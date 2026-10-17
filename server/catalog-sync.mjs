// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from 'node:crypto';

const SCOPE = 'nextmoe:public-catalog:v2';
const BUDGET_KEY = 'catalog-sync:requests:v1';
const DAY = 86_400_000;
const FEEDS = ['changes', 'redirects'];
const OBJECTS = new Set(['work', 'release', 'character', 'credit_name', 'person', 'company', 'tag', 'engine']);
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const cursor = value => typeof value === 'string' && value.length <= 512 && /^cur_[A-Za-z0-9._~-]+$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

function failure(code) { return Object.assign(new Error(code), { code }); }
function timestamp(value) {
  if (typeof value !== 'string') throw failure('INVALID_FEED');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(value);
  if (!parts) throw failure('INVALID_FEED');
  const parsed = Date.parse(value), date = new Date(parsed);
  if (!Number.isSafeInteger(parsed) || date.getUTCFullYear() !== Number(parts[1]) || date.getUTCMonth() + 1 !== Number(parts[2]) ||
      date.getUTCDate() !== Number(parts[3]) || date.getUTCHours() !== Number(parts[4]) || date.getUTCMinutes() !== Number(parts[5]) ||
      date.getUTCSeconds() !== Number(parts[6])) throw failure('INVALID_FEED');
  return parsed;
}
function parsePage(data, feed, previous) {
  if (!plain(data) || data.object !== 'list' || !Array.isArray(data.items) || data.items.length > 100 ||
      (Object.hasOwn(data, 'next_cursor') && (!cursor(data.next_cursor) || data.next_cursor === previous?.cursor))) {
    throw failure('INVALID_FEED');
  }
  const events = data.items.map(row => {
    if (!plain(row) || !OBJECTS.has(row.target_object)) throw failure('INVALID_FEED');
    if (feed === 'changes') {
      if (row.object !== 'change' || !id(row.id) || (Object.hasOwn(row, 'gone') && row.gone !== true)) throw failure('INVALID_FEED');
      return { object: row.target_object, id: row.id, updatedAt: timestamp(row.updated_at), ...(row.gone === true ? { gone: true } : {}) };
    }
    if (row.object !== 'redirect' || !id(row.old_id) || !id(row.current_id) || row.old_id === row.current_id) throw failure('INVALID_FEED');
    return { object: row.target_object, id: row.old_id, currentId: row.current_id, updatedAt: timestamp(row.merged_at) };
  });
  // Keep the original timestamp strings in this digest: RFC3339 may carry
  // sub-millisecond precision even though the database uses milliseconds.
  const hash = createHash('sha256').update(JSON.stringify([feed, data.items, data.next_cursor ?? null])).digest('hex');
  return { events, hasMore: Object.hasOwn(data, 'next_cursor'),
    checkpoint: { cursor: data.next_cursor ?? previous?.cursor ?? null, lastPageHash: hash } };
}
function readCheckpoint(database, feed) {
  const saved = database.getChangeCheckpoint({ scope: SCOPE, feed });
  if (saved === null || saved === undefined) return null;
  if (!plain(saved) || (saved.cursor !== null && !cursor(saved.cursor)) ||
      (saved.lastPageHash !== undefined && (typeof saved.lastPageHash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.lastPageHash)))) {
    throw failure('INVALID_CHECKPOINT');
  }
  return saved;
}
function retryDelay(value, now) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(DAY, Math.max(1000, Number(value) * 1000));
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.min(DAY, Math.max(1000, date - now)) : 60_000;
}

/** Low-priority invalidation, not a full catalogue importer. Public metadata is
 * refreshed by the normal authoritative read pipeline when somebody needs it.
 */
export class CatalogSync {
  #transport; #database; #enabled; #interval; #requestInterval; #maximum; #timeout;
  #now; #setTimeout; #clearTimeout; #busy; #onApplied; #onError;
  #running = false; #stopped = false; #timer; #controller; #pending;
  #notification = null; #stagedPage = null;
  #nextRequestAt = 0; #blockedUntil = 0; #nextFeed = 0;
  #due = { changes: 0, redirects: 0 }; #failures = { changes: 0, redirects: 0 };
  #lastSuccessAt = null; #lastError = null; #lastOutcome = 'idle'; #lastFeed = null; #budget = null;

  constructor({ client, transport, database, enabled = true, intervalMs = 900_000, requestIntervalMs = 15_000,
    maxRequestsPerDay = 2000, timeoutMs = 15_000, now = Date.now,
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    isForegroundBusy = () => Boolean(client?.busy), onApplied = () => {}, onError = () => {} } = {}) {
    if (!transport || !['runBackground', 'fetch', 'status', 'backgroundReady'].every(key => typeof transport[key] === 'function') ||
        !database || !['getChangeCheckpoint', 'applyChangePage', 'getMetadata', 'setMetadata'].every(key => typeof database[key] === 'function') ||
        typeof enabled !== 'boolean' || ![intervalMs, requestIntervalMs, maxRequestsPerDay, timeoutMs].every(positive) ||
        intervalMs > DAY || requestIntervalMs > DAY || timeoutMs > 60_000 ||
        ![now, setTimeoutImpl, clearTimeoutImpl, isForegroundBusy, onApplied, onError].every(value => typeof value === 'function')) {
      throw new TypeError('Invalid catalogue sync options.');
    }
    this.#transport = transport; this.#database = database; this.#enabled = enabled;
    this.#interval = intervalMs; this.#requestInterval = requestIntervalMs; this.#maximum = maxRequestsPerDay; this.#timeout = timeoutMs;
    this.#now = now; this.#setTimeout = setTimeoutImpl; this.#clearTimeout = clearTimeoutImpl;
    this.#busy = isForegroundBusy; this.#onApplied = onApplied; this.#onError = onError;
  }

  #configured() { return this.#transport.status().credentialMode === 'application'; }
  status() {
    return { enabled: this.#enabled, configured: this.#configured(), running: this.#running, active: Boolean(this.#pending),
      pendingPage: Boolean(this.#stagedPage),
      lastOutcome: this.#lastOutcome, lastFeed: this.#lastFeed, lastSuccessAt: this.#lastSuccessAt,
      lastError: this.#lastError, nextRequestAt: Math.max(this.#blockedUntil, this.#nextRequestAt),
      requestsToday: this.#budget?.day === Math.floor(this.#now() / DAY) ? this.#budget.count : 0,
      maxRequestsPerDay: this.#maximum };
  }
  start() {
    if (this.#running || !this.#enabled || !this.#configured()) return false;
    this.#stopped = false; this.#running = true; this.#schedule(); return true;
  }
  async stop() {
    this.#running = false; this.#stopped = true;
    this.#clearTimeout(this.#timer); this.#timer = undefined;
    this.#controller?.abort();
    await this.#pending;
    this.#stagedPage = null;
  }
  #schedule() {
    if (!this.#running || this.#stopped || this.#timer !== undefined) return;
    if (!this.#configured()) { this.#running = false; return; }
    const due = Math.max(this.#blockedUntil, this.#nextRequestAt, Math.min(...Object.values(this.#due)));
    this.#timer = this.#setTimeout(async () => {
      this.#timer = undefined;
      try { await this.runOnce(); }
      finally { this.#schedule(); }
    }, Math.max(0, Math.min(DAY, due - this.#now())));
    this.#timer?.unref?.();
  }
  runOnce() {
    if (this.#pending) return this.#pending;
    this.#pending = this.#run().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  #reserve(now) {
    const day = Math.floor(now / DAY), stored = this.#database.getMetadata(BUDGET_KEY);
    if (stored !== null && stored !== undefined && (!plain(stored) || !Number.isSafeInteger(stored.day) || !Number.isSafeInteger(stored.count) ||
        stored.count < 0 || (stored.lastRequestAt !== undefined && !Number.isSafeInteger(stored.lastRequestAt)))) throw failure('INVALID_BUDGET');
    // A failed/older metadata read must not lower a budget already observed by
    // this running worker. Persisted reservations still own restart recovery.
    const known = this.#budget && (!stored || this.#budget.day > stored.day ||
      (this.#budget.day === stored.day && this.#budget.count >= stored.count)) ? this.#budget : stored;
    const saved = known && known.day >= day ? known : { day, count: 0 };
    this.#budget = saved;
    if (saved.day > day || saved.count >= this.#maximum) {
      this.#blockedUntil = Math.max(this.#blockedUntil, (saved.day + 1) * DAY); return false;
    }
    if (saved.lastRequestAt !== undefined && saved.lastRequestAt + this.#requestInterval > now) {
      this.#nextRequestAt = saved.lastRequestAt + this.#requestInterval; return false;
    }
    const next = { day, count: saved.count + 1, lastRequestAt: now };
    // Reserve before I/O. A crash may waste a slot, but cannot reset the daily
    // budget or spend an unrecorded request on every process restart.
    if (this.#database.setMetadata(BUDGET_KEY, next) !== true) throw failure('BUDGET_SAVE_FAILED');
    this.#budget = next; return true;
  }
  async #read(feed, checkpoint, signal) {
    const url = new URL(`https://api.nextmoe.dev/v2/catalog/${feed}`);
    url.searchParams.set('limit', '100');
    if (checkpoint?.cursor) url.searchParams.set('cursor', checkpoint.cursor);
    const response = await this.#transport.runBackground(() => this.#transport.fetch(url, {
      method: 'GET', headers: { Accept: 'application/json' }, signal, redirect: 'error',
    }));
    signal.throwIfAborted();
    if (!response.ok) {
      const error = failure(response.status === 429 ? 'RATE_LIMITED' : [401, 403].includes(response.status) ? 'AUTH_REQUIRED' : 'UPSTREAM_UNAVAILABLE');
      error.retryMs = retryDelay(response.headers.get('retry-after'), this.#now());
      try { await response.body?.cancel(); } catch { /* Preserve the status-based cooldown if the response stream already failed. */ }
      throw error;
    }
    let data;
    try { data = await response.json(); } catch { throw failure('INVALID_FEED'); }
    signal.throwIfAborted();
    return parsePage(data, feed, checkpoint);
  }
  async #run() {
    if (this.#stopped || !this.#enabled || !this.#configured()) return { outcome: 'disabled' };
    const now = this.#now();
    if (now < this.#nextRequestAt || now < this.#blockedUntil) return { outcome: 'waiting' };
    const feed = this.#notification?.feed || this.#stagedPage?.feed ||
      [FEEDS[this.#nextFeed], FEEDS[1 - this.#nextFeed]].find(value => this.#due[value] <= now);
    if (!feed) return { outcome: 'waiting' };
    let timeout;
    try {
      if (this.#notification) {
        const { hasMore } = this.#notification;
        this.#notify(); this.#completed(feed, hasMore, 'notified');
        return { outcome: 'notified', feed };
      }
      if (this.#stagedPage) {
        if (this.#busy()) return this.#defer(feed);
        const { checkpoint, page } = this.#stagedPage; this.#stagedPage = null;
        return this.#apply(feed, checkpoint, page);
      }
      if (this.#busy() || this.#transport.backgroundReady() !== true) {
        this.#nextRequestAt = now + this.#requestInterval;
        this.#lastOutcome = 'deferred'; return { outcome: 'deferred' };
      }
      const checkpoint = readCheckpoint(this.#database, feed);
      if (!this.#reserve(now)) { this.#lastOutcome = 'budget'; return { outcome: 'budget' }; }
      this.#nextRequestAt = now + this.#requestInterval;
      this.#nextFeed = 1 - FEEDS.indexOf(feed); this.#lastFeed = feed;
      const controller = new AbortController(); this.#controller = controller;
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason || failure('ABORTED')), { once: true });
      });
      timeout = this.#setTimeout(() => controller.abort(failure('TIMEOUT')), this.#timeout);
      const page = await Promise.race([this.#read(feed, checkpoint, controller.signal), cancelled]);
      controller.signal.throwIfAborted();
      // A foreground exploration may have started while this page was in
      // flight. Keep one bounded page until it is idle again; do not invalidate
      // that exploration or spend another request downloading the same page.
      if (this.#busy()) {
        this.#stagedPage = { feed, checkpoint, page };
        return this.#defer(feed);
      }
      return this.#apply(feed, checkpoint, page);
    } catch (error) {
      if (this.#stopped) { this.#lastOutcome = 'stopped'; return { outcome: 'stopped', feed }; }
      const code = ['INVALID_FEED', 'INVALID_CHECKPOINT', 'INVALID_BUDGET', 'BUDGET_SAVE_FAILED', 'APPLY_FAILED', 'NOTIFY_FAILED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'TIMEOUT'].includes(error?.code)
        ? error.code : 'SYNC_FAILED';
      const backoff = Math.min(3_600_000, this.#interval * 2 ** Math.min(this.#failures[feed]++, 5));
      const delay = code === 'RATE_LIMITED' ? Math.max(this.#requestInterval, error.retryMs || 60_000)
        : code === 'AUTH_REQUIRED' ? Math.max(3_600_000, this.#interval) : code === 'NOTIFY_FAILED' ? this.#requestInterval : backoff;
      this.#due[feed] = this.#now() + delay;
      this.#nextRequestAt = Math.max(this.#nextRequestAt, this.#now() + this.#requestInterval);
      if (code === 'RATE_LIMITED' || code === 'AUTH_REQUIRED') this.#blockedUntil = this.#now() + delay;
      this.#lastError = { code, feed, at: this.#now() }; this.#lastOutcome = 'error';
      try { this.#onError(this.#lastError); } catch { /* Diagnostics cannot restart a failing loop. */ }
      return { outcome: 'error', code, feed };
    } finally {
      if (timeout !== undefined) this.#clearTimeout(timeout);
      this.#controller = undefined;
    }
  }
  #notify() {
    try { this.#onApplied(this.#notification.result); }
    catch { throw failure('NOTIFY_FAILED'); }
    this.#notification = null;
  }
  #defer(feed) {
    this.#nextRequestAt = this.#now() + this.#requestInterval;
    this.#lastOutcome = 'deferred'; return { outcome: 'deferred', feed };
  }
  #completed(feed, hasMore, outcome) {
    const now = this.#now();
    // Slow local invalidation must not consume the quiet interval reserved for
    // foreground traffic. Both feeds wait from completion, not request start.
    this.#nextRequestAt = Math.max(this.#nextRequestAt, now + this.#requestInterval);
    this.#due[feed] = now + (hasMore ? this.#requestInterval : this.#interval);
    this.#failures[feed] = 0; this.#lastSuccessAt = now; this.#lastError = null;
    this.#lastOutcome = outcome;
  }
  #apply(feed, checkpoint, page) {
    const unchanged = checkpoint?.lastPageHash === page.checkpoint.lastPageHash && checkpoint?.cursor === page.checkpoint.cursor;
    let result;
    if (!unchanged) {
      result = this.#database.applyChangePage({ scope: SCOPE, feed, expectedCheckpoint: checkpoint,
        checkpoint: page.checkpoint, events: page.events });
      if (!result || result.applied !== true) throw failure('APPLY_FAILED');
      // Synchronous notification closes the gap between a committed retirement
      // and every live client's process-local caches becoming aware of it.
      this.#notification = { feed, result, hasMore: page.hasMore }; this.#notify();
    }
    this.#completed(feed, page.hasMore, unchanged ? 'unchanged' : 'applied');
    return { outcome: this.#lastOutcome, feed, hasMore: page.hasMore, ...(result ? { result } : {}) };
  }
}
