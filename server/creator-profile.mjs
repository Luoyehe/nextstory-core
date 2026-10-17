// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { roleAspect, isUsableNameCreditRecord } from './catalog-normalize.mjs';
/** Optional biography facts for the selected credited name, never an inferred person.
 * aliases are alternate spellings of this name. Other names of the linked
 * person are intentionally not merged into this profile or its discovery seed.
 */
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';

function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function languageRank(language) {
  const value = language.toLowerCase();
  if (/^zh-(hans|cn|sg)(-|$)/.test(value) || value === 'zh') return 0;
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(value)) return 1;
  if (/^en(-|$)/.test(value)) return 2;
  if (/^ja(-|$)/.test(value)) return 3;
  return 4;
}

export function normalizeCreatorProfile(raw, { nsfw = false } = {}) {
  if (typeof nsfw !== 'boolean') throw new TypeError('The NSFW setting must be a boolean.');
  const aliases = [];
  const knownAliases = new Map();
  for (const alias of array(raw?.aliases)) {
    const value = text(alias?.value);
    if (!value || !['translation', 'spelling_variant'].includes(alias?.alias_kind)) continue;
    const normalized = { value, language: text(alias.lang) || null, isMachine: alias.is_machine === true };
    const key = `${normalized.language}\u0000${value}`;
    const existing = knownAliases.get(key);
    if (existing !== undefined) {
      // Preserve the human-authored fact when the exact same spelling occurs twice.
      if (aliases[existing].isMachine && !normalized.isMachine) aliases[existing] = normalized;
      continue;
    }
    knownAliases.set(key, aliases.length);
    aliases.push(normalized);
  }

  const intros = array(raw?.intros).filter(item => text(item?.value)).map(item => ({
    text: text(item.value), language: text(item.lang) || null,
    isMachine: item.is_machine === true, source: text(item.source) || null,
  }));
  const preferred = intros.filter(item => languageRank(item.language ?? '') < 4);
  // For unpreferred languages keep the first available language, then prefer
  // a human-authored entry of that language. Do not invent a translation.
  const candidates = preferred.length ? preferred : intros.filter(item => item.language === intros[0]?.language);
  const intro = candidates.sort((a, b) => languageRank(a.language ?? '') - languageRank(b.language ?? '') ||
    Number(a.isMachine) - Number(b.isMachine))[0] ?? null;

  const links = [];
  const knownLinks = new Set();
  for (const link of array(raw?.links)) {
    const url = httpUrl(link?.url);
    if (!url || knownLinks.has(url)) continue;
    knownLinks.add(url);
    links.push({ name: text(link.source) || '原始资料页面', url });
  }
  // The card only shows explicitly safe photos, including when adult works
  // are enabled. An absent assessment is not evidence that a photo is safe.
  const photoUrl = raw?.photo?.sexual === 'safe' ? httpUrl(raw.photo.url) : null;
  return { aliases, intro, links, photoUrl };
}

/** Observed Galgame responsibilities, never a guess from browser visit history.
 * Multiple characters and duplicate rows count as one work per responsibility.
 * A bounded page is explicitly partial; unknown duties remain displayable.
 */
export function creatorFactsFromPages(pages, { nsfw = false, complete: coverageComplete = true } = {}) {
  const roles = new Map(), works = new Set();
  let complete = pages.length > 0 && coverageComplete;
  for (const page of pages) {
    if (!Array.isArray(page?.items)) { complete = false; continue; }
    if (page.next_cursor) complete = false;
    for (const row of page.items.slice(0, 100)) {
      if (!isUsableNameCreditRecord(row)) { complete = false; continue; }
      if (row.work.medium !== 'galgame' || (!nsfw && row.work.content_rating === 'r18')) continue;
      works.add(row.work.id);
      for (const role of row.roles) {
        const key = role.role_key;
        if (!roles.has(key)) roles.set(key, { key, label: key === 'voice-actor' ? '配音（CV）' : text(role.role_name) || key,
          aspect: roleAspect(key), works: new Set() });
        roles.get(key).works.add(row.work.id);
      }
    }
    if (page.items.length > 100) complete = false;
  }
  const priority = ['scenario', 'art', 'music', 'voice'];
  const responsibilities = [...roles.values()].map(({ works, ...role }) => ({ ...role, count: works.size }))
    .sort((a, b) => b.count - a.count || (priority.indexOf(a.aspect) < 0 ? 99 : priority.indexOf(a.aspect)) -
      (priority.indexOf(b.aspect) < 0 ? 99 : priority.indexOf(b.aspect)) || a.key.localeCompare(b.key));
  return { responsibilities, primaryAspect: responsibilities.find(role => role.aspect)?.aspect ?? null,
    complete, workCount: works.size };
}
