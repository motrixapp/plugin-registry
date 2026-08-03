import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { RegistryPluginAuthoringSchema } from '../schema/registry.ts'
import {
  buildPackageBlock,
  patchEntry,
  type PackageBlock,
  type ReleaseArtifacts,
} from '../scripts/entry-from-release.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** Build a real .moext zip whose signed bytes carry `manifest` at the root. */
function makeMoext(manifest: Record<string, unknown>): Buffer {
  return Buffer.from(
    zipSync({
      'motrix-plugin.json': strToU8(JSON.stringify(manifest)),
      'dist/plugin.js': strToU8('x'),
    })
  )
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// A faithful in-bundle manifest: the real signed manifest always carries
// engines (required + strict in the manifest schema) plus the consent fields
// the generator now mirrors into the entry.
const URL_RESOLVER_MANIFEST = {
  manifestVersion: 1,
  id: 'motrix.url-resolver',
  version: '1.0.0',
  main: 'dist/plugin.js',
  engines: { motrix: '>=2.0.0 <3.0.0' },
  permissions: ['http'],
  hostPermissions: ['*://commons.wikimedia.org/*'],
}

const moext = makeMoext(URL_RESOLVER_MANIFEST)
const moextSha256 = sha256(moext)

function artifacts(over: Partial<ReleaseArtifacts> = {}): ReleaseArtifacts {
  return {
    moext,
    metadata: {
      id: 'motrix.url-resolver',
      version: '1.0.0',
      file: 'motrix.url-resolver-1.0.0.moext',
      sha256: moextSha256,
      size: moext.byteLength,
    },
    signatureB64: sign(null, moext, privateKey).toString('base64'),
    ...over,
  }
}
const TAG = 'motrix.url-resolver@1.0.0'

/**
 * Build signed ReleaseArtifacts + matching tag for an arbitrary in-bundle
 * manifest, so a test can exercise how the generator mirrors the manifest's
 * consent-preview / compatibility fields into the entry.
 */
function releaseFor(manifest: Record<string, unknown>): {
  rel: ReleaseArtifacts
  tag: string
} {
  const id = manifest.id as string
  const version = manifest.version as string
  const bytes = makeMoext(manifest)
  return {
    rel: {
      moext: bytes,
      metadata: {
        id,
        version,
        file: `${id}-${version}.moext`,
        sha256: sha256(bytes),
        size: bytes.byteLength,
      },
      signatureB64: sign(null, bytes, privateKey).toString('base64'),
    },
    tag: `${id}@${version}`,
  }
}

describe('buildPackageBlock', () => {
  it('returns a verified package block for a good release', () => {
    const r = buildPackageBlock(artifacts(), TAG, PUB)
    expect(r.id).toBe('motrix.url-resolver')
    expect(r.version).toBe('1.0.0')
    expect(r.package.sha256).toBe(moextSha256)
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

  it('aborts when metadata.file does not match the expected "<id>-<version>.moext" name', () => {
    expect(() =>
      buildPackageBlock(
        artifacts({ metadata: { ...artifacts().metadata, file: 'not-the-right-name.moext' } }),
        TAG,
        PUB
      )
    ).toThrow(/file/i)
  })

  it('aborts when a tag has no "@" or more than one "@"', () => {
    expect(() => buildPackageBlock(artifacts(), 'motrix.url-resolver-no-at-sign', PUB)).toThrow(
      /tag/i
    )
    // Constructed so the FIRST two "@"-split segments still match metadata:
    // without an explicit shape guard this would sail through every other
    // check (metadata, filename, sha256, size, signature, manifest identity)
    // and wrongly succeed.
    expect(() =>
      buildPackageBlock(artifacts(), 'motrix.url-resolver@1.0.0@extra-segment', PUB)
    ).toThrow(/tag/i)
  })

  // THE differentiating test: proves the identity-binding hole this fix closes.
  // A.moext's SIGNED bytes genuinely claim id "motrix.url-resolver" — but the
  // UNSIGNED metadata + tag + target filename all relabel it as an unrelated
  // plugin "motrix.filename-template@9.9.9". The ed25519 signature verifies
  // fine (it signs raw bytes only, no identity). Before manifest-binding, this
  // relabeled block would be silently ACCEPTED and published under the wrong
  // plugin id. After manifest-binding, it MUST throw.
  it('aborts when the signed in-bundle manifest identity does not match the tag (relabel attack)', () => {
    const relabeledTag = 'motrix.filename-template@9.9.9'
    const relabeled = artifacts({
      metadata: {
        id: 'motrix.filename-template',
        version: '9.9.9',
        file: 'motrix.filename-template-9.9.9.moext',
        sha256: moextSha256,
        size: moext.byteLength,
      },
    })
    expect(() => buildPackageBlock(relabeled, relabeledTag, PUB)).toThrow(
      /identity|manifest/i
    )
  })
})

describe('buildPackageBlock mirrors the signed manifest consent+compat fields', () => {
  it('carries permissions, optionalPermissions, hostPermissions and engines from the manifest', () => {
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id: 'motrix.url-resolver',
      version: '1.0.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['http'],
      optionalPermissions: ['notifications'],
      hostPermissions: ['*://commons.wikimedia.org/*'],
    })
    const r = buildPackageBlock(rel, tag, PUB)
    expect(r.mirror.engines).toEqual({ motrix: '>=2.0.0 <3.0.0' })
    expect(r.mirror.permissions).toEqual(['http'])
    expect(r.mirror.optionalPermissions).toEqual(['notifications'])
    expect(r.mirror.hostPermissions).toEqual(['*://commons.wikimedia.org/*'])
  })

  // The incident shape: filename-template@1.1.0 dropped hostPermissions from
  // its manifest entirely (they are optional in the manifest schema). The
  // mirror must materialize the absent fields as [] so the entry advertises
  // nothing the plugin no longer requests.
  it('materializes absent optional consent fields as [] (manifest without hostPermissions)', () => {
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id: 'motrix.filename-template',
      version: '1.1.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['fs.task.write'],
    })
    const r = buildPackageBlock(rel, tag, PUB)
    expect(r.mirror.permissions).toEqual(['fs.task.write'])
    expect(r.mirror.optionalPermissions).toEqual([])
    expect(r.mirror.hostPermissions).toEqual([])
  })

  it('aborts when the signed manifest has no engines.motrix range', () => {
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id: 'motrix.url-resolver',
      version: '1.0.0',
      main: 'dist/plugin.js',
      permissions: [],
    })
    expect(() => buildPackageBlock(rel, tag, PUB)).toThrow(/engines/i)
  })
})

describe('patchEntry', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function writeFixture(id: string, extra: Record<string, unknown> = {}) {
    dir = await mkdtemp(path.join(tmpdir(), 'plugin-registry-test-'))
    const entry = {
      id,
      listing: {
        defaultLocale: 'en-US',
        localizations: {
          'en-US': {
            name: 'Test Plugin',
            description: 'A test plugin.',
          },
        },
      },
      version: '0.0.1',
      author: { name: 'Motrix Team' },
      origin: 'builtin',
      categories: ['site-resolver'],
      engines: { motrix: '>=2.0.0 <3.0.0' },
      updatedAt: '2026-07-22',
      ...extra,
    }
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2))
    return dir
  }

  function block(): PackageBlock {
    return buildPackageBlock(artifacts(), TAG, PUB)
  }

  it('writes version + package and preserves other fields', async () => {
    const d = await writeFixture('motrix.url-resolver')
    await patchEntry('motrix.url-resolver', block(), d)
    const patched = JSON.parse(await readFile(path.join(d, 'motrix.url-resolver.json'), 'utf8'))
    expect(patched.version).toBe('1.0.0')
    expect(patched.package).toEqual(block().package)
    expect(patched.listing).toEqual({
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'Test Plugin',
          description: 'A test plugin.',
        },
      },
    })
    expect(patched.id).toBe('motrix.url-resolver')
  })

  it('throws when the target id does not match the verified block identity', async () => {
    await writeFixture('motrix.url-resolver')
    await expect(patchEntry('motrix.other', block(), dir)).rejects.toThrow(/identity|id/i)
  })
})

describe('patchEntry syncs consent+compat fields from the signed manifest', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  /**
   * Write a builtin entry that already carries hand-authored consent/compat
   * fields, so a patch can be shown to overwrite them from the manifest.
   */
  async function writeStaleEntry(
    id: string,
    stale: Record<string, unknown>
  ): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'plugin-registry-test-'))
    const entry = {
      id,
      listing: {
        defaultLocale: 'en-US',
        localizations: {
          'en-US': {
            name: 'Filename Template',
            description: 'Renames finished downloads.',
          },
          'zh-CN': { name: '文件名模板' },
        },
      },
      version: '1.0.0',
      author: { name: 'Motrix Team' },
      origin: 'builtin',
      categories: ['post-action'],
      engines: { motrix: '>=1.0.0 <2.0.0' },
      updatedAt: '2026-07-01',
      ...stale,
    }
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2))
    return dir
  }

  it('overwrites a stale hostPermissions with the value from the manifest', async () => {
    const id = 'motrix.filename-template'
    await writeStaleEntry(id, { hostPermissions: ['*://*/*'] })
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id,
      version: '1.1.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['fs.task.write'],
      hostPermissions: ['*://commons.wikimedia.org/*'],
    })
    await patchEntry(id, buildPackageBlock(rel, tag, PUB), dir)
    const patched = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'))
    expect(patched.hostPermissions).toEqual(['*://commons.wikimedia.org/*'])
    expect(patched.permissions).toEqual(['fs.task.write'])
  })

  // THE incident case: 1.1.0 dropped hostPermissions from the manifest, yet the
  // registry entry kept advertising ["*://*/*"] — the registry lied about what
  // the plugin requests. The patch MUST clear the stale value to [] and the
  // result must stay schema-valid.
  it('clears a stale hostPermissions when the manifest requests none, and stays schema-valid', async () => {
    const id = 'motrix.filename-template'
    await writeStaleEntry(id, { hostPermissions: ['*://*/*'] })
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id,
      version: '1.1.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['fs.task.write'],
    })
    await patchEntry(id, buildPackageBlock(rel, tag, PUB), dir)
    const patched = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'))
    expect(patched.hostPermissions).toEqual([])
    expect(patched.optionalPermissions).toEqual([])
    expect(RegistryPluginAuthoringSchema.safeParse(patched).success).toBe(true)
  })

  it('syncs the engines range from the manifest', async () => {
    const id = 'motrix.filename-template'
    await writeStaleEntry(id, { engines: { motrix: '>=1.0.0 <2.0.0' } })
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id,
      version: '1.1.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['fs.task.write'],
    })
    await patchEntry(id, buildPackageBlock(rel, tag, PUB), dir)
    const patched = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'))
    expect(patched.engines).toEqual({ motrix: '>=2.0.0 <3.0.0' })
  })

  it('preserves the parsed listing by deep equality while manifest fields change', async () => {
    const id = 'motrix.filename-template'
    await writeStaleEntry(id, { hostPermissions: ['*://*/*'] })
    const before = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'))
    const { rel, tag } = releaseFor({
      manifestVersion: 1,
      id,
      version: '1.1.0',
      main: 'dist/plugin.js',
      engines: { motrix: '>=2.0.0 <3.0.0' },
      permissions: ['fs.task.write'],
    })
    await patchEntry(id, buildPackageBlock(rel, tag, PUB), dir)
    const patched = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'))
    expect(patched.listing).toEqual(before.listing)
    expect(patched.categories).toEqual(before.categories)
    expect(patched.updatedAt).toEqual(before.updatedAt)
  })
})
