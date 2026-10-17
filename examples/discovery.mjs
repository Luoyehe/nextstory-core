// Copyright (c) 2026 Luoyehe.
// NextStory Core — https://github.com/Luoyehe/nextstory-core
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { discover, discoverMulti } from '@nextstory/core';

// Entirely fictional fixtures. These IDs are local to this example and must
// never be sent to NextMoe. No network, account, images or files are required.
const writer = { id: 'example:writer', name: 'Example Writer', role: 'scenario', roleKey: 'scenario', roleLabel: 'Script' };
const artist = { id: 'example:artist', name: 'Example Artist', role: 'art', roleKey: 'illustration', roleLabel: 'Illustration' };
const composer = { id: 'example:composer', name: 'Example Composer', role: 'music', roleKey: 'composer', roleLabel: 'Composition' };
const voice = { id: 'example:voice', name: 'Example Voice', role: 'voice', roleKey: 'voice-actor', roleLabel: 'Voice acting' };
const work = (id, title, credits) => ({ id, title, credits, year: 2020, series: [], companies: [], releases: [], contentRating: 'all_ages' });
const catalog = [
  work('example:origin-a', 'Origin A', [writer, composer]),
  work('example:origin-b', 'Origin B', [artist, { ...voice, characters: [{ id: 'example:character-b', name: 'Example Character B' }] }]),
  work('example:shared', 'Shared Connection', [writer, artist, { ...voice, characters: [{ id: 'example:character-c', name: 'Example Character C' }] }]),
  work('example:one-origin', 'One Origin Connection', [writer, composer]),
];

const single = discover(catalog, { seed: { type: 'work', id: 'example:origin-a' }, aspect: 'all' });
const multiple = discoverMulti(catalog, {
  seeds: [{ type: 'work', id: 'example:origin-a' }, { type: 'work', id: 'example:origin-b' }],
  aspect: 'all',
});
if (single[0]?.work.id !== 'example:one-origin') throw new Error('Unexpected single-origin relationship order.');
if (multiple[0]?.work.id !== 'example:shared' || !multiple[0].commonToAll) throw new Error('Expected the shared connection first.');

const summarize = result => ({
  id: result.work.id,
  title: result.work.title,
  score: result.score,
  ...(result.matchedSeedCount !== undefined ? { matchedSeedCount: result.matchedSeedCount, commonToAll: result.commonToAll } : {}),
  reasons: result.reasons.map(({ kind, label, detail }) => ({ kind, label, detail })),
});
console.log(JSON.stringify({ single: single.map(summarize), multiple: multiple.map(summarize) }, null, 2));
