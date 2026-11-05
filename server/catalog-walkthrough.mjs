// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Read-only walkthrough contracts from NextMoe OpenAPI 2.83.0. This module
// validates graph identity, not a player's progress or any game's save format.
// Preserve additive fields and unknown step types for host-side safe rendering.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(value);
const text = (value, max = 2048) => typeof value === 'string' && value.length <= max;
const optionalText = (value, max) => value === null || text(value, max);
const count = value => Number.isSafeInteger(value) && value >= 0;
const localized = value => plain(value) && Object.keys(value).length <= 128 &&
  Object.entries(value).every(([language, entry]) => text(language, 32) && plain(entry) &&
    text(entry.value, 4096) && typeof entry.is_machine === 'boolean');
const arrays = (value, max = 50_000) => Array.isArray(value) && value.length <= max;
const links = (value, target) => arrays(value) && value.every(item => key(item) && target.has(item));
const group = (value, max = 50_000) => {
  if (!arrays(value, max) || value.some(item => !plain(item) || !key(item.key))) return null;
  const keys = new Set(value.map(item => item.key));
  return keys.size === value.length ? keys : null;
};

function metadata(value) {
  return plain(value) && value.object === 'walkthrough' && id(value.id) && id(value.work_id) &&
    ['sfw', 'nsfw'].includes(value.work_content_limit) && typeof value.work_route_hints === 'boolean' &&
    text(value.source, 64) && optionalText(value.source_url, 2048) && optionalText(value.source_author, 256) &&
    (value.source_updated_on === null || /^\d{4}-\d{2}-\d{2}$/.test(value.source_updated_on)) &&
    text(value.lang, 32) && text(value.updated_at, 32) && Number.isFinite(Date.parse(value.updated_at)) &&
    count(value.ending_count) && count(value.save_count) && count(value.segment_count) &&
    (value.release === null || (plain(value.release) && id(value.release.id) &&
      optionalText(value.release.title, 512) && optionalText(value.release.lang, 32) && text(value.release.release_kind, 64) &&
      arrays(value.release.companies, 1000) && value.release.companies.every(name => text(name, 512)))) &&
    !!group(value.characters, 10_000) && value.characters.every(character => text(character.name, 512) &&
      (character.character_id === null || id(character.character_id)) && optionalText(character.display_name, 512) && localized(character.localized));
}

function graph(value) {
  const chart = value.chart;
  if (!plain(chart)) return false;
  const characters = group(value.characters), sections = group(chart.sections), entries = group(chart.entries),
    saves = group(chart.saves), endings = group(chart.endings), segments = group(chart.segments);
  if (!characters || !sections || !entries || !saves || !endings || !segments || !arrays(chart.legend, 10_000)) return false;
  if (value.ending_count !== chart.endings.length || value.save_count !== chart.saves.length || value.segment_count !== chart.segments.length) return false;
  if (!chart.sections.every(row => text(row.title, 512) && localized(row.localized) && links(row.character_keys, characters)) ||
      !chart.legend.every(row => plain(row) && text(row.text, 1024) && localized(row.localized)) ||
      !chart.entries.every(row => text(row.label, 256) && localized(row.localized) &&
        (row.unlocked_by_ending_key === null || endings.has(row.unlocked_by_ending_key))) ||
      !chart.saves.every(row => text(row.label, 256) && localized(row.localized)) ||
      !chart.endings.every(row => text(row.name, 512) && localized(row.localized) &&
        text(row.ending_type, 64) && links(row.character_keys, characters))) return false;
  const node = row => {
    if (!plain(row) || !text(row.node_type, 64)) return false;
    const target = row.node_type === 'entry' ? entries : row.node_type === 'save' ? saves : row.node_type === 'ending' ? endings : null;
    return target ? target.has(row.key) : row.key === null;
  };
  let totalSteps = 0;
  for (const segment of chart.segments) {
    if (!(segment.section_key === null || sections.has(segment.section_key)) || !node(segment.from_node) || !node(segment.to_node) ||
        !optionalText(segment.condition, 1024) || !localized(segment.condition_localized) ||
        !links(segment.requires_ending_keys, endings) || !arrays(segment.steps) || (totalSteps += segment.steps.length) > 50_000) return false;
    for (const step of segment.steps) {
      if (!plain(step) || !text(step.step_type, 64) || !optionalText(step.text, 1024) || !localized(step.localized) ||
          !optionalText(step.remark, 1024) || !localized(step.remark_localized) || typeof step.achievement !== 'boolean' ||
          !arrays(step.alternatives, 1000) || !step.alternatives.every(row => plain(row) && text(row.text, 1024) && localized(row.localized)) ||
          !(step.step_type === 'save' ? saves.has(step.save_key) : step.save_key === null)) return false;
    }
  }
  return true;
}

export function isUsableWalkthrough(value, { detail = false, workId } = {}) {
  return metadata(value) && (workId === undefined || value.work_id === workId) && (!detail || graph(value));
}

export function isUsableWalkthroughPage(value, { workId, limit = 100, characterId } = {}) {
  if (!plain(value) || value.object !== 'list' || !arrays(value.items, limit) ||
      (value.next_cursor !== undefined && (typeof value.next_cursor !== 'string' ||
        !/^cur_[A-Za-z0-9._~-]{1,508}$/.test(value.next_cursor)))) return false;
  const ids = new Set();
  return value.items.every(row => {
    if (!isUsableWalkthrough(row, { workId }) || ids.has(row.id) ||
        (characterId !== undefined && !row.characters.some(character => character.character_id === characterId))) return false;
    ids.add(row.id);
    // Collections contain summaries. A graph belongs to the explicit detail
    // read and must not arrive unnoticed during ordinary list browsing.
    return row.chart === undefined;
  });
}
