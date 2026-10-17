// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shared by the browser demo and the live catalog adapter. The matcher only
// compares supplied names; it never invents aliases or joins entities by name.
const MAX_QUERY_LENGTH = 512;
const MAX_LABEL_LENGTH = 2048;
// Existing long-name direct searches remain valid; only typo comparison and
// upstream fallback expansion use the smaller work budget.
const MAX_FUZZY_QUERY_LENGTH = 64;
const MAX_FUZZY_LABEL_LENGTH = 160;
const MAX_LABELS = 64;
const TITLE_SEPARATOR = /[\p{Pd}:：|｜()\[\]{}（）［］｛｝「」『』【】〈〉《》]/u;

export function normalizeSearchText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ') : '';
}

function boundedText(value, maxLength) {
  // Reject excessive input before normalization as well as after it. Normalized
  // code points, rather than UTF-16 units, determine the meaningful limit.
  if (typeof value !== 'string' || value.length > maxLength * 4) return null;
  const text = normalizeSearchText(value);
  const points = Array.from(text);
  return points.length && points.length <= maxLength ? { text, points } : null;
}

// Decorative punctuation and spacing may differ between a player's full title
// and a supplied catalog spelling. Compare this key only for whole-name
// equivalence; symbols such as + and mathematical − remain meaningful.
function fullNameKey(text) {
  const key = text.replace(/[\p{P}\s]/gu, '');
  return (key.match(/[\p{L}\p{N}]/gu)?.length || 0) >= 3 ? key : '';
}

// Banded optimal-string-alignment distance: insertion, deletion, substitution,
// and one adjacent transposition all cost one. Three rows keep work bounded.
function boundedEditDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const overflow = limit + 1;
  let older = new Array(right.length + 1).fill(overflow);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => Math.min(index, overflow));
  for (let row = 1; row <= left.length; row++) {
    const current = new Array(right.length + 1).fill(overflow);
    current[0] = Math.min(row, overflow);
    for (let column = Math.max(1, row - limit); column <= Math.min(right.length, row + limit); column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        current[column] = Math.min(current[column], older[column - 2] + 1);
      }
    }
    older = previous;
    previous = current;
  }
  return previous[right.length];
}

function typoMatch(needle, label, matchedText) {
  if (!label || needle.points.length < 2 || needle.points.length > MAX_FUZZY_QUERY_LENGTH || label.points.length < 2 || label.points.length > MAX_FUZZY_LABEL_LENGTH || !/[\p{L}\p{N}]/u.test(needle.text) || !/[\p{L}\p{N}]/u.test(label.text)) return null;
  const limit = needle.points.length < 6 ? 1 : 2;
  const distance = boundedEditDistance(needle.points, label.points, limit);
  const similarity = 1 - distance / Math.max(needle.points.length, label.points.length);
  // Three-character CJK names need a one-character correction (2/3
  // similarity); longer queries have the stricter 0.7 similarity floor.
  // Two-character names can lose or mistype one character too. Keep these as
  // low-confidence typo suggestions, never as normalized/exact identities.
  const floor = needle.points.length === 2 && label.points.length === 2 ? 0.5 : needle.points.length < 6 ? 2 / 3 - Number.EPSILON : 0.7;
  return distance <= limit && similarity >= floor
    ? { kind: 'typo', matchedText, distance, score: 300 + 100 * similarity - 10 * distance }
    : null;
}

/** Return the strongest supplied label match, preserving its original spelling. */
export function matchSearchLabel(query, labels) {
  const needle = boundedText(query, MAX_QUERY_LENGTH);
  if (!needle) return null;
  const normalizedNeedle = fullNameKey(needle.text);
  const candidates = typeof labels === 'string' ? [labels] : Array.isArray(labels) ? labels.slice(0, MAX_LABELS) : [];
  let best = null;
  for (const matchedText of candidates) {
    const label = boundedText(matchedText, MAX_LABEL_LENGTH);
    if (!label) continue;
    let match = null;
    if (needle.text === label.text) {
      match = { kind: 'exact', matchedText, distance: 0, score: 1000 };
    } else if (normalizedNeedle && normalizedNeedle === fullNameKey(label.text)) {
      match = { kind: 'normalized', matchedText, distance: 0, score: 950 };
    } else if (label.text.startsWith(needle.text)) {
      match = { kind: 'prefix', matchedText, distance: 0, score: 800 + 100 * needle.points.length / label.points.length };
    } else if (label.text.includes(needle.text)) {
      match = { kind: 'substring', matchedText, distance: 0, score: 600 + 100 * needle.points.length / label.points.length };
    } else {
      match = typoMatch(needle, label, matchedText);
      // Catalog names sometimes contain only a full title with a subtitle.
      // Compare its explicitly separated leading title too; never slide a
      // short fuzzy query across arbitrary positions in a longer name.
      const title = matchedText.split(TITLE_SEPARATOR, 1)[0].trim();
      if (title !== matchedText.trim()) {
        const titleMatch = typoMatch(needle, boundedText(title, MAX_FUZZY_LABEL_LENGTH), title);
        if (titleMatch && (!match || titleMatch.score > match.score)) match = titleMatch;
      }
    }
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

/** Small, deterministic upstream recall probes; matching ranks their returned hits. */
export function searchFallbackQueries(query) {
  const needle = boundedText(query, MAX_FUZZY_QUERY_LENGTH);
  if (!needle || needle.points.length < 2) return [];
  // Small names have no surviving two-character fragment after a middle typo
  // (Koy -> Key) or one missing character. The caller caps each stream/page;
  // matching still compares the complete returned name and preserves its ID.
  if (/^[\p{L}\p{N}]{2}$/u.test(needle.text) || /^\p{Script=Latin}{3}$/u.test(needle.text)) {
    return [...new Set([needle.points[0], needle.points.at(-1)])];
  }
  // Three-Han-character names have no two-character fragment left intact when
  // the middle character is wrong. The catalog caller may try this final-Han
  // probe alongside the two-character prefix. The caller bounds each page and
  // provides continuation; full-name matching still permits only one edit.
  // Longer names retain their selective original fragments.
  if (/^\p{Script=Han}{3}$/u.test(needle.text)) return [needle.points.slice(0, 2).join(''), needle.points[2]];
  const length = needle.points.length;
  const suffixLength = Math.max(2, Math.min(6, Math.floor(length / 3)));
  // A longer Latin prefix can cross an untyped word boundary ("Frontwign"
  // versus "Front Wing"). Use a shorter continuous prefix for Latin-only
  // names, keeping the original full-name matcher and the two-probe budget.
  const prefixLimit = /^\p{Script=Latin}+$/u.test(needle.text) ? 5 : 8;
  const prefixLength = Math.max(2, Math.min(prefixLimit, length - suffixLength));
  // Only three-character queries overlap. Except for the controlled Han case
  // above, both fragments must retain at least two letters/numbers.
  const fragments = [needle.points.slice(0, prefixLength).join('').trim(), needle.points.slice(-suffixLength).join('').trim()];
  return [...new Set(fragments)].filter(fragment => fragment !== needle.text && (fragment.match(/[\p{L}\p{N}]/gu)?.length || 0) >= 2);
}

/** Extra recall for an adjacent swap crossing the two primary fragments. */
export function searchRecoveryQueries(query) {
  const needle = boundedText(query, MAX_FUZZY_QUERY_LENGTH);
  const fragments = searchFallbackQueries(query);
  if (!needle || fragments.length !== 2) return [];
  const [first, last] = fragments.map(value => Array.from(value));
  // A one-character probe or a gap between fragments already survives a swap.
  if (first.length < 2 || last.length < 2 || first.length + last.length < needle.points.length) return [];
  const recovery = first.slice(0, -1).join('');
  return /^[\p{L}\p{N}]+$/u.test(recovery) && !fragments.includes(recovery) ? [recovery] : [];
}
