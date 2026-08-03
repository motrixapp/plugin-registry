import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Zip, ZipPassThrough, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertCandidateIsCurrent,
  completeReleaseV2,
  completeRestoreV2,
  createReleaseIntentV2,
  createRegistryCandidateManifest,
  createWebsiteArtifactManifest,
  extractVerifiedRegistryArtifactBundle,
  extractVerifiedPromotionBundle,
  extractVerifiedWebsiteArtifactBundle,
  hashDirectory,
  inspectReleaseIntentV2,
  deriveRestoreOperationV2,
  RegistryCandidateManifestSchema,
  ReleaseIntentSchema,
  ReleaseManifestSchema,
  RestoreIntentSchema,
  RestoreManifestSchema,
  RestorePlanSchema,
  runReleaseContractCli,
  sha256File,
  validateReleaseIntentV2,
  validateReleaseManifestV2,
  verifyPromotionBundle,
  verifyPublishIntentV2,
  verifyRegistryArtifactBundle,
  verifyRestoredV2,
  verifyRestoreCompletionV2,
  verifyRestoreOperationV2,
  verifyRestoreSelfV2,
  verifyRestoreV2,
  verifyWebsiteArtifactBundle,
  WebsiteArtifactManifestSchema,
  type ReleaseIntent,
  type RegistryCandidateManifest,
  type RestoreManifest,
  type VerifiedPromotionBundle,
  type WebsiteArtifactManifest,
} from '../scripts/release-contract.ts'

const SOURCE_A = 'a'.repeat(40)
const SOURCE_B = 'b'.repeat(40)
const SOURCE_C = 'c'.repeat(40)
const SOURCE_D = 'd'.repeat(40)

function registryJson(generatedAt = '2026-08-02T00:00:00.000Z'): string {
  return `${JSON.stringify({ version: 2, generatedAt, plugins: [] })}\n`
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function zipWithDuplicateEntries(
  entries: ReadonlyArray<readonly [string, Uint8Array]>
): Buffer {
  const chunks: Buffer[] = []
  let streamError: Error | undefined
  let complete = false
  const archive = new Zip((error, data, final) => {
    if (error) {
      streamError = error
      return
    }
    chunks.push(Buffer.from(data))
    if (final) complete = true
  })
  for (const [name, bytes] of entries) {
    const entry = new ZipPassThrough(name)
    archive.add(entry)
    entry.push(bytes, true)
  }
  archive.end()
  if (streamError) throw streamError
  if (!complete) throw new Error('test ZIP did not complete synchronously')
  return Buffer.concat(chunks)
}

describe('exact-artifact release contract', () => {
  let dir = ''

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  async function writeArchive(
    filename: string,
    entries: Record<string, Uint8Array>
  ): Promise<{ path: string; sha256: string }> {
    const archivePath = path.join(dir, filename)
    await writeFile(archivePath, zipSync(entries))
    return { path: archivePath, sha256: await sha256File(archivePath) }
  }

  async function createCandidate(options?: {
    registry?: string
    filename?: string
    artifactId?: string
    runId?: string
    sourceSha?: string
  }): Promise<{
    candidate: RegistryCandidateManifest
    archivePath: string
    archiveSha256: string
    registry: string
  }> {
    if (!dir) {
      dir = await mkdtemp(path.join(tmpdir(), 'registry-release-contract-'))
    }
    const registry = options?.registry ?? registryJson()
    const artifactId = options?.artifactId ?? '202'
    const archive = await writeArchive(
      options?.filename ?? 'registry-artifact.zip',
      { 'plugins.json': Buffer.from(registry) }
    )
    const candidate = await createRegistryCandidateManifest({
      registryArtifactPath: archive.path,
      artifactId,
      expectedArtifactId: artifactId,
      expectedArtifactSha256: archive.sha256,
      sourceSha: options?.sourceSha ?? SOURCE_A,
      runId: options?.runId ?? '101',
    })
    return {
      candidate,
      archivePath: archive.path,
      archiveSha256: archive.sha256,
      registry,
    }
  }

  async function createWebsite(options: {
    candidate: RegistryCandidateManifest
    filename?: string
    html?: string
    sourceSha?: string
    buildRunId?: string
  }): Promise<{
    website: WebsiteArtifactManifest
    archivePath: string
    archiveSha256: string
    distDir: string
    html: string
  }> {
    const html = options.html ?? '<h1>Motrix</h1>'
    const sourceSha = options.sourceSha ?? SOURCE_B
    const buildRunId = options.buildRunId ?? '303'
    const distDir = path.join(
      dir,
      `dist-${options.filename ?? 'website-artifact'}`
    )
    await mkdir(distDir)
    await writeFile(path.join(distDir, 'index.html'), html)
    const website = await createWebsiteArtifactManifest({
      candidate: options.candidate,
      distDir,
      sourceSha,
      buildRunId,
    })
    const archive = await writeArchive(
      options.filename ?? 'website-artifact.zip',
      {
        'website-artifact-manifest.json': jsonBytes(website),
        'dist/index.html': Buffer.from(html),
      }
    )
    return {
      website,
      archivePath: archive.path,
      archiveSha256: archive.sha256,
      distDir,
      html,
    }
  }

  it('verifies and safely extracts one exact registry/website promotion pair', async () => {
    const registry = await createCandidate()
    const website = await createWebsite({ candidate: registry.candidate })
    const bundle = await verifyPromotionBundle({
      candidate: registry.candidate,
      registryArtifactPath: registry.archivePath,
      registryArtifactId: '202',
      websiteArtifactPath: website.archivePath,
      websiteArtifactId: '404',
      expectedWebsiteArtifactId: '404',
      expectedWebsiteArtifactSha256: website.archiveSha256,
      websiteSourceSha: SOURCE_B,
      websiteBuildRunId: '303',
    })

    expect(bundle.registry.artifactSha256).toBe(registry.archiveSha256)
    expect(bundle.website.manifest.registryArtifactSha256).toBe(
      registry.archiveSha256
    )
    expect(bundle.website.manifest.registrySha256).toBe(
      registry.candidate.registry.sha256
    )

    const extractionRoot = path.join(dir, 'verified-promotion')
    const extracted = await extractVerifiedPromotionBundle(
      bundle,
      extractionRoot
    )
    await expect(readFile(extracted.registryPath, 'utf8')).resolves.toBe(
      registry.registry
    )
    await expect(
      readFile(path.join(extracted.websiteDistDir, 'index.html'), 'utf8')
    ).resolves.toBe(website.html)
    await expect(readdir(extractionRoot)).resolves.toEqual([
      'registry',
      'website',
    ])
  })

  it('matches the cross-repository directory hash vector byte-for-byte', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'registry-directory-vector-'))
    await mkdir(path.join(dir, 'assets'))
    await writeFile(path.join(dir, 'a.bin'), Buffer.from([0x00, 0xff, 0x0a]))
    await writeFile(path.join(dir, 'assets', '语言.txt'), '你好\n')
    await writeFile(path.join(dir, 'index.html'), '<h1>Motrix</h1>\n')

    await expect(hashDirectory(dir)).resolves.toBe(
      'ec167790aabccfc70a0a04c78240e9c175fc1109c0ba71498e3c76d977416a81'
    )
  })

  it('rejects registry archive A paired with separate registry bytes B or a forged artifact id', async () => {
    const registryA = await createCandidate()
    const registryB = await writeArchive('registry-b.zip', {
      'plugins.json': Buffer.from(registryJson('2026-08-03T00:00:00.000Z')),
    })

    await expect(
      verifyRegistryArtifactBundle({
        artifactPath: registryB.path,
        artifactId: '202',
        expectedArtifactId: registryA.candidate.registry.artifactId,
        expectedArtifactSha256:
          registryA.candidate.registry.artifactSha256,
        candidate: registryA.candidate,
      })
    ).rejects.toThrow(/artifact ZIP SHA|embedded plugins|candidate/i)

    await expect(
      verifyRegistryArtifactBundle({
        artifactPath: registryA.archivePath,
        artifactId: '999',
        expectedArtifactId: registryA.candidate.registry.artifactId,
        expectedArtifactSha256:
          registryA.candidate.registry.artifactSha256,
        candidate: registryA.candidate,
      })
    ).rejects.toThrow(/artifact id/i)
  })

  it('rejects an archive with a duplicate, traversal, or extra layout entry', async () => {
    const registry = await createCandidate()
    const website = await createWebsite({ candidate: registry.candidate })
    const manifestBytes = jsonBytes(website.website)

    const duplicatePath = path.join(dir, 'duplicate.zip')
    await writeFile(
      duplicatePath,
      zipWithDuplicateEntries([
        ['website-artifact-manifest.json', manifestBytes],
        ['dist/index.html', Buffer.from(website.html)],
        ['dist/index.html', Buffer.from('substitution')],
      ])
    )
    await expect(
      verifyWebsiteArtifactBundle({
        artifactPath: duplicatePath,
        artifactId: '404',
        expectedArtifactId: '404',
        expectedArtifactSha256: await sha256File(duplicatePath),
        websiteSourceSha: SOURCE_B,
        websiteBuildRunId: '303',
        candidate: registry.candidate,
      })
    ).rejects.toThrow(/duplicate/i)

    for (const [filename, badEntry] of [
      ['traversal.zip', 'dist/../outside.txt'],
      ['extra.zip', 'README.txt'],
    ] as const) {
      const archive = await writeArchive(filename, {
        'website-artifact-manifest.json': manifestBytes,
        'dist/index.html': Buffer.from(website.html),
        [badEntry]: Buffer.from('not allowed'),
      })
      await expect(
        verifyWebsiteArtifactBundle({
          artifactPath: archive.path,
          artifactId: '404',
          expectedArtifactId: '404',
          expectedArtifactSha256: archive.sha256,
          websiteSourceSha: SOURCE_B,
          websiteBuildRunId: '303',
          candidate: registry.candidate,
        })
      ).rejects.toThrow(/traversal|extra.*layout/i)
    }
  })

  it('rejects missing EOCD, local-only ZIPs, and central/local mismatches', async () => {
    const registry = await createCandidate()
    const website = await createWebsite({ candidate: registry.candidate })
    const complete = await readFile(website.archivePath)
    const centralOffset = complete.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralOffset).toBeGreaterThan(0)

    const malformedArchives: Array<readonly [string, Buffer, RegExp]> = [
      [
        'no-eocd.zip',
        complete.subarray(0, complete.byteLength - 22),
        /invalid zip|central|truncated|incomplete/i,
      ],
      [
        'local-only.zip',
        complete.subarray(0, centralOffset),
        /invalid zip|central|truncated|incomplete/i,
      ],
    ]

    const centralMismatch = Buffer.from(complete)
    const centralNameOffset = centralMismatch.lastIndexOf(
      Buffer.from('dist/index.html')
    )
    expect(centralNameOffset).toBeGreaterThan(centralOffset)
    Buffer.from('evil/index.html').copy(centralMismatch, centralNameOffset)
    malformedArchives.push([
      'central-local-mismatch.zip',
      centralMismatch,
      /central directory.*local entr/i,
    ])

    for (const [filename, bytes, errorPattern] of malformedArchives) {
      const archivePath = path.join(dir, filename)
      await writeFile(archivePath, bytes)
      await expect(
        verifyWebsiteArtifactBundle({
          artifactPath: archivePath,
          artifactId: '404',
          expectedArtifactId: '404',
          expectedArtifactSha256: await sha256File(archivePath),
          websiteSourceSha: SOURCE_B,
          websiteBuildRunId: '303',
          candidate: registry.candidate,
        })
      ).rejects.toThrow(errorPattern)
    }
  })

  it('rejects genuine website ZIP A combined with manifest/dist or candidate B', async () => {
    const registryA = await createCandidate()
    const websiteA = await createWebsite({ candidate: registryA.candidate })
    const distB = '<h1>Substituted B</h1>'
    const distBDir = path.join(dir, 'dist-b')
    await mkdir(distBDir)
    await writeFile(path.join(distBDir, 'index.html'), distB)
    const websiteB = await createWebsiteArtifactManifest({
      candidate: registryA.candidate,
      distDir: distBDir,
      sourceSha: SOURCE_B,
      buildRunId: '303',
    })
    const mixed = await writeArchive('website-mixed.zip', {
      'website-artifact-manifest.json': jsonBytes(websiteB),
      'dist/index.html': Buffer.from(websiteA.html),
    })
    await expect(
      verifyWebsiteArtifactBundle({
        artifactPath: mixed.path,
        artifactId: '404',
        expectedArtifactId: '404',
        expectedArtifactSha256: mixed.sha256,
        websiteSourceSha: SOURCE_B,
        websiteBuildRunId: '303',
        candidate: registryA.candidate,
      })
    ).rejects.toThrow(/dist bytes.*embedded manifest/i)

    const registryB = await createCandidate({
      registry: registryJson('2026-08-03T00:00:00.000Z'),
      filename: 'registry-b.zip',
      artifactId: '505',
      runId: '404',
      sourceSha: SOURCE_C,
    })
    await expect(
      verifyWebsiteArtifactBundle({
        artifactPath: websiteA.archivePath,
        artifactId: '404',
        expectedArtifactId: '404',
        expectedArtifactSha256: websiteA.archiveSha256,
        websiteSourceSha: SOURCE_B,
        websiteBuildRunId: '303',
        candidate: registryB.candidate,
      })
    ).rejects.toThrow(/exact registry artifact ZIP/i)
  })

  it('rejects a caller-forged promotion pair assembled from two verified bundles', async () => {
    const registryA = await createCandidate()
    const websiteA = await createWebsite({ candidate: registryA.candidate })
    const pairA = await verifyPromotionBundle({
      candidate: registryA.candidate,
      registryArtifactPath: registryA.archivePath,
      registryArtifactId: '202',
      websiteArtifactPath: websiteA.archivePath,
      websiteArtifactId: '404',
      expectedWebsiteArtifactId: '404',
      expectedWebsiteArtifactSha256: websiteA.archiveSha256,
      websiteSourceSha: SOURCE_B,
      websiteBuildRunId: '303',
    })
    const registryB = await createCandidate({
      registry: registryJson('2026-08-03T00:00:00.000Z'),
      filename: 'forged-pair-registry-b.zip',
      artifactId: '505',
      runId: '404',
      sourceSha: SOURCE_C,
    })
    const websiteB = await createWebsite({
      candidate: registryB.candidate,
      filename: 'forged-pair-website-b.zip',
      sourceSha: SOURCE_D,
      buildRunId: '707',
    })
    const verifiedWebsiteB = await verifyWebsiteArtifactBundle({
      artifactPath: websiteB.archivePath,
      artifactId: '606',
      expectedArtifactId: '606',
      expectedArtifactSha256: websiteB.archiveSha256,
      websiteSourceSha: SOURCE_D,
      websiteBuildRunId: '707',
      candidate: registryB.candidate,
    })
    const forgedPair = {
      registry: pairA.registry,
      website: verifiedWebsiteB,
    } as unknown as VerifiedPromotionBundle

    await expect(
      extractVerifiedPromotionBundle(
        forgedPair,
        path.join(dir, 'forged-promotion-output')
      )
    ).rejects.toThrow(/promotion pair.*verifier/i)
  })

  it('does not authorize extraction from raw artifact verification alone', async () => {
    const registry = await createCandidate()
    const website = await createWebsite({ candidate: registry.candidate })
    const unboundRegistry = await verifyRegistryArtifactBundle({
      artifactPath: registry.archivePath,
      artifactId: '202',
      expectedArtifactId: '202',
      expectedArtifactSha256: registry.archiveSha256,
    })
    await expect(
      extractVerifiedRegistryArtifactBundle(
        unboundRegistry,
        path.join(dir, 'unbound-registry-output')
      )
    ).rejects.toThrow(/candidate-manifest binding/i)

    const unboundWebsite = await verifyWebsiteArtifactBundle({
      artifactPath: website.archivePath,
      artifactId: '404',
      expectedArtifactId: '404',
      expectedArtifactSha256: website.archiveSha256,
      websiteSourceSha: SOURCE_B,
      websiteBuildRunId: '303',
    })
    await expect(
      extractVerifiedWebsiteArtifactBundle(
        unboundWebsite,
        path.join(dir, 'unbound-website-output')
      )
    ).rejects.toThrow(/promotion or restore tuple binding/i)
  })

  it('rejects a superseded candidate before promotion', () => {
    expect(() => assertCandidateIsCurrent(SOURCE_A, SOURCE_B)).toThrow(
      /superseded/i
    )
    expect(() => assertCandidateIsCurrent(SOURCE_A, SOURCE_A)).not.toThrow()
  })

  it('rejects a substituted website artifact ZIP or artifact id', async () => {
    const registry = await createCandidate()
    const website = await createWebsite({ candidate: registry.candidate })

    await writeFile(
      website.archivePath,
      zipSync({
        'website-artifact-manifest.json': jsonBytes(website.website),
        'dist/index.html': Buffer.from('substituted archive bytes'),
      })
    )
    await expect(
      verifyWebsiteArtifactBundle({
        artifactPath: website.archivePath,
        artifactId: '404',
        expectedArtifactId: '404',
        expectedArtifactSha256: website.archiveSha256,
        websiteSourceSha: SOURCE_B,
        websiteBuildRunId: '303',
        candidate: registry.candidate,
      })
    ).rejects.toThrow(/artifact ZIP SHA/i)

    await expect(
      verifyWebsiteArtifactBundle({
        artifactPath: website.archivePath,
        artifactId: '405',
        expectedArtifactId: '404',
        expectedArtifactSha256: await sha256File(website.archivePath),
        websiteSourceSha: SOURCE_B,
        websiteBuildRunId: '303',
        candidate: registry.candidate,
      })
    ).rejects.toThrow(/artifact id/i)
  })

  function releaseOperationId(options: {
    repository: string
    registrySourceSha: string
    websiteSourceSha: string
    candidateSha256: string
    websiteDistSha256: string
  }): string {
    return createHash('sha256')
      .update(
        [
          'motrix-release-intent-v2',
          options.repository,
          options.registrySourceSha,
          options.websiteSourceSha,
          options.candidateSha256,
          options.websiteDistSha256,
          '',
        ].join('\n')
      )
      .digest('hex')
  }

  async function createReleaseFixture(previousRegistry = registryJson(
    '2026-08-01T00:00:00.000Z'
  )): Promise<{
    intent: ReleaseIntent
    intentPath: string
    intentSha256: string
    currentPath: string
    backupPath: string
    candidatePath: string
    registryPath: string
    websitePath: string
    candidate: RegistryCandidateManifest
    candidateRegistry: string
    operationId: string
  }> {
    const candidate = await createCandidate({
      registry: registryJson('2026-08-02T00:00:00.000Z'),
      filename: 'registry-release.zip',
      artifactId: '102',
      runId: '101',
      sourceSha: SOURCE_A,
    })
    const website = await createWebsite({
      candidate: candidate.candidate,
      filename: 'website-release.zip',
      sourceSha: SOURCE_B,
      buildRunId: '101',
    })
    const candidatePath = path.join(dir, 'candidate-release.json')
    await writeFile(candidatePath, jsonBytes(candidate.candidate))
    const currentPath = path.join(dir, 'release-current.json')
    const backupPath = path.join(dir, 'release-backup.json')
    await writeFile(currentPath, previousRegistry)
    await writeFile(backupPath, previousRegistry)
    const operationId = releaseOperationId({
      repository: 'motrixapp/plugin-registry',
      registrySourceSha: SOURCE_A,
      websiteSourceSha: SOURCE_B,
      candidateSha256: candidate.candidate.registry.sha256,
      websiteDistSha256: website.website.distSha256,
    })
    const intent = await createReleaseIntentV2({
      currentRegistryPath: currentPath,
      previousEtag: '"previous"',
      backupRegistryPath: backupPath,
      backupKey: `private/backups/plugins/${operationId}-${createHash('sha256')
        .update(previousRegistry)
        .digest('hex')}.json`,
      backupEtag: '"backup"',
      candidateManifestPath: candidatePath,
      candidateFilename: 'candidate-release.json',
      candidateArtifactId: '103',
      candidateArtifactSha256: await sha256File(candidatePath),
      registryArtifactPath: candidate.archivePath,
      registryFilename: 'registry-release.zip',
      registryArtifactId: '102',
      registryArtifactSha256: candidate.archiveSha256,
      websiteArtifactPath: website.archivePath,
      websiteFilename: 'website-release.zip',
      websiteArtifactId: '104',
      websiteArtifactSha256: website.archiveSha256,
      websiteSourceSha: SOURCE_B,
      websiteBuildRunId: '101',
      repository: 'motrixapp/plugin-registry',
      producerRunId: '101',
      operationId,
    })
    const intentPath = path.join(
      dir,
      `registry-release-intent-${operationId}.json`
    )
    await writeFile(intentPath, jsonBytes(intent))
    return {
      intent,
      intentPath,
      intentSha256: await sha256File(intentPath),
      currentPath,
      backupPath,
      candidatePath,
      registryPath: candidate.archivePath,
      websitePath: website.archivePath,
      candidate: candidate.candidate,
      candidateRegistry: candidate.registry,
      operationId,
    }
  }

  it('journals a stable publish intent, classifies CAS/resume, and completes v2', async () => {
    const fixture = await createReleaseFixture()
    expect(ReleaseIntentSchema.parse(fixture.intent)).toEqual(fixture.intent)
    expect(
      validateReleaseIntentV2(
        fixture.intent,
        'motrixapp/plugin-registry',
        '101',
        fixture.operationId
      )
    ).toEqual(fixture.intent)
    expect(
      inspectReleaseIntentV2(
        fixture.intent,
        'motrixapp/plugin-registry',
        '101',
        fixture.operationId
      ).artifacts.registry
    ).toMatchObject({ id: '102', filename: 'registry-release.zip' })

    const cas = await verifyPublishIntentV2({
      intentPath: fixture.intentPath,
      intentArtifactId: '105',
      intentArtifactSha256: fixture.intentSha256,
      currentRegistryPath: fixture.currentPath,
      currentEtag: '"previous"',
      backupRegistryPath: fixture.backupPath,
      backupEtag: '"backup"',
      candidateManifestPath: fixture.candidatePath,
      registryArtifactPath: fixture.registryPath,
      websiteArtifactPath: fixture.websitePath,
      extractionRoot: path.join(dir, 'publish-cas'),
    })
    expect(cas.mode).toBe('cas')
    expect(cas.candidateSha256).toBe(fixture.candidate.registry.sha256)

    await writeFile(fixture.currentPath, fixture.candidateRegistry)
    const resume = await verifyPublishIntentV2({
      intentPath: fixture.intentPath,
      intentArtifactId: '105',
      intentArtifactSha256: fixture.intentSha256,
      currentRegistryPath: fixture.currentPath,
      currentEtag: '"new-live-etag"',
      backupRegistryPath: fixture.backupPath,
      backupEtag: '"backup"',
      candidateManifestPath: fixture.candidatePath,
      registryArtifactPath: fixture.registryPath,
      websiteArtifactPath: fixture.websitePath,
      extractionRoot: path.join(dir, 'publish-resume'),
    })
    expect(resume.mode).toBe('resume')

    const release = await completeReleaseV2({
      intentPath: fixture.intentPath,
      intentArtifactId: '105',
      intentArtifactSha256: fixture.intentSha256,
      liveSha256: fixture.candidate.registry.sha256,
      liveEtag: '"new-live-etag"',
      transitionMode: 'resume',
      completionRunId: '110',
      completionRunAttempt: '2',
      completionSourceSha: SOURCE_A,
      completionEvent: 'workflow_dispatch',
      candidateManifestPath: fixture.candidatePath,
      registryArtifactPath: fixture.registryPath,
      websiteArtifactPath: fixture.websitePath,
    })
    expect(ReleaseManifestSchema.parse(release)).toEqual(release)
    expect(validateReleaseManifestV2(release)).toEqual(release)
    expect(release.registry.etag).toBe('"new-live-etag"')
  })

  it('keeps previous bytes opaque and rejects every third publish state', async () => {
    const opaquePrevious = 'opaque pre-registry-v2 bytes\u0000\n'
    const fixture = await createReleaseFixture(opaquePrevious)
    expect(fixture.intent.registry.previousSha256).toBe(
      createHash('sha256').update(opaquePrevious).digest('hex')
    )
    await writeFile(
      fixture.currentPath,
      registryJson('2026-07-30T00:00:00.000Z')
    )
    await expect(
      verifyPublishIntentV2({
        intentPath: fixture.intentPath,
        intentArtifactId: '105',
        intentArtifactSha256: fixture.intentSha256,
        currentRegistryPath: fixture.currentPath,
        currentEtag: '"third"',
        backupRegistryPath: fixture.backupPath,
        backupEtag: '"backup"',
        candidateManifestPath: fixture.candidatePath,
        registryArtifactPath: fixture.registryPath,
        websiteArtifactPath: fixture.websitePath,
        extractionRoot: path.join(dir, 'publish-third'),
      })
    ).rejects.toThrow(/neither.*pre-state.*candidate/i)

    await writeFile(fixture.currentPath, opaquePrevious)
    await expect(
      verifyPublishIntentV2({
        intentPath: fixture.intentPath,
        intentArtifactId: '105',
        intentArtifactSha256: fixture.intentSha256,
        currentRegistryPath: fixture.currentPath,
        currentEtag: '"wrong-etag"',
        backupRegistryPath: fixture.backupPath,
        backupEtag: '"backup"',
        candidateManifestPath: fixture.candidatePath,
        registryArtifactPath: fixture.registryPath,
        websiteArtifactPath: fixture.websitePath,
        extractionRoot: path.join(dir, 'publish-wrong-etag'),
      })
    ).rejects.toThrow(/neither.*pre-state.*candidate/i)
  })

  function digestText(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  function artifactMetadata(options: {
    artifactId: string
    artifactName: string
    artifactSha256: string
    runId: string
    sourceSha: string
  }): unknown {
    return {
      id: Number(options.artifactId),
      name: options.artifactName,
      expired: false,
      digest: `sha256:${options.artifactSha256}`,
      archive_download_url:
        `https://api.github.com/repos/motrixapp/plugin-registry/actions/artifacts/` +
        `${options.artifactId}/zip`,
      workflow_run: {
        id: Number(options.runId),
        repository_id: 77,
        head_repository_id: 77,
        head_branch: 'main',
        head_sha: options.sourceSha,
      },
    }
  }

  async function createRestoreSide(options: {
    prefix: string
    baseId: number
    registry: string
    producerSourceSha: string
    websiteSourceSha: string
    rawConclusion?: string
  }) {
    const runId = String(options.baseId)
    const registry = await createCandidate({
      registry: options.registry,
      filename: `${options.prefix}-registry.zip`,
      artifactId: String(options.baseId + 1),
      runId,
      sourceSha: options.producerSourceSha,
    })
    const website = await createWebsite({
      candidate: registry.candidate,
      filename: `${options.prefix}-website.zip`,
      sourceSha: options.websiteSourceSha,
      buildRunId: runId,
    })
    const websiteArtifactId = String(options.baseId + 2)
    const candidateArtifactId = String(options.baseId + 3)
    const completionArtifactId = String(options.baseId + 4)
    const intentArtifactId = String(options.baseId + 5)
    const completionRunId = String(options.baseId + 10)
    const candidateArtifactSha256 = digestText(`${options.prefix}-candidate`)
    const completionArtifactSha256 = digestText(`${options.prefix}-completion-zip`)
    const previousSha256 = digestText(`${options.prefix}-previous`)
    const operationId = releaseOperationId({
      repository: 'motrixapp/plugin-registry',
      registrySourceSha: options.producerSourceSha,
      websiteSourceSha: options.websiteSourceSha,
      candidateSha256: registry.candidate.registry.sha256,
      websiteDistSha256: website.website.distSha256,
    })
    const release = ReleaseManifestSchema.parse({
      schemaVersion: 2,
      kind: 'release',
      operationId,
      intent: {
        artifactId: intentArtifactId,
        artifactName: `intent-${options.prefix}.json`,
        artifactSha256: digestText(`${options.prefix}-intent`),
        producerRunId: runId,
      },
      producer: {
        repository: 'motrixapp/plugin-registry',
        runId,
        registrySourceSha: options.producerSourceSha,
        websiteSourceSha: options.websiteSourceSha,
        websiteBuildRunId: runId,
      },
      completion: {
        workflowRunId: completionRunId,
        workflowRunAttempt: '1',
        sourceSha: options.producerSourceSha,
        event: 'workflow_dispatch',
        transitionMode: 'resume',
      },
      registry: {
        previousSha256,
        previousEtag: '"previous"',
        backupKey: `private/backups/plugins/${operationId}-${previousSha256}.json`,
        backupEtag: '"backup"',
        sha256: registry.candidate.registry.sha256,
        bytes: registry.candidate.registry.bytes,
        etag: '"published"',
        sourceSha: options.producerSourceSha,
        workflowRunId: runId,
        artifactId: registry.candidate.registry.artifactId,
        artifactName: path.basename(registry.archivePath),
        artifactSha256: registry.archiveSha256,
      },
      website: {
        artifactId: websiteArtifactId,
        artifactName: path.basename(website.archivePath),
        artifactSha256: website.archiveSha256,
        runId,
        sourceSha: options.websiteSourceSha,
        distSha256: website.website.distSha256,
        registrySha256: registry.candidate.registry.sha256,
        registryArtifactSha256: registry.archiveSha256,
        registryWorkflowRunId: runId,
        registryArtifactId: registry.candidate.registry.artifactId,
      },
      candidateManifestArtifact: {
        filename: `candidate-${options.prefix}.json`,
        id: candidateArtifactId,
        sha256: candidateArtifactSha256,
      },
    })
    const releaseBytes = jsonBytes(release)
    const tuple = {
      producer: {
        repositoryId: '77',
        workflowId: '88',
        workflowPath: '.github/workflows/publish.yml' as const,
        sourceSha: options.producerSourceSha,
        event: 'push' as const,
      },
      candidateManifestArtifact: {
        artifactId: candidateArtifactId,
        artifactName: `candidate-${options.prefix}.json`,
        artifactSha256: candidateArtifactSha256,
        workflowRunId: runId,
      },
      registry: {
        sha256: registry.candidate.registry.sha256,
        bytes: registry.candidate.registry.bytes,
        artifactId: registry.candidate.registry.artifactId,
        artifactName: path.basename(registry.archivePath),
        artifactSha256: registry.archiveSha256,
        workflowRunId: runId,
      },
      website: {
        artifactId: websiteArtifactId,
        artifactName: path.basename(website.archivePath),
        artifactSha256: website.archiveSha256,
        runId,
        sourceRepository: 'motrixapp/motrix-website',
        sourceSha: options.websiteSourceSha,
        distSha256: website.website.distSha256,
        registrySha256: registry.candidate.registry.sha256,
        registryArtifactSha256: registry.archiveSha256,
        registryWorkflowRunId: runId,
        registryArtifactId: registry.candidate.registry.artifactId,
      },
      completion: {
        artifactId: completionArtifactId,
        artifactName: `release-${options.prefix}.json`,
        artifactSha256: completionArtifactSha256,
        manifestSha256: createHash('sha256').update(releaseBytes).digest('hex'),
        runId: completionRunId,
        runAttempt: '1',
        sourceSha: options.producerSourceSha,
        event: 'workflow_dispatch' as const,
      },
      artifactSource: { kind: 'github' as const },
    }
    const proofRoot = path.join(dir, `proof-${options.prefix}`)
    await mkdir(proofRoot)
    const writeProof = async (name: string, value: unknown) =>
      writeFile(path.join(proofRoot, name), jsonBytes(value))
    await writeProof('candidate-artifact.json', artifactMetadata({
      artifactId: candidateArtifactId,
      artifactName: tuple.candidateManifestArtifact.artifactName,
      artifactSha256: candidateArtifactSha256,
      runId,
      sourceSha: options.producerSourceSha,
    }))
    await writeProof('registry-artifact.json', artifactMetadata({
      ...tuple.registry,
      runId,
      sourceSha: options.producerSourceSha,
    }))
    await writeProof('website-artifact.json', artifactMetadata({
      ...tuple.website,
      runId,
      sourceSha: options.producerSourceSha,
    }))
    await writeProof('raw-run.json', {
      id: Number(runId),
      workflow_id: 88,
      run_attempt: 1,
      repository: { id: 77, full_name: 'motrixapp/plugin-registry' },
      head_repository: { id: 77, full_name: 'motrixapp/plugin-registry' },
      head_sha: options.producerSourceSha,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: options.rawConclusion ?? 'success',
      path: '.github/workflows/publish.yml',
    })
    await writeProof('raw-run-endpoint.json', {
      url: `https://api.github.com/repos/motrixapp/plugin-registry/actions/runs/${runId}`,
    })
    await writeProof('raw-workflow.json', {
      id: 88,
      path: '.github/workflows/publish.yml',
    })
    await writeFile(path.join(proofRoot, 'release-manifest.json'), releaseBytes)
    await writeProof('completion-artifact.json', artifactMetadata({
      artifactId: completionArtifactId,
      artifactName: tuple.completion.artifactName,
      artifactSha256: completionArtifactSha256,
      runId: completionRunId,
      sourceSha: options.producerSourceSha,
    }))
    await writeProof('completion-run.json', {
      id: Number(completionRunId),
      workflow_id: 88,
      run_attempt: 1,
      repository: { id: 77, full_name: 'motrixapp/plugin-registry' },
      head_repository: { id: 77, full_name: 'motrixapp/plugin-registry' },
      head_sha: options.producerSourceSha,
      head_branch: 'main',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/publish.yml',
    })
    await writeProof('completion-run-endpoint.json', {
      url:
        `https://api.github.com/repos/motrixapp/plugin-registry/actions/runs/` +
        `${completionRunId}/attempts/1`,
    })
    await writeProof('completion-workflow.json', {
      id: 88,
      path: '.github/workflows/publish.yml',
    })
    return { tuple, registry, website, proofRoot, release }
  }

  async function createRestoreFixture(rawConclusion = 'success') {
    const from = await createRestoreSide({
      prefix: 'from',
      baseId: 1000,
      registry: registryJson('2026-08-03T00:00:00.000Z'),
      producerSourceSha: SOURCE_C,
      websiteSourceSha: SOURCE_D,
      rawConclusion,
    })
    const target = await createRestoreSide({
      prefix: 'target',
      baseId: 2000,
      registry: registryJson('2026-08-02T00:00:00.000Z'),
      producerSourceSha: SOURCE_A,
      websiteSourceSha: SOURCE_B,
      rawConclusion,
    })
    const manifest = RestoreManifestSchema.parse({
      schemaVersion: 2,
      from: {
        ...from.tuple,
        registry: { ...from.tuple.registry, etag: '"from-live"' },
      },
      to: {
        ...target.tuple,
        registry: {
          ...target.tuple.registry,
          sourceKey: 'private/backups/plugins/target-registry-v2.json',
          sourceEtag: '"target-source"',
        },
      },
    })
    const manifestPath = path.join(dir, 'restore-manifest.json')
    const currentPath = path.join(dir, 'restore-current.json')
    const targetPath = path.join(dir, 'restore-target.json')
    const proofRoot = path.join(dir, 'proof-root')
    await mkdir(proofRoot)
    await writeFile(manifestPath, jsonBytes(manifest))
    await writeFile(currentPath, from.registry.registry)
    await writeFile(targetPath, target.registry.registry)
    await mkdir(path.join(proofRoot, 'from'))
    await mkdir(path.join(proofRoot, 'to'))
    for (const [side, source] of [['from', from], ['to', target]] as const) {
      for (const name of await readdir(source.proofRoot)) {
        await writeFile(
          path.join(proofRoot, side, name),
          await readFile(path.join(source.proofRoot, name))
        )
      }
    }
    return { manifest, manifestPath, currentPath, targetPath, proofRoot, from, target }
  }

  async function verifyRestoreFixture(
    fixture: Awaited<ReturnType<typeof createRestoreFixture>>,
    suffix: string,
    currentEtag = '"from-live"'
  ) {
    const planOutputPath = path.join(dir, `${suffix}-plan.json`)
    const intentOutputPath = path.join(dir, `${suffix}-intent.json`)
    const authorizedManifestOutputPath = path.join(dir, `${suffix}-authorized.json`)
    const plan = await verifyRestoreV2({
      manifestPath: fixture.manifestPath,
      currentRegistryPath: fixture.currentPath,
      targetRegistrySourcePath: fixture.targetPath,
      targetWebsiteArtifactPath: fixture.target.website.archivePath,
      targetRegistryArtifactPath: fixture.target.registry.archivePath,
      fromWebsiteArtifactPath: fixture.from.website.archivePath,
      fromRegistryArtifactPath: fixture.from.registry.archivePath,
      sourceProofRoot: fixture.proofRoot,
      currentEtag,
      targetSourceEtag: '"target-source"',
      extractionRoot: path.join(dir, `${suffix}-extracted`),
      planOutputPath,
      intentOutputPath,
      authorizedManifestOutputPath,
    })
    return { plan, planOutputPath, intentOutputPath, authorizedManifestOutputPath }
  }

  async function createSelfRoot(
    fixture: Awaited<ReturnType<typeof createRestoreFixture>>,
    verified: Awaited<ReturnType<typeof verifyRestoreFixture>>
  ): Promise<string> {
    const root = path.join(dir, 'self-proof')
    await mkdir(root)
    await mkdir(path.join(root, 'reverse'))
    await mkdir(path.join(root, 'target'))
    await writeFile(path.join(root, 'intent.json'), await readFile(verified.intentOutputPath))
    await writeFile(
      path.join(root, 'authorized-manifest.json'),
      await readFile(verified.authorizedManifestOutputPath)
    )
    await writeFile(path.join(root, 'reverse/plugins.json'), fixture.from.registry.registry)
    await writeFile(
      path.join(root, 'reverse/registry.zip'),
      await readFile(fixture.from.registry.archivePath)
    )
    await writeFile(
      path.join(root, 'reverse/website.zip'),
      await readFile(fixture.from.website.archivePath)
    )
    await writeFile(
      path.join(root, 'target/registry.zip'),
      await readFile(fixture.target.registry.archivePath)
    )
    await writeFile(
      path.join(root, 'target/website.zip'),
      await readFile(fixture.target.website.archivePath)
    )
    return root
  }

  it('completes, reads back, self-resumes, and reverses from durable R2 proof only', async () => {
    const fixture = await createRestoreFixture('timed_out')
    const verified = await verifyRestoreFixture(fixture, 'restore-cas')
    expect(RestorePlanSchema.parse(verified.plan).mode).toBe('cas')
    expect(deriveRestoreOperationV2(fixture.manifest).operationKey).toBe(
      verified.plan.operationKey
    )
    const selfRoot = await createSelfRoot(fixture, verified)
    await writeFile(fixture.currentPath, fixture.target.registry.registry)
    const selfPlan = await verifyRestoreSelfV2({
      manifestPath: fixture.manifestPath,
      currentRegistryPath: fixture.currentPath,
      selfProofRoot: selfRoot,
      currentEtag: '"observed-target"',
      extractionRoot: path.join(dir, 'self-extracted'),
      planOutputPath: path.join(dir, 'self-plan.json'),
    })
    expect(selfPlan.mode).toBe('resume')
    const completionPath = path.join(dir, 'completion.json')
    const reverseManifestPath = path.join(dir, 'reverse-manifest.json')
    await completeRestoreV2({
      manifestPath: fixture.manifestPath,
      planPath: path.join(dir, 'self-plan.json'),
      intentPath: path.join(selfRoot, 'intent.json'),
      reverseRegistryPayloadPath: path.join(selfRoot, 'reverse/plugins.json'),
      reverseRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      reverseWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      authorizedManifestPath: path.join(selfRoot, 'authorized-manifest.json'),
      restoredRegistryPath: fixture.currentPath,
      observedTargetEtag: '"observed-target"',
      reverseRegistrySourceEtag: '"reverse-source"',
      repositoryId: '77',
      workflowId: '99',
      runId: '3000',
      runAttempt: '1',
      sourceSha: SOURCE_A,
      completionOutputPath: completionPath,
      reverseManifestOutputPath: reverseManifestPath,
    })
    const completeBase = {
      manifestPath: fixture.manifestPath,
      planPath: path.join(dir, 'self-plan.json'),
      intentPath: path.join(selfRoot, 'intent.json'),
      reverseRegistryPayloadPath: path.join(selfRoot, 'reverse/plugins.json'),
      reverseRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      reverseWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      authorizedManifestPath: path.join(selfRoot, 'authorized-manifest.json'),
      restoredRegistryPath: fixture.currentPath,
      observedTargetEtag: '"observed-target"',
      reverseRegistrySourceEtag: '"reverse-source"',
      repositoryId: '77',
      workflowId: '99',
      runId: '4000',
      runAttempt: '2',
      sourceSha: SOURCE_B,
    }
    const completionOnlyReverse = path.join(dir, 'completion-only-reverse.json')
    await completeRestoreV2({
      ...completeBase,
      existingCompletionPath: completionPath,
      completionOutputPath: path.join(dir, 'must-not-write-completion.json'),
      reverseManifestOutputPath: completionOnlyReverse,
    })
    expect(await readFile(completionOnlyReverse, 'utf8')).toBe(
      await readFile(reverseManifestPath, 'utf8')
    )
    const reverseOnlyCompletion = path.join(dir, 'reverse-only-completion.json')
    await completeRestoreV2({
      ...completeBase,
      existingReverseManifestPath: reverseManifestPath,
      completionOutputPath: reverseOnlyCompletion,
      reverseManifestOutputPath: path.join(dir, 'must-not-write-reverse.json'),
    })
    expect(await readFile(reverseOnlyCompletion, 'utf8')).toBe(
      await readFile(completionPath, 'utf8')
    )
    await expect(completeRestoreV2({
      ...completeBase,
      existingCompletionPath: completionPath,
      existingReverseManifestPath: reverseManifestPath,
      completionOutputPath: path.join(dir, 'response-lost-completion.json'),
      reverseManifestOutputPath: path.join(dir, 'response-lost-reverse.json'),
    })).resolves.toMatchObject({ completion: { operationKey: selfPlan.operationKey } })
    await expect(verifyRestoreCompletionV2({
      manifestPath: fixture.manifestPath,
      planPath: path.join(dir, 'self-plan.json'),
      intentPath: path.join(selfRoot, 'intent.json'),
      reverseRegistryPayloadPath: path.join(selfRoot, 'reverse/plugins.json'),
      reverseRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      reverseWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      authorizedManifestPath: path.join(selfRoot, 'authorized-manifest.json'),
      completionPath,
      reverseManifestPath,
      restoredRegistryPath: fixture.currentPath,
      observedTargetEtag: '"observed-target"',
      reverseRegistrySourceEtag: '"reverse-source"',
    })).resolves.toBeUndefined()
    const nonCanonicalReversePath = path.join(
      dir,
      'noncanonical-reverse-manifest.json'
    )
    await writeFile(
      nonCanonicalReversePath,
      jsonBytes(await readJsonFile(reverseManifestPath))
    )
    await expect(completeRestoreV2({
      ...completeBase,
      existingReverseManifestPath: nonCanonicalReversePath,
      completionOutputPath: path.join(dir, 'noncanonical-completion-output.json'),
      reverseManifestOutputPath: path.join(dir, 'must-not-rewrite-reverse.json'),
    })).rejects.toThrow(/deterministic reconstruction/i)
    await expect(verifyRestoreCompletionV2({
      manifestPath: fixture.manifestPath,
      planPath: path.join(dir, 'self-plan.json'),
      intentPath: path.join(selfRoot, 'intent.json'),
      reverseRegistryPayloadPath: path.join(selfRoot, 'reverse/plugins.json'),
      reverseRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      reverseWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      authorizedManifestPath: path.join(selfRoot, 'authorized-manifest.json'),
      completionPath,
      reverseManifestPath: nonCanonicalReversePath,
      restoredRegistryPath: fixture.currentPath,
      observedTargetEtag: '"observed-target"',
      reverseRegistrySourceEtag: '"reverse-source"',
    })).rejects.toThrow(/reverse manifest differs/i)
    await expect(verifyRestoreCompletionV2({
      manifestPath: fixture.manifestPath,
      planPath: path.join(dir, 'self-plan.json'),
      intentPath: path.join(selfRoot, 'intent.json'),
      reverseRegistryPayloadPath: path.join(selfRoot, 'reverse/plugins.json'),
      reverseRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      reverseWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      authorizedManifestPath: path.join(selfRoot, 'authorized-manifest.json'),
      completionPath,
      reverseManifestPath,
      restoredRegistryPath: fixture.currentPath,
      observedTargetEtag: '"different-etag"',
      reverseRegistrySourceEtag: '"reverse-source"',
    })).rejects.toThrow(/completion differs/i)

    const parentProof = path.join(dir, 'parent-proof')
    await mkdir(parentProof)
    await writeFile(path.join(parentProof, 'intent.json'), await readFile(path.join(selfRoot, 'intent.json')))
    await writeFile(path.join(parentProof, 'completion.json'), await readFile(completionPath))
    await writeFile(path.join(parentProof, 'reverse-manifest.json'), await readFile(reverseManifestPath))
    await writeFile(fixture.currentPath, fixture.target.registry.registry)
    const reversePlan = await verifyRestoreV2({
      manifestPath: reverseManifestPath,
      currentRegistryPath: fixture.currentPath,
      targetRegistrySourcePath: path.join(selfRoot, 'reverse/plugins.json'),
      targetWebsiteArtifactPath: path.join(selfRoot, 'reverse/website.zip'),
      targetRegistryArtifactPath: path.join(selfRoot, 'reverse/registry.zip'),
      fromWebsiteArtifactPath: path.join(selfRoot, 'target/website.zip'),
      fromRegistryArtifactPath: path.join(selfRoot, 'target/registry.zip'),
      sourceProofRoot: parentProof,
      currentEtag: '"observed-target"',
      targetSourceEtag: '"reverse-source"',
      extractionRoot: path.join(dir, 'reverse-extracted'),
      planOutputPath: path.join(dir, 'reverse-plan.json'),
      intentOutputPath: path.join(dir, 'reverse-intent.json'),
      authorizedManifestOutputPath: path.join(dir, 'reverse-authorized.json'),
    })
    expect(reversePlan.mode).toBe('cas')
  })

  it('accepts all 128 valid CAS pre-record subsets and rejects corruption', async () => {
    const fixture = await createRestoreFixture()
    const verified = await verifyRestoreFixture(fixture, 'partial')
    const records = {
      intentPath: verified.intentOutputPath,
      reverseRegistryPayloadPath: fixture.currentPath,
      reverseRegistryArtifactPath: fixture.from.registry.archivePath,
      reverseWebsiteArtifactPath: fixture.from.website.archivePath,
      targetRegistryArtifactPath: fixture.target.registry.archivePath,
      targetWebsiteArtifactPath: fixture.target.website.archivePath,
      authorizedManifestPath: verified.authorizedManifestOutputPath,
    }
    const entries = Object.entries(records)
    for (let mask = 0; mask < 2 ** entries.length; mask += 1) {
      const subset = Object.fromEntries(
        entries.filter((_, index) => (mask & (1 << index)) !== 0)
      )
      await expect(verifyRestoreOperationV2({
        manifestPath: fixture.manifestPath,
        planPath: verified.planOutputPath,
        ...subset,
        allowMissingForCas: true,
      })).resolves.toBeUndefined()
    }
    const corrupt = path.join(dir, 'corrupt-registry.zip')
    await writeFile(corrupt, Buffer.from('bad'))
    await expect(verifyRestoreOperationV2({
      manifestPath: fixture.manifestPath,
      planPath: verified.planOutputPath,
      reverseRegistryArtifactPath: corrupt,
      allowMissingForCas: true,
    })).rejects.toThrow()
  })

  it('rejects completion attempt confusion and keeps raw rerun mutations out of intent identity', async () => {
    const fixture = await createRestoreFixture('failure')
    const first = await verifyRestoreFixture(fixture, 'stable-first')
    for (const side of ['from', 'to']) {
      const rawPath = path.join(fixture.proofRoot, side, 'raw-run.json')
      const raw = await readJsonFile(rawPath) as Record<string, unknown>
      await writeFile(rawPath, jsonBytes({ ...raw, run_attempt: 2, conclusion: 'success' }))
    }
    const second = await verifyRestoreFixture(fixture, 'stable-second')
    expect(await readFile(second.intentOutputPath, 'utf8')).toBe(
      await readFile(first.intentOutputPath, 'utf8')
    )
    const completionRunPath = path.join(
      fixture.proofRoot,
      'to/completion-run.json'
    )
    const completionRun = await readJsonFile(completionRunPath) as Record<string, unknown>
    await writeFile(completionRunPath, jsonBytes({ ...completionRun, run_attempt: 2 }))
    await expect(verifyRestoreFixture(fixture, 'bad-attempt')).rejects.toThrow(
      /successful trusted|attempt/i
    )
  })

  it('keeps the reviewed CLI argument contracts executable and strict', async () => {
    const release = await createReleaseFixture()
    await expect(
      runReleaseContractCli([
        'validate-release-intent-v2',
        release.intentPath,
        'motrixapp/plugin-registry',
        '101',
        release.operationId,
      ])
    ).resolves.toBeUndefined()
    const inspectPath = path.join(dir, 'cli-inspect.json')
    await runReleaseContractCli([
      'inspect-release-intent-v2',
      release.intentPath,
      'motrixapp/plugin-registry',
      '101',
      release.operationId,
      inspectPath,
    ])
    expect(await readJsonFile(inspectPath)).toMatchObject({
      artifacts: { registry: { id: '102' } },
    })

    const restore = await createRestoreFixture()
    await expect(
      runReleaseContractCli(['validate-restore-v2', restore.manifestPath])
    ).resolves.toBeUndefined()
    await expect(
      runReleaseContractCli(['validate-restore', restore.manifestPath])
    ).rejects.toThrow(/usage/i)
  })

  it('rejects v1 restore records, restoreEtag, sibling mismatch, and unknown fields', () => {
    expect(() =>
      RestoreManifestSchema.parse({
        schemaVersion: 1,
        registry: { restoreEtag: '"legacy"' },
      })
    ).toThrow()
    const manifest = {
      schemaVersion: 2,
      from: {
        producer: {
          repositoryId: '1',
          workflowId: '2',
          workflowPath: '.github/workflows/publish.yml',
          sourceSha: SOURCE_A,
          event: 'push',
        },
        registry: {
          sha256: 'a'.repeat(64),
          bytes: 1,
          artifactId: '3',
          artifactName: 'registry.zip',
          artifactSha256: 'b'.repeat(64),
          workflowRunId: '4',
          etag: '"from"',
        },
        website: {
          artifactId: '5',
          artifactName: 'website.zip',
          artifactSha256: 'c'.repeat(64),
          runId: '4',
          sourceRepository: 'motrixapp/motrix-website',
          sourceSha: SOURCE_B,
          distSha256: 'd'.repeat(64),
          registrySha256: 'a'.repeat(64),
          registryArtifactSha256: 'b'.repeat(64),
          registryWorkflowRunId: '4',
          registryArtifactId: '3',
        },
      },
      to: undefined,
    }
    expect(() => RestoreManifestSchema.parse(manifest)).toThrow()
    expect(() =>
      RestoreManifestSchema.parse({
        ...manifest,
        unexpected: true,
      })
    ).toThrow()
  })
})
