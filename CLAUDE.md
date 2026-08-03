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
- The pre-release fixed `{ en, zh? }` draft was intentionally reset with a
  clean break to registry v2. Registry v2 now resumes additive-only evolution:
  never rename, retype, or remove a
  published field, endpoint, root version, or public filename.
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
- Production release/restore code must use `scripts/release-contract.ts`.
  Build registry and website artifacts once, download them by exact workflow
  run/artifact id, verify archive SHA plus exact ZIP layout, and consume only
  fresh-directory safe extraction output. The registry ZIP contains only root
  `plugins.json`; the website ZIP contains only the root strict manifest and
  `dist/**`. Reject superseded candidates, split inputs, and registry/website
  mismatch, then deploy prebuilt website output without rebuilding. Persist an
  immutable publish/restore intent and its exact operation artifacts before the
  first cross-service mutation; retries may continue only the intent's strict
  `cas` or `resume` state. `ReleaseManifest` and `RestoreManifest` are strict
  internal v2 contracts. Restore directions are complete registry-v2 tuples whose
  completion artifact wrapper separates its raw `artifactSha256` from the inner
  `manifestSha256`; sources are either one completion-attested GitHub generation
  or one direct-parent R2 operation generation. A pre-write `cas` may fill any
  missing subset of a strictly verified initial restore journal, but readback
  and every `resume` require the complete set. Post-transition completion binds
  the full restore workflow identity and observed ETags; the reverse manifest
  has no self hash and is rebuilt deterministically from its direct-parent
  intent and completion. Never predict a target ETag. The first registry-v2
  cutover is forward-only: retain the bounded opaque previous live bytes for
  exact backup/CAS and forensics, but never parse or restore them. App
  source/build notes are non-attesting operator evidence
  and must never hard-gate remote writes.

## Commands

```bash
pnpm install
pnpm check       # tsc --noEmit
pnpm test        # vitest (fixture lockstep + policy tests)
pnpm validate    # CI gate over plugins/
pnpm aggregate   # build dist/plugins.json
```

Run all four before handing off. `pnpm test` also exercises release/restore
manifest preflight and the cross-repository directory-hash vector.
