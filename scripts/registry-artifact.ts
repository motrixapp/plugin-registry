import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { RegistryFileSchema } from '../schema/registry.ts'
import { MAX_REGISTRY_BYTES } from './aggregate.ts'

export interface RegistryArtifactIdentity {
  sha256: string
  bytes: number
}

/** Validate the original bytes; never serialize or rebuild a release artifact. */
export function inspectRegistryArtifact(
  bytes: Buffer,
  expected?: RegistryArtifactIdentity
): RegistryArtifactIdentity {
  if (bytes.length === 0 || bytes.length > MAX_REGISTRY_BYTES) {
    throw new Error('registry artifact must contain between 1 byte and 4 MiB')
  }
  if (
    expected &&
    (!/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 1 ||
      expected.bytes > MAX_REGISTRY_BYTES)
  ) {
    throw new Error('invalid expected registry artifact identity')
  }
  const identity = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
  if (
    expected &&
    (identity.sha256 !== expected.sha256 || identity.bytes !== expected.bytes)
  ) {
    throw new Error('registry artifact does not match the approved SHA-256 and size')
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  RegistryFileSchema.parse(JSON.parse(source))
  return identity
}

export async function inspectRegistryArtifactFile(
  file: string,
  expected?: RegistryArtifactIdentity
): Promise<RegistryArtifactIdentity> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_REGISTRY_BYTES) {
    throw new Error('registry artifact must be a regular file of at most 4 MiB')
  }
  return inspectRegistryArtifact(await readFile(file), expected)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, sha256, bytes, ...extra] = process.argv.slice(2)
  if (
    !file || extra.length > 0 ||
    (sha256 === undefined) !== (bytes === undefined) ||
    (bytes !== undefined && !/^[1-9][0-9]*$/.test(bytes))
  ) {
    throw new Error('usage: registry-artifact.ts <file> [<sha256> <bytes>]')
  }
  const expected = sha256 === undefined ? undefined : { sha256, bytes: Number(bytes) }
  console.log(JSON.stringify(await inspectRegistryArtifactFile(file, expected)))
}
