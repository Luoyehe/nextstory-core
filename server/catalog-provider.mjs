// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { creatorIdentityKey, canonicalCreatorEntity } from '../lib/creator-identity.js';
import { MAX_EXPLORATION_SEEDS } from '../lib/exploration-seeds.js';
/** Bounded, read-only live discovery. Never substitutes demo data for API errors.
 * Metadata ranking freezes page positions; hydrated facts verify each result.
 * Collection rows never manufacture returned credits, series or responsibilities.
 */
import { NextMoeError, catalogIdentityMatcher } from './nextmoe.mjs';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { normalizeWork, normalizeSearchHit, roleAspect, rawId, isUsableWorkRecord, isUsableNameCreditRecord, hasWorkRelationships, hasWorkSeries } from './catalog-normalize.mjs';
import { companiesOf, discoverMulti } from '../lib/discovery.js';
import { CatalogSearch } from './catalog-search.mjs';
import { normalizeCreatorProfile, creatorFactsFromPages } from './creator-profile.mjs';

const ASPECTS = new Set(['all', 'scenario', 'art', 'music', 'voice', 'series']);
const STAFF_ASPECTS = ['scenario', 'art', 'music'];
const CREDIT_ASPECTS = [...STAFF_ASPECTS, 'voice'];
const CACHE_TTL = 60_000;
const CACHE_LIMIT = 64;
const SNAPSHOT_TTL = 15 * 60_000;
const SNAPSHOT_LIMIT = 16;
const PAGE_CACHE_LIMIT = 16;
const DETAIL_CACHE_LIMIT = 96;
const YEAR_FACT_CACHE_LIMIT = 512;
const SUMMARY_CACHE_LIMIT = 512;
const METADATA_BATCH_SIZE = 100;
const MAX_METADATA_BATCHES = 4;
const MAX_COMPANY_BRANCHES = 3;
const array = value => Array.isArray(value) ? value : [];
const validRawId = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const eligible = (value, nsfw) => value?.medium === 'galgame' && (nsfw || value.content_rating !== 'r18') && validRawId(value.id);
const invalid = message => new NextMoeError('INVALID_INPUT', message, { status: 400 });
const invalidResponse = () => new NextMoeError('INVALID_RESPONSE', 'NextMoe returned an unexpected catalog response.');
const cancelled = () => new NextMoeError('CANCELLED', 'The catalog request was cancelled.');
const expiredSnapshot = () => new NextMoeError('SNAPSHOT_EXPIRED', '这次探索结果已过期，请重新探索后再翻页。', { status: 409 });
const mustPropagate = error => [401, 403, 429].includes(error?.status) ||
  ['NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'LOCAL_QUOTA', 'QUOTA_EXCEEDED', 'ENTITY_MERGED', 'CANCELLED'].includes(error?.code);
const searchableSummary = work => ['credits', 'companies'].every(field =>
  work.coverage?.[field] !== 'missing' && Array.isArray(work[field]));

function validateNsfw(nsfw) {
  if (typeof nsfw !== 'boolean') throw invalid('The NSFW setting must be a boolean.');
}

function page(value) {
  if (!value || !Array.isArray(value.items)) throw invalidResponse();
  return value;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

async function isolated(promise, signal) {
  const value = await promise;
  checkCancelled(signal);
  return structuredClone(value);
}

// Snapshot construction, page hydration and overlapping details each have their
// own subscribers. Stop abandoned work only after its final caller leaves; a
// cancelled page must not interrupt a different page using the same detail.
function sharedOperation(operations, key, signal, execute) {
  checkCancelled(signal);
  let operation = operations.get(key);
  let start;
  if (!operation || operation.controller.signal.aborted) {
    const controller = new AbortController();
    operation = { controller, subscribers: 0, settled: false };
    const current = operation;
    operation.promise = new Promise((resolve, reject) => {
      start = () => {
        try { checkCancelled(controller.signal); resolve(execute(controller.signal)); }
        catch (error) { reject(error); }
      };
    }).then(value => {
      checkCancelled(controller.signal);
      return value;
    }).finally(() => {
      current.settled = true;
      if (operations.get(key) === current) operations.delete(key);
    });
    operations.set(key, operation);
  }
  const current = operation;
  current.subscribers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      current.subscribers--;
      if (!current.settled && !current.subscribers) {
        if (operations.get(key) === current) operations.delete(key);
        current.controller.abort();
      }
      callback(value);
    };
    const onAbort = () => finish(reject, cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    current.promise.then(value => finish(resolve, value), error => finish(reject, error));
    // Join the upstream request before returning to the caller. Deferring this
    // step lets a sibling seed-summary abort cancel the only upstream reader
    // before the exploration gets a chance to subscribe to the same detail.
    start?.();
  });
}

async function settledMap(items, concurrency, operation, signal) {
  checkCancelled(signal);
  const results = new Array(items.length);
  let index = 0;
  let fatal = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length && !fatal) {
      const position = index++;
      try {
        checkCancelled(signal);
        const value = await operation(items[position]);
        checkCancelled(signal);
        results[position] = { status: 'fulfilled', value };
      }
      catch (reason) {
        results[position] = { status: 'rejected', reason };
        if (mustPropagate(reason)) fatal = reason;
      }
      // Local cache hits only schedule microtasks. Yield between bounded work
      // units as well, otherwise a whole cached exploration can monopolize the
      // HTTP thread even though every caller uses async/await.
      if (index < items.length && !fatal) await yieldToRequests();
    }
  }));
  if (fatal) throw fatal;
  if (items.length) await yieldToRequests();
  checkCancelled(signal);
  return results;
}

function collectErrors(results) {
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  const fatal = failures.find(mustPropagate);
  if (fatal) throw fatal;
  if (results.length && failures.length === results.length) throw failures[0];
  return failures;
}

function entitySeed(raw, type, expectedId, nsfw) {
  const expectedObject = type === 'creator' ? 'credit_name' : type;
  if (raw?.id !== expectedId || raw?.object !== expectedObject) throw invalidResponse();
  const normalized = normalizeSearchHit({ ...raw, target_object: expectedObject }, { nsfw });
  if (!normalized || normalized.type !== type) throw invalidResponse();
  return {
    type, id: normalized.id, label: normalized.label,
    ...(type === 'creator' ? { profile: normalizeCreatorProfile(raw, { nsfw }) } : {}),
  };
}

function creatorBranches(work, aspect, maxCreators) {
  const creators = new Map();
  const credits = array(work.credits);
  // Keep staff encounter order as well as its priority: a dual-role person
  // appearing early in a cast block must not reorder the original staff pool.
  const orderedCredits = aspect === 'all'
    ? [...credits.filter(credit => STAFF_ASPECTS.includes(credit.role)), ...credits.filter(credit => credit.role === 'voice')]
    : credits;
  for (const credit of orderedCredits) {
    if (!CREDIT_ASPECTS.includes(credit.role) || (aspect !== 'all' && aspect !== credit.role)) continue;
    const id = rawId(credit.id, 'creator');
    if (!id) continue;
    const key = creatorIdentityKey(credit);
    if (!creators.has(key)) creators.set(key, { id, ids: new Set(), aspects: new Set() });
    const creator = creators.get(key);
    for (const name of credit.creatorIdentity?.creditNames || [{ id: credit.id }]) {
      const aliasId = rawId(name.id, 'creator');
      if (aliasId) creator.ids.add(aliasId);
    }
    creator.aspects.add(credit.role);
  }
  const candidates = [...creators.values()];
  const selected = [];
  // Broad discovery samples different responsibilities before more people in
  // the same responsibility. Preserve the existing three-read budget and staff
  // priorities, then use spare slots for cast. Dual duties share a single read.
  if (aspect === 'all') {
    for (const focus of STAFF_ASPECTS) {
      if (selected.some(creator => creator.aspects.has(focus))) continue;
      const creator = candidates.find(candidate => candidate.aspects.has(focus) && !selected.includes(candidate));
      if (creator && selected.length < maxCreators) selected.push(creator);
    }
  }
  for (const creator of candidates) {
    if (selected.length >= maxCreators) break;
    if (!selected.includes(creator)) selected.push(creator);
  }
  return { selected, omitted: Math.max(0, candidates.length - selected.length) };
}

function idsFromCredits(response, aspects, nsfw) {
  return page(response).items.slice(0, 100).filter(row => eligible(row?.work, nsfw) &&
    array(row.roles).some(role => aspects.has(roleAspect(role?.role_key))))
    .map(row => row.work.id);
}

function idsFromWorks(response, nsfw) {
  return page(response).items.slice(0, 100).filter(work => eligible(work, nsfw)).map(work => work.id);
}

function interleave(groups, excluded) {
  const seen = new Set(excluded ? [excluded] : []);
  const ids = [];
  const length = Math.max(0, ...groups.map(group => group.length));
  for (let position = 0; position < length; position++) {
    for (const group of groups) {
      const id = group[position];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export class CatalogProvider {
  #client;
  #search;
  #maxCandidates;
  #maxCreators;
  #now;
  #cache = new Map();
  #inflight = new Map();
  #snapshots = new Map();
  #yearFacts = new Map();
  #summaries = new Map();
  #retirementVersions = new Map([[false, 0], [true, 0]]);

  constructor({ client, maxCandidates = 8, maxCreators = 3, now = Date.now } = {}) {
    if (!client || typeof client.getWork !== 'function') throw invalid('A server catalog client is required.');
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 8) throw invalid('The candidate limit must be between 1 and 8.');
    if (!Number.isInteger(maxCreators) || maxCreators < 1 || maxCreators > 3) throw invalid('The creator limit must be between 1 and 3.');
    if (typeof now !== 'function') throw invalid('A clock function is required.');
    this.#client = client;
    this.#search = new CatalogSearch({ client, now });
    this.#maxCandidates = maxCandidates;
    this.#maxCreators = maxCreators;
    this.#now = now;
    this.#client.registerCatalogCache?.(this);
  }

  findCatalogIdentities(events) {
    const match = catalogIdentityMatcher(events), found = new Set();
    for (const row of this.#summaries.values()) {
      if (row.expiresAt > this.#now()) match(row.work, found);
    }
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.expiresAt <= this.#now()) continue;
      for (const id of snapshot.rankingIds) match({ id }, found);
      match([snapshot.catalog, snapshot.seeds], found);
      for (const detail of snapshot.details?.values() ?? []) match(detail, found);
    }
    return found;
  }

  async search(query, { signal, nsfw = false, correction = false, cursor } = {}) {
    const retirementVersion = this.#retirementVersion(nsfw);
    const result = await this.#search.search(query, { signal, nsfw, correction, cursor });
    // Search hits omit person_id. Resolve all returned credited names in batches,
    // never one profile call per candidate; missing identity keeps the candidate.
    const creatorIds = [...new Set(result.items.filter(item => item.type === 'creator').map(item => rawId(item.id, 'creator')).filter(Boolean))];
    if (this.#client.listCreditNames) {
      const batches = [];
      for (let offset = 0; offset < creatorIds.length; offset += 100) batches.push(creatorIds.slice(offset, offset + 100));
      await settledMap(batches, 2, async ids => {
        try { await this.#client.listCreditNames(ids, { nsfw, signal }); }
        catch (error) { if (error?.code === 'CANCELLED') throw error; /* Identity enrichment must not hide useful name matches. */ }
      }, signal);
    }
    const identities = new Map();
    if (!this.#client.getCachedCreatorIdentity && this.#client.resolveCreatorIdentity) for (const id of creatorIds) {
      const value = await this.#client.resolveCreatorIdentity(id, { nsfw, signal, cacheOnly: true });
      if (value?.creatorIdentity) identities.set(id, value.creatorIdentity);
    }
    const facts = new Map();
    const candidates = [...new Set(result.items.filter(item => item.type === 'creator')
      .map(item => this.#canonicalCreatorId(rawId(item.id, 'creator'), nsfw)))].slice(0, 3);
    // Names are already usable. Optional responsibilities must not hold the
    // entire candidate list behind another upstream read or an in-flight read.
    // The browser may enrich visible creators separately through creator-facts.
    // A cache miss is not empty responsibilities or evidence of a new identity.
    if (typeof this.#client.getCachedCreatorFacts === 'function') {
      await Promise.all(candidates.map(async id => {
        try {
          const value = await this.#client.getCachedCreatorFacts(id, { nsfw, signal });
          if (value) facts.set(value.id, value);
        } catch { /* Useful names survive optional responsibility failures. */ }
      }));
    }
    checkCancelled(signal);
    this.#checkRetirement(nsfw, retirementVersion, new NextMoeError(cursor ? 'SEARCH_CURSOR_EXPIRED' : 'CATALOG_CHANGED',
      '搜索候选已更新，请重新搜索。', { status: cursor ? 410 : 409 }));
    return this.#withCreatorIdentityLookups(() => {
    // Optional responsibilities can yield even on a cache hit. Resolve identities
    // at commit time, synchronously, so a concurrent explicit person reassignment
    // cannot merge candidates using an earlier alias roster.
    if (this.#client.getCachedCreatorIdentity) for (const id of creatorIds) {
      const value = this.#client.getCachedCreatorIdentity(id, { nsfw, signal });
      if (value?.creatorIdentity) identities.set(id, value.creatorIdentity);
    }
    const items = new Map();
    for (const item of result.items) {
      const canonical = item.type === 'creator' ? this.#canonicalCreatorId(rawId(item.id, 'creator'), nsfw) : null;
      const identity = canonical ? identities.get(rawId(item.id, 'creator')) : null;
      const cachedFacts = facts.get(canonical);
      const factsMatch = cachedFacts && this.#creatorIdentitySignature(cachedFacts.creatorIdentity, nsfw) === this.#creatorIdentitySignature(identity, nsfw)
        && cachedFacts.creatorIdentity?.complete === identity?.complete;
      const normalized = canonical ? canonicalCreatorEntity({ ...item, id: `credit:nm:${canonical}`,
        ...(identity ? { creatorIdentity: identity } : {}),
        ...(factsMatch ? { creatorFacts: cachedFacts.creatorFacts } : {}) }) : item;
      const key = normalized.type === 'creator' ? creatorIdentityKey(normalized) : `${normalized.type}:${normalized.id}`;
      const prior = items.get(key);
      // Only explicit redirects or upstream person links establish identity.
      // Same display names alone never merge unrelated people.
      if (!prior) items.set(key, normalized);
      else items.set(key, { ...prior, ...((normalized.match?.score ?? 500) > (prior.match?.score ?? 500) ? normalized : {}),
        aliases: [...new Set([...(prior.aliases || []), ...(normalized.aliases || []), prior.label, normalized.label])],
        ...(normalized.creatorFacts ? { creatorFacts: normalized.creatorFacts } : {}),
        match: (prior.match?.score ?? 500) >= (normalized.match?.score ?? 500) ? prior.match : normalized.match });
    }
    const displayed = [...items.values()].sort((a, b) => (b.match?.score ?? 500) - (a.match?.score ?? 500));
    return { ...result, items: displayed,
      notice: result.notice?.replace(/^本次取得 \d+ 条候选/, `本次取得 ${displayed.length} 条候选`),
      searchCoverage: { ...result.searchCoverage, correctionCandidates: displayed.filter(item => item.match?.kind === 'typo').length,
        relatedCandidates: displayed.filter(item => item.match?.kind === 'related').length } };
    });

  }

  #canonicalCreatorId(id, nsfw) { return this.#client.canonicalCreatorGroupId?.(id, { nsfw }) ?? this.#client.canonicalCreditNameId?.(id, { nsfw }) ?? id; }
  #canonicalWork(work, nsfw) { return this.#client.canonicalizeWorkCreatorIds?.(work, { nsfw }) ?? work; }
  #canonicalWorks(works, nsfw) {
    return this.#client.canonicalizeWorksCreatorIds?.(works, { nsfw }) ?? works.map(work => this.#canonicalWork(work, nsfw));
  }
  #withCreatorIdentityLookups(operation) {
    return this.#client.withCreatorIdentityLookups ? this.#client.withCreatorIdentityLookups(operation) : operation();
  }
  #retirementVersion(nsfw) { return this.#client.catalogRetirementVersionFor?.({ nsfw }) ?? this.#client.catalogRetirementVersion ?? 0; }
  #synchronizeRetirements() {
    for (const nsfw of [false, true]) {
      const version = this.#retirementVersion(nsfw);
      if (this.#retirementVersions.get(nsfw) === version) continue;
      // These presentation caches bypass the raw directory on a hit. Once an
      // entity is explicitly retired, they must not keep serving its old cards
      // or frozen relationships. Unaffected directory facts remain reusable.
      for (const map of [this.#summaries, this.#yearFacts]) {
        for (const key of map.keys()) if (key.startsWith(`${nsfw}:`)) map.delete(key);
      }
      const retiredSnapshots = new Set();
      for (const [id, snapshot] of this.#snapshots) {
        if (snapshot.nsfw === nsfw) { this.#snapshots.delete(id); retiredSnapshots.add(id); }
      }
      for (const [key, entry] of this.#cache) if (retiredSnapshots.has(entry.snapshotId)) this.#cache.delete(key);
      this.#retirementVersions.set(nsfw, version);
    }
  }
  #checkRetirement(nsfw, version, error = invalidResponse()) {
    if (this.#retirementVersion(nsfw) === version) return;
    this.#synchronizeRetirements();
    throw error;
  }
  #checkBuildRetirements(nsfw, version) {
    if (this.#retirementVersion(nsfw) === version) return;
    const events = this.#client.catalogRetirementsSince?.(version, { nsfw });
    // Resolving a creator merge is part of normal discovery. Only confirmed
    // redirects can be rewritten safely; other retired facts require a retry.
    if (events?.length && events.every(event => event.object === 'credit_name' && event.code === 'ENTITY_MERGED' &&
      this.#client.canonicalCreditNameId?.(event.id, { nsfw }) !== undefined &&
      this.#client.canonicalCreditNameId(event.id, { nsfw }) !== event.id)) return;
    this.#checkRetirement(nsfw, version);
  }
  #canonicalSeeds(seeds, nsfw) {
    return [...new Map(seeds.map(seed => {
      const id = seed.type === 'creator' ? `credit:nm:${this.#canonicalCreatorId(rawId(seed.id, 'creator'), nsfw)}` : seed.id;
      return [`${seed.type}:${id}`, { ...seed, id }];
    })).values()];
  }
  #creatorIdentitySignature(identity, nsfw) {
    return identity && JSON.stringify([identity.personId,
      [...new Set(identity.creditNames.map(name => this.#client.canonicalCreditNameId?.(rawId(name.id, 'creator'), { nsfw }) ?? rawId(name.id, 'creator')))].sort()]);
  }
  #commitCreatorSeeds(seeds, pages, nsfw, plannedSeeds) {
    if (!this.#client.getCachedCreatorIdentity) return seeds;
    return this.#withCreatorIdentityLookups(() => seeds.map((seed, index) => {
      if (seed.type !== 'creator') return seed;
      const decoded = rawId(seed.id, 'creator');
      const current = this.#client.getCachedCreatorIdentity(decoded, { nsfw });
      // Metadata requests can outlive the person/alias facts used to select
      // branches. A different roster cannot inherit their completeness or
      // duties. Resolved name redirects are equivalent after canonicalization.
      const plannedIdentity = plannedSeeds[index].creatorIdentity;
      if (plannedIdentity && this.#creatorIdentitySignature(plannedIdentity, nsfw) !== this.#creatorIdentitySignature(current?.creatorIdentity, nsfw)) {
        throw new NextMoeError('CATALOG_CHANGED', '创作者署名资料刚刚更新，请重新探索以取得当前关联。', { status: 409 });
      }
      const refreshed = current?.creatorIdentity ? canonicalCreatorEntity({ ...seed,
        id: `credit:nm:${this.#client.canonicalCreditNameId?.(decoded, { nsfw }) ?? decoded}` }, current.creatorIdentity) : seed;
      const canonical = this.#canonicalCreatorId(rawId(refreshed.id, 'creator'), nsfw);
      const related = pages.filter(value => value.creditNameId && this.#canonicalCreatorId(value.creditNameId, nsfw) === canonical);
      if (!related.length) return refreshed;
      const creatorFacts = creatorFactsFromPages(related.map(value => value.response), { nsfw });
      const loaded = new Set(related.map(value => this.#client.canonicalCreditNameId?.(value.creditNameId, { nsfw }) ?? value.creditNameId));
      if (loaded.size < (refreshed.creatorIdentity?.creditNames.length ?? 1) || refreshed.creatorIdentity?.complete === false) creatorFacts.complete = false;
      return { ...refreshed, creatorFacts };
    }));
  }
  #queryKey(seeds, aspect, nsfw, includeSameSeries) {
    return `${JSON.stringify(this.#canonicalSeeds(seeds, nsfw).map(({ type, id }) => ({ type, id })))}:${aspect}:${nsfw}:${includeSameSeries}`;
  }
  #rememberSnapshotInputs(snapshot, inputSeeds) {
    // All callers reach this only after accepting the query. Keep each proven
    // input alias, including cache hits and waiters on a shared snapshot build.
    for (const origin of snapshot.seeds.filter(seed => seed.type === 'creator')) {
      for (const alias of origin.creatorIdentity?.creditNames || []) snapshot.seedBindings.set(`creator:${alias.id}`, origin.id);
    }
    for (const seed of inputSeeds) {
      if (seed.type !== 'creator') continue;
      const bound = snapshot.seedBindings.get(`creator:${seed.id}`) || seed.id;
      const current = this.#canonicalCreatorId(rawId(bound, 'creator'), snapshot.nsfw);
      const origin = snapshot.seeds.find(item => item.type === 'creator' &&
        this.#canonicalCreatorId(rawId(item.id, 'creator'), snapshot.nsfw) === current);
      if (origin) snapshot.seedBindings.set(`creator:${seed.id}`, origin.id);
    }
  }
  #canonicalPage(result, snapshot) {
    this.#checkRetirement(snapshot.nsfw, snapshot.retirementVersion, expiredSnapshot());
    return this.#withCreatorIdentityLookups(() => {
      this.#checkSnapshotIdentities(snapshot, result.catalog);
      const seeds = this.#canonicalSeeds(result.seeds, result.nsfw);
      return { ...result, seed: seeds[0], seeds, catalog: this.#canonicalWorks(result.catalog, result.nsfw) };
    });
  }
  #checkSnapshotIdentities(snapshot, works = []) {
    if (!this.#client.getCachedCreatorIdentity) return;
    this.#withCreatorIdentityLookups(() => {
      const records = [...snapshot.seeds.filter(seed => seed.type === 'creator'),
        ...[...snapshot.catalog, ...works].flatMap(work => array(work.credits))];
      const checked = new Set();
      for (const record of records) {
        const identity = record.creatorIdentity;
        if (!identity) continue;
        const signature = this.#creatorIdentitySignature(identity, snapshot.nsfw);
        if (checked.has(signature)) continue;
        checked.add(signature);
        const contradicted = identity.creditNames.some(name => {
          const id = rawId(name.id, 'creator');
          const person = this.#client.getCachedCreatorPersonId?.(id, { nsfw: snapshot.nsfw });
          const current = this.#client.getCachedCreatorIdentity(id, { nsfw: snapshot.nsfw })?.creatorIdentity;
          return (person !== undefined && `person:nm:${person}` !== identity.personId) ||
            (current && (current.personId !== identity.personId || current.complete) &&
              this.#creatorIdentitySignature(current, snapshot.nsfw) !== signature);
        });
        // Expiry/eviction alone does not disprove this frozen snapshot's known
        // bindings. Fresh explicit person links or a replacement full roster do.
        if (contradicted) {
          this.#snapshots.delete(snapshot.snapshotId);
          if (this.#cache.get(snapshot.key)?.snapshotId === snapshot.snapshotId) this.#cache.delete(snapshot.key);
          throw expiredSnapshot();
        }
      }
    });
  }

  async getCreatorFacts(id, { nsfw = false, signal } = {}) {
    validateNsfw(nsfw);
    const decoded = rawId(id, 'creator');
    if (!decoded) throw invalid('Use a canonical NextMoe credited-name ID.');
    checkCancelled(signal);
    const retirementVersion = this.#retirementVersion(nsfw);
    const value = this.#client.getCreatorFacts
      ? await this.#client.getCreatorFacts(decoded, { nsfw, signal })
      : { id: decoded, creatorFacts: creatorFactsFromPages([page(await this.#client.getCreditNameCredits(decoded, { nsfw, signal, limit: 100 }))], { nsfw }) };
    checkCancelled(signal);
    // The client already follows confirmed name redirects while aggregating
    // duties; retain those canonical results, but reject other retirements.
    this.#checkBuildRetirements(nsfw, retirementVersion);
    if (this.#retirementVersion(nsfw) !== retirementVersion &&
      [value.id, ...array(value.creatorIdentity?.creditNames).map(name => rawId(name.id, 'creator'))].some(id =>
        this.#client.canonicalCreditNameId?.(id, { nsfw }) !== id)) {
      this.#checkRetirement(nsfw, retirementVersion);
    }
    return { type: 'creator', id: `credit:nm:${value.id}`, creatorFacts: value.creatorFacts,
      creatorIdentity: value.creatorIdentity ?? null };
  }

  async resolveHistoryCreator(target) {
    if (target?.type !== 'creator' || !this.#client.resolveCreatorIdentity) return { target, aliases: [] };
    const id = rawId(target.id, 'creator');
    if (!id) return { target, aliases: [] };
    const scopes = await Promise.all([false, true].map(nsfw => this.#client.resolveCreatorIdentity(id, { nsfw, cacheOnly: true })));
    const known = scopes.filter(value => value?.creatorIdentity);
    if (!known.length || known.some(value => value.creatorIdentity.personId !== known[0].creatorIdentity.personId)) return { target, aliases: [] };
    const value = known.find(value => value.creatorIdentity.complete) || known[0];
    return { target: { ...target, id: `credit:nm:${value.id}` }, aliases: value.creatorIdentity.creditNames.map(row => row.id) };
  }

  #rememberYearFacts(work, nsfw) {
    if (!work || work.coverage.releases === 'missing') return;
    const key = `${nsfw}:${work.id}`;
    const facts = structuredClone({
      year: work.year, releaseYear: work.releaseYear, releaseYearEvidence: work.releaseYearEvidence,
      yearEvidence: work.yearEvidence,
    });
    this.#yearFacts.delete(key);
    this.#yearFacts.set(key, { catalogDate: work.catalogDate, catalogDatePrecision: work.catalogDatePrecision, facts, expiresAt: this.#now() + SNAPSHOT_TTL });
    while (this.#yearFacts.size > YEAR_FACT_CACHE_LIMIT) this.#yearFacts.delete(this.#yearFacts.keys().next().value);
    // Newly acquired evidence is eligible for a NEW exploration. Old tokens and
    // their fixed page positions retain the original years until they expire.
    for (const [cacheKey, cached] of this.#cache) {
      const snapshot = this.#snapshots.get(cached.snapshotId);
      const previous = snapshot?.rankingYears.get(work.id);
      if (snapshot?.nsfw === nsfw && previous && previous.rankingYear !== work.year) this.#cache.delete(cacheKey);
    }
  }

  #applyKnownYearFacts(work, nsfw) {
    const key = `${nsfw}:${work.id}`;
    const cached = this.#yearFacts.get(key);
    if (!cached) return work;
    if (cached.expiresAt <= this.#now() || cached.catalogDate !== work.catalogDate || cached.catalogDatePrecision !== work.catalogDatePrecision) {
      this.#yearFacts.delete(key);
      return work;
    }
    const facts = structuredClone(cached.facts);
    return { ...work, ...facts, rankingYear: facts.year, rankingYearEvidence: structuredClone(facts.yearEvidence) };
  }

  #rememberSummary(work, nsfw, canonical = false) {
    if (!work) return;
    if (!canonical) work = this.#canonicalWork(work, nsfw);
    const key = `${nsfw}:${work.id}`;
    // Card data includes already-fetched searchable credited names, but must
    // never masquerade as the full
    // release/series facts required by details, comparison and discovery.
    const { id, title, originalTitle, aliases, company, companies, cover, contentRating, tags, credits, participationCredits,
      year, catalogYear, catalogDate, catalogDatePrecision, releaseYear,
      releaseYearEvidence, yearEvidence, dataSource } = work;
    const summary = structuredClone({
      id, title, originalTitle, aliases, company, companies, cover, contentRating, tags, credits,
      ...(Array.isArray(participationCredits) ? { participationCredits } : {}),
      coverage: { credits: work.coverage?.credits || (Array.isArray(credits) ? 'available' : 'missing'),
        companies: work.coverage?.companies || (Array.isArray(companies) ? 'available' : 'missing') },
      year, catalogYear, catalogDate, catalogDatePrecision, releaseYear,
      releaseYearEvidence, yearEvidence, dataSource, detailLevel: 'summary',
    });
    const prior = this.#summaries.get(key);
    let retainedFacts = false;
    if (prior?.expiresAt > this.#now()) {
      const previous = this.#canonicalWork(prior.work, nsfw);
      const incompleteCredits = summary.coverage.credits === 'missing';
      for (const field of ['credits', 'companies']) {
        if (summary.coverage[field] !== 'missing' || previous.coverage?.[field] === 'missing' || !Array.isArray(previous[field])) continue;
        summary[field] = structuredClone(previous[field]);
        summary.coverage[field] = previous.coverage?.[field] || (summary[field].length ? 'available' : 'empty');
        if (field === 'companies') summary.company = structuredClone(previous.company);
        retainedFacts = true;
      }
      if ((incompleteCredits || !Array.isArray(summary.participationCredits)) && Array.isArray(previous.participationCredits)) {
        summary.participationCredits = structuredClone(previous.participationCredits);
        retainedFacts = true;
      }
      for (const field of ['credits', 'participationCredits']) {
        const priorCredits = new Map(array(previous[field]).map(credit => [`${credit.id}\u0000${credit.roleKey ?? credit.role}`, credit]));
        for (const credit of array(summary[field])) {
          const known = priorCredits.get(`${credit.id}\u0000${credit.roleKey ?? credit.role}`);
          if (!Array.isArray(credit.characters) && Array.isArray(known?.characters)) {
            credit.characters = structuredClone(known.characters);
            retainedFacts = true;
          }
        }
      }
    }
    // Re-reading an unchanged URL-cache result is not a fresh observation.
    // Nor can a partial detail extend the lifetime of retained searchable facts.
    const expiresAt = prior?.expiresAt > this.#now() && (retainedFacts || JSON.stringify(prior.work) === JSON.stringify(summary))
      ? prior.expiresAt : this.#now() + SNAPSHOT_TTL;
    this.#summaries.delete(key);
    this.#summaries.set(key, { expiresAt, work: summary });
    while (this.#summaries.size > SUMMARY_CACHE_LIMIT) this.#summaries.delete(this.#summaries.keys().next().value);
  }

  async getWorks(ids, { signal, nsfw = false } = {}) {
    validateNsfw(nsfw);
    if (!Array.isArray(ids) || !ids.length || ids.length > METADATA_BATCH_SIZE || ids.some(id => !rawId(id, 'work'))) {
      throw invalid('Provide between 1 and 100 canonical NextMoe work IDs.');
    }
    if (signal?.aborted) throw cancelled();
    this.#synchronizeRetirements();
    const retirementVersion = this.#retirementVersion(nsfw);
    const requested = [...new Set(ids)];
    const found = new Map();
    const fallback = new Map();
    const missing = [];
    const malformed = new Set();
    const incompleteRelationships = new Set();
    for (const id of requested) {
      const key = `${nsfw}:${id}`;
      const cached = this.#summaries.get(key);
      if (cached?.expiresAt > this.#now()) {
        this.#summaries.delete(key);
        this.#summaries.set(key, cached);
        const value = this.#applyKnownYearFacts(structuredClone(cached.work), nsfw);
        if (!searchableSummary(value)) {
          fallback.set(id, value); missing.push(rawId(id, 'work'));
        } else found.set(id, value);
      } else {
        this.#summaries.delete(key);
        missing.push(rawId(id, 'work'));
      }
    }
    let response;
    if (missing.length) {
      // Canonical ordering also coalesces overlapping identical batches at the
      // HTTP cache, regardless of a user's library sort order.
      try { response = page(await this.#client.listWorks({ ids: missing.sort(), nsfw, signal,
        requireRelationships: true, allowPartialRelationships: true })); }
      catch (error) {
        this.#checkRetirement(nsfw, retirementVersion);
        if (signal?.aborted || error?.code === 'CANCELLED' || (!found.size && !fallback.size) || !(error instanceof NextMoeError) || [401, 403].includes(error.status)) throw error;
        // Network failure is not evidence that a work is invisible. Display
        // cached siblings and let only the failed records retry explicitly.
        return { mode: 'live', nsfw, partial: true,
          works: this.#canonicalWorks(requested.filter(id => found.has(id) || fallback.has(id)).map(id => found.get(id) || fallback.get(id)), nsfw), missing: [],
          failed: requested.filter(id => !found.has(id)),
          ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        };
      }
      if (signal?.aborted) throw cancelled();
      this.#checkRetirement(nsfw, retirementVersion);
    }
    return this.#withCreatorIdentityLookups(() => {
    if (response) {
      const allowed = new Set(missing);
      // With no usable identity on a broken row, absence cannot establish
      // whether an unresolved requested work was filtered or failed to parse.
      const unidentifiedRow = response.items.some(raw => !validRawId(raw?.id));
      for (const raw of response.items) {
        if (!allowed.has(raw?.id) || found.has(`nm:${raw.id}`)) continue;
        if (!isUsableWorkRecord(raw)) { malformed.add(`nm:${raw.id}`); continue; }
        const normalized = normalizeWork(raw, { nsfw });
        if (!normalized) continue;
        const work = this.#applyKnownYearFacts(normalized, nsfw);
        malformed.delete(work.id);
        this.#rememberSummary(work, nsfw);
        const summary = structuredClone(this.#summaries.get(`${nsfw}:${work.id}`).work);
        if (!searchableSummary(summary)) incompleteRelationships.add(work.id);
        found.set(work.id, summary);
      }
      if (unidentifiedRow) for (const id of missing) if (!found.has(`nm:${id}`)) malformed.add(`nm:${id}`);
      // Keep the last usable title when a repair returns a malformed row. A
      // valid omission remains a real missing/filtered record, not a cache hit.
      for (const id of malformed) if (!found.has(id) && fallback.has(id)) found.set(id, fallback.get(id));
    }
    const failed = requested.filter(id => malformed.has(id) || incompleteRelationships.has(id));
    return { mode: 'live', nsfw, works: this.#canonicalWorks(requested.filter(id => found.has(id)).map(id => found.get(id)), nsfw),
      missing: requested.filter(id => !found.has(id) && !malformed.has(id)),
      ...(failed.length ? { partial: true, failed } : {}) };
    });
  }

  async getWork(id, { signal, nsfw = false, requireRelationships = false, requireSeries = false } = {}) {
    validateNsfw(nsfw);
    const decoded = rawId(id, 'work');
    if (!decoded) throw invalid('Use a canonical NextMoe work ID.');
    const retirementVersion = this.#retirementVersion(nsfw);
    const raw = await this.#client.getWork(decoded, { signal, nsfw, requireRelationships, requireSeries });
    checkCancelled(signal);
    // Lower-level request settlement and this continuation are separate
    // microtasks. A feed retirement between them must not republish old detail
    // or refill the card/year caches immediately after they were invalidated.
    this.#checkRetirement(nsfw, retirementVersion);
    this.#synchronizeRetirements();
    if (raw?.id !== decoded) throw invalidResponse();
    if (requireRelationships && !hasWorkRelationships(raw)) throw invalidResponse();
    if (requireSeries && !hasWorkSeries(raw)) throw invalidResponse();
    const work = this.#canonicalWork(normalizeWork(raw, { nsfw }), nsfw);
    if (!work) throw new NextMoeError('UNSUPPORTED_WORK', 'This entry is not a visible Galgame in the current catalog view.', { status: 422 });
    this.#rememberYearFacts(work, nsfw);
    this.#rememberSummary(work, nsfw, true);
    return work;
  }

  async explore({ type, id, seeds: requestedSeeds, aspect = 'all', nsfw = false, includeSameSeries = true, page: pageNumber = 1, pageSize = this.#maxCandidates, snapshotId } = {}, { signal } = {}) {
    validateNsfw(nsfw);
    if (typeof includeSameSeries !== 'boolean') throw invalid('The same-series setting must be a boolean.');
    if (requestedSeeds !== undefined && (type !== undefined || id !== undefined)) throw invalid('Use seeds or a single type and id, not both.');
    const inputSeeds = requestedSeeds === undefined ? [{ type, id }] : requestedSeeds;
    if (!Array.isArray(inputSeeds) || !inputSeeds.length || inputSeeds.length > MAX_EXPLORATION_SEEDS ||
      inputSeeds.some(seed => !seed || !['work', 'creator', 'company'].includes(seed.type) || !rawId(seed.id, seed.type)) || !ASPECTS.has(aspect)) {
      throw invalid(`Select between 1 and ${MAX_EXPLORATION_SEEDS} valid NextMoe seeds and an exploration aspect.`);
    }
    const seeds = this.#canonicalSeeds(inputSeeds.map(({ type, id }) => ({ type, id })), nsfw);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 400) throw invalid('The page must be an integer between 1 and 400.');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 24) throw invalid('The page size must be an integer between 1 and 24.');
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !/^snap_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(snapshotId))) throw invalid('Use a valid catalog snapshot token.');
    if (pageNumber > 1 && snapshotId === undefined) throw invalid('Continue an exploration with its snapshot token.');
    if (signal?.aborted) throw cancelled();
    this.#synchronizeRetirements();
    const key = this.#queryKey(seeds, aspect, nsfw, includeSameSeries);
    if (snapshotId !== undefined) {
      const snapshot = this.#snapshots.get(snapshotId);
      if (!snapshot || snapshot.expiresAt <= this.#now()) {
        this.#snapshots.delete(snapshotId);
        throw expiredSnapshot();
      }
      // Preserve the proven bindings for the life of this snapshot, even if
      // the shared alias cache expires or evicts a name between page requests.
      for (const origin of snapshot.seeds.filter(seed => seed.type === 'creator')) {
        const current = `credit:nm:${this.#canonicalCreatorId(rawId(origin.id, 'creator'), snapshot.nsfw)}`;
        snapshot.seedBindings.set(`creator:${current}`, origin.id);
      }
      const bound = inputSeeds.map(seed => ({ type: seed.type, id: snapshot.seedBindings.get(`${seed.type}:${seed.id}`) || seed.id }));
      if (this.#queryKey(snapshot.seeds, snapshot.aspect, snapshot.nsfw, snapshot.includeSameSeries) !==
        this.#queryKey(bound, aspect, nsfw, includeSameSeries)) throw invalid('The snapshot does not match the selected seed, aspect, NSFW or same-series setting.');
      this.#rememberSnapshotInputs(snapshot, inputSeeds);
      return isolated(this.#snapshotPage(snapshot, pageNumber, pageSize, signal).then(result => this.#canonicalPage(result, snapshot)), signal);
    }
    const cached = this.#cache.get(key);
    const snapshot = cached?.expiresAt > this.#now() && cached.identityVersion === this.#client.creatorIdentityVersion ? this.#snapshots.get(cached.snapshotId) : undefined;
    if (snapshot?.expiresAt > this.#now()) {
      this.#rememberSnapshotInputs(snapshot, inputSeeds);
      return isolated(this.#snapshotPage(snapshot, pageNumber, pageSize, signal).then(result => this.#canonicalPage(result, snapshot)), signal);
    }
    this.#cache.delete(key);
    const built = await sharedOperation(this.#inflight, `${this.#client.inflightScope ?? ''}\u0000${key}`, signal, async sharedSignal => {
      const value = await this.#buildSnapshot({ seeds, aspect, nsfw, includeSameSeries }, sharedSignal);
      checkCancelled(sharedSignal);
      this.#checkRetirement(nsfw, value.retirementVersion);
      // This build may itself have followed a creator merge. Invalidate older
      // snapshots before publishing the newly resolved canonical result.
      this.#synchronizeRetirements();
      const snapshotId = `snap_${randomUUID()}`;
      const seedBindings = new Map(inputSeeds.map(origin => [`${origin.type}:${origin.id}`, origin.type === 'creator'
        ? `credit:nm:${this.#canonicalCreatorId(rawId(origin.id, 'creator'), nsfw)}` : origin.id]));
      const snapshot = { ...value, seedBindings, snapshotId, key: this.#queryKey(value.seeds, aspect, nsfw, includeSameSeries), expiresAt: this.#now() + SNAPSHOT_TTL,
        retirementVersion: this.#retirementVersion(nsfw),
        pages: new Map(), pageInflight: new Map(), details: new Map(), detailInflight: new Map() };
      this.#snapshots.set(snapshotId, snapshot);
      while (this.#snapshots.size > SNAPSHOT_LIMIT) this.#snapshots.delete(this.#snapshots.keys().next().value);
      // A new exploration must be able to retry failed collection/metadata
      // requests immediately. Explicit snapshot tokens still preserve the
      // original fixed page positions even when their pool is incomplete.
      if (!snapshot.coverage.failedRequests && !snapshot.coverage.incompleteMetadata) this.#cache.set(snapshot.key, { snapshotId, identityVersion: this.#client.creatorIdentityVersion, expiresAt: this.#now() + CACHE_TTL });
      while (this.#cache.size > CACHE_LIMIT) this.#cache.delete(this.#cache.keys().next().value);
      return snapshot;
    });
    this.#rememberSnapshotInputs(built, inputSeeds);
    return isolated(this.#snapshotPage(built, pageNumber, pageSize, signal).then(result => this.#canonicalPage(result, built)), signal);
  }

  async #buildSnapshot({ seeds: requestedSeeds, aspect, nsfw, includeSameSeries }, signal) {
    checkCancelled(signal);
    const retirementVersion = this.#retirementVersion(nsfw);
    const catalog = [];
    const planned = new Map();
    const perSeedBranches = [];
    let omittedCreators = 0;
    let omittedSeries = 0;
    let omittedCompanies = 0;
    const explanations = new Set();
    // All selected origins must resolve. Silently dropping an unavailable origin
    // would incorrectly label matches against the survivors as common to all.
    let origins = await settledMap(requestedSeeds, 2, async ({ type, id }) => {
      const decoded = rawId(id, type);
      if (type === 'work') {
        const work = await this.getWork(id, { nsfw, signal, requireRelationships: true,
          requireSeries: aspect === 'all' || aspect === 'series' || !includeSameSeries });
        return { seed: { type, id, label: work.title }, work };
      }
      const raw = type === 'creator'
        ? await this.#client.getCreditName(decoded, { nsfw, signal })
        : await this.#client.getCompany(decoded, { nsfw, signal });
      const seed = entitySeed(raw, type, type === 'creator' ? (this.#client.canonicalCreditNameId?.(decoded, { nsfw }) ?? decoded) : decoded, nsfw);
      if (type === 'creator' && this.#client.resolveCreatorIdentity) {
        const identity = await this.#client.resolveCreatorIdentity(decoded, { nsfw, signal, cacheOnly: true });
        if (identity?.creatorIdentity) return { seed: canonicalCreatorEntity(seed, identity.creatorIdentity) };
      }
      return { seed };
    }, signal);
    const originFailure = origins.find(result => result.status === 'rejected');
    if (originFailure) throw originFailure.reason;
    if (this.#client.resolveCreatorIdentity) for (const result of origins) {
      const seed = result.value.seed;
      if (seed.type !== 'creator') continue;
      const identity = await this.#client.resolveCreatorIdentity(rawId(seed.id, 'creator'), { nsfw, signal, cacheOnly: true });
      if (identity?.creatorIdentity) result.value.seed = canonicalCreatorEntity(seed, identity.creatorIdentity);
    }
    origins = [...new Map(origins.map(result => [result.value.seed.type === 'creator' ? creatorIdentityKey(result.value.seed) : `${result.value.seed.type}:${result.value.seed.id}`, result])).values()];
    const seeds = origins.map(result => result.value.seed);
    // Later branch/profile reads may refresh seeds in place. Retain the actual
    // roster used to plan queries so an expanded/reassigned roster is detected.
    const plannedSeeds = structuredClone(seeds);
    let seed = seeds[0];
    const addBranch = (group, branch) => {
      const key = `${branch.kind}:${branch.id}`;
      const existing = planned.get(key);
      if (existing) {
        for (const role of branch.aspects || []) existing.aspects.add(role);
        existing.origins.add(group);
      } else planned.set(key, { ...branch, origins: new Set([group]) });
      perSeedBranches[group].push(key);
    };
    for (const [index, result] of origins.entries()) {
      const { seed: origin, work } = result.value;
      const { type, id } = origin;
      perSeedBranches.push([]);
      const addCreator = (creatorId, aspects) => addBranch(index, { kind: 'creator', id: creatorId, aspects: new Set(aspects) });
      const addCollection = (kind, collectionId) => addBranch(index, { kind, id: collectionId });
      if (work) {
        catalog.push(work);
        const creators = creatorBranches(work, aspect, this.#maxCreators);
        omittedCreators += creators.omitted;
        for (const creator of creators.selected) addCreator(creator.id, creator.aspects);
        if (aspect === 'series' && !includeSameSeries) {
          explanations.add('当前选择系列探索，但已关闭包含同系列作品，因此没有符合条件的候选；可切换探索方面或重新开启开关。');
        } else if (aspect === 'series' || aspect === 'all' || !includeSameSeries) {
          const seriesId = rawId(array(work.series)[0]?.id, 'series');
          omittedSeries += Math.max(0, array(work.series).length - 1);
          if (seriesId) addCollection('series', seriesId);
          else if (aspect === 'series') explanations.add('部分起点当前没有可用的明确系列记录，可由你切换其他方面。');
        }
        if (!creators.selected.length && aspect === 'all') {
          const companyIds = companiesOf(work).map(company => rawId(company.id, 'company')).filter(Boolean);
          omittedCompanies += Math.max(0, companyIds.length - MAX_COMPANY_BRANCHES);
          for (const companyId of companyIds.slice(0, MAX_COMPANY_BRANCHES)) addCollection('company', companyId);
          if (companyIds.length) explanations.add('当前缺少可用的创作者关联，补充已确认制作方的目录；同制作方不代表体验相似。');
          if (companyIds.length > MAX_COMPANY_BRANCHES) explanations.add(`本次每个起点最多查询 ${MAX_COMPANY_BRANCHES} 家制作方，另有 ${companyIds.length - MAX_COMPANY_BRANCHES} 家制作方目录尚未加载。`);
        } else if (!creators.selected.length && CREDIT_ASPECTS.includes(aspect)) {
          explanations.add('部分起点当前没有支持所选方面的明确署名，没有自动放宽条件。');
        }
        // Preserve every originally selected duty and series before spending
        // remaining slots on alternate names of any one prolific creator.
        const extras = creators.selected.map(creator => [...creator.ids].filter(aliasId => aliasId !== creator.id));
        for (let index = 0; index < Math.max(0, ...extras.map(ids => ids.length)); index++) {
          extras.forEach((ids, creatorIndex) => { if (ids[index]) addCreator(ids[index], creators.selected[creatorIndex].aspects); });
        }
      } else if (type === 'creator') {
        if (aspect === 'series') explanations.add('创作者署名不能证明系列归属，请先选一部作品作为系列探索起点。');
        else {
          const aliases = origin.creatorIdentity?.creditNames || [{ id }];
          for (const alias of aliases) addCreator(rawId(alias.id, 'creator'), new Set(aspect === 'all' ? CREDIT_ASPECTS : [aspect]));
          if (origin.creatorIdentity && !origin.creatorIdentity.complete) explanations.add('部分创作者的其他署名资料尚未完整载入，可稍后重新探索。');
        }
      } else if (aspect !== 'all') {
        explanations.add('会社归属不能证明剧本、画风、音乐、配音或系列关系，请选择综合探索或明确的作品／创作者。');
      } else {
        addCollection('company', rawId(id, type));
        explanations.add('会社检索结果仍按详情核实制作归属，发行商不会代替制作方参与推荐。');
      }
    }
    // Deterministic per-origin round robin guarantees a retrieval entry for
    // every queryable origin before adding more branches for earlier origins.
    // Keep the pool independent of page size. With eight origins, eight reads
    // plus four metadata batches and 24 details still fit the 45-read ceiling.
    const branchLimit = seeds.length === 1 ? 12 : Math.min(12, 16 - seeds.length);
    const branchKeys = interleave(perSeedBranches).slice(0, branchLimit);
    const selectedBranches = branchKeys.map(key => planned.get(key));
    const omittedBranches = planned.size - selectedBranches.length;
    const queriedCreators = selectedBranches.filter(branch => branch.kind === 'creator').length;
    const queriedCompanies = selectedBranches.filter(branch => branch.kind === 'company').length;
    const explanation = [...explanations].join('');
    const queries = selectedBranches.map(branch => async () => {
      if (branch.kind === 'creator') {
        const response = page(await this.#client.getCreditNameCredits(branch.id, { limit: 100, nsfw, signal }));
        return { response, creditNameId: branch.id, creatorId: this.#canonicalCreatorId(branch.id, nsfw), ids: idsFromCredits(response, branch.aspects, nsfw), origins: branch.origins,
          malformed: response.items.some(row => !isUsableNameCreditRecord(row)) };
      }
      const filters = branch.kind === 'series' ? { seriesId: branch.id } : { companyId: branch.id };
      const response = page(await this.#client.listWorks({ ...filters, limit: 100, nsfw, signal,
        requireRelationships: true, allowPartialRelationships: true }));
      return { response, ids: idsFromWorks(response, nsfw), origins: branch.origins, seriesId: filters.seriesId, collection: true,
        malformed: response.items.some(row => !isUsableWorkRecord(row)) };
    });
    const branches = await settledMap(queries, 2, query => query(), signal);
    const branchFailures = collectErrors(branches);
    const pages = branches.filter(result => result.status === 'fulfilled').map(result => result.value);
    for (const result of pages) if (result.malformed) branchFailures.push(invalidResponse());
    for (const origin of seeds.filter(origin => origin.type === 'creator')) {
      const identity = await this.#client.resolveCreatorIdentity?.(rawId(origin.id, 'creator'), { nsfw, signal, cacheOnly: true });
      if (identity?.creatorIdentity) Object.assign(origin, canonicalCreatorEntity(origin, identity.creatorIdentity));
      origin.id = `credit:nm:${this.#canonicalCreatorId(rawId(origin.id, 'creator'), nsfw)}`;
      const related = pages.filter(value => value.creditNameId && this.#canonicalCreatorId(value.creditNameId, nsfw) === rawId(origin.id, 'creator'));
      if (related.length) {
        origin.creatorFacts = creatorFactsFromPages(related.map(value => value.response), { nsfw });
        const expected = origin.creatorIdentity?.creditNames.length ?? 1;
        if (related.length < expected || origin.creatorIdentity?.complete === false) origin.creatorFacts.complete = false;
      }
    }
    // Branch reads may have just established redirects; rewrite BOTH sides
    // before ranking, including earlier summaries and origin work credits.
    catalog.splice(0, catalog.length, ...this.#canonicalWorks(catalog, nsfw));
    const excluded = new Set(seeds.filter(origin => origin.type === 'work').map(origin => rawId(origin.id, 'work')));
    const candidateIds = interleave(pages.map(value => value.ids)).filter(id => !excluded.has(id));
    if (seeds.length > 1) {
      // Prioritize retrieval evidence shared by origins before trimming the
      // bounded metadata pool. Final ranking still requires actual work facts.
      const reachedBy = new Map();
      for (const result of pages) for (const id of result.ids) {
        if (!reachedBy.has(id)) reachedBy.set(id, new Set());
        for (const origin of result.origins) reachedBy.get(id).add(origin);
      }
      candidateIds.sort((a, b) => reachedBy.get(b).size - reachedBy.get(a).size);
    }
    // The detail budget is a presentation/hydration limit, not a recall limit.
    // Every unique candidate in the bounded first-page pool gets metadata and
    // the same evidence-based ranking as the browser before pagination begins.
    const poolIds = candidateIds.slice(0, METADATA_BATCH_SIZE * MAX_METADATA_BATCHES);
    const reusable = new Map();
    const poolSet = new Set(poolIds);
    for (const value of pages.filter(value => value.collection)) {
      for (const raw of value.response.items.slice(0, 100)) {
        if (!poolSet.has(raw?.id) || reusable.has(raw.id) || !hasWorkRelationships(raw)) continue;
        const normalized = normalizeWork(raw, { nsfw });
        if (normalized) reusable.set(raw.id, this.#applyKnownYearFacts(normalized, nsfw));
      }
    }
    const neededIds = poolIds.filter(id => !reusable.has(id));
    const batches = [];
    for (let index = 0; index < neededIds.length; index += METADATA_BATCH_SIZE) batches.push(neededIds.slice(index, index + METADATA_BATCH_SIZE));
    const metadata = await settledMap(batches, 2, async ids => {
      const response = page(await this.#client.listWorks({ ids, nsfw, signal,
        requireRelationships: true, allowPartialRelationships: true }));
      const requested = new Set(ids);
      const seen = new Set();
      const works = [];
      let incomplete = 0;
      let malformed = false;
      for (const raw of response.items) {
        // A malformed successful row is retryable, not proof that this
        // candidate is absent or filtered. Retain valid siblings and keep a
        // fresh exploration from reusing the incomplete snapshot.
        if (!isUsableWorkRecord(raw)) { malformed = true; continue; }
        if (!requested.has(raw?.id) || seen.has(raw.id)) continue;
        seen.add(raw.id);
        const normalized = normalizeWork(raw, { nsfw });
        if (!normalized) continue;
        // The collection contract excludes releases. Reuse only evidence from
        // existing detail reads; never add one request per candidate to rank.
        const work = this.#applyKnownYearFacts(normalized, nsfw);
        if (!hasWorkRelationships(raw)) incomplete++;
        works.push(work);
      }
      return { works, incomplete, malformed };
    }, signal);
    // A failed supplemental batch must not hide usable collection rows.
    const metadataFailures = reusable.size
      ? metadata.filter(result => result.status === 'rejected').map(result => result.reason)
      : collectErrors(metadata);
    for (const result of metadata) {
      if (result.status === 'fulfilled' && result.value.malformed) metadataFailures.push(invalidResponse());
    }
    // Retain the original interleaved order: reuse must not alter tie-breaking.
    const metadataById = new Map([...reusable.values(), ...metadata.filter(result => result.status === 'fulfilled').flatMap(result => result.value.works)].map(work => [work.id, work]));
    const loadedMetadata = this.#canonicalWorks(poolIds.map(id => metadataById.get(`nm:${id}`)).filter(Boolean), nsfw);
    this.#checkBuildRetirements(nsfw, retirementVersion);
    catalog.splice(0, catalog.length, ...this.#canonicalWorks(catalog, nsfw));
    seeds.splice(0, seeds.length, ...this.#canonicalSeeds(this.#commitCreatorSeeds(seeds, pages, nsfw, plannedSeeds), nsfw));
    seed = seeds[0];
    this.#withCreatorIdentityLookups(() => { for (const work of loadedMetadata) this.#rememberSummary(work, nsfw, true); });
    const incompleteMetadata = metadata.filter(result => result.status === 'fulfilled').reduce((sum, result) => sum + result.value.incomplete, 0);
    const missingMetadata = poolIds.length - loadedMetadata.length;
    // A series-filtered collection explicitly establishes membership for
    // preliminary ranking. Keep this evidence confined to temporary metadata;
    // the hydrated work must independently confirm it before being returned.
    const seriesMemberships = new Map();
    for (const value of pages) {
      if (!value.seriesId) continue;
      const series = catalog.flatMap(work => array(work.series)).find(item => rawId(item.id, 'series') === value.seriesId);
      if (!series) continue;
      for (const candidateId of value.ids) {
        const memberships = seriesMemberships.get(`nm:${candidateId}`) || [];
        if (!memberships.some(item => item.id === series.id)) memberships.push(series);
        seriesMemberships.set(`nm:${candidateId}`, memberships);
      }
    }
    const rankingMetadata = loadedMetadata.map(work => {
      const extraSeries = (seriesMemberships.get(work.id) || []).filter(series => !array(work.series).some(item => item.id === series.id));
      return extraSeries.length ? { ...work, series: [...array(work.series), ...extraSeries] } : work;
    });
    const ranking = discoverMulti([...catalog, ...rankingMetadata], { seeds, aspect, includeSameSeries });
    const excludedSameSeries = !includeSameSeries && seeds.some(origin => origin.type === 'work')
      ? discoverMulti([...catalog, ...rankingMetadata], { seeds, aspect, includeSameSeries: true }).length - ranking.length : 0;
    const truncated = seeds.some(origin => origin.creatorIdentity?.complete === false) || omittedCreators > 0 || omittedSeries > 0 || omittedCompanies > 0 || omittedBranches > 0 ||
      candidateIds.length > poolIds.length || pages.some(value => Boolean(value.response.next_cursor) || value.response.items.length > 100);
    return {
      nsfw, includeSameSeries, seed, seeds, aspect, retirementVersion: this.#retirementVersion(nsfw), catalog: Object.freeze(catalog),
      rankingIds: Object.freeze(ranking.map(result => result.work.id)),
      rankingYears: new Map([...catalog, ...ranking.map(result => result.work)].map(work => [work.id, {
        rankingYear: work.rankingYear, rankingYearEvidence: structuredClone(work.rankingYearEvidence),
      }])),
      explanation, fetchedAt: new Date(this.#now()).toISOString(),
      unavailableRequests: [...branchFailures, ...metadataFailures].filter(error => error?.status === 404).length,
      coverage: Object.freeze({
        seedCount: seeds.length, branchLimit, queriedBranches: selectedBranches.length, omittedBranches,
        creatorLimit: this.#maxCreators, candidatePoolSize: candidateIds.length, metadataLoaded: loadedMetadata.length,
        metadataBatches: batches.length, reusedMetadata: reusable.size, batchFailures: metadataFailures.length,
        missingMetadata, incompleteMetadata, rankedCandidates: ranking.length, excludedSameSeries,
        queriedCreators, omittedCreators, omittedSeries,
        companyLimit: MAX_COMPANY_BRANCHES, queriedCompanies, omittedCompanies, firstPageOnly: true,
        truncated, failedRequests: branchFailures.length + metadataFailures.length,
      }),
    };
  }

  async #snapshotWork(snapshot, candidateId, signal) {
    checkCancelled(signal);
    this.#checkRetirement(snapshot.nsfw, snapshot.retirementVersion, expiredSnapshot());
    if (snapshot.details.has(candidateId)) return snapshot.details.get(candidateId);
    return sharedOperation(snapshot.detailInflight, `${this.#client.inflightScope ?? ''}\u0000${candidateId}`, signal, async sharedSignal => {
      const decoded = rawId(candidateId, 'work');
      const requireSeries = snapshot.seeds.some(seed => seed.type === 'work') &&
        (snapshot.aspect === 'all' || snapshot.aspect === 'series' || !snapshot.includeSameSeries);
      const raw = await this.#client.getWork(decoded, { nsfw: snapshot.nsfw, signal: sharedSignal, requireRelationships: true, requireSeries });
      checkCancelled(sharedSignal);
      this.#checkRetirement(snapshot.nsfw, snapshot.retirementVersion, expiredSnapshot());
      if (raw?.id !== decoded) throw invalidResponse();
      if (!hasWorkRelationships(raw)) throw invalidResponse();
      if (requireSeries && !hasWorkSeries(raw)) throw invalidResponse();
      let work = this.#canonicalWork(normalizeWork(raw, { nsfw: snapshot.nsfw }), snapshot.nsfw);
      this.#rememberYearFacts(work, snapshot.nsfw);
      this.#rememberSummary(work, snapshot.nsfw, true);
      if (work && snapshot.rankingYears.has(candidateId)) work = { ...work, ...structuredClone(snapshot.rankingYears.get(candidateId)) };
      snapshot.details.set(candidateId, work);
      while (snapshot.details.size > DETAIL_CACHE_LIMIT) snapshot.details.delete(snapshot.details.keys().next().value);
      return work;
    });
  }

  async #snapshotPage(snapshot, pageNumber, pageSize, signal) {
    checkCancelled(signal);
    this.#checkSnapshotIdentities(snapshot);
    const totalPages = Math.max(1, Math.ceil(snapshot.rankingIds.length / pageSize));
    if (pageNumber > totalPages) throw invalid('The requested page is outside this exploration snapshot.');
    const pageKey = `${pageNumber}:${pageSize}`;
    if (snapshot.pages.has(pageKey)) return snapshot.pages.get(pageKey);
    return sharedOperation(snapshot.pageInflight, `${this.#client.inflightScope ?? ''}\u0000${pageKey}`, signal, async sharedSignal => {
      const result = await this.#hydratePage(snapshot, pageNumber, pageSize, totalPages, sharedSignal);
      checkCancelled(sharedSignal);
      this.#checkRetirement(snapshot.nsfw, snapshot.retirementVersion, expiredSnapshot());
      // Retry transient detail failures using the same fixed positions. Other
      // successful details remain cached, including across page-size changes.
      if (!result.coverage.detailFailures) {
        snapshot.pages.set(pageKey, result);
        while (snapshot.pages.size > PAGE_CACHE_LIMIT) snapshot.pages.delete(snapshot.pages.keys().next().value);
      }
      return result;
    });
  }

  async #hydratePage(snapshot, pageNumber, pageSize, totalPages, signal) {
    const { nsfw, includeSameSeries, seed, seeds, aspect, explanation, fetchedAt } = snapshot;
    const positionIds = snapshot.rankingIds.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    const details = await settledMap(positionIds, 2, candidateId => this.#snapshotWork(snapshot, candidateId, signal), signal);
    const detailFailures = collectErrors(details);
    const hydrated = details.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
    const verifiedIds = new Set(discoverMulti(this.#canonicalWorks([...snapshot.catalog, ...hydrated], nsfw), { seeds: this.#canonicalSeeds(seeds, nsfw), aspect, includeSameSeries }).map(result => result.work.id));
    // Verification can reject a position but cannot move it to another page.
    // Keep the frozen metadata order even if richer details change its score.
    const candidates = hydrated.filter(work => verifiedIds.has(work.id));
    const detailRejected = hydrated.length - candidates.length;
    const catalog = [...snapshot.catalog, ...candidates];
    const failedRequests = snapshot.coverage.failedRequests + detailFailures.length;
    const skippedWorks = details.filter(result => result.status === 'fulfilled' && !result.value).length;
    const { candidatePoolSize, metadataLoaded, rankedCandidates, missingMetadata, incompleteMetadata, truncated, excludedSameSeries } = snapshot.coverage;
    const partial = truncated || failedRequests > 0 || skippedWorks > 0 || missingMetadata > 0 || incompleteMetadata > 0 || detailRejected > 0;
    const missing = snapshot.unavailableRequests + detailFailures.filter(error => error?.status === 404).length;
    return {
      mode: 'live', nsfw, includeSameSeries, seed, seeds, catalog, partial,
      notice: `本次关联池 ${candidatePoolSize} 部，已取得 ${metadataLoaded} 部排序资料，其中 ${rankedCandidates} 部有明确关联，可分页浏览。当前第 ${pageNumber}/${totalPages} 页，已加载 ${candidates.length} 部候选，每页最多 ${pageSize} 部，并以详情再次核实。语言、平台和已玩筛选仅作用于本页。关联仅基于本次已加载资料，并非全目录。${explanation}${!includeSameSeries && seeds.some(origin => origin.type === 'work') ? `排序前已排除 ${excludedSameSeries} 部已确认同系列作品；系列资料未标记或未完整加载的候选无法据此排除。` : ''}${!includeSameSeries && !seeds.some(origin => origin.type === 'work') ? '同系列开关仅在以作品为起点时生效。' : ''}${truncated ? '部分关联或上游后续分页尚未加载。' : ''}${missingMetadata ? `${missingMetadata} 部候选未取得可用排序资料。` : ''}${incompleteMetadata ? `${incompleteMetadata} 部排序资料缺少署名或制作方字段，仅按已知事实比较。` : ''}${failedRequests ? `${failedRequests} 个请求未完成${missing ? `（其中 ${missing} 项已不可见或不存在）` : ''}，可稍后重试。` : ''}${skippedWorks ? `${skippedWorks} 部详情不符合当前 Galgame 视图，已跳过。` : ''}${detailRejected ? `${detailRejected} 部候选的详情未满足当前关联条件或同系列设置，已剔除。` : ''}`,
      fetchedAt,
      pagination: { page: pageNumber, pageSize, totalCandidates: rankedCandidates, totalPages,
        snapshotId: snapshot.snapshotId, positionIds },
      coverage: {
        ...snapshot.coverage, candidateLimit: pageSize,
        loadedWorks: catalog.length, loadedCandidates: candidates.length,
        detailRejected, detailFailures: detailFailures.length, failedRequests, skippedWorks,
      },
    };
  }
}
