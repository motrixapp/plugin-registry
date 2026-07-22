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
  vendor byte-identical copies of the schema and of
  `schema/registry.fixture.json`. Any wire-shape change must land in
  lockstep with all consumers in the same PR cycle, and is additive-only —
  never rename, retype, or remove a published field.
- Policy (what may merge HERE) lives in `scripts/lib.ts` `validateEntry`,
  not in the wire schema: `motrix.*` namespace is builtin-only, community
  entries need a `package` pointer from the URL allowlist, categories must
  be registered, assets live under
  `https://dl.motrix.app/registry/assets/<id>/`.

## Commands

```bash
pnpm install
pnpm check       # tsc --noEmit
pnpm test        # vitest (fixture lockstep + policy tests)
pnpm validate    # CI gate over plugins/
pnpm aggregate   # build dist/plugins.json
```
