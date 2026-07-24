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
