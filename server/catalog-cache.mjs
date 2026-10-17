// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ENTRIES = 10_000;

function normalizedIdentity(object, id) { return object === 'work' ? `nm:${id}` : `${object === 'credit_name' ? 'credit' : object}:nm:${id}`; }
function cardIdentities(value, result = new Set()) {
  if (Array.isArray(value)) { for (const child of value) cardIdentities(child, result); }
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['id', 'personId', 'seedId'].includes(key) && typeof child === 'string') result.add(child);
      else if (child && typeof child === 'object') cardIdentities(child, result);
    }
  }
  return result;
}

function privateFile(file) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Invalid catalogue cache directory.');
  // Preserve permissions on an existing host-owned directory. mkdir's mode
  // applies only to new cache directories, while the cache file stays private.
  let descriptor;
  try { descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid catalogue cache file.');
  chmodSync(file, 0o600);
}

function jsonValue(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || depth > 64 || seen.has(value) ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
  seen.add(value);
  const valid = Object.values(value).every(item => jsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

/** Shared catalogue JSON only. Callers own validation and credential-free keys.
 * Freshness and retention are separate: stale records survive until bounded LRU
 * eviction, so saved recommendation pools can still render without network I/O.
 * maxBytes counts UTF-8 keys + JSON. SQLite additionally needs bounded indexes
 * and page overhead; FULL auto-vacuum reclaims pages after every transaction.
 */
export class CatalogCache {
  #db;
  #now;
  #maxBytes;
  #maxEntries;
  #sequence = 0;
  #closed = false;
  #persistent = false;
  #degraded = false;
  #touches = new Map();
  #maxFileBytes;
  #catalogRevisions = new Map();

  constructor({ file, now = Date.now, maxBytes = DEFAULT_BYTES, maxEntries = DEFAULT_ENTRIES } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3 ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000 ||
        (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')))) {
      throw new TypeError('Invalid catalogue cache configuration.');
    }
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    try { this.#open(file); }
    catch (error) {
      if (file === undefined) throw error;
      this.#degraded = true;
      if (/file is not a database|database disk image is malformed/i.test(error.message)) {
        try {
          // This cache is replaceable. Preserve corruption evidence separately;
          // never remove or migrate any account database or caller's other files.
          const quarantine = `${file}.corrupt-${randomUUID()}`;
          renameSync(file, quarantine);
          for (const suffix of ['-journal', '-wal', '-shm']) {
            if (existsSync(file + suffix)) renameSync(file + suffix, quarantine + suffix);
          }
          this.#open(file);
          return;
        } catch { /* Unwritable cache storage degrades to bounded memory. */ }
      }
      this.#open();
    }
  }

  #open(file) {
    if (file !== undefined) privateFile(file);
    this.#db = new DatabaseSync(file ?? ':memory:');
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA auto_vacuum = FULL;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA trusted_schema = OFF;
        CREATE TABLE IF NOT EXISTS catalog_cache (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK (bytes > 0),
          expires_at INTEGER NOT NULL,
          touched INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS catalog_cache_lru ON catalog_cache(touched);
        CREATE INDEX IF NOT EXISTS catalog_cache_lookup ON catalog_cache(key,expires_at);
        CREATE TABLE IF NOT EXISTS catalog_cache_revisions (
          scope TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0)
        ) WITHOUT ROWID;
      `);
      if (!this.#db.prepare('PRAGMA table_info(catalog_cache)').all().some(column => column.name === 'observed_at')) {
        this.#db.exec('ALTER TABLE catalog_cache ADD COLUMN observed_at INTEGER');
      }
      // Bound physical growth as well as logical payload. Reserve headroom for
      // SQLite pages/indexes and the largest transactional replacement; DELETE
      // journaling avoids an ever-growing WAL and FULL auto-vacuum shrinks frees.
      const pageSize = this.#db.prepare('PRAGMA page_size').get().page_size;
      const pageLimit = Math.max(16, Math.ceil((this.#maxBytes * 3 + this.#maxEntries * 1024 + 65_536) / pageSize));
      this.#maxFileBytes = pageLimit * pageSize;
      this.#sequence = this.#db.prepare('SELECT COALESCE(MAX(touched), 0) AS sequence FROM catalog_cache').get().sequence;
      this.#trim();
      this.#db.exec(`PRAGMA max_page_count = ${pageLimit}`);
      this.#persistent = file !== undefined;
    } catch (error) { this.#db.close(); throw error; }
  }

  #key(key) { return typeof key === 'string' && key.length > 0 && key.length <= 4096 && !key.includes('\0'); }

  // The directory and presentation cache are separate databases. Persist the
  // last applied generation here so a crash between their commits cannot leave
  // deleted cards available through allowStale after restart.
  bindCatalogRevision(scope, getRevision, { getWorkObservedAt } = {}) {
    if (!this.#key(scope) || typeof getRevision !== 'function' ||
        (getWorkObservedAt !== undefined && typeof getWorkObservedAt !== 'function')) return false;
    this.#catalogRevisions.set(scope, { getRevision, getWorkObservedAt, pending: null, removedCards: 0 });
    return this.#synchronizeCatalogRevision(scope);
  }

  findCatalogIdentities({ scope, events = [] }) {
    const wanted = new Set(events.filter(event => ['credit_name', 'person'].includes(event?.object) && /^\d{1,20}$/.test(event.id)).map(event => `${event.object}:${event.id}`));
    const found = new Set();
    if (this.#closed || !this.#key(scope) || !wanted.size) return found;
    // Predicate only: reading through get() here would acknowledge the new
    // directory revision before its targeted invalidation was supplied.
    try {
      const add = (object, id) => { const key = `${object}:${id}`; if (wanted.has(key)) found.add(key); };
      const read = this.#db.prepare('SELECT key,value FROM catalog_cache WHERE key>=? AND key<? AND expires_at>?');
      for (const nsfw of [false, true]) for (const kind of ['credit-name', 'credit-alias', 'person-names']) {
        const prefix = `${scope}:${kind}:${nsfw}:`;
        for (const row of read.all(prefix, `${prefix}\uffff`, this.#now())) {
          add(kind === 'person-names' ? 'person' : 'credit_name', row.key.slice(prefix.length));
          // Each roster is decoded once per feed page, not once per event.
          const value = JSON.parse(row.value);
          if (kind === 'credit-alias') add('credit_name', value.id);
          if (kind === 'credit-name') add('person', value.row?.person_id);
          for (const id of value.ids ?? []) add('credit_name', id);
          for (const member of value.members ?? []) add('credit_name', member?.id);
        }
      }
    } catch { return wanted; } // A temporarily unreadable known cache is conservative.
    return found;
  }

  invalidateCatalogChanges({ scope, revision, previousRevision, workIds = [], workChanges = [], entityChanges = [], identitiesChanged = true } = {}) {
    const state = this.#catalogRevisions.get(scope);
    if (!state || !Number.isSafeInteger(revision) || revision < 0 ||
        !Number.isSafeInteger(previousRevision) || previousRevision < 0 || !Array.isArray(workIds) || !Array.isArray(workChanges) || !Array.isArray(entityChanges)) return false;
    state.removedCards = 0;
    state.pending = { revision, previousRevision: state.pending?.previousRevision ?? previousRevision,
      workIds: [...new Set([...(state.pending?.workIds ?? []), ...workIds.filter(id => /^nm:\d{1,20}$/.test(id))])],
      workChanges: [...(state.pending?.workChanges ?? []), ...workChanges.filter(change => /^nm:\d{1,20}$/.test(change?.id) && Number.isSafeInteger(change.updatedAt))],
      entityChanges: [...(state.pending?.entityChanges ?? []), ...entityChanges.filter(change => /^[a-z][a-z_]{0,63}$/.test(change?.object) && /^\d{1,20}$/.test(change?.id) && Number.isSafeInteger(change.updatedAt))],
      identitiesChanged: identitiesChanged || state.pending?.identitiesChanged === true };
    if (state.pending.workIds.length + state.pending.workChanges.length + state.pending.entityChanges.length > 10_000) {
      // A prolonged write lock must not accumulate an unbounded event journal.
      // Loss of the targeted interval uses the same conservative recovery as a
      // crash, while all reads remain gated until that transaction can commit.
      state.pending.previousRevision = -1; state.pending.workIds = []; state.pending.workChanges = []; state.pending.entityChanges = [];
    }
    const applied = this.#synchronizeCatalogRevision(scope);
    return { applied, removedCards: state.removedCards };
  }

  #synchronizeCatalogRevision(scope) {
    if (this.#closed) return false;
    const state = this.#catalogRevisions.get(scope);
    if (!state) return true;
    let busyTimeout, transaction = false;
    try {
      const revision = state.getRevision();
      if (!Number.isSafeInteger(revision) || revision < 0) return false;
      const saved = this.#db.prepare('SELECT revision FROM catalog_cache_revisions WHERE scope=?').get(scope);
      if (saved?.revision === revision) { state.pending = null; state.removedCards = 0; return true; }
      busyTimeout = this.#db.prepare('PRAGMA busy_timeout').get().timeout;
      this.#db.exec('PRAGMA busy_timeout=0');
      this.#db.exec('BEGIN IMMEDIATE'); transaction = true;
      const pending = state.pending;
      const targeted = pending?.revision === revision && (saved?.revision ?? 0) === pending.previousRevision;
      let removedCards = 0;
      if (targeted) {
        const remove = this.#db.prepare('DELETE FROM catalog_cache WHERE key=?');
        for (const id of pending.workIds) { removedCards += remove.run(`card:${id}`).changes; this.#touches.delete(`card:${id}`); }
        const removeOlder = this.#db.prepare('DELETE FROM catalog_cache WHERE key=? AND (observed_at IS NULL OR observed_at<?)');
        for (const { id, updatedAt } of pending.workChanges) {
          removedCards += removeOlder.run(`card:${id}`, updatedAt).changes; this.#touches.delete(`card:${id}`);
        }
        const changes = new Map();
        for (const event of pending.entityChanges) {
          const key = normalizedIdentity(event.object, event.id);
          changes.set(key, Math.max(changes.get(key) ?? 0, event.updatedAt));
        }
        if (changes.size) {
          const latest = Math.max(...changes.values());
          for (const row of this.#db.prepare("SELECT key,value,observed_at FROM catalog_cache WHERE key>='card:' AND key<'card;' AND (observed_at IS NULL OR observed_at<?)").all(latest)) {
            let affected;
            try { affected = [...cardIdentities(JSON.parse(row.value))].some(id => changes.has(id) && (row.observed_at === null || row.observed_at < changes.get(id))); }
            catch { affected = true; }
            if (affected) { removedCards += remove.run(row.key).changes; this.#touches.delete(row.key); }
          }
        }
      } else if (revision !== 0 || saved) {
        // An unknown interval (restart, missed callback or rollback) has no
        // trustworthy dependency list. Only this recovery path clears all cards.
        removedCards += this.#db.prepare("DELETE FROM catalog_cache WHERE key>='card:' AND key<'card;'").run().changes;
        for (const key of this.#touches.keys()) if (key.startsWith('card:')) this.#touches.delete(key);
      }
      for (const prefix of (!targeted || pending.identitiesChanged) ? [`${scope}:credit-`, `${scope}:person-names:`] : []) {
        this.#db.prepare('DELETE FROM catalog_cache WHERE key>=? AND key<?').run(prefix, `${prefix}\uffff`);
        for (const key of this.#touches.keys()) if (key.startsWith(prefix)) this.#touches.delete(key);
      }
      this.#db.prepare('INSERT INTO catalog_cache_revisions VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision').run(scope, revision);
      this.#db.exec('COMMIT'); transaction = false; state.pending = null; state.removedCards = removedCards;
      return true;
    } catch {
      if (transaction) try { this.#db.exec('ROLLBACK'); } catch { /* Keep the revision mismatch as a durable read barrier. */ }
      return false;
    } finally {
      if (busyTimeout !== undefined) try { this.#db.exec(`PRAGMA busy_timeout=${busyTimeout}`); } catch { /* Optional cache remains unavailable. */ }
    }
  }

  #catalogReadable(key) {
    for (const scope of this.#catalogRevisions.keys()) {
      if ((key.startsWith('card:') || key.startsWith(`${scope}:credit-`) || key.startsWith(`${scope}:person-names:`)) &&
          !this.#synchronizeCatalogRevision(scope)) return false;
    }
    return true;
  }

  #sourceObservation(key, serialized) {
    if (!key.startsWith('card:nm:')) return this.#now();
    // A card can be saved long after the raw catalogue was read. Its storage
    // time is not evidence of source freshness, and must not hide feed updates.
    const observations = [...this.#catalogRevisions.values()].map(state => state.getWorkObservedAt?.(key.slice(8)))
      .filter(value => Number.isSafeInteger(value) && value >= 0);
    let observedAt = observations.length ? Math.min(...observations) : null;
    const previous = this.#db.prepare('SELECT value, observed_at FROM catalog_cache WHERE key=?').get(key);
    if (previous?.value === serialized) {
      // Re-saving an unchanged private recommendation reference is not a new
      // observation. Legacy unknown provenance remains unknown until replaced.
      observedAt = previous.observed_at === null || observedAt === null ? null : Math.min(previous.observed_at, observedAt);
    }
    return observedAt;
  }

  get(key, { allowStale = false } = {}) {
    if (this.#closed || !this.#key(key) || !this.#catalogReadable(key)) return undefined;
    let row;
    // Keep missing identity lookups on a compact index, away from the large
    // JSON records stored in the WITHOUT ROWID primary tree.
    try { row = this.#db.prepare('SELECT value, expires_at FROM catalog_cache INDEXED BY catalog_cache_lookup WHERE key = ?').get(key); }
    catch { return undefined; } // Optional metadata stays a cache miss during storage contention.
    if (!row || (!allowStale && row.expires_at <= this.#now())) return undefined;
    let value;
    try { value = JSON.parse(row.value); }
    catch { this.delete(key); return undefined; }
    // Read traffic stays read-only on disk. Apply promotions atomically before
    // the next eviction, preserving LRU order without a transaction per card.
    this.#touches.set(key, ++this.#sequence);
    if (this.#touches.size > this.#maxEntries) this.#touches.delete(this.#touches.keys().next().value);
    return value;
  }

  set(key, value, { ttlMs } = {}) {
    return this.setMany([[key, value]], { ttlMs });
  }

  // A recommendation pool must either retain every required card or leave the
  // old pool's cards intact. Preflight and SQLite rollback cover both capacity
  // rejection and a write failure partway through the batch.
  setMany(entries, { ttlMs } = {}) {
    if (this.#closed || !Array.isArray(entries) || entries.length > this.#maxEntries ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1) return false;
    const expiresAt = this.#now() + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) return false;
    const rows = [], keys = new Set();
    let totalBytes = 0;
    try {
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return false;
        const [key, value] = entry;
        if (!this.#key(key) || keys.has(key) || !jsonValue(value) || !this.#catalogReadable(key)) return false;
        keys.add(key);
        const serialized = JSON.stringify(value);
        const bytes = Buffer.byteLength(key) + Buffer.byteLength(serialized);
        totalBytes += bytes;
        if (totalBytes > this.#maxBytes) return false;
        rows.push({ key, serialized, bytes, observedAt: this.#sourceObservation(key, serialized) });
      }
    } catch { return false; }
    if (!rows.length) return true;
    let transaction = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); transaction = true;
      this.#flushTouches();
      const insert = this.#db.prepare(`INSERT INTO catalog_cache (key, value, bytes, expires_at, touched, observed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes,
          expires_at=excluded.expires_at, touched=excluded.touched, observed_at=excluded.observed_at`);
      for (const row of rows) insert.run(row.key, row.serialized, row.bytes, expiresAt, ++this.#sequence, row.observedAt);
      this.#trim();
      const retained = this.#db.prepare('SELECT 1 FROM catalog_cache WHERE key = ?');
      if (rows.some(row => !retained.get(row.key))) throw new Error('Catalogue cache batch exceeds retention capacity.');
      this.#db.exec('COMMIT');
      this.#touches.clear();
    } catch {
      if (transaction) { try { this.#db.exec('ROLLBACK'); } catch { /* SQLITE_FULL may already have rolled back. */ } }
      return false;
    }
    return true;
  }

  #flushTouches() {
    const touch = this.#db.prepare('UPDATE catalog_cache SET touched = ? WHERE key = ?');
    for (const [key, sequence] of this.#touches) touch.run(sequence, key);
  }

  #trim() {
    let { entries, bytes } = this.stats();
    const oldest = this.#db.prepare('SELECT key, bytes FROM catalog_cache ORDER BY touched, key LIMIT 1');
    const remove = this.#db.prepare('DELETE FROM catalog_cache WHERE key = ?');
    while (entries > this.#maxEntries || bytes > this.#maxBytes) {
      const row = oldest.get();
      remove.run(row.key);
      entries--; bytes -= row.bytes;
    }
  }

  delete(key) {
    if (this.#closed || !this.#key(key)) return false;
    try {
      const removed = this.#db.prepare('DELETE FROM catalog_cache WHERE key = ?').run(key).changes > 0;
      this.#touches.delete(key);
      return removed;
    } catch { return false; } // Corrupt-row cleanup and invalidation are best effort.
  }

  stats() {
    if (this.#closed) return { entries: 0, bytes: 0, maxEntries: this.#maxEntries, maxBytes: this.#maxBytes };
    const counts = this.#db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM catalog_cache').get();
    return { ...counts, maxEntries: this.#maxEntries, maxBytes: this.#maxBytes,
      persistent: this.#persistent, degraded: this.#degraded, maxFileBytes: this.#maxFileBytes };
  }

  close() {
    if (!this.#closed) {
      try {
        if (this.#touches.size) {
          this.#db.exec('BEGIN IMMEDIATE');
          this.#flushTouches();
          this.#db.exec('COMMIT');
        }
      } catch { /* LRU promotion is optional if storage disappears at shutdown. */ }
      finally { this.#db.close(); this.#closed = true; }
    }
  }
}
