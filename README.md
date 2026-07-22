# Motrix Plugin Registry

English | [简体中文](./README.zh-CN.md)

The public, data-only registry behind the Motrix plugin directory. Entries
merged here are aggregated into a single `plugins.json` and served at:

```
https://dl.motrix.app/registry/plugins.json
```

Two peer consumers read that file: the [motrix.app/plugins](https://motrix.app/plugins)
directory and the in-app marketplace of Motrix itself. New plugins go live
for both the moment the publish workflow finishes — no website or app
release required.

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
4. Open a PR. CI runs `pnpm validate` (schema + policy: id namespace,
   package allowlist, registered categories, asset prefixes). A maintainer
   review is the trust gate — the registry pins your package hash, so any
   new release needs a version-bump PR.

Rules enforced by CI:

- `id` is dot-namespaced lowercase (`author.plugin-name`); `motrix.*` is
  reserved for builtin plugins.
- `name`/`description` carry at least English; add `zh` if you can —
  consumers fall back to `en` automatically.
- `categories` must be registered in `schema/registry.ts` (PR a new slug
  first if none fits).
- Permission fields are a **preview** for the install consent screen; the
  actual grants always come from the manifest inside your package, and the
  app rejects packages whose manifest disagrees with the registry entry.

## How publishing works

Merges to `main` trigger `.github/workflows/publish.yml`:
validate → aggregate (`dist/plugins.json`, stamped with `generatedAt`) →
upload to the `motrix-registry` R2 bucket, together with `assets/`.
Consumers cache the file with ETags and keep a last-good copy, so a bad
deploy can never blank the directory.

## Contract & lockstep

The wire schema in `schema/registry.ts` is the **source of truth**;
consumers vendor byte-identical copies of the schema and of
`schema/registry.fixture.json`. Changing the wire shape means updating
every consumer in the same PR cycle, and evolution is additive-only:
never rename, retype, or remove a published field.

## Development

```bash
pnpm install
pnpm test        # fixture lockstep + entry policy tests
pnpm validate    # what CI runs against plugins/
pnpm aggregate   # build dist/plugins.json locally
```
