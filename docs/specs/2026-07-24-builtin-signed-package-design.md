# Builtin Signed Package (Phase 2) — Design

Date: 2026-07-24
Status: approved
Parent design: `motrix-turbo/docs/superpowers/specs/2026-07-18-builtin-plugin-independent-update-design.md` §2 (registry schema extension) and §5 (update check). This spec covers Phase 2 — the registry-side data + schema + policy + release automation that activates the (already-shipped, dormant) Phase 3 client in motrix-turbo.

## 1. Background & Goal

The Motrix builtin hot-update client (motrix-turbo Phase 3) is fully implemented but dormant: it only offers a builtin update when the registry entry carries a `package` block **with an Ed25519 `signature`** (the trust root). Today the registry's three builtin entries carry no `package` at all, and the registry's wire schema (`schema/registry.ts`, the source of truth) has no `signature` field. This Phase 2 closes that gap:

1. Add the optional `signature` field to the `package` block, in lockstep across all three vendored schema copies.
2. Populate real, verified `package` blocks for the three builtin entries.
3. Tighten repo policy so a builtin `package` without a `signature` cannot merge.
4. Automate future updates: a builtin-plugins signed release opens a registry PR.

## 2. Repo footprint (blast radius)

A wire-shape change (adding `signature`) is additive-only but must land in lockstep across the three vendored copies + their fixtures, per the hard rule in `CLAUDE.md`:

| Repo | Files | Change |
|------|-------|--------|
| **plugin-registry** (primary) | `schema/registry.ts`, `schema/registry.fixture.json`, `scripts/lib.ts`, `scripts/entry-from-release.ts` (new), `.github/workflows/*` (new/edit), `plugins/motrix.*.json` (×3), `tests/*` | schema + policy + data + generator + CI + tests |
| **motrix-website** | `src/data/plugins.ts`, `src/data/registry.fixture.json` | lockstep: add `signature`, sync fixture |
| **motrix-turbo** | `src/shared/schemas/registry.fixture.json` (reconcile), verify `src/shared/schemas/registry.ts` | already has `signature`; only fixture reconciliation |
| **builtin-plugins** | `.github/workflows/release.yml` | append a `repository_dispatch` step notifying plugin-registry after a successful signed release |

**Current lockstep state is already broken**: motrix-turbo (via its Phase-1B work) added `signature` to its vendored schema and a placeholder builtin entry to its fixture, ahead of the source of truth. Phase 2 reconciles all three to be byte-identical again.

## 3. Schema change (source of truth)

In `plugin-registry/schema/registry.ts`, the `package` object gains one optional field, **byte-identical to what motrix-turbo already vendored**:

```ts
package: z
  .object({
    url: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive(),
    // Phase 2 of the builtin independent-update design: detached ed25519
    // signature (base64) over the .moext bytes. THE trust boundary for
    // builtin hot updates; sha256 above is a pre-check only.
    signature: z.string().min(1).optional(),
  })
  .optional(),
```

The same additive field lands in `motrix-website/src/data/plugins.ts`'s `package` block. **`minMotrix` is deliberately NOT added** — the parent design mentioned it, but motrix-turbo vendored only `signature` and uses the existing `engines.motrix` for the compatibility gate; adding `minMotrix` now would re-introduce drift for no consumer benefit.

Field stays `.optional()` at the wire level (community packages have no signature; the requirement is repo policy, §4). Additive-only: no existing field renamed/retyped/removed.

## 4. Policy change (`scripts/lib.ts` `validateEntry`)

Add one rule to the repo-merge policy (the wire schema stays permissive; policy gates what may merge HERE):

- **If `entry.origin === 'builtin'` and `entry.package` is present, `entry.package.signature` MUST be present.** A builtin package without a signature cannot be hot-updated by the client (`BuiltinUpdater` rejects it with `builtin_no_signature`) and is a latent trust hole — reject it at merge.

Not changed: builtins are NOT required to have a package (a builtin not yet released independently may omit it); community entries keep their existing rule (package required, signature not required); the `PACKAGE_URL_ALLOWLIST` already accepts the GitHub Releases download URLs the builtins use.

## 5. Real builtin data

Populate a `package` block on each of the three builtin entries. Versions already match the released tags and the motrix-turbo lockfile (`scripts/builtins.lock.json`) — no version bump needed:

| id | version | tag | sha256 / size | source |
|----|---------|-----|---------------|--------|
| motrix.filename-template | 1.0.1 | `motrix.filename-template@1.0.1` | `d7c2…815d` / 2085 | released |
| motrix.scraper-hook | 1.0.0 | `motrix.scraper-hook@1.0.0` | `2b6d…cb25` / 2218 | released |
| motrix.url-resolver | 1.0.0 | `motrix.url-resolver@1.0.0` | `308d…4a9e` / 3161 | released |

`package.url` = `https://github.com/motrixapp/builtin-plugins/releases/download/<url-encoded-tag>/<id>-<version>.moext`. `sha256`/`size` come from each release's `.metadata.json` (equal to the lockfile). `signature` (base64) comes from the release's `.moext.sig` sidecar.

**Invariant — never hand-transcribe the data.** The values are produced by the generator script (§6), which reads the release assets and **verifies the signature against `keys/signing-key.pub.pem` before writing**. A signature that does not verify aborts the write. This is the same verification `builtin-plugins/scripts/verify.mjs` performs and the same key motrix-turbo pins.

## 6. Generator script (`scripts/entry-from-release.ts`)

One script, two callers (CI + the one-time initial population — DRY):

Input: a plugin id + tag (e.g. `motrix.url-resolver@1.0.0`). Sources, in order:
1. A local artifact dir override (env `MOTRIX_BUILTIN_ARTIFACT_DIR`, containing `<file>.moext`, `<file>.moext.sig`, `<file>.metadata.json`) — used for the one-time offline population and tests.
2. Otherwise, download the three public release assets from GitHub Releases for that tag.

Steps:
1. Read/parse `.metadata.json` → `{ id, version, file, sha256, size }`; assert `id`/`version` match the tag.
2. Recompute sha256 over the `.moext` bytes and assert it equals the metadata sha256 (never trust the metadata alone — mirrors the motrix-turbo lockfile discipline).
3. Read the base64 signature from `.moext.sig`; `crypto.verify('ed25519', bytes, publicKey, sig)` against `keys/signing-key.pub.pem`; abort on failure.
4. Load the existing `plugins/<id>.json`, patch **only** `version` + `package { url, sha256, size, signature }` (leave name/description/categories/engines/permissions/features/etc. untouched), write it back, and re-run `validateEntry` on the result.

Reused now: run it against a local artifact dir assembled from the verified release artifacts to write the three initial `package` blocks.

## 7. CI automation (dispatch-to-registry model)

Minimize cross-repo credentials — the PR is created by plugin-registry's own `GITHUB_TOKEN`; the only cross-repo credential is the dispatch trigger.

```
builtin-plugins .github/workflows/release.yml  (after the sign job's gh release create succeeds)
  → repository_dispatch (event_type: builtin-released, payload { id, version, tag })
     to motrixapp/plugin-registry
plugin-registry .github/workflows/registry-entry-update.yml
  on: repository_dispatch (types: [builtin-released]) AND workflow_dispatch (manual: id, tag inputs)
  → checkout, pnpm install
  → node scripts/entry-from-release.ts <id> <tag>   (downloads public assets, verifies, patches)
  → pnpm validate && pnpm test                        (self-gate before PR)
  → create a branch + PR via peter-evans/create-pull-request (or gh) using GITHUB_TOKEN
  → existing validate/test/lockstep CI runs on the PR; a human merges
```

- **Credential required (out-of-band, user-provisioned)**: a token in builtin-plugins with permission to send a `repository_dispatch` to `motrixapp/plugin-registry` (a fine-scoped PAT or a GitHub App installation token), stored as the secret `REGISTRY_DISPATCH_TOKEN`. The workflow references it; provisioning it is a repo-admin action outside this change. Until it is set, the plugin-registry workflow is still usable via `workflow_dispatch` (manual id+tag), so the feature is not blocked on the secret.
- The generator's download path needs no auth (release assets are public).
- The PR path uses the workflow's native `GITHUB_TOKEN` (contents+PR write on its own repo) — enable "Allow GitHub Actions to create and approve pull requests" in plugin-registry settings (also a one-time repo-admin toggle; documented).

## 8. Fixture lockstep

All three `registry.fixture.json` copies must be byte-identical and must include a builtin entry exercising the `signature` field (schema round-trip coverage). motrix-turbo already has a placeholder `motrix.url-resolver` builtin entry with a synthetic sha256/signature; adopt that same entry (byte-identical) into plugin-registry's and motrix-website's fixtures. The fixture is schema-validation test data — a synthetic signature string is acceptable and keeps the fixture stable; it is NOT real registry data.

## 9. Testing

- **plugin-registry**: `pnpm check` (tsc), `pnpm test` (fixture lockstep + policy), `pnpm validate` (CI gate over `plugins/`), `pnpm aggregate` (builds `dist/plugins.json`). New tests: policy rejects a builtin with a package but no signature; `entry-from-release.ts` verifies-before-write (a tampered `.moext` or wrong-key signature aborts, nothing written); the three real entries pass `validateEntry` and aggregate cleanly.
- **motrix-website**: `tsc`/test confirm the schema+fixture edit parses; no consumer regression.
- **motrix-turbo**: existing `registry.test.ts` + full suite stay green after the fixture reconciliation.
- **Cross-repo lockstep check**: the `package` block of all three schema copies and all three fixtures are byte-identical (a small diff assertion, run manually or scripted).

## 10. Out of scope

- Adding `minMotrix` (see §3).
- Signing infrastructure / private-key handling — owned by builtin-plugins; unchanged here.
- Community-plugin registry submission flow — unchanged.
- Any change to the client-side hot-update logic (Phase 3, already shipped in motrix-turbo).
