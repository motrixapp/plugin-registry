# Builtin Signed Package (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the registry's three builtin plugin entries a signed `package` block (Ed25519 `signature` field), in lockstep across all vendored schema copies, with a generator script + CI that keeps them updated from builtin-plugins releases — activating the dormant builtin hot-update client in motrix-turbo.

**Architecture:** Additive wire-schema change (`package.signature`, optional) landed byte-identical in three repos; a repo-merge policy that requires the signature on builtin packages; a `tsx` generator that fetches/verifies a release and patches an entry (reused by CI and by the one-time data population); a dispatch-to-registry CI flow where builtin-plugins notifies plugin-registry, which opens a self-gated PR with its own token.

**Tech Stack:** TypeScript run via `tsx`, Zod 4, vitest, Node 24 `node:crypto` (ed25519), GitHub Actions.

**Spec:** `docs/specs/2026-07-24-builtin-signed-package-design.md` (+ `.zh-CN.md`)

## Global Constraints

- **Lockstep (hard rule):** `plugin-registry/schema/registry.ts` is the wire-contract source of truth; `motrix-website/src/data/plugins.ts` and `motrix-turbo/src/shared/schemas/registry.ts` vendor byte-identical copies, together with a byte-identical `registry.fixture.json`. Any wire-shape change lands in all three in one cycle; **additive-only** — never rename/retype/remove a published field.
- The `signature` field must be exactly `signature: z.string().min(1).optional()` inside the `package` object — matching what motrix-turbo already vendored.
- **Do NOT add `minMotrix`** (see spec §3).
- **Signature data is never hand-transcribed** — it is produced by the generator, which verifies it against `keys/signing-key.pub.pem` (the same Ed25519 key motrix-turbo pins) before writing. A signature that does not verify aborts the write.
- Per-repo gates (run in the repo you edited): plugin-registry `pnpm check && pnpm test && pnpm validate`; motrix-website `pnpm exec tsc --noEmit && pnpm test` (or the repo's equivalent — check its package.json); motrix-turbo `pnpm exec tsc --noEmit && pnpm exec vitest run src/shared/schemas/`.
- Conventional Commits, English, no AI attribution lines. Each repo gets its own commit(s) on its own feature branch.
- Repos & branches: plugin-registry on `feature/builtin_signed_package_20260724` (already created). motrix-website / motrix-turbo / builtin-plugins each need their own `feature/builtin_signed_package_20260724` branch created from their default branch before editing.

## The canonical fixture

Tasks 1, 5, 6 all write the SAME `registry.fixture.json`. Define it once here: it is **motrix-turbo's current `src/shared/schemas/registry.fixture.json` with exactly one edit** — the builtin `motrix.url-resolver` entry's `"categories": ["network"]` changed to `"categories": ["integration"]`. Rationale: motrix-website's schema enforces categories via `z.enum(pluginCategoryKeys)` where the registered keys are `site-resolver | post-action | automation | integration` — `"network"` is not among them and would fail website's parse; `"integration"` is valid in all three schemas. Everything else in that fixture (the two community entries, the builtin entry's placeholder `sha256` of 64 `a`s, `size` 12345, `signature` `"c2lnbmF0dXJl"`, `engines.motrix` `"^2.0.0"`) stays byte-identical. The builtin entry's placeholder values are synthetic schema-test data — NOT real registry data (§8 of the spec).

---

### Task 1: plugin-registry — schema `signature` field + canonical fixture

**Files:**
- Modify: `schema/registry.ts` (the `package` object)
- Modify: `schema/registry.fixture.json` (adopt the canonical fixture — grows from 2 to 3 plugins)
- Modify: `tests/registry.test.ts` (fixture length 2→3 + signature-preserved assertion)

**Interfaces:**
- Produces: `RegistryPluginSchema.package` now accepts an optional `signature: string`. `RegistryFileSchema` parse of the shared fixture yields 3 plugins including a builtin with `package.signature` defined.

- [ ] **Step 1: Write the failing assertions** — in `tests/registry.test.ts`, update the `contract fixture (lockstep)` block:

```ts
  it('parses unchanged', () => {
    const parsed = RegistryFileSchema.parse(fixture)
    expect(parsed.plugins).toHaveLength(3)
    // Guards that the vendored schema actually carries the Phase-2
    // signature field (Zod would otherwise silently strip it).
    const builtin = parsed.plugins.find((p) => p.id === 'motrix.url-resolver')
    expect(builtin?.package?.signature).toBe('c2lnbmF0dXJl')
  })
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm test`
Expected: FAIL — current fixture has 2 plugins, and `signature` is stripped by the current schema (so the builtin lookup/assertion fails).

- [ ] **Step 3: Add the `signature` field** — in `schema/registry.ts`, the `package` object becomes:

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

Also update the `package` comment above it from "absent for builtins, which ship with the app" to "Historically absent for builtins; builtin entries carry it (plus `signature`) for independent hot updates."

- [ ] **Step 4: Adopt the canonical fixture** — overwrite `schema/registry.fixture.json` with the canonical fixture (see "The canonical fixture" above): copy `motrix-turbo/src/shared/schemas/registry.fixture.json` verbatim, then change the builtin entry's `"categories": ["network"]` to `"categories": ["integration"]`. Verify it is valid JSON.

- [ ] **Step 5: Run — verify it passes**

Run: `pnpm test`
Expected: PASS (the fixture block; other suites unaffected).

- [ ] **Step 6: Gates + commit**

```bash
pnpm check && pnpm test
git add schema/registry.ts schema/registry.fixture.json tests/registry.test.ts
git commit -m "feat: add optional package.signature to the registry wire schema"
```

---

### Task 2: plugin-registry — builtin package signature policy

**Files:**
- Modify: `scripts/lib.ts` (`validateEntry`)
- Modify: `tests/registry.test.ts` (policy tests)

**Interfaces:**
- Consumes: the `signature` field from Task 1.
- Produces: `validateEntry` reports a problem when `origin === 'builtin'` && `package` present && `package.signature` absent.

- [ ] **Step 1: Write the failing tests** — add to the `validateEntry policy` describe in `tests/registry.test.ts`:

```ts
  it('requires a signature on a builtin package', () => {
    const { problems } = validateEntry('motrix.demo.json', {
      ...base,
      id: 'motrix.demo',
      origin: 'builtin',
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
      },
    })
    expect(
      problems.some((p) => /builtin package.*signature|signature/.test(p.message))
    ).toBe(true)
  })

  it('accepts a builtin package that carries a signature', () => {
    const { problems } = validateEntry('motrix.demo.json', {
      ...base,
      id: 'motrix.demo',
      origin: 'builtin',
      categories: ['integration'],
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
        signature: 'c2ln',
      },
    })
    expect(problems).toEqual([])
  })
```

- [ ] **Step 2: Run — verify the first fails**

Run: `pnpm test`
Expected: FAIL — no signature rule yet, so the builtin-without-signature entry reports no problem.

- [ ] **Step 3: Implement the rule** — in `scripts/lib.ts` `validateEntry`, after the existing `entry.origin === 'community' && !entry.package` check, add:

```ts
  if (
    entry.origin === 'builtin' &&
    entry.package &&
    !entry.package.signature
  ) {
    problems.push({
      file,
      message:
        'a builtin package must carry an ed25519 signature (hot-update trust root)',
    })
  }
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm test`
Expected: PASS (both new tests + all existing).

- [ ] **Step 5: Gates + commit**

```bash
pnpm check && pnpm test
git add scripts/lib.ts tests/registry.test.ts
git commit -m "feat: require an ed25519 signature on builtin package entries"
```

---

### Task 3: plugin-registry — `entry-from-release.ts` generator

**Files:**
- Create: `scripts/entry-from-release.ts`
- Create: `tests/entry-from-release.test.ts`
- Modify: `package.json` (add `"entry:from-release": "tsx scripts/entry-from-release.ts"`)

**Interfaces:**
- Consumes: `RegistryPluginSchema` / `validateEntry`; `node:crypto` ed25519 verify; the Ed25519 public key. NOTE: plugin-registry does not yet contain the public key — the generator reads it from an env-provided path or a repo-local `keys/signing-key.pub.pem`. **This task also copies `builtin-plugins/keys/signing-key.pub.pem` into `plugin-registry/keys/signing-key.pub.pem`** (byte-identical) so the generator and CI have a pinned local trust anchor. Verify it matches `motrix-turbo/scripts/builtins-signing.pub.pem`.
- Produces:
  - `export interface ReleaseArtifacts { moext: Buffer; metadata: { id: string; version: string; file: string; sha256: string; size: number }; signatureB64: string }`
  - `export function buildPackageBlock(a: ReleaseArtifacts, tag: string, pubPem: string): { version: string; package: { url: string; sha256: string; size: number; signature: string } }` — recomputes sha256 over `moext`, asserts it equals `metadata.sha256`, verifies the signature against `pubPem` (throws on any mismatch), and returns the version + package block. The `url` is `https://github.com/motrixapp/builtin-plugins/releases/download/${encodeURIComponent(tag)}/${metadata.file}`.
  - `export async function patchEntry(id: string, block: ...): Promise<void>` — loads `plugins/<id>.json`, sets `version` + `package`, writes it back (2-space indent + trailing newline), then re-runs `validateEntry` and throws if it reports problems.
  - A CLI entry (`if (import.meta.url === ...)`) reading `<id> <tag>`, resolving artifacts from `MOTRIX_BUILTIN_ARTIFACT_DIR` if set (files `<file>`, `<file>.sig`, `<basename>.metadata.json`) else downloading the three release assets, then `patchEntry`.

- [ ] **Step 1: Write the failing tests** — `tests/entry-from-release.test.ts`. Build a tiny real ed25519 keypair in-test, sign some bytes, and drive `buildPackageBlock`:

```ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPackageBlock, type ReleaseArtifacts } from '../scripts/entry-from-release.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const moext = Buffer.from('fake-moext-bytes')
const sha256 = createHash('sha256').update(moext).digest('hex')

function artifacts(over: Partial<ReleaseArtifacts> = {}): ReleaseArtifacts {
  return {
    moext,
    metadata: {
      id: 'motrix.url-resolver',
      version: '1.0.0',
      file: 'motrix.url-resolver-1.0.0.moext',
      sha256,
      size: moext.byteLength,
    },
    signatureB64: sign(null, moext, privateKey).toString('base64'),
    ...over,
  }
}
const TAG = 'motrix.url-resolver@1.0.0'

describe('buildPackageBlock', () => {
  it('returns a verified package block for a good release', () => {
    const r = buildPackageBlock(artifacts(), TAG, PUB)
    expect(r.version).toBe('1.0.0')
    expect(r.package.sha256).toBe(sha256)
    expect(r.package.size).toBe(moext.byteLength)
    expect(r.package.signature).toBe(artifacts().signatureB64)
    expect(r.package.url).toBe(
      'https://github.com/motrixapp/builtin-plugins/releases/download/motrix.url-resolver%401.0.0/motrix.url-resolver-1.0.0.moext'
    )
  })

  it('aborts when the signature does not verify (wrong key)', () => {
    const other = generateKeyPairSync('ed25519')
    const bad = sign(null, moext, other.privateKey).toString('base64')
    expect(() =>
      buildPackageBlock(artifacts({ signatureB64: bad }), TAG, PUB)
    ).toThrow(/signature/i)
  })

  it('aborts when sha256 disagrees with the bytes', () => {
    expect(() =>
      buildPackageBlock(
        artifacts({ metadata: { ...artifacts().metadata, sha256: 'b'.repeat(64) } }),
        TAG,
        PUB
      )
    ).toThrow(/sha256/i)
  })

  it('aborts when the tag does not match the metadata id/version', () => {
    expect(() => buildPackageBlock(artifacts(), 'motrix.url-resolver@9.9.9', PUB)).toThrow(
      /version|tag/i
    )
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm exec vitest run tests/entry-from-release.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/entry-from-release.ts`**

```ts
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateEntry } from './lib.ts'

export interface ReleaseArtifacts {
  moext: Buffer
  metadata: {
    id: string
    version: string
    file: string
    sha256: string
    size: number
  }
  signatureB64: string
}

export interface PackageBlock {
  version: string
  package: { url: string; sha256: string; size: number; signature: string }
}

const RELEASE_BASE = 'https://github.com/motrixapp/builtin-plugins/releases/download'

/**
 * Turn verified release artifacts into the entry's version + package block.
 * The ed25519 signature is THE trust decision; sha256/size are pre-checks.
 * Any mismatch throws — nothing downstream writes an unverified package.
 */
export function buildPackageBlock(
  a: ReleaseArtifacts,
  tag: string,
  pubPem: string
): PackageBlock {
  const [tagId, tagVersion] = tag.split('@')
  if (a.metadata.id !== tagId || a.metadata.version !== tagVersion) {
    throw new Error(
      `tag ${tag} does not match metadata ${a.metadata.id}@${a.metadata.version}`
    )
  }
  const digest = createHash('sha256').update(a.moext).digest('hex')
  if (digest !== a.metadata.sha256) {
    throw new Error(
      `sha256 mismatch: bytes ${digest} != metadata ${a.metadata.sha256}`
    )
  }
  if (a.moext.byteLength !== a.metadata.size) {
    throw new Error(
      `size mismatch: bytes ${a.moext.byteLength} != metadata ${a.metadata.size}`
    )
  }
  let ok = false
  try {
    ok = verify(
      null,
      a.moext,
      createPublicKey(pubPem),
      Buffer.from(a.signatureB64, 'base64')
    )
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`ed25519 signature does not verify for ${tag}`)
  return {
    version: a.metadata.version,
    package: {
      url: `${RELEASE_BASE}/${encodeURIComponent(tag)}/${a.metadata.file}`,
      sha256: a.metadata.sha256,
      size: a.metadata.size,
      signature: a.signatureB64,
    },
  }
}

const PLUGINS_DIR = new URL('../plugins/', import.meta.url).pathname

export async function patchEntry(id: string, block: PackageBlock): Promise<void> {
  const file = path.join(PLUGINS_DIR, `${id}.json`)
  const entry = JSON.parse(await readFile(file, 'utf8'))
  entry.version = block.version
  entry.package = block.package
  const problems = validateEntry(`${id}.json`, entry).problems
  if (problems.length > 0) {
    throw new Error(
      `patched ${id}.json fails policy:\n${problems.map((p) => p.message).join('\n')}`
    )
  }
  await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`)
}

async function loadArtifacts(
  id: string,
  tag: string
): Promise<ReleaseArtifacts> {
  const version = tag.split('@')[1]
  const file = `${id}-${version}.moext`
  const localDir = process.env.MOTRIX_BUILTIN_ARTIFACT_DIR
  if (localDir) {
    const moext = await readFile(path.join(localDir, file))
    const metadata = JSON.parse(
      await readFile(path.join(localDir, `${id}-${version}.metadata.json`), 'utf8')
    )
    const signatureB64 = (
      await readFile(path.join(localDir, `${file}.sig`), 'utf8')
    ).trim()
    return { moext, metadata, signatureB64 }
  }
  const base = `${RELEASE_BASE}/${encodeURIComponent(tag)}`
  const [moextRes, metaRes, sigRes] = await Promise.all([
    fetch(`${base}/${file}`),
    fetch(`${base}/${id}-${version}.metadata.json`),
    fetch(`${base}/${file}.sig`),
  ])
  for (const [res, what] of [
    [moextRes, 'moext'],
    [metaRes, 'metadata'],
    [sigRes, 'sig'],
  ] as const) {
    if (!res.ok) throw new Error(`download ${what} failed: ${res.status}`)
  }
  return {
    moext: Buffer.from(await moextRes.arrayBuffer()),
    metadata: await metaRes.json(),
    signatureB64: (await sigRes.text()).trim(),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, tag] = process.argv.slice(2)
  if (!id || !tag) {
    console.error('usage: entry-from-release.ts <id> <tag>')
    process.exit(2)
  }
  const pubPem = await readFile(
    new URL('../keys/signing-key.pub.pem', import.meta.url),
    'utf8'
  )
  const artifacts = await loadArtifacts(id, tag)
  const block = buildPackageBlock(artifacts, tag, pubPem)
  await patchEntry(id, block)
  console.log(`[entry-from-release] patched ${id}.json -> ${block.version}`)
}
```

- [ ] **Step 4: Copy the pinned public key** — `cp ../builtin-plugins/keys/signing-key.pub.pem keys/signing-key.pub.pem` (create `keys/`), and verify byte-identity with `motrix-turbo/scripts/builtins-signing.pub.pem`:

```bash
mkdir -p keys && cp ../builtin-plugins/keys/signing-key.pub.pem keys/signing-key.pub.pem
diff keys/signing-key.pub.pem ../motrix-turbo/scripts/builtins-signing.pub.pem && echo "KEY MATCHES"
```

- [ ] **Step 5: Add the package.json script**

```json
    "entry:from-release": "tsx scripts/entry-from-release.ts",
```

- [ ] **Step 6: Run — verify tests pass**

Run: `pnpm exec vitest run tests/entry-from-release.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Gates + commit**

```bash
pnpm check && pnpm test
git add scripts/entry-from-release.ts tests/entry-from-release.test.ts package.json keys/signing-key.pub.pem
git commit -m "feat: add signature-verifying release-to-entry generator"
```

---

### Task 4: plugin-registry — populate the three builtin package blocks

**Files:**
- Modify: `plugins/motrix.filename-template.json`, `plugins/motrix.scraper-hook.json`, `plugins/motrix.url-resolver.json` (add `package` blocks — via the generator, not by hand)

**Interfaces:**
- Consumes: `scripts/entry-from-release.ts` (Task 3), the real signed artifacts.

- [ ] **Step 1: Assemble a local verified artifact dir.** The real `.moext` + `.metadata.json` live in `builtin-plugins/dist/artifacts/`; the real `.moext.sig` sidecars live in `motrix-turbo/node_modules/.cache/motrix-builtins/`. Assemble one dir with all three files per plugin (for the 3 pinned tags: `motrix.filename-template@1.0.1`, `motrix.scraper-hook@1.0.0`, `motrix.url-resolver@1.0.0`). Example:

```bash
mkdir -p /tmp/mreg-artifacts
# .moext + .metadata.json from builtin-plugins
cp ../builtin-plugins/dist/artifacts/motrix.filename-template-1.0.1.moext /tmp/mreg-artifacts/
cp ../builtin-plugins/dist/artifacts/motrix.filename-template-1.0.1.metadata.json /tmp/mreg-artifacts/
cp ../builtin-plugins/dist/artifacts/motrix.scraper-hook-1.0.0.moext /tmp/mreg-artifacts/
cp ../builtin-plugins/dist/artifacts/motrix.scraper-hook-1.0.0.metadata.json /tmp/mreg-artifacts/
cp ../builtin-plugins/dist/artifacts/motrix.url-resolver-1.0.0.moext /tmp/mreg-artifacts/
cp ../builtin-plugins/dist/artifacts/motrix.url-resolver-1.0.0.metadata.json /tmp/mreg-artifacts/
# .sig sidecars from the motrix-turbo fetch cache
cp ../motrix-turbo/node_modules/.cache/motrix-builtins/motrix.filename-template-1.0.1.moext.sig /tmp/mreg-artifacts/
cp ../motrix-turbo/node_modules/.cache/motrix-builtins/motrix.scraper-hook-1.0.0.moext.sig /tmp/mreg-artifacts/
cp ../motrix-turbo/node_modules/.cache/motrix-builtins/motrix.url-resolver-1.0.0.moext.sig /tmp/mreg-artifacts/
ls -la /tmp/mreg-artifacts
```

If any file is missing from those locations, STOP and report — do not fabricate. (Alternative: run with no `MOTRIX_BUILTIN_ARTIFACT_DIR` to download from GitHub Releases, if the environment has network.)

- [ ] **Step 2: Run the generator for each plugin**

```bash
MOTRIX_BUILTIN_ARTIFACT_DIR=/tmp/mreg-artifacts pnpm entry:from-release motrix.filename-template motrix.filename-template@1.0.1
MOTRIX_BUILTIN_ARTIFACT_DIR=/tmp/mreg-artifacts pnpm entry:from-release motrix.scraper-hook motrix.scraper-hook@1.0.0
MOTRIX_BUILTIN_ARTIFACT_DIR=/tmp/mreg-artifacts pnpm entry:from-release motrix.url-resolver motrix.url-resolver@1.0.0
```

Each must print `patched ... -> <version>` and exit 0 (signature verified). If any aborts on a signature/sha mismatch, STOP and report — the artifact is wrong, do not force it.

- [ ] **Step 3: Verify the entries** — confirm each `plugins/*.json` now has a `package` with a real `url` (GitHub Releases), `sha256` (matching the lockfile in `../motrix-turbo/scripts/builtins.lock.json`), `size`, and a base64 `signature`. Spot-check the sha256 values equal the lockfile's.

- [ ] **Step 4: Full plugin-registry gates**

```bash
pnpm check && pnpm test && pnpm validate && pnpm aggregate
```

Expected: `published entries` test green (all three pass `validateEntry` incl. the new signature policy); `validate` PASS; `aggregate` writes `dist/plugins.json` with the three signed builtins. (`dist/` is git-ignored — do not commit it.)

- [ ] **Step 5: Commit**

```bash
git add plugins/motrix.filename-template.json plugins/motrix.scraper-hook.json plugins/motrix.url-resolver.json
git commit -m "feat: publish signed package blocks for the three builtin plugins"
```

---

### Task 5: motrix-website — lockstep schema + fixture

**Files (in `../motrix-website`):**
- Modify: `src/data/plugins.ts` (`package` object gets `signature`)
- Modify: `src/data/registry.fixture.json` (adopt the canonical fixture)
- Modify: `src/data/plugins.test.ts` (fixture length 2→3 + signature assertion)

**Interfaces:**
- Consumes: the canonical fixture (identical to Task 1's).

- [ ] **Step 1: Create the branch** — `git -C ../motrix-website checkout -b feature/builtin_signed_package_20260724` (from its default branch; verify clean first).

- [ ] **Step 2: Write the failing assertion** — in `src/data/plugins.test.ts`'s `registry contract fixture` block, change `toHaveLength(2)` to `toHaveLength(3)` and add:

```ts
    const builtin = parsed.plugins.find((p) => p.id === 'motrix.url-resolver')
    expect(builtin?.package?.signature).toBe('c2lnbmF0dXJl')
```

- [ ] **Step 3: Run — verify it fails** (`pnpm test` in motrix-website; signature stripped + wrong length).

- [ ] **Step 4: Add `signature` to the schema** — in `src/data/plugins.ts`, the `package` object inside `PluginEntrySchema` gains the same `signature: z.string().min(1).optional()` field with the same comment as Task 1 Step 3.

- [ ] **Step 5: Adopt the canonical fixture** — overwrite `src/data/registry.fixture.json` with the exact canonical fixture (byte-identical to `plugin-registry/schema/registry.fixture.json` from Task 1). Confirm the builtin entry uses `"categories": ["integration"]` (website's schema enforces the category enum — `"network"` would fail here; this is the whole reason the canonical uses `integration`).

- [ ] **Step 6: Run — verify it passes** (`pnpm test`); then `pnpm exec tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git -C ../motrix-website add src/data/plugins.ts src/data/registry.fixture.json src/data/plugins.test.ts
git -C ../motrix-website commit -m "feat: vendor package.signature and sync the registry fixture"
```

---

### Task 6: motrix-turbo — fixture category reconciliation

**Files (in `../motrix-turbo`):**
- Modify: `src/shared/schemas/registry.fixture.json` (builtin entry `"categories": ["network"]` → `["integration"]`)

**Interfaces:**
- motrix-turbo already has the `signature` field and the 3-entry fixture. The ONLY change needed for byte-identical lockstep is the category edit (so all three fixtures match the canonical). Its schema is category-lenient, so this is behavior-neutral there.

- [ ] **Step 1: Create the branch** — `git -C ../motrix-turbo checkout -b feature/builtin_signed_package_20260724` (from its default; verify clean).

- [ ] **Step 2: Edit the fixture** — change the `motrix.url-resolver` builtin entry's `"categories": ["network"]` to `"categories": ["integration"]` in `src/shared/schemas/registry.fixture.json`. Grep the turbo test suite for a hardcoded `"network"` assertion first: `grep -rn '"network"' src/` — if any test asserts that literal, update it; otherwise no test change is needed.

- [ ] **Step 3: Verify byte-identity across all three fixtures**

```bash
diff src/shared/schemas/registry.fixture.json ../plugin-registry/schema/registry.fixture.json && \
diff src/shared/schemas/registry.fixture.json ../motrix-website/src/data/registry.fixture.json && \
echo "ALL THREE FIXTURES IDENTICAL"
```

- [ ] **Step 4: Gates** — `pnpm exec tsc --noEmit && pnpm exec vitest run src/shared/schemas/` (all green).

- [ ] **Step 5: Commit**

```bash
git -C ../motrix-turbo add src/shared/schemas/registry.fixture.json
git -C ../motrix-turbo commit -m "chore: align shared registry fixture category with the registry canonical"
```

---

### Task 7: CI automation — dispatch-to-registry

**Files:**
- Create: `plugin-registry/.github/workflows/registry-entry-update.yml`
- Modify: `builtin-plugins/.github/workflows/release.yml` (append a dispatch step to the `sign` job)
- Create/Modify: `plugin-registry/docs/releasing.md` (document the required secret + repo toggle)

**Interfaces:**
- Consumes: `scripts/entry-from-release.ts` (Task 3) with its GitHub-download path (no local artifact dir in CI).

- [ ] **Step 1: plugin-registry workflow** — `plugin-registry/.github/workflows/registry-entry-update.yml`:

```yaml
name: registry-entry-update
on:
  workflow_dispatch:
    inputs:
      id: { description: 'plugin id (e.g. motrix.url-resolver)', required: true }
      tag: { description: 'release tag (e.g. motrix.url-resolver@1.0.0)', required: true }
  repository_dispatch:
    types: [builtin-released]
permissions:
  contents: write
  pull-requests: write
jobs:
  update-entry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
        with: { version: 10 }
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Resolve inputs
        id: in
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "id=${{ github.event.inputs.id }}" >> "$GITHUB_OUTPUT"
            echo "tag=${{ github.event.inputs.tag }}" >> "$GITHUB_OUTPUT"
          else
            echo "id=${{ github.event.client_payload.id }}" >> "$GITHUB_OUTPUT"
            echo "tag=${{ github.event.client_payload.tag }}" >> "$GITHUB_OUTPUT"
          fi
      - name: Generate entry from the signed release
        run: pnpm entry:from-release "${{ steps.in.outputs.id }}" "${{ steps.in.outputs.tag }}"
      - name: Self-gate
        run: pnpm validate && pnpm test
      - name: Open PR
        uses: peter-evans/create-pull-request@v7
        with:
          branch: "auto/entry-${{ steps.in.outputs.id }}-${{ steps.in.outputs.tag }}"
          title: "chore: update ${{ steps.in.outputs.id }} to ${{ steps.in.outputs.tag }}"
          body: |
            Automated registry entry update from a signed builtin-plugins release.
            The generator verified the ed25519 signature against keys/signing-key.pub.pem.
            Merging requires the standard validate/test/lockstep CI to pass.
          commit-message: "chore: update ${{ steps.in.outputs.id }} package to ${{ steps.in.outputs.tag }}"
          add-paths: plugins/
```

- [ ] **Step 2: builtin-plugins dispatch step** — create `git -C ../builtin-plugins checkout -b feature/builtin_signed_package_20260724`, then in `.github/workflows/release.yml`, append to the `sign` job's steps (after "Create release"):

```yaml
      - name: Notify plugin-registry
        env:
          GH_TOKEN: ${{ secrets.REGISTRY_DISPATCH_TOKEN }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "REGISTRY_DISPATCH_TOKEN not set — skipping registry notify"
            exit 0
          fi
          gh api repos/motrixapp/plugin-registry/dispatches \
            -f event_type=builtin-released \
            -F client_payload[id]="${{ steps.tag.outputs.id }}" \
            -F client_payload[version]="${{ steps.tag.outputs.version }}" \
            -F client_payload[tag]="$GITHUB_REF_NAME"
```

(The empty-token shell guard means the step is a no-op until the secret is provisioned — the release still succeeds; the registry entry can be updated manually via `workflow_dispatch` in the meantime. The guard lives in the shell, not a step-level `if:`, because the `secrets` context is not reliably available in step `if:` conditions.)

- [ ] **Step 3: Document the out-of-band requirements** — `plugin-registry/docs/releasing.md`:

```markdown
# Registry entry automation

A signed builtin-plugins release notifies this repo (`repository_dispatch:
builtin-released`); the `registry-entry-update` workflow regenerates the
entry (verifying the ed25519 signature) and opens a PR that the normal
validate/test/lockstep CI gates before a human merges.

## One-time setup (repo admin)

- **builtin-plugins secret `REGISTRY_DISPATCH_TOKEN`** — a fine-scoped PAT or
  GitHub App token permitted to POST `repos/motrixapp/plugin-registry/dispatches`.
  Until it is set, the dispatch step is skipped and the release still succeeds.
- **plugin-registry setting** — Settings → Actions → General → "Allow GitHub
  Actions to create and approve pull requests" must be enabled so the
  workflow's `GITHUB_TOKEN` can open the PR.

## Manual fallback

`gh workflow run registry-entry-update.yml -f id=<id> -f tag=<id>@<version>`
(or the Actions UI) regenerates and PRs an entry without any dispatch.
```

- [ ] **Step 4: Lint the YAML** — if `actionlint` is available, run it on both workflow files; otherwise validate with a YAML parser (`python3 -c "import yaml,sys; yaml.safe_load(open(f))"` for each). No runtime execution of the workflows in this task.

- [ ] **Step 5: Commit (two repos)**

```bash
git -C . add .github/workflows/registry-entry-update.yml docs/releasing.md
git -C . commit -m "ci: auto-update registry entries from signed builtin releases"
git -C ../builtin-plugins add .github/workflows/release.yml
git -C ../builtin-plugins commit -m "ci: notify plugin-registry after a signed release"
```

---

### Task 8: cross-repo lockstep verification

**Files:** none (verification only)

- [ ] **Step 1: Schema `package` block byte-identity** — extract the `package` object from all three schema files and confirm the field set (url, sha256, size, signature) matches. A practical check:

```bash
cd /Users/xanaduv/Work/code/motrix-app
grep -A6 'package: z' plugin-registry/schema/registry.ts | grep -E 'url|sha256|size|signature'
grep -A6 'package: z' motrix-turbo/src/shared/schemas/registry.ts | grep -E 'url|sha256|size|signature'
grep -A8 'package: z' motrix-website/src/data/plugins.ts | grep -E 'url|sha256|size|signature'
```

All three must list the same four fields with `signature` optional.

- [ ] **Step 2: Fixture byte-identity** — already asserted in Task 6 Step 3; re-run the three-way diff to be sure nothing drifted after Task 7.

- [ ] **Step 3: Per-repo final gates**

```bash
( cd plugin-registry && pnpm check && pnpm test && pnpm validate )
( cd motrix-website && pnpm exec tsc --noEmit && pnpm test )
( cd motrix-turbo && pnpm exec tsc --noEmit && pnpm exec vitest run src/shared/schemas/ )
```

All green.

- [ ] **Step 4: No commit** — this task only verifies. Record the results in the final summary.

---

## Coverage vs spec (self-review record)

- §3 schema `signature` (3 repos) — Tasks 1, 5, 6 (turbo already had the field; only fixture reconciliation)
- §4 policy (builtin+package⇒signature) — Task 2
- §5 real builtin data — Task 4 (via the Task 3 generator; no hand-transcription)
- §6 generator with verify-before-write — Task 3
- §7 CI dispatch-to-registry + out-of-band secret/toggle docs — Task 7
- §8 fixture lockstep (network→integration for website's enum) — Tasks 1, 5, 6, 8
- §9 testing — Tasks 1-4 (registry), 5 (website), 6 (turbo), 8 (cross-repo)
- Deferred/none: `minMotrix` (§3, deliberately omitted), signing infra (§10, owned by builtin-plugins)
