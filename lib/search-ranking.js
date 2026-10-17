// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { matchSearchLabel } from './search-match.js';
import { canonicalCreatorEntity, creatorIdentityResolver, creatorNames, mergeCreatorFacts } from './creator-identity.js';

const TYPES = new Set(['work', 'creator', 'company']);
const TIER = { exact: 0, normalized: 1, prefix: 2, substring: 3, upstream: 4, typo: 5, related: 6 };
const BASE_SCORE = { exact: 1000, normalized: 950, prefix: 800, substring: 600, upstream: 500, typo: 300, related: 100 };
const NAME_QUALITY = { human: 2, unknown: 1, machine: 0 };
const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validDistance = value => Number.isSafeInteger(value) && value >= 0;

function evidence(item, query) {
  const supplied = item.match && Object.hasOwn(TIER, item.match.kind) && item.match.kind !== 'upstream' ? item.match : null;
  let inferred = null;
  // Duplicate records can contribute more than one response's spelling list.
  // Compare each real name within the matcher's per-name bounds so a late
  // exact alias is not hidden by its general-purpose list-size cutoff.
  for (const name of new Set([item.label, ...(Array.isArray(item.aliases) ? item.aliases : [])])) {
    const candidate = matchSearchLabel(query, [name]);
    if (candidate && (!inferred || candidate.score > inferred.score)) inferred = candidate;
  }
  // The catalog can match spellings omitted from its visible aliases. Retain
  // that evidence, but an exact visible alias must never rank below a typo.
  const match = inferred && (!supplied || TIER[inferred.kind] < TIER[supplied.kind]) ? inferred : supplied;
  const kind = match?.kind || 'upstream';
  const sameKind = inferred?.kind === kind ? inferred : null;
  return {
    tier: TIER[kind],
    score: validScore(match?.score) ? match.score : sameKind?.score ?? BASE_SCORE[kind],
    distance: validDistance(match?.distance) ? match.distance : sameKind?.distance ?? (kind === 'typo' ? Infinity : 0),
    // Only an explicit flag on the actual matched spelling refines a typo tie.
    quality: kind === 'typo' ? NAME_QUALITY[match?.nameQuality] ?? NAME_QUALITY.unknown : 0,
  };
}

function compareEvidence(left, right) {
  return left.tier - right.tier || right.score - left.score ||
    (left.distance < right.distance ? -1 : left.distance > right.distance ? 1 : 0) ||
    right.quality - left.quality;
}

const compare = (left, right) => compareEvidence(left, right) || left.index - right.index;

/**
 * Rank supplied candidates by deterministic name-match evidence, not a
 * probability. This only orders the supplied set: callers must retain partial
 * response warnings, and must not claim the first item wins over unseen hits.
 * No requests, type quotas, identity merging by name, or input mutation occur.
 */
export function rankSearchCandidates(items, query) {
  if (!Array.isArray(items)) return [];
  const identities = creatorIdentityResolver(items.filter(item => item?.type === 'creator'));
  const unique = new Map();
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !TYPES.has(item.type) ||
        typeof item.id !== 'string' || !item.id.trim() || typeof item.label !== 'string' || !item.label.trim()) return;
    const candidate = { item, index, ...evidence(item, query) };
    const key = JSON.stringify([item.type, item.type === 'creator' ? identities.key(item) : item.id]);
    if (!unique.has(key)) unique.set(key, []);
    unique.get(key).push(candidate);
  });
  const merged = [...unique.values()].map(records => {
    const identity = records[0].item.type === 'creator' ? identities.identity(records[0].item) : null;
    if (records.length === 1 && !identity) return records[0];
    const aliases = [...new Set(records.flatMap(({ item }) => identity ? creatorNames({ ...item, creatorIdentity: identity }) : Array.isArray(item.aliases) ? item.aliases : []))]
      .filter(value => typeof value === 'string' && value.trim());
    let best = null;
    for (const original of records) {
      const existing = Array.isArray(original.item.aliases) ? original.item.aliases : [];
      let item = aliases.some(alias => !existing.includes(alias)) ? { ...original.item, aliases } : original.item;
      if (identity) item = canonicalCreatorEntity(item, identity);
      const candidate = { item, index: original.index, original, ...evidence(item, query) };
      // Re-evaluate after unioning names, then keep the record that originally
      // supplied the strongest evidence and its metadata when merged scores tie.
      if (!best || (compareEvidence(candidate, best) || compareEvidence(original, best.original) || original.index - best.index) < 0) best = candidate;
    }
    if (identity) {
      // Facts already aggregate distinct works on the server. Never sum counts
      // from several aliases, which may describe overlapping credits.
      const facts = mergeCreatorFacts(records.map(record => record.item.creatorFacts));
      if (facts) best.item = { ...best.item, creatorFacts: facts };
    }
    return best;
  });
  return merged.sort(compare).map(candidate => candidate.item);
}
