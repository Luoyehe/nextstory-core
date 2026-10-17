// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copy alongside the example package.json into a separate host directory.
// This is an offline compatibility smoke check, not the host's business tests.
import assert from 'node:assert/strict';

const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok(major > 24 || (major === 24 && minor >= 14), 'Use Node.js 24.14.0 or newer.');
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error('This compatibility check must remain offline.');
};

const { default: manifest } = await import('@nextstory/core/package.json', { with: { type: 'json' } });
assert.equal(manifest.name, '@nextstory/core');
for (const name of Object.keys(manifest.exports)) {
  if (name === './package.json') continue;
  await import('@nextstory/core' + (name === '.' ? '' : name.slice(1)));
}
const pure = await import('@nextstory/core');
const node = await import('@nextstory/core/node');
assert.equal(pure.discover, node.discover);

const writer = { id: 'example:writer', name: 'Example Writer', role: 'scenario' };
const voice = { id: 'example:voice', name: 'Example Voice', role: 'voice' };
const catalog = [
  { id: 'example:origin-a', title: 'Example A', credits: [writer] },
  { id: 'example:origin-b', title: 'Example B', credits: [voice] },
  { id: 'example:shared', title: 'Shared Example', credits: [writer, voice] },
];
const options = { seed: { type: 'work', id: 'example:origin-a' }, aspect: 'scenario' };
assert.equal(pure.discover(catalog, options)[0].work.id, 'example:shared');
const multiple = pure.discoverMulti(catalog, {
  seeds: [options.seed, { type: 'work', id: 'example:origin-b' }], aspect: 'all',
});
assert.equal(multiple[0].work.id, 'example:shared');
assert.equal(multiple[0].matchedSeedCount, 2);
assert.equal(multiple[0].commonToAll, true);
assert.ok(multiple[0].reasons.length > 0);

// No file path: never inspect or migrate the host's real catalogue/account data.
const database = new node.CatalogDatabase();
try {
  const transport = new node.CatalogTransport();
  const client = new node.NextMoeClient({ transport, catalogDatabase: database });
  const provider = new node.CatalogProvider({ client });
  assert.equal(typeof provider.search, 'function');
  assert.equal(typeof provider.explore, 'function');
} finally {
  database.close();
}
assert.equal(requests, 0, 'The check must not contact NextMoe.');
console.log(`NextStory Core ${manifest.version}: offline compatibility check passed.`);
console.log('Run your application tests, then rebuild/restart through your normal release process.');
