// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hasCatalogName } from './catalog-normalize.mjs';

const OBJECTS = { works: 'work', persons: 'person', 'credit-names': 'credit_name', companies: 'company',
  characters: 'character', releases: 'release', series: 'series', tags: 'tag', traits: 'trait', engines: 'engine',
  platforms: 'platform', roles: 'role' };
const NESTED = { ...OBJECTS, credit_names: 'credit_name', siblings: 'credit_name',
  work: 'work', person: 'person', credit_name: 'credit_name', company: 'company', character: 'character',
  release: 'release', tag: 'tag', trait: 'trait', engine: 'engine', platform: 'platform', role: 'role' };
const BLOCKS = new Set(['titles', 'refs', 'credits', 'releases', 'series', 'platforms', 'companies', 'tags',
  'characters', 'covers', 'aliases', 'intros', 'links', 'photo', 'siblings', 'traits', 'engines']);
const ARRAY_BLOCKS = new Set([...BLOCKS].filter(key => key !== 'photo'));
const NAME_FIELDS = new Set(['display_name', 'name', 'latin', 'localized', 'titles', 'aliases']);
const RELATION_OBJECTS = new Set(['list', 'search', 'search_hit', 'credit', 'name_credit', 'work_credit', 'person_credit', 'credit_group']);
const RELATION_FIELDS = new Set(['identity', 'attribution_role', 'role_key', 'role_name', 'roles', 'sort_order',
  'position', 'character_id', 'character', 'credit_name_id']);
// Embedded credited names can carry a different identity/character/context for
// every participation. Only established entity attributes are shared from an
// embedded row; all other (including future) fields remain in the raw envelope
// and relationship record. Name arrays (titles/aliases) are also potentially
// incomplete there. Full endpoint observations still retain all fields.
const NESTED_ENTITY_FIELDS = new Set(['id', 'object', 'target_object', 'person_id', 'medium', 'content_rating', ...[...NAME_FIELDS].filter(field => !BLOCKS.has(field))]);
const idOf = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,20}$/.test(String(value)) ? String(value) : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const folded = value => String(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
const prefixEnd = value => {
  const characters = [...value];
  while (characters.length) {
    const last = characters.pop().codePointAt(0);
    if (last < 0x10ffff) return characters.join('') + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
  }
  return null;
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const DEFAULT_MAX_BYTES = 20_000_000_000;
const MEMORY_MAX_BYTES = 256 * 1024 * 1024;
const MAX_CAPACITY_BYTES = 64 * 1024 ** 3;
const USAGE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_GRACE_MS = 30 * 60 * 1000;
const USAGE_DEDUP_MS = 60 * 1000;
const USAGE_FLUSH_MS = 30 * 1000;
const MAX_PENDING_USAGE = 10_000;
const MIN_EFFECTIVE_USAGE = 0.01;
const REDIRECT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Released mappings must outlive the 24-hour creator/alias caches, including
// their bounded in-flight reads. Capacity reclamation is not a new redirect.
const REDIRECT_RELEASE_GRACE_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
const RECLAIM_BATCH = 64;
const RECLAIM_REMOVALS = 32;
const RECLAIM_MS = 12;
const ZERO_PRIORITY = -1e100;
// log2(score) + time/half-life orders decaying scores without periodically
// rewriting every hot row. A bounded maintenance pass floors negligible tails.
const priority = (score, at) => {
  if (!(score > 0)) return ZERO_PRIORITY;
  // Binary buckets avoid platform-dependent decimal rounding in SQLite indexes.
  const scaled = (Math.log2(score) + at / USAGE_HALF_LIFE_MS) * 1048576;
  return Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5) / 1048576;
};
const decay = (score, at, now) => score * 2 ** (-Math.max(0, now - at) / USAGE_HALF_LIFE_MS);

function observedObject(node, hint, kind) {
  const explicit = node.target_object || (node.object && !RELATION_OBJECTS.has(node.object) ? node.object : null);
  const named = ['display_name', 'name', 'latin', 'localized'].some(key => node[key] !== undefined);
  const inferred = kind !== 'nested' || (named && !Object.hasOwn(node, 'source'));
  return RELATION_OBJECTS.has(node.object) && !node.target_object ? null : explicit || (inferred ? hint : null);
}

function jsonValue(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if ((!plain(value) && !Array.isArray(value)) || depth > 64 || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every(item => jsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requestInfo({ scope, path: resource, params = {} }) {
  if (typeof scope !== 'string' || !scope || scope.length > 1024 || scope.includes('\0') ||
      typeof resource !== 'string' || !/^\/catalog\/[a-z-]+(?:\/\d{1,20})?(?:\/[a-z-]+)?$/.test(resource) || !plain(params)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return null;
    clean[key] = String(value);
  }
  const nsfw = clean.nsfw === 'true' || clean.nsfw === '1';
  const spoiler = clean.spoiler || 'none';
  clean.nsfw = String(nsfw); clean.spoiler = spoiler;
  for (const key of ['include', 'fields', 'ids', 'refs']) if (clean[key]) clean[key] = [...new Set(clean[key].split(',').map(value => value.trim()).filter(Boolean))].sort().join(',');
  const partition = canonical([scope, nsfw, spoiler]);
  const [, , collection, id, relation] = resource.split('/');
  return { partition, params: clean, resource, object: OBJECTS[collection], id, relation,
    key: hash(canonical([partition, resource, clean])), include: (clean.include || '').split(',').filter(Boolean) };
}

function changeKeys(scope, feed = 'changes') {
  if (!requestInfo({ scope, path: '/catalog/search' }) || !['changes', 'redirects'].includes(feed)) return null;
  const prefix = `sync:${hash(scope)}`;
  return { checkpoint: `${prefix}:${feed}`, revision: `${prefix}:revision`, syncRevision: `${prefix}:pages` };
}

function normalizedChanges(events) {
  if (!Array.isArray(events) || events.length > 1000) return null;
  const unique = new Map();
  for (const event of events) {
    if (!plain(event) || typeof event.object !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(event.object) ||
        RELATION_OBJECTS.has(event.object) || !idOf(event.id) || !Number.isSafeInteger(event.updatedAt) || event.updatedAt < 0 ||
        (event.gone !== undefined && typeof event.gone !== 'boolean') ||
        (event.currentId !== undefined && event.currentId !== null && (!idOf(event.currentId) || String(event.currentId) === String(event.id)))) return null;
    const next = { object: event.object, id: String(event.id), updatedAt: event.updatedAt,
      ...(event.gone ? { gone: true } : {}), ...(event.currentId != null ? { currentId: String(event.currentId) } : {}) };
    const key = canonical([next.object, next.id]), previous = unique.get(key);
    if (!previous || previous.updatedAt < next.updatedAt) unique.set(key, next);
    else if (previous.updatedAt === next.updatedAt) unique.set(key, { ...previous, ...next });
  }
  return [...unique.values()];
}

function privateFile(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const directory = lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid catalogue database directory.');
  // An embedding host may place the cache in an existing shared directory.
  // Only directories created above belong to us; preserve the host's access.
  let fd;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid catalogue database file.');
  chmodSync(file, 0o600);
}

function names(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(names);
  if (!plain(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => ['value', 'name', 'display_name', 'title', 'latin', 'alias'].includes(key)
    ? names(item) : plain(item) || Array.isArray(item) ? names(item) : []);
}

/** A shared, bounded, structured catalogue, never an account store.
 * Raw successful envelopes are retained separately from field observations.
 * Missing fields do not overwrite facts or renew their freshness. Collection,
 * search and nested records cannot masquerade as complete entity details.
 */
export class CatalogDatabase {
  #db; #now; #maxFileBytes; #configuredFileBytes; #pageSize;
  #closed = false; #persistent = false; #degraded = false;
  #pendingUsage = new Map(); #usageTimer;
  #pendingRetirements = new Map();
  #reclaimTimer; #reclaimTarget = null; #reclaimCursor = {}; #reclaimSweepRemoved = 0;

  constructor({ file, now = Date.now, maxFileBytes = DEFAULT_MAX_BYTES } = {}) {
    if (typeof now !== 'function' ||
        !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 256 * 1024 || maxFileBytes > MAX_CAPACITY_BYTES ||
        (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')))) throw new TypeError('Invalid catalogue database configuration.');
    this.#now = now;
    this.#configuredFileBytes = maxFileBytes;
    try { this.#open(file); }
    catch (error) {
      if (file === undefined) throw error;
      this.#degraded = true;
      if (/file is not a database|database disk image is malformed/i.test(error.message)) {
        try {
          const quarantine = `${file}.corrupt-${randomUUID()}`;
          renameSync(file, quarantine);
          for (const suffix of ['-journal', '-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, quarantine + suffix);
          this.#open(file); return;
        } catch { /* Preserve evidence and fall back if disk storage is unavailable. */ }
      }
      this.#open();
    }
  }

  #open(file) {
    if (file !== undefined) privateFile(file);
    this.#db = new DatabaseSync(file ?? ':memory:');
    try {
      // Reuse the presentation contract for local candidates, including open
      // language maps and Unicode whitespace. The SQL predicate runs before
      // LIMIT; an alias alone is searchable evidence, not a displayable name.
      this.#db.function('catalog_has_name', { deterministic: true }, (field, value) => {
        try { return hasCatalogName({ [field]: JSON.parse(value) }) ? 1 : 0; }
        catch { return 0; }
      });
      // The service can make system temp directories read-only. Keep SQLite's
      // temporary transaction/index structures on this connection in memory.
      // A fixed 16-MiB pager budget also avoids repeated index-page reads
      // during batched invalidation, without growing with the catalogue.
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -16384;
        PRAGMA auto_vacuum = FULL;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        CREATE TABLE IF NOT EXISTS catalog_metadata (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS catalog_entities (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL, observed_at INTEGER NOT NULL,
          PRIMARY KEY(scope,object,id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_entity_age ON catalog_entities(observed_at);
        CREATE TABLE IF NOT EXISTS catalog_fields (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
          observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'legacy',
          PRIMARY KEY(scope,object,id,field),
          FOREIGN KEY(scope,object,id) REFERENCES catalog_entities ON DELETE CASCADE
        ) WITHOUT ROWID;
        -- Card provenance is looked up across visibility partitions. The
        -- entity primary key starts with scope, so it cannot serve that read.
        -- Cover just work fields instead of scanning every catalogue field
        -- once for each card saved by a library or discovery response.
        CREATE INDEX IF NOT EXISTS catalog_work_observation ON catalog_fields(id,scope,expires_at,observed_at) WHERE object='work';
        CREATE TABLE IF NOT EXISTS catalog_views (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
          base_fields TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(scope,object,id,kind),
          FOREIGN KEY(scope,object,id) REFERENCES catalog_entities ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS catalog_names (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL,
          normalized TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(scope,object,id,field,normalized),
          FOREIGN KEY(scope,object,id) REFERENCES catalog_entities ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_name_search ON catalog_names(scope,object,normalized);
        CREATE TABLE IF NOT EXISTS catalog_queries (
          key TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, params TEXT NOT NULL,
          data TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_query_age ON catalog_queries(observed_at);
        CREATE INDEX IF NOT EXISTS catalog_query_metadata ON catalog_queries(scope,observed_at,path,params);
        CREATE INDEX IF NOT EXISTS catalog_query_lookup ON catalog_queries(key,expires_at);
        CREATE TABLE IF NOT EXISTS catalog_query_entities (
          query_key TEXT NOT NULL REFERENCES catalog_queries(key) ON DELETE CASCADE,
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY(query_key,scope,object,id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_query_dependency ON catalog_query_entities(scope,object,id);
        CREATE TABLE IF NOT EXISTS catalog_relationships (
          key TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL,
          field TEXT NOT NULL, target_object TEXT NOT NULL, target_id TEXT NOT NULL, data TEXT NOT NULL,
          query_key TEXT REFERENCES catalog_queries(key) ON DELETE CASCADE,
          observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
          FOREIGN KEY(scope,object,id) REFERENCES catalog_entities ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_relationship_owner ON catalog_relationships(scope,object,id,field);
        CREATE INDEX IF NOT EXISTS catalog_relationship_target ON catalog_relationships(scope,target_object,target_id);
        CREATE INDEX IF NOT EXISTS catalog_relationship_query ON catalog_relationships(query_key) WHERE query_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS catalog_redirects (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL, current_id TEXT,
          updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(scope,object,id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_redirect_expiry ON catalog_redirects(expires_at);
        CREATE INDEX IF NOT EXISTS catalog_redirect_target ON catalog_redirects(scope,object,current_id) WHERE current_id IS NOT NULL;
      `);
      if (!this.#db.prepare('PRAGMA table_info(catalog_fields)').all().some(row => row.name === 'provenance')) {
        this.#db.exec("ALTER TABLE catalog_fields ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy'");
      }
      // Usage describes local reuse, not upstream freshness. Separate rows keep
      // catalogue observations unchanged and cascade away with their owner.
      // Initialize bookkeeping atomically. Reopening an established catalogue
      // must not rescan every retained field or generate a new, discarded usage
      // identifier for every entity before the HTTP server can start.
      this.#db.exec('BEGIN IMMEDIATE');
      const schema = new Set(this.#db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','trigger')").all().map(row => row.name));
      const usageVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_entity_usage (
          scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL,
          generation TEXT NOT NULL, born_at INTEGER NOT NULL, score REAL NOT NULL,
          score_at INTEGER NOT NULL, last_read_at INTEGER,
          PRIMARY KEY(scope,object,id),
          FOREIGN KEY(scope,object,id) REFERENCES catalog_entities ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS catalog_query_usage (
          key TEXT PRIMARY KEY NOT NULL REFERENCES catalog_queries(key) ON DELETE CASCADE,
          generation TEXT NOT NULL, born_at INTEGER NOT NULL, score REAL NOT NULL,
          score_at INTEGER NOT NULL, last_read_at INTEGER
        ) WITHOUT ROWID;
      `);
      this.#db.exec(`CREATE TABLE IF NOT EXISTS catalog_redirect_usage (
        scope TEXT NOT NULL, object TEXT NOT NULL, id TEXT NOT NULL,
        generation TEXT NOT NULL, born_at INTEGER NOT NULL, score REAL NOT NULL,
        score_at INTEGER NOT NULL, last_read_at INTEGER,
        PRIMARY KEY(scope,object,id),
        FOREIGN KEY(scope,object,id) REFERENCES catalog_redirects ON DELETE CASCADE
      ) WITHOUT ROWID`);
      if (!schema.has('catalog_redirect_usage') || !schema.has('catalog_redirect_usage_insert') || !schema.has('catalog_redirect_usage_update')) this.#db.exec(`INSERT OR IGNORE INTO catalog_redirect_usage
        (scope,object,id,generation,born_at,score,score_at,last_read_at)
        SELECT scope,object,id,lower(hex(randomblob(16))),expires_at-${REDIRECT_TTL_MS},0.0,expires_at-${REDIRECT_TTL_MS},NULL FROM catalog_redirects`);
      // Triggers also cover positional writes made by an older application
      // after rollback, so those rows remain eligible for later maintenance.
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS catalog_redirect_usage_insert AFTER INSERT ON catalog_redirects BEGIN
        INSERT OR IGNORE INTO catalog_redirect_usage (scope,object,id,generation,born_at,score,score_at,last_read_at)
        VALUES (NEW.scope,NEW.object,NEW.id,lower(hex(randomblob(16))),NEW.expires_at-${REDIRECT_TTL_MS},0.0,NEW.expires_at-${REDIRECT_TTL_MS},NULL); END;
        CREATE TRIGGER IF NOT EXISTS catalog_redirect_usage_update AFTER UPDATE ON catalog_redirects BEGIN
        UPDATE catalog_redirect_usage SET born_at=MAX(born_at,NEW.expires_at-${REDIRECT_TTL_MS})
          WHERE scope=NEW.scope AND object=NEW.object AND id=NEW.id; END;`);
      if (usageVersion < 3 || !schema.has('catalog_entity_usage')) this.#db.exec(`INSERT OR IGNORE INTO catalog_entity_usage (scope,object,id,generation,born_at,score,score_at,last_read_at)
        SELECT scope,object,id,lower(hex(randomblob(16))),observed_at,0.0,observed_at,NULL FROM catalog_entities`);
      if (usageVersion < 3 || !schema.has('catalog_query_usage')) this.#db.exec(`INSERT OR IGNORE INTO catalog_query_usage (key,generation,born_at,score,score_at,last_read_at)
        SELECT key,lower(hex(randomblob(16))),observed_at,0.0,observed_at,NULL FROM catalog_queries`);
      // Maintain logical totals in the same transaction as writes. Recounting
      // all field/name rows for every fetched page or restart becomes costly as
      // it grows. Only bootstrap a missing counter or repair its missing trigger;
      // a complete set is already kept consistent by the write transactions.
      this.#db.exec('CREATE TABLE IF NOT EXISTS catalog_totals (table_name TEXT PRIMARY KEY,n INTEGER NOT NULL,bytes INTEGER NOT NULL) WITHOUT ROWID');
      const totals = new Map(this.#db.prepare('SELECT * FROM catalog_totals').all().map(row => [row.table_name, row]));
      for (const table of ['catalog_entities', 'catalog_fields', 'catalog_views', 'catalog_names', 'catalog_queries', 'catalog_relationships', 'catalog_redirects']) {
        const size = table === 'catalog_entities' ? '128' : 'bytes';
        const total = totals.get(table);
        if (!total || !Number.isSafeInteger(total.n) || total.n < 0 || !Number.isSafeInteger(total.bytes) || total.bytes < 0 ||
            ['insert', 'delete', 'update'].some(event => !schema.has(`${table}_count_${event}`))) {
          this.#db.exec(`INSERT INTO catalog_totals SELECT '${table}',COUNT(*),COALESCE(SUM(${size}),0) FROM ${table} WHERE 1
            ON CONFLICT(table_name) DO UPDATE SET n=excluded.n,bytes=excluded.bytes`);
        }
        this.#db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_count_insert AFTER INSERT ON ${table} BEGIN
            UPDATE catalog_totals SET n=n+1,bytes=bytes+${size === '128' ? size : 'NEW.bytes'} WHERE table_name='${table}'; END;
          CREATE TRIGGER IF NOT EXISTS ${table}_count_delete AFTER DELETE ON ${table} BEGIN
            UPDATE catalog_totals SET n=n-1,bytes=bytes-${size === '128' ? size : 'OLD.bytes'} WHERE table_name='${table}'; END;
          CREATE TRIGGER IF NOT EXISTS ${table}_count_update AFTER UPDATE ON ${table} BEGIN
            UPDATE catalog_totals SET bytes=bytes+${size === '128' ? '0' : 'NEW.bytes-OLD.bytes'} WHERE table_name='${table}'; END;`);
      }
      // Generated columns preserve the original positional INSERT shape for
      // rollback to older application releases. Both old and new score updates
      // keep the ordered index current; healthy reopen never rewrites usage.
      for (const table of ['catalog_entity_usage', 'catalog_query_usage', 'catalog_redirect_usage']) {
        if (!this.#db.prepare(`PRAGMA table_xinfo(${table})`).all().some(row => row.name === 'priority')) {
          this.#db.exec(`ALTER TABLE ${table} ADD COLUMN priority REAL GENERATED ALWAYS AS
            (CASE WHEN score>0 THEN CAST(round((log2(score)+score_at/604800000.0)*1048576) AS INTEGER)/1048576.0 ELSE -1e100 END) VIRTUAL`);
        }
        if (!this.#db.prepare(`PRAGMA table_xinfo(${table})`).all().some(row => row.name === 'read_order')) {
          this.#db.exec(`ALTER TABLE ${table} ADD COLUMN read_order INTEGER GENERATED ALWAYS AS (COALESCE(last_read_at,born_at)) VIRTUAL;
            DROP INDEX IF EXISTS ${table}_reclaim`);
        }
        const keys = table === 'catalog_query_usage' ? 'key' : 'scope,object,id';
        this.#db.exec(`CREATE INDEX IF NOT EXISTS ${table}_reclaim ON ${table}(priority,read_order,${keys})`);
      }
      if (usageVersion < 4) this.#db.exec('PRAGMA user_version = 4');
      this.#db.exec('COMMIT');
      this.#pageSize = this.#db.prepare('PRAGMA page_size').get().page_size;
      const fileLimit = file === undefined ? Math.min(this.#configuredFileBytes,
        MEMORY_MAX_BYTES) : this.#configuredFileBytes;
      const pages = Math.floor(fileLimit / this.#pageSize);
      this.#maxFileBytes = pages * this.#pageSize;
      this.#db.exec('BEGIN IMMEDIATE');
      this.#trim();
      this.#db.exec('COMMIT');
      this.#persistent = file !== undefined;
      this.#usageTimer = setInterval(() => { this.flushUsage(); }, USAGE_FLUSH_MS);
      this.#usageTimer.unref();
    } catch (error) { clearTimeout(this.#reclaimTimer); this.#reclaimTimer = null; this.#db.close(); throw error; }
  }

  ingest({ scope, path: resource, params = {}, data, ttlMs, observedAt = this.#now() } = {}) {
    if (this.#closed || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(observedAt) ||
        !Number.isSafeInteger(observedAt + ttlMs) || !jsonValue(data) || !plain(data)) return false;
    const info = requestInfo({ scope, path: resource, params });
    if (!info || !this.#flushRetirements(info.partition)) return false;
    const serialized = JSON.stringify(data), expiresAt = observedAt + ttlMs;
    let transaction = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); transaction = true;
      const prior = this.#db.prepare('SELECT observed_at FROM catalog_queries WHERE key=?').get(info.key);
      if (prior?.observed_at > observedAt) { this.#db.exec('ROLLBACK'); return true; }
      const paramsJson = canonical(info.params);
      this.#db.prepare(`INSERT INTO catalog_queries VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        data=excluded.data,observed_at=excluded.observed_at,expires_at=excluded.expires_at,bytes=excluded.bytes`).run(
        info.key, info.partition, resource, paramsJson, serialized, observedAt, expiresAt,
        Buffer.byteLength(serialized + paramsJson + info.partition + resource) + 64);
      this.#db.prepare('INSERT OR IGNORE INTO catalog_query_usage (key,generation,born_at,score,score_at,last_read_at) VALUES (?,?,?,?,?,?)').run(
        info.key, randomUUID(), this.#now(), 0, this.#now(), null);
      this.#db.prepare('DELETE FROM catalog_query_entities WHERE query_key=?').run(info.key);
      this.#db.prepare('DELETE FROM catalog_relationships WHERE query_key=?').run(info.key);
      const touched = new Set();
      const record = (raw, object, kind = 'nested') => {
        const id = idOf(raw?.id);
        if (!plain(raw) || !id || !object || !/^[a-z][a-z_]{0,63}$/.test(object) || RELATION_OBJECTS.has(object)) return null;
        const identity = { object, id };
        touched.add(canonical([object, id]));
        this.#entity(info.partition, object, id, observedAt);
        if (kind !== 'nested') {
          // A newer positive endpoint observation can re-establish an old ID.
          // Embedded participation fragments are not proof of that recovery.
          this.#db.prepare(`UPDATE catalog_redirects SET current_id=NULL,updated_at=?,expires_at=?
            WHERE scope=? AND object=? AND id=? AND updated_at<?`).run(observedAt, this.#now() + REDIRECT_TTL_MS, scope, object, id, observedAt);
        }
        this.#db.prepare('INSERT OR IGNORE INTO catalog_query_entities VALUES (?,?,?,?)').run(info.key, info.partition, object, id);
        this.#observe(info, identity, raw, kind, observedAt, expiresAt);
        return identity;
      };
      const walk = (node, hint, owner, field, kind = 'nested', queryEdge = false, depth = 0, context = null) => {
        if (depth > 48 || (!plain(node) && !Array.isArray(node))) return;
        if (Array.isArray(node)) { for (const item of node) walk(item, hint, owner, field, kind, queryEdge, depth + 1, context); return; }
        // Unqualified source-local IDs (for example tags from two providers)
        // are not global catalogue identities just because they share a key.
        const identity = record(node, observedObject(node, hint, kind), kind);
        if (owner && identity && (identity.object !== owner.object || identity.id !== owner.id)) {
          this.#edge(info, owner, field, identity, context ? { record: node, context } : node, observedAt, expiresAt, queryEdge ? info.key : null);
        }
        const currentOwner = identity || owner;
        for (const [key, value] of Object.entries(node)) {
          if (identity) {
            const current = this.#db.prepare('SELECT observed_at FROM catalog_fields WHERE scope=? AND object=? AND id=? AND field=?').get(info.partition, identity.object, identity.id, key);
            if (current?.observed_at > observedAt) continue;
          }
          if (currentOwner && key.endsWith('_id') && NESTED[key.slice(0, -3)] && idOf(value)) {
            this.#edge(info, currentOwner, identity ? key : field, { object: NESTED[key.slice(0, -3)], id: String(value) },
              { [key]: value }, observedAt, expiresAt, queryEdge ? info.key : null);
          }
          if (!plain(value) && !Array.isArray(value)) continue;
          let childHint = NESTED[key];
          if (key === 'credits' && node.role_key) childHint = 'credit_name';
          const childField = identity ? key : field;
          const rowContext = !identity ? Object.fromEntries(Object.entries(node).filter(([name]) => name !== key)) : null;
          walk(value, childHint, currentOwner, childField, 'nested', queryEdge, depth + 1, rowContext);
        }
      };
      if (info.id && info.relation && info.object) {
        const owner = { object: info.object, id: info.id };
        touched.add(canonical([owner.object, owner.id]));
        this.#entity(info.partition, owner.object, owner.id, observedAt);
        this.#db.prepare('INSERT OR IGNORE INTO catalog_query_entities VALUES (?,?,?,?)').run(info.key, info.partition, owner.object, owner.id);
        walk(data.items || [], NESTED[info.relation], owner, `@${info.relation}`, 'nested', true);
      } else if (Array.isArray(data.items)) {
        const kind = resource === '/catalog/search' || info.params.q ? 'search' : 'collection';
        walk(data.items, info.object || info.params.object, null, '', kind);
      } else walk(data, info.object, null, '', info.id ? 'detail' : 'nested');
      this.#trim();
      if (!this.#db.prepare('SELECT 1 FROM catalog_queries WHERE key=?').get(info.key)) throw new Error('Catalogue response exceeds capacity.');
      const retained = this.#db.prepare('SELECT 1 FROM catalog_entities WHERE scope=? AND object=? AND id=?');
      for (const identity of touched) if (!retained.get(info.partition, ...JSON.parse(identity))) throw new Error('Catalogue response entities exceed capacity.');
      this.#db.exec('COMMIT'); return true;
    } catch {
      if (transaction) { try { this.#db.exec('ROLLBACK'); } catch { /* SQLite may have rolled back a real full-disk transaction itself. */ } }
      return false;
    }
  }

  #entity(scope, object, id, observedAt) {
    this.#db.prepare(`INSERT INTO catalog_entities VALUES (?,?,?,?) ON CONFLICT(scope,object,id) DO UPDATE SET
      observed_at=MAX(catalog_entities.observed_at,excluded.observed_at)`).run(scope, object, id, observedAt);
    this.#db.prepare('INSERT OR IGNORE INTO catalog_entity_usage (scope,object,id,generation,born_at,score,score_at,last_read_at) VALUES (?,?,?,?,?,?,?,?)').run(
      scope, object, id, randomUUID(), this.#now(), 0, this.#now(), null);
  }

  #observe(info, { object, id }, raw, kind, observedAt, expiresAt) {
    const get = this.#db.prepare('SELECT value,observed_at,expires_at FROM catalog_fields WHERE scope=? AND object=? AND id=? AND field=?');
    const put = this.#db.prepare(`INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,object,id,field) DO UPDATE SET
      value=excluded.value,observed_at=excluded.observed_at,expires_at=excluded.expires_at,bytes=excluded.bytes,provenance=excluded.provenance`);
    for (const [field, supplied] of Object.entries(raw)) {
      if (kind === 'nested' && RELATION_FIELDS.has(field)) continue;
      // An embedded entity is not a declaration that its relation lists are
      // complete. Keep its raw blocks in the enclosing response/edge context,
      // but never replace or renew an authoritative entity's relation fields.
      if (kind === 'nested' && !NESTED_ENTITY_FIELDS.has(field)) continue;
      // Search envelopes use object=search_hit with target_object=work/etc.
      // Keep the original in the query, but never corrupt canonical entity type.
      const value = field === 'object' && raw.target_object ? object : supplied;
      const json = JSON.stringify(value), old = get.get(info.partition, object, id, field);
      if (old?.observed_at > observedAt) continue;
      const lifetime = old?.value === json ? Math.max(old.expires_at, expiresAt) : expiresAt;
      const provenance = ['detail', 'collection'].includes(kind) ? 'authoritative' : kind;
      put.run(info.partition, object, id, field, json, observedAt, lifetime, Buffer.byteLength(json + field + provenance) + 24, provenance);
      this.#db.prepare('DELETE FROM catalog_relationships WHERE scope=? AND object=? AND id=? AND field=? AND query_key IS NULL').run(info.partition, object, id, field);
      if (NAME_FIELDS.has(field)) {
        this.#db.prepare('DELETE FROM catalog_names WHERE scope=? AND object=? AND id=? AND field=?').run(info.partition, object, id, field);
        const insert = this.#db.prepare('INSERT OR IGNORE INTO catalog_names VALUES (?,?,?,?,?,?,?)');
        for (const name of names(value)) {
          const normalized = folded(name);
          if (normalized && name.length <= 2048) insert.run(info.partition, object, id, field, normalized, name, Buffer.byteLength(normalized + name + field) + 24);
        }
      }
    }
    // A linked credited name with explicit person identity is sufficient for a
    // basic identity batch. It still cannot satisfy creator detail/includes.
    if (kind === 'nested' && object === 'credit_name' && idOf(raw.person_id) &&
        ['display_name', 'name', 'latin', 'localized'].some(key => raw[key] !== undefined)) kind = 'basic';
    if (!['detail', 'collection', 'basic'].includes(kind) || info.params.fields) return;
    const base = JSON.stringify(Object.keys(raw).filter(key => !BLOCKS.has(key) &&
      (kind !== 'basic' || NESTED_ENTITY_FIELDS.has(key))).sort());
    const old = this.#db.prepare('SELECT observed_at FROM catalog_views WHERE scope=? AND object=? AND id=? AND kind=?').get(info.partition, object, id, kind);
    if (old?.observed_at > observedAt) return;
    this.#db.prepare(`INSERT INTO catalog_views VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope,object,id,kind) DO UPDATE SET
      base_fields=excluded.base_fields,observed_at=excluded.observed_at,expires_at=excluded.expires_at,bytes=excluded.bytes`).run(
      info.partition, object, id, kind, base, observedAt, expiresAt, Buffer.byteLength(base) + 32);
  }

  #edge(info, owner, field, target, data, observedAt, expiresAt, queryKey) {
    const json = JSON.stringify(data);
    const key = hash(canonical([info.partition, owner, field, target, data, queryKey]));
    this.#db.prepare(`INSERT INTO catalog_relationships VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      observed_at=MAX(catalog_relationships.observed_at,excluded.observed_at),expires_at=MAX(catalog_relationships.expires_at,excluded.expires_at)`).run(
      key, info.partition, owner.object, owner.id, field, target.object, target.id, json, queryKey, observedAt, expiresAt,
      Buffer.byteLength(json + field + target.object + target.id) + 128);
    this.#db.prepare('INSERT OR IGNORE INTO catalog_query_entities VALUES (?,?,?,?)').run(info.key, info.partition, target.object, target.id);
  }

  read(args = {}, { trackUsage = true } = {}) {
    if (this.#closed) return null;
    const info = requestInfo(args);
    if (!info || !this.#flushRetirements(info.partition)) return null;
    try {
      // One synchronous read often repeats the same creators across many
      // works/roles. Reuse their authoritative rows only within this read;
      // later reads must observe ingestion, retirement, expiry and scope anew.
      const fields = new Map();
      // The WITHOUT ROWID primary tree also stores large response envelopes.
      // Probe its compact key index first so missing identities do not traverse
      // payload-heavy pages for every credited name in a batch of works.
      const exact = this.#db.prepare('SELECT data,observed_at,expires_at FROM catalog_queries INDEXED BY catalog_query_lookup WHERE key=?').get(info.key);
      if (exact?.expires_at > this.#now()) {
        const result = this.#refreshEnvelope(info, JSON.parse(exact.data), exact, fields);
        if (result) { if (trackUsage) this.#recordRead(info); return result; }
        // A newly observed but now expired fact cannot resurrect an older one
        // just because an unrelated query envelope still has time remaining.
        return null;
      }
      if (!info.object || info.relation || info.params.fields || info.params.q || info.params.refs) return null;
      const allowed = new Set(['ids', 'include', 'nsfw', 'spoiler', 'limit']);
      if (Object.keys(info.params).some(key => !allowed.has(key))) return null;
      if (info.id) {
        const result = this.#reconstruct(info, info.id, true, fields);
        if (result && trackUsage) this.#recordRead(info);
        return result;
      }
      const ids = (info.params.ids || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 100 || ids.some(id => !idOf(id))) return null;
      const records = ids.map(id => this.#reconstruct(info, id, false, fields));
      if (records.some(row => !row)) return null;
      if (trackUsage) this.#recordRead(info);
      return { data: { object: 'list', items: records.map(row => row.data) }, expiresAt: Math.min(...records.map(row => row.expiresAt)) };
    } catch { return null; }
  }

  #refreshEnvelope(info, data, exact, fields) {
    let expiresAt = exact.expires_at, valid = true;
    const walk = (node, hint, rootEntity = false) => {
      if (Array.isArray(node)) return node.map(row => walk(row, hint, rootEntity));
      if (!plain(node)) return node;
      const explicit = node.target_object || (node.object && !RELATION_OBJECTS.has(node.object) ? node.object : null);
      const named = ['display_name', 'name', 'latin', 'localized'].some(key => node[key] !== undefined);
      const inferred = rootEntity || (named && !Object.hasOwn(node, 'source'));
      const object = RELATION_OBJECTS.has(node.object) && !node.target_object ? null : explicit || (inferred ? hint : null);
      const id = idOf(node.id), result = { ...node };
      if (object && id) {
        const rows = this.#fields(info.partition, object, id, fields).filter(row => row.observed_at >= exact.observed_at);
        for (const row of rows) {
          // Only update fields actually represented in this envelope. Extra
          // detail blocks are provided by reconstruction, not search payloads.
          if (!Object.hasOwn(result, row.field) || ['object', 'target_object'].includes(row.field)) continue;
          // Never replace participation-local fields using another appearance
          // of the same entity, including polluted observations from older DBs.
          if (!rootEntity && !NESTED_ENTITY_FIELDS.has(row.field)) continue;
          if (row.expires_at <= this.#now()) { valid = false; continue; }
          Object.defineProperty(result, row.field, { value: JSON.parse(row.value), enumerable: true, configurable: true });
          expiresAt = Math.min(expiresAt, row.expires_at);
        }
      }
      for (const [key, value] of Object.entries(result)) {
        let childHint = NESTED[key];
        if (key === 'credits' && result.role_key) childHint = 'credit_name';
        if (key === 'items' && !info.relation) childHint = info.object || info.params.object;
        Object.defineProperty(result, key, { value: walk(value, childHint, key === 'items' && !info.relation), enumerable: true, configurable: true });
      }
      return result;
    };
    const result = walk(data, info.object, !!info.id && !info.relation);
    return valid ? { data: result, expiresAt } : null;
  }

  #reconstruct(info, id, detail, fields) {
    const now = this.#now();
    const views = this.#db.prepare('SELECT * FROM catalog_views WHERE scope=? AND object=? AND id=? AND expires_at>? ORDER BY observed_at DESC').all(info.partition, info.object, id, now);
    const view = views.find(row => detail ? row.kind === 'detail' : row.kind !== 'basic' || !info.include.length);
    if (!view) return null;
    const rows = this.#fields(info.partition, info.object, id, fields).filter(row => row.expires_at > now);
    const map = new Map(rows.map(row => [row.field, row]));
    const required = new Set([...JSON.parse(view.base_fields).filter(field =>
      view.kind !== 'basic' || NESTED_ENTITY_FIELDS.has(field)), ...info.include]);
    // Work collection includes select summary slots rather than detail arrays:
    // titles => latin/localized, covers => cover/banner. Reuse those actual
    // fresh fields across ID batches; never invent arrays or use a search-only
    // record as proof of a complete collection/detail response.
    if (!detail && info.object === 'work' && view.kind !== 'basic') {
      const projections = { titles: ['latin', 'localized'], covers: ['cover', 'banner'] };
      for (const [block, fields] of Object.entries(projections)) {
        if (!info.include.includes(block) || map.has(block)) continue;
        const valid = fields.every(field => {
          if (!map.has(field)) return false;
          const value = JSON.parse(map.get(field).value);
          return field === 'latin' ? value === null || typeof value === 'string'
            : field === 'localized' ? !!plain(value) : value === null || !!plain(value);
        });
        if (!valid) continue;
        required.delete(block);
        for (const field of fields) required.add(field);
      }
    }
    if ([...required].some(field => !map.has(field))) return null;
    const result = {};
    let expiresAt = view.expires_at;
    // Requested blocks establish the minimum; retain any other fresh facts so
    // a detail read can serve cards without throwing away known character or
    // version metadata. The earliest included expiry bounds the whole result.
    const returned = new Set([...required, ...rows.map(row => row.field).filter(field => field !== 'target_object')]);
    for (const field of returned) {
      const row = map.get(field), value = JSON.parse(row.value);
      if (info.include.includes(field) && ARRAY_BLOCKS.has(field) && !Array.isArray(value)) return null;
      // Reconstructed batches must see the same newer embedded names/person
      // links as exact detail reads. Compare against this field's observation,
      // not another block's timestamp, and keep participation-local duties.
      const refreshed = this.#refreshEnvelope(info, { [field]: value }, {
        observed_at: row.observed_at, expires_at: row.expires_at,
      }, fields);
      if (!refreshed) {
        // Optional presentation facts must not make otherwise complete work
        // metadata a cache miss. Never return the obsolete embedded identity.
        if (required.has(field)) return null;
        continue;
      }
      Object.defineProperty(result, field, { value: refreshed.data[field], enumerable: true, configurable: true });
      expiresAt = Math.min(expiresAt, refreshed.expiresAt);
    }
    if (String(result.id) !== id || (result.object && result.object !== info.object)) return null;
    if (!result.object) result.object = info.object;
    return { data: result, expiresAt };
  }

  #fields(scope, object, id, memo) {
    const key = memo && canonical([scope, object, id]);
    if (memo?.has(key)) return memo.get(key);
    const rows = this.#db.prepare('SELECT field,value,observed_at,expires_at,provenance FROM catalog_fields WHERE scope=? AND object=? AND id=?').all(scope, object, id);
    let legacy;
    const result = rows.flatMap(row => {
      // Top-level search observations can update entity facts too. Their lack
      // of a complete detail/collection view still prevents hydration reuse;
      // it does not turn a newly observed release date into untrusted context.
      if (row.provenance === 'nested' && BLOCKS.has(row.field)) return [];
      if (['authoritative', 'search'].includes(row.provenance) || NESTED_ENTITY_FIELDS.has(row.field) || BLOCKS.has(row.field)) return [row];
      if (row.provenance !== 'legacy') return [];
      // Do not trust older global scalars merely because a current view lists
      // that field: an embedded participation may have overwritten its value.
      // Recover its original authoritative value and lifetime from raw query
      // history. Reads never write back or grant a new freshness lifetime.
      legacy ??= this.#legacyAuthoritativeFields(scope, object, id);
      return legacy.has(row.field) ? [legacy.get(row.field)] : [];
    });
    memo?.set(key, result);
    return result;
  }

  #legacyAuthoritativeFields(scope, object, id) {
    const fields = new Map();
    const queries = this.#db.prepare(`SELECT q.path,q.params,q.data,q.observed_at,q.expires_at
      FROM catalog_query_entities AS d JOIN catalog_queries AS q ON q.key=d.query_key
      WHERE d.scope=? AND d.object=? AND d.id=? ORDER BY q.observed_at`).all(scope, object, id);
    for (const query of queries) {
      const params = JSON.parse(query.params);
      const [, , collection, entityId, relation] = query.path.split('/');
      if (relation || params.q || collection === 'search') continue;
      const data = JSON.parse(query.data);
      const records = entityId ? [data] : Array.isArray(data.items) ? data.items : [];
      for (const record of records) {
        if (String(record?.id) !== id || (record.object || OBJECTS[collection]) !== object) continue;
        for (const [field, value] of Object.entries(record)) fields.set(field, { field, value: JSON.stringify(value),
          observed_at: query.observed_at, expires_at: query.expires_at, provenance: 'authoritative' });
      }
    }
    return fields;
  }

  find({ scope, object, query, nsfw = false, spoiler = 'none', limit = 100 } = {}) {
    if (this.#closed || typeof query !== 'string' || query.length > 512 || typeof object !== 'string' ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return [];
    const info = requestInfo({ scope, path: '/catalog/search', params: { nsfw, spoiler } });
    const key = folded(query);
    if (!info || !key || !this.#flushRetirements(info.partition)) return [];
    try {
      const now = this.#now();
      // Exclude non-displayable works before LIMIT, otherwise hidden/unknown
      // ratings could consume the page and hide a usable local fallback.
      const visibility = !nsfw && object === 'work' ? `AND EXISTS (
        SELECT 1 FROM catalog_fields AS rating WHERE rating.scope=names.scope AND rating.object=names.object
          AND rating.id=names.id AND rating.field='content_rating' AND rating.value='"all_ages"' AND rating.expires_at>?)` : '';
      const visibilityArgs = visibility ? [now] : [];
      const displayable = `AND EXISTS (
        SELECT 1 FROM catalog_fields AS display WHERE display.scope=names.scope AND display.object=names.object
          AND display.id=names.id AND display.field IN ('display_name','latin','localized') AND display.expires_at>?
          AND catalog_has_name(display.field,display.value)=1)`;
      // Exact and prefix names already outrank substring matches. Serve these
      // through the normalized-name index first, so a normal name lookup does
      // not scan the growing catalogue merely to rediscover an exact match.
      const rows = this.#db.prepare(`SELECT names.id
        FROM catalog_names AS names JOIN catalog_fields AS fields
          ON fields.scope=names.scope AND fields.object=names.object AND fields.id=names.id AND fields.field=names.field
        WHERE names.scope=? AND names.object=? AND normalized=? AND fields.expires_at>? ${visibility} ${displayable}
        GROUP BY names.id ORDER BY names.id LIMIT ?`).all(info.partition, object, key, now, ...visibilityArgs, now, limit);
      const end = prefixEnd(key);
      if (rows.length < limit) {
        const excluded = rows.map(row => row.id);
        rows.push(...this.#db.prepare(`SELECT names.id
          FROM catalog_names AS names JOIN catalog_fields AS fields
            ON fields.scope=names.scope AND fields.object=names.object AND fields.id=names.id AND fields.field=names.field
          WHERE names.scope=? AND names.object=? AND normalized>? ${end ? 'AND normalized<?' : ''} AND fields.expires_at>? ${visibility} ${displayable}
            ${excluded.length ? `AND names.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
          GROUP BY names.id ORDER BY names.id LIMIT ?`).all(info.partition, object, key, ...(end ? [end] : []), now, ...visibilityArgs, now, ...excluded, limit - rows.length));
      }
      // This supplements the upstream search, not a complete local catalogue.
      // Do not scan every retained name merely to fill the unused slots after
      // a useful exact/prefix match. Validate freshness/visibility first: an
      // unusable strong match must not suppress a valid substring fallback.
      const hydrate = matches => matches.flatMap(({ id }) => {
        const fields = this.#fields(info.partition, object, id).filter(row => row.expires_at > now);
        const record = Object.fromEntries(fields.map(row => [row.field, JSON.parse(row.value)]));
        if (!hasCatalogName(record)) return [];
        if (!nsfw && object === 'work' && record.content_rating !== 'all_ages') return [];
        return [{ ...record, id, target_object: object }];
      });
      const strong = hydrate(rows);
      if (strong.length) return strong;
      const excluded = rows.map(row => row.id);
      const fallback = this.#db.prepare(`SELECT names.id
          FROM catalog_names AS names JOIN catalog_fields AS fields
            ON fields.scope=names.scope AND fields.object=names.object AND fields.id=names.id AND fields.field=names.field
          WHERE names.scope=? AND names.object=? AND normalized LIKE ? AND fields.expires_at>? ${visibility} ${displayable}
            ${excluded.length ? `AND names.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
          GROUP BY names.id ORDER BY names.id LIMIT ?`).all(info.partition, object, `%${key}%`, now, ...visibilityArgs, now, ...excluded, limit);
      return hydrate(fallback);
    } catch { return []; }
  }

  getChangeCheckpoint({ scope, feed } = {}) {
    const keys = changeKeys(scope, feed);
    return keys ? this.getMetadata(keys.checkpoint) : null;
  }

  getChangeRevision({ scope } = {}) {
    const keys = changeKeys(scope), value = keys ? this.getMetadata(keys.revision) : null;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  getSyncRevision({ scope } = {}) {
    const keys = changeKeys(scope), value = keys ? this.getMetadata(keys.syncRevision) : null;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  getRedirect({ scope, object, id, includeReleased = false } = {}) {
    if (this.#closed || !changeKeys(scope) || typeof object !== 'string' || !idOf(id)) return null;
    try {
      const row = this.#db.prepare(`SELECT r.current_id,r.updated_at,r.expires_at,u.* FROM catalog_redirects AS r
        LEFT JOIN catalog_redirect_usage AS u ON u.scope=r.scope AND u.object=r.object AND u.id=r.id
        WHERE r.scope=? AND r.object=? AND r.id=? AND r.expires_at>?`).get(scope, object, String(id), this.#now());
      if (!row || (!row.current_id && !includeReleased)) return null;
      if (row.generation) this.#queueUsage('redirect', row, this.#now());
      return { object, id: String(id), currentId: row.current_id, updatedAt: row.updated_at, ...(includeReleased ? { expiresAt: row.expires_at } : {}) };
    } catch { return null; }
  }

  getWorkObservedAt({ scope, id, params } = {}) {
    const rawId = typeof id === 'string' ? id.replace(/^nm:/, '') : id;
    if (this.#closed || !changeKeys(scope) || !idOf(rawId)) return null;
    try {
      const rows = this.#db.prepare(`SELECT scope,MIN(observed_at) AS observed_at FROM catalog_fields
        WHERE object='work' AND id=? AND expires_at>? GROUP BY scope`).all(String(rawId), this.#now());
      const times = rows.filter(row => {
        const [namespace, nsfw, spoiler] = JSON.parse(row.scope);
        return namespace === scope && (!params || (nsfw === (params.nsfw === true || params.nsfw === 'true') && spoiler === (params.spoiler || 'none')));
      }).map(row => row.observed_at);
      return times.length ? Math.min(...times) : null;
    } catch { return null; }
  }

  #positiveObservation(partition, object, id, atLeast, queryObservations) {
    const view = this.#db.prepare(`SELECT MAX(observed_at) AS observed_at FROM catalog_views
      WHERE scope=? AND object=? AND id=? AND kind IN ('detail','collection')`).get(partition, object, id);
    let latest = view?.observed_at ?? -Infinity;
    if (latest >= atLeast) return latest;
    // Nested credits can mention an already merged ID. They must not prevent a
    // redirect or pretend the old ID has been independently published again.
    // Most dependencies are large work/relationship envelopes containing this
    // identity only as a nested mention. Do not read their JSON blobs merely
    // to rule them out by path; a historical page may reference hundreds of
    // names in the same envelopes.
    for (const { query_key } of this.#db.prepare(`SELECT query_key FROM catalog_query_entities WHERE scope=? AND object=? AND id=?`).iterate(partition, object, id)) {
      const row = queryObservations.get(query_key);
      if (!row || row.observed_at <= latest || row.observed_at < atLeast) continue;
      const [, , collection, entityId, relation] = row.path.split('/');
      if (relation || (entityId && entityId !== id) || (OBJECTS[collection] && OBJECTS[collection] !== object)) continue;
      const params = JSON.parse(row.params);
      if ((OBJECTS[collection] || params.object) !== object) continue;
      const data = JSON.parse(this.#db.prepare('SELECT data FROM catalog_queries WHERE key=?').get(row.key).data), records = entityId ? [data] : data.items || [];
      if (records.some(record => String(record?.id) === id && (record.target_object || record.object || OBJECTS[collection]) === object)) return row.observed_at;
    }
    return latest;
  }

  // Changes are invalidation notices, never partial detail observations. The
  // cursor and invalidation share one commit; a failed page remains replayable.
  applyChangePage({ scope, feed, expectedCheckpoint = null, checkpoint, events } = {}) {
    const keys = changeKeys(scope, feed), changes = normalizedChanges(events);
    if (this.#closed || !keys || !changes || !jsonValue(expectedCheckpoint) || !plain(checkpoint) ||
        !jsonValue(checkpoint) || Buffer.byteLength(JSON.stringify(checkpoint)) > 4096) return { applied: false };
    const workChanges = changes.filter(event => event.object === 'work').map(({ id, currentId, ...event }) => ({
      ...event, id: `nm:${id}`, ...(currentId ? { currentId: `nm:${currentId}` } : {}),
    }));
    let transaction = false, busyTimeout;
    try {
      for (const partition of this.#pendingRetirements.keys()) {
        if (JSON.parse(partition)[0] === scope && !this.#flushRetirements(partition)) return { applied: false };
      }
      busyTimeout = this.#db.prepare('PRAGMA busy_timeout').get().timeout;
      this.#db.exec('PRAGMA busy_timeout=0');
      this.#db.exec('BEGIN IMMEDIATE'); transaction = true;
      const read = key => {
        const row = this.#db.prepare('SELECT value FROM catalog_metadata WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : null;
      };
      const previous = read(keys.checkpoint);
      if (canonical(previous) !== canonical(expectedCheckpoint)) {
        this.#db.exec('ROLLBACK'); transaction = false; return { applied: false };
      }
      let revision = read(keys.revision) ?? 0, syncRevision = read(keys.syncRevision) ?? 0;
      if (![revision, syncRevision].every(value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER)) throw new Error('Invalid sync revision.');
      if (canonical(previous) === canonical(checkpoint)) {
        this.#db.exec('ROLLBACK'); transaction = false;
        return { applied: true, revision, syncRevision, events: [], entityChanges: changes, redirectChanges: [], workIds: [], refreshWorkIds: [], workChanges, listsChanged: false };
      }
      // Seeking the next distinct leading index key avoids scanning every
      // entity/query merely to enumerate the handful of visibility partitions.
      const partitionKeys = new Set();
      for (const table of ['catalog_entities', 'catalog_queries']) {
        const first = this.#db.prepare(`SELECT MIN(scope) AS scope FROM ${table}`);
        const next = this.#db.prepare(`SELECT MIN(scope) AS scope FROM ${table} WHERE scope>?`);
        let partition = first.get().scope;
        while (partition !== null) {
          if (JSON.parse(partition)[0] === scope) partitionKeys.add(partition);
          partition = next.get(partition).scope;
        }
      }
      const partitions = [...partitionKeys];
      const activeChanges = changes.filter(event => {
        const known = this.#db.prepare('SELECT current_id,updated_at FROM catalog_redirects WHERE scope=? AND object=? AND id=?').get(scope, event.object, event.id);
        return !known || known.updated_at < event.updatedAt ||
          (known.updated_at === event.updatedAt && !!event.currentId && !known.current_id);
      });
      const affected = new Map(), redirectChanges = [], refreshWorkIds = new Set();
      const latestChange = activeChanges.reduce((latest, event) => Math.max(latest, event.updatedAt), -Infinity);
      // A dependency only needs its own query metadata. Keep a small page-local
      // memo instead of copying the entire retained query catalogue into JS.
      const observationMemo = new Map();
      const observationRead = this.#db.prepare('SELECT key,path,params,observed_at FROM catalog_queries WHERE key=?');
      const observations = { get: key => {
        if (observationMemo.has(key)) return observationMemo.get(key);
        const value = observationRead.get(key);
        if (observationMemo.size >= 512) observationMemo.delete(observationMemo.keys().next().value);
        observationMemo.set(key, value);
        return value;
      } };
      const changedIds = new Map();
      for (const event of activeChanges) {
        let ids = changedIds.get(event.object);
        if (!ids) changedIds.set(event.object, ids = new Map());
        ids.set(event.id, Math.max(ids.get(event.id) ?? -Infinity, event.updatedAt));
      }
      // Freeze positive evidence before any event invalidates shared queries
      // or ancestor fields. A later notice in this page must not erase proof
      // that an older tombstone/redirect has already been superseded.
      const positiveObservations = new Map(changes.map(event => [event, new Map(partitions.map(partition => [
        partition, this.#positiveObservation(partition, event.object, event.id, event.updatedAt, observations),
      ]))]));
      let listsChanged = false;
      for (const partition of partitions) {
        const pendingQueryDeletes = new Set();
        for (const event of activeChanges) {
          const retired = event.gone === true || !!event.currentId;
          // Historical tombstones may be replayed after a work was made public
          // again. A newer positive observation wins over that old tombstone.
          if (retired && positiveObservations.get(event).get(partition) >= event.updatedAt) continue;
          const invalidated = this.#retireEntity(partition, event.object, event.id, {
            // Once a tombstone is current, later embedded mentions cannot
            // validate it. Remove every containing block, just like a direct
            // NOT_FOUND/ENTITY_MERGED response; a newer positive root above is
            // the evidence that permits an old tombstone to be ignored.
            before: retired ? Infinity : event.updatedAt, preserveEntity: !retired, queryObservations: observations, pendingQueryDeletes,
          });
          for (const identity of invalidated) {
            const key = canonical([identity.object, identity.id]);
            const direct = identity.object === event.object && identity.id === event.id;
            const next = { ...identity, updatedAt: event.updatedAt, ...(direct && event.gone ? { gone: true } : {}),
              ...(direct && event.currentId ? { currentId: event.currentId } : {}) };
            const prior = affected.get(key);
            if (!prior || prior.updatedAt <= next.updatedAt) affected.set(key, next);
            if (identity.object === 'work' && !(direct && retired) && this.#db.prepare(
              'SELECT 1 FROM catalog_entities WHERE scope=? AND object=? AND id=?').get(partition, identity.object, identity.id)) refreshWorkIds.add(identity.id);
          }
        }
        // One shared relation response can carry several changed identities.
        // Deleting it during the first traversal would cascade away the edges
        // needed by later events, leaving their nested identity fields stale.
        // Delete each query only after the complete page has walked its edges.
        const keysToDelete = [...pendingQueryDeletes];
        // Positive dependencies cannot detect an entity entering an empty
        // search/career page. Walk older membership metadata in bounded pages
        // only after all event traversals have retained their relationship
        // edges. Keyset pagination stays stable while earlier rows are deleted.
        // The existing covering index supplies this exact tuple order.
        const firstPage = this.#db.prepare(`SELECT key,path,params,observed_at FROM catalog_queries INDEXED BY catalog_query_metadata
          WHERE scope=? AND observed_at<? ORDER BY observed_at,path,params,key LIMIT 250`);
        const nextPage = this.#db.prepare(`SELECT key,path,params,observed_at FROM catalog_queries INDEXED BY catalog_query_metadata
          WHERE scope=? AND observed_at<? AND (observed_at,path,params,key)>(?,?,?,?)
          ORDER BY observed_at,path,params,key LIMIT 250`);
        let cursor;
        while (latestChange > -Infinity) {
          const page = cursor ? nextPage.all(partition, latestChange, ...cursor) : firstPage.all(partition, latestChange);
          if (!page.length) break;
          const query = page.at(-1);
          cursor = [query.observed_at, query.path, query.params, query.key];
          const membershipKeys = [];
          for (const row of page) {
            const info = requestInfo({ scope, path: row.path, params: JSON.parse(row.params) });
            const membership = info && (info.relation || info.params.q || info.resource === '/catalog/search' || (!info.id && !info.params.ids));
            const ids = info && !info.id ? changedIds.get(info.object) : null;
            const changed = membership || (ids && (info.params.ids || '').split(',').some(id => row.observed_at < (ids.get(id) ?? -Infinity)));
            if (changed) membershipKeys.push(row.key);
          }
          if (membershipKeys.length) {
            this.#db.prepare(`DELETE FROM catalog_queries WHERE key IN (${membershipKeys.map(() => '?').join(',')})`).run(...membershipKeys);
            listsChanged = true;
          }
        }
        for (let start = 0; start < keysToDelete.length; start += 250) {
          const batch = keysToDelete.slice(start, start + 250);
          this.#db.prepare(`DELETE FROM catalog_queries WHERE key IN (${batch.map(() => '?').join(',')})`).run(...batch);
        }
      }
      for (const event of changes) {
        const known = this.#db.prepare('SELECT * FROM catalog_redirects WHERE scope=? AND object=? AND id=?').get(scope, event.object, event.id);
        const latest = Math.max(-Infinity, ...positiveObservations.get(event).values());
        // Feed replay cannot override a newer positive observation or a newer
        // change from the other feed. Equal-time gone and merge are compatible.
        if (latest >= event.updatedAt || known?.updated_at > event.updatedAt ||
            (known?.updated_at === event.updatedAt && (!event.currentId || known.current_id))) continue;
        const currentId = event.currentId || null;
        this.#db.prepare(`INSERT INTO catalog_redirects VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope,object,id) DO UPDATE SET
          current_id=excluded.current_id,updated_at=excluded.updated_at,expires_at=excluded.expires_at,bytes=excluded.bytes`).run(
          scope, event.object, event.id, currentId, event.updatedAt, this.#now() + REDIRECT_TTL_MS,
          Buffer.byteLength(scope + event.object + event.id + (currentId || '')) + 48);
        // Learning an old redirect for an entity never used here is not a
        // change to local catalogue facts. Consumers separately check whether
        // surviving aliases or cards depend on this accepted identity state.
        redirectChanges.push({ ...event, currentId });
      }
      const resultEvents = [...affected.values()];
      if (listsChanged || resultEvents.length) revision++;
      syncRevision++;
      const values = [[keys.checkpoint, checkpoint], [keys.revision, revision], [keys.syncRevision, syncRevision]];
      const missing = values.filter(([key]) => !this.#db.prepare('SELECT 1 FROM catalog_metadata WHERE key=?').get(key)).length;
      if (this.#db.prepare('SELECT COUNT(*) AS n FROM catalog_metadata').get().n + missing > 100) throw new Error('Sync metadata capacity exceeded.');
      const put = this.#db.prepare('INSERT INTO catalog_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of values) put.run(key, JSON.stringify(value));
      this.#trim();
      this.#db.exec('COMMIT'); transaction = false;
      return { applied: true, revision, syncRevision, events: resultEvents, entityChanges: changes, redirectChanges,
        workIds: [...affected.values()].filter(event => event.object === 'work').map(event => `nm:${event.id}`),
        refreshWorkIds: [...refreshWorkIds], workChanges, listsChanged };
    } catch {
      if (transaction) try { this.#db.exec('ROLLBACK'); } catch { /* Storage failures never acknowledge a feed page. */ }
      return { applied: false };
    } finally {
      if (busyTimeout !== undefined) try { this.#db.exec(`PRAGMA busy_timeout=${busyTimeout}`); } catch { /* Restore on the next healthy connection. */ }
    }
  }

  invalidateQuery(args = {}) {
    const info = requestInfo(args);
    if (this.#closed || !info) return false;
    try { return this.#db.prepare('DELETE FROM catalog_queries WHERE key=?').run(info.key).changes > 0; }
    catch { return false; }
  }

  retire({ scope, object, id, params = {} } = {}) {
    const info = requestInfo({ scope, path: '/catalog/search', params });
    if (this.#closed || !info || typeof object !== 'string' || !idOf(id)) return false;
    const pending = this.#pendingRetirements.get(info.partition) || new Map();
    pending.set(canonical([object, String(id)]), { object, id: String(id) });
    this.#pendingRetirements.set(info.partition, pending);
    return this.#flushRetirements(info.partition);
  }

  #flushRetirements(partition) {
    const pending = this.#pendingRetirements.get(partition);
    if (!pending) return true;
    let busyTimeout;
    try {
      // Once deletion is known, stale reads are worse than a cache miss. Keep
      // the partition gated if a competing writer prevents invalidation, and
      // retry without making every cache lookup wait for the same writer.
      busyTimeout = this.#db.prepare('PRAGMA busy_timeout').get().timeout;
      this.#db.exec('PRAGMA busy_timeout=0');
      this.#db.exec('BEGIN IMMEDIATE');
      for (const { object, id } of pending.values()) this.#retireEntity(partition, object, id);
      this.#db.exec('COMMIT');
      this.#pendingRetirements.delete(partition);
      return true;
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch { /* Invalidation remains queued. */ }
      return false;
    } finally {
      if (busyTimeout !== undefined) try { this.#db.exec(`PRAGMA busy_timeout=${busyTimeout}`); } catch { /* Unavailable storage remains a cache miss. */ }
    }
  }

  #retireEntity(partition, object, id, { before = Infinity, preserveEntity = false, queryObservations, pendingQueryDeletes, protectedQuery = null, reclaimPriority } = {}) {
    const affected = new Map();
    // Remove containing fields as well: a work's credits array must not
    // resurrect a retired identity through a cross-shape reconstruction.
    // Relationships can nest (work -> credited name -> person). Invalidate
    // every containing field before removing edges; otherwise reconstruction
    // could revive a retired person from a grandparent's raw credits array.
    const parents = new Map(), visited = new Set();
    const queue = [{ object, id }];
    // DISTINCT otherwise makes SQLite prefer the owner index to avoid a
    // temporary sort, scanning every relationship in this public partition
    // for each changed ID. Resolve the small incoming edge set first instead.
    const incoming = this.#db.prepare('SELECT DISTINCT object,id,field FROM catalog_relationships INDEXED BY catalog_relationship_target WHERE scope=? AND target_object=? AND target_id=? AND observed_at<? LIMIT ?');
    for (let index = 0; index < queue.length; index++) {
      const target = queue[index], key = canonical([target.object, target.id]);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const parent of incoming.all(partition, target.object, target.id, before, reclaimPriority === undefined ? -1 : RECLAIM_BATCH + 1)) {
        parents.set(canonical([parent.object, parent.id, parent.field]), parent);
        queue.push(parent);
        if (reclaimPriority !== undefined && (parents.size > RECLAIM_BATCH || queue.length > RECLAIM_BATCH * 2)) return null;
      }
    }
    if (reclaimPriority !== undefined) {
      // Include transitive containing fields: a cold child must not retire a
      // recently read parent or query. Large graphs are kept conservatively.
      const checkedQueries = new Set();
      for (const target of [{ object, id }, ...parents.values()]) {
        const usage = this.#db.prepare('SELECT * FROM catalog_entity_usage WHERE scope=? AND object=? AND id=?')
          .get(partition, target.object, target.id);
        if (usage) {
          const candidate = this.#usageCandidate('entity', usage, this.#now());
          if (candidate.protected || candidate.effectivePriority > reclaimPriority + 1e-7) return null;
        }
        const dependencies = this.#db.prepare(`SELECT u.* FROM catalog_query_entities AS d
          JOIN catalog_query_usage AS u ON u.key=d.query_key
          WHERE d.scope=? AND d.object=? AND d.id=? LIMIT ?`).all(partition, target.object, target.id, RECLAIM_BATCH + 1);
        for (const dependency of dependencies) {
          checkedQueries.add(dependency.key);
          if (checkedQueries.size > RECLAIM_BATCH) return null;
          const candidate = this.#usageCandidate('query', dependency, this.#now());
          if (candidate.protected || candidate.effectivePriority > reclaimPriority + 1e-7) return null;
        }
      }
    }
    const deleteQueries = (targetObject, targetId) => {
      if (!queryObservations) return this.#db.prepare(`DELETE FROM catalog_queries WHERE observed_at<? AND (? IS NULL OR key<>?) AND key IN
        (SELECT query_key FROM catalog_query_entities WHERE scope=? AND object=? AND id=?)`).run(before, protectedQuery, protectedQuery, partition, targetObject, targetId).changes;
      let changed = 0;
      for (const { query_key } of this.#db.prepare('SELECT query_key FROM catalog_query_entities WHERE scope=? AND object=? AND id=?').all(partition, targetObject, targetId)) {
        const observation = queryObservations.get(query_key);
        if (!observation || observation.observed_at >= before) continue;
        if (pendingQueryDeletes) { pendingQueryDeletes.add(query_key); changed++; }
        else changed += this.#db.prepare('DELETE FROM catalog_queries WHERE key=?').run(query_key).changes;
      }
      return changed;
    };
    let ownChanges = deleteQueries(object, id);
    for (const parent of parents.values()) {
      let changed = deleteQueries(parent.object, parent.id);
      const oldField = this.#db.prepare('SELECT 1 FROM catalog_fields WHERE scope=? AND object=? AND id=? AND field=? AND observed_at<?').get(partition, parent.object, parent.id, parent.field, before);
      if (oldField) {
        changed += this.#db.prepare('DELETE FROM catalog_fields WHERE scope=? AND object=? AND id=? AND field=?').run(partition, parent.object, parent.id, parent.field).changes;
        this.#db.prepare('DELETE FROM catalog_names WHERE scope=? AND object=? AND id=? AND field=?').run(partition, parent.object, parent.id, parent.field);
      }
      changed += this.#db.prepare('DELETE FROM catalog_relationships WHERE scope=? AND object=? AND id=? AND field=? AND observed_at<?').run(partition, parent.object, parent.id, parent.field, before).changes;
      if (changed) affected.set(canonical([parent.object, parent.id]), { object: parent.object, id: parent.id });
    }
    if (preserveEntity) {
      // Keep observation-independent local read heat. Only observations older
      // than the notice are removed, including old blocks beside a newer name.
      this.#db.prepare(`DELETE FROM catalog_names WHERE scope=? AND object=? AND id=? AND field IN
        (SELECT field FROM catalog_fields WHERE scope=? AND object=? AND id=? AND observed_at<?)`).run(partition, object, id, partition, object, id, before);
      ownChanges += this.#db.prepare(`DELETE FROM catalog_relationships WHERE scope=? AND object=? AND id=? AND observed_at<?`).run(partition, object, id, before).changes;
      ownChanges += this.#db.prepare('DELETE FROM catalog_fields WHERE scope=? AND object=? AND id=? AND observed_at<?').run(partition, object, id, before).changes;
      ownChanges += this.#db.prepare('DELETE FROM catalog_views WHERE scope=? AND object=? AND id=? AND observed_at<?').run(partition, object, id, before).changes;
    } else {
      ownChanges += this.#db.prepare('DELETE FROM catalog_entities WHERE scope=? AND object=? AND id=?').run(partition, object, id).changes;
    }
    if (ownChanges || affected.size) affected.set(canonical([object, id]), { object, id });
    return [...affected.values()];
  }

  // Use existing exact dependency indexes, once per visibility partition. A
  // retained field, query or incoming redirect still owns this identity's
  // retirement evidence, even if the identity itself has no entity row.
  #redirectReclaimable(row, now, partitions) {
    const redirect = this.#db.prepare('SELECT current_id FROM catalog_redirects WHERE scope=? AND object=? AND id=?')
      .get(row.scope, row.object, row.id);
    if (!redirect || (redirect.current_id === null && now - row.born_at < REDIRECT_RELEASE_GRACE_MS)) return false;
    if (this.#db.prepare('SELECT 1 FROM catalog_redirects WHERE scope=? AND object=? AND current_id=? LIMIT 1')
      .get(row.scope, row.object, row.id)) return false;
    let scoped = partitions.get(row.scope);
    if (!scoped) {
      scoped = new Set();
      const prefix = `[${JSON.stringify(row.scope)},`;
      for (const table of ['catalog_entities', 'catalog_queries']) {
        const next = this.#db.prepare(`SELECT MIN(scope) AS scope FROM ${table} WHERE scope>? AND scope<?`);
        let partition = next.get(prefix, `${prefix}\uffff`).scope;
        while (partition !== null) { scoped.add(partition); partition = next.get(partition, `${prefix}\uffff`).scope; }
      }
      partitions.set(row.scope, scoped);
    }
    for (const partition of scoped) for (const id of new Set([row.id, redirect.current_id].filter(Boolean))) {
      if (this.#db.prepare('SELECT 1 FROM catalog_entities WHERE scope=? AND object=? AND id=?').get(partition, row.object, id) ||
          this.#db.prepare('SELECT 1 FROM catalog_query_entities WHERE scope=? AND object=? AND id=? LIMIT 1').get(partition, row.object, id) ||
          this.#db.prepare('SELECT 1 FROM catalog_relationships WHERE scope=? AND target_object=? AND target_id=? LIMIT 1').get(partition, row.object, id)) return false;
    }
    return true;
  }

  // The client can defer tracking until its own response validation succeeds.
  // Calling this method never fetches, hydrates or changes catalogue freshness.
  recordUsage(args = {}) {
    if (this.#closed) return false;
    const info = requestInfo(args);
    return info ? this.#recordRead(info) : false;
  }

  #recordRead(info) {
    try {
      const now = this.#now();
      const exact = this.#db.prepare(`SELECT u.* FROM catalog_query_usage AS u
        JOIN catalog_queries AS q ON q.key=u.key WHERE u.key=? AND q.expires_at>?`).get(info.key, now);
      if (exact) this.#queueUsage('query', exact, now);
      // Merely appearing in a candidate list is not a user reading that entity.
      // The query itself is reusable; individual candidates get no popularity.
      if (info.resource === '/catalog/search' || info.params.q) return !!exact;
      if (exact) {
        const dependencies = this.#db.prepare(`SELECT u.* FROM catalog_entity_usage AS u
          JOIN catalog_query_entities AS d ON d.scope=u.scope AND d.object=u.object AND d.id=u.id
          WHERE d.query_key=?`).all(info.key);
        for (const row of dependencies) this.#queueUsage('entity', row, now);
        return true;
      }
      // Cross-shape reads reconstruct a whole entity or explicit batch from
      // fresh fields. They must not create a synthetic upstream query record.
      if (!info.object || info.relation || info.params.q || info.params.fields || info.params.refs) return false;
      const ids = info.id ? [info.id] : (info.params.ids || '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 100 || ids.some(id => !idOf(id))) return false;
      const get = this.#db.prepare('SELECT * FROM catalog_entity_usage WHERE scope=? AND object=? AND id=?');
      for (const id of ids) {
        const row = get.get(info.partition, info.object, id);
        if (row) this.#queueUsage('entity', row, now);
      }
      return true;
    } catch { return false; } // Optional popularity bookkeeping cannot break a read.
  }

  #usageKey(type, row) {
    return canonical(type === 'query' ? [type, row.key] : [type, row.scope, row.object, row.id]);
  }

  #queueUsage(type, row, now) {
    const key = this.#usageKey(type, row), queued = this.#pendingUsage.get(key);
    const pending = queued?.generation === row.generation ? queued : null;
    const last = Math.max(row.last_read_at ?? -Infinity, pending?.last_read_at ?? -Infinity);
    if (now - last < USAGE_DEDUP_MS) return;
    if (!queued && this.#pendingUsage.size >= MAX_PENDING_USAGE) {
      // A busy or full disk must never turn usage counters into unbounded RAM.
      // Prefer a batch flush, then discard only optional, oldest pending stats.
      this.flushUsage();
      if (this.#pendingUsage.size >= MAX_PENDING_USAGE) this.#pendingUsage.delete(this.#pendingUsage.keys().next().value);
    }
    this.#pendingUsage.set(key, { ...row, type, delta: decay(pending?.delta || 0, pending?.at ?? now, now) + 1,
      at: now, last_read_at: now });
  }

  flushUsage() {
    if (this.#closed) return false;
    if (!this.#pendingUsage.size) return true;
    const pending = [...this.#pendingUsage], now = this.#now();
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const entityGet = this.#db.prepare('SELECT * FROM catalog_entity_usage WHERE scope=? AND object=? AND id=? AND generation=?');
      const redirectGet = this.#db.prepare('SELECT * FROM catalog_redirect_usage WHERE scope=? AND object=? AND id=? AND generation=?');
      const redirectPut = this.#db.prepare('UPDATE catalog_redirect_usage SET score=?,score_at=?,last_read_at=? WHERE scope=? AND object=? AND id=? AND generation=?');
      const queryGet = this.#db.prepare('SELECT * FROM catalog_query_usage WHERE key=? AND generation=?');
      const entityPut = this.#db.prepare('UPDATE catalog_entity_usage SET score=?,score_at=?,last_read_at=? WHERE scope=? AND object=? AND id=? AND generation=?');
      const queryPut = this.#db.prepare('UPDATE catalog_query_usage SET score=?,score_at=?,last_read_at=? WHERE key=? AND generation=?');
      for (const [, entry] of pending) {
        const args = entry.type === 'query' ? [entry.key, entry.generation] : [entry.scope, entry.object, entry.id, entry.generation];
        const old = (entry.type === 'query' ? queryGet : entry.type === 'redirect' ? redirectGet : entityGet).get(...args);
        if (!old) continue; // Deleted and recreated identities never inherit old hits.
        const at = Math.max(now, old.score_at, entry.at);
        const score = decay(old.score, old.score_at, at) + decay(entry.delta, entry.at, at);
        (entry.type === 'query' ? queryPut : entry.type === 'redirect' ? redirectPut : entityPut).run(score, at, Math.max(old.last_read_at ?? entry.last_read_at, entry.last_read_at), ...args);
      }
      this.#db.exec('COMMIT');
      for (const [key, entry] of pending) if (this.#pendingUsage.get(key) === entry) this.#pendingUsage.delete(key);
      return true;
    } catch {
      try { this.#db.exec('ROLLBACK'); } catch { /* SQLite may roll back SQLITE_FULL itself. */ }
      return false; // Keep pending hits for retry; do not evict data just to persist statistics.
    }
  }

  #allocatedBytes() {
    const pages = this.#db.prepare('PRAGMA page_count').get().page_count;
    const free = this.#db.prepare('PRAGMA freelist_count').get().freelist_count;
    return (pages - free) * this.#pageSize;
  }

  #scheduleReclaim(delay = 20) {
    if (this.#closed || this.#reclaimTimer) return;
    this.#reclaimTimer = setTimeout(() => {
      this.#reclaimTimer = null;
      const result = this.reclaim();
      if (result.pending) this.#scheduleReclaim(result.waitMs || 20);
    }, delay);
    this.#reclaimTimer.unref();
  }

  #trim() {
    // Expired redirect accelerators can be pruned without scanning retained
    // facts, including well below the file target. Bound this work per write.
    this.#db.prepare(`DELETE FROM catalog_redirects WHERE (scope,object,id) IN
      (SELECT scope,object,id FROM catalog_redirects WHERE expires_at<=? ORDER BY expires_at LIMIT ?)`)
      .run(this.#now(), RECLAIM_BATCH);
    // Foreground ingestion only measures page allocation. Reclamation has its
    // own short transactions and yields between batches; catalogue size never
    // imposes an all-record scan/sort on an upstream response or server start.
    if (this.#allocatedBytes() >= this.#maxFileBytes * 0.95) {
      // The enclosing write may still roll back. Only the later maintenance
      // callback may establish a target from committed page allocation.
      this.#scheduleReclaim();
    }
  }

  #usageCandidate(type, row, now) {
    const entry = this.#pendingUsage.get(this.#usageKey(type, row));
    const pending = entry?.generation === row.generation ? entry : null;
    const score = decay(row.score, row.score_at, now) + decay(pending?.delta || 0, pending?.at ?? now, now);
    return { ...row, type, protected: this.#persistent && now - row.born_at < USAGE_GRACE_MS,
      effectivePriority: score < MIN_EFFECTIVE_USAGE ? ZERO_PRIORITY : priority(score, now),
      lastRead: Math.max(row.last_read_at ?? row.born_at, pending?.last_read_at ?? row.born_at) };
  }

  // One bounded maintenance step, also exposed for deterministic capacity QA.
  // Temporary overshoot and the 30-minute new-record grace never reject writes.
  reclaim() {
    if (this.#closed) return { pending: false, removed: 0, scanned: 0 };
    clearTimeout(this.#reclaimTimer); this.#reclaimTimer = null;
    const started = performance.now(), now = this.#now();
    let removed = 0, scanned = 0, waitMs = 20, transaction = false, busyTimeout;
    const originalCursor = { ...this.#reclaimCursor }, originalRemoved = this.#reclaimSweepRemoved;
    try {
      busyTimeout = this.#db.prepare('PRAGMA busy_timeout').get().timeout;
      this.#db.exec('PRAGMA busy_timeout=0');
      if (this.#allocatedBytes() >= this.#maxFileBytes * 0.95) this.#reclaimTarget ??= this.#maxFileBytes * 0.9;
      if (this.#reclaimTarget !== null && this.#allocatedBytes() <= this.#reclaimTarget) {
        this.#reclaimTarget = null; this.#reclaimCursor = {}; this.#reclaimSweepRemoved = 0;
      }
      if (this.#reclaimTarget === null) return { pending: false, removed: 0, scanned: 0 };
      // Flush outside the maintenance transaction, including pending hits in
      // comparisons if the flush cannot complete. A read never turns cold
      // merely because statistics have not reached disk yet.
      this.flushUsage();
      this.#db.exec('BEGIN IMMEDIATE'); transaction = true;
      this.#db.prepare(`DELETE FROM catalog_redirects WHERE (scope,object,id) IN
        (SELECT scope,object,id FROM catalog_redirects WHERE expires_at<=? ORDER BY expires_at LIMIT ?)`)
        .run(now, RECLAIM_BATCH);
      let floored = 0;
      for (const table of ['catalog_query_usage', 'catalog_entity_usage', 'catalog_redirect_usage']) {
        const keys = table === 'catalog_query_usage' ? 'key' : 'scope,object,id';
        floored += this.#db.prepare(`UPDATE ${table} SET score=0 WHERE (${keys}) IN
          (SELECT ${keys} FROM ${table} WHERE priority>? AND priority<? ORDER BY priority LIMIT ?)`)
          .run(ZERO_PRIORITY, priority(MIN_EFFECTIVE_USAGE, now), RECLAIM_BATCH).changes;
      }
      if (floored) {
        // Finish flooring in short indexed batches before choosing between
        // ancient negligible hits and never-read data. No full-table update.
        this.#reclaimCursor = {};
      } else {
        const batches = ['query', 'redirect', 'entity'].map(type => {
          const table = `catalog_${type}_usage`;
          const keys = type === 'query' ? ['key'] : ['scope', 'object', 'id'];
          const order = ['priority', 'read_order', ...keys].join(',');
          const cursor = this.#reclaimCursor[type];
          const rows = this.#db.prepare(`SELECT * FROM ${table}
            ${cursor ? `WHERE (${order})>(${cursor.map(() => '?').join(',')})` : ''}
            ORDER BY ${order} LIMIT ?`).all(...(cursor || []), RECLAIM_BATCH);
          return { type, keys, rows, exhausted: rows.length < RECLAIM_BATCH };
        });
        const compare = (a, b) => a.priority - b.priority || a.read_order - b.read_order ||
          ['query', 'redirect', 'entity'].indexOf(a.type) - ['query', 'redirect', 'entity'].indexOf(b.type) ||
          a.keys.reduce((order, key) => order || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0), 0);
        const ordered = batches.flatMap(batch => batch.rows.map(row => ({ ...row, type: batch.type, keys: batch.keys }))).sort(compare);
        // Do not pass the lower unseen frontier of either index. A dependency
        // can raise an entity's effective frequency; defer it instead of
        // discarding hot query snapshots through a cold-looking child.
        const frontier = batches.filter(batch => !batch.exhausted).map(batch => ({ ...batch.rows.at(-1), type: batch.type, keys: batch.keys })).sort(compare)[0];
        const redirectPartitions = new Map();
        for (const raw of ordered) {
          if ((frontier && compare(raw, frontier) > 0) || removed >= RECLAIM_REMOVALS || (scanned && performance.now() - started >= RECLAIM_MS)) break;
          this.#reclaimCursor[raw.type] = [raw.priority, raw.read_order, ...raw.keys.map(key => raw[key])];
          scanned++;
          const row = this.#usageCandidate(raw.type, raw, now);
          if (row.protected) continue;
          if (row.effectivePriority > raw.priority + 1e-7) continue;
          if (raw.type === 'query') this.#db.prepare('DELETE FROM catalog_queries WHERE key=?').run(raw.key);
          else if (raw.type === 'redirect') {
            if (!this.#redirectReclaimable(row, now, redirectPartitions)) continue;
            this.#db.prepare('DELETE FROM catalog_redirects WHERE scope=? AND object=? AND id=?').run(raw.scope, raw.object, raw.id);
          }
          else if (this.#retireEntity(raw.scope, raw.object, raw.id, { reclaimPriority: row.effectivePriority }) === null) continue;
          removed++; this.#reclaimSweepRemoved++;
          if (this.#allocatedBytes() <= this.#reclaimTarget) break;
        }
        const ended = batches.every(batch => batch.exhausted && (!batch.rows.length ||
          JSON.stringify(this.#reclaimCursor[batch.type]) === JSON.stringify([batch.rows.at(-1).priority,
            batch.rows.at(-1).read_order, ...batch.keys.map(key => batch.rows.at(-1)[key])])));
        if (ended) {
          // All remaining data may be in its grace period. Retry later rather
          // than spinning the event loop or bypassing that protection.
          waitMs = this.#reclaimSweepRemoved ? 20 : 60_000;
          this.#reclaimCursor = {}; this.#reclaimSweepRemoved = 0;
        }
      }
      this.#db.exec('COMMIT'); transaction = false;
      if (this.#allocatedBytes() <= this.#reclaimTarget) {
        this.#reclaimTarget = null; this.#reclaimCursor = {}; this.#reclaimSweepRemoved = 0;
      }
    } catch {
      if (transaction) try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original observations on disk/SQL failure. */ }
      this.#reclaimCursor = originalCursor; this.#reclaimSweepRemoved = originalRemoved;
      removed = 0;
      waitMs = 60_000;
    } finally {
      if (busyTimeout !== undefined) try { this.#db.exec(`PRAGMA busy_timeout=${busyTimeout}`); } catch { /* Retry maintenance later. */ }
    }
    const pending = this.#reclaimTarget !== null;
    if (pending) this.#scheduleReclaim(waitMs);
    return { pending, removed, scanned, waitMs, blocked: pending && waitMs >= 60_000 };
  }

  #counts() {
    const rows = this.#db.prepare('SELECT * FROM catalog_totals').all(), totals = Object.fromEntries(rows.map(row => [row.table_name, row]));
    return { entities: totals.catalog_entities.n, queries: totals.catalog_queries.n, relationships: totals.catalog_relationships.n,
      names: totals.catalog_names.n, bytes: rows.reduce((total, row) => total + row.bytes, 0) };
  }

  stats() {
    return { ...(this.#closed ? { entities: 0, queries: 0, relationships: 0, names: 0, bytes: 0 } : this.#counts()),
      maxFileBytes: this.#maxFileBytes, capacityMode: 'soft',
      fileReclaimAtBytes: Math.floor(this.#maxFileBytes * 0.95), fileReclaimToBytes: Math.floor(this.#maxFileBytes * 0.9), persistent: this.#persistent, degraded: this.#degraded };
  }

  getMetadata(key) {
    if (this.#closed || typeof key !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(key)) return null;
    try { const row = this.#db.prepare('SELECT value FROM catalog_metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
    catch { return null; }
  }

  setMetadata(key, value) {
    if (this.#closed || typeof key !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(key) || !jsonValue(value)) return false;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 4096) return false;
    try {
      if (!this.#db.prepare('SELECT 1 FROM catalog_metadata WHERE key=?').get(key) && this.#db.prepare('SELECT COUNT(*) AS n FROM catalog_metadata').get().n >= 100) return false;
      this.#db.prepare('INSERT INTO catalog_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, json); return true;
    } catch { return false; }
  }

  close() {
    if (!this.#closed) {
      clearInterval(this.#usageTimer); clearTimeout(this.#reclaimTimer);
      for (const partition of this.#pendingRetirements.keys()) this.#flushRetirements(partition);
      this.flushUsage();
      this.#db.close(); this.#closed = true;
      this.#pendingUsage.clear();
      this.#pendingRetirements.clear();
    }
  }
}
