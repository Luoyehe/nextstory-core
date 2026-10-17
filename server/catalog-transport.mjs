// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AsyncLocalStorage } from 'node:async_hooks';

async function discardResponse(response) {
  // Disposal is best effort: a body that already errored or lost its socket
  // must not suppress a valid credential refresh or quota fallback.
  try { await response.body?.cancel(); } catch { /* The response is no longer used. */ }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const PUBLIC_PATH = /^\/v2\/catalog\/(?:search|roles|changes|redirects|(?:works|credit-names|persons|companies|characters|releases|series|tags|traits|engines)(?:\/[0-9]{1,20}(?:\/(?:credits|credit-names|titles|refs|releases|series|platforms|companies|tags|characters|appearances|graph|covers|links|descriptions))?)?)$/;
const DEFAULTS = { user: [100, 10_000], anonymous: [30, 1_000], application: [60, 50_000] };

function problem(status, code, seconds) {
  return Response.json({ code }, { status, headers: seconds === undefined ? {} : { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) } });
}
function checkSignal(signal) { signal?.throwIfAborted(); }
function credentialFailure(error, signal) {
  checkSignal(signal);
  if (error?.code === 'CATALOG_AUTH_REQUIRED') return userAuthorization(problem(403, 'SCOPE_REQUIRED'));
  if (error?.status === 401 || error?.code === 'AUTH_REQUIRED') return userAuthorization(problem(401, 'UNAUTHORIZED'));
  // OAuth throttling/outages are not catalogue quota exhaustion. Preserve the
  // session and do not fan this failure out through anonymous/application lanes.
  return problem(503, 'UPSTREAM_UNAVAILABLE');
}
function userAuthorization(response) {
  const headers = new Headers(response.headers);
  headers.set('X-NextStory-User-Authorization', 'required');
  return new Response(response.body, { status: response.status, headers });
}
function retryAt(response, now, daily) {
  const raw = response.headers.get('retry-after');
  const delay = raw && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : NaN;
  const date = raw && !Number.isFinite(delay) ? Date.parse(raw) : NaN;
  return Math.max(now + 1000, Number.isFinite(delay) ? now + delay : Number.isFinite(date) ? date
    : (Math.floor(now / (daily ? DAY : MINUTE)) + 1) * (daily ? DAY : MINUTE));
}
function bucket(kind, now) {
  return { kind, limits: [...DEFAULTS[kind]], minute: Math.floor(now / MINUTE), day: Math.floor(now / DAY),
    minuteCount: 0, dayCount: 0, remaining: null, blockedUntil: 0, active: 0 };
}

/** Credential routing is only for the ordinary public catalogue. Site claims,
 * account data and writes must never pass through this shared-cache transport.
 * Local windows avoid repeated known failures; upstream headers remain authoritative.
 */
export class CatalogTransport {
  #context = new AsyncLocalStorage();
  #apiKey; #fetch; #now; #maximum; #users = new Map(); #anonymous; #application;
  #foregroundActive = 0;
  constructor({ apiKey, fetchImpl = globalThis.fetch, now = Date.now, maxUserBuckets = 2048 } = {}) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || /\s/.test(apiKey))) throw new TypeError('Invalid catalogue credential.');
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(maxUserBuckets) || maxUserBuckets < 1) throw new TypeError('Invalid catalogue transport options.');
    this.#apiKey = apiKey || null; this.#fetch = fetchImpl; this.#now = now; this.#maximum = maxUserBuckets;
    this.#anonymous = bucket('anonymous', now()); this.#application = bucket('application', now());
  }
  run(identity, operation) {
    if (identity !== null && identity !== undefined && (typeof identity.userId !== 'string' || !identity.userId || typeof identity.getAccessToken !== 'function')) throw new TypeError('Invalid catalogue identity.');
    return this.#context.run({ identity }, operation);
  }
  runBackground(operation) { return this.#context.run({ background: true }, operation); }
  backgroundReady() {
    if (!this.#apiKey || this.#foregroundActive || this.#wait(this.#application)) return false;
    const state = this.#application;
    // Background work shares the application's real bucket. Keep at least 60%
    // of each window for foreground quota fallback; never borrow a lane.
    const minuteLeft = Math.min(state.limits[0] - state.minuteCount, state.remaining ?? Infinity);
    return minuteLeft > Math.ceil(state.limits[0] * 0.6)
      && state.limits[1] - state.dayCount > Math.ceil(state.limits[1] * 0.6);
  }
  // This reports configured application credentials, not the first foreground
  // route. Sync/setup use it to determine whether a website key is available.
  status() { return { credentialMode: this.#apiKey ? 'application' : 'anonymous' }; }
  inflightScope() {
    const context = this.#context.getStore();
    return context?.background ? 'background' : context?.identity ? `user:${context.identity.userId}` : 'anonymous';
  }
  #reset(state) {
    const now = this.#now(), minute = Math.floor(now / MINUTE), day = Math.floor(now / DAY);
    if (minute !== state.minute) { state.minute = minute; state.minuteCount = 0; state.remaining = null; }
    if (day !== state.day) { state.day = day; state.dayCount = 0; }
  }
  #user(id) {
    if (this.#users.has(id)) return this.#users.get(id);
    const now = this.#now();
    // Never evict a live cooldown/count and thereby reset someone's allowance.
    for (const [key, state] of this.#users) if (!state.active && state.day < Math.floor(now / DAY) && state.blockedUntil <= now) this.#users.delete(key);
    if (this.#users.size >= this.#maximum) return null;
    const state = bucket('user', now); this.#users.set(id, state); return state;
  }
  #wait(state) {
    this.#reset(state);
    const now = this.#now();
    return Math.max(0, state.blockedUntil - now,
      state.minuteCount >= state.limits[0] || state.remaining === 0 ? (state.minute + 1) * MINUTE - now : 0,
      state.dayCount >= state.limits[1] ? (state.day + 1) * DAY - now : 0);
  }
  #observe(state, response, started) {
    this.#reset(state);
    for (const part of (response.headers.get('ratelimit-policy') || '').split(',')) {
      const match = /^\s*(\d+)\s*;\s*w=(\d+)\s*$/.exec(part);
      if (match && Number(match[1]) > 0 && Number.isSafeInteger(Number(match[1]))) {
        const index = Number(match[2]) === 60 ? 0 : Number(match[2]) === 86400 ? 1 : -1;
        if (index >= 0) state.limits[index] = Number(match[1]);
      }
    }
    // A response from the previous natural minute must not spend the new one.
    if (started !== state.minute) return;
    const rate = response.headers.get('ratelimit') || '';
    const remainingText = /(?:^|[,;]\s*)remaining=(\d+)/.exec(rate)?.[1] ?? response.headers.get('x-ratelimit-remaining');
    if (remainingText !== null && /^\d+$/.test(remainingText)) {
      const remaining = Math.max(0, Number(remainingText) - state.active);
      state.remaining = state.remaining === null ? remaining : Math.min(state.remaining, remaining);
    }
  }
  async #send(url, init, state, token) {
    checkSignal(init.signal);
    const wait = this.#wait(state);
    if (wait) return problem(429, 'RATE_LIMITED', wait / 1000);
    const headers = new Headers(init.headers);
    headers.delete('Authorization'); headers.delete('X-API-Key'); headers.delete('Cookie');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    state.minuteCount++; state.dayCount++; state.active++;
    if (state.remaining !== null) state.remaining = Math.max(0, state.remaining - 1);
    const started = state.minute;
    let response;
    try { response = await this.#fetch(url, { ...init, method: 'GET', headers, redirect: 'error', credentials: 'omit' }); }
    finally { state.active--; }
    checkSignal(init.signal);
    this.#observe(state, response, started);
    if (response.status === 429) {
      let daily = false;
      try { daily = (await response.clone().json())?.code === 'QUOTA_EXCEEDED'; } catch { /* Retry-After still applies. */ }
      checkSignal(init.signal);
      state.blockedUntil = Math.max(state.blockedUntil, retryAt(response, this.#now(), daily));
    }
    return response;
  }
  async fetch(input, init = {}) {
    const background = this.#context.getStore()?.background === true;
    if (background && this.#apiKey && !this.backgroundReady()) return problem(429, 'BACKGROUND_PAUSED', 60);
    if (!background) this.#foregroundActive++;
    try { return await this.#route(input, init); }
    finally { if (!background) this.#foregroundActive--; }
  }
  async #route(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== 'https://api.nextmoe.dev' || url.username || url.password || url.hash || !PUBLIC_PATH.test(url.pathname) ||
      (init.method && init.method.toUpperCase() !== 'GET') || url.searchParams.has('site') || url.searchParams.has('claim_state')) {
      throw new TypeError('Only the ordinary public catalogue may use this transport.');
    }
    checkSignal(init.signal);
    const context = this.#context.getStore() || {};
    if (context.background && !this.#apiKey) return problem(503, 'NOT_CONFIGURED');
    const identity = context.identity;
    const user = identity ? this.#user(identity.userId) : null;
    if (identity && !user) return problem(503, 'CATALOG_BUSY');
    const routes = context.background ? [this.#application]
      : [...(identity ? [user] : []), this.#anonymous, ...(this.#apiKey ? [this.#application] : [])];
    let shortestWait = Infinity;
    for (const state of routes) {
      checkSignal(init.signal);
      const wait = this.#wait(state);
      if (wait) { shortestWait = Math.min(shortestWait, wait); continue; }
      let token = state.kind === 'application' ? this.#apiKey : null;
      if (state.kind === 'user') {
        try { token = await identity.getAccessToken(); }
        catch (error) { return credentialFailure(error, init.signal); }
        if (!token || typeof token !== 'string') return userAuthorization(problem(401, 'UNAUTHORIZED'));
      }
      let response = await this.#send(url, init, state, token);
      if (response.status === 401 && state.kind === 'user') {
        checkSignal(init.signal);
        let refreshed;
        try { refreshed = await identity.getAccessToken({ forceRefresh: true, rejectedAccessToken: token }); }
        catch (error) {
          // The replacement error no longer owns the rejected response body.
          // Release it before returning so failed token refreshes cannot leave
          // catalogue connections waiting for an unread response to be drained.
          await discardResponse(response);
          return credentialFailure(error, init.signal);
        }
        if (typeof refreshed !== 'string' || !refreshed || refreshed === token) return userAuthorization(response);
        await discardResponse(response);
        response = await this.#send(url, init, state, refreshed);
      }
      if (response.status !== 429) return state.kind === 'user' && [401, 403].includes(response.status) ? userAuthorization(response) : response;
      shortestWait = Math.min(shortestWait, this.#wait(state) || MINUTE);
      await discardResponse(response);
    }
    return problem(429, 'RATE_LIMITED', (Number.isFinite(shortestWait) ? shortestWait : MINUTE) / 1000);
  }
}
