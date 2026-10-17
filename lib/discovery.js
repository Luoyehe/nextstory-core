// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Explainable catalogue discovery. IDs identify credited entities, never guessed people. */
import { matchSearchLabel, normalizeSearchText } from './search-match.js';
import { canonicalCreatorEntity, creatorIdentityResolver, creatorNames, creatorPersonId } from './creator-identity.js';

const ASPECTS = [
  { aspect: 'all', label: '综合探索' },
  { aspect: 'scenario', label: '剧本' },
  { aspect: 'art', label: '画风' },
  { aspect: 'music', label: '音乐' },
  { aspect: 'voice', label: '配音' },
  { aspect: 'series', label: '系列' },
];
const ROLES = {
  scenario: { label: '剧本', weight: 100, caveat: '同一署名参与剧本，不代表题材、叙事风格或负责篇幅相同。' },
  art: { label: '美术', weight: 85, caveat: '同一署名参与美术，不代表整部作品均由其绘制。' },
  music: { label: '音乐', weight: 75, caveat: '同一署名参与音乐，不代表全部配乐或整体听感相同。' },
  voice: { label: '配音', weight: 40, caveat: '同一 CV 参与角色配音，不代表扮演相同角色、配音语言或版本相同，也不代表故事风格相似。' },
};
const array = value => Array.isArray(value) ? value : [];
const validId = value => typeof value === 'string' && value.trim() !== '';
const sourceUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined;
const relationWeight = kind => ROLES[kind]?.weight || (kind === 'series' ? 120 : kind === 'company' ? 10 : 0);

function eraBonus(work, seedWork) {
  // Live snapshots freeze the year selected from available release evidence or
  // the catalogue fallback. Hydrating a detail never changes this snapshot's
  // era score. Curated demo works retain their independently supplied year.
  const knownYear = year => Number.isInteger(year) && year >= 1800 && year <= 2200;
  const yearOf = item => item && Object.hasOwn(item, 'rankingYear') ? item.rankingYear : item?.year;
  const year = yearOf(work);
  const seedYear = yearOf(seedWork);
  return knownYear(year) && knownYear(seedYear) ? Math.max(0, 18 - 1.5 * Math.abs(year - seedYear)) : 0;
}

function sharedCreditsBonus(reasons) {
  return Object.entries(ROLES).reduce((sum, [kind, { weight }]) => {
    const count = new Set(reasons.filter(reason => reason.kind === kind && validId(reason.creditedId)).map(reason => reason.creditedIdentity || reason.creditedId)).size;
    // The first matching ID establishes the aspect's base score. Each extra ID
    // adds 15%, 7.5%, 3.75%... of its weight, bounded by 30%. Explicit person
    // links group their signatures once; otherwise exact credited IDs remain separate.
    return sum + (count > 1 ? weight * 0.30 * (1 - 2 ** -(count - 1)) : 0);
  }, 0);
}

function worksIn(catalog) {
  const seen = new Set();
  return array(catalog).filter(work => {
    if (!work || !validId(work.id) || seen.has(work.id)) return false;
    seen.add(work.id);
    return true;
  });
}

function creditsOf(work) {
  return array(work?.credits).filter(credit => credit && validId(credit.id) && ROLES[credit.role]);
}

/** Collect once per render from visible metadata; no identity lookup or retained private state. */
export function collectVoiceIds(catalog, visible = () => true) {
  const ids = new Set();
  if (!catalog || typeof catalog[Symbol.iterator] !== 'function') return ids;
  for (const work of catalog) {
    if (!work || !visible(work)) continue;
    for (const credit of array(work.credits)) {
      if (credit?.role === 'voice' && validId(credit.id)) ids.add(credit.id);
    }
  }
  return ids;
}

/** A person's identity never changes with the works previously browsed. */
export function creditedEntityLabel(entity) {
  if (entity?.type !== 'creator') return entity?.type === 'company' ? '制作方' : '作品';
  return '创作者';
}

export function creatorResponsibilities(entity) {
  return array(entity?.creatorFacts?.responsibilities)
    .filter(role => role && typeof role.label === 'string' && role.label.trim())
    .map(role => ({ ...role, count: Number.isFinite(role.count) && role.count >= 0 ? role.count : 0 }))
    .sort((left, right) => right.count - left.count);
}

/** A fixed sample catalogue supplies its own complete, distinct-work facts. */
export function creatorFactsFromCatalog(catalog, id) {
  const roles = new Map(), works = new Set();
  const entity = typeof id === 'string' ? { id } : id;
  const identities = creatorIdentityResolver([entity, ...array(catalog).flatMap(work => array(work?.credits))]);
  for (const work of array(catalog)) {
    for (const credit of array(work?.credits)) {
      if (!identities.matches(credit, entity) || !ROLES[credit.role]) continue;
      const key = credit.roleKey || credit.role;
      if (!roles.has(key)) roles.set(key, { key, label: credit.roleLabel || ROLES[credit.role].label, aspect: credit.role, works: new Set() });
      roles.get(key).works.add(work.id); works.add(work.id);
    }
  }
  const responsibilities = [...roles.values()].map(({ works, ...role }) => ({ ...role, count: works.size }))
    .sort((left, right) => right.count - left.count || ASPECTS.findIndex(item => item.aspect === left.aspect) - ASPECTS.findIndex(item => item.aspect === right.aspect));
  return { responsibilities, primaryAspect: responsibilities[0]?.aspect || 'all', complete: true, workCount: works.size };
}

export function creatorRolesText(entity) {
  const roles = creatorResponsibilities(entity);
  if (!roles.length) return entity?.creatorFacts?.complete ? '职责暂未收录' : '职责资料待补充';
  return roles.map(role => role.label).join(' · ')
    + (entity.creatorFacts.complete ? '' : ' · 部分署名资料');
}

function seriesOf(work) {
  return array(work?.series).filter(series => series && validId(series.id));
}

/** Full production affiliations, with legacy curated catalogues still supported. */
export function companiesOf(work) {
  const seen = new Set();
  const entries = Array.isArray(work?.companies) ? work.companies : [work?.company];
  return entries.filter(company => {
    if (!validId(company?.id) || seen.has(company.id) ||
        (company.attributionRole && !['developer', 'brand', 'circle'].includes(company.attributionRole))) return false;
    seen.add(company.id);
    return true;
  });
}

function titleOf(work) {
  return [work.title, work.originalTitle, work.id].find(value => typeof value === 'string' && value.trim()) || '';
}

/** Return all matched known works, credited names and companies, including typos. */
export function searchCatalog(catalog, query) {
  const needle = normalizeSearchText(query);
  if (!needle) return [];
  const works = worksIn(catalog);
  const matches = [];
  const creators = new Map();
  const companies = new Map();
  const identities = creatorIdentityResolver(works.flatMap(creditsOf));

  for (const work of works) {
    const aliases = [...new Set([work.title, work.originalTitle, ...array(work.aliases)])].filter(value => typeof value === 'string' && value.trim());
    const match = matchSearchLabel(needle, aliases);
    if (match) matches.push({
      type: 'work', id: work.id, workId: work.id, label: titleOf(work), aliases,
      subtitle: [work.year, work.company?.name].filter(Boolean).join(' · '), match,
    });
    for (const credit of creditsOf(work)) {
      const key = identities.key(credit);
      let creator = creators.get(key);
      if (!creator) {
        creator = { id: credit.id, creatorIdentity: identities.identity(credit), names: [], roles: new Set(), works: new Set() };
        creators.set(key, creator);
      }
      creator.names.push(...creatorNames({ ...credit, ...(creator.creatorIdentity ? { creatorIdentity: creator.creatorIdentity } : {}) }));
      creator.roles.add(credit.role);
      creator.works.add(work.id);
    }
    for (const affiliation of companiesOf(work)) {
      let company = companies.get(affiliation.id);
      if (!company) {
        company = { id: affiliation.id, names: [], works: new Set() };
        companies.set(affiliation.id, company);
      }
      if (affiliation.name) company.names.push(affiliation.name);
      company.works.add(work.id);
    }
  }

  for (const creator of creators.values()) {
    const aliases = [...new Set(creator.names)].filter(value => typeof value === 'string' && value.trim());
    const match = matchSearchLabel(needle, aliases);
    if (match) matches.push(canonicalCreatorEntity({
      type: 'creator', id: creator.id, ...(creator.creatorIdentity ? { creatorIdentity: creator.creatorIdentity } : {}), creatorFacts: creatorFactsFromCatalog(works, creator.id),
      label: match.matchedText, aliases,
      subtitle: `${[...creator.roles].map(role => ROLES[role].label).join(' / ')} · 已收录 ${creator.works.size} 部作品`, match,
    }));
  }
  for (const company of companies.values()) {
    const aliases = [...new Set(company.names)].filter(value => typeof value === 'string' && value.trim());
    const match = matchSearchLabel(needle, aliases);
    if (match) matches.push({
      type: 'company', id: company.id,
      label: match.matchedText, aliases,
      subtitle: `制作方 · 已收录 ${company.works.size} 部作品`, match,
    });
  }
  const typeOrder = { work: 0, creator: 1, company: 2 };
  return matches.sort((a, b) => b.match.score - a.match.score || typeOrder[a.type] - typeOrder[b.type] || a.label.localeCompare(b.label, 'zh-CN'));
}

function companyReason(work, company) {
  return {
    kind: 'company', companyId: company.id, label: `同制作方 · ${company.name || company.id}`,
    detail: '同一制作方的目录关系；制作团队和题材可能不同，不能据此判断体验相似。',
    sourceUrl: sourceUrl(company.sourceUrl) || sourceUrl(array(work.sources)[0]?.url),
  };
}

function creditRoleLabel(credit) {
  const key = typeof credit.roleKey === 'string' ? credit.roleKey.trim() : '';
  const label = typeof credit.roleLabel === 'string' ? credit.roleLabel.trim() : '';
  return key && label && key !== label ? `${label}（${key}）` : label || key;
}

function participationRoles(credits) {
  const roles = new Map();
  for (const credit of credits) {
    const key = typeof credit?.roleKey === 'string' && credit.roleKey.trim() ? credit.roleKey.trim() : credit?.role;
    const label = typeof credit?.roleLabel === 'string' && credit.roleLabel.trim() ? credit.roleLabel.trim() : ROLES[credit?.role]?.label || key;
    if (validId(key) && validId(label) && !roles.has(key)) roles.set(key, { key, label });
  }
  return [...roles.values()];
}

function participationCharacters(credits) {
  const characters = new Map();
  for (const credit of credits) {
    if (credit?.role !== 'voice') continue;
    for (const character of array(credit.characters)) {
      if (validId(character?.id) && validId(character.name) && !characters.has(character.id)) {
        characters.set(character.id, { id: character.id, name: character.name.trim() });
      }
    }
  }
  return [...characters.values()];
}

// Collapse spelling-only display duplicates without changing character IDs or
// making identity claims about separate upstream records.
export function creatorCharacterNames(characters) {
  const names = new Map();
  for (const character of array(characters)) {
    if (typeof character?.name !== 'string') continue;
    const key = character.name.normalize('NFKC').replace(/[\p{White_Space}\uFEFF]/gu, '');
    if (key && !names.has(key)) names.set(key, character.name);
  }
  return [...names.values()];
}

/**
 * Work-local duties of explicitly selected creator origins. These facts are
 * presentation only: unmapped duties and multiple voiced characters never
 * become new relationship votes, identities or requests. Older/demo works use
 * their existing credits without requiring a new metadata fetch.
 */
export function creatorParticipation(work, seeds) {
  const selected = new Set();
  const credits = [...array(work?.participationCredits), ...array(work?.credits)];
  const identities = creatorIdentityResolver([...credits, ...array(seeds).filter(seed => seed?.type === 'creator')]);
  const participation = [];
  for (const seed of array(seeds)) {
    if (seed?.type !== 'creator' || !validId(seed.id) || selected.has(identities.key(seed))) continue;
    selected.add(identities.key(seed));
    const matching = credits.filter(credit => identities.matches(credit, seed));
    if (!matching.length) continue;
    const roles = participationRoles(matching);
    const knownOrder = new Map(creatorResponsibilities(seed).map((role, index) => [role.key, index]));
    roles.sort((left, right) => (knownOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (knownOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER));
    participation.push({
      id: seed.id,
      name: String(identities.key(seed)).startsWith('person:nm:') && validId(seed.label) ? seed.label : matching.find(credit => validId(credit.name))?.name || (validId(seed.label) ? seed.label : '创作者'),
      ...(String(identities.key(seed)).startsWith('person:nm:') ? { creditNames: [...new Map(matching.filter(credit => validId(credit.name)).map(credit => [credit.id, { id: credit.id, name: credit.name }])).values()] } : {}),
      roles, characters: participationCharacters(matching),
    });
  }
  return participation;
}

function creditReason(credit, origins = [], candidates = [credit], identity) {
  const role = ROLES[credit.role];
  const hasRoleDetails = [...origins, ...candidates].some(item => creditRoleLabel(item));
  const describeRoles = entries => [...new Set(entries.map(item => creditRoleLabel(item) || `${role.label}（具体职责未记录）`))].join('、');
  const responsibilities = hasRoleDetails
    ? `${origins.length ? `起点作品署名职责：${describeRoles(origins)}；` : ''}候选作品署名职责：${describeRoles(candidates)}。`
    : '';
  const characters = participationCharacters(candidates);
  const characterNames = creatorCharacterNames(characters);
  const names = entries => [...new Set(entries.map(item => item.name).filter(validId))];
  const personLinked = typeof identity === 'string' && identity.startsWith('person:nm:');
  const candidateNames = names(candidates), originNames = names(origins);
  const signatureDetail = personLinked ? `${originNames.length ? `起点署名：${originNames.join('、')}；` : ''}本作署名：${candidateNames.join('、')}。` : '';
  return {
    kind: credit.role, creditedId: credit.id, label: `${role.label}关联 · ${credit.name || credit.id}`,
    creditedName: credit.name || '', candidateRoles: participationRoles(candidates), characters,
    ...(personLinked ? { creditedIdentity: identity, creditedNames: candidateNames } : {}),
    detail: signatureDetail + responsibilities + (characterNames.length ? `配音角色：${characterNames.join('、')}。` : '') + (personLinked ? role.caveat.replace('同一署名', '同一创作者') : role.caveat),
    sourceUrl: sourceUrl(credit.sourceUrl),
  };
}

/**
 * Return record-level language/platform evidence, never a promise of playability.
 * `default` is an unspecified edition kind; standard/non-patch records do not
 * establish a complete translation. Optional patch evidence requires a specific
 * language and says nothing about completion, base-edition compatibility or availability.
 */
export function matchingReleases(work, { language = 'any', platform = 'any', includePatches = false } = {}) {
  return array(work?.releases).filter(release => {
    if (!release) return false;
    // Legacy curated demos omit kind. Live unknown and trial records never qualify.
    const standard = !Object.hasOwn(release, 'kind') || ['default', 'digital', 'physical', 'full'].includes(release.kind);
    const patch = includePatches === true && language !== 'any' && release.kind === 'patch';
    return (standard || patch) &&
      (language === 'any' || array(release.languages).includes(language)) &&
      (platform === 'any' || array(release.platforms).includes(platform));
  });
}

/**
 * Rank only explicit credited-name/person + role, series and company links.
 * score is internal ordering weight, not a similarity percentage or user preference.
 * Each relationship aspect establishes its base score once. Additional matching
 * credit IDs add diminishing corroboration; catalogue-era proximity adds at most 18.
 * Neither signal invents a relationship or infers people from display names.
 * Filter language/platform against the SAME release; aggregate display fields never qualify.
 */
export function discover(catalog, options = {}) {
  const { seed, aspect = 'all', language = 'any', platform = 'any', excludePlayed = false, includeSameSeries = true, includePatches = false, library = {} } = options;
  if (!seed || !validId(seed.id) || !['work', 'creator', 'company'].includes(seed.type)) return [];
  if (!ASPECTS.some(item => item.aspect === aspect)) return [];
  const works = worksIn(catalog);
  const seedWork = seed.type === 'work' ? works.find(work => work.id === seed.id) : undefined;
  if (seed.type === 'work' && !seedWork) return [];
  const seedCredits = creditsOf(seedWork);
  const identities = creatorIdentityResolver([...works.flatMap(creditsOf), ...(seed.type === 'creator' ? [seed] : [])]);
  const seedCompanyIds = new Set(companiesOf(seedWork).map(company => company.id));
  const seedSeries = seriesOf(seedWork);
  const seedSeriesIds = new Set(seedSeries.map(series => series.id));
  const results = [];

  for (const work of works) {
    if (seed.type === 'work' && work.id === seed.id) continue;
    // Exclude only an established canonical-series overlap. Missing series data
    // stays eligible through other evidence; it does not establish a different series.
    if (includeSameSeries === false && seed.type === 'work' && seriesOf(work).some(series => seedSeriesIds.has(series.id))) continue;
    const status = library?.[work.id]?.status;
    // A dropped or in-progress work has already been played too; wish is not evidence of liking.
    if (excludePlayed && ['playing', 'completed', 'dropped'].includes(status)) continue;
    if ((language !== 'any' || platform !== 'any') && !matchingReleases(work, { language, platform, includePatches }).length) continue;
    const reasons = [];
    const seenCredits = new Set();
    for (const credit of creditsOf(work)) {
      if (aspect !== 'all' && aspect !== credit.role) continue;
      const identity = `${credit.role}\u0000${identities.key(credit)}`;
      if (seenCredits.has(identity)) continue;
      const matchedSources = seedCredits.filter(other => identities.matches(other, credit) && other.role === credit.role);
      const matched = seed.type === 'creator' ? identities.matches(credit, seed) : seed.type === 'work' &&
        matchedSources.length > 0;
      if (matched) {
        seenCredits.add(identity);
        const candidates = creditsOf(work).filter(other => identities.matches(other, credit) && other.role === credit.role);
        reasons.push(creditReason({ ...credit, sourceUrl: credit.sourceUrl || matchedSources[0]?.sourceUrl }, matchedSources, candidates, identities.key(credit)));
      }
    }
    if (seed.type === 'work' && (aspect === 'all' || aspect === 'series')) {
      const seenSeries = new Set();
      for (const series of seriesOf(work)) {
        if (seenSeries.has(series.id) || !seedSeries.some(other => other.id === series.id)) continue;
        seenSeries.add(series.id);
        reasons.push({
          kind: 'series', seriesId: series.id, label: `同系列 · ${series.name || series.id}`,
          detail: '有明确系列关联；系列归属本身不说明游玩顺序或是否需要先玩前作。',
          sourceUrl: sourceUrl(series.sourceUrl) || sourceUrl(seedSeries.find(other => other.id === series.id)?.sourceUrl),
        });
      }
    }
    if (aspect === 'all') {
      for (const company of companiesOf(work)) {
        if ((seed.type === 'work' && seedCompanyIds.has(company.id)) ||
            (seed.type === 'company' && company.id === seed.id)) reasons.push(companyReason(work, company));
      }
    }
    if (!reasons.length) continue;
    // Corroborating credits are bounded within each aspect; duplicates never vote
    // twice. Apply era only after a real relationship qualifies the candidate.
    const scoreBreakdown = {
      relations: [...new Set(reasons.map(reason => reason.kind))].reduce((sum, kind) => sum + relationWeight(kind), 0),
      sharedCredits: sharedCreditsBonus(reasons),
      era: eraBonus(work, seedWork),
    };
    const score = scoreBreakdown.relations + scoreBreakdown.sharedCredits + scoreBreakdown.era;
    reasons.sort((a, b) => relationWeight(b.kind) - relationWeight(a.kind));
    results.push({ work, reasons, score, scoreBreakdown });
  }
  return results.sort((a, b) => b.score - a.score ||
    titleOf(a.work).localeCompare(titleOf(b.work), 'zh-CN') || a.work.id.localeCompare(b.work.id));
}

/**
 * Combine independent, explicit relationships without treating aliases or repeated
 * staff rows as extra starting points. Coverage has absolute priority over score:
 * a two-origin match precedes every one-origin match, however strong the latter.
 * Missing origin metadata does not reduce the denominator or invent a match.
 * One origin delegates unchanged, including its score and result shape.
 */
export function discoverMulti(catalog, options = {}) {
  const seenSeeds = new Set();
  const identities = creatorIdentityResolver([...array(catalog).flatMap(creditsOf), ...array(options.seeds).filter(seed => seed?.type === 'creator')]);
  const seeds = array(options.seeds).filter(seed => {
    if (!seed || !validId(seed.id) || !['work', 'creator', 'company'].includes(seed.type)) return false;
    const key = `${seed.type}\u0000${seed.type === 'creator' ? identities.key(seed) : seed.id}`;
    if (seenSeeds.has(key)) return false;
    seenSeeds.add(key);
    return true;
  }).map(seed => seed.type === 'creator' ? canonicalCreatorEntity(seed, identities.identity(seed)) : seed);
  if (!seeds.length) return [];
  if (seeds.length === 1) return discover(catalog, { ...options, seed: seeds[0] });

  const works = worksIn(catalog);
  const byId = new Map(works.map(work => [work.id, work]));
  const seedWorkIds = new Set(seeds.filter(seed => seed.type === 'work').map(seed => seed.id));
  const excludedSeriesIds = new Set(options.includeSameSeries === false
    ? seeds.filter(seed => seed.type === 'work').flatMap(seed => seriesOf(byId.get(seed.id)).map(series => series.id)) : []);
  const nonemptyText = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const labelOf = seed => {
    if (seed.type === 'work') {
      const work = byId.get(seed.id);
      return nonemptyText(work?.title) || nonemptyText(work?.originalTitle) || nonemptyText(seed.label) || '作品';
    }
    const entities = seed.type === 'creator' ? works.flatMap(creditsOf) : works.flatMap(companiesOf);
    if (seed.type === 'creator' && creatorPersonId(seed) && nonemptyText(seed.label)) return nonemptyText(seed.label);
    return nonemptyText(entities.find(entity => entity.id === seed.id && nonemptyText(entity.name))?.name) ||
      nonemptyText(seed.label) || (seed.type === 'creator' ? '创作者' : '制作方');
  };
  const combined = new Map();
  for (const seed of seeds) {
    const origin = { type: seed.type, id: seed.id, label: labelOf(seed) };
    for (const result of discover(works, { ...options, seed })) {
      const { work } = result;
      if (seedWorkIds.has(work.id) || seriesOf(work).some(series => excludedSeriesIds.has(series.id))) continue;
      let aggregate = combined.get(work.id);
      if (!aggregate) {
        aggregate = {
          work, reasons: [], score: 0,
          scoreBreakdown: { relations: 0, sharedCredits: 0, era: 0 },
          matchedSeeds: [], matchedSeedCount: 0, totalSeedCount: seeds.length, commonToAll: false,
        };
        combined.set(work.id, aggregate);
      }
      aggregate.matchedSeeds.push(origin);
      aggregate.score += result.score;
      for (const key of ['relations', 'sharedCredits', 'era']) aggregate.scoreBreakdown[key] += result.scoreBreakdown[key];
      aggregate.reasons.push(...result.reasons.map(reason => ({
        ...reason, seedId: origin.id, seedType: origin.type, seedLabel: origin.label,
      })));
    }
  }
  for (const result of combined.values()) {
    result.matchedSeedCount = result.matchedSeeds.length;
    result.commonToAll = result.matchedSeedCount === seeds.length;
  }
  return [...combined.values()].sort((a, b) => b.matchedSeedCount - a.matchedSeedCount || b.score - a.score ||
    titleOf(a.work).localeCompare(titleOf(b.work), 'zh-CN') || a.work.id.localeCompare(b.work.id));
}

/** Count unique related works per aspect using the same multi-origin scope. */
export function getMultiBranches(catalog, seeds, { includeSameSeries = true } = {}) {
  return ASPECTS.map(({ aspect, label }) => ({ aspect, label, count: discoverMulti(catalog, { seeds, aspect, includeSameSeries }).length }));
}

/** Branch counts honor the same-series scope, without release or played-status filters. */
export function getBranches(catalog, seed, { includeSameSeries = true } = {}) {
  return ASPECTS.map(({ aspect, label }) => ({ aspect, label, count: discover(catalog, { seed, aspect, includeSameSeries }).length }));
}

/**
 * Group an already ranked, filtered page without changing individual scores.
 * Each work chooses one canonical series ID: one shared with the seed first,
 * then the most represented series in the unfiltered page, then the ID.
 * The reference page fixes membership decisions through local filtering; it
 * never supplies extra visible works or implies a complete series catalogue.
 */
export function groupResults(results, { seedWork, referenceResults = results } = {}) {
  const uniqueResults = values => {
    const seen = new Set();
    return array(values).filter(result => {
      if (!result?.work || !validId(result.work.id) || seen.has(result.work.id)) return false;
      seen.add(result.work.id);
      return true;
    });
  };
  const uniqueSeries = work => [...new Map(seriesOf(work).map(series => [series.id, series])).values()];
  const visible = uniqueResults(results);
  const reference = uniqueResults(referenceResults);
  const seedIds = new Set(seriesOf(seedWork).map(series => series.id));
  const memberCounts = new Map();
  const metadata = new Map();
  const remember = series => {
    const previous = metadata.get(series.id);
    metadata.set(series.id, {
      id: series.id,
      name: previous?.name || (typeof series.name === 'string' ? series.name.trim() : '') || undefined,
      sourceUrl: previous?.sourceUrl || sourceUrl(series.sourceUrl),
    });
  };
  for (const series of seriesOf(seedWork)) remember(series);
  for (const { work } of reference) {
    for (const series of uniqueSeries(work)) {
      memberCounts.set(series.id, (memberCounts.get(series.id) || 0) + 1);
      remember(series);
    }
  }
  const primarySeries = work => uniqueSeries(work).sort((a, b) =>
    Number(seedIds.has(b.id)) - Number(seedIds.has(a.id)) ||
    (memberCounts.get(b.id) || 0) - (memberCounts.get(a.id) || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const primaryByWork = new Map();
  const referenceCounts = new Map();
  for (const { work } of reference) {
    const primary = primarySeries(work);
    primaryByWork.set(work.id, primary);
    if (primary) referenceCounts.set(primary.id, (referenceCounts.get(primary.id) || 0) + 1);
  }
  const groups = new Map();
  for (const result of visible) {
    const primary = primaryByWork.has(result.work.id) ? primaryByWork.get(result.work.id) : primarySeries(result.work);
    if (!primary) {
      groups.set(`work\u0000${result.work.id}`, { type: 'work', id: `work:${result.work.id}`, results: [result] });
      continue;
    }
    const key = `series\u0000${primary.id}`;
    if (!groups.has(key)) {
      remember(primary);
      const details = metadata.get(primary.id);
      groups.set(key, {
        type: 'series', id: primary.id, name: details.name || primary.id, sourceUrl: details.sourceUrl,
        results: [], referenceCount: referenceCounts.get(primary.id) || 0, sharedWithSeed: seedIds.has(primary.id),
      });
    }
    groups.get(key).results.push(result);
  }
  return [...groups.values()];
}
