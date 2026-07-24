import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
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
  id: string
  version: string
  package: { url: string; sha256: string; size: number; signature: string }
}

const RELEASE_BASE = 'https://github.com/motrixapp/builtin-plugins/releases/download'
const MANIFEST_ENTRY = 'motrix-plugin.json'
const MANIFEST_SIZE_MAX = 1 << 20 // 1 MiB — defensive cap, bytes are already signed
const TAG_RE = /^[^@]+@[^@]+$/

/**
 * Turn verified release artifacts into the entry's version + package block.
 *
 * The ed25519 signature is THE trust decision over the raw `.moext` bytes —
 * but the signature itself carries no identity binding, and `.metadata.json`
 * is unsigned. So a genuinely-signed artifact for plugin A could be relabeled
 * (unsigned metadata + tag + target filename all edited to claim plugin B)
 * and would otherwise be accepted as B's package. To close that hole, once
 * the signature verifies we unzip the SIGNED bytes themselves and require
 * their in-bundle `motrix-plugin.json` to claim the same id/version as the
 * tag — mirroring the check `motrix-turbo`'s install path already performs
 * client-side, but here at publish time so a mislabeled entry never lands in
 * the registry at all.
 *
 * Any mismatch throws — nothing downstream writes an unverified package.
 */
export function buildPackageBlock(
  a: ReleaseArtifacts,
  tag: string,
  pubPem: string
): PackageBlock {
  if (!TAG_RE.test(tag)) {
    throw new Error(`tag "${tag}" must be exactly "<id>@<version>" (one "@")`)
  }
  const [tagId, tagVersion] = tag.split('@')
  if (a.metadata.id !== tagId || a.metadata.version !== tagVersion) {
    throw new Error(
      `tag ${tag} does not match metadata ${a.metadata.id}@${a.metadata.version}`
    )
  }
  const expectedFile = `${tagId}-${tagVersion}.moext`
  if (a.metadata.file !== expectedFile) {
    throw new Error(
      `metadata.file "${a.metadata.file}" does not match expected "${expectedFile}"`
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

  // From here on we only ever parse bytes the Motrix key has already signed.
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(a.moext, {
      filter: (file) => file.name === MANIFEST_ENTRY,
    })
  } catch (err) {
    throw new Error(`.moext is not a valid zip: ${(err as Error).message}`)
  }
  const manifestBytes = entries[MANIFEST_ENTRY]
  if (!manifestBytes) {
    throw new Error('.moext missing motrix-plugin.json')
  }
  if (manifestBytes.byteLength > MANIFEST_SIZE_MAX) {
    throw new Error(
      `motrix-plugin.json exceeds ${MANIFEST_SIZE_MAX} bytes (${manifestBytes.byteLength})`
    )
  }
  let manifest: { id?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(strFromU8(manifestBytes))
  } catch (err) {
    throw new Error(
      `.moext motrix-plugin.json is not valid JSON: ${(err as Error).message}`
    )
  }
  if (manifest.id !== tagId || manifest.version !== tagVersion) {
    throw new Error(
      `identity mismatch: signed manifest claims ${manifest.id}@${manifest.version}, tag says ${tag}`
    )
  }

  return {
    id: tagId,
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

export async function patchEntry(
  id: string,
  block: PackageBlock,
  pluginsDir: string = PLUGINS_DIR
): Promise<void> {
  if (id !== block.id) {
    throw new Error(
      `identity mismatch: refusing to patch "${id}.json" with a package block verified for "${block.id}"`
    )
  }
  const file = path.join(pluginsDir, `${id}.json`)
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
    metadata: (await metaRes.json()) as ReleaseArtifacts['metadata'],
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
