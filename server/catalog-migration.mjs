// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MARKER = 'legacy-catalog-cache-v1';
const LEGACY_TTL = 15 * 60_000;
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const WORK_KEY = /^(nextmoe:v1:[a-f0-9]{64}):work:(true|false):none:([0-9]{1,20}):(detail|list)$/;
const IDENTITY_KEY = /^(nextmoe:v1:[a-f0-9]{64}):(credit-name|person-names):(true|false):([0-9]{1,20})$/;
const WORK_BLOCKS = ['titles', 'refs', 'credits', 'releases', 'series', 'platforms', 'companies', 'tags', 'characters', 'covers'];
const decimal = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const named = row => [row?.display_name, row?.latin, ...Object.values(object(row?.localized) ? row.localized : {}).map(value => value?.value)]
  .some(value => typeof value === 'string' && value.trim());
const creditName = row => object(row) && row.object === 'credit_name' && decimal(row.id) && named(row) && (row.person_id === null || decimal(row.person_id));
const counters = () => ({ scanned: 0, imported: 0, skipped: 0, invalid: 0, failed: 0 });

function decode(row) {
  const work = WORK_KEY.exec(row.key), identity = IDENTITY_KEY.exec(row.key);
  // Exact-query hashes cannot recover the original path/parameters. Normalized
  // recommendation cards have a different lifetime and are not raw catalogue
  // observations. Neither is eligible for this migration.
  if (!work && !identity) return { skipped: true };
  try {
    const value = JSON.parse(row.value);
    let expiresAt = Number(row.expires_at);
    if (row.value === null || !object(value) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(expiresAt - LEGACY_TTL)) return { invalid: true };
    let resource, params, data;
    if (work) {
      const [, scope, nsfw, id, variant] = work;
      if (value.object !== 'work' || value.id !== id || !named(value)) return { invalid: true };
      const include = WORK_BLOCKS.filter(field => Array.isArray(value[field])).sort().join(',');
      resource = variant === 'detail' ? `/catalog/works/${id}` : '/catalog/works';
      params = { nsfw, spoiler: 'none', ...(include ? { include } : {}), ...(variant === 'list' ? { ids: id } : {}) };
      data = variant === 'detail' ? value : { object: 'list', items: [value] };
      return { request: { scope, path: resource, params, data, ttlMs: LEGACY_TTL, observedAt: expiresAt - LEGACY_TTL } };
    }
    const [, scope, kind, nsfw, id] = identity;
    if (!Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.expiresAt - LEGACY_TTL)) return { invalid: true };
    // The outer key/value TTL may have rounded a delayed write forward. Never
    // exceed either original bound, including for already-expired observations.
    expiresAt = Math.min(expiresAt, value.expiresAt);
    if (kind === 'credit-name') {
      if (!creditName(value.row) || value.row.id !== id) return { invalid: true };
      resource = '/catalog/credit-names'; params = { ids: id, nsfw };
      data = { object: 'list', items: [value.row] };
    } else {
      // A partially collected roster is not proof of a complete person list.
      // Individual names have separate basic cache rows and remain importable.
      if (value.complete !== true) return { skipped: true };
      if (!Array.isArray(value.ids) || !Array.isArray(value.members) || value.ids.length !== value.members.length ||
          new Set(value.ids).size !== value.ids.length || new Set(value.members.map(member => member?.id)).size !== value.members.length ||
          !value.ids.every(decimal) || !value.members.every(member => creditName(member) && member.person_id === id && value.ids.includes(member.id))) return { invalid: true };
      resource = `/catalog/persons/${id}/credit-names`; params = { nsfw };
      data = { object: 'list', items: value.members };
    }
    return { request: { scope, path: resource, params, data, ttlMs: LEGACY_TTL, observedAt: expiresAt - LEGACY_TTL } };
  } catch { return { invalid: true }; }
}

/** Import only documented legacy catalogue rows; never open the account DB.
 * Source reads are immutable. The target retains each observation's original
 * expiry, so retries and old cache imports cannot renew stale catalogue facts.
 * A bounded pass checkpoints after its last accepted row; a failed target write
 * is retried on a later startup, while completed imports never replay.
 */
export function migrateCatalogCache({ file, database, maxRows = 10_000 } = {}) {
  const result = { version: 1, status: 'missing', complete: false, ...counters(), errors: [], checkpoint: null };
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'catalog-cache.sqlite' || file.includes('\0')) {
    return { ...result, status: 'invalid-source', errors: ['INVALID_SOURCE'] };
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000 ||
      !database || ['ingest', 'getMetadata', 'setMetadata'].some(method => typeof database[method] !== 'function')) {
    return { ...result, status: 'unavailable', errors: ['INVALID_TARGET_OR_LIMIT'] };
  }
  let marker;
  try { marker = database.getMetadata(MARKER); }
  catch { return { ...result, status: 'unavailable', errors: ['TARGET_UNAVAILABLE'] }; }
  if (marker?.version === 1 && marker.complete === true) {
    return { ...result, status: 'already-complete', complete: true, checkpoint: { key: marker.key ?? null, complete: true } };
  }
  let source, sourceId, key = '';
  try {
    const facts = lstatSync(file);
    if (!facts.isFile() || facts.isSymbolicLink()) return { ...result, status: 'invalid-source', errors: ['INVALID_SOURCE'] };
    sourceId = createHash('sha256').update(`${realpathSync(file)}\0${facts.dev}\0${facts.ino}`).digest('hex');
    if (marker?.version === 1 && marker.sourceId === sourceId && typeof marker.key === 'string' && marker.key.length <= 4096) key = marker.key;
    source = new DatabaseSync(file, { readOnly: true });
    source.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const columns = new Set(source.prepare('PRAGMA table_info(catalog_cache)').all().map(column => column.name));
    if (!['key', 'value', 'expires_at'].every(column => columns.has(column))) return { ...result, status: 'unavailable', errors: ['INVALID_CACHE_SCHEMA'] };
    const rows = source.prepare(`SELECT key, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value,
      CAST(expires_at AS TEXT) AS expires_at FROM catalog_cache WHERE key > ? ORDER BY key LIMIT ?`).iterate(MAX_ROW_BYTES, key, maxRows + 1);
    let more = false, failed = false;
    for (const row of rows) {
      if (result.scanned === maxRows) { more = true; break; }
      result.scanned++;
      const decoded = decode(row);
      if (decoded.request) {
        let accepted = false;
        try { accepted = database.ingest(decoded.request) === true; } catch { /* Do not expose stored JSON or backend diagnostics. */ }
        if (!accepted) { result.failed++; result.errors.push('TARGET_WRITE_FAILED'); failed = true; break; }
        result.imported++;
      } else {
        result.skipped++;
        if (decoded.invalid) result.invalid++;
      }
      key = row.key;
    }
    const complete = !more && !failed;
    const previous = marker?.sourceId === sourceId && object(marker.totals) ? marker.totals : {};
    const totals = Object.fromEntries(Object.keys(counters()).map(name => [name, (Number.isSafeInteger(previous[name]) && previous[name] >= 0 ? previous[name] : 0) + result[name]]));
    let saved = false;
    try { saved = database.setMetadata(MARKER, { version: 1, sourceId, key, complete, totals }) === true; } catch { /* A replay preserves observedAt, never granting a new TTL. */ }
    result.complete = complete && saved;
    result.status = result.complete ? 'complete' : 'partial';
    result.checkpoint = { key: saved ? key : null, complete: result.complete };
    if (!saved) result.errors.push('CHECKPOINT_WRITE_FAILED');
    return result;
  } catch (error) {
    return { ...result, status: error.code === 'ENOENT' ? 'missing' : 'unavailable', errors: error.code === 'ENOENT' ? [] : ['SOURCE_UNAVAILABLE'] };
  } finally { source?.close(); }
}
