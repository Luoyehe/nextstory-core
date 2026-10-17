// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Canonical discovery starts shared by routes, drafts and the server boundary. */
import { canonicalCreatorEntity, creatorIdentityKey, creatorIdentityOf, creatorIdentityResolver } from './creator-identity.js';
export const MAX_EXPLORATION_SEEDS = 8;
const TYPES = new Set(['work', 'creator', 'company']);

export function explorationSeedKey(seed) {
  return JSON.stringify([seed?.type, seed?.type === 'creator' ? creatorIdentityKey(seed) : seed?.id]);
}

export function normalizeExplorationSeeds(input, { max = MAX_EXPLORATION_SEEDS } = {}) {
  if (!Array.isArray(input)) throw new Error('请选择有效的探索起点。');
  const seen = new Set();
  const result = [];
  const identities = creatorIdentityResolver(input.filter(seed => seed?.type === 'creator'));
  for (let seed of input) {
    if (!seed || !TYPES.has(seed.type) || typeof seed.id !== 'string' || !seed.id.trim()
      || seed.id.length > 160 || /[\u0000-\u001f\u007f]/.test(seed.id)) {
      throw new Error('探索起点无效，请重新选择。');
    }
    if (seed.label !== undefined && (typeof seed.label !== 'string' || [...seed.label].length > 1024)) {
      throw new Error('探索起点名称无效，请重新选择。');
    }
    seed = seed.type === 'creator' ? canonicalCreatorEntity(seed, identities.identity(seed)) : seed;
    const key = explorationSeedKey(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type: seed.type, id: seed.id, ...(seed.label !== undefined ? { label: seed.label } : {}),
      ...(seed.profile && typeof seed.profile === 'object' ? { profile: seed.profile } : {}),
      ...(creatorIdentityOf(seed) ? { creatorIdentity: creatorIdentityOf(seed) } : {}),
      ...(seed.creatorFacts && typeof seed.creatorFacts === 'object' ? { creatorFacts: seed.creatorFacts } : {}) });
    if (result.length > max) throw new Error(`一次最多可添加 ${max} 个探索起点。`);
  }
  return result;
}

export function readExplorationSeeds(params) {
  if (['seed', 'type', 'seeds'].some(key => params.getAll(key).length > 1)) {
    throw new Error('探索链接包含重复的起点参数。');
  }
  if (params.has('seeds')) {
    if (params.has('seed') || params.has('type')) throw new Error('探索链接包含重复的起点参数。');
    let seeds;
    try { seeds = JSON.parse(params.get('seeds')); }
    catch { throw new Error('探索链接中的起点信息无效，请重新选择。'); }
    // Shared URLs carry identifiers only. They cannot assert person links or
    // bypass the catalogue's identity resolution with supplied metadata.
    return normalizeExplorationSeeds(Array.isArray(seeds) ? seeds.map(seed => seed && { type: seed.type, id: seed.id }) : seeds);
  }
  if (!params.has('seed')) {
    if (params.has('type')) throw new Error('探索链接缺少起点，请重新选择。');
    return [];
  }
  return normalizeExplorationSeeds([{ type: params.get('type') || 'work', id: params.get('seed') }]);
}

/** Mutates and returns the given URLSearchParams; labels never enter share URLs. */
export function writeExplorationSeeds(params, input) {
  const seeds = normalizeExplorationSeeds(input);
  for (const key of ['seed', 'type', 'seeds']) params.delete(key);
  if (seeds.length === 1) {
    params.set('seed', seeds[0].id);
    params.set('type', seeds[0].type);
  } else if (seeds.length > 1) {
    params.set('seeds', JSON.stringify(seeds.map(({ type, id }) => ({ type, id }))));
  }
  return params;
}

export function explorationSeedsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((seed, index) => explorationSeedKey(seed) === explorationSeedKey(right[index]));
}
