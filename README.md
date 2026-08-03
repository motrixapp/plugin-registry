# Motrix Plugin Registry

English | [简体中文](./README.zh-CN.md)

The public, data-only registry behind the Motrix plugin directory. Entries
merged here are aggregated into a single `plugins.json` and served at:

```
https://dl.motrix.app/registry/plugins.json
```

Two peer consumers read that file: the [motrix.app/plugins](https://motrix.app/plugins)
directory and the in-app marketplace of Motrix itself. A merge is not an
instant publish: one approval-gated release coordinator verifies the registry,
builds the website against those exact bytes, and promotes both attested
artifacts together. No App binary is produced by that workflow.

## Submitting a plugin

1. Fork this repo and add **one file**: `plugins/<your.plugin-id>.json`.
   The filename must equal the plugin `id`. Start from an existing entry
   or the annotated schema in [`schema/registry.ts`](schema/registry.ts).
2. Community entries must include a `package` block — an `https` URL to a
   GitHub release asset (or dl.motrix.app), its `sha256`, and `size`.
   Motrix verifies the hash before unpacking and refuses mismatches.
3. Icons/screenshots are optional. Put files under `assets/<your.plugin-id>/`
   and reference them by their published URL:
   `https://dl.motrix.app/registry/assets/<your.plugin-id>/<file>`.
4. Put editorial text under `listing`. Publisher policy currently requires
   `defaultLocale: "en-US"`; that default record must contain `name` and
   `description`. Other canonical BCP 47 keys may be sparse:

   ```json
   {
     "listing": {
       "defaultLocale": "en-US",
       "localizations": {
         "en-US": { "name": "Example", "description": "Example plugin" },
         "zh-CN": { "name": "示例" },
         "ja-JP": { "description": "サンプルプラグイン" }
       }
     }
   }
   ```

5. Open a PR. CI runs typecheck, tests, validation, aggregation, and the final
   UTF-8 artifact-size gate. A maintainer
   review is the trust gate — the registry pins your package hash, so any
   new release needs a version-bump PR.

Rules enforced by CI:

- `id` is dot-namespaced lowercase (`author.plugin-name`); `motrix.*` is
  reserved for builtin plugins.
- Locale keys are canonical BCP 47 tags without extensions/private use.
  Adding a language such as `ja-JP` is data-only and requires no schema edit.
  Consumers resolve each field independently through exact, structural parent,
  inferred language-script, language, then default fallback; an explicit empty
  list is an intentional override.
- `categories` must be registered in `schema/registry.ts` (PR a new slug
  first if none fits).
- Permission fields are a **preview** for the install consent screen; the
  actual grants always come from the manifest inside your package, and the
  app rejects packages whose manifest disagrees with the registry entry.

## How publishing works

Merges to `main` enter one serialized coordinator DAG. It runs
`check → test → validate → aggregate` once, uploads immutable candidate bytes
as the sole root `plugins.json` in a ZIP plus their payload/archive
SHA-256/run/artifact identity, and gives only its safe extraction to the
website build. A no-write preflight rejects split, mismatched, or superseded
artifacts.
After the `plugin-publishing` environment approval, the job repeats preflight,
backs up the current R2 object, deploys the matching prebuilt website without
rebuilding, and only then conditionally writes the same candidate to the stable
`plugins.json` key. It verifies the direct and cache-busted public SHA/ETag and
retains the release record for coordinated restore. See
[the cutover runbook](docs/registry-cutover-runbook.md).

## Contract & lockstep

The tolerant wire schema and resolver in `schema/registry.ts` are the
**source of truth**. Consumers vendor wire-equivalent implementations plus
byte-identical copies of `schema/registry.fixture.json` and
`schema/registry.conformance.json`. The strict publisher-authoring schema is
deliberately narrower and is not a consumer contract. Registry v2 is a clean
break from the unpublished fixed-language draft: the known v1 plugin-root
fields `name`, `description`, and `features` are rejected even by tolerant
consumers, while unrelated future fields remain preserved. Registry v2
evolution is additive-only: never rename, retype, or remove a published field.

## Development

```bash
pnpm install
pnpm check       # TypeScript
pnpm test        # schema, corpus, policy, aggregation, release contracts
pnpm validate    # what CI runs against plugins/
pnpm aggregate   # build dist/plugins.json locally
```

Do not hand-edit or commit `dist/plugins.json`. The public URL, root
`version: 2`, R2 key `plugins.json`, and output filename remain stable.
