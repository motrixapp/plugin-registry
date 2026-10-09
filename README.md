# Motrix Plugin Registry

English | [简体中文](./README.zh-CN.md)

The public, data-only registry behind the Motrix plugin directory. Entries
merged here are aggregated into a single `plugins.json` and served at:

```
https://dl.motrix.app/registry/plugins.json
```

Two peer consumers read that file: the [motrix.app/plugins](https://motrix.app/plugins)
directory and the in-app marketplace of Motrix itself. A merge builds a
validated registry candidate; publication waits for the `plugin-publishing`
environment approval. The website is built and deployed separately by its
maintainer. This workflow publishes only registry data and assets.

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

Merges to `main` run `check → test → validate → aggregate` before approval.
The workflow uploads the exact `plugins.json` bytes as an immutable artifact
and records its SHA-256, size, artifact id, and source commit. After approval,
it downloads that artifact by id and verifies the bytes and v2 schema without
rebuilding.

The publisher rejects a superseded `main` commit, backs up the previous R2
object, uploads referenced assets from the reviewed commit, and replaces the
stable `plugins.json` key only if its observed ETag still matches. It checks
both the R2 readback and public endpoint against the approved SHA-256. The
website remains a separate manual deployment; no website repository or deploy
credentials are required by this workflow.

## Contract & lockstep

The tolerant wire schema and resolver in `schema/registry.ts` are the
**source of truth**. Consumers vendor wire-equivalent implementations plus
byte-identical copies of `schema/registry.fixture.json` and
`schema/registry.conformance.json`. The strict publisher-authoring schema is
deliberately narrower and is not a consumer contract. Even tolerant v2
consumers reject the known v1 plugin-root fields `name`, `description`, and
`features`, while unrelated future fields remain preserved. Registry v2
evolution is additive-only: never rename, retype, or remove a published field.

## Development

```bash
pnpm install
pnpm check       # TypeScript
pnpm test        # schema, corpus, policy, aggregation, release artifact integrity
pnpm validate    # what CI runs against plugins/
pnpm aggregate   # build dist/plugins.json locally
```

Do not hand-edit or commit `dist/plugins.json`. The public URL, root
`version: 2`, R2 key `plugins.json`, and output filename remain stable.
