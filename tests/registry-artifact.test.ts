import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import fixture from '../schema/registry.fixture.json'
import {
  inspectRegistryArtifact,
  inspectRegistryArtifactFile,
} from '../scripts/registry-artifact.ts'

const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`)
const identity = {
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
}

describe('immutable registry release artifact', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('validates and hashes the exact bytes without materializing schema defaults', () => {
    const original = Buffer.from(bytes)
    expect(inspectRegistryArtifact(bytes, identity)).toEqual(identity)
    expect(bytes).toEqual(original)
  })

  it('rejects different valid JSON bytes even when they describe the same registry', () => {
    expect(() => inspectRegistryArtifact(Buffer.from(JSON.stringify(fixture)), identity))
      .toThrow('approved SHA-256 and size')
  })

  it('rejects a mismatched expected size', () => {
    expect(() => inspectRegistryArtifact(bytes, { ...identity, bytes: bytes.length + 1 }))
      .toThrow('approved SHA-256 and size')
  })

  it('rejects a v1 registry even with its correct hash', () => {
    const legacy = Buffer.from(JSON.stringify({ ...fixture, version: 1 }))
    expect(() => inspectRegistryArtifact(legacy)).toThrow()
  })

  it('rejects invalid UTF-8 instead of silently replacing bytes', () => {
    const invalid = Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')])
    expect(() => inspectRegistryArtifact(invalid)).toThrow()
  })

  it.each([Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1)])(
    'rejects an empty or oversized artifact',
    (input) => expect(() => inspectRegistryArtifact(input)).toThrow('between 1 byte and 4 MiB')
  )

  it.each([
    { ...identity, sha256: 'invalid' },
    { ...identity, bytes: Number.NaN },
    { ...identity, bytes: -1 },
    { ...identity, bytes: 4 * 1024 * 1024 + 1 },
  ])('rejects malformed expected identity', (expected) => {
    expect(() => inspectRegistryArtifact(bytes, expected)).toThrow('invalid expected')
  })

  it('accepts a regular file and rejects a symlink or directory', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'registry-artifact-'))
    const file = path.join(directory, 'plugins.json')
    await writeFile(file, bytes)
    await expect(inspectRegistryArtifactFile(file, identity)).resolves.toEqual(identity)
    const link = path.join(directory, 'linked.json')
    await symlink(file, link)
    await expect(inspectRegistryArtifactFile(link, identity)).rejects.toThrow('regular file')
    await expect(inspectRegistryArtifactFile(directory, identity)).rejects.toThrow('regular file')
  })
})
