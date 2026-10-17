// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server-only, read-only NextMoe catalog adapter.
 * Contract checked against public OpenAPI 2.38.1 (2026-10-09).
 * The application key needs catalog:read. Pass it from a server environment
 * variable; never import this module into browser assets or expose the key.
 *
 * Responses retain NextMoe's original shape, IDs, role keys and pagination.
 * In particular, getRoles() is one page, not a promise of a complete registry.
 * This module does not normalize catalog data or enable live recommendations.
 * An injected catalogue cache persists bounded raw records and query pages.
 * Request budgets remain process-local, not a multi-instance quota service.
 */

import { creatorFactsFromPages } from './creator-profile.mjs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hasCatalogName, hasWorkCredits, hasWorkRelationships, hasWorkSeries, isUsableWorkRecord, isUsableNameCreditRecord, isUsableSearchRecord, normalizeSearchHit } from './catalog-normalize.mjs';

const BASE_URL = 'https://api.nextmoe.dev/v2';
const CACHE_LIMIT = 256;
const TTL = { search: 60_000, work: 900_000, credits: 900_000, roles: 86_400_000 };
const digest = value => createHash('sha256').update(value).digest('hex');
const WORK_BLOCKS = ['titles', 'refs', 'credits', 'releases', 'series', 'platforms', 'companies', 'tags', 'covers', 'characters'];
const decimalId = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const usableCreditName = row => row?.object === 'credit_name' && decimalId(row.id) && hasCatalogName(row) &&
  (row.person_id === null || decimalId(row.person_id));
const compareIds = (a, b) => a.length - b.length || a.localeCompare(b);

const COLLECTION_OBJECTS = { works: 'work', 'credit-names': 'credit_name', companies: 'company', persons: 'person',
  characters: 'character', releases: 'release', series: 'series', tags: 'tag', traits: 'trait', engines: 'engine' };
const NESTED_OBJECTS = { ...COLLECTION_OBJECTS, siblings: 'credit_name', credit_names: 'credit_name',
  work: 'work', person: 'person', credit_name: 'credit_name', company: 'company', character: 'character',
  release: 'release', tag: 'tag', trait: 'trait', engine: 'engine' };
const RELATION_OBJECTS = new Set(['list', 'search', 'search_hit', 'credit', 'name_credit', 'work_credit', 'person_credit', 'credit_group']);

export function catalogIdentityMatcher(events) {
  const wanted = new Map(events.map(({ object, id }) => [object === 'work' ? `nm:${id}` : `${object === 'credit_name' ? 'credit' : object}:nm:${id}`, `${object}:${id}`]));
  return (value, found = new Set()) => {
    const visit = node => {
      if (Array.isArray(node)) { for (const child of node) visit(child); return; }
      if (!node || typeof node !== 'object') return;
      for (const id of [node.id, node.personId, node.seedId]) if (wanted.has(id)) found.add(wanted.get(id));
      for (const child of Object.values(node)) if (child && typeof child === 'object') visit(child);
    };
    visit(value); return found;
  };
}

// A list/detail started before an explicit removal must not revive that entity
// when it arrives later. Track only removals occurring during this request;
// this is bounded by in-flight work and is not a permanent negative cache.
function referencesRetired(data, path, params, retired) {
  if (!retired?.size) return false;
  const matches = (object, id) => typeof id === 'string' && retired.has(`${object}:${id}`);
  const route = /^\/catalog\/([^/]+)(?:\/([0-9]+))?(?:\/([^/]+))?$/.exec(path);
  const rootObject = COLLECTION_OBJECTS[route?.[1]];
  if (matches(rootObject, route?.[2])) return true;
  if (params.ids?.split(',').some(id => matches(rootObject, id))) return true;
  for (const [field, value] of Object.entries(params)) {
    if (field.endsWith('_id') && matches(field.slice(0, -3), value)) return true;
  }
  const visit = (value, inferred) => {
    if (Array.isArray(value)) return value.some(row => visit(row, inferred));
    if (!value || typeof value !== 'object') return false;
    // A career row's own ID identifies a relationship, not a credited name.
    // Infer only named embedded entities, matching the structured store rules.
    const relation = RELATION_OBJECTS.has(value.object);
    const named = ['display_name', 'name', 'latin', 'localized'].some(field => value[field] !== undefined);
    const object = value.target_object || (!relation ? value.object || (named && !Object.hasOwn(value, 'source') ? inferred : null) : null);
    if (matches(object, value.id)) return true;
    for (const [field, child] of Object.entries(value)) {
      if (field.endsWith('_id') && matches(field.slice(0, -3), child)) return true;
      const hint = field === 'items' ? (route?.[3] ? NESTED_OBJECTS[route[3]] : rootObject)
        : field === 'credits' && value.role_key ? 'credit_name' : NESTED_OBJECTS[field];
      if (child && typeof child === 'object' && visit(child, hint)) return true;
    }
    return false;
  };
  return visit(data, rootObject);
}

// Include tokens alone are not evidence that an upstream actually returned the
// required facts. Cross-query reuse requires the core requested blocks,
// including legal empty arrays, plus validated credit/company relationships.
// Characters and alternate covers are optional presentation facts. Cards use
// the main cover/banner; missing alternate artwork must not trigger another
// catalogue request after the complete detail was already obtained.
const OPTIONAL_WORK_BLOCKS = new Set(['characters', 'covers']);
function completeWork(data, params, { collection = false } = {}) {
  return isUsableWorkRecord(data) && hasWorkRelationships(data) &&
    (!params.include.split(',').includes('series') || hasWorkSeries(data)) &&
    params.include.split(',').every(block => WORK_BLOCKS.includes(block) && (OPTIONAL_WORK_BLOCKS.has(block) || Array.isArray(data[block]) ||
      // On collection lanes, titles elects latin/localized rather than returning
      // the detail-only titles array. Preserve the upstream shape and do not
      // promote these summary fields into complete alternate-title details.
      (collection && block === 'titles' && (data.latin === null || typeof data.latin === 'string') &&
        data.localized !== null && typeof data.localized === 'object' && !Array.isArray(data.localized))));
}
function relationshipsAvailable(data, expected) {
  if (!expected.workRelationships && !expected.workSeries) return true;
  const matches = work => (!expected.workRelationships || hasWorkRelationships(work)) &&
    (!expected.workSeries || hasWorkSeries(work));
  return expected.object === 'work' ? matches(data) : data.items.every(matches);
}
function creditsAvailable(data, expected) {
  return !expected.workCredits || (expected.object === 'work' ? hasWorkCredits(data) : data.items.every(hasWorkCredits));
}
const SAFE_UPSTREAM_CODES = new Set([
  'ENTITY_MERGED', 'NOT_FOUND', 'SCOPE_REQUIRED', 'INVALID_API_KEY',
  'UNAUTHORIZED', 'FORBIDDEN', 'LIMIT_TOO_LARGE', 'INVALID_CURSOR',
  'RATE_LIMITED', 'QUOTA_EXCEEDED', 'INTERNAL_SERVER_ERROR',
]);

export class NextMoeError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null, currentId = null, currentObject = null, upstreamCode = null } = {}) {
    super(message);
    this.name = 'NextMoeError';
    this.code = code;
    this.status = status;
    if (retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (currentId !== null) this.currentId = currentId;
    if (currentObject !== null) this.currentObject = currentObject;
    if (upstreamCode !== null) this.upstreamCode = upstreamCode;
  }

  toJSON() {
    return Object.fromEntries(
      ['code', 'message', 'status', 'retryAfterMs', 'currentId', 'currentObject', 'upstreamCode']
        .filter(key => this[key] !== undefined)
        .map(key => [key, this[key]]),
    );
  }
}

function invalid(message) {
  return new NextMoeError('INVALID_INPUT', message, { status: 400 });
}

function nsfwOption(nsfw = false) {
  if (typeof nsfw !== 'boolean') throw invalid('The NSFW setting must be a boolean.');
  return String(nsfw);
}

function catalogId(id) {
  if (typeof id !== 'string' || !/^[0-9]{1,20}$/.test(id)) {
    throw invalid('Catalog IDs must be decimal strings containing 1–20 digits.');
  }
  return encodeURIComponent(id);
}

function pageOptions(options = {}, defaultLimit = 20) {
  const { limit = defaultLimit, cursor } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalid('Page size must be an integer between 1 and 100.');
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512 || !cursor.startsWith('cur_'))) {
    throw invalid('The cursor must be an opaque NextMoe cur_ cursor.');
  }
  return { limit: String(limit), ...(cursor === undefined ? {} : { cursor }) };
}

function retryDelay(value, now) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const milliseconds = Number(value) * 1_000;
    if (Number.isFinite(milliseconds) && milliseconds <= Number.MAX_SAFE_INTEGER) return milliseconds;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 60_000;
}

function aborted() {
  return new NextMoeError('CANCELLED', 'The catalog request was cancelled.');
}

// Upstream requires an explicit site filter and privileged scope for private
// claims. The managed transport forbids that filter; guard observations too so
// an upstream contract change cannot silently enter the ordinary shared view.
function assertPublicCatalogue(data) {
  const pending = [data];
  while (pending.length) {
    const row = pending.pop();
    if (!row || typeof row !== 'object') continue;
    if (row.claim !== undefined && row.claim !== null &&
      (typeof row.claim !== 'object' || !['live', 'draft'].includes(row.claim.state))) {
      throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned a catalogue view that cannot be shared.');
    }
    for (const value of Object.values(row)) if (value && typeof value === 'object') pending.push(value);
  }
}

// Validate the endpoint's minimum envelope before a successful response can
// enter the cache. Optional include fields and additive upstream fields remain
// untouched; unsupported media are still classified by the catalog provider.
function validateResponse(data, expected) {
  const matches = data?.object === expected.object && (expected.object === 'list'
    ? Array.isArray(data.items)
    : data.id === expected.id && hasCatalogName(data) &&
      (expected.object !== 'work' || isUsableWorkRecord(data)));
  if (!matches) throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned an unexpected catalog response.');
}

// Keep a shared request only while at least one caller still needs it. An
// individual cancellation must never interrupt another subscriber.
function subscribe(request, signal, onEmpty) {
  request.subscribers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      request.subscribers--;
      return true;
    };
    const onAbort = () => {
      if (!cleanup()) return;
      reject(aborted());
      if (!request.settled && request.subscribers === 0) onEmpty();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.promise.then(
      value => { if (cleanup()) resolve(value); },
      error => { if (cleanup()) reject(error); },
    );
    if (signal?.aborted) onAbort();
  });
}

export class NextMoeClient {
  #transport;
  #apiKey;
  #fetch;
  #now;
  #timeoutMs;
  #cache = new Map();
  #inflight = new Map();
  #rateLimitedUntil = 0;
  #requests = [];
  #maxRequests;
  #concurrency;
  #active = 0;
  #requestSequence = 0;
  #queue = [];
  #maxQueue;
  #queueTimeoutMs;
  #lastSuccessAt = null;
  #lastConnectionFailureAt = null;
  #catalogCache;
  #catalogDatabase;
  #cacheScope;
  #creatorAliases = new Map();
  #creatorIdentityVersion = 0;
  #catalogRetirementVersion = 0;
  #catalogRetirementVersions = new Map();
  #catalogRetirementEvents = new Map();
  #creditNames = new Map();
  #personNames = new Map();
  #catalogRevision = 0;
  #catalogDatabaseRevision = 0;
  #catalogSyncRevision = 0;
  #catalogPendingNotification = null;
  #catalogObservers = new Set();
  #identityLookups = null;

  constructor({ apiKey, transport, catalogCache, catalogDatabase, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, maxRequestsPerMinute = 45, concurrency = 2, maxQueue = 16, queueTimeoutMs = 20_000 } = {}) {
    if (typeof window !== 'undefined') throw new NextMoeError('SERVER_ONLY', 'NextMoe credentials belong on the server.');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || /\s/.test(apiKey))) {
      throw invalid('The application key must be a string without whitespace.');
    }
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw invalid('A fetch function and clock function are required.');
    if (catalogCache !== undefined && (!catalogCache || !['get', 'set', 'delete'].every(method => typeof catalogCache[method] === 'function'))) throw invalid('Invalid catalogue cache.');
    if (catalogDatabase !== undefined && (!catalogDatabase || !['read', 'ingest', 'find', 'retire'].every(method => typeof catalogDatabase[method] === 'function'))) throw invalid('Invalid catalogue database.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw invalid('The timeout must be between 1 and 60000 milliseconds.');
    if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1 || maxRequestsPerMinute > 60) throw invalid('The local upstream budget must be between 1 and 60 requests per minute.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw invalid('Upstream concurrency must be between 1 and 4.');
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 64 || !Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 60_000) throw invalid('Invalid upstream queue bounds.');
    this.#apiKey = apiKey || null;
    if (transport && typeof transport.fetch !== 'function') throw invalid('Invalid catalogue transport.');
    this.#transport = transport;
    this.#catalogCache = catalogCache;
    this.#catalogDatabase = catalogDatabase;
    // Capabilities may differ even between two live keys. Persist only an opaque
    // fingerprint, never credentials; key rotation deliberately starts a scope.
    // Managed routing admits only the ordinary public catalogue, never site
    // claim views. Do not inherit old credential-specific observations.
    this.#cacheScope = transport ? 'nextmoe:public-catalog:v2' : `nextmoe:v1:${digest(apiKey || 'unconfigured')}`;
    this.#fetch = transport ? transport.fetch.bind(transport) : fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#maxRequests = maxRequestsPerMinute;
    this.#concurrency = concurrency;
    this.#maxQueue = maxQueue;
    this.#queueTimeoutMs = queueTimeoutMs;
    this.#catalogRevision = this.#catalogDatabaseRevision = this.#catalogDatabase?.getChangeRevision?.({ scope: this.#cacheScope }) ?? 0;
    this.#catalogSyncRevision = this.#catalogDatabase?.getSyncRevision?.({ scope: this.#cacheScope }) ?? this.#catalogDatabaseRevision;
    if (this.#catalogDatabase?.getChangeRevision) {
      this.#catalogCache?.bindCatalogRevision?.(this.#cacheScope, () => this.#catalogDatabase?.getSyncRevision?.({ scope: this.#cacheScope }) ?? this.#catalogDatabase?.getChangeRevision?.({ scope: this.#cacheScope }) ?? this.#catalogSyncRevision,
        { getWorkObservedAt: id => this.#catalogDatabase?.getWorkObservedAt?.({ scope: this.#cacheScope, id }) });
    }
  }

  status() {
    return {
      configured: Boolean(this.#transport || this.#apiKey),
      ...(this.#transport ? this.#transport.status() : {}),
      requiredScope: 'catalog:read',
      liveConnectionVerified: this.#lastSuccessAt !== null,
      lastSuccessAt: this.#lastSuccessAt,
      catalogUnavailable: this.#lastConnectionFailureAt !== null && this.#now() - this.#lastConnectionFailureAt < 60_000,
      keyType: this.#apiKey?.startsWith('nmk_test_') ? 'test' : this.#apiKey ? 'live' : 'none',
      requestsPerMinute: this.#transport ? null : this.#maxRequests,
      cache: this.#catalogDatabase ? 'shared-catalogue-database' : this.#catalogCache ? 'bounded-shared-catalogue' : 'bounded-process-local',
    };
  }

  get inflightScope() { return this.#transport?.inflightScope() || ''; }
  get busy() { return this.#active > 0 || this.#queue.length > 0 || this.#inflight.size > 0; }
  registerCatalogCache(cache) {
    if (typeof cache?.findCatalogIdentities !== 'function') return;
    for (const ref of this.#catalogObservers) { const value = ref.deref(); if (!value) this.#catalogObservers.delete(ref); else if (value === cache) return; }
    this.#catalogObservers.add(new WeakRef(cache));
  }

  #findCatalogIdentities(events) {
    const found = this.#catalogCache?.findCatalogIdentities?.({ scope: this.#cacheScope, events }) ?? new Set();
    const wanted = new Set(events.map(event => `${event.object}:${event.id}`));
    const add = (object, id) => { const key = `${object}:${id}`; if (wanted.has(key)) found.add(key); };
    for (const [map, kind] of [[this.#creditNames, 'credit_name'], [this.#creatorAliases, 'credit_name'], [this.#personNames, 'person']]) {
      for (const [key, row] of map) if (row.expiresAt > this.#now()) {
        add(kind, key.slice(key.lastIndexOf(':') + 1));
        if (map === this.#creatorAliases) add('credit_name', row.id);
        if (map === this.#creditNames) add('person', row.row?.person_id);
        for (const id of row.ids ?? []) add('credit_name', id);
      }
    }
    for (const event of events) for (const request of this.#inflight.values()) {
      if (referencesRetired(null, request.path, request.params, new Set([`${event.object}:${event.id}`]))) found.add(`${event.object}:${event.id}`);
    }
    for (const ref of this.#catalogObservers) {
      const cache = ref.deref();
      if (!cache) this.#catalogObservers.delete(ref);
      else for (const identity of cache.findCatalogIdentities(events)) found.add(identity);
    }
    return found;
  }
  get catalogRevision() {
    const revision = this.#catalogDatabase?.getChangeRevision?.({ scope: this.#cacheScope });
    return this.#catalogRevision + (Number.isSafeInteger(revision) ? Math.max(0, revision - this.#catalogDatabaseRevision) : 0);
  }

  applyCatalogChanges(result = {}) {
    const syncRevision = result.syncRevision ?? result.revision;
    if (!result.applied || !Number.isSafeInteger(result.revision) || !Number.isSafeInteger(syncRevision) || syncRevision <= this.#catalogSyncRevision) return false;
    const previousRevision = this.#catalogSyncRevision;
    const pending = this.#catalogPendingNotification?.syncRevision === syncRevision ? this.#catalogPendingNotification : null;
    const events = (Array.isArray(result.events) ? result.events : []).filter(event =>
      event && typeof event.object === 'string' && /^[a-z][a-z_]{0,63}$/.test(event.object) && decimalId(event.id));
    const redirects = (result.redirectChanges ?? []).filter(event => event && decimalId(event.id) && typeof event.object === 'string');
    const relevant = redirects.length ? this.#findCatalogIdentities(redirects) : new Set();
    const included = new Set(events.map(event => `${event.object}:${event.id}`));
    for (const event of pending?.events ?? []) {
      const identity = `${event.object}:${event.id}`;
      if (!included.has(identity)) { events.push(event); included.add(identity); }
    }
    for (const event of redirects) {
      // Even an unseen redirect can occur while a broad search is in flight.
      // Fence a response that actually contains that identity, without making
      // every unrelated historical mapping a site-wide cache generation.
      for (const request of this.#inflight.values()) request.retired.add(`${event.object}:${event.id}`);
      const identity = `${event.object}:${event.id}`;
      if (!included.has(identity) && relevant.has(identity)) { events.push(event); included.add(identity); }
    }
    // A historical redirect may change lookup behavior without invalidating
    // newer raw work fields. Only the database's actual dependency set forces
    // removal; feed-only work changes are compared with card source freshness.
    const workIds = [...new Set(result.workIds ?? [])];
    const databaseChanged = result.revision !== this.#catalogDatabaseRevision;
    // A durable deletion may succeed before an adapter reports a failure. Keep
    // one unfinished page so its retry still invalidates process caches even
    // when the deleted card/alias is no longer present to establish relevance.
    this.#catalogPendingNotification = { syncRevision, events };
    const cacheResult = this.#catalogCache?.invalidateCatalogChanges?.({ scope: this.#cacheScope, revision: syncRevision, previousRevision, workIds,
      workChanges: result.workChanges ?? [], entityChanges: result.entityChanges ?? result.redirectChanges ?? events,
      identitiesChanged: databaseChanged || events.length > 0 || result.listsChanged === true });
    const changed = Boolean(pending) || databaseChanged || events.length > 0 || result.listsChanged === true || cacheResult?.removedCards > 0 ||
      (cacheResult?.applied === false && (workIds.length > 0 || result.workChanges?.length > 0 || result.entityChanges?.length > 0 || result.redirectChanges?.length > 0));
    if (changed) {
      this.#creditNames.clear(); this.#personNames.clear(); this.#creatorAliases.clear();
      this.#creatorIdentityVersion++;
      this.#cache.clear();
      // A change page is public catalogue state, so both visibility partitions
      // must stop serving old identities, queries and normalized presentation.
      for (const nsfw of [false, true]) {
        for (const event of events.length ? events : [{ object: 'catalog', id: '0' }]) {
          const merged = decimalId(event.currentId) && event.currentId !== event.id;
          if (event.object === 'credit_name' && merged) {
            const key = `${this.#cacheScope}:credit-alias:${nsfw}:${event.id}`;
            const entry = { id: event.currentId, expiresAt: this.#now() + TTL.roles, observedAt: Number.isSafeInteger(event.updatedAt) ? event.updatedAt : this.#now() };
            this.#rememberCreatorAlias(key, entry);
            this.#catalogCache?.set(key, entry, { ttlMs: TTL.roles });
          }
          this.#recordRetirement(event.object, event.id, merged ? 'ENTITY_MERGED' : event.gone ? 'NOT_FOUND' : 'CATALOG_CHANGED', String(nsfw));
        }
      }
    }
    // Acknowledge only after every derived cache has been handled. The shared
    // database's committed revision remains the durable read barrier meanwhile.
    this.#catalogRevision += changed ? Math.max(1, result.revision - this.#catalogDatabaseRevision) : 0;
    this.#catalogDatabaseRevision = result.revision;
    this.#catalogSyncRevision = syncRevision;
    this.#catalogPendingNotification = null;
    return changed;
  }

  #recordRetirement(object, id, code, scope) {
    this.#catalogRetirementVersion++;
    const version = (this.#catalogRetirementVersions.get(scope) ?? 0) + 1;
    this.#catalogRetirementVersions.set(scope, version);
    const events = this.#catalogRetirementEvents.get(scope) ?? [];
    events.push({ version, object, id, code });
    if (events.length > 64) events.splice(0, events.length - 64);
    this.#catalogRetirementEvents.set(scope, events);
  }

  async searchWorks(query, options = {}) {
    return this.searchCatalog(query, 'work', options);
  }

  // Local names supplement upstream recall; the accumulated corpus is never
  // treated as the complete upstream catalogue or used to suppress pagination.
  searchKnownCatalog(query, { nsfw = false } = {}) {
    nsfwOption(nsfw);
    if ((!this.#apiKey && !this.#transport) || !this.#catalogDatabase || typeof query !== 'string' || !query.trim()) return [];
    return ['work', 'credit_name', 'company'].flatMap(object =>
      this.#catalogDatabase.find({ scope: this.#cacheScope, object, query, nsfw, limit: 100 })
        .map(row => ({ ...row, target_object: object })));
  }

  async searchCatalog(query, object, options = {}) {
    if (!['work', 'credit_name', 'company'].includes(object)) throw invalid('Unsupported search family.');
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 512) {
      throw invalid('Enter a search query containing 1–512 characters.');
    }
    if (object === 'work') {
      // The title-search collection returns names and identifying facts in the
      // same request. Keep its cursor on this endpoint; never hydrate each hit.
      const page = await this.#request('/catalog/works', {
        q: query.trim(), include: 'titles,companies', ...pageOptions(options), nsfw: nsfwOption(options.nsfw),
      }, TTL.search, options.signal, { object: 'list', workItems: true });
      return { ...page, items: page.items.map(row => ({ ...row,
        target_object: isUsableWorkRecord(row) ? 'work' : null })) };
    }
    return this.#request('/catalog/search', {
      object, q: query.trim(), ...pageOptions(options), nsfw: nsfwOption(options.nsfw),
    }, TTL.search, options.signal, { object: 'list', searchItems: true });
  }

  async getWork(id, options = {}) {
    return this.#request(`/catalog/works/${catalogId(id)}`, {
      include: 'titles,refs,credits,releases,series,platforms,companies,tags,characters',
      nsfw: nsfwOption(options.nsfw), spoiler: 'none',
    }, TTL.work, options.signal, { object: 'work', id, workRelationships: options.requireRelationships === true,
      workSeries: options.requireSeries === true }, options.cacheOnly === true);
  }

  async getWorkCredits(id, options = {}) {
    return this.#request(`/catalog/works/${catalogId(id)}/credits`, {
      ...pageOptions(options, 100), nsfw: nsfwOption(options.nsfw),
    }, TTL.credits, options.signal);
  }

  async getCreditNameCredits(id, options = {}) {
    return this.#creditNameRequest(id, options, currentId => this.#request(`/catalog/credit-names/${catalogId(currentId)}/credits`, {
      ...pageOptions(options), nsfw: nsfwOption(options.nsfw),
    }, TTL.credits, options.signal, { object: 'list', creditItems: true }, options.cacheOnly === true));
  }

  // The search endpoint omits person_id. Hydrate up to 100 names together;
  // cache individual basic rows so overlapping searches do not repeat reads.
  async listCreditNames(ids, options = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || options.cursor !== undefined) throw invalid('Credit-name batches need 1–100 IDs and no cursor.');
    nsfwOption(options.nsfw);
    if (!this.#apiKey && !this.#transport) throw new NextMoeError('NOT_CONFIGURED', 'NextMoe is not configured.');
    if (options.signal?.aborted) throw aborted();
    const retirementVersion = this.catalogRetirementVersionFor(options);
    const requested = [...new Set(ids.map(id => { catalogId(id); return this.canonicalCreditNameId(id, options); }))].sort(compareIds);
    if (this.#catalogDatabase) {
      const observations = requested.map(id => this.#databaseCreditName(id, options)).filter(Boolean);
      if (observations.length) this.#rememberCreditNames(observations.map(entry => entry.row), options,
        { expiresAt: Math.min(...observations.map(entry => entry.expiresAt)), restore: true });
    }
    const hits = requested.map(id => this.#cachedCreditName(id, options)).filter(Boolean);
    const found = new Set(hits.map(row => row.id));
    if (hits.length) this.#recordDatabaseUsage({ scope: this.#cacheScope, path: '/catalog/credit-names',
      params: { ids: hits.map(row => row.id).join(','), nsfw: nsfwOption(options.nsfw) } });
    const missing = requested.filter(id => !found.has(id));
    if (!missing.length) return { object: 'list', items: hits };
    if (options.cacheOnly) return { object: 'list', items: hits, missing, partial: true };
    const page = await this.#request('/catalog/credit-names', { ids: missing.join(','), nsfw: nsfwOption(options.nsfw) },
      TTL.work, options.signal, { object: 'list', creditNameItems: true });
    const wanted = new Set(missing);
    const combined = { ...page, items: [...hits, ...page.items.filter(row => wanted.has(row?.id))] };
    const retirements = this.catalogRetirementsSince(retirementVersion, options);
    if (!retirements || referencesRetired(combined, '/catalog/credit-names', {},
      new Set(retirements.map(event => `${event.object}:${event.id}`)))) {
      throw new NextMoeError('INVALID_RESPONSE', 'The catalogue changed while the credited names were loading.', { status: 502 });
    }
    return combined;
  }

  async getPersonCreditNames(id, options = {}) {
    // This subresource returns all linked names and has no pagination input.
    // Preserve any unexpected next_cursor so callers never claim completeness.
    return this.#request(`/catalog/persons/${catalogId(id)}/credit-names`, { nsfw: nsfwOption(options.nsfw) },
      TTL.work, options.signal, { object: 'list', creditNameItems: true, personId: id }, options.cacheOnly === true);
  }

  #identityKey(kind, id, options) {
    return `${this.#cacheScope}:${kind}:${options.nsfw === true}:${id}`;
  }

  #readIdentityCache(map, key) {
    return this.#identityLookup('cache', key, () => this.#readIdentityCacheEntry(map, key));
  }

  #readIdentityCacheEntry(map, key) {
    let entry = map.get(key);
    if (entry?.expiresAt <= this.#now()) { map.delete(key); entry = null; }
    if (!entry) {
      const stored = this.#catalogCache?.get(key);
      if (stored?.expiresAt > this.#now()) { entry = stored; this.#putIdentityCache(map, key, entry, false); }
    }
    return entry;
  }

  #putIdentityCache(map, key, entry, persist = true) {
    map.delete(key); map.set(key, structuredClone(entry));
    while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
    if (persist) this.#catalogCache?.set(key, entry, { ttlMs: Math.max(1, entry.expiresAt - this.#now()) });
  }

  #databaseCreditName(id, options) {
    return this.#identityLookup('database', this.#identityKey('credit-name', id, options), () => this.#databaseCreditNameEntry(id, options));
  }

  #databaseCreditNameEntry(id, options) {
    const stored = this.#catalogDatabase?.read({ scope: this.#cacheScope, path: '/catalog/credit-names',
      params: { ids: id, nsfw: nsfwOption(options.nsfw) } }, { trackUsage: false });
    const basic = stored?.data?.items?.find(item => item.id === id);
    return usableCreditName(basic) ? { row: basic, expiresAt: stored.expiresAt } : null;
  }

  #recordDatabaseUsage(request) {
    // Optional bookkeeping cannot invalidate an otherwise usable cached read
    // or turn a disk/statistics failure into an extra upstream request.
    try { this.#catalogDatabase?.recordUsage?.(request); } catch { /* best-effort usage statistics */ }
  }

  #cachedCreditName(id, options) {
    const basic = this.#databaseCreditName(id, options);
    if (basic) return structuredClone(basic.row);
    // With structured storage enabled, an older presentation index cannot
    // replace missing/expired authoritative facts. Do not probe that index
    // thousands of times only to discard its answer below.
    if (this.#catalogDatabase) return null;
    const row = this.#readIdentityCache(this.#creditNames, this.#identityKey('credit-name', id, options))?.row;
    if (!this.#catalogDatabase && usableCreditName(row) && row.id === id) return structuredClone(row);
    // A large explicitly returned roster must not lose names just because the
    // bounded individual-row LRU evicted its earliest members.
    const prefix = this.#identityKey('person-names', '', options);
    for (const [key, group] of this.#catalogDatabase ? [] : this.#personNames) {
      if (!key.startsWith(prefix) || group.expiresAt <= this.#now()) continue;
      const member = Array.isArray(group.members) ? group.members.find(candidate => candidate?.id === id) : null;
      if (usableCreditName(member)) return structuredClone(member);
    }
    return null;
  }

  #rememberCreditNames(rows, options, { completePersonId = null, expiresAt = this.#now() + TTL.work, restore = false } = {}) {
    if (expiresAt <= this.#now()) return;
    const byPerson = new Map(), writes = new Map();
    if (restore && completePersonId && rows.some(row => {
      const known = this.#cachedCreditName(row.id, options);
      return known && known.person_id !== completePersonId;
    })) completePersonId = null;
    for (const raw of rows) {
      if (!usableCreditName(raw)) continue;
      // Identity caches need basic names/spellings only. Keeping siblings on
      // every member would replicate a full roster inside every other roster.
      let row = Object.fromEntries(['object', 'id', 'person_id', 'display_name', 'latin', 'lang', 'localized', 'aliases']
        .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
      const key = this.#identityKey('credit-name', row.id, options);
      const previous = restore ? this.#cachedCreditName(row.id, options) : this.#readIdentityCache(this.#creditNames, key)?.row;
      // A cached response may recover evicted indexes, but cannot replace a
      // newer explicit person link or turn a cache hit into fresh observation.
      if (restore && previous) row = previous;
      else {
        if (previous?.person_id !== row.person_id) this.#creatorIdentityVersion++;
        const entry = { row, expiresAt };
        this.#putIdentityCache(this.#creditNames, key, entry, false); writes.set(key, entry);
      }
      if (row.person_id) {
        if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
        byPerson.get(row.person_id).push(row);
      }
    }
    if (completePersonId && !byPerson.has(completePersonId)) byPerson.set(completePersonId, []);
    for (const [personId, members] of byPerson) {
      const key = this.#identityKey('person-names', personId, options);
      const cached = this.#readIdentityCache(this.#personNames, key);
      const old = Array.isArray(cached?.ids) && cached.ids.every(decimalId) ? cached : null;
      const complete = completePersonId === personId;
      // A full still-fresh raw roster may complete a partial index recreated
      // by a later basic batch, provided that batch added no unknown members.
      // Never overturn a newer complete roster (including an explicit empty one).
      if (restore && old && (old.complete || !complete || old.ids.some(id => !members.some(row => row.id === id)))) continue;
      const ids = [...new Set((complete ? [] : old?.ids ?? []).concat(members.map(row => row.id)))].sort(compareIds);
      const knownMembers = [...new Map([...(complete ? [] : old?.members ?? []), ...members].map(row => [row.id, row])).values()];
      const retainsComplete = !complete && old?.complete && ids.length === old.ids.length;
      if (old?.ids?.join(',') !== ids.join(',') || Boolean(old?.complete) !== Boolean(complete || retainsComplete)) this.#creatorIdentityVersion++;
      // A partial observation must not extend the lifetime of an older full roster.
      const entry = { ids, members: knownMembers, complete: Boolean(complete || retainsComplete),
        expiresAt: (!complete || restore) && old ? Math.min(old.expiresAt, expiresAt) : expiresAt };
      this.#putIdentityCache(this.#personNames, key, entry, false); writes.set(key, entry);
    }
    if (this.#catalogCache && writes.size && this.#catalogCache.setMany?.([...writes], { ttlMs: Math.max(1, expiresAt - this.#now()) }) !== true) {
      for (const [key, entry] of writes) this.#catalogCache.set(key, entry, { ttlMs: Math.max(1, entry.expiresAt - this.#now()) });
    }
  }

  #rememberCreditNameResponse(data, expected, params, { expiresAt, restore = false } = {}) {
    if (!expected.creditNameItems && expected.object !== 'credit_name') return;
    const rows = expected.object === 'credit_name' ? [data, ...(Array.isArray(data.siblings) ? data.siblings : [])] : data.items;
    const personId = expected.personId ?? (expected.object === 'credit_name' && Array.isArray(data.siblings) ? data.person_id : null);
    const completePersonId = decimalId(personId) && !data.next_cursor && rows.every(row => usableCreditName(row) && row.person_id === personId) ? personId : null;
    this.#rememberCreditNames(rows, { nsfw: params.nsfw === 'true' }, { completePersonId, expiresAt, restore });
  }

  #knownCreatorIdentity(id, options) {
    return this.#identityLookup('identity', this.#identityKey('identity', id, options), () => this.#buildKnownCreatorIdentity(id, options));
  }

  #buildKnownCreatorIdentity(id, options) {
    const canonical = this.canonicalCreditNameId(id, options);
    const row = this.#cachedCreditName(canonical, options);
    if (!row?.person_id) return null;
    const cached = this.#readIdentityCache(this.#personNames, this.#identityKey('person-names', row.person_id, options));
    const group = Array.isArray(cached?.ids) && cached.ids.every(decimalId) ? cached : null;
    if (group?.complete && !group.ids.some(member => this.canonicalCreditNameId(member, options) === canonical)) return null;
    const ids = [...new Set([...(group?.ids ?? []), canonical].map(member => this.canonicalCreditNameId(member, options)))].sort(compareIds);
    const members = ids.map(member => this.#cachedCreditName(member, options)).filter(member => member?.person_id === row.person_id);
    const creditNames = members.map(member => {
      const hit = normalizeSearchHit({ ...member, target_object: 'credit_name' }, options);
      return { id: `credit:nm:${member.id}`, name: member.display_name?.trim() || hit?.label,
        aliases: [...new Set([hit?.label, ...(hit?.aliases ?? []), ...(member.aliases ?? []).map(alias => alias?.value)]
          .filter(value => typeof value === 'string' && value.trim()))] };
    });
    return { id: members[0]?.id ?? canonical, creatorIdentity: { personId: `person:nm:${row.person_id}`, creditNames,
      complete: group?.complete === true && members.length === ids.length } };
  }

  canonicalCreatorGroupId(id, options = {}) {
    nsfwOption(options.nsfw);
    return this.#knownCreatorIdentity(id, options)?.id ?? this.canonicalCreditNameId(id, options);
  }

  getCachedCreatorIdentity(id, options = {}) {
    catalogId(id); nsfwOption(options.nsfw);
    if (options.signal?.aborted) throw aborted();
    // Synchronous publication can re-read authoritative cached identity without
    // opening another await gap. Preserve scope/expiry and keep memoized values
    // private so callers cannot mutate another candidate's identity.
    const known = this.#knownCreatorIdentity(id, options);
    return known ? structuredClone(known) : null;
  }

  getCachedCreatorPersonId(id, options = {}) {
    catalogId(id); nsfwOption(options.nsfw);
    if (options.signal?.aborted) throw aborted();
    // Frozen explorations may outlive an identity cache entry. Distinguish a
    // fresh explicit removal (null) from missing/expired evidence (undefined)
    // without fetching profiles or treating expiry as a person reassignment.
    const canonical = this.canonicalCreditNameId(id, options);
    return this.#cachedCreditName(canonical, options)?.person_id;
  }

  async resolveCreatorIdentity(id, options = {}) {
    catalogId(id); nsfwOption(options.nsfw);
    if (options.signal?.aborted) throw aborted();
    const known = this.#knownCreatorIdentity(id, options);
    if (options.cacheOnly || known?.creatorIdentity.complete) return known;
    if (this.#cachedCreditName(this.canonicalCreditNameId(id, options), options)?.person_id === null) return null;
    await this.getCreditName(id, options);
    return this.#knownCreatorIdentity(id, options);
  }

  async getCreatorCredits(id, options = {}) {
    const maxAliases = options.maxAliases ?? 8;
    if (!Number.isInteger(maxAliases) || maxAliases < 1 || maxAliases > 8 || options.cursor !== undefined) throw invalid('Creator aggregation reads at most 1–8 credited names and their first pages.');
    pageOptions({ limit: options.limit ?? 100 });
    const retirementVersion = this.catalogRetirementVersionFor(options);
    let identity, identityFailed = false;
    const globalFailure = error => ['CANCELLED', 'NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'LOCAL_QUOTA'].includes(error.code) || [401, 403, 429].includes(error.status);
    try { identity = await this.resolveCreatorIdentity(id, options); }
    catch (error) {
      if (globalFailure(error)) throw error;
      identity = this.#knownCreatorIdentity(id, options); identityFailed = true;
    }
    const canonical = this.canonicalCreditNameId(id, options);
    const ids = identity?.creatorIdentity.creditNames.map(row => row.id.slice('credit:nm:'.length)) ?? [canonical];
    const selected = ids.slice(0, maxAliases), pages = [], errors = [];
    let offset = 0, fatal = false;
    const worker = async () => {
      while (!fatal && offset < selected.length) {
        const creditNameId = selected[offset++];
        try {
          let page = await this.getCreditNameCredits(creditNameId, { ...options, limit: options.limit ?? 100 });
          if (page?.items.some(row => !isUsableNameCreditRecord(row))) {
            const items = page.items.filter(isUsableNameCreditRecord);
            if (!items.length) throw new NextMoeError('INVALID_RESPONSE', 'Creator responsibilities are temporarily incomplete.');
            // One malformed career row must not erase the valid duties from
            // that same page. The raw request stays uncached and retryable.
            errors.push({ creditNameId, code: 'INVALID_RESPONSE' });
            page = { ...page, items };
          }
          if (page) pages.push({ ...page, creditNameId });
          else errors.push({ creditNameId, code: 'CACHE_MISS' });
        } catch (error) {
          if (globalFailure(error)) { fatal = true; throw error; }
          errors.push({ creditNameId, code: error.code ?? 'UPSTREAM_ERROR' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, selected.length) }, worker));
    return this.withCreatorIdentityLookups(() => {
      const personId = identity?.creatorIdentity.personId.slice('person:nm:'.length);
      this.#assertUnretired(retirementVersion, { person_id: personId, items: pages.map(page => ({
        credit_name_id: this.canonicalCreditNameId(page.creditNameId, options), items: page.items,
      })) }, '/catalog/credit-names', { nsfw: nsfwOption(options.nsfw) });
      pages.sort((a, b) => compareIds(a.creditNameId, b.creditNameId));
      const currentCanonical = this.canonicalCreditNameId(canonical, options);
      const currentName = this.#cachedCreditName(currentCanonical, options);
      const currentIdentity = this.#knownCreatorIdentity(currentCanonical, options);
      const roster = currentName?.person_id && this.#readIdentityCache(this.#personNames,
        this.#identityKey('person-names', currentName.person_id, options));
      const completeRoster = roster?.complete === true && Array.isArray(roster.ids) && roster.ids.every(decimalId);
      const currentIds = new Set(completeRoster ? roster.ids.map(id => this.canonicalCreditNameId(id, options)) : []);
      // A different read can learn a person reassignment or a replacement full
      // roster while these career pages are loading. Never attribute an already
      // fetched alias to a person that fresh explicit evidence no longer links.
      // Unknown target facts after an ordinary name merge remain partial rather
      // than disproving that merge, so confirmed redirects still work in one turn.
      if ((personId && currentName && currentName.person_id !== personId) || pages.some(page => {
        const id = this.canonicalCreditNameId(page.creditNameId, options);
        const row = this.#cachedCreditName(id, options);
        return (personId && row && row.person_id !== personId) ||
          (completeRoster && id !== currentCanonical && (!currentIds.has(currentCanonical) || !currentIds.has(id)));
      })) throw new NextMoeError('INVALID_RESPONSE', '创作者署名资料已更新，请重新探索以取得当前关联。');
      identity = currentIdentity ?? (currentName?.person_id === null || completeRoster ? null : identity);
      const attempted = new Set(selected.map(id => this.canonicalCreditNameId(id, options)));
      const remainingCreditNameIds = [...new Set((identity?.creatorIdentity.creditNames.map(row => row.id.slice('credit:nm:'.length)) ?? ids)
        .map(id => this.canonicalCreditNameId(id, options)))].filter(id => !attempted.has(id));
      const partial = Boolean(identityFailed || (identity && !identity.creatorIdentity.complete) || remainingCreditNameIds.length || errors.length || pages.some(page => page.next_cursor));
      return { id: identity?.id ?? this.canonicalCreditNameId(id, options), pages,
        ...(identity ? { creatorIdentity: identity.creatorIdentity } : {}), partial, remainingCreditNameIds,
        ...(errors.length ? { errors } : {}) };
    });
  }

  get creatorIdentityVersion() { return this.#creatorIdentityVersion; }
  get catalogRetirementVersion() { return this.#catalogRetirementVersion; }
  catalogRetirementVersionFor({ nsfw = false } = {}) {
    return this.#catalogRetirementVersions.get(nsfwOption(nsfw)) ?? 0;
  }
  catalogRetirementsSince(version, { nsfw = false } = {}) {
    const scope = nsfwOption(nsfw), current = this.#catalogRetirementVersions.get(scope) ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || version > current) return null;
    if (version === current) return [];
    const events = this.#catalogRetirementEvents.get(scope) ?? [];
    // Callers spanning more than the bounded journal conservatively retry.
    if (!events.length || events[0].version > version + 1) return null;
    return events.filter(event => event.version > version).map(event => ({ ...event }));
  }

  #assertUnretired(version, data, path, params) {
    const events = this.catalogRetirementsSince(version, { nsfw: params.nsfw === 'true' });
    if (!events || referencesRetired(data, path, params, new Set(events.map(event => `${event.object}:${event.id}`)))) {
      throw new NextMoeError('INVALID_RESPONSE', '目录资料已更新，请重新查询以取得当前条目。');
    }
  }

  canonicalCreditNameId(id, { nsfw = false } = {}) {
    catalogId(id); nsfwOption(nsfw);
    return this.#identityLookup('redirect', `${nsfw}:${id}`, () => this.#resolveCanonicalCreditNameId(id, { nsfw }));
  }

  #resolveCanonicalCreditNameId(id, { nsfw = false } = {}) {
    const seen = new Set();
    while (!seen.has(id) && seen.size < 8) {
      seen.add(id);
      const key = `${this.#cacheScope}:credit-alias:${nsfw}:${id}`;
      let entry = this.#creatorAliases.get(key);
      if (entry?.expiresAt <= this.#now()) { this.#creatorAliases.delete(key); entry = null; }
      if (!entry) {
        const stored = this.#catalogCache?.get(key);
        if (stored?.id && /^[0-9]{1,20}$/.test(stored.id) && stored.expiresAt > this.#now()) {
          entry = stored; this.#rememberCreatorAlias(key, entry);
        }
      }
      const redirect = this.#catalogDatabase?.getRedirect?.({ scope: this.#cacheScope, object: 'credit_name', id, includeReleased: true });
      if (redirect && (!entry || (entry.observedAt ?? entry.expiresAt - TTL.roles) <= redirect.updatedAt)) {
        if (redirect.currentId === null) {
          if (entry) this.#creatorIdentityVersion++;
          this.#creatorAliases.delete(key); this.#catalogCache?.delete(key); entry = null;
        } else if (decimalId(redirect.currentId) && redirect.currentId !== id) {
          entry = { id: redirect.currentId, expiresAt: Math.min(redirect.expiresAt ?? Infinity, this.#now() + TTL.roles), observedAt: redirect.updatedAt };
          this.#rememberCreatorAlias(key, entry);
        }
      }
      if (!entry || seen.has(entry.id)) break;
      id = entry.id;
    }
    return id;
  }

  #rememberCreatorAlias(key, entry) {
    if (this.#creatorAliases.get(key)?.id !== entry.id) this.#creatorIdentityVersion++;
    this.#creatorAliases.delete(key); this.#creatorAliases.set(key, entry);
    while (this.#creatorAliases.size > CACHE_LIMIT) this.#creatorAliases.delete(this.#creatorAliases.keys().next().value);
  }

  async #creditNameRequest(id, options, read) {
    catalogId(id); nsfwOption(options.nsfw);
    const seen = new Set(), moved = [];
    let current = this.canonicalCreditNameId(id, options);
    for (let hop = 0; hop < 4; hop++) {
      if (options.signal?.aborted) throw aborted();
      if (seen.has(current)) throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned a circular creator redirect.');
      seen.add(current);
      try {
        const result = await read(current);
        if (result) for (const previous of moved) {
          const key = `${this.#cacheScope}:credit-alias:${options.nsfw === true}:${previous}`;
          const entry = { id: current, expiresAt: this.#now() + TTL.roles, observedAt: this.#now() };
          this.#rememberCreatorAlias(key, entry);
          this.#catalogCache?.set(key, entry, { ttlMs: TTL.roles });
        }
        return result;
      } catch (error) {
        // A shared person_id groups distinct credited names separately; it
        // does not establish a canonical replacement for a merged name.
        if (options.cacheOnly || error.code !== 'ENTITY_MERGED' || error.currentObject !== 'credit_name' || !error.currentId) throw error;
        moved.push(current); current = error.currentId;
      }
    }
    throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned too many creator redirects.');
  }

  // Memoize only during one synchronous normalization pass. Nothing survives
  // an await, a later database ingestion, a feed update, or another operation;
  // stale identity facts and negative lookups never gain a new TTL.
  withCreatorIdentityLookups(operation) {
    if (this.#identityLookups) return operation();
    this.#identityLookups = new Map();
    try { return operation(); }
    finally { this.#identityLookups = null; }
  }

  #identityLookup(kind, key, read) {
    const cache = this.#identityLookups;
    if (!cache) return read();
    const lookup = `${kind}:${key}`;
    if (cache.has(lookup)) return cache.get(lookup);
    const value = read();
    cache.set(lookup, value);
    return value;
  }

  canonicalizeWorksCreatorIds(works, options = {}) {
    return this.withCreatorIdentityLookups(() => works.map(work => this.canonicalizeWorkCreatorIds(work, options)));
  }

  canonicalizeWorkCreatorIds(work, options = {}) {
    return this.withCreatorIdentityLookups(() => this.#canonicalizeWorkCreatorIds(work, options));
  }

  #canonicalizeWorkCreatorIds(work, { nsfw = false } = {}) {
    if (!work) return work;
    const normalize = credits => {
      const identities = new Map(), values = [];
      for (const credit of credits) {
        const match = /^credit:nm:([0-9]{1,20})$/.exec(credit.id);
        if (!match) { values.push(credit); continue; }
        const id = `credit:nm:${this.canonicalCreditNameId(match[1], { nsfw })}`;
        const identity = this.#knownCreatorIdentity(match[1], { nsfw });
        // A roster is derived from currently reusable name facts. Rebuild it
        // each time instead of retaining stale aliases after reassignment or
        // expiry. Only the original work may supply an explicit personId:
        // promoting a derived link into that field would make it immutable on
        // a later pass and override the very authority it came from.
        const { creatorIdentity: previousIdentity, ...recordedCredit } = credit;
        const identityFields = identity && (!credit.personId || credit.personId === identity.creatorIdentity.personId)
          ? { creatorIdentity: structuredClone(identity.creatorIdentity) } : {};
        const key = `${id}\u0000${credit.roleKey ?? credit.role}`;
        if (!identities.has(key)) {
          identities.set(key, values.length); values.push({ ...recordedCredit, id, ...identityFields });
        } else {
          const index = identities.get(key), prior = values[index];
          // A proven name merge may join credits for different characters.
          // It removes duplicate duties, never already-known character names.
          if (Array.isArray(credit.characters)) values[index] = { ...prior,
            characters: [...new Map([...(prior.characters || []), ...credit.characters].map(character => [character.id, character])).values()] };
        }
      }
      return values;
    };
    return { ...work,
      ...(Array.isArray(work.credits) ? { credits: normalize(work.credits) } : {}),
      ...(Array.isArray(work.participationCredits) ? { participationCredits: normalize(work.participationCredits) } : {}),
    };
  }

  async getCreatorFacts(id, options = {}) {
    const response = await this.getCreatorCredits(id, { ...options, maxAliases: options.maxAliases ?? 3, limit: 100, cursor: undefined });
    if (options.cacheOnly === true && !response.pages.length) return null;
    if (!response.pages.length || response.pages.some(page => page.items.some(row => !isUsableNameCreditRecord(row)))) {
      throw new NextMoeError('INVALID_RESPONSE', 'Creator responsibilities are temporarily incomplete.');
    }
    return { id: response.id, ...(response.creatorIdentity ? { creatorIdentity: response.creatorIdentity } : {}),
      creatorFacts: creatorFactsFromPages(response.pages, { ...options, complete: !response.partial }) };
  }

  async getCachedCreatorFacts(id, options = {}) {
    return this.getCreatorFacts(id, { ...options, cacheOnly: true });
  }

  // Cache-only probes use precisely the same keys, validation and TTL as reads.
  // They never wait for in-flight traffic or start an upstream request.
  async getCachedWork(id, options = {}) {
    return this.getWork(id, { ...options, cacheOnly: true });
  }

  async getCachedCreditNameCredits(id, options = {}) {
    return this.getCreditNameCredits(id, { ...options, cacheOnly: true });
  }

  async listCachedWorks(options = {}) {
    return this.listWorks({ ...options, cacheOnly: true });
  }

  async getRoles(options = {}) {
    return this.#request('/catalog/roles', pageOptions(options, 100), TTL.roles, options.signal);
  }

  async getCreditName(id, options = {}) {
    return this.#creditNameRequest(id, options, currentId => this.#request(`/catalog/credit-names/${catalogId(currentId)}`, {
      include: 'aliases,intros,links,photo,siblings', nsfw: nsfwOption(options.nsfw),
    }, TTL.work, options.signal, { object: 'credit_name', id: currentId }, options.cacheOnly === true));
  }

  async getCompany(id, options = {}) {
    return this.#request(`/catalog/companies/${catalogId(id)}`, { nsfw: nsfwOption(options.nsfw) }, TTL.work, options.signal, { object: 'company', id });
  }

  async listWorks({ companyId, seriesId, ids, limit = 20, cursor, signal, nsfw = false, requireRelationships = false, allowPartialRelationships = false, requireCredits = false, cacheOnly = false } = {}) {
    const lanes = [companyId, seriesId, ids].filter(value => value !== undefined).length;
    if (lanes !== 1) throw invalid('Use exactly one company, series or ID batch filter.');
    // Characters are a detail-only block. The shared Work response schema does
    // not make them a supported collection include, even on the ids batch lane.
    const params = { include: 'titles,refs,companies,credits,covers,tags', nsfw: nsfwOption(nsfw) };
    if (ids !== undefined) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || cursor !== undefined) throw invalid('ID batches need 1–100 IDs and no cursor.');
      // IDs are a set filter. Canonicalize every caller, including discovery
      // metadata, so different ranking/library orders share one cache request.
      params.ids = [...new Set(ids.map(catalogId))].sort().join(',');
    } else {
      Object.assign(params, pageOptions({limit,cursor}));
      if (companyId !== undefined) params.company_id = catalogId(companyId);
      if (seriesId !== undefined) params.series_id = catalogId(seriesId);
    }
    return this.#request('/catalog/works', params, TTL.credits, signal, { object: 'list', workItems: true,
      workRelationships: requireRelationships === true, allowPartialRelationships: allowPartialRelationships === true,
      workCredits: requireCredits === true }, cacheOnly === true);
  }

  #bounded(operation, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(aborted()); return; }
      let timer;
      let queued;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const removeQueued = () => {
        const index = this.#queue.indexOf(queued);
        if (index !== -1) this.#queue.splice(index, 1);
        cleanup();
      };
      const onAbort = () => { removeQueued(); reject(aborted()); };
      const run = AsyncLocalStorage.bind(() => {
        cleanup();
        if (signal.aborted) { reject(aborted()); return; }
        this.#active++;
        operation().then(resolve, reject).finally(() => {
          this.#active--;
          this.#queue.shift()?.();
        });
      });
      if (this.#active < this.#concurrency) run();
      else {
        if (this.#queue.length >= this.#maxQueue) { reject(new NextMoeError('LOCAL_QUOTA', '目录查询较多，请稍后再试。', {status:429,retryAfterMs:3000})); return; }
        queued = run;
        timer = setTimeout(() => {
          removeQueued();
          reject(new NextMoeError('QUEUE_TIMEOUT', '目录请求等待过久，请稍后重试。', {status:503}));
        }, this.#queueTimeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        this.#queue.push(queued);
      }
    });
  }

  async #request(path, params, ttl, signal, expected = { object: 'list' }, cacheOnly = false) {
    if (!this.#apiKey && !this.#transport) throw new NextMoeError('NOT_CONFIGURED', 'NextMoe is not configured. Set the server-side NEXTMOE_API_KEY with catalog:read.');
    if (signal?.aborted) throw aborted();
    const catalogRevision = this.catalogRevision;
    const retirementVersion = this.catalogRetirementVersionFor({ nsfw: params.nsfw === 'true' });
    const checkCatalogRevision = () => {
      if (catalogRevision !== this.catalogRevision) throw new NextMoeError('CATALOG_CHANGED', '目录资料已更新，请重新查询以取得当前条目。', { status: 409 });
    };
    const url = new URL(`${BASE_URL}${path}`);
    url.search = new URLSearchParams(params).toString();
    const key = url.toString();
    const requestScope = this.inflightScope;
    const inflightKey = `${requestScope}:${key}`;
    const persistentKey = `${this.#cacheScope}:query:${digest(key)}`;
    const directEntity = /^\/catalog\/([a-z-]+)\/(\d+)(?:\/[a-z-]+)?$/.exec(path);
    if (directEntity && COLLECTION_OBJECTS[directEntity[1]]) {
      const object = COLLECTION_OBJECTS[directEntity[1]];
      const redirect = this.#catalogDatabase?.getRedirect?.({ scope: this.#cacheScope, object, id: directEntity[2], params });
      if (redirect?.object === object && decimalId(redirect.currentId) && redirect.currentId !== directEntity[2]) {
        throw new NextMoeError('ENTITY_MERGED', 'This catalogue record was merged into another record.',
          { status: 404, currentId: redirect.currentId, currentObject: object, upstreamCode: 'ENTITY_MERGED' });
      }
    }
    const identityQuery = expected.creditNameItems || expected.object === 'credit_name';
    // The structured store owns current catalogue facts. Older raw caches may
    // otherwise mask a newer field observation or revive a retired identity.
    const cached = this.#catalogDatabase ? null : this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now() && relationshipsAvailable(cached.data, expected) && creditsAvailable(cached.data, expected)) {
      // Frequently reused catalogue data should survive capacity eviction;
      // reading it does not extend its freshness lifetime.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      this.#rememberCreditNameResponse(cached.data, expected, params, { expiresAt: cached.expiresAt, restore: true });
      return structuredClone(cached.data);
    }
    if (cached) this.#cache.delete(key);
    const databaseRequest = { scope: this.#cacheScope, path, params };
    const saved = this.#catalogDatabase?.read(databaseRequest, { trackUsage: false });
    if (saved) {
      try {
        validateResponse(saved.data, expected);
        if (this.#cacheable(saved.data, expected)) {
          this.#rememberCreditNameResponse(saved.data, expected, params, { expiresAt: saved.expiresAt, restore: true });
          this.#recordDatabaseUsage(databaseRequest);
          return structuredClone(saved.data);
        }
      } catch { /* Invalid or incomplete saved facts remain eligible for repair. */ }
      this.#catalogDatabase.invalidateQuery?.(databaseRequest);
    }
    const stored = this.#catalogDatabase ? null : this.#catalogCache?.get(persistentKey);
    if (stored) {
      try {
        // Name indexes and raw query entries may be independently evicted.
        // Retain original freshness with these queries so rebuilding an index
        // after restart does not silently grant another full cache lifetime.
        const storedData = identityQuery ? stored.data : stored;
        if (identityQuery && (stored.identityCacheVersion !== 1 || !Number.isFinite(stored.expiresAt) || stored.expiresAt <= this.#now())) throw invalid('Expired identity cache.');
        validateResponse(storedData, expected);
        if (this.#cacheable(storedData, expected) && relationshipsAvailable(storedData, expected)) {
          if (identityQuery) this.#rememberCreditNameResponse(storedData, expected, params, { expiresAt: stored.expiresAt, restore: true });
          return storedData;
        }
      } catch { /* A corrupt cached envelope must not block an upstream repair. */ }
      this.#catalogCache.delete(persistentKey);
    }
    // Batch omissions are cached only as part of their exact query, never as
    // per-work negative records: a changed batch can retry a previously absent ID.
    if ((this.#catalogCache || this.#catalogDatabase) && !this.#inflight.has(inflightKey) && (expected.object === 'work' || (expected.workItems && params.ids))) {
      const ids = expected.object === 'work' ? [expected.id] : params.ids.split(',');
      const hits = new Map();
      // The store itself remains strict about requested blocks. Cross-shape
      // reuse asks only for the facts this caller requires, while retaining
      // any fresh optional fields already obtained. Never invent empty arrays.
      const reuseParams = { ...params, include: params.include.split(',').filter(block => !OPTIONAL_WORK_BLOCKS.has(block)).join(',') };
      for (const id of ids) {
        const reuseRequest = { ...databaseRequest,
          params: { ...reuseParams, ...(expected.object === 'work' ? {} : { ids: id }) } };
        const entity = this.#catalogDatabase?.read(reuseRequest, { trackUsage: false });
        const storedWork = expected.object === 'work' ? entity?.data : entity?.data?.items?.find(row => row.id === id);
        if (storedWork?.id === id && completeWork(storedWork, params, { collection: expected.workItems === true })) {
          hits.set(id, storedWork); this.#recordDatabaseUsage(reuseRequest); continue;
        }
        for (const variant of this.#catalogDatabase ? [] : ['detail', 'list']) {
          const row = this.#catalogCache?.get(this.#workKey(id, params, variant));
          if (row?.id === id && completeWork(row, params, { collection: expected.workItems === true })) { hits.set(id, row); break; }
        }
      }
      if (hits.size === ids.length) return expected.object === 'work' ? hits.get(ids[0]) : { object: 'list', items: ids.map(id => hits.get(id)) };
      if (cacheOnly) return null;
      if (params.ids) {
        const missing = ids.filter(id => !hits.has(id));
        const overlapping = [...this.#inflight.values()].find(request => request.scope === requestScope && request.path === path && request.params.ids &&
          request.params.include === params.include && request.params.nsfw === params.nsfw &&
          request.params.spoiler === params.spoiler && request.params.ids.split(',').some(id => missing.includes(id)));
        if (overlapping) {
          const covered = new Set(overlapping.params.ids.split(','));
          const uncovered = missing.filter(id => !covered.has(id));
          const pages = await Promise.all([
            this.#request(path, overlapping.params, ttl, signal, expected),
            ...(uncovered.length ? [this.#request(path, { ...params, ids: uncovered.join(',') }, ttl, signal, expected)] : []),
          ]);
          checkCatalogRevision();
          // Coalescing cannot reinterpret a partial or malformed row as a
          // definitive omission. Retry the requested batch after those requests
          // settle; only complete records may cross batch boundaries.
          if (pages.some(page => !page.items.every(row => completeWork(row, params, { collection: true })))) {
            return this.#request(path, params, ttl, signal, expected);
          }
          const wanted = new Set(missing);
          const combined = { object: 'list', items: [...hits.values(), ...pages.flatMap(page => page.items).filter(row => wanted.has(row?.id))] };
          this.#assertUnretired(retirementVersion, combined, path, params);
          return combined;
        }
      }
      if (hits.size > 0) {
        const missing = ids.filter(id => !hits.has(id));
        const fetched = await this.#request(path, { ...params, ids: missing.join(',') }, ttl, signal, expected);
        checkCatalogRevision();
        const combined = { ...fetched, items: [...hits.values(), ...fetched.items] };
        this.#assertUnretired(retirementVersion, combined, path, params);
        return combined;
      }
    }
    if (cacheOnly) return null;
    if (!this.#transport && this.#rateLimitedUntil > this.#now()) {
      throw new NextMoeError('RATE_LIMITED', 'NextMoe asked this client to wait before making another request.', {
        status: 429, retryAfterMs: this.#rateLimitedUntil - this.#now(),
      });
    }
    let pending = this.#inflight.get(inflightKey);
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, subscribers: 0, settled: false, promise: null, path, params, scope: requestScope, retired: new Set(), catalogRevision: this.catalogRevision };
      const shared = pending;
      pending.promise = this.#bounded(async () => {
        // Account when a request actually starts, not when it joins a queue.
        const now = this.#now();
        this.#requests = this.#requests.filter(time => time > now - 60_000);
        if (!this.#transport && this.#rateLimitedUntil > now) throw new NextMoeError('RATE_LIMITED', 'NextMoe asked this client to wait before making another request.', {status:429,retryAfterMs:this.#rateLimitedUntil-now});
        if (!this.#transport && this.#requests.length >= this.#maxRequests) throw new NextMoeError('LOCAL_QUOTA', '本轮目录查询已达到本地请求预算，请稍后再试。', { status:429, retryAfterMs:Math.max(1,this.#requests[0]+60_000-now) });
        this.#requests.push(now);
        shared.sequence = ++this.#requestSequence;
        return this.#fetchJSON(key, controller.signal);
      }, controller.signal).then(data => {
        if (controller.signal.aborted) throw aborted();
        if (shared.catalogRevision !== this.catalogRevision) throw new NextMoeError('CATALOG_CHANGED', '目录资料已更新，请重新查询以取得当前条目。', { status: 409 });
        if (referencesRetired(data, path, params, shared.retired)) {
          throw new NextMoeError('INVALID_RESPONSE', '目录资料已更新，请重新查询以取得当前条目。');
        }
        validateResponse(data, expected);
        this.#lastSuccessAt = new Date(this.#now()).toISOString();
        this.#lastConnectionFailureAt = null;
        this.#rememberCreditNameResponse(data, expected, params);
        // Persist original catalogue fields, entities and relations in one
        // transaction. Only real upstream observations establish freshness.
        // Retain valid siblings from partial batches but never a broken query.
        if (this.#cacheable(data, expected)) {
          this.#catalogDatabase?.ingest({ ...databaseRequest, data, ttlMs: this.#databaseTtl(path, params) });
        } else if (expected.workItems || expected.creditNameItems) {
          const healthy = data.items.filter(row => expected.workItems ? completeWork(row, params, { collection: true }) : usableCreditName(row));
          if (healthy.length) this.#catalogDatabase?.ingest({ ...databaseRequest,
            params: { ...params, ids: healthy.map(row => row.id).join(',') }, data: { object: 'list', items: healthy },
            ttlMs: this.#databaseTtl(path, params) });
        }
        // A broken row must not poison explicit retries for the full TTL.
        // Return usable siblings for the provider's per-work summary cache,
        // without caching this incomplete collection response as a whole.
        if (!this.#catalogDatabase && this.#cacheable(data, expected)) {
          // Delete first so a refresh moves the entry to the end of the queue.
          this.#cache.delete(key);
          const expiresAt = this.#now() + ttl;
          this.#cache.set(key, { data, expiresAt });
          while (this.#cache.size > CACHE_LIMIT) this.#cache.delete(this.#cache.keys().next().value);
          this.#catalogCache?.set(persistentKey, identityQuery ? { identityCacheVersion: 1, data, expiresAt } : data, { ttlMs: ttl });
        }
        // Retain healthy siblings from a partly malformed batch. Never upgrade
        // a summary into full detail or refresh missing blocks by merging rows.
        if (!this.#catalogDatabase && this.#catalogCache && (expected.object === 'work' || expected.workItems)) {
          const variant = expected.object === 'work' ? 'detail' : 'list';
          const rows = new Map();
          for (const row of expected.object === 'work' ? [data] : data.items) {
            if (completeWork(row, params, { collection: expected.workItems === true })) rows.set(this.#workKey(row.id, params, variant), row);
          }
          // A 100-work response should not cause 100 durable transactions or
          // capacity scans. Small custom cache adapters may still expose set.
          if (rows.size && this.#catalogCache.setMany?.([...rows], { ttlMs: ttl }) !== true) {
            for (const [workKey, row] of rows) this.#catalogCache.set(workKey, row, { ttlMs: ttl });
          }
        }
        this.#recordPositiveObservation(data, path, params, expected, shared);
        return data;
      }).catch(error => {
        const direct = /^\/catalog\/(works|credit-names|companies|persons|characters|releases|series|tags|traits|engines)\/([0-9]+)(?:\/(credits|credit-names))?$/.exec(path);
        if (direct && (error.code === 'ENTITY_MERGED' || (!direct[3] && error.status === 404 && error.upstreamCode === 'NOT_FOUND'))) {
          // An error can arrive from the same old request as a stale success.
          // After a feed change, its tombstone/redirect must not remove newer
          // facts or teach a creator alias that has already been superseded.
          // Read the durable revision too, even before cache notification runs.
          if (shared.reobserved || shared.catalogRevision !== this.catalogRevision) throw new NextMoeError('CATALOG_CHANGED',
            '目录资料已更新，请重新查询以取得当前条目。', { status: 409 });
          const object = ({ works: 'work', 'credit-names': 'credit_name', companies: 'company', persons: 'person', characters: 'character', releases: 'release', series: 'series', tags: 'tag', traits: 'trait', engines: 'engine' })[direct[1]];
          for (const request of this.#inflight.values()) {
            if (request.params.nsfw === params.nsfw) request.retired.add(`${object}:${direct[2]}`);
          }
          this.#catalogDatabase?.retire({ scope: this.#cacheScope, object, id: direct[2], params });
          this.#recordRetirement(object, direct[2], error.code, params.nsfw);
        }
        throw error;
      }).finally(() => {
        shared.settled = true;
        if (this.#inflight.get(inflightKey) === shared) this.#inflight.delete(inflightKey);
      });
      this.#inflight.set(inflightKey, pending);
    }
    const shared = pending;
    const data = await subscribe(shared, signal, () => {
      // Remove immediately so an identical new query cannot join cancelled
      // work while the old promise is still settling.
      if (this.#inflight.get(inflightKey) === shared) this.#inflight.delete(inflightKey);
      shared.controller.abort();
    });
    checkCatalogRevision();
    // Promise settlement and subscriber continuation are separate microtasks.
    // A concurrent definitive removal can happen after the shared fetch passed
    // validation but before this subscriber gets to publish its payload.
    this.#assertUnretired(retirementVersion, data, path, params);
    // A recommendation may join an ordinary card read. Validate per subscriber,
    // so missing requested facts cannot become a permanent empty analysis, while
    // healthy cards and analyses still share the exact same request/cache entry.
    if (!relationshipsAvailable(data, expected)) {
      if (this.#cache.get(key)?.data === data) this.#cache.delete(key);
      this.#catalogCache?.delete(persistentKey);
      if (!expected.allowPartialRelationships) throw new NextMoeError('INVALID_RESPONSE', '作品关系资料暂时不完整，请稍后重试。');
    }
    // Library cards can still display a title while credited names are missing.
    // Repair old/ordinary shared caches, but retain usable rows in this response
    // and let the caller offer an explicit retry rather than discarding siblings.
    if (!creditsAvailable(data, expected)) {
      if (this.#cache.get(key)?.data === data) this.#cache.delete(key);
      this.#catalogCache?.delete(persistentKey);
    }
    return structuredClone(data);
  }

  #cacheable(data, expected) {
    return relationshipsAvailable(data, expected) && creditsAvailable(data, expected) && (!expected.workItems || data.items.every(isUsableWorkRecord)) &&
      (!expected.creditItems || data.items.every(isUsableNameCreditRecord)) &&
      (!expected.creditNameItems || data.items.every(usableCreditName)) &&
      (!expected.searchItems || data.items.every(isUsableSearchRecord));
  }

  #databaseTtl(path, params) {
    if (params.q || path === '/catalog/search') return 5 * 60_000;
    if (/\/(credits|credit-names)$/.test(path) && !params.ids || params.company_id || params.series_id) return 6 * 60 * 60_000;
    return 24 * 60 * 60_000;
  }

  #workKey(id, params, variant) {
    // Catalogue collection tag blocks use the documented default none ceiling;
    // the detail endpoint makes that ceiling explicit. Other scopes stay apart.
    return `${this.#cacheScope}:work:${params.nsfw}:${params.spoiler ?? 'none'}:${id}:${variant}`;
  }

  #recordPositiveObservation(data, path, params, expected, source) {
    const route = /^\/catalog\/([^/]+)(?:\/([0-9]+))?$/.exec(path);
    const object = COLLECTION_OBJECTS[route?.[1]];
    // Only a successful direct/collection observation can establish presence.
    // Search hits and embedded career records are not current entity facts.
    if (!object || params.q || !this.#cacheable(data, expected)) return;
    const ids = new Set((expected.object === 'list' ? data.items : [data])
      .filter(row => row?.object === object && decimalId(row.id) && hasCatalogName(row)).map(row => row.id));
    if (!ids.size) return;
    for (const request of this.#inflight.values()) {
      // Use actual send order, not wall time or completion order. An older
      // batch arriving late must not suppress a newer definitive detail error.
      if (!request.sequence || request.sequence >= source.sequence || request.params.nsfw !== params.nsfw ||
          (request.params.spoiler ?? 'none') !== (params.spoiler ?? 'none')) continue;
      const target = /^\/catalog\/([^/]+)\/([0-9]+)(?:\/(?:credits|credit-names))?$/.exec(request.path);
      if (COLLECTION_OBJECTS[target?.[1]] === object && ids.has(target?.[2])) request.reobserved = true;
    }
  }

  async #fetchJSON(url, signal) {
    if (signal.aborted) throw aborted();
    const controller = new AbortController();
    let timer;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => { reject(aborted()); controller.abort(); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new NextMoeError('TIMEOUT', 'The NextMoe request exceeded its time limit.'));
        controller.abort();
      }, this.#timeoutMs);
    });
    const fetchResponse = async () => {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { ...(!this.#transport ? { Authorization: `Bearer ${this.#apiKey}` } : {}), Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (controller.signal.aborted) throw aborted();
      if (!response.ok) {
        let problem = null;
        try { problem = await response.json(); } catch { /* Never expose arbitrary upstream response text. */ }
        if (controller.signal.aborted) throw aborted();
        const status = response.status;
        if (this.#transport && [401, 403].includes(status) && response.headers.get('x-nextstory-user-authorization') === 'required') {
          throw new NextMoeError('CATALOG_AUTH_REQUIRED', '个人作品查询授权已失效，请在账户窗口重新授权后重试。', { status });
        }
        const upstreamCode = SAFE_UPSTREAM_CODES.has(problem?.code) && (!this.#apiKey || !problem.code.includes(this.#apiKey)) ? problem.code : null;
        if (status === 429) {
          const retryAfterMs = retryDelay(response.headers.get('retry-after'), this.#now());
          if (!this.#transport) this.#rateLimitedUntil = Math.max(this.#rateLimitedUntil, this.#now() + retryAfterMs);
          throw new NextMoeError('RATE_LIMITED', 'NextMoe has temporarily limited catalog requests.', { status, retryAfterMs, upstreamCode });
        }
        if (status === 404 && upstreamCode === 'ENTITY_MERGED') {
          const currentId = typeof problem.current_id === 'string' && /^[0-9]{1,20}$/.test(problem.current_id) ? problem.current_id : null;
          throw new NextMoeError('ENTITY_MERGED', 'This catalog entity has moved to a canonical ID.', { status, currentId, currentObject: problem.object === 'credit_name' ? 'credit_name' : null, upstreamCode });
        }
        const [code, message] = ({
          400: ['INVALID_REQUEST', 'NextMoe rejected the catalog request.'],
          401: ['UNAUTHORIZED', 'NextMoe rejected the server credential.'],
          403: ['FORBIDDEN', 'NextMoe denied access. Check the application scope.'],
          404: ['NOT_FOUND', 'The catalog entity is unavailable for this request.'],
          422: ['INVALID_REQUEST', 'NextMoe could not process the catalog request.'],
        })[status] ?? (status >= 500
          ? ['UPSTREAM_UNAVAILABLE', 'NextMoe is temporarily unavailable.']
          : ['HTTP_ERROR', 'NextMoe returned an unsuccessful response.']);
        throw new NextMoeError(code, message, { status, upstreamCode });
      }
      let data;
      try { data = await response.json(); }
      catch { throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned a response that is not valid JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned an unexpected response shape.');
      }
      if (this.#transport) assertPublicCatalogue(data);
      return data;
    };
    try {
      return await Promise.race([fetchResponse(), timeout, cancelled]);
    } catch (error) {
      if (!(error instanceof NextMoeError) || ['NETWORK_ERROR', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)) {
        this.#lastConnectionFailureAt = this.#now();
      }
      if (error instanceof NextMoeError) throw error;
      // Fetch errors may contain headers, credentials or arbitrary proxy text.
      // Deliberately omit the original message and cause from the public error.
      throw new NextMoeError('NETWORK_ERROR', 'The NextMoe service could not be reached.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
