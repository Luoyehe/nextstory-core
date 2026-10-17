# NextStory Core

`@nextstory/core` provides explainable Galgame discovery for applications that want to build their own interface. It ranks explicit relationships between works, creators, voice actors, companies and series, and returns the evidence behind each result.

Version: **0.1.2**. ESM only, with no runtime npm dependencies. The package includes no website interface, account database, credentials, game images or real catalogue fixture data.

## Install once, update with one command

Use the versioned GitHub dependency in your **host application's development directory** (Node.js/npm and Git are required):

```sh
npm install "@nextstory/core@git+https://github.com/Luoyehe/nextstory-core.git#semver:^0.1.2" --ignore-scripts --no-audit --no-fund
```

Then update just Core within that compatible release series:

```sh
npm update @nextstory/core --ignore-scripts --no-audit --no-fund
```

This works directly from public GitHub version tags; no GitHub login, API key or npm-registry publication is required. Do not use `main` or an unversioned Git URL as an automatic update channel. An existing fixed `.tgz`, `file:` path or exact Git tag does **not** track new versions: run the install command above once to change that dependency's source. Do not replace your application's whole `package.json` with the example.

For a ready-to-run embedded host, copy **both files** from [`examples/embedded-host/`](examples/embedded-host/) into a new directory outside this Core checkout. Run `npm install --ignore-scripts --no-audit --no-fund`, then `npm run core:check`. Subsequent updates use one command:

```sh
npm run core:update
```

The example updates the dependency and runs an offline check of the public imports, single/multi-origin discovery and the optional in-memory Node adapter. It makes no NextMoe requests and never opens the host's persistent databases. Existing hosts can copy `verify.mjs` to a chosen location and merge the two example script entries, adjusting the verification path. The smoke check complements the host's own integration tests; it does not prove every application behavior.

### Compatibility and application ownership

- `^0.1.2` accepts stable `0.1.x` releases from `0.1.2` onward. It excludes `0.2.0`, `1.0.0` and prereleases. Moving to a new compatibility series is an explicit developer decision.
- We reserve the `0.1.x` update channel for compatible changes: preserve public API shapes, defaults, ranking semantics and runtime requirements. Incompatible contract changes or irreversible stored-data changes require a new compatibility series and migration instructions. This is a release policy, not a guarantee that software can never have a regression.
- Core has no runtime npm dependencies or installation hooks. The commands target Core and disable lifecycle scripts. They update package-manager-owned dependency files and the lockfile, not the host's UI, source code, credentials, configuration, accounts or catalogue data. Keep those files outside `node_modules` and never patch installed Core files directly.
- Commit `package.json` and the generated `package-lock.json` in the host project; ignore `node_modules`. The lockfile records the chosen Git commit. Build/deploy with `npm ci` to reproduce that reviewed version instead of selecting a new version on every application launch.
- Run updates in development or a staged build. A bundled browser/Electron/desktop application needs rebuilding; a Node service needs its normal restart/reload. This command is **not** a live hot-swap or an end-user application updater. C#, Rust or other hosts can use the example as their separately packaged Node helper.
- `--ignore-scripts` deliberately skips host install hooks as well. Run your normal, trusted build steps afterwards. Use your existing package manager and workspace targeting rules in a monorepo; do not introduce a second lockfile into a pnpm/Yarn-managed project.

### Failure and rollback

Before updating, preserve the host's current manifest and lockfile (for example, in version control). If installation or verification fails, the command exits unsuccessfully: do not deploy that staging directory. It does **not** promise an atomic install or automatically restore the prior dependency tree.

To roll back, restore the previous `package.json` and `package-lock.json`, then run `npm ci --ignore-scripts --no-audit --no-fund` and the host's checks/build. `npm ci` recreates the entire dependency tree, so do this in the staging/build directory. Restoring code is not a substitute for a data backup if a future explicitly chosen incompatible version has already migrated real data.

This mechanism uses npm's documented [Git semver dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#git-urls-as-dependencies) and [targeted updates](https://docs.npmjs.com/cli/v11/commands/npm-update/).

## Choose an entry point

| Import | Runtime | Purpose |
| --- | --- | --- |
| `@nextstory/core` | Modern browser or JavaScript runtime | Pure discovery, identity and name-matching functions; no network or DOM access |
| `@nextstory/core/discovery` | Same as the root | Single- and multi-origin discovery, participation and release helpers |
| `@nextstory/core/creator-identity` | Same as the root | Explicit person/credited-name identity normalization |
| `@nextstory/core/exploration-seeds` | Same as the root | Validate and deduplicate exploration origins |
| `@nextstory/core/search-match` | Same as the root | Name matching and bounded correction query generation |
| `@nextstory/core/search-ranking` | Same as the root | Order supplied search candidates and combine explicit identity matches |
| `@nextstory/core/node` | **Node.js 24.14.0 or newer** | NextMoe client/provider and optional SQLite storage/synchronization |
| `@nextstory/core/node/<module>` | Node.js 24.14.0 or newer | Import one of the Node modules listed below |

Only the Node entry points require Node.js. The root entry does not import `node:sqlite`, read files, open a database or start a background task. Pure functions use modern JavaScript features including Unicode property escapes, `BigInt`, `Map`, `Set` and `URLSearchParams`.

From a source checkout, `npm pack` creates an installable package. Install that archive in a consuming project, for example `npm install ./nextstory-core-0.1.2.tgz`. This is a fixed offline snapshot; use the GitHub dependency above when you want versioned updates. Bundlers can resolve the imports above. For an unbundled browser, serve `index.js` and the complete `lib/` directory together and import `index.js` by its served URL.

## Run the synthetic example

```sh
npm run example
```

`examples/discovery.mjs` contains only fictional works and contributors. It runs without network access and demonstrates single-origin ranking, multi-origin coverage priority, and voice-character evidence.

```js
import { discover, discoverMulti } from '@nextstory/core';

const writer = { id: 'local:writer', name: 'Example Writer', role: 'scenario' };
const artist = { id: 'local:artist', name: 'Example Artist', role: 'art' };
const catalog = [
  { id: 'local:a', title: 'Origin A', credits: [writer] },
  { id: 'local:b', title: 'Origin B', credits: [artist] },
  { id: 'local:c', title: 'Shared Connection', credits: [writer, artist] },
];

const single = discover(catalog, {
  seed: { type: 'work', id: 'local:a' }, aspect: 'scenario',
});
const multiple = discoverMulti(catalog, {
  seeds: [{ type: 'work', id: 'local:a' }, { type: 'work', id: 'local:b' }],
  aspect: 'all',
});
console.log(single[0].reasons, multiple[0].matchedSeedCount); // 2 origins
```

### Pure discovery contract

The caller supplies the catalogue. These functions do not fetch missing records or claim that the supplied records cover an entire external catalogue.

| Field or option | Contract |
| --- | --- |
| Work | Unique nonempty string `id`, display `title`, and any known `credits`, `companies`, `series`, `releases`, `year` |
| Credit | Nonempty string `id`; known `role` of `scenario`, `art`, `music` or `voice`; optional `name`, `roleKey`, `roleLabel`, `sourceUrl`, `characters` |
| Voice characters | `characters: [{ id, name }]` attached to that work's actual voice credit, not a global creator property |
| Company / series | Records with stable `id` and optional `name` / `sourceUrl` |
| Origin | `{ type: 'work' \| 'creator' \| 'company', id }`; creator identity evidence may also be supplied |
| `aspect` | `all`, `scenario`, `art`, `music`, `voice` or `series`; default `all` |
| Release filtering | `language`, `platform`, `includePatches`; language and platform must be present in the same qualifying release record |
| Library exclusion | `excludePlayed: true` with `library: { [workId]: { status } }`; `playing`, `completed`, `dropped` are excluded; this object remains caller-owned |
| Series exclusion | `includeSameSeries: false` excludes known shared series for work origins; missing series data is not evidence of a different series |

`discover()` returns ordered `{ work, reasons, score, scoreBreakdown }` entries. `score` is an internal ordering weight, not a similarity percentage or prediction of enjoyment. Reasons contain structured identifiers, participation roles, source links and, when supplied, voice characters. Existing `label` and `detail` values are Chinese display text; applications may render their own wording from the structured fields.

`discoverMulti()` adds `matchedSeeds`, `matchedSeedCount`, `totalSeedCount` and `commonToAll` when there is more than one unique origin. Coverage has priority over total score. A single unique origin delegates to `discover()` and retains its original result shape. Origin works are excluded from multi-origin results. `normalizeExplorationSeeds()` validates up to eight origins by default and deduplicates explicit identities; call it at your input boundary.

Generic exact credit IDs can be application-owned strings. Automatic person/alias grouping deliberately uses the established NextMoe identity shape: `person:nm:<decimal-id>`, `credit:nm:<decimal-id>` and `creatorIdentity: { personId, creditNames: [{ id, name, aliases? }], complete }`. Do not invent these associations or combine people by display name. A source without verified person links can still use exact stable credit IDs.

Pure `searchCatalog(catalog, query)` searches the supplied records. `rankSearchCandidates(items, query)` orders supplied `{ type, id, label, aliases?, match? }` candidates; it does not create new remote identities. The functions preserve the distinction between direct matches, typo candidates and broader related names.

## Use NextMoe without a website account system

This example makes no request until explicitly enabled:

```sh
node examples/nextmoe.mjs
node examples/nextmoe.mjs --live --query="your search text"
# Copy an actual work ID returned by that search before running exploration:
node examples/nextmoe.mjs --live --work="nm:ID_FROM_SEARCH"
```

Add `--include-nsfw` when desired. `NEXTMOE_API_KEY` is optional; without one this example uses anonymous catalogue access. It creates no disk database and starts no synchronization. Search can issue several bounded upstream requests, and `--live` consumes the upstream allowance even though no website account is used. The example prints candidate IDs for the caller to choose; it never automatically selects the first match.

```js
import { CatalogTransport, NextMoeClient, CatalogProvider } from '@nextstory/core/node';

const transport = new CatalogTransport();
const client = new NextMoeClient({ transport });
const provider = new CatalogProvider({ client });
const controller = new AbortController();

const response = await transport.run(null, () => provider.search('your search text', {
  nsfw: false, correction: true, signal: controller.signal,
}));
// Render all returned response.items. Retain partial/notice and nextCursor.
// Call controller.abort() when this operation is no longer needed.
```

### Node provider API

| Method | Result / usage |
| --- | --- |
| `provider.search(query, { nsfw, correction, signal, cursor })` | Candidate `items`, `partial`, `notice`, `nextCursor` and coverage. Continue explicitly with the same query, flags and identity scope |
| `provider.getWork('nm:…', { nsfw, signal })` | A normalized work with available relationship evidence; missing data remains missing |
| `provider.getWorks(['nm:…'], { nsfw, signal })` | Up to 100 requested works per call; inspect `works`, `missing`, `failed` and `partial` separately |
| `provider.getCreatorFacts('credit:nm:…', { nsfw, signal })` | Creator/person identity, credited-name responsibilities and coverage from obtained records |
| `provider.explore({ seeds, aspect, nsfw, includeSameSeries, page, pageSize, snapshotId }, { signal })` | A catalogue subset with seed facts, pagination, coverage and partial-data notices; rank/filter the returned normalized catalogue with the pure core as the application needs |

For one origin, `explore()` also accepts `{ type, id }` instead of `seeds`. `pageSize` is bounded by the provider's public contract (1–24). Keep the returned `pagination.snapshotId` for subsequent pages of the same exploration. Search cursors and exploration snapshots are process-local, scoped, expiring handles; they are not bookmarks or database IDs. On expiration or `CATALOG_CHANGED`, restart that operation while preserving the user's chosen exact origins.

The `NextMoeClient` methods expose validated upstream-shaped records and use raw decimal IDs, whereas `CatalogProvider` exposes normalized IDs (`nm:…`, `credit:nm:…`, `company:nm:…`). Do not interchange them. Incomplete or unknown data must not be labeled as an authoritative empty relationship list. `partial`, `failed`, `missing`, `coverage` and `notice` belong in the consuming application's handling, not just its logs.

Errors use `NextMoeError` with `code` and, where applicable, `status`, `retryAfterMs`, `currentId`, `currentObject` and `upstreamCode`. Do not immediately loop on quota, authorization or timeout failures. A cancellation signal only cancels that caller's subscription; other callers sharing a request may still receive its result.

The normalizer retains the compatibility missing-cover marker `/assets/cover-placeholder.svg`. This is **not an upstream image URL or a bundled asset**. Map it to your own placeholder or `null`; the network example demonstrates this. Original catalogue media remains linked, not downloaded or licensed by this package.

### Credential ownership

`CatalogTransport` accepts an optional `apiKey` and injectable `fetchImpl`. For an authorized user, the host can call `transport.run({ userId, getAccessToken }, operation)` with its own token provider. The callback is normally called without arguments. After a rejected token, it may receive `{ forceRefresh: true, rejectedAccessToken }`; return a refreshed token or let the host handle authorization failure. The package supplies no login screen, OAuth application or account persistence. Keep credentials in the host's server or desktop process, never browser-delivered code.

Foreground routing is authorized user → anonymous → configured application key, or anonymous → application key without a user. Only quota exhaustion advances to the next identity. Authentication failures require the host's authorization flow. In-flight work stays identity-scoped while eligible public metadata can be shared. A different quota owner does not reduce the total number of upstream requests.

## Optional storage and synchronization

```js
import { CatalogDatabase, CatalogTransport, NextMoeClient, CatalogProvider } from '@nextstory/core/node';

const database = new CatalogDatabase({ file: '/your/application/data/catalog.sqlite', maxFileBytes: 20_000_000_000 });
const transport = new CatalogTransport();
const client = new NextMoeClient({ transport, catalogDatabase: database });
const provider = new CatalogProvider({ client });
try {
  // Await the host's operations here. The constructor itself makes no request.
} finally {
  database.close();
}
```

The host chooses an absolute file path and its lifecycle; omit `file` for in-memory storage. Prefer a dedicated catalogue directory. Newly created directories are private (`0700`), existing host-directory permissions are preserved, and database files use `0600`; the host owns directory isolation. Do not pass an account database or share that file with unrelated schemas. Storage keeps typed raw fields, relationship context and query snapshots; entity names alone do not establish identity. Reuse requires fresh, complete, scope-eligible data. The retained catalogue is not a complete offline mirror; local name supplementation does not replace remote search recall.

The database uses a soft main-file target rather than a write limit, with bounded reclamation, decaying recent-use frequency and temporary protection for new records. WAL files, backups and other application files are outside that target. SQLite work is synchronous; hosts serving heavy concurrent traffic should account for that in their process architecture. Call `close()` after awaited operations finish. `CatalogCache` is an optional generic persisted cache used for derived snapshots and legacy interoperability, not a replacement account store.

`CatalogSync` is opt-in: constructing it does not start it. Use the same client/transport/database and connect invalidation back to the client:

```js
import { CatalogSync } from '@nextstory/core/node';

const sync = new CatalogSync({
  client, transport, database,
  onApplied: result => client.applyCatalogChanges(result),
});
// Only when your host explicitly enables background use and provides its key:
sync.start();
// During shutdown, stop and await it before closing the database:
await sync.stop();
```

Background reads use only the configured application key, yielding to foreground work and persisting feed cursors and budget. Without that key `start()` returns false. Changes/redirects invalidate affected older facts; ordinary reads refresh them through the same validation path. Incremental notifications do not replace TTL refresh or import all work details. `migrateCatalogCache()` is an optional bounded legacy-cache importer; new consumers do not need it.

The individually exported Node module names are `nextmoe`, `catalog-provider`, `catalog-search`, `catalog-normalize`, `catalog-transport`, `catalog-cache`, `catalog-database`, `catalog-sync`, `catalog-migration`, `creator-profile` and `work-tags`. For example, `@nextstory/core/node/catalog-normalize` exports `normalizeWork` and the data-shape predicates. All their imports stay inside this package or Node built-ins.

## Integrating other desktop languages

A non-JavaScript host can run a small local Node process and exchange JSON over its chosen local HTTP or standard-input/output protocol. That process owns the provider and optional database; the host owns its UI, game installations, launch behavior, playtime, save backups and account state. This package does not start a bridge server or require the NextStory website to run. The pure JavaScript layer may alternatively be used inside a compatible embedded runtime.

## License, copyright and source

Copyright (c) 2026 Luoyehe. **NextStory Core** (`@nextstory/core`) is maintained in the [official source repository](https://github.com/Luoyehe/nextstory-core). The version tags identify each published source release.

This package's source is governed by **MPL-2.0**; the unmodified official license is included in [LICENSE](LICENSE) and available from [Mozilla](https://www.mozilla.org/MPL/2.0/). No additional use restrictions are imposed by this documentation.

When redistributing covered source, retain its applicable copyright and license notices. When distributing covered software in executable form, make the corresponding MPL-covered source, including your changes to covered files, available and tell recipients how to obtain it, as specified in sections 3.1–3.4 of the license. These brief notes do not replace the license text.

### Optional attribution / 自愿署名

If you would like to acknowledge NextStory Core, you can use one of these examples in your README, an About page, third-party acknowledgements or another suitable location:

```markdown
本项目使用 [NextStory Core](https://github.com/Luoyehe/nextstory-core)，由 Luoyehe 维护，采用 MPL-2.0 许可。
```

```markdown
This project uses [NextStory Core](https://github.com/Luoyehe/nextstory-core), maintained by Luoyehe and licensed under MPL-2.0.
```

These credits are **voluntary**, not an additional license condition. No particular wording, placement, logo or user-visible credit is required by this guidance. Including a credit does not replace the MPL obligations that apply to your distribution. This guidance adds no advertising, telemetry or extra deployment requirements.

以上署名示例完全自愿，不构成额外许可条件；是否采用、使用什么措辞以及放在哪里，均由接入者自行决定。采用示例不能代替 MPL-2.0 本身适用的许可义务。

### Data sources

The examples are synthetic. NextMoe data, media, API terms and service quotas remain governed by their respective sources; the code license does not grant rights to game assets or imply NextMoe endorsement. Consult the [NextMoe developer documentation](https://developer.nextmoe.dev/docs) for the upstream API contract.
