// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Normalize NextMoe catalogue facts without inferring identity or availability.
 * Checked against OpenAPI 2.38.1 and live work/role responses on 2026-10-09.
 * Pure module: no credentials, network requests or browser storage.
 */

import { selectWorkTags } from './work-tags.mjs';

const ID = /^[0-9]{1,20}$/;
const PREFIXES = { work: 'nm:', creator: 'credit:nm:', credit_name: 'credit:nm:', company: 'company:nm:', series: 'series:nm:', release: 'release:nm:' };
const ASPECT_BY_ROLE = new Map([
  ['scenario', 'scenario'], ['剧本', 'scenario'],
  ['原画', 'art'], ['illustration', 'art'], ['character-design', 'art'],
  ['music', 'music'], ['音乐', 'music'], ['composer', 'music'], ['作曲', 'music'], ['composer-2', 'music'],
  ['voice-actor', 'voice'],
]);
const PLATFORMS = {
  win: 'Windows', windows: 'Windows', mac: 'macOS', lnx: 'Linux', linux: 'Linux',
  swi: 'Switch', switch: 'Switch', and: 'Android', android: 'Android', ios: 'iOS',
  ps2: 'PlayStation 2', ps3: 'PlayStation 3', ps4: 'PlayStation 4', ps5: 'PlayStation 5',
  psp: 'PSP', psv: 'PS Vita', xb3: 'Xbox 360', xbo: 'Xbox One', xbs: 'Xbox Series',
  web: '浏览器', bps: '浏览器', nds: 'Nintendo DS', n3d: 'Nintendo 3DS',
};
const PLACEHOLDER = '/assets/cover-placeholder.svg';
const DEFAULT_SUMMARY = '查看制作人员与已收录发行版本，沿着关系继续探索。';
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const validId = value => typeof value === 'string' && ID.test(value);
const unique = values => [...new Set(values.filter(Boolean))];
const prefixedId = (id, type) => validId(id) && Object.hasOwn(PREFIXES, type) ? `${PREFIXES[type]}${id}` : null;

function validateNsfw(nsfw) {
  if (typeof nsfw !== 'boolean') throw new TypeError('The NSFW setting must be a boolean.');
}

/** Unknown roles stay unknown; role-name substrings are never evidence. */
export function roleAspect(roleKey) {
  return ASPECT_BY_ROLE.get(roleKey) ?? null;
}

/** Decode only the requested entity namespace. Demo IDs never reach the API. */
export function rawId(id, type) {
  const prefix = Object.hasOwn(PREFIXES, type) ? PREFIXES[type] : null;
  if (!prefix || typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const value = id.slice(prefix.length);
  return ID.test(value) ? value : null;
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function localizedName(raw) {
  for (const lang of ['zh-Hans', 'en', 'ja']) {
    const localized = raw?.localized?.[lang];
    const value = text(localized?.value);
    if (value) return { value, language: lang, isMachine: localized.is_machine === true };
  }
  const value = text(raw?.display_name) || text(raw?.latin);
  if (value) return { value, language: null, isMachine: false };
  // Localized names use an open BCP-47 language map. A known title remains
  // usable even when none of our preferred display languages is recorded.
  for (const [language, localized] of Object.entries(raw?.localized ?? {})) {
    const value = text(localized?.value);
    if (value) return { value, language, isMachine: localized.is_machine === true };
  }
  return { value: '', language: null, isMachine: false };
}

function workNameAliases(raw) {
  return unique([text(raw.display_name), text(raw.latin),
    ...Object.values(raw.localized ?? {}).map(value => text(value?.value)),
    ...array(raw.aliases).map(alias => text(alias?.value)),
    ...array(raw.titles).flatMap(item => [text(item?.title), text(item?.latin)])]);
}

// Use the same identifying-name rules for every work. Keep English and the
// original-language name ahead of other spellings, deduplicating before the
// display limit so case/width variants cannot crowd out a useful second name.
function alternateWorkNames(raw, mainName) {
  const key = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
  const languageNames = language => [raw.localized?.[language], ...array(raw.titles)
    .filter(name => language && name?.lang === language)
    .sort((a,b) => ({official:0,alias:1,abbreviation:2}[a.title_kind] ?? 3) - ({official:0,alias:1,abbreviation:2}[b.title_kind] ?? 3))
    .map(name => ({ value: name.title, is_machine: name.is_machine }))];
  const seen = new Set([key(mainName)]), selected = [];
  const add = name => {
    const value = text(name?.value), identity = key(value);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    selected.push(visibleName({ value, isMachine: name.is_machine === true }));
    return true;
  };
  // Choose one name per language before using other spellings. A repeated
  // elected title must not hide a distinct title already in the same response.
  [ ...languageNames('en'), { value: raw.latin } ].some(add);
  [ ...languageNames(raw.olang), { value: raw.display_name } ].some(add);
  for (const name of [{ value: raw.display_name }, { value: raw.latin }, raw.localized?.ja]) {
    if (selected.length === 2) break;
    add(name);
  }
  return selected;
}

// Collection rows can be partially broken even when the list envelope is
// valid. Keep usable localized/Latin titles, but do not confuse malformed
// records with works intentionally omitted by a content filter.
export function hasCatalogName(raw) {
  return Boolean(localizedName(raw).value);
}

export function isUsableWorkRecord(raw) {
  return raw?.object === 'work' && validId(raw.id) && Boolean(text(raw.medium)) &&
    hasCatalogName(raw);
}

/** Requested relationship sections distinguish known emptiness from missing facts.
 * Unknown responsibilities are valid; malformed containers must remain retryable.
 */
export function hasWorkRelationships(raw) {
  return hasWorkCompanies(raw) && hasWorkCredits(raw);
}

export function hasWorkCompanies(raw) {
  return Array.isArray(raw?.companies) && raw.companies.every(company => validId(company?.id) &&
    hasCatalogName(company) && Boolean(text(company.attribution_role)));
}

export function hasWorkSeries(raw) {
  return Array.isArray(raw?.series) && raw.series.every(series => validId(series?.id) && hasCatalogName(series));
}

/** A known empty credit list is complete; malformed/missing names stay retryable. */
export function hasWorkCredits(raw) {
  return Array.isArray(raw?.credits) && raw.credits.every(group => group && typeof group === 'object' &&
    Boolean(text(group.role_key)) && Array.isArray(group.credits) &&
    group.credits.every(value => validId(value?.id) && hasCatalogName(value)));
}

// Unknown but well-formed responsibilities remain valid catalogue data.
// A malformed responsibility is missing evidence, not proof of no relation.
export function isUsableNameCreditRecord(raw) {
  return isUsableWorkRecord(raw?.work) && Array.isArray(raw?.roles) &&
    raw.roles.every(role => role && typeof role === 'object' && !Array.isArray(role) && Boolean(text(role.role_key)));
}

/** Search rows need a usable identity/name even when hidden by NSFW scope. */
export function isUsableSearchRecord(raw) {
  return ['work', 'credit_name', 'company'].includes(raw?.target_object) && validId(raw?.id) && hasCatalogName(raw);
}

function visibleName(name) {
  return `${name.value}${name.isMachine ? '（机器译名）' : ''}`;
}

function sourceFromRef(ref) {
  const id = text(ref?.external_id);
  if (ref?.source === 'vndb' && /^[vr][0-9]+$/.test(id)) {
    return { name: id.startsWith('r') ? 'VNDB · 发行版本' : 'VNDB · 作品资料', url: `https://vndb.org/${id}` };
  }
  if ((ref?.source === 'bangumi' || ref?.source === 'bgm') && /^[0-9]+$/.test(id)) {
    return { name: 'Bangumi · 作品资料', url: `https://bgm.tv/subject/${id}` };
  }
  if (ref?.source === 'steam' && /^[0-9]+$/.test(id)) {
    return { name: 'Steam · 商店页面', url: `https://store.steampowered.com/app/${id}/` };
  }
  return null;
}

function sourcesOf(raw) {
  const sources = array(raw?.refs).map(sourceFromRef).filter(Boolean);
  for (const link of array(raw?.links)) {
    const url = safeUrl(link?.url);
    if (url) sources.push({ name: text(link.source) || '原始资料页面', url });
  }
  const seen = new Set();
  return sources.filter(source => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function normalizeRelease(raw) {
  const id = prefixedId(raw?.id, 'release');
  if (!id) return null;
  const language = text(raw.lang);
  const codes = array(raw.platforms).length ? raw.platforms : [raw.platform];
  const sources = sourcesOf(raw);
  return {
    id, title: text(raw.title) || '名称未收录的发行版本',
    kind: text(raw.release_kind) || null,
    date: text(raw.date) || null,
    languages: language ? [language] : [],
    platforms: unique(codes.map(code => text(code)).map(code => Object.hasOwn(PLATFORMS, code) ? PLATFORMS[code] : code)),
    sourceUrl: sources[0]?.url ?? null,
    sources,
  };
}

function fieldCoverage(raw, key) {
  return !Array.isArray(raw[key]) ? 'missing' : raw[key].length ? 'available' : 'empty';
}

/** Read recorded date precision without turning an unknown month/day into a fact. */
function dateFacts(value, precision) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (year < 1800 || year > 2200 || (month !== null && (month < 1 || month > 12)) ||
      (day !== null && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()))) return null;
  const actualPrecision = day !== null ? 'day' : month !== null ? 'month' : 'year';
  const levels = { year: 0, month: 1, day: 2 };
  const recordedPrecision = Object.hasOwn(levels, precision) && levels[precision] < levels[actualPrecision] ? precision : actualPrecision;
  return { year, date: value, precision: recordedPrecision };
}

function sameRecordedDate(a, b) {
  const lengths = { year: 4, month: 7, day: 10 };
  // A coarser release date cannot establish the origin of a more precise catalog date.
  return a && b && lengths[b.precision] >= lengths[a.precision] &&
    a.date.slice(0, lengths[a.precision]) === b.date.slice(0, lengths[a.precision]);
}

/**
 * Distinguish the catalogue date from the earliest recorded non-trial edition.
 * An incomplete release inventory must not turn a later translation/reissue into
 * an invented first-release year. Retain an earlier catalogue year unless its
 * recorded date coincides with an explicitly classified trial or patch.
 */
function workYearFacts(raw, releases) {
  const catalog = dateFacts(raw.release_date, raw.release_date_precision);
  const eligible = releases.filter(release => ['default', 'digital', 'physical'].includes(release.kind))
    .map(release => ({ release, date: dateFacts(release.date) })).filter(item => item.date)
    .sort((a, b) => a.date.year - b.date.year || a.date.date.localeCompare(b.date.date) || a.release.id.localeCompare(b.release.id));
  const first = eligible[0];
  const releaseEvidence = first ? {
    year: first.date.year, date: first.date.date, precision: first.date.precision,
    releaseId: first.release.id, releaseKind: first.release.kind, sourceUrl: first.release.sourceUrl,
  } : null;
  const excludedCatalogDate = catalog && releases.some(release => ['trial', 'patch'].includes(release.kind) && sameRecordedDate(catalog, dateFacts(release.date)));
  const useRelease = first && (!catalog || first.date.year <= catalog.year || excludedCatalogDate);
  const year = useRelease ? first.date.year : catalog?.year ?? null;
  const yearEvidence = useRelease ? { basis: 'release', ...releaseEvidence }
    : catalog ? { basis: 'catalog', ...catalog }
      : { basis: 'unknown', year: null, date: null, precision: null };
  return {
    year, catalogYear: catalog?.year ?? null, catalogDate: catalog?.date ?? null,
    catalogDatePrecision: catalog?.precision ?? null,
    releaseYear: releaseEvidence?.year ?? null, releaseYearEvidence: releaseEvidence,
    yearEvidence, rankingYear: year, rankingYearEvidence: { ...yearEvidence },
  };
}

/** Normalize a full work response. Search hits cannot establish its medium. */
export function normalizeWork(raw, { nsfw = false } = {}) {
  validateNsfw(nsfw);
  if (!isUsableWorkRecord(raw) || raw.medium !== 'galgame' || (!nsfw && raw.content_rating === 'r18')) return null;
  const name = localizedName(raw);
  if (!name.value) return null;
  const sources = sourcesOf(raw);
  const workSource = sources.find(source => /^https:\/\/vndb.org\/v[0-9]+$/.test(source.url)) || sources[0];
  const warnings = [];
  const coverage = Object.fromEntries(['credits', 'releases', 'series', 'companies', 'refs'].map(key => [key, fieldCoverage(raw, key)]));
  if (!hasWorkCredits(raw)) coverage.credits = 'missing';
  if (!hasWorkCompanies(raw)) coverage.companies = 'missing';
  if (!hasWorkSeries(raw)) coverage.series = 'missing';
  const sectionLabels = { credits: '署名', releases: '发行版本', series: '系列', companies: '会社', refs: '来源索引' };
  for (const [key, state] of Object.entries(coverage)) {
    if (state === 'missing') warnings.push(`当前响应未包含${sectionLabels[key]}资料，不能据此判断不存在。`);
  }
  if (name.isMachine) warnings.push('当前显示名称为机器译名。');

  // Character names belong to this work's roster, not the credited-name row.
  // Join only an explicit character_id and only non-spoiler roster entries;
  // missing names never become visible internal IDs or extra network reads.
  const charactersById = new Map();
  for (const character of array(raw.characters)) {
    if (!validId(character?.id) || character.spoiler !== 'none') continue;
    const characterName = localizedName(character);
    if (!characterName.value || charactersById.has(character.id)) continue;
    charactersById.set(character.id, { id: `character:nm:${character.id}`, name: visibleName(characterName) });
  }
  const credits = [], participationCredits = [];
  const seenCredits = new Map();
  const unmappedRoles = new Set();
  for (const group of array(raw.credits)) {
    const role = roleAspect(group?.role_key);
    const roleKey = text(group?.role_key);
    if (!roleKey) continue;
    if (!role && array(group?.credits).length) unmappedRoles.add(roleKey);
    for (const entry of array(group?.credits)) {
      const id = prefixedId(entry?.id, 'creator');
      const creditName = localizedName(entry);
      const identity = `${id}\u0000${roleKey}`;
      if (!id || !creditName.value) continue;
      let credit = seenCredits.get(identity);
      if (!credit) {
        credit = {
          id, name: visibleName(creditName), nameIsMachine: creditName.isMachine,
          ...(validId(entry.person_id) ? { personId: `person:nm:${entry.person_id}` } : {}),
          role, roleKey, roleLabel: text(group.role_name) || roleKey,
          sourceUrl: sourcesOf(entry)[0]?.url ?? workSource?.url ?? null,
          ...(role === 'voice' && Array.isArray(raw.characters) ? { characters: [] } : {}),
        };
        seenCredits.set(identity, credit);
        // Preserve every recorded duty for presentation while retaining the
        // exact existing role allowlist and single-credit scoring semantics.
        participationCredits.push(credit);
        if (role) credits.push(credit);
      }
      const character = role === 'voice' ? charactersById.get(entry.character_id) : null;
      if (character && !array(credit.characters).some(item => item.id === character.id)) {
        (credit.characters ||= []).push({ ...character });
      }
    }
  }
  if (unmappedRoles.size) warnings.push('部分署名职责尚未映射到剧本、画风、音乐或配音，因此没有用于这些关联推荐。');

  const companies = [];
  const seenCompanies = new Set();
  for (const role of ['developer', 'brand', 'circle']) {
    for (const entry of array(raw.companies)) {
      const id = prefixedId(entry?.id, 'company');
      const companyName = localizedName(entry);
      if (entry?.attribution_role !== role || !id || !companyName.value || seenCompanies.has(id)) continue;
      seenCompanies.add(id);
      companies.push({ id, name: visibleName(companyName), attributionRole: role, sourceUrl: workSource?.url ?? null });
    }
  }
  // Keep the primary display field compatible, but never discard additional
  // developers, brands or circles when establishing catalogue relationships.
  const company = companies[0] ?? null;
  if (!company) warnings.push('未收录可明确归属的制作方；发行商不会代替制作方参与关联。');

  const series = array(raw.series).filter(item => validId(item?.id) && localizedName(item).value).map(item => ({
    id: prefixedId(item.id, 'series'), name: visibleName(localizedName(item)),
    // A work page is a reference, not a fabricated public NextMoe series URL.
    sourceUrl: sourcesOf(item)[0]?.url ?? workSource?.url ?? null,
  }));
  const releases = array(raw.releases).map(normalizeRelease).filter(Boolean);
  // Non-patch catalogue records; `default` does not certify a complete translation.
  const standardReleases = releases.filter(release => ['default', 'digital', 'physical'].includes(release.kind));
  if (releases.some(release => !release.languages.length || !release.platforms.length)) {
    warnings.push('部分发行版本的语言或平台未收录；未知信息不会满足筛选条件。');
  }
  if (releases.some(release => ['patch', 'trial'].includes(release.kind))) {
    warnings.push('发行记录包含补丁或试玩版；这类记录不代表可独立游玩的完整版本。');
  }
  const image = [raw.banner, raw.cover].find(candidate => candidate?.sexual === 'safe' && safeUrl(candidate.url));
  if (!image) warnings.push('封面未明确标为安全或未收录，暂用占位图。');
  const original = raw.localized?.[raw.olang];
  const originalTitle = text(original?.value) ? visibleName({ value: text(original.value), isMachine: original.is_machine === true }) : text(raw.display_name);
  const years = workYearFacts(raw, releases);
  return {
    id: prefixedId(raw.id, 'work'), title: visibleName(name), titleIsMachine: name.isMachine, titleLanguage: name.language,
    originalTitle, alternateTitles: alternateWorkNames(raw, name.value), aliases: workNameAliases(raw),
    // Keep machine labels in display-only aliases without altering searchable
    // aliases or treating an alias as a verified edition/original title.
    otherTitles: array(raw.titles).map(item => text(item?.title) ? visibleName({ value: text(item.title), isMachine: item.is_machine === true }) : '').filter(Boolean),
    ...years, company, companies, summary: DEFAULT_SUMMARY, cover: image ? safeUrl(image.url) : PLACEHOLDER,
    coverSource: image?.source || null, color: '#8b93a7',
    // Badges describe full releases only; a patch/trial cannot promise a playable
    // edition. Filtering must still use one release's facts together.
    languages: unique(standardReleases.flatMap(release => release.languages)),
    platforms: unique(standardReleases.flatMap(release => release.platforms)),
    releases, credits, ...(Array.isArray(raw.credits) ? { participationCredits } : {}), series, sources, tags: selectWorkTags(raw.tags),
    contentRating: text(raw.content_rating) || null, originalLanguage: text(raw.olang) || null,
    dataSource: 'nextmoe', coverage, warnings,
  };
}

/** Normalize entity lookup while keeping credit-name identity separate from people. */
export function normalizeSearchHit(hit, { nsfw = false } = {}) {
  validateNsfw(nsfw);
  if (!hit || !validId(hit.id)) return null;
  const types = { work: 'work', credit_name: 'creator', company: 'company' };
  const type = Object.hasOwn(types, hit.target_object) ? types[hit.target_object] : null;
  if (!type || (!nsfw && type === 'work' && hit.content_rating === 'r18')) return null;
  const name = localizedName(hit);
  if (!name.value) return null;
  let workFacts, subtitle;
  if (type === 'work') {
    const companies = unique(['developer', 'brand', 'circle'].flatMap(role => array(hit.companies)
      .filter(company => company?.attribution_role === role && validId(company.id) && localizedName(company).value)
      .map(company => visibleName(localizedName(company)))));
    const year = hit.release_date_precision === 'unknown' ? null : dateFacts(hit.release_date, hit.release_date_precision)?.year ?? null;
    const names = alternateWorkNames(hit, name.value);
    workFacts = { year, companies, names };
    subtitle = [year ? `${year} · 目录年份` : '年份待补充',
      companies.length ? `${companies.slice(0, 2).join(' / ')}${companies.length > 2 ? ` 等 ${companies.length} 家` : ''}` : '制作方待补充',
      ...names].join(' · ');
    // History snapshots have a 1024-code-point field limit. Long catalog names
    // must not prevent selecting or saving an otherwise valid identity.
    if ([...subtitle].length > 1000) subtitle = [...subtitle].slice(0, 999).join('') + '…';
  }
  return {
    type, id: prefixedId(hit.id, type), label: visibleName(name),
    ...(type === 'work' ? { contentRating: text(hit.content_rating) || null } : {}),
    aliases: workNameAliases(hit),
    ...(workFacts ? { workFacts } : {}),
    subtitle: subtitle ?? ({ creator: '创作者署名 · 按具体职责探索', company: '会社 · 打开后核实其作品归属' })[type],
  };
}
