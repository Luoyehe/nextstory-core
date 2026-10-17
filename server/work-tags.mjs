// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Small, reviewed display vocabulary, not a recommendation or search filter.
 * IDs checked against NextMoe's tag vocabulary / work attachments, 2026-10-13.
 * Never classify by display-name substrings: names, aliases and sources are open
 * vocabularies. Unknown tags remain absent until their meaning is reviewed.
 */
const RULES = [
  // Group aliases and narrower variants; prefer the first matching rule.
  ['mystery', 'genre', '悬疑', ['88']],
  ['scifi', 'genre', '科幻', ['139']],
  ['fantasy', 'genre', '奇幻', ['55']],
  ['horror', 'genre', '恐怖', ['85']],
  ['thriller', 'genre', '惊悚', ['89']],
  ['strategy', 'genre', 'SLG', ['8'], 'meta'],
  ['raising', 'genre', '养成', ['33']],
  ['romance', 'genre', '纯爱', ['142', '1390']],
  ['romance', 'genre', '恋爱', ['84', '642']],
  ['school', 'setting', '校园', ['1585', '1021', '1242']],
  ['world', 'setting', '架空世界', ['112']],
  ['family', 'theme', '亲情', ['6172']],
  ['family', 'theme', '家庭', ['585', '1080', '7041']],
  ['friendship', 'theme', '友情', ['43']],
  ['growth', 'theme', '成长', ['1158']],
  ['daily', 'theme', '日常', ['619', '1323']],
  ['cohabitation', 'theme', '同居', ['47']],
  ['military', 'theme', '军事', ['36']],
  ['mecha', 'theme', '机甲', ['111']],
  ['magic', 'theme', '魔法', ['169']],
  ['sports', 'theme', '体育', ['537']],
  ['nakige', 'tone', '泣系', ['6296']],
  ['healing', 'tone', '治愈', ['118']],
  ['comedy', 'tone', '喜剧', ['50', '102', '1242', '1323', '7041']],
];

/** Return at most four stable labels, with no minimum or guessed fallback.
 * spoiler=none is an upstream tag rating, not a guarantee for unrated sources.
 * Our additional vocabulary excludes plot events, endings, character traits,
 * erotic labels, staff, platforms and generic medium/technical tags.
 */
export function selectWorkTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  const rows = rawTags.filter(tag => tag && typeof tag.id === 'string');
  const unsafe = new Set(rows.filter(tag => tag.spoiler === 'minor' || tag.spoiler === 'major' || tag.is_sexual === true).map(tag => tag.id));
  const blockedGroups = new Set(RULES.filter(([, , , ids]) => ids.some(id => unsafe.has(id))).map(([group]) => group));
  const candidates = new Map();
  for (const [group, facet, label, ids, kind = 'content'] of RULES) {
    if (blockedGroups.has(group) || candidates.has(group)) continue;
    const match = rows.some(tag => ids.includes(tag.id) && tag.spoiler === 'none' && tag.is_sexual === false &&
      tag.tag_kind === kind && ['core', 'longtail'].includes(tag.tier));
    if (match) candidates.set(group, { facet, label });
  }
  const selected = new Set();
  // Avoid filling a card with four near-identical genres or moods when the
  // upstream also supplies useful setting and theme information.
  for (const facet of ['genre', 'setting', 'theme', 'tone']) {
    const match = [...candidates.values()].find(tag => tag.facet === facet);
    if (match) selected.add(match.label);
  }
  for (const tag of candidates.values()) {
    if (selected.size === 4) break;
    selected.add(tag.label);
  }
  return [...selected];
}
