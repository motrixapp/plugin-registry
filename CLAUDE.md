# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Public data-only registry for Motrix plugins. `plugins/<id>.json` entries are
validated by CI and aggregated into `dist/plugins.json`, which the publish
workflow uploads to the `motrix-registry` R2 bucket served at
`https://dl.motrix.app/registry/plugins.json`. Consumers: the
[motrix.app/plugins](https://motrix.app/plugins) directory and the Motrix
in-app marketplace.

## Hard rules

- **`schema/registry.ts` is the wire-contract source of truth.** Consumers
  vendor wire-equivalent tolerant schemas/resolvers and byte-identical copies
  of `schema/registry.fixture.json` and
  `schema/registry.conformance.json`. Corpus channels are independent:
  every consumer runs `wireExpected`, only this publisher runs
  `authoringExpected`, and App/website run `resolverExpected`.
- Registry v2 is already published and evolves additively. Never rename,
  retype, or remove a published field, endpoint, root version, or public
  filename.
- Consumer parsing is tolerant: safe profile locale tags, future category
  slugs, and unknown object fields survive parsing, except the known v1
  localized plugin-root fields `name`, `description`, and `features`, which are
  rejected explicitly. Publisher source is strict at every controlled object
  layer, pins canonical `Intl` locale spelling, and currently requires
  `listing.defaultLocale === "en-US"`. Never use the strict authoring schema in
  a consumer.
- Marketplace listing locales are open BCP 47 data and are independent of App
  resource `SupportedLocale`. Do not add fixed language properties or bind
  listing resolution to a runtime UI-locale enum. Adding `ja-JP` must remain
  a data-only change.
- Before a formal App/website release, run the shared resolver corpus in the
  exact shipping Electron and browser runtimes and record their ICU/CLDR
  versions. `Intl.Locale.maximize()` divergence is release-blocking even when
  the Node publisher suite passes.
- Policy (what may merge HERE) lives in `scripts/lib.ts` `validateEntry`,
  not in the wire schema: `motrix.*` namespace is builtin-only, community
  entries need a `package` pointer from the URL allowlist, categories must
  be registered, assets live under
  `https://dl.motrix.app/registry/assets/<id>/`.
- Do not hand-edit or commit `dist/plugins.json`. Aggregation must keep the
  stable `dist/plugins.json` filename, public URL, R2 `plugins.json` key,
  root `version: 2`, sorted ids, final newline, and 4 MiB UTF-8 byte gate.
- The website is deployed manually from its local repository. Registry
  publication must not require a website GitHub repository or website deploy
  credentials. Keep the registry URL and v2 contract compatible with both
  consumers.
- Build and validate the registry before the `plugin-publishing` environment
  approval. Publish only those exact immutable artifact bytes, verify their
  SHA-256 and schema after download, and reject a superseded `main` commit.
  Back up the previous object and conditionally replace it using its observed
  ETag; verify the uploaded bytes. Never rebuild or re-aggregate after approval.

## Commands

```bash
pnpm install
pnpm check       # tsc --noEmit
pnpm test        # vitest (fixture lockstep + policy tests)
pnpm validate    # CI gate over plugins/
pnpm aggregate   # build dist/plugins.json
```

Run all four before handing off. `pnpm test` also exercises the immutable
registry artifact validation used by the publish workflow.

## Documentation

Keep maintainer runbooks and private rollout plans in the configured Obsidian
documentation workspace, using the project's `pnpm run docs -- ...` gateway.
Do not add them to this public repository unless the user explicitly requests
a public document. Public documentation describes the reviewed wire and
release contracts without private deployment records or local paths.
