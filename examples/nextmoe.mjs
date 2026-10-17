// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { CatalogProvider, CatalogTransport, NextMoeClient } from '@nextstory/core/node';

// This example never logs credentials and does not start background sync or
// create a database. Every network run requires an explicit flag and target.
const args = process.argv.slice(2);
const queries = args.filter(value => value.startsWith('--query='));
const works = args.filter(value => value.startsWith('--work='));
const live = args.includes('--live');
const valid = args.every(value => value === '--live' || value === '--include-nsfw' || value.startsWith('--query=') || value.startsWith('--work='));
if (!live || !valid || queries.length + works.length !== 1 || queries.length > 1 || works.length > 1) {
  console.log('No network request made. Explicit usage:');
  console.log('  node examples/nextmoe.mjs --live --query="your search text"');
  console.log('  node examples/nextmoe.mjs --live --work="nm:ID_FROM_SEARCH"');
  console.log('Add --include-nsfw to include adult catalogue records. NEXTMOE_API_KEY is optional.');
} else {
  const transport = new CatalogTransport({ apiKey: process.env.NEXTMOE_API_KEY || undefined });
  const client = new NextMoeClient({ transport });
  const provider = new CatalogProvider({ client });
  const nsfw = args.includes('--include-nsfw');
  const signal = AbortSignal.timeout(45_000);
  // This relative string is the adapter's legacy missing-cover marker, not
  // a NextMoe resource. The host should render its own placeholder for null.
  const coverForHost = cover => cover === '/assets/cover-placeholder.svg' ? null : cover;
  try {
    await transport.run(null, async () => {
      if (queries.length) {
        const result = await provider.search(queries[0].slice('--query='.length), { nsfw, correction: true, signal });
        console.log(JSON.stringify({ items: result.items, partial: result.partial, nextCursor: result.nextCursor, notice: result.notice }, null, 2));
      } else {
        const result = await provider.explore({ type: 'work', id: works[0].slice('--work='.length), aspect: 'all', nsfw, pageSize: 6 }, { signal });
        console.log(JSON.stringify({ ...result, catalog: result.catalog?.map(work => ({ ...work, cover: coverForHost(work.cover) })) }, null, 2));
      }
    });
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || error.name, message: error.message, retryAfterMs: error.retryAfterMs }));
    process.exitCode = 1;
  }
}
