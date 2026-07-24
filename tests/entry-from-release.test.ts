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
