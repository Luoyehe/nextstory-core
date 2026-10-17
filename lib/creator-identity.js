// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Explicit catalogue person links only. Names never establish identity. */
const array = value => Array.isArray(value) ? value : [];
const personPattern = /^person:nm:[0-9]{1,20}$/;
const creditPattern = /^credit:nm:[0-9]{1,20}$/;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const unique = values => [...new Set(values.map(text).filter(Boolean))];
const byId = (left, right) => {
  const a = BigInt(left.id.slice(10)), b = BigInt(right.id.slice(10));
  return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
};

export function normalizeCreatorIdentity(value) {
  if (!value || !personPattern.test(value.personId) || !Array.isArray(value.creditNames)) return null;
  const names = new Map();
  let complete = value.complete === true;
  for (const row of value.creditNames) {
    if (!row || !creditPattern.test(row.id) || !text(row.name)) { complete = false; continue; }
    const prior = names.get(row.id);
    names.set(row.id, { id: row.id, name: prior?.name || row.name.trim(),
      aliases: unique([...(prior?.aliases || []), ...(prior ? [row.name] : []), ...array(row.aliases)]) });
  }
  if (!names.size) return null;
  return { personId: value.personId, creditNames: [...names.values()].sort(byId), complete };
}

export function creatorIdentityOf(entity) {
  const identity = normalizeCreatorIdentity(entity?.creatorIdentity);
  if (!identity || !identity.creditNames.some(row => row.id === entity?.id)) return null;
  if (entity.personId && entity.personId !== identity.personId) return null;
  return identity;
}

export function creatorPersonId(entity) {
  const identity = creatorIdentityOf(entity);
  if (identity) return identity.personId;
  return !entity?.creatorIdentity && creditPattern.test(entity?.id) && personPattern.test(entity?.personId) ? entity.personId : null;
}

export function mergeCreatorIdentities(values) {
  const identities = array(values).map(normalizeCreatorIdentity).filter(Boolean);
  if (!identities.length || identities.some(identity => identity.personId !== identities[0].personId)) return null;
  const creditNames = identities.flatMap(identity => identity.creditNames);
  const ids = new Set(creditNames.map(row => row.id));
  const complete = identities.some(identity => identity.complete && identity.creditNames.length === ids.size
    && identity.creditNames.every(row => ids.has(row.id)));
  return normalizeCreatorIdentity({ personId: identities[0].personId, creditNames, complete });
}

/** One bounded snapshot resolves unknown rows through explicitly linked IDs. */
export function creatorIdentityResolver(entities) {
  const people = new Map(), bindings = new Map();
  const bind = (id, personId) => {
    if (!bindings.has(id)) bindings.set(id, personId);
    else if (bindings.get(id) !== personId) bindings.set(id, null);
  };
  for (const entity of array(entities)) {
    const personId = creatorPersonId(entity);
    if (!personId) continue;
    bind(entity.id, personId);
    const identity = creatorIdentityOf(entity);
    if (!identity) continue;
    people.set(personId, mergeCreatorIdentities([...(people.has(personId) ? [people.get(personId)] : []), identity]));
    for (const name of identity.creditNames) bind(name.id, personId);
  }
  const person = entity => {
    if (bindings.has(entity?.id)) return bindings.get(entity.id);
    return creatorPersonId(entity);
  };
  const key = entity => person(entity) || entity?.id;
  return {
    key,
    identity: entity => {
      const identity = people.get(person(entity));
      if (!identity || identity.creditNames.some(row => bindings.get(row.id) === null)) return null;
      return identity;
    },
    matches: (left, right) => Boolean(left?.id && right?.id && key(left) === key(right)),
  };
}

export function creatorIdentityKey(entity) {
  return creatorPersonId(entity) || entity?.id;
}

export function creatorCreditIds(entity) {
  return [...new Set([entity?.id, ...array(creatorIdentityOf(entity)?.creditNames).map(row => row.id)].filter(text))];
}

export function creatorNames(entity) {
  return unique([entity?.label, entity?.name, ...array(entity?.aliases),
    ...array(creatorIdentityOf(entity)?.creditNames).flatMap(row => [row.name, ...row.aliases])]);
}

export function creatorOtherNames(entity, label = entity?.label || entity?.name || '') {
  const key = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{White_Space}\uFEFF]/gu, '');
  const seen = new Set([key(String(label))]);
  return creatorNames(entity).filter(name => { const value = key(name); if (seen.has(value)) return false; seen.add(value); return true; });
}

/** Partial per-name pages can overlap: retain duties, never add their counts. */
export function mergeCreatorFacts(values) {
  const facts = array(values).filter(value => value && Array.isArray(value.responsibilities));
  if (!facts.length) return undefined;
  if (facts.length === 1 || facts.every(value => JSON.stringify(value) === JSON.stringify(facts[0]))) return facts[0];
  const roles = new Map();
  for (const fact of facts) for (const role of fact.responsibilities) {
    if (!text(role?.key) || !text(role.label)) continue;
    const count = Number.isFinite(role.count) && role.count >= 0 ? role.count : 0;
    if (!roles.has(role.key) || roles.get(role.key).count < count) roles.set(role.key, { ...role, count });
  }
  const responsibilities = [...roles.values()].sort((left, right) => right.count - left.count);
  return { ...facts[0], responsibilities, primaryAspect: responsibilities.find(role => role.aspect)?.aspect || 'all',
    complete: false, workCount: Math.max(0, ...facts.map(fact => Number.isFinite(fact.workCount) ? fact.workCount : 0)) };
}

/** Keep the matched display name independent of the stable routing ID. */
export function canonicalCreatorEntity(entity, identity = creatorIdentityOf(entity)) {
  const normalized = normalizeCreatorIdentity(identity);
  if (entity?.type !== 'creator' || !normalized || !normalized.creditNames.some(row => row.id === entity.id)) return entity;
  return { ...entity, id: normalized.creditNames[0].id, creatorIdentity: normalized,
    aliases: unique([...(entity.aliases || []), entity.label, ...normalized.creditNames.flatMap(row => [row.name, ...row.aliases])]) };
}
