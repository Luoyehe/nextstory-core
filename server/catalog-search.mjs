// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Bounded name suggestions. Only catalog-returned identities can be suggested. */
import { randomBytes } from 'node:crypto';
import { NextMoeError, catalogIdentityMatcher } from './nextmoe.mjs';
import { normalizeSearchHit, isUsableSearchRecord } from './catalog-normalize.mjs';
import { matchSearchLabel, searchFallbackQueries, searchRecoveryQueries } from '../lib/search-match.js';

const FAMILIES = ['work', 'credit_name', 'company'];
const NAME_TTL = 15 * 60_000;
const NAME_LIMIT = 2000;
// One upstream call costs the same for 20 or 100 names. Return every name
// already retrieved; only explicit continuation may query further streams.
const PAGE_LIMIT = 100;
const invalid = message => new NextMoeError('INVALID_INPUT', message, { status: 400 });
const cancelled = () => new NextMoeError('CANCELLED', 'The catalog request was cancelled.');
const fatal = error => [401, 403, 429].includes(error?.status) ||
  ['NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'LOCAL_QUOTA', 'QUOTA_EXCEEDED', 'ENTITY_MERGED', 'CANCELLED'].includes(error?.code);
const qualityRank = { human: 2, unknown: 1, machine: 0 };

// Keep provenance on each actual spelling, not on the displayed (possibly
// translated) label. A source name without an explicit flag remains unknown.
function nameEvidence(hit) {
  const names = new Map();
  for (const value of [hit.display_name, hit.latin]) {
    if (typeof value === 'string' && value.trim()) names.set(value.trim(), 'unknown');
  }
  const titleNames = (Array.isArray(hit.titles) ? hit.titles : []).flatMap(title => [
    { value: title?.title, is_machine: title?.is_machine },
    { value: title?.latin, is_machine: title?.is_machine },
  ]);
  for (const localized of [...Object.values(hit.localized ?? {}), ...titleNames,
    ...(Array.isArray(hit.aliases) ? hit.aliases : [])]) {
    if (typeof localized?.value !== 'string' || !localized.value.trim()) continue;
    const value = localized.value.trim();
    const quality = localized.is_machine === false ? 'human' : localized.is_machine === true ? 'machine' : 'unknown';
    const previous = names.get(value);
    // An explicit fact refines an unspecified spelling. If the same spelling
    // also has a human-supplied entry, it need not depend on machine translation.
    if (!previous || previous === 'unknown' || quality === 'human') names.set(value, quality);
  }
  return [...names].map(([value, quality]) => ({ value, quality }));
}

const annotate = (item, query) => {
  const { nameEvidence: names, ...visible } = item;
  let match;
  for (const name of names ?? [item.label, ...(item.aliases || [])].map(value => ({ value, quality: 'unknown' }))) {
    const candidate = matchSearchLabel(query, [name.value]);
    if (!candidate) continue;
    if (!match || candidate.score > match.score ||
        (candidate.score === match.score && qualityRank[name.quality] > qualityRank[match.nameQuality])) {
      match = { ...candidate, nameQuality: name.quality };
    }
  }
  return match ? { ...visible, match } : visible;
};
const ordered = items => items.map((item, index) => ({ item, index }))
  // Unclassified original upstream hits may match aliases not included in the
  // response. Preserve them ahead of our own speculative corrections.
  .sort((a, b) => (b.item.match?.score ?? 500) - (a.item.match?.score ?? 500) ||
    (a.item.match?.kind === 'typo' && b.item.match?.kind === 'typo'
      ? (qualityRank[b.item.match.nameQuality] ?? 1) - (qualityRank[a.item.match.nameQuality] ?? 1) : 0) || a.index - b.index)
  .map(({ item }) => item);

const identity = item => `${item.type}:${item.id}`;
const finiteDelay = value => Number.isFinite(value) && value > 0 ? value : 0;

function mergeNames(previous, item) {
  if (!previous) return structuredClone(item);
  const names = new Map();
  for (const entry of [...(previous.nameEvidence || []), ...(item.nameEvidence || [])]) {
    const existing = names.get(entry.value);
    if (!existing || qualityRank[entry.quality] > qualityRank[existing.quality]) names.set(entry.value, entry);
  }
  const factsQuality = facts => !facts ? -1 : Number(Boolean(facts.year)) + Number(Boolean(facts.companies?.length)) + Number(Boolean(facts.names?.length));
  const newerFacts = item.workFacts && factsQuality(item.workFacts) >= factsQuality(previous.workFacts);
  return { ...previous, ...(newerFacts ? { workFacts: item.workFacts, subtitle: item.subtitle } : {}),
    aliases: [...new Set([...(previous.aliases || []), ...(item.aliases || [])])],
    ...(names.size ? { nameEvidence: [...names.values()] } : {}) };
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class CatalogSearch {
  #client;
  #now;
  #timeoutMs;
  #cursorTtl;
  #names = new Map([[false, new Map()], [true, new Map()]]);
  #cursors = new Map();
  #retirementVersions = new Map([[false, 0], [true, 0]]);

  constructor({ client, now = Date.now, preparationTimeoutMs = 12_000, cursorTtlMs = 10 * 60_000 }) {
    if (!Number.isFinite(preparationTimeoutMs) || preparationTimeoutMs <= 0 || !Number.isFinite(cursorTtlMs) || cursorTtlMs <= 0) throw invalid('Search time limits must be positive.');
    this.#client = client; this.#now = now; this.#timeoutMs = preparationTimeoutMs; this.#cursorTtl = cursorTtlMs;
    this.#client.registerCatalogCache?.(this);
  }

  findCatalogIdentities(events) {
    const match = catalogIdentityMatcher(events), found = new Set();
    for (const names of this.#names.values()) for (const row of names.values()) {
      if (row.expiresAt > this.#now()) match(row.item, found);
    }
    for (const cursor of this.#cursors.values()) {
      if (cursor.expiresAt > this.#now()) match(cursor, found);
    }
    return found;
  }

  #remember(items, nsfw) {
    const names = this.#names.get(nsfw);
    for (const item of items) {
      const key = identity(item), previous = names.get(key);
      names.delete(key);
      names.set(key, { item: mergeNames(previous?.expiresAt > this.#now() ? previous.item : null, item), expiresAt: this.#now() + NAME_TTL });
    }
    while (names.size > NAME_LIMIT) names.delete(names.keys().next().value);
  }

  #knownMatches(query, nsfw) {
    this.#prune();
    const items = [];
    for (const hit of this.#client.searchKnownCatalog?.(query, { nsfw }) ?? []) {
      if (!isUsableSearchRecord(hit)) continue;
      const normalized = normalizeSearchHit(hit, { nsfw });
      if (!normalized) continue;
      const item = { ...normalized, nameEvidence: nameEvidence(hit) };
      const candidate = annotate(item, query);
      if (candidate.match) items.push({ ...candidate, nameEvidence: item.nameEvidence });
    }
    for (const [key, value] of this.#names.get(nsfw)) {
      if (value.expiresAt <= this.#now()) { this.#names.get(nsfw).delete(key); continue; }
      const item = annotate(value.item, query);
      if (item.match) items.push({ ...structuredClone(item), nameEvidence: structuredClone(value.item.nameEvidence || []) });
    }
    return items;
  }

  #retirementVersion(nsfw) {
    return this.#client.catalogRetirementVersionFor?.({ nsfw }) ?? this.#client.catalogRetirementVersion ?? 0;
  }

  #checkRetirement(nsfw, version, continuation = false) {
    if (this.#retirementVersion(nsfw) === version) return;
    this.#prune();
    throw continuation
      ? new NextMoeError('SEARCH_CURSOR_EXPIRED', '搜索候选已更新，请重新搜索。', { status: 410 })
      : new NextMoeError('CATALOG_CHANGED', '目录资料已更新，请重新查询以取得当前条目。', { status: 409 });
  }

  #prune() {
    for (const nsfw of [false, true]) {
      const version = this.#retirementVersion(nsfw);
      if (this.#retirementVersions.get(nsfw) === version) continue;
      // Both spelling memory and replayable continuation responses can contain
      // a deleted/merged candidate. Require a fresh search rather than letting
      // an old cursor put it back. The other NSFW partition remains usable.
      this.#names.get(nsfw).clear();
      for (const [key, entry] of this.#cursors) if (entry.scope.nsfw === nsfw) this.#cursors.delete(key);
      this.#retirementVersions.set(nsfw, version);
    }
    for (const [key, entry] of this.#cursors) if (entry.expiresAt <= this.#now()) this.#cursors.delete(key);
  }

  #publish(scope, streams, warnings) {
    if (!streams.length) return null;
    this.#prune();
    const token = `sc_${randomBytes(24).toString('base64url')}`;
    this.#cursors.set(token, { scope, streams: structuredClone(streams), warnings: structuredClone(warnings),
      retirementVersion: this.#retirementVersion(scope.nsfw), expiresAt: this.#now() + this.#cursorTtl });
    while (this.#cursors.size > 128) this.#cursors.delete(this.#cursors.keys().next().value);
    return token;
  }

  async #bounded(signal, execute) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const result = await execute(combined, deadline.signal);
      if (signal?.aborted) throw cancelled();
      return result;
    } finally { clearTimeout(timer); }
  }

  async #batch(streams, { nsfw, signal, deadline, external }) {
    if (external?.aborted) throw cancelled();
    if (deadline.aborted) return { items: [], raw: [], pending: streams, failures: [], warnings: [], requests: 0, queries: [], stopped: true };
    const results = await Promise.allSettled(streams.map(async stream => {
      const response = await withAbort(Promise.resolve().then(() => this.#client.searchCatalog(stream.query, stream.object, {
        limit: PAGE_LIMIT, nsfw, signal, ...(stream.cursor ? { cursor: stream.cursor } : {}),
      })), signal);
      if (!response || !Array.isArray(response.items)) {
        throw new NextMoeError('INVALID_RESPONSE', 'NextMoe returned an unexpected catalog response.');
      }
      return response;
    }));
    if (external?.aborted) throw cancelled();
    const raw = [], pending = [], failures = [], warnings = [];
    const items = [];
    let stopped = deadline.aborted;
    results.forEach((result, index) => {
      const stream = streams[index];
      if (result.status === 'rejected') {
        const error = deadline.aborted && result.reason?.code === 'CANCELLED'
          ? new NextMoeError('TIMEOUT', 'This search batch reached its time budget.') : result.reason;
        const failure = { object: stream.object, query: stream.query, code: error?.code || 'UPSTREAM_UNAVAILABLE', retryAfterMs: finiteDelay(error?.retryAfterMs) };
        failures.push(failure);
        pending.push({ ...stream, failure, retryAt: this.#now() + failure.retryAfterMs });
        stopped ||= fatal(error);
        return;
      }
      const response = result.value;
      const page = new Map();
      let malformed = false;
      // Preserve even unexpected extra rows; a display limit must never hide
      // or discard identities that the upstream has already returned.
      for (const hit of response.items) {
        if (!isUsableSearchRecord(hit)) { malformed = true; continue; }
        if (hit?.target_object !== stream.object) continue;
        const item = normalizeSearchHit(hit, { nsfw });
        if (!item) continue;
        const value = { ...item, nameEvidence: nameEvidence(hit) };
        page.set(identity(item), mergeNames(page.get(identity(item)), value));
      }
      for (const item of page.values()) {
        raw.push(item);
        const candidate = annotate(item, stream.originalQuery);
        items.push({ ...candidate, nameEvidence: item.nameEvidence, ...(!candidate.match && stream.probe ? { match: { kind: 'related', score: 100, probe: stream.probe } } : {}) });
      }
      let nextStream = null;
      if (!stream.retryOnly && response.next_cursor !== undefined && (typeof response.next_cursor !== 'string' || !/^cur_[A-Za-z0-9._~-]+$/.test(response.next_cursor) || response.next_cursor.length > 512)) {
        warnings.push({ object: stream.object, query: stream.query, code: 'INVALID_UPSTREAM_CURSOR', retryAfterMs: 0 });
      } else if (!stream.retryOnly && response.next_cursor) {
        const seen = [...(stream.seen || []), ...(stream.cursor ? [stream.cursor] : [])];
        if (seen.includes(response.next_cursor)) {
          warnings.push({ object: stream.object, query: stream.query, code: 'CURSOR_LOOP', retryAfterMs: 0 });
        } else {
          const { failure: _failure, retryAt: _retryAt, ...next } = stream;
          nextStream = { ...next, cursor: response.next_cursor, seen };
        }
      }
      if (malformed) {
        // Retain the missing identity's page for explicit recovery without
        // blocking a known healthy successor. Once that successor is published,
        // retries only heal this page and cannot fork its pagination again.
        const failure = { object: stream.object, query: stream.query, code: 'INVALID_RESPONSE', retryAfterMs: 0 };
        failures.push(failure);
        pending.push({ ...stream, ...(nextStream ? { retryOnly: true } : {}), failure, retryAt: this.#now() });
      }
      if (nextStream) pending.push(nextStream);
    });
    return { items, raw, pending, failures, warnings, requests: streams.length, queries: streams.map(stream => stream.probe).filter(Boolean), stopped };
  }

  #response({ scope, items, pending, failures = [], warnings = [], requests = 0, probes = [], fromKnownNames = false, nextCursor }) {
    const unique = new Map();
    for (const item of items) {
      const key = identity(item), previous = unique.get(key);
      // Keep every spelling's provenance until all identities are merged. A
      // later row may have fewer names; it must not erase earlier exact evidence.
      const merged = mergeNames(previous?.item, item);
      delete merged.match;
      unique.set(key, { item: merged, direct: previous?.direct || item.match?.kind !== 'related',
        related: previous?.related || (item.match?.kind === 'related' ? item.match : null) });
    }
    const ranked = ordered([...unique.values()].map(({ item, direct, related }) => {
      const candidate = annotate(item, scope.query);
      if (!candidate.match && !direct && related) candidate.match = related;
      return { ...candidate, nameEvidence: item.nameEvidence };
    }));
    const displayed = ranked.map(({ nameEvidence: _names, ...item }) => item);
    nextCursor ??= this.#publish(scope, pending, warnings);
    const outstanding = [...failures, ...pending.flatMap(stream => stream.failure ? [{ ...stream.failure, retryAfterMs: Math.max(0, (stream.retryAt || 0) - this.#now()) }] : []), ...warnings];
    const errors = [...new Map(outstanding.map(error => [`${error.object}:${error.query}:${error.code}`, error])).values()];
    const authorizationRequired = errors.some(error => error.code === 'CATALOG_AUTH_REQUIRED');
    // All retrieved names are visible now; the cooldown applies only to
    // further upstream work, never to choosing an existing candidate.
    const retryAfterMs = Math.max(0, ...errors.map(error => finiteDelay(error.retryAfterMs)));
    const partial = Boolean(nextCursor) || errors.length > 0 || fromKnownNames;
    return {
      mode: 'live', nsfw: scope.nsfw, items: displayed, partial, nextCursor, retryAfterMs,
      searchCoverage: {
        correctionEnabled: scope.correction, correctionCandidates: displayed.filter(item => item.match?.kind === 'typo').length,
        relatedCandidates: displayed.filter(item => item.match?.kind === 'related').length,
        fromKnownNames, fallbackQueries: new Set(probes).size, requestsPlanned: requests,
        perFallbackFamilyLimit: PAGE_LIMIT, perDirectFamilyLimit: PAGE_LIMIT,
        failedFamilies: [...new Set(errors.map(error => error.object))], failures: errors, retryAfterMs,
        truncated: pending.some(stream => Boolean(stream.cursor)) || warnings.length > 0,
        pendingStreams: pending.length,
      },
      notice: `本次取得 ${displayed.length} 条候选，按名称匹配程度排序。${fromKnownNames ? '同时补充此前已加载的名称。' : ''}${authorizationRequired ? '个人作品查询授权已失效，请打开账户窗口重新授权后重试。' : errors.length ? '部分查询暂时未完成，可稍后继续加载。' : ''}${warnings.some(warning => warning.code === 'CURSOR_LOOP') ? '上游分页出现重复，已停止该分页以避免循环。' : ''}${warnings.some(warning => warning.code === 'INVALID_UPSTREAM_CURSOR') ? '上游分页标识无效，已保留取得的候选；请稍后重新搜索。' : ''}${nextCursor ? '还有候选或扩展查询可继续加载。' : ''}${!displayed.length && !partial ? '本次查询未返回候选，可以试试原名或另一种写法。' : ''}作品类型将在打开后核实。`,
    };
  }

  async #initial(scope, external, version) {
    return this.#bounded(external, async (signal, deadline) => {
      const makeStreams = (query, probe) => FAMILIES.map(object => ({ object, query, originalQuery: scope.query, ...(probe ? { probe } : {}) }));
      const direct = await this.#batch(makeStreams(scope.query), { nsfw: scope.nsfw, signal, deadline, external });
      const batches = [direct];
      const pending = [...direct.pending];
      const known = scope.correction ? this.#knownMatches(scope.query, scope.nsfw) : [];
      // A complete name keeps the three-request fast path. Otherwise a work
      // prefix must not suppress a missing creator/CV/company's correction.
      // Only that already-useful family's expansion waits for an explicit click.
      const exactDirect = direct.items.some(item => ['exact', 'normalized'].includes(item.match?.kind));
      const strongTypes = new Set(direct.items.filter(item => ['exact', 'normalized', 'prefix', 'substring'].includes(item.match?.kind)).map(item => item.type));
      const typeOf = object => object === 'credit_name' ? 'creator' : object;
      let stopped = direct.stopped;
      if (scope.correction) {
        for (const fragment of searchFallbackQueries(scope.query)) {
          const streams = [];
          for (const stream of makeStreams(fragment, fragment)) {
            if (exactDirect || strongTypes.has(typeOf(stream.object)) || stopped || deadline.aborted) pending.push(stream);
            else streams.push(stream);
          }
          if (!streams.length) continue;
          const batch = await this.#batch(streams, { nsfw: scope.nsfw, signal, deadline, external });
          batches.push(batch); pending.push(...batch.pending); stopped ||= batch.stopped;
        }
        // Less selective swap recovery is available without expanding the
        // initial request budget (at most three direct + six fragment calls).
        if (!exactDirect) for (const fragment of searchRecoveryQueries(scope.query)) {
          pending.push(...makeStreams(fragment, fragment).filter(stream => !strongTypes.has(typeOf(stream.object))));
        }
      }
      if (external?.aborted) throw cancelled();
      // A previously completed family/fragment can be retired while another
      // request is pending. Check before repopulating names or publishing cursors.
      this.#checkRetirement(scope.nsfw, version);
      const raw = batches.flatMap(batch => batch.raw);
      this.#remember(raw, scope.nsfw);
      const fresh = new Set(raw.map(identity));
      const supplemental = known.filter(item => !fresh.has(identity(item)));
      const warnings = batches.flatMap(batch => batch.warnings);
      return this.#response({ scope, items: [...batches.flatMap(batch => batch.items), ...known], pending,
        failures: batches.flatMap(batch => batch.failures), warnings, requests: batches.reduce((sum, batch) => sum + batch.requests, 0),
        probes: batches.flatMap(batch => batch.queries), fromKnownNames: supplemental.length > 0 });
    });
  }

  async #continue(entry, token, external) {
    return this.#bounded(external, async (signal, deadline) => {
      const selected = [], rest = [];
      for (const stream of entry.streams) {
        if (selected.length < FAMILIES.length && (!stream.retryAt || stream.retryAt <= this.#now())) selected.push(stream);
        else rest.push(stream);
      }
      if (!selected.length) return { complete: false, response: this.#response({ scope: entry.scope, items: [], pending: rest, warnings: entry.warnings, nextCursor: token }) };
      const batch = await this.#batch(selected, { nsfw: entry.scope.nsfw, signal, deadline, external });
      if (external?.aborted) throw cancelled();
      this.#checkRetirement(entry.scope.nsfw, entry.retirementVersion, true);
      const pending = [...rest, ...batch.pending], warnings = [...entry.warnings, ...batch.warnings];
      this.#remember(batch.raw, entry.scope.nsfw);
      return { complete: true, response: this.#response({ scope: entry.scope, items: batch.items, pending,
        failures: batch.failures, warnings, requests: batch.requests, probes: batch.queries }) };
    });
  }

  #readCursor(entry, token, signal) {
    if (entry.result) return Promise.resolve(structuredClone(entry.result));
    let run = entry.running;
    if (!run || run.controller.signal.aborted) {
      const controller = new AbortController();
      run = { controller, waiters: 0 };
      entry.running = run;
      run.promise = this.#continue(entry, token, controller.signal).then(({ complete, response }) => {
        if (controller.signal.aborted) throw cancelled();
        this.#checkRetirement(entry.scope.nsfw, entry.retirementVersion, true);
        if (complete) {
          entry.result = structuredClone(response);
          // Replay needs only the immutable response. The successor owns any
          // remaining upstream work.
          entry.streams = [];
        }
        return response;
      }).finally(() => { if (entry.running === run) entry.running = null; });
    }
    run.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); run.waiters--;
        if (!run.waiters && !entry.result) run.controller.abort();
        fn(value);
      };
      const abort = () => finish(reject, cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      run.promise.then(value => finish(resolve, structuredClone(value)), error => finish(reject, error));
    });
  }

  async search(query, { signal, nsfw = false, correction = false, cursor } = {}) {
    if (typeof nsfw !== 'boolean') throw invalid('The NSFW setting must be a boolean.');
    if (typeof correction !== 'boolean') throw invalid('The correction setting must be a boolean.');
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 512) throw invalid('Enter a search query containing 1–512 characters.');
    if (signal?.aborted) throw cancelled();
    // Continuations retain identity-specific failures and cooldowns. Names and
    // catalogue data stay shared; this scope never appears in the response.
    const scope = { query: query.normalize('NFKC').replace(/\s+/gu, ' ').trim(), nsfw, correction,
      inflightScope: this.#client.inflightScope ?? '' };
    this.#prune();
    const version = this.#retirementVersion(nsfw);
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !/^sc_[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 160) throw new NextMoeError('INVALID_SEARCH_CURSOR', '请使用本次搜索返回的分页标识。', { status: 400 });
      const entry = this.#cursors.get(cursor);
      if (!entry) throw new NextMoeError('SEARCH_CURSOR_EXPIRED', '搜索候选已过期，请重新搜索。', { status: 410 });
      if (JSON.stringify(entry.scope) !== JSON.stringify(scope)) throw new NextMoeError('INVALID_SEARCH_CURSOR', '搜索条件已变化，请重新搜索。', { status: 400 });
      const result = await this.#readCursor(entry, cursor, signal);
      this.#checkRetirement(nsfw, version, true);
      return result;
    }
    const result = await this.#initial(scope, signal, version);
    this.#checkRetirement(nsfw, version);
    return result;
  }
}
