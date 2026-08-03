import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Unzip, UnzipInflate, unzipSync } from 'fflate'
import { z } from 'zod'
import { RegistryFileSchema } from '../schema/registry.ts'
import { MAX_REGISTRY_BYTES } from './aggregate.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const SourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const GitHubNumericIdSchema = z.string().regex(/^[1-9][0-9]*$/)
const GitHubRunAttemptSchema = z.string().regex(/^[1-9][0-9]*$/)
const GitHubRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const SafeArtifactFilenameSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const PublishWorkflowPathSchema = z.literal('.github/workflows/publish.yml')
const ProducerEventSchema = z.enum(['push', 'workflow_dispatch'])
const CompletedGitHubConclusionSchema = z.enum([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
])
const RestoreWorkflowPathSchema = z.literal('.github/workflows/restore.yml')
const REGISTRY_ARTIFACT_ENTRY = 'plugins.json'
const WEBSITE_ARTIFACT_MANIFEST_ENTRY = 'website-artifact-manifest.json'
const WEBSITE_ARTIFACT_DIST_PREFIX = 'dist/'
const MAX_ARTIFACT_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_ARTIFACT_ENTRIES = 10_000
const MAX_ARTIFACT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
const MAX_WEBSITE_MANIFEST_BYTES = 64 * 1024
const MAX_ZIP_ENTRY_PATH_BYTES = 1024
const OpaqueEtagSchema = z
  .string()
  .min(1, 'ETag identity is required')
  .max(256, 'ETag identity is too long')
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    'ETag must not contain whitespace padding or control characters'
  )
const PrivateBackupKeySchema = z
  .string()
  .max(512)
  .refine((value) => {
    if (
      !/^private\/backups\/plugins\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(
        value
      )
    ) {
      return false
    }
    return value
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  }, 'backup key must be a private plugins backup JSON key')

const RestoreRegistrySourceKeySchema = z
  .string()
  .max(512)
  .refine((value) => {
    if (
      !(
        /^private\/backups\/plugins\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(
          value
        ) ||
        /^restore-operations\/v2\/[a-f0-9]{64}\/reverse\/plugins\.json$/.test(
          value
        )
      )
    ) {
      return false
    }
    return value
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  }, 'restore source key must be an immutable private registry JSON key')

const RegistryArtifactIdentitySchema = z
  .object({
    sha256: Sha256Schema,
    bytes: z.number().int().positive().max(MAX_REGISTRY_BYTES),
    sourceSha: SourceShaSchema,
    runId: GitHubNumericIdSchema,
    artifactId: GitHubNumericIdSchema,
    artifactSha256: Sha256Schema,
  })
  .strict()

export const RegistryCandidateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    registry: RegistryArtifactIdentitySchema,
  })
  .strict()

export type RegistryCandidateManifest = z.infer<
  typeof RegistryCandidateManifestSchema
>

export const WebsiteArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    registrySha256: Sha256Schema,
    registryWorkflowRunId: GitHubNumericIdSchema,
    registryArtifactId: GitHubNumericIdSchema,
    registryArtifactSha256: Sha256Schema,
    websiteSourceSha: SourceShaSchema,
    websiteBuildRunId: GitHubNumericIdSchema,
    distSha256: Sha256Schema,
  })
  .strict()

export type WebsiteArtifactManifest = z.infer<
  typeof WebsiteArtifactManifestSchema
>

const RawArtifactIdentitySchema = z
  .object({
    filename: SafeArtifactFilenameSchema,
    id: GitHubNumericIdSchema,
    sha256: Sha256Schema,
  })
  .strict()

const ReleaseProducerSchema = z
  .object({
    repository: GitHubRepositorySchema,
    runId: GitHubNumericIdSchema,
    registrySourceSha: SourceShaSchema,
    websiteSourceSha: SourceShaSchema,
    websiteBuildRunId: GitHubNumericIdSchema,
  })
  .strict()

const ReleaseIntentArtifactsSchema = z
  .object({
    candidate_manifest: RawArtifactIdentitySchema,
    registry: RawArtifactIdentitySchema,
    website: RawArtifactIdentitySchema,
  })
  .strict()

export const ReleaseIntentSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('release-intent'),
    operationId: Sha256Schema,
    producer: ReleaseProducerSchema,
    registry: z
      .object({
        previousSha256: Sha256Schema,
        previousEtag: OpaqueEtagSchema,
        backupKey: PrivateBackupKeySchema,
        backupEtag: OpaqueEtagSchema,
        candidate: RegistryArtifactIdentitySchema,
      })
      .strict(),
    website: WebsiteArtifactManifestSchema,
    artifacts: ReleaseIntentArtifactsSchema,
  })
  .strict()
  .superRefine((intent, ctx) => {
    const { candidate } = intent.registry
    if (
      candidate.sourceSha !== intent.producer.registrySourceSha ||
      candidate.runId !== intent.producer.runId ||
      intent.producer.websiteBuildRunId !== intent.producer.runId ||
      intent.website.websiteSourceSha !== intent.producer.websiteSourceSha ||
      intent.website.websiteBuildRunId !== intent.producer.websiteBuildRunId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['producer'],
        message: 'release intent producer does not bind the candidate and website run',
      })
    }
    if (!sameRegistryIdentity(candidate, intent.website)) {
      ctx.addIssue({
        code: 'custom',
        path: ['website'],
        message: 'release intent website does not bind the exact registry candidate',
      })
    }
    if (
      intent.artifacts.registry.id !== candidate.artifactId ||
      intent.artifacts.registry.sha256 !== candidate.artifactSha256
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', 'registry'],
        message: 'release intent registry raw artifact differs from the candidate',
      })
    }
  })

export type ReleaseIntent = z.infer<typeof ReleaseIntentSchema>

export const PublishIntentPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    mode: z.enum(['cas', 'resume']),
    operationId: Sha256Schema,
    intentArtifactId: GitHubNumericIdSchema,
    intentArtifactSha256: Sha256Schema,
    candidateSha256: Sha256Schema,
    previousSha256: Sha256Schema,
    previousEtag: OpaqueEtagSchema,
    backupKey: PrivateBackupKeySchema,
    backupEtag: OpaqueEtagSchema,
    currentSha256: Sha256Schema,
    currentEtag: OpaqueEtagSchema,
  })
  .strict()

export type PublishIntentPlan = z.infer<typeof PublishIntentPlanSchema>

export const ReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('release'),
    operationId: Sha256Schema,
    intent: z
      .object({
        artifactId: GitHubNumericIdSchema,
        artifactName: SafeArtifactFilenameSchema,
        artifactSha256: Sha256Schema,
        producerRunId: GitHubNumericIdSchema,
      })
      .strict(),
    producer: ReleaseProducerSchema,
    completion: z
      .object({
        workflowRunId: GitHubNumericIdSchema,
        workflowRunAttempt: GitHubRunAttemptSchema,
        sourceSha: SourceShaSchema,
        event: ProducerEventSchema,
        transitionMode: z.enum(['cas', 'resume']),
      })
      .strict(),
    registry: z
      .object({
        previousSha256: Sha256Schema,
        previousEtag: OpaqueEtagSchema,
        backupKey: PrivateBackupKeySchema,
        backupEtag: OpaqueEtagSchema,
        sha256: Sha256Schema,
        bytes: z.number().int().positive().max(MAX_REGISTRY_BYTES),
        etag: OpaqueEtagSchema,
        sourceSha: SourceShaSchema,
        workflowRunId: GitHubNumericIdSchema,
        artifactId: GitHubNumericIdSchema,
        artifactName: SafeArtifactFilenameSchema,
        artifactSha256: Sha256Schema,
      })
      .strict(),
    website: z
      .object({
        artifactId: GitHubNumericIdSchema,
        artifactName: SafeArtifactFilenameSchema,
        artifactSha256: Sha256Schema,
        runId: GitHubNumericIdSchema,
        sourceSha: SourceShaSchema,
        distSha256: Sha256Schema,
        registrySha256: Sha256Schema,
        registryArtifactSha256: Sha256Schema,
        registryWorkflowRunId: GitHubNumericIdSchema,
        registryArtifactId: GitHubNumericIdSchema,
      })
      .strict(),
    candidateManifestArtifact: RawArtifactIdentitySchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.registry.sha256 !== manifest.website.registrySha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['website', 'registrySha256'],
        message: 'release website registry SHA differs from the live registry',
      })
    }
    if (
      manifest.registry.artifactId !== manifest.website.registryArtifactId ||
      manifest.registry.artifactSha256 !==
        manifest.website.registryArtifactSha256 ||
      manifest.registry.workflowRunId !==
        manifest.website.registryWorkflowRunId ||
      manifest.website.runId !== manifest.registry.workflowRunId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['website'],
        message: 'release website does not bind the exact registry raw artifact tuple',
      })
    }
  })

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>

const RestoreProducerSchema = z
  .object({
    repositoryId: GitHubNumericIdSchema,
    workflowId: GitHubNumericIdSchema,
    workflowPath: PublishWorkflowPathSchema,
    sourceSha: SourceShaSchema,
    event: ProducerEventSchema,
  })
  .strict()

const RestoreRegistryBaseSchema = z
  .object({
    sha256: Sha256Schema,
    bytes: z.number().int().positive().max(MAX_REGISTRY_BYTES),
    artifactId: GitHubNumericIdSchema,
    artifactName: SafeArtifactFilenameSchema,
    artifactSha256: Sha256Schema,
    workflowRunId: GitHubNumericIdSchema,
  })
  .strict()

const RestoreWebsiteSchema = z
  .object({
    artifactId: GitHubNumericIdSchema,
    artifactName: SafeArtifactFilenameSchema,
    artifactSha256: Sha256Schema,
    runId: GitHubNumericIdSchema,
    sourceRepository: GitHubRepositorySchema,
    sourceSha: SourceShaSchema,
    distSha256: Sha256Schema,
    registrySha256: Sha256Schema,
    registryArtifactSha256: Sha256Schema,
    registryWorkflowRunId: GitHubNumericIdSchema,
    registryArtifactId: GitHubNumericIdSchema,
  })
  .strict()

const RestoreCandidateManifestArtifactSchema = z
  .object({
    artifactId: GitHubNumericIdSchema,
    artifactName: SafeArtifactFilenameSchema,
    artifactSha256: Sha256Schema,
    workflowRunId: GitHubNumericIdSchema,
  })
  .strict()

const RestoreReleaseCompletionSchema = z
  .object({
    artifactId: GitHubNumericIdSchema,
    artifactName: SafeArtifactFilenameSchema,
    artifactSha256: Sha256Schema,
    manifestSha256: Sha256Schema,
    runId: GitHubNumericIdSchema,
    runAttempt: GitHubRunAttemptSchema,
    sourceSha: SourceShaSchema,
    event: ProducerEventSchema,
  })
  .strict()

const RestoreWorkflowIdentitySchema = z
  .object({
    repositoryId: GitHubNumericIdSchema,
    workflowId: GitHubNumericIdSchema,
    workflowPath: RestoreWorkflowPathSchema,
    runId: GitHubNumericIdSchema,
    runAttempt: GitHubRunAttemptSchema,
    sourceSha: SourceShaSchema,
    event: z.literal('workflow_dispatch'),
  })
  .strict()

const GitHubArtifactSourceSchema = z
  .object({
    kind: z.literal('github'),
  })
  .strict()

const R2OperationArtifactSourceSchema = z
  .object({
    kind: z.literal('r2-operation'),
    parentOperationKey: Sha256Schema,
    intentKey: z.string(),
    intentSha256: Sha256Schema,
    completionKey: z.string(),
    completionSha256: Sha256Schema,
    reverseManifestKey: z.string(),
    completionIdentity: z
      .object({
        mode: z.enum(['cas', 'resume']),
        workflow: RestoreWorkflowIdentitySchema,
        targetEtag: OpaqueEtagSchema,
        reverseRegistrySourceEtag: OpaqueEtagSchema,
      })
      .strict(),
    registryArtifactKey: z.string(),
    websiteArtifactKey: z.string(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const base = `restore-operations/v2/${source.parentOperationKey}/`
    if (
      source.intentKey !== `${base}intent.json` ||
      source.completionKey !== `${base}completion.json` ||
      source.reverseManifestKey !== `${base}reverse/restore-manifest.json` ||
      ![
        `${base}reverse/registry.zip`,
        `${base}target/registry.zip`,
      ].includes(source.registryArtifactKey) ||
      ![
        `${base}reverse/website.zip`,
        `${base}target/website.zip`,
      ].includes(source.websiteArtifactKey) ||
      source.registryArtifactKey.replace('registry.zip', '') !==
        source.websiteArtifactKey.replace('website.zip', '')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'R2 artifact source keys do not form one parent operation pair',
      })
    }
  })

const RestoreArtifactSourceSchema = z.discriminatedUnion('kind', [
  GitHubArtifactSourceSchema,
  R2OperationArtifactSourceSchema,
])

const RestoreFromTupleSchema = z
  .object({
    producer: RestoreProducerSchema,
    candidateManifestArtifact: RestoreCandidateManifestArtifactSchema,
    registry: RestoreRegistryBaseSchema.extend({
      etag: OpaqueEtagSchema,
    }).strict(),
    website: RestoreWebsiteSchema,
    completion: RestoreReleaseCompletionSchema,
    artifactSource: RestoreArtifactSourceSchema,
  })
  .strict()

const RestoreToTupleSchema = z
  .object({
    producer: RestoreProducerSchema,
    candidateManifestArtifact: RestoreCandidateManifestArtifactSchema,
    registry: RestoreRegistryBaseSchema.extend({
      sourceKey: RestoreRegistrySourceKeySchema,
      sourceEtag: OpaqueEtagSchema,
    }).strict(),
    website: RestoreWebsiteSchema,
    completion: RestoreReleaseCompletionSchema,
    artifactSource: RestoreArtifactSourceSchema,
  })
  .strict()

function addRestoreTupleIssues(
  tuple: z.infer<typeof RestoreFromTupleSchema> | z.infer<typeof RestoreToTupleSchema>,
  key: 'from' | 'to',
  ctx: z.RefinementCtx
): void {
  if (
    tuple.registry.sha256 !== tuple.website.registrySha256 ||
    tuple.registry.workflowRunId !== tuple.website.registryWorkflowRunId ||
    tuple.registry.artifactId !== tuple.website.registryArtifactId ||
    tuple.registry.artifactSha256 !== tuple.website.registryArtifactSha256 ||
    tuple.registry.workflowRunId !== tuple.website.runId
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [key, 'website'],
      message: `${key} website does not bind its sibling registry raw artifact tuple`,
    })
  }
  if (tuple.registry.artifactId === tuple.website.artifactId) {
    ctx.addIssue({
      code: 'custom',
      path: [key, 'website', 'artifactId'],
      message: `${key} registry and website artifact ids must differ`,
    })
  }
  if (
    tuple.candidateManifestArtifact.workflowRunId !==
      tuple.registry.workflowRunId ||
    tuple.candidateManifestArtifact.artifactId === tuple.registry.artifactId ||
    tuple.candidateManifestArtifact.artifactId === tuple.website.artifactId ||
    tuple.completion.artifactId === tuple.registry.artifactId ||
    tuple.completion.artifactId === tuple.website.artifactId ||
    tuple.completion.artifactId === tuple.candidateManifestArtifact.artifactId
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} candidate/raw/completion artifact identities are not distinct and run-bound`,
    })
  }
}

export const RestoreManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    from: RestoreFromTupleSchema,
    to: RestoreToTupleSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    addRestoreTupleIssues(manifest.from, 'from', ctx)
    addRestoreTupleIssues(manifest.to, 'to', ctx)
    if (manifest.from.registry.sha256 === manifest.to.registry.sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['to', 'registry', 'sha256'],
        message: 'restore from/to registry SHA values must be distinct',
      })
    }
    if (
      manifest.from.producer.repositoryId !==
      manifest.to.producer.repositoryId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['to', 'producer', 'repositoryId'],
        message: 'restore generations must belong to one registry repository',
      })
    }
    if (
      manifest.from.artifactSource.kind !== manifest.to.artifactSource.kind ||
      (manifest.from.artifactSource.kind === 'r2-operation' &&
        manifest.to.artifactSource.kind === 'r2-operation' &&
        (manifest.from.artifactSource.parentOperationKey !==
          manifest.to.artifactSource.parentOperationKey ||
          manifest.from.artifactSource.intentKey !==
            manifest.to.artifactSource.intentKey ||
          manifest.from.artifactSource.intentSha256 !==
            manifest.to.artifactSource.intentSha256 ||
          manifest.from.artifactSource.completionKey !==
            manifest.to.artifactSource.completionKey ||
          manifest.from.artifactSource.completionSha256 !==
            manifest.to.artifactSource.completionSha256 ||
          manifest.from.artifactSource.reverseManifestKey !==
            manifest.to.artifactSource.reverseManifestKey ||
          canonicalJson(manifest.from.artifactSource.completionIdentity) !==
            canonicalJson(manifest.to.artifactSource.completionIdentity)))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['to', 'artifactSource'],
        message: 'restore from/to artifacts must use one source generation',
      })
    }
  })

export type RestoreManifest = z.infer<typeof RestoreManifestSchema>

const RestoreOperationKeysSchema = z
  .object({
    intentKey: z.string(),
    authorizedManifestKey: z.string(),
    reverseRegistryPayloadKey: z.string(),
    reverseRegistryArtifactKey: z.string(),
    reverseWebsiteArtifactKey: z.string(),
    targetRegistryArtifactKey: z.string(),
    targetWebsiteArtifactKey: z.string(),
    completionKey: z.string(),
    reverseManifestKey: z.string(),
  })
  .strict()

export const RestorePlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    mode: z.enum(['cas', 'resume']),
    currentSha256: Sha256Schema,
    currentEtag: OpaqueEtagSchema,
    operationKey: Sha256Schema,
    manifestCanonicalSha256: Sha256Schema,
    intentSha256: Sha256Schema,
    provenance: z
      .object({
        from: z.lazy(() => NormalizedTupleProvenanceSchema),
        to: z.lazy(() => NormalizedTupleProvenanceSchema),
      })
      .strict(),
    intentKey: z.string(),
    authorizedManifestKey: z.string(),
    reverseRegistryPayloadKey: z.string(),
    reverseRegistryArtifactKey: z.string(),
    reverseWebsiteArtifactKey: z.string(),
    targetRegistryArtifactKey: z.string(),
    targetWebsiteArtifactKey: z.string(),
    completionKey: z.string(),
    reverseManifestKey: z.string(),
    reverseSeed: z
      .object({
        requiresObservedFromEtag: z.literal(true),
        requiresObservedSourceEtag: z.literal(true),
        registrySourceKey: z.string(),
        manifestKey: z.string(),
        fromRegistryArtifactKey: z.string(),
        fromWebsiteArtifactKey: z.string(),
        toRegistryArtifactKey: z.string(),
        toWebsiteArtifactKey: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const base = `restore-operations/v2/${plan.operationKey}/`
    const expected = {
      intentKey: `${base}intent.json`,
      authorizedManifestKey: `${base}authorized-manifest.json`,
      reverseRegistryPayloadKey: `${base}reverse/plugins.json`,
      reverseRegistryArtifactKey: `${base}reverse/registry.zip`,
      reverseWebsiteArtifactKey: `${base}reverse/website.zip`,
      targetRegistryArtifactKey: `${base}target/registry.zip`,
      targetWebsiteArtifactKey: `${base}target/website.zip`,
      completionKey: `${base}completion.json`,
      reverseManifestKey: `${base}reverse/restore-manifest.json`,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (plan[key as keyof typeof expected] !== value) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'restore operation key is not derived from operationKey',
        })
      }
    }
    if (
      plan.reverseSeed.registrySourceKey !==
        plan.reverseRegistryPayloadKey ||
      plan.reverseSeed.manifestKey !== plan.reverseManifestKey ||
      plan.reverseSeed.fromRegistryArtifactKey !==
        plan.targetRegistryArtifactKey ||
      plan.reverseSeed.fromWebsiteArtifactKey !==
        plan.targetWebsiteArtifactKey ||
      plan.reverseSeed.toRegistryArtifactKey !==
        plan.reverseRegistryArtifactKey ||
      plan.reverseSeed.toWebsiteArtifactKey !==
        plan.reverseWebsiteArtifactKey
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reverseSeed'],
        message: 'reverse seed does not bind the immutable operation objects',
      })
    }
  })

export type RestorePlan = z.infer<typeof RestorePlanSchema>

const NormalizedArtifactProvenanceSchema = z
  .object({
    artifactId: GitHubNumericIdSchema,
    artifactName: SafeArtifactFilenameSchema,
    artifactSha256: Sha256Schema,
    runId: GitHubNumericIdSchema,
    repositoryId: GitHubNumericIdSchema,
    headRepositoryId: GitHubNumericIdSchema,
    headBranch: z.literal('main'),
    headSha: SourceShaSchema,
  })
  .strict()

const NormalizedRunProvenanceSchema = z
  .object({
    runId: GitHubNumericIdSchema,
    repositoryId: GitHubNumericIdSchema,
    headRepositoryId: GitHubNumericIdSchema,
    repository: GitHubRepositorySchema,
    headRepository: GitHubRepositorySchema,
    workflowId: GitHubNumericIdSchema,
    workflowPath: PublishWorkflowPathSchema,
    runPath: z.string().min(1),
    headSha: SourceShaSchema,
    headBranch: z.literal('main'),
    event: ProducerEventSchema,
  })
  .strict()

const NormalizedTupleProvenanceSchema = z
  .object({
    raw: z
      .object({
        run: NormalizedRunProvenanceSchema,
        candidateManifestArtifact: NormalizedArtifactProvenanceSchema,
        registryArtifact: NormalizedArtifactProvenanceSchema,
        websiteArtifact: NormalizedArtifactProvenanceSchema,
      })
      .strict(),
    completion: z
      .object({
        run: NormalizedRunProvenanceSchema.extend({
          conclusion: z.literal('success'),
          runAttempt: GitHubRunAttemptSchema,
          apiEndpoint: z.string().url(),
        }).strict(),
        manifestArtifact: NormalizedArtifactProvenanceSchema,
        manifest: ReleaseManifestSchema,
      })
      .strict(),
  })
  .strict()

type NormalizedTupleProvenance = z.infer<
  typeof NormalizedTupleProvenanceSchema
>

export const RestoreIntentSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('restore-intent'),
    operationKey: Sha256Schema,
    manifest: RestoreManifestSchema,
    provenance: z
      .object({
        from: NormalizedTupleProvenanceSchema,
        to: NormalizedTupleProvenanceSchema,
      })
      .strict(),
    objects: z
      .object({
        reverseRegistryPayload: z
          .object({ key: z.string(), sha256: Sha256Schema })
          .strict(),
        reverseRegistryArtifact: z
          .object({ key: z.string(), sha256: Sha256Schema })
          .strict(),
        reverseWebsiteArtifact: z
          .object({ key: z.string(), sha256: Sha256Schema })
          .strict(),
        targetRegistryArtifact: z
          .object({ key: z.string(), sha256: Sha256Schema })
          .strict(),
        targetWebsiteArtifact: z
          .object({ key: z.string(), sha256: Sha256Schema })
          .strict(),
        authorizedManifest: z
          .object({ key: z.string(), canonicalSha256: Sha256Schema })
          .strict(),
      })
      .strict(),
  })
  .strict()

export type RestoreIntent = z.infer<typeof RestoreIntentSchema>

export const RestoreCompletionSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('restore-completion'),
    operationKey: Sha256Schema,
    mode: z.enum(['cas', 'resume']),
    workflow: RestoreWorkflowIdentitySchema,
    authorizedManifestCanonicalSha256: Sha256Schema,
    intentSha256: Sha256Schema,
    observed: z
      .object({
        targetSha256: Sha256Schema,
        targetEtag: OpaqueEtagSchema,
        reverseRegistrySha256: Sha256Schema,
        reverseRegistrySourceKey: RestoreRegistrySourceKeySchema,
        reverseRegistrySourceEtag: OpaqueEtagSchema,
      })
      .strict(),
    objects: RestoreOperationKeysSchema,
  })
  .strict()

export type RestoreCompletion = z.infer<typeof RestoreCompletionSchema>

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
        )
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function prettyJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`)
}

async function readRegularFile(
  filePath: string,
  label: string,
  maxBytes?: number
): Promise<Buffer> {
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file`)
  }
  if (maxBytes !== undefined && fileStat.size > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`)
  }
  return readFile(filePath)
}

async function writeBytesAtomicExclusive(
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  const directory = path.dirname(filePath)
  const basename = path.basename(filePath)
  const temporaryPath = path.join(
    directory,
    `.${basename}.${process.pid}.${createHash('sha256')
      .update(bytes)
      .digest('hex')
      .slice(0, 16)}.tmp`
  )
  await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporaryPath, filePath)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function writeJsonAtomicExclusive(
  filePath: string,
  value: unknown,
  canonical = false
): Promise<void> {
  await writeBytesAtomicExclusive(
    filePath,
    canonical ? canonicalJsonBytes(value) : prettyJsonBytes(value)
  )
}

function assertArtifactBasename(filePath: string, expected: string): void {
  const filename = SafeArtifactFilenameSchema.parse(expected)
  if (path.basename(filePath) !== filename) {
    throw new Error('raw artifact basename differs from the recorded artifact name')
  }
}

function computeReleaseOperationId(options: {
  repository: string
  registrySourceSha: string
  websiteSourceSha: string
  candidateSha256: string
  websiteDistSha256: string
}): string {
  return sha256(
    Buffer.from(
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
  )
}

type StrictZipContents = {
  files: Map<string, Buffer>
  directories: Set<string>
}

function assertSafeZipEntryName(name: string): {
  canonicalName: string
  isDirectory: boolean
} {
  if (
    !name ||
    Buffer.byteLength(name, 'utf8') > MAX_ZIP_ENTRY_PATH_BYTES ||
    name !== name.normalize('NFC') ||
    name.includes('\\') ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  ) {
    throw new Error('website/registry artifact contains an unsafe ZIP path')
  }

  const isDirectory = name.endsWith('/')
  const canonicalName = isDirectory ? name.slice(0, -1) : name
  const segments = canonicalName.split('/')
  if (
    !canonicalName ||
    name.startsWith('/') ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..'
    )
  ) {
    throw new Error('website/registry artifact contains ZIP path traversal')
  }

  return { canonicalName, isDirectory }
}

function assertNoZipPathConflicts(contents: StrictZipContents): void {
  for (const fileName of contents.files.keys()) {
    const segments = fileName.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (contents.files.has(segments.slice(0, index).join('/'))) {
        throw new Error('artifact ZIP contains a file/directory path conflict')
      }
    }
    if (contents.directories.has(fileName)) {
      throw new Error('artifact ZIP contains a file/directory path conflict')
    }
  }
}

function readStrictZipContents(bytes: Uint8Array): StrictZipContents {
  const centralNames = new Set<string>()
  let centralEntries = 0
  let centralDeclaredBytes = 0
  const centralFiles = unzipSync(bytes, {
    filter: (file) => {
      centralEntries += 1
      if (centralEntries > MAX_ARTIFACT_ENTRIES) {
        throw new Error('artifact ZIP central directory has too many entries')
      }
      assertSafeZipEntryName(file.name)
      if (centralNames.has(file.name)) {
        throw new Error(
          'artifact ZIP central directory contains a duplicate entry: ' +
            file.name
        )
      }
      centralNames.add(file.name)
      centralDeclaredBytes += file.originalSize
      if (centralDeclaredBytes > MAX_ARTIFACT_UNCOMPRESSED_BYTES) {
        throw new Error(
          'artifact ZIP central directory exceeds the size safety limit'
        )
      }
      return true
    },
  })

  const files = new Map<string, Buffer>()
  const directories = new Set<string>()
  const seenNames = new Set<string>()
  let declaredBytes = 0
  let extractedBytes = 0
  let pendingEntries = 0
  let entryCount = 0
  let extractionError: Error | undefined

  const fail = (error: unknown): void => {
    if (!extractionError) {
      extractionError =
        error instanceof Error ? error : new Error(String(error))
    }
  }

  const unzipper = new Unzip((file) => {
    if (extractionError) {
      file.terminate()
      return
    }

    try {
      entryCount += 1
      if (entryCount > MAX_ARTIFACT_ENTRIES) {
        throw new Error('artifact ZIP contains too many entries')
      }
      const { canonicalName, isDirectory } = assertSafeZipEntryName(file.name)
      if (seenNames.has(file.name)) {
        throw new Error('artifact ZIP contains a duplicate entry: ' + file.name)
      }
      seenNames.add(file.name)

      if (file.originalSize !== undefined) {
        declaredBytes += file.originalSize
        if (declaredBytes > MAX_ARTIFACT_UNCOMPRESSED_BYTES) {
          throw new Error('artifact ZIP declared size exceeds the safety limit')
        }
      }

      pendingEntries += 1
      const chunks: Buffer[] = []
      let entryBytes = 0
      file.ondata = (error, data, final) => {
        if (extractionError) return
        if (error) {
          fail(error)
          return
        }
        entryBytes += data.byteLength
        extractedBytes += data.byteLength
        if (extractedBytes > MAX_ARTIFACT_UNCOMPRESSED_BYTES) {
          fail(new Error('artifact ZIP expanded size exceeds the safety limit'))
          file.terminate()
          return
        }
        chunks.push(Buffer.from(data))
        if (!final) return

        pendingEntries -= 1
        const entry = Buffer.concat(chunks, entryBytes)
        if (isDirectory) {
          if (entry.byteLength !== 0) {
            fail(new Error('artifact ZIP directory entry contains data'))
            return
          }
          directories.add(canonicalName)
          return
        }
        files.set(canonicalName, entry)
      }
      file.start()
    } catch (error) {
      fail(error)
      file.terminate()
    }
  })
  unzipper.register(UnzipInflate)

  try {
    unzipper.push(bytes, true)
  } catch (error) {
    fail(error)
  }
  if (extractionError) throw extractionError
  if (entryCount === 0 || pendingEntries !== 0) {
    throw new Error('artifact ZIP is empty, truncated, or incomplete')
  }

  const contents = { files, directories }
  assertNoZipPathConflicts(contents)

  const localEntries = new Map<string, Buffer>(files)
  for (const directory of directories) {
    localEntries.set(directory + '/', Buffer.alloc(0))
  }
  const centralEntryList = Object.entries(centralFiles)
  if (centralEntryList.length !== localEntries.size) {
    throw new Error(
      'artifact ZIP central directory and local entries have different layouts'
    )
  }
  for (const [entryName, centralBytes] of centralEntryList) {
    const localBytes = localEntries.get(entryName)
    if (!localBytes || !localBytes.equals(centralBytes)) {
      throw new Error(
        'artifact ZIP central directory and local entry name/size/content differ'
      )
    }
  }
  return contents
}

async function readVerifiedArtifactArchive(options: {
  artifactPath: string
  artifactId: string
  expectedArtifactId: string
  expectedArtifactSha256: string
}): Promise<{
  artifactId: string
  artifactSha256: string
  contents: StrictZipContents
}> {
  const artifactId = GitHubNumericIdSchema.parse(options.artifactId)
  const expectedArtifactId = GitHubNumericIdSchema.parse(
    options.expectedArtifactId
  )
  const expectedArtifactSha256 = Sha256Schema.parse(
    options.expectedArtifactSha256
  )
  if (artifactId !== expectedArtifactId) {
    throw new Error('downloaded artifact id differs from the expected artifact id')
  }

  const artifactStat = await lstat(options.artifactPath)
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error('artifact path must be a real regular file')
  }
  if (artifactStat.size > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new Error('artifact ZIP exceeds the compressed-size safety limit')
  }
  const bytes = await readFile(options.artifactPath)
  const artifactSha256 = sha256(bytes)
  if (artifactSha256 !== expectedArtifactSha256) {
    throw new Error('artifact ZIP SHA differs from the expected SHA')
  }
  return {
    artifactId,
    artifactSha256,
    contents: readStrictZipContents(bytes),
  }
}

function hashFileEntries(
  entries: Iterable<readonly [string, Uint8Array]>
): string {
  const sortedEntries = [...entries].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  )
  const hash = createHash('sha256')
  hash.update('motrix-directory-sha256-v1\0')
  for (const [posixPath, bytes] of sortedEntries) {
    const pathBytes = Buffer.from(posixPath, 'utf8')
    const lengths = Buffer.allocUnsafe(16)
    lengths.writeBigUInt64BE(BigInt(pathBytes.byteLength), 0)
    lengths.writeBigUInt64BE(BigInt(bytes.byteLength), 8)
    hash.update(lengths)
    hash.update(pathBytes)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

async function collectDirectoryFiles(
  root: string,
  current = ''
): Promise<string[]> {
  const absolute = path.join(root, current)
  const entries = await readdir(absolute, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'))
  )) {
    const relative = current ? path.join(current, entry.name) : entry.name
    if (entry.isSymbolicLink()) {
      throw new Error('website dist must not contain symbolic links: ' + relative)
    }
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, relative)))
      continue
    }
    if (!entry.isFile()) {
      throw new Error('website dist contains a non-file entry: ' + relative)
    }
    files.push(relative)
  }
  return files
}

/**
 * Hashes a directory as a path-and-byte manifest. Sorted POSIX paths and
 * length prefixes make the digest independent of filesystem enumeration and
 * unambiguous across file boundaries.
 */
export async function hashDirectory(directory: string): Promise<string> {
  const rootStat = await lstat(directory)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('website dist path must be a real directory')
  }

  const asPosixPath = (filePath: string) =>
    filePath.split(path.sep).join('/')
  const files = (await collectDirectoryFiles(directory)).sort((a, b) =>
    Buffer.compare(
      Buffer.from(asPosixPath(a), 'utf8'),
      Buffer.from(asPosixPath(b), 'utf8')
    )
  )
  const entries = await Promise.all(
    files.map(async (relativePath) =>
      [
        asPosixPath(relativePath),
        await readFile(path.join(directory, relativePath)),
      ] as const
    )
  )
  return hashFileEntries(entries)
}

async function readRegistryBytes(registryPath: string): Promise<Buffer> {
  return readRegularFile(
    registryPath,
    'registry artifact path',
    MAX_REGISTRY_BYTES
  )
}

async function readRegistryV2(registryPath: string): Promise<Buffer> {
  const bytes = await readRegistryBytes(registryPath)
  validateRegistryBytes(bytes)
  return bytes
}

function validateRegistryBytes(bytes: Uint8Array): void {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  RegistryFileSchema.parse(JSON.parse(source))
}

const VERIFIED_REGISTRY_ARTIFACT = Symbol('verified registry artifact')
const VERIFIED_WEBSITE_ARTIFACT = Symbol('verified website artifact')
const VERIFIED_PROMOTION_BUNDLE = Symbol('verified promotion bundle')

export type VerifiedRegistryArtifactBundle = Readonly<{
  [VERIFIED_REGISTRY_ARTIFACT]: true
  artifactId: string
  artifactSha256: string
  registrySha256: string
  registryBytes: number
}>

export type VerifiedWebsiteArtifactBundle = Readonly<{
  [VERIFIED_WEBSITE_ARTIFACT]: true
  artifactId: string
  artifactSha256: string
  manifest: WebsiteArtifactManifest
}>

const verifiedRegistryPayloads = new WeakMap<object, Buffer>()
const candidateBoundRegistryBundles = new WeakSet<object>()
const verifiedWebsitePayloads = new WeakMap<
  object,
  {
    manifestBytes: Buffer
    distFiles: Map<string, Buffer>
  }
>()
const deployableWebsiteBundles = new WeakSet<object>()

export async function verifyRegistryArtifactBundle(options: {
  artifactPath: string
  artifactId: string
  expectedArtifactId: string
  expectedArtifactSha256: string
  candidate?: RegistryCandidateManifest
}): Promise<VerifiedRegistryArtifactBundle> {
  const archive = await readVerifiedArtifactArchive({
    artifactPath: options.artifactPath,
    artifactId: options.artifactId,
    expectedArtifactId: options.expectedArtifactId,
    expectedArtifactSha256: options.expectedArtifactSha256,
  })
  if (
    archive.contents.directories.size !== 0 ||
    archive.contents.files.size !== 1 ||
    !archive.contents.files.has(REGISTRY_ARTIFACT_ENTRY)
  ) {
    throw new Error(
      'registry artifact ZIP must contain exactly one root plugins.json regular file'
    )
  }
  const registryBytes = archive.contents.files.get(REGISTRY_ARTIFACT_ENTRY)
  if (!registryBytes) {
    throw new Error('registry artifact ZIP is missing plugins.json')
  }
  if (
    registryBytes.byteLength === 0 ||
    registryBytes.byteLength > MAX_REGISTRY_BYTES
  ) {
    throw new Error('registry artifact plugins.json violates the byte limit')
  }
  validateRegistryBytes(registryBytes)
  const registrySha256 = sha256(registryBytes)

  if (options.candidate) {
    const candidate = RegistryCandidateManifestSchema.parse(options.candidate)
    if (
      candidate.registry.artifactId !== archive.artifactId ||
      candidate.registry.artifactSha256 !== archive.artifactSha256 ||
      candidate.registry.sha256 !== registrySha256 ||
      candidate.registry.bytes !== registryBytes.byteLength
    ) {
      throw new Error(
        'registry artifact ZIP identity or embedded plugins.json differs from candidate manifest'
      )
    }
  }

  const bundle: VerifiedRegistryArtifactBundle = Object.freeze({
    [VERIFIED_REGISTRY_ARTIFACT]: true as const,
    artifactId: archive.artifactId,
    artifactSha256: archive.artifactSha256,
    registrySha256,
    registryBytes: registryBytes.byteLength,
  })
  verifiedRegistryPayloads.set(bundle, registryBytes)
  if (options.candidate) candidateBoundRegistryBundles.add(bundle)
  return bundle
}

export async function createRegistryCandidateManifest(options: {
  registryArtifactPath: string
  artifactId: string
  expectedArtifactId: string
  expectedArtifactSha256: string
  sourceSha: string
  runId: string
}): Promise<RegistryCandidateManifest> {
  const artifact = await verifyRegistryArtifactBundle({
    artifactPath: options.registryArtifactPath,
    artifactId: options.artifactId,
    expectedArtifactId: options.expectedArtifactId,
    expectedArtifactSha256: options.expectedArtifactSha256,
  })
  return RegistryCandidateManifestSchema.parse({
    schemaVersion: 1,
    registry: {
      sha256: artifact.registrySha256,
      bytes: artifact.registryBytes,
      sourceSha: options.sourceSha,
      runId: options.runId,
      artifactId: artifact.artifactId,
      artifactSha256: artifact.artifactSha256,
    },
  })
}

export async function createWebsiteArtifactManifest(options: {
  candidate: RegistryCandidateManifest
  distDir: string
  sourceSha: string
  buildRunId: string
}): Promise<WebsiteArtifactManifest> {
  const candidate = RegistryCandidateManifestSchema.parse(options.candidate)
  return WebsiteArtifactManifestSchema.parse({
    schemaVersion: 1,
    registrySha256: candidate.registry.sha256,
    registryWorkflowRunId: candidate.registry.runId,
    registryArtifactId: candidate.registry.artifactId,
    registryArtifactSha256: candidate.registry.artifactSha256,
    websiteSourceSha: options.sourceSha,
    websiteBuildRunId: options.buildRunId,
    distSha256: await hashDirectory(options.distDir),
  })
}

function sameRegistryIdentity(
  left: RegistryCandidateManifest['registry'],
  right: WebsiteArtifactManifest
): boolean {
  return (
    left.sha256 === right.registrySha256 &&
    left.runId === right.registryWorkflowRunId &&
    left.artifactId === right.registryArtifactId &&
    left.artifactSha256 === right.registryArtifactSha256
  )
}

function assertWebsiteProvenance(
  website: WebsiteArtifactManifest,
  actualSourceSha: string,
  actualBuildRunId: string
): void {
  const websiteBuildRunId = GitHubNumericIdSchema.parse(actualBuildRunId)
  const websiteSourceSha = SourceShaSchema.parse(actualSourceSha)
  if (
    website.websiteBuildRunId !== websiteBuildRunId ||
    website.websiteSourceSha !== websiteSourceSha
  ) {
    throw new Error(
      'website manifest source SHA/build run does not match actual website provenance'
    )
  }
}

export async function verifyWebsiteArtifactBundle(options: {
  artifactPath: string
  artifactId: string
  expectedArtifactId: string
  expectedArtifactSha256: string
  websiteSourceSha: string
  websiteBuildRunId: string
  candidate?: RegistryCandidateManifest
}): Promise<VerifiedWebsiteArtifactBundle> {
  const archive = await readVerifiedArtifactArchive({
    artifactPath: options.artifactPath,
    artifactId: options.artifactId,
    expectedArtifactId: options.expectedArtifactId,
    expectedArtifactSha256: options.expectedArtifactSha256,
  })

  for (const directory of archive.contents.directories) {
    if (
      directory !== 'dist' &&
      !directory.startsWith(WEBSITE_ARTIFACT_DIST_PREFIX)
    ) {
      throw new Error('website artifact ZIP contains an extra directory layout')
    }
  }
  const manifestBytes = archive.contents.files.get(
    WEBSITE_ARTIFACT_MANIFEST_ENTRY
  )
  if (!manifestBytes || manifestBytes.byteLength > MAX_WEBSITE_MANIFEST_BYTES) {
    throw new Error(
      'website artifact ZIP must contain one bounded root website manifest'
    )
  }

  const distFiles = new Map<string, Buffer>()
  for (const [entryName, bytes] of archive.contents.files) {
    if (entryName === WEBSITE_ARTIFACT_MANIFEST_ENTRY) continue
    if (!entryName.startsWith(WEBSITE_ARTIFACT_DIST_PREFIX)) {
      throw new Error('website artifact ZIP contains an extra file layout')
    }
    const relativePath = entryName.slice(WEBSITE_ARTIFACT_DIST_PREFIX.length)
    if (!relativePath) {
      throw new Error('website artifact ZIP contains an invalid dist entry')
    }
    distFiles.set(relativePath, bytes)
  }
  if (distFiles.size === 0) {
    throw new Error('website artifact ZIP contains no dist regular files')
  }

  const manifestSource = new TextDecoder('utf-8', { fatal: true }).decode(
    manifestBytes
  )
  const website = Object.freeze(
    WebsiteArtifactManifestSchema.parse(JSON.parse(manifestSource))
  )
  if (hashFileEntries(distFiles) !== website.distSha256) {
    throw new Error(
      'website artifact ZIP dist bytes differ from its embedded manifest'
    )
  }
  assertWebsiteProvenance(
    website,
    options.websiteSourceSha,
    options.websiteBuildRunId
  )
  if (options.candidate) {
    const candidate = RegistryCandidateManifestSchema.parse(options.candidate)
    if (!sameRegistryIdentity(candidate.registry, website)) {
      throw new Error(
        'website artifact embedded manifest does not bind the exact registry artifact ZIP'
      )
    }
  }

  const bundle: VerifiedWebsiteArtifactBundle = Object.freeze({
    [VERIFIED_WEBSITE_ARTIFACT]: true as const,
    artifactId: archive.artifactId,
    artifactSha256: archive.artifactSha256,
    manifest: website,
  })
  verifiedWebsitePayloads.set(bundle, { manifestBytes, distFiles })
  return bundle
}

export type VerifiedPromotionBundle = Readonly<{
  [VERIFIED_PROMOTION_BUNDLE]: true
  registry: VerifiedRegistryArtifactBundle
  website: VerifiedWebsiteArtifactBundle
}>

const verifiedPromotionBundles = new WeakSet<object>()

export async function verifyPromotionBundle(options: {
  candidate: RegistryCandidateManifest
  registryArtifactPath: string
  registryArtifactId: string
  websiteArtifactPath: string
  websiteArtifactId: string
  expectedWebsiteArtifactId: string
  expectedWebsiteArtifactSha256: string
  websiteSourceSha: string
  websiteBuildRunId: string
}): Promise<VerifiedPromotionBundle> {
  const candidate = RegistryCandidateManifestSchema.parse(options.candidate)
  const registry = await verifyRegistryArtifactBundle({
    artifactPath: options.registryArtifactPath,
    artifactId: options.registryArtifactId,
    expectedArtifactId: candidate.registry.artifactId,
    expectedArtifactSha256: candidate.registry.artifactSha256,
    candidate,
  })
  const website = await verifyWebsiteArtifactBundle({
    artifactPath: options.websiteArtifactPath,
    artifactId: options.websiteArtifactId,
    expectedArtifactId: options.expectedWebsiteArtifactId,
    expectedArtifactSha256: options.expectedWebsiteArtifactSha256,
    websiteSourceSha: options.websiteSourceSha,
    websiteBuildRunId: options.websiteBuildRunId,
    candidate,
  })
  deployableWebsiteBundles.add(website)
  const bundle: VerifiedPromotionBundle = Object.freeze({
    [VERIFIED_PROMOTION_BUNDLE]: true as const,
    registry,
    website,
  })
  verifiedPromotionBundles.add(bundle)
  return bundle
}

function validateReleaseIntentContext(
  input: unknown,
  repository: string,
  producerRunId: string,
  operationId: string
): ReleaseIntent {
  const intent = ReleaseIntentSchema.parse(input)
  const expectedRepository = GitHubRepositorySchema.parse(repository)
  const expectedRunId = GitHubNumericIdSchema.parse(producerRunId)
  const expectedOperationId = Sha256Schema.parse(operationId)
  if (
    intent.producer.repository !== expectedRepository ||
    intent.producer.runId !== expectedRunId ||
    intent.operationId !== expectedOperationId
  ) {
    throw new Error('release intent does not match the requested producer context')
  }
  const computedOperationId = computeReleaseOperationId({
    repository: intent.producer.repository,
    registrySourceSha: intent.producer.registrySourceSha,
    websiteSourceSha: intent.producer.websiteSourceSha,
    candidateSha256: intent.registry.candidate.sha256,
    websiteDistSha256: intent.website.distSha256,
  })
  if (intent.operationId !== computedOperationId) {
    throw new Error('release intent operation id is not the stable tuple hash')
  }
  const expectedBackupKey =
    `private/backups/plugins/${intent.operationId}-` +
    `${intent.registry.previousSha256}.json`
  if (intent.registry.backupKey !== expectedBackupKey) {
    throw new Error('release intent backup key is not stable for the operation')
  }
  const artifactIds = Object.values(intent.artifacts).map(({ id }) => id)
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error('release intent raw artifact ids must be distinct')
  }
  return intent
}

export function validateReleaseIntentV2(
  input: unknown,
  repository: string,
  producerRunId: string,
  operationId: string
): ReleaseIntent {
  return validateReleaseIntentContext(
    input,
    repository,
    producerRunId,
    operationId
  )
}

export async function createReleaseIntentV2(options: {
  currentRegistryPath: string
  previousEtag: string
  backupRegistryPath: string
  backupKey: string
  backupEtag: string
  candidateManifestPath: string
  candidateFilename: string
  candidateArtifactId: string
  candidateArtifactSha256: string
  registryArtifactPath: string
  registryFilename: string
  registryArtifactId: string
  registryArtifactSha256: string
  websiteArtifactPath: string
  websiteFilename: string
  websiteArtifactId: string
  websiteArtifactSha256: string
  websiteSourceSha: string
  websiteBuildRunId: string
  repository: string
  producerRunId: string
  operationId: string
}): Promise<ReleaseIntent> {
  const previousEtag = OpaqueEtagSchema.parse(options.previousEtag)
  const backupEtag = OpaqueEtagSchema.parse(options.backupEtag)
  assertArtifactBasename(
    options.candidateManifestPath,
    options.candidateFilename
  )
  assertArtifactBasename(options.registryArtifactPath, options.registryFilename)
  assertArtifactBasename(options.websiteArtifactPath, options.websiteFilename)

  const previousBytes = await readRegistryBytes(options.currentRegistryPath)
  const backupBytes = await readRegistryBytes(options.backupRegistryPath)
  if (!previousBytes.equals(backupBytes)) {
    throw new Error('immutable release backup differs from the previous live bytes')
  }

  const candidateArtifactSha256 = Sha256Schema.parse(
    options.candidateArtifactSha256
  )
  const candidateManifestBytes = await readRegularFile(
    options.candidateManifestPath,
    'candidate manifest'
  )
  if (sha256(candidateManifestBytes) !== candidateArtifactSha256) {
    throw new Error('candidate manifest raw artifact SHA mismatch')
  }
  const candidate = RegistryCandidateManifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateManifestBytes))
  )
  const promotion = await verifyPromotionBundle({
    candidate,
    registryArtifactPath: options.registryArtifactPath,
    registryArtifactId: options.registryArtifactId,
    websiteArtifactPath: options.websiteArtifactPath,
    websiteArtifactId: options.websiteArtifactId,
    expectedWebsiteArtifactId: options.websiteArtifactId,
    expectedWebsiteArtifactSha256: options.websiteArtifactSha256,
    websiteSourceSha: options.websiteSourceSha,
    websiteBuildRunId: options.websiteBuildRunId,
  })
  if (
    promotion.registry.artifactSha256 !==
      Sha256Schema.parse(options.registryArtifactSha256) ||
    candidate.registry.artifactId !==
      GitHubNumericIdSchema.parse(options.registryArtifactId)
  ) {
    throw new Error('registry raw artifact metadata differs from the candidate')
  }
  if (sha256(previousBytes) === candidate.registry.sha256) {
    throw new Error('release intent previous and candidate registry must differ')
  }

  const repository = GitHubRepositorySchema.parse(options.repository)
  const producerRunId = GitHubNumericIdSchema.parse(options.producerRunId)
  const websiteBuildRunId = GitHubNumericIdSchema.parse(
    options.websiteBuildRunId
  )
  if (
    candidate.registry.runId !== producerRunId ||
    websiteBuildRunId !== producerRunId
  ) {
    throw new Error('candidate and website must come from the intent producer run')
  }
  const operationId = Sha256Schema.parse(options.operationId)
  const intent = ReleaseIntentSchema.parse({
    schemaVersion: 2,
    kind: 'release-intent',
    operationId,
    producer: {
      repository,
      runId: producerRunId,
      registrySourceSha: candidate.registry.sourceSha,
      websiteSourceSha: options.websiteSourceSha,
      websiteBuildRunId,
    },
    registry: {
      previousSha256: sha256(previousBytes),
      previousEtag,
      backupKey: options.backupKey,
      backupEtag,
      candidate: candidate.registry,
    },
    website: promotion.website.manifest,
    artifacts: {
      candidate_manifest: {
        filename: options.candidateFilename,
        id: options.candidateArtifactId,
        sha256: candidateArtifactSha256,
      },
      registry: {
        filename: options.registryFilename,
        id: options.registryArtifactId,
        sha256: options.registryArtifactSha256,
      },
      website: {
        filename: options.websiteFilename,
        id: options.websiteArtifactId,
        sha256: options.websiteArtifactSha256,
      },
    },
  })
  return validateReleaseIntentContext(
    intent,
    repository,
    producerRunId,
    operationId
  )
}

export function inspectReleaseIntentV2(
  input: unknown,
  repository: string,
  producerRunId: string,
  operationId: string
): Pick<ReleaseIntent, 'producer' | 'artifacts'> {
  const intent = validateReleaseIntentContext(
    input,
    repository,
    producerRunId,
    operationId
  )
  return {
    producer: intent.producer,
    artifacts: intent.artifacts,
  }
}

async function verifyReleaseIntentArtifacts(options: {
  intent: ReleaseIntent
  candidateManifestPath: string
  registryArtifactPath: string
  websiteArtifactPath: string
}): Promise<{
  candidate: RegistryCandidateManifest
  promotion: VerifiedPromotionBundle
}> {
  const intent = validateReleaseIntentContext(
    options.intent,
    options.intent.producer.repository,
    options.intent.producer.runId,
    options.intent.operationId
  )
  assertArtifactBasename(
    options.candidateManifestPath,
    intent.artifacts.candidate_manifest.filename
  )
  assertArtifactBasename(
    options.registryArtifactPath,
    intent.artifacts.registry.filename
  )
  assertArtifactBasename(
    options.websiteArtifactPath,
    intent.artifacts.website.filename
  )
  const candidateBytes = await readRegularFile(
    options.candidateManifestPath,
    'candidate manifest'
  )
  if (sha256(candidateBytes) !== intent.artifacts.candidate_manifest.sha256) {
    throw new Error('candidate manifest differs from the release intent')
  }
  const candidate = RegistryCandidateManifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes))
  )
  if (canonicalJson(candidate.registry) !== canonicalJson(intent.registry.candidate)) {
    throw new Error('candidate manifest tuple differs from the release intent')
  }
  const promotion = await verifyPromotionBundle({
    candidate,
    registryArtifactPath: options.registryArtifactPath,
    registryArtifactId: intent.artifacts.registry.id,
    websiteArtifactPath: options.websiteArtifactPath,
    websiteArtifactId: intent.artifacts.website.id,
    expectedWebsiteArtifactId: intent.artifacts.website.id,
    expectedWebsiteArtifactSha256: intent.artifacts.website.sha256,
    websiteSourceSha: intent.producer.websiteSourceSha,
    websiteBuildRunId: intent.producer.websiteBuildRunId,
  })
  if (
    promotion.registry.artifactSha256 !== intent.artifacts.registry.sha256 ||
    canonicalJson(promotion.website.manifest) !== canonicalJson(intent.website)
  ) {
    throw new Error('raw promotion artifacts differ from the release intent')
  }
  return { candidate, promotion }
}

async function readReleaseIntentArtifact(options: {
  intentPath: string
  intentArtifactSha256: string
}): Promise<ReleaseIntent> {
  const expectedSha256 = Sha256Schema.parse(options.intentArtifactSha256)
  const bytes = await readRegularFile(options.intentPath, 'release intent')
  if (sha256(bytes) !== expectedSha256) {
    throw new Error('release intent raw artifact SHA mismatch')
  }
  const intent = ReleaseIntentSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
  assertArtifactBasename(
    options.intentPath,
    `registry-release-intent-${intent.operationId}.json`
  )
  return validateReleaseIntentContext(
    intent,
    intent.producer.repository,
    intent.producer.runId,
    intent.operationId
  )
}

export async function verifyPublishIntentV2(options: {
  intentPath: string
  intentArtifactId: string
  intentArtifactSha256: string
  currentRegistryPath: string
  currentEtag: string
  backupRegistryPath: string
  backupEtag: string
  candidateManifestPath: string
  registryArtifactPath: string
  websiteArtifactPath: string
  extractionRoot: string
}): Promise<PublishIntentPlan> {
  const intentArtifactId = GitHubNumericIdSchema.parse(options.intentArtifactId)
  const intent = await readReleaseIntentArtifact(options)
  const currentEtag = OpaqueEtagSchema.parse(options.currentEtag)
  const backupEtag = OpaqueEtagSchema.parse(options.backupEtag)
  if (backupEtag !== intent.registry.backupEtag) {
    throw new Error('immutable backup ETag differs from the release intent')
  }
  const backupBytes = await readRegistryBytes(options.backupRegistryPath)
  if (sha256(backupBytes) !== intent.registry.previousSha256) {
    throw new Error('immutable backup bytes differ from the release intent')
  }
  const { promotion } = await verifyReleaseIntentArtifacts({
    intent,
    candidateManifestPath: options.candidateManifestPath,
    registryArtifactPath: options.registryArtifactPath,
    websiteArtifactPath: options.websiteArtifactPath,
  })
  const candidateBytes = verifiedRegistryPayloads.get(promotion.registry)
  if (!candidateBytes) {
    throw new Error('verified registry payload is unavailable')
  }
  const currentBytes = await readRegistryBytes(options.currentRegistryPath)
  const currentSha256 = sha256(currentBytes)
  let mode: 'cas' | 'resume'
  if (
    currentSha256 === intent.registry.previousSha256 &&
    currentEtag === intent.registry.previousEtag &&
    currentBytes.equals(backupBytes)
  ) {
    mode = 'cas'
  } else if (
    currentSha256 === intent.registry.candidate.sha256 &&
    currentBytes.equals(candidateBytes)
  ) {
    validateRegistryBytes(currentBytes)
    mode = 'resume'
  } else {
    throw new Error(
      'live registry is neither the exact opaque intent pre-state nor the exact registry-v2 candidate'
    )
  }
  await extractVerifiedPromotionBundle(promotion, options.extractionRoot)
  return PublishIntentPlanSchema.parse({
    schemaVersion: 2,
    mode,
    operationId: intent.operationId,
    intentArtifactId,
    intentArtifactSha256: options.intentArtifactSha256,
    candidateSha256: intent.registry.candidate.sha256,
    previousSha256: intent.registry.previousSha256,
    previousEtag: intent.registry.previousEtag,
    backupKey: intent.registry.backupKey,
    backupEtag: intent.registry.backupEtag,
    currentSha256,
    currentEtag,
  })
}

export async function completeReleaseV2(options: {
  intentPath: string
  intentArtifactId: string
  intentArtifactSha256: string
  liveSha256: string
  liveEtag: string
  transitionMode: string
  completionRunId: string
  completionRunAttempt: string
  completionSourceSha: string
  completionEvent: string
  candidateManifestPath: string
  registryArtifactPath: string
  websiteArtifactPath: string
}): Promise<ReleaseManifest> {
  const intent = await readReleaseIntentArtifact(options)
  const intentArtifactId = GitHubNumericIdSchema.parse(options.intentArtifactId)
  const liveSha256 = Sha256Schema.parse(options.liveSha256)
  const liveEtag = OpaqueEtagSchema.parse(options.liveEtag)
  const transitionMode = z.enum(['cas', 'resume']).parse(options.transitionMode)
  const completionRunId = GitHubNumericIdSchema.parse(options.completionRunId)
  const completionRunAttempt = GitHubRunAttemptSchema.parse(
    options.completionRunAttempt
  )
  const completionSourceSha = SourceShaSchema.parse(options.completionSourceSha)
  const completionEvent = ProducerEventSchema.parse(options.completionEvent)
  const { candidate, promotion } = await verifyReleaseIntentArtifacts({
    intent,
    candidateManifestPath: options.candidateManifestPath,
    registryArtifactPath: options.registryArtifactPath,
    websiteArtifactPath: options.websiteArtifactPath,
  })
  if (liveSha256 !== candidate.registry.sha256) {
    throw new Error('completed release live SHA differs from its candidate')
  }
  const website = promotion.website.manifest
  return validateReleaseManifestV2({
    schemaVersion: 2,
    kind: 'release',
    operationId: intent.operationId,
    intent: {
      artifactId: intentArtifactId,
      artifactName: `registry-release-intent-${intent.operationId}.json`,
      artifactSha256: options.intentArtifactSha256,
      producerRunId: intent.producer.runId,
    },
    producer: intent.producer,
    completion: {
      workflowRunId: completionRunId,
      workflowRunAttempt: completionRunAttempt,
      sourceSha: completionSourceSha,
      event: completionEvent,
      transitionMode,
    },
    registry: {
      previousSha256: intent.registry.previousSha256,
      previousEtag: intent.registry.previousEtag,
      backupKey: intent.registry.backupKey,
      backupEtag: intent.registry.backupEtag,
      sha256: candidate.registry.sha256,
      bytes: candidate.registry.bytes,
      etag: liveEtag,
      sourceSha: candidate.registry.sourceSha,
      workflowRunId: candidate.registry.runId,
      artifactId: candidate.registry.artifactId,
      artifactName: intent.artifacts.registry.filename,
      artifactSha256: candidate.registry.artifactSha256,
    },
    website: {
      artifactId: promotion.website.artifactId,
      artifactName: intent.artifacts.website.filename,
      artifactSha256: promotion.website.artifactSha256,
      runId: website.websiteBuildRunId,
      sourceSha: website.websiteSourceSha,
      distSha256: website.distSha256,
      registrySha256: website.registrySha256,
      registryArtifactSha256: website.registryArtifactSha256,
      registryWorkflowRunId: website.registryWorkflowRunId,
      registryArtifactId: website.registryArtifactId,
    },
    candidateManifestArtifact: intent.artifacts.candidate_manifest,
  })
}

export function validateReleaseManifestV2(input: unknown): ReleaseManifest {
  const manifest = ReleaseManifestSchema.parse(input)
  const expectedOperationId = computeReleaseOperationId({
    repository: manifest.producer.repository,
    registrySourceSha: manifest.producer.registrySourceSha,
    websiteSourceSha: manifest.producer.websiteSourceSha,
    candidateSha256: manifest.registry.sha256,
    websiteDistSha256: manifest.website.distSha256,
  })
  if (manifest.operationId !== expectedOperationId) {
    throw new Error('release manifest operation id is not the stable tuple hash')
  }
  if (
    manifest.registry.sourceSha !== manifest.producer.registrySourceSha ||
    manifest.registry.workflowRunId !== manifest.producer.runId ||
    manifest.website.runId !== manifest.producer.websiteBuildRunId ||
    manifest.website.sourceSha !== manifest.producer.websiteSourceSha ||
    manifest.registry.previousSha256 === manifest.registry.sha256
  ) {
    throw new Error('release manifest producer/live tuple is internally inconsistent')
  }
  const expectedBackupKey =
    `private/backups/plugins/${manifest.operationId}-` +
    `${manifest.registry.previousSha256}.json`
  if (manifest.registry.backupKey !== expectedBackupKey) {
    throw new Error('release manifest backup key is not stable for the operation')
  }
  return manifest
}

async function createFreshExtractionRoot(destination: string): Promise<void> {
  if (!path.isAbsolute(destination)) {
    throw new Error('verified artifact extraction destination must be absolute')
  }
  await mkdir(destination, { recursive: false, mode: 0o700 })
}

async function writeRegistryBundleInto(
  bundle: VerifiedRegistryArtifactBundle,
  destination: string
): Promise<string> {
  const bytes = verifiedRegistryPayloads.get(bundle)
  if (!bytes || bundle[VERIFIED_REGISTRY_ARTIFACT] !== true) {
    throw new Error('registry artifact must be verified before extraction')
  }
  if (!candidateBoundRegistryBundles.has(bundle)) {
    throw new Error(
      'registry artifact extraction requires candidate-manifest binding'
    )
  }
  await mkdir(destination, { recursive: false, mode: 0o700 })
  const registryPath = path.join(destination, REGISTRY_ARTIFACT_ENTRY)
  await writeFile(registryPath, bytes, { flag: 'wx', mode: 0o600 })
  return registryPath
}

async function writeWebsiteBundleInto(
  bundle: VerifiedWebsiteArtifactBundle,
  destination: string
): Promise<{ manifestPath: string; distDir: string }> {
  const payload = verifiedWebsitePayloads.get(bundle)
  if (!payload || bundle[VERIFIED_WEBSITE_ARTIFACT] !== true) {
    throw new Error('website artifact must be verified before extraction')
  }
  if (!deployableWebsiteBundles.has(bundle)) {
    throw new Error(
      'website artifact extraction requires promotion or restore tuple binding'
    )
  }
  await mkdir(destination, { recursive: false, mode: 0o700 })
  const manifestPath = path.join(destination, WEBSITE_ARTIFACT_MANIFEST_ENTRY)
  await writeFile(manifestPath, payload.manifestBytes, {
    flag: 'wx',
    mode: 0o600,
  })

  const distDir = path.join(destination, 'dist')
  await mkdir(distDir, { recursive: false, mode: 0o700 })
  const sortedFiles = [...payload.distFiles].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  )
  for (const [relativePath, bytes] of sortedFiles) {
    const outputPath = path.resolve(distDir, ...relativePath.split('/'))
    if (!outputPath.startsWith(distDir + path.sep)) {
      throw new Error('verified website artifact escaped the dist directory')
    }
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
    await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 })
  }
  return { manifestPath, distDir }
}

export async function extractVerifiedRegistryArtifactBundle(
  bundle: VerifiedRegistryArtifactBundle,
  destination: string
): Promise<string> {
  if (!candidateBoundRegistryBundles.has(bundle)) {
    throw new Error(
      'registry artifact extraction requires candidate-manifest binding'
    )
  }
  await createFreshExtractionRoot(destination)
  return writeRegistryBundleInto(bundle, path.join(destination, 'registry'))
}

export async function extractVerifiedWebsiteArtifactBundle(
  bundle: VerifiedWebsiteArtifactBundle,
  destination: string
): Promise<{ manifestPath: string; distDir: string }> {
  if (!deployableWebsiteBundles.has(bundle)) {
    throw new Error(
      'website artifact extraction requires promotion or restore tuple binding'
    )
  }
  await createFreshExtractionRoot(destination)
  return writeWebsiteBundleInto(bundle, path.join(destination, 'website'))
}

export async function extractVerifiedPromotionBundle(
  bundle: VerifiedPromotionBundle,
  destination: string
): Promise<{
  registryPath: string
  websiteManifestPath: string
  websiteDistDir: string
}> {
  if (
    bundle[VERIFIED_PROMOTION_BUNDLE] !== true ||
    !verifiedPromotionBundles.has(bundle)
  ) {
    throw new Error(
      'promotion pair must be produced by the exact promotion bundle verifier'
    )
  }
  await createFreshExtractionRoot(destination)
  const registryPath = await writeRegistryBundleInto(
    bundle.registry,
    path.join(destination, 'registry')
  )
  const website = await writeWebsiteBundleInto(
    bundle.website,
    path.join(destination, 'website')
  )
  return {
    registryPath,
    websiteManifestPath: website.manifestPath,
    websiteDistDir: website.distDir,
  }
}

export function assertCandidateIsCurrent(
  candidateSourceSha: string,
  currentSourceSha: string
): void {
  SourceShaSchema.parse(candidateSourceSha)
  SourceShaSchema.parse(currentSourceSha)
  if (candidateSourceSha !== currentSourceSha) {
    throw new Error(
      'candidate was superseded: source SHA is no longer the current main SHA'
    )
  }
}

type RestoreTuple = RestoreManifest['from'] | RestoreManifest['to']

function candidateFromRestoreTuple(tuple: RestoreTuple): RegistryCandidateManifest {
  return RegistryCandidateManifestSchema.parse({
    schemaVersion: 1,
    registry: {
      sha256: tuple.registry.sha256,
      bytes: tuple.registry.bytes,
      sourceSha: tuple.producer.sourceSha,
      runId: tuple.registry.workflowRunId,
      artifactId: tuple.registry.artifactId,
      artifactSha256: tuple.registry.artifactSha256,
    },
  })
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function apiId(value: unknown, label: string): string {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))
  ) {
    return String(value)
  }
  throw new Error(`${label} is not a positive GitHub numeric id`)
}

function apiString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`)
  }
  return value
}

function validateGitHubRestoreProvenance(options: {
  tuple: RestoreTuple
  candidateManifestArtifact: unknown
  websiteArtifact: unknown
  registryArtifact: unknown
  rawRun: unknown
  rawRunApiEndpoint: string
  rawWorkflow: unknown
  completionManifest: unknown
  completionManifestRawSha256: string
  completionArtifact: unknown
  completionRun: unknown
  completionRunApiEndpoint: string
  completionWorkflow: unknown
}): NormalizedTupleProvenance {
  const tuple = options.tuple
  const candidateManifestArtifact = asRecord(
    options.candidateManifestArtifact,
    'candidate manifest artifact metadata'
  )
  const websiteArtifact = asRecord(options.websiteArtifact, 'website artifact metadata')
  const registryArtifact = asRecord(options.registryArtifact, 'registry artifact metadata')
  const run = asRecord(options.rawRun, 'workflow run metadata')
  const workflow = asRecord(options.rawWorkflow, 'workflow metadata')
  const repository = asRecord(run.repository, 'workflow run repository')
  const headRepository = asRecord(
    run.head_repository,
    'workflow run head repository'
  )
  const expectedRunId = tuple.registry.workflowRunId
  if (
    apiId(run.id, 'workflow run id') !== expectedRunId ||
    apiId(run.workflow_id, 'workflow run workflow id') !==
      tuple.producer.workflowId ||
    apiId(repository.id, 'workflow run repository id') !==
      tuple.producer.repositoryId ||
    apiId(headRepository.id, 'workflow run head repository id') !==
      tuple.producer.repositoryId
  ) {
    throw new Error('workflow run identity differs from the restore producer tuple')
  }
  if (
    apiString(repository.full_name, 'workflow run repository name') !==
      apiString(headRepository.full_name, 'workflow run head repository name') ||
    run.head_sha !== tuple.producer.sourceSha ||
    run.head_branch !== 'main' ||
    run.event !== tuple.producer.event ||
    run.status !== 'completed' ||
    !CompletedGitHubConclusionSchema.safeParse(run.conclusion).success
  ) {
    throw new Error('workflow run source/event/conclusion is not a trusted publish run')
  }
  if (
    apiId(workflow.id, 'workflow id') !== tuple.producer.workflowId ||
    workflow.path !== tuple.producer.workflowPath
  ) {
    throw new Error('workflow endpoint differs from the trusted publish workflow')
  }
  const allowedRunPaths = [
    tuple.producer.workflowPath,
    `${tuple.producer.workflowPath}@main`,
    `${tuple.producer.workflowPath}@refs/heads/main`,
  ]
  if (!allowedRunPaths.includes(apiString(run.path, 'workflow run path'))) {
    throw new Error('workflow run path does not cross-check with the workflow endpoint')
  }
  apiId(run.run_attempt, 'workflow run attempt')
  const expectedRawEndpoint =
    `https://api.github.com/repos/${repository.full_name}/actions/runs/${expectedRunId}`
  if (options.rawRunApiEndpoint !== expectedRawEndpoint) {
    throw new Error('raw run metadata was not captured from its bound GitHub API endpoint')
  }

  const normalizeArtifact = (
    artifact: Record<string, unknown>,
    expected: { artifactId: string; artifactName: string; artifactSha256: string },
    expectedRun: {
      runId: string
      repositoryId: string
      sourceSha: string
    },
    label: string
  ): z.infer<typeof NormalizedArtifactProvenanceSchema> => {
    if (
      apiId(artifact.id, `${label} id`) !== expected.artifactId ||
      artifact.name !== expected.artifactName ||
      artifact.expired !== false ||
      artifact.digest !== `sha256:${expected.artifactSha256}` ||
      artifact.archive_download_url !==
        `https://api.github.com/repos/${repository.full_name}/actions/artifacts/${expected.artifactId}/zip`
    ) {
      throw new Error(`${label} metadata differs from the restore tuple`)
    }
    const producer = asRecord(artifact.workflow_run, `${label} workflow run`)
    if (
      apiId(producer.id, `${label} run id`) !== expectedRun.runId ||
      apiId(producer.repository_id, `${label} repository id`) !==
        expectedRun.repositoryId ||
      apiId(producer.head_repository_id, `${label} head repository id`) !==
        expectedRun.repositoryId ||
      producer.head_branch !== 'main' ||
      producer.head_sha !== expectedRun.sourceSha
    ) {
      throw new Error(`${label} is not bound to the trusted publish run`)
    }
    return NormalizedArtifactProvenanceSchema.parse({
      artifactId: expected.artifactId,
      artifactName: expected.artifactName,
      artifactSha256: expected.artifactSha256,
      runId: expectedRun.runId,
      repositoryId: expectedRun.repositoryId,
      headRepositoryId: expectedRun.repositoryId,
      headBranch: 'main',
      headSha: expectedRun.sourceSha,
    })
  }
  const rawRunIdentity = {
    runId: expectedRunId,
    repositoryId: tuple.producer.repositoryId,
    sourceSha: tuple.producer.sourceSha,
  }
  const candidateProof = normalizeArtifact(
    candidateManifestArtifact,
    tuple.candidateManifestArtifact,
    rawRunIdentity,
    'candidate manifest artifact'
  )
  const websiteProof = normalizeArtifact(
    websiteArtifact,
    tuple.website,
    rawRunIdentity,
    'website artifact'
  )
  const registryProof = normalizeArtifact(
    registryArtifact,
    tuple.registry,
    rawRunIdentity,
    'registry artifact'
  )

  const release = validateReleaseManifestV2(options.completionManifest)
  if (Sha256Schema.parse(options.completionManifestRawSha256) !== tuple.completion.manifestSha256) {
    throw new Error('release completion manifest raw SHA differs from the restore tuple')
  }
  if (
    release.producer.repository !== repository.full_name ||
    release.producer.runId !== tuple.registry.workflowRunId ||
    release.producer.registrySourceSha !== tuple.producer.sourceSha ||
    release.intent.artifactId === tuple.completion.artifactId ||
    release.candidateManifestArtifact.id !==
      tuple.candidateManifestArtifact.artifactId ||
    release.candidateManifestArtifact.filename !==
      tuple.candidateManifestArtifact.artifactName ||
    release.candidateManifestArtifact.sha256 !==
      tuple.candidateManifestArtifact.artifactSha256 ||
    release.registry.sha256 !== tuple.registry.sha256 ||
    release.registry.bytes !== tuple.registry.bytes ||
    release.registry.artifactId !== tuple.registry.artifactId ||
    release.registry.artifactName !== tuple.registry.artifactName ||
    release.registry.artifactSha256 !== tuple.registry.artifactSha256 ||
    release.website.artifactId !== tuple.website.artifactId ||
    release.website.artifactName !== tuple.website.artifactName ||
    release.website.artifactSha256 !== tuple.website.artifactSha256 ||
    release.website.sourceSha !== tuple.website.sourceSha ||
    release.website.distSha256 !== tuple.website.distSha256
  ) {
    throw new Error('release completion manifest does not bind the restore raw/live tuple')
  }

  const completionRun = asRecord(options.completionRun, 'completion run metadata')
  const completionWorkflow = asRecord(
    options.completionWorkflow,
    'completion workflow metadata'
  )
  const completionRepository = asRecord(
    completionRun.repository,
    'completion run repository'
  )
  const completionHeadRepository = asRecord(
    completionRun.head_repository,
    'completion run head repository'
  )
  if (
    apiId(completionRun.id, 'completion run id') !== tuple.completion.runId ||
    apiId(completionRun.workflow_id, 'completion workflow id') !==
      tuple.producer.workflowId ||
    apiId(completionRepository.id, 'completion repository id') !==
      tuple.producer.repositoryId ||
    apiId(completionHeadRepository.id, 'completion head repository id') !==
      tuple.producer.repositoryId ||
    completionRepository.full_name !== repository.full_name ||
    completionHeadRepository.full_name !== repository.full_name ||
    completionRun.head_sha !== tuple.completion.sourceSha ||
    completionRun.head_branch !== 'main' ||
    completionRun.event !== tuple.completion.event ||
    completionRun.status !== 'completed' ||
    completionRun.conclusion !== 'success' ||
    apiId(completionRun.run_attempt, 'completion run attempt') !==
      tuple.completion.runAttempt ||
    apiId(completionWorkflow.id, 'completion workflow endpoint id') !==
      tuple.producer.workflowId ||
    completionWorkflow.path !== tuple.producer.workflowPath
  ) {
    throw new Error('completion run is not a successful trusted current-main publish')
  }
  const allowedCompletionPaths = [
    tuple.producer.workflowPath,
    `${tuple.producer.workflowPath}@main`,
    `${tuple.producer.workflowPath}@refs/heads/main`,
  ]
  if (!allowedCompletionPaths.includes(String(completionRun.path))) {
    throw new Error('completion run path is not the trusted publish workflow')
  }
  const expectedCompletionEndpoint =
    `https://api.github.com/repos/${repository.full_name}/actions/runs/` +
    `${tuple.completion.runId}/attempts/${tuple.completion.runAttempt}`
  if (options.completionRunApiEndpoint !== expectedCompletionEndpoint) {
    throw new Error('completion metadata was not captured from the attempt-specific endpoint')
  }
  if (run.conclusion !== 'success' && tuple.completion.event !== 'workflow_dispatch') {
    throw new Error('a failed raw producer can only be bridged by a dispatched completion run')
  }
  if (
    release.completion.workflowRunId !== tuple.completion.runId ||
    release.completion.workflowRunAttempt !== tuple.completion.runAttempt ||
    release.completion.sourceSha !== tuple.completion.sourceSha ||
    release.completion.event !== tuple.completion.event
  ) {
    throw new Error('release manifest completion tuple differs from its producer run')
  }
  const completionArtifactProof = normalizeArtifact(
    asRecord(options.completionArtifact, 'completion manifest artifact metadata'),
    tuple.completion,
    {
      runId: tuple.completion.runId,
      repositoryId: tuple.producer.repositoryId,
      sourceSha: tuple.completion.sourceSha,
    },
    'completion manifest artifact'
  )

  const normalizeRun = (
    source: Record<string, unknown>,
    sourceRepository: Record<string, unknown>,
    sourceHeadRepository: Record<string, unknown>
  ) =>
    NormalizedRunProvenanceSchema.parse({
      runId: apiId(source.id, 'normalized run id'),
      repositoryId: apiId(sourceRepository.id, 'normalized repository id'),
      headRepositoryId: apiId(
        sourceHeadRepository.id,
        'normalized head repository id'
      ),
      repository: sourceRepository.full_name,
      headRepository: sourceHeadRepository.full_name,
      workflowId: apiId(source.workflow_id, 'normalized workflow id'),
      workflowPath: tuple.producer.workflowPath,
      runPath: source.path,
      headSha: source.head_sha,
      headBranch: source.head_branch,
      event: source.event,
    })
  return NormalizedTupleProvenanceSchema.parse({
    raw: {
      run: normalizeRun(
        run,
        repository,
        headRepository
      ),
      candidateManifestArtifact: candidateProof,
      registryArtifact: registryProof,
      websiteArtifact: websiteProof,
    },
    completion: {
      run: {
        ...normalizeRun(
          completionRun,
          completionRepository,
          completionHeadRepository
        ),
        conclusion: 'success',
        runAttempt: tuple.completion.runAttempt,
        apiEndpoint: options.completionRunApiEndpoint,
      },
      manifestArtifact: completionArtifactProof,
      manifest: release,
    },
  })
}

async function verifyRestoreTupleArtifacts(options: {
  tuple: RestoreTuple
  websiteArtifactPath: string
  registryArtifactPath: string
  enforceBasenames: boolean
}): Promise<{
  registry: VerifiedRegistryArtifactBundle
  website: VerifiedWebsiteArtifactBundle
  registryBytes: Buffer
}> {
  const tuple = options.tuple
  if (options.enforceBasenames) {
    assertArtifactBasename(
      options.websiteArtifactPath,
      tuple.website.artifactName
    )
    assertArtifactBasename(
      options.registryArtifactPath,
      tuple.registry.artifactName
    )
  }
  const candidate = candidateFromRestoreTuple(tuple)
  const registry = await verifyRegistryArtifactBundle({
    artifactPath: options.registryArtifactPath,
    artifactId: tuple.registry.artifactId,
    expectedArtifactId: tuple.registry.artifactId,
    expectedArtifactSha256: tuple.registry.artifactSha256,
    candidate,
  })
  const website = await verifyWebsiteArtifactBundle({
    artifactPath: options.websiteArtifactPath,
    artifactId: tuple.website.artifactId,
    expectedArtifactId: tuple.website.artifactId,
    expectedArtifactSha256: tuple.website.artifactSha256,
    websiteSourceSha: tuple.website.sourceSha,
    websiteBuildRunId: tuple.website.runId,
    candidate,
  })
  const embedded = website.manifest
  if (
    embedded.distSha256 !== tuple.website.distSha256 ||
    embedded.registrySha256 !== tuple.website.registrySha256 ||
    embedded.registryArtifactSha256 !==
      tuple.website.registryArtifactSha256 ||
    embedded.registryWorkflowRunId !==
      tuple.website.registryWorkflowRunId ||
    embedded.registryArtifactId !== tuple.website.registryArtifactId
  ) {
    throw new Error('website ZIP embedded manifest differs from the restore tuple')
  }
  const registryBytes = verifiedRegistryPayloads.get(registry)
  if (!registryBytes) throw new Error('verified restore registry payload is unavailable')
  deployableWebsiteBundles.add(website)
  return { registry, website, registryBytes }
}

function restoreOperationKey(manifest: RestoreManifest): string {
  return sha256(Buffer.from(canonicalJson({ from: manifest.from, to: manifest.to })))
}

function restoreOperationKeys(operationKey: string): z.infer<typeof RestoreOperationKeysSchema> {
  const base = `restore-operations/v2/${operationKey}/`
  return RestoreOperationKeysSchema.parse({
    intentKey: `${base}intent.json`,
    authorizedManifestKey: `${base}authorized-manifest.json`,
    reverseRegistryPayloadKey: `${base}reverse/plugins.json`,
    reverseRegistryArtifactKey: `${base}reverse/registry.zip`,
    reverseWebsiteArtifactKey: `${base}reverse/website.zip`,
    targetRegistryArtifactKey: `${base}target/registry.zip`,
    targetWebsiteArtifactKey: `${base}target/website.zip`,
    completionKey: `${base}completion.json`,
    reverseManifestKey: `${base}reverse/restore-manifest.json`,
  })
}

function createReverseRestoreManifest(options: {
  manifest: RestoreManifest
  operationKey: string
  intentSha256: string
  completionSha256: string
  completionIdentity: z.infer<typeof R2OperationArtifactSourceSchema>['completionIdentity']
  observedTargetEtag: string
  reverseRegistrySourceEtag: string
}): RestoreManifest {
  const keys = restoreOperationKeys(options.operationKey)
  const sharedSource = {
    kind: 'r2-operation' as const,
    parentOperationKey: options.operationKey,
    intentKey: keys.intentKey,
    intentSha256: Sha256Schema.parse(options.intentSha256),
    completionKey: keys.completionKey,
    completionSha256: Sha256Schema.parse(options.completionSha256),
    reverseManifestKey: keys.reverseManifestKey,
    completionIdentity: options.completionIdentity,
  }
  const { sourceKey: _toSourceKey, sourceEtag: _toSourceEtag, ...toRegistry } =
    options.manifest.to.registry
  const { etag: _fromEtag, ...fromRegistry } = options.manifest.from.registry
  return RestoreManifestSchema.parse({
    schemaVersion: 2,
    from: {
      ...options.manifest.to,
      registry: {
        ...toRegistry,
        etag: OpaqueEtagSchema.parse(options.observedTargetEtag),
      },
      artifactSource: {
        ...sharedSource,
        registryArtifactKey: keys.targetRegistryArtifactKey,
        websiteArtifactKey: keys.targetWebsiteArtifactKey,
      },
    },
    to: {
      ...options.manifest.from,
      registry: {
        ...fromRegistry,
        sourceKey: keys.reverseRegistryPayloadKey,
        sourceEtag: OpaqueEtagSchema.parse(options.reverseRegistrySourceEtag),
      },
      artifactSource: {
        ...sharedSource,
        registryArtifactKey: keys.reverseRegistryArtifactKey,
        websiteArtifactKey: keys.reverseWebsiteArtifactKey,
      },
    },
  })
}

function createRestoreIntent(
  manifest: RestoreManifest,
  operationKey: string,
  keys: z.infer<typeof RestoreOperationKeysSchema>,
  provenance: { from: NormalizedTupleProvenance; to: NormalizedTupleProvenance }
): RestoreIntent {
  return RestoreIntentSchema.parse({
    schemaVersion: 2,
    kind: 'restore-intent',
    operationKey,
    manifest,
    provenance,
    objects: {
      reverseRegistryPayload: {
        key: keys.reverseRegistryPayloadKey,
        sha256: manifest.from.registry.sha256,
      },
      reverseRegistryArtifact: {
        key: keys.reverseRegistryArtifactKey,
        sha256: manifest.from.registry.artifactSha256,
      },
      reverseWebsiteArtifact: {
        key: keys.reverseWebsiteArtifactKey,
        sha256: manifest.from.website.artifactSha256,
      },
      targetRegistryArtifact: {
        key: keys.targetRegistryArtifactKey,
        sha256: manifest.to.registry.artifactSha256,
      },
      targetWebsiteArtifact: {
        key: keys.targetWebsiteArtifactKey,
        sha256: manifest.to.website.artifactSha256,
      },
      authorizedManifest: {
        key: keys.authorizedManifestKey,
        canonicalSha256: sha256(canonicalJsonBytes(manifest)),
      },
    },
  })
}

function createRestorePlan(options: {
  manifest: RestoreManifest
  mode: 'cas' | 'resume'
  currentSha256: string
  currentEtag: string
  provenance: { from: NormalizedTupleProvenance; to: NormalizedTupleProvenance }
}): { plan: RestorePlan; intent: RestoreIntent } {
  const operationKey = restoreOperationKey(options.manifest)
  const keys = restoreOperationKeys(operationKey)
  const intent = createRestoreIntent(
    options.manifest,
    operationKey,
    keys,
    options.provenance
  )
  const plan = RestorePlanSchema.parse({
    schemaVersion: 2,
    mode: options.mode,
    currentSha256: options.currentSha256,
    currentEtag: options.currentEtag,
    operationKey,
    manifestCanonicalSha256: sha256(canonicalJsonBytes(options.manifest)),
    intentSha256: sha256(canonicalJsonBytes(intent)),
    provenance: options.provenance,
    ...keys,
    reverseSeed: {
      requiresObservedFromEtag: true,
      requiresObservedSourceEtag: true,
      registrySourceKey: keys.reverseRegistryPayloadKey,
      manifestKey: keys.reverseManifestKey,
      fromRegistryArtifactKey: keys.targetRegistryArtifactKey,
      fromWebsiteArtifactKey: keys.targetWebsiteArtifactKey,
      toRegistryArtifactKey: keys.reverseRegistryArtifactKey,
      toWebsiteArtifactKey: keys.reverseWebsiteArtifactKey,
    },
  })
  return { plan, intent }
}

export function deriveRestoreOperationV2(input: unknown): {
  operationKey: string
  manifestCanonicalSha256: string
  objects: z.infer<typeof RestoreOperationKeysSchema>
} {
  const manifest = RestoreManifestSchema.parse(input)
  const operationKey = restoreOperationKey(manifest)
  return {
    operationKey,
    manifestCanonicalSha256: sha256(canonicalJsonBytes(manifest)),
    objects: restoreOperationKeys(operationKey),
  }
}

async function assertStrictDirectory(
  directory: string,
  expectedNames: string[],
  label: string
): Promise<void> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`)
  }
  const actual = (await readdir(directory)).sort()
  const expected = [...expectedNames].sort()
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} has missing or unexpected proof records`)
  }
}

const GitHubEndpointSchema = z.object({ url: z.string().url() }).strict()

async function readGitHubTupleProof(
  root: string,
  tuple: RestoreTuple
): Promise<NormalizedTupleProvenance> {
  const names = [
    'candidate-artifact.json',
    'registry-artifact.json',
    'website-artifact.json',
    'raw-run.json',
    'raw-run-endpoint.json',
    'raw-workflow.json',
    'release-manifest.json',
    'completion-artifact.json',
    'completion-run.json',
    'completion-run-endpoint.json',
    'completion-workflow.json',
  ]
  await assertStrictDirectory(root, names, 'GitHub restore proof root')
  const releaseBytes = await readRegularFile(
    path.join(root, 'release-manifest.json'),
    'release completion manifest'
  )
  const release = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes)
  )
  const rawEndpoint = GitHubEndpointSchema.parse(
    await readJson(path.join(root, 'raw-run-endpoint.json'))
  )
  const completionEndpoint = GitHubEndpointSchema.parse(
    await readJson(path.join(root, 'completion-run-endpoint.json'))
  )
  return validateGitHubRestoreProvenance({
    tuple,
    candidateManifestArtifact: await readJson(
      path.join(root, 'candidate-artifact.json')
    ),
    registryArtifact: await readJson(path.join(root, 'registry-artifact.json')),
    websiteArtifact: await readJson(path.join(root, 'website-artifact.json')),
    rawRun: await readJson(path.join(root, 'raw-run.json')),
    rawRunApiEndpoint: rawEndpoint.url,
    rawWorkflow: await readJson(path.join(root, 'raw-workflow.json')),
    completionManifest: release,
    completionManifestRawSha256: sha256(releaseBytes),
    completionArtifact: await readJson(
      path.join(root, 'completion-artifact.json')
    ),
    completionRun: await readJson(path.join(root, 'completion-run.json')),
    completionRunApiEndpoint: completionEndpoint.url,
    completionWorkflow: await readJson(
      path.join(root, 'completion-workflow.json')
    ),
  })
}

async function readR2ParentProof(
  root: string,
  manifest: RestoreManifest
): Promise<{ from: NormalizedTupleProvenance; to: NormalizedTupleProvenance }> {
  await assertStrictDirectory(
    root,
    ['intent.json', 'completion.json', 'reverse-manifest.json'],
    'R2 parent proof root'
  )
  const intentBytes = await readRegularFile(path.join(root, 'intent.json'), 'parent intent')
  const completionBytes = await readRegularFile(
    path.join(root, 'completion.json'),
    'parent completion'
  )
  const intent = RestoreIntentSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(intentBytes))
  )
  const completion = RestoreCompletionSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(completionBytes))
  )
  const reverseManifestBytes = await readRegularFile(
    path.join(root, 'reverse-manifest.json'),
    'parent reverse manifest'
  )
  const reverseManifest = RestoreManifestSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(reverseManifestBytes)
    )
  )
  if (
    manifest.from.artifactSource.kind !== 'r2-operation' ||
    manifest.to.artifactSource.kind !== 'r2-operation'
  ) {
    throw new Error('R2 proof cannot authorize GitHub restore sources')
  }
  const parentOperationKey = manifest.from.artifactSource.parentOperationKey
  const source = manifest.from.artifactSource
  const parentKeys = restoreOperationKeys(parentOperationKey)
  const expectedIntent = createRestoreIntent(
    intent.manifest,
    parentOperationKey,
    parentKeys,
    intent.provenance
  )
  if (
    intent.operationKey !== parentOperationKey ||
    restoreOperationKey(intent.manifest) !== parentOperationKey ||
    canonicalJson(intent) !== canonicalJson(expectedIntent) ||
    !intentBytes.equals(canonicalJsonBytes(intent)) ||
    !completionBytes.equals(canonicalJsonBytes(completion)) ||
    !reverseManifestBytes.equals(canonicalJsonBytes(reverseManifest)) ||
    completion.operationKey !== parentOperationKey ||
    completion.intentSha256 !== sha256(canonicalJsonBytes(intent)) ||
    completion.authorizedManifestCanonicalSha256 !==
      sha256(canonicalJsonBytes(intent.manifest)) ||
    canonicalJson(completion.objects) !== canonicalJson(parentKeys) ||
    source.intentSha256 !== sha256(intentBytes) ||
    source.completionSha256 !== sha256(completionBytes) ||
    canonicalJson(source.completionIdentity) !== canonicalJson({
      mode: completion.mode,
      workflow: completion.workflow,
      targetEtag: completion.observed.targetEtag,
      reverseRegistrySourceEtag:
        completion.observed.reverseRegistrySourceEtag,
    }) ||
    canonicalJson(completion) !==
      canonicalJson(
        buildRestoreCompletionFromIdentity({
          manifest: intent.manifest,
          operationKey: parentOperationKey,
          intentSha256: source.intentSha256,
          identity: source.completionIdentity,
        })
      ) ||
    canonicalJson(reverseManifest) !== canonicalJson(manifest) ||
    canonicalJson(
      createReverseRestoreManifest({
        manifest: intent.manifest,
        operationKey: parentOperationKey,
        intentSha256: source.intentSha256,
        completionSha256: source.completionSha256,
        completionIdentity: source.completionIdentity,
        observedTargetEtag: completion.observed.targetEtag,
        reverseRegistrySourceEtag: completion.observed.reverseRegistrySourceEtag,
      })
    ) !== canonicalJson(manifest)
  ) {
    throw new Error('R2 parent attestation is not a complete direct-parent restore proof')
  }
  if (
    completion.observed.targetSha256 !== manifest.from.registry.sha256 ||
    completion.observed.targetEtag !== manifest.from.registry.etag ||
    completion.observed.reverseRegistrySha256 !== manifest.to.registry.sha256 ||
    completion.observed.reverseRegistrySourceKey !== manifest.to.registry.sourceKey ||
    completion.observed.reverseRegistrySourceEtag !== manifest.to.registry.sourceEtag
  ) {
    throw new Error('R2 parent completion does not bind the reverse live/source tuple')
  }
  const fromSource = manifest.from.artifactSource
  const toSource = manifest.to.artifactSource
  if (
    fromSource.intentKey !== parentKeys.intentKey ||
    fromSource.intentSha256 !== source.intentSha256 ||
    fromSource.completionKey !== parentKeys.completionKey ||
    fromSource.completionSha256 !== source.completionSha256 ||
    fromSource.reverseManifestKey !== parentKeys.reverseManifestKey ||
    fromSource.registryArtifactKey !== parentKeys.targetRegistryArtifactKey ||
    fromSource.websiteArtifactKey !== parentKeys.targetWebsiteArtifactKey ||
    toSource.intentKey !== parentKeys.intentKey ||
    toSource.intentSha256 !== source.intentSha256 ||
    toSource.completionKey !== parentKeys.completionKey ||
    toSource.completionSha256 !== source.completionSha256 ||
    toSource.reverseManifestKey !== parentKeys.reverseManifestKey ||
    toSource.registryArtifactKey !== parentKeys.reverseRegistryArtifactKey ||
    toSource.websiteArtifactKey !== parentKeys.reverseWebsiteArtifactKey
  ) {
    throw new Error('R2 restore manifest does not reference the attested parent objects')
  }
  return {
    from: NormalizedTupleProvenanceSchema.parse(intent.provenance.to),
    to: NormalizedTupleProvenanceSchema.parse(intent.provenance.from),
  }
}

async function readSourceProvenance(
  proofRoot: string,
  manifest: RestoreManifest
): Promise<{ from: NormalizedTupleProvenance; to: NormalizedTupleProvenance }> {
  if (manifest.from.artifactSource.kind === 'github') {
    await assertStrictDirectory(proofRoot, ['from', 'to'], 'restore proof root')
    return {
      from: await readGitHubTupleProof(path.join(proofRoot, 'from'), manifest.from),
      to: await readGitHubTupleProof(path.join(proofRoot, 'to'), manifest.to),
    }
  }
  return readR2ParentProof(proofRoot, manifest)
}

async function verifyAndExtractRestore(options: {
  manifest: RestoreManifest
  provenance: { from: NormalizedTupleProvenance; to: NormalizedTupleProvenance }
  currentRegistryPath: string
  currentEtag: string
  targetRegistrySourcePath?: string
  targetSourceEtag?: string
  targetWebsiteArtifactPath: string
  targetRegistryArtifactPath: string
  fromWebsiteArtifactPath: string
  fromRegistryArtifactPath: string
  extractionRoot: string
  planOutputPath: string
  intentOutputPath?: string
  authorizedManifestOutputPath?: string
  enforceArtifactBasenames?: boolean
}): Promise<RestorePlan> {
  const { manifest } = options
  const currentEtag = OpaqueEtagSchema.parse(options.currentEtag)
  const target = await verifyRestoreTupleArtifacts({
    tuple: manifest.to,
    websiteArtifactPath: options.targetWebsiteArtifactPath,
    registryArtifactPath: options.targetRegistryArtifactPath,
    enforceBasenames:
      options.enforceArtifactBasenames ??
      manifest.to.artifactSource.kind === 'github',
  })
  const from = await verifyRestoreTupleArtifacts({
    tuple: manifest.from,
    websiteArtifactPath: options.fromWebsiteArtifactPath,
    registryArtifactPath: options.fromRegistryArtifactPath,
    enforceBasenames:
      options.enforceArtifactBasenames ??
      manifest.from.artifactSource.kind === 'github',
  })
  if (options.targetRegistrySourcePath !== undefined) {
    if (
      OpaqueEtagSchema.parse(options.targetSourceEtag) !==
      manifest.to.registry.sourceEtag
    ) {
      throw new Error('target registry source ETag differs from the restore manifest')
    }
    const targetSourceBytes = await readRegistryV2(
      options.targetRegistrySourcePath
    )
    if (!target.registryBytes.equals(targetSourceBytes)) {
      throw new Error('target registry ZIP differs byte-for-byte from its source object')
    }
  }
  const currentBytes = await readRegistryV2(options.currentRegistryPath)
  const currentSha256 = sha256(currentBytes)
  let mode: 'cas' | 'resume'
  if (
    currentSha256 === manifest.from.registry.sha256 &&
    currentEtag === manifest.from.registry.etag &&
    currentBytes.equals(from.registryBytes)
  ) {
    mode = 'cas'
  } else if (
    currentSha256 === manifest.to.registry.sha256 &&
    currentBytes.equals(target.registryBytes)
  ) {
    mode = 'resume'
  } else {
    throw new Error('live registry is neither the exact restore from-state nor target')
  }
  await createFreshExtractionRoot(options.extractionRoot)
  await writeRegistryBundleInto(target.registry, path.join(options.extractionRoot, 'registry'))
  await writeWebsiteBundleInto(target.website, path.join(options.extractionRoot, 'website'))
  await writeRegistryBundleInto(from.registry, path.join(options.extractionRoot, 'from-registry'))
  await writeWebsiteBundleInto(from.website, path.join(options.extractionRoot, 'from-website'))
  const { plan, intent } = createRestorePlan({
    manifest,
    mode,
    currentSha256,
    currentEtag,
    provenance: options.provenance,
  })
  if (options.intentOutputPath) {
    await writeJsonAtomicExclusive(options.intentOutputPath, intent, true)
  }
  if (options.authorizedManifestOutputPath) {
    await writeJsonAtomicExclusive(
      options.authorizedManifestOutputPath,
      manifest,
      true
    )
  }
  await writeJsonAtomicExclusive(options.planOutputPath, plan)
  return plan
}

export async function verifyRestoreV2(options: {
  manifestPath: string
  currentRegistryPath: string
  targetRegistrySourcePath: string
  targetWebsiteArtifactPath: string
  targetRegistryArtifactPath: string
  fromWebsiteArtifactPath: string
  fromRegistryArtifactPath: string
  sourceProofRoot: string
  existingIntentPath?: string
  currentEtag: string
  targetSourceEtag: string
  extractionRoot: string
  planOutputPath: string
  intentOutputPath: string
  authorizedManifestOutputPath: string
}): Promise<RestorePlan> {
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  const sourceProvenance = await readSourceProvenance(
    options.sourceProofRoot,
    manifest
  )
  let provenance = sourceProvenance
  if (options.existingIntentPath) {
    const existingBytes = await readRegularFile(
      options.existingIntentPath,
      'existing own restore intent'
    )
    const existing = RestoreIntentSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existingBytes))
    )
    const operationKey = restoreOperationKey(manifest)
    const expected = createRestoreIntent(
      manifest,
      operationKey,
      restoreOperationKeys(operationKey),
      existing.provenance
    )
    if (
      !existingBytes.equals(canonicalJsonBytes(expected)) ||
      canonicalJson(existing.provenance) !== canonicalJson(sourceProvenance)
    ) {
      throw new Error('existing own intent differs from the stable source proof')
    }
    provenance = existing.provenance
  }
  return verifyAndExtractRestore({
    manifest,
    provenance,
    ...options,
  })
}

export async function verifyRestoreSelfV2(options: {
  manifestPath: string
  currentRegistryPath: string
  selfProofRoot: string
  currentEtag: string
  extractionRoot: string
  planOutputPath: string
}): Promise<RestorePlan> {
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  await assertStrictDirectory(
    options.selfProofRoot,
    ['intent.json', 'authorized-manifest.json', 'reverse', 'target'],
    'self restore proof root'
  )
  await assertStrictDirectory(
    path.join(options.selfProofRoot, 'reverse'),
    ['plugins.json', 'registry.zip', 'website.zip'],
    'self reverse proof directory'
  )
  await assertStrictDirectory(
    path.join(options.selfProofRoot, 'target'),
    ['registry.zip', 'website.zip'],
    'self target proof directory'
  )
  const intentBytes = await readRegularFile(
    path.join(options.selfProofRoot, 'intent.json'),
    'self restore intent'
  )
  const authorizedBytes = await readRegularFile(
    path.join(options.selfProofRoot, 'authorized-manifest.json'),
    'self authorized manifest'
  )
  const intent = RestoreIntentSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(intentBytes))
  )
  const authorized = RestoreManifestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(authorizedBytes))
  )
  if (
    canonicalJson(authorized) !== canonicalJson(manifest) ||
    canonicalJson(intent.manifest) !== canonicalJson(manifest) ||
    !authorizedBytes.equals(canonicalJsonBytes(authorized)) ||
    intent.operationKey !== restoreOperationKey(manifest) ||
    !intentBytes.equals(
      canonicalJsonBytes(
        createRestoreIntent(
          manifest,
          intent.operationKey,
          restoreOperationKeys(intent.operationKey),
          intent.provenance
        )
      )
    )
  ) {
    throw new Error('self restore proof does not match the requested operation')
  }
  const reversePayload = await readRegistryV2(
    path.join(options.selfProofRoot, 'reverse/plugins.json')
  )
  if (sha256(reversePayload) !== manifest.from.registry.sha256) {
    throw new Error('self reverse registry payload differs from the intent')
  }
  return verifyAndExtractRestore({
    manifest,
    provenance: intent.provenance,
    currentRegistryPath: options.currentRegistryPath,
    currentEtag: options.currentEtag,
    targetWebsiteArtifactPath: path.join(options.selfProofRoot, 'target/website.zip'),
    targetRegistryArtifactPath: path.join(options.selfProofRoot, 'target/registry.zip'),
    fromWebsiteArtifactPath: path.join(options.selfProofRoot, 'reverse/website.zip'),
    fromRegistryArtifactPath: path.join(options.selfProofRoot, 'reverse/registry.zip'),
    extractionRoot: options.extractionRoot,
    planOutputPath: options.planOutputPath,
    enforceArtifactBasenames: false,
  })
}

async function verifyStoredRestoreArtifactPair(options: {
  tuple: RestoreTuple
  registryArtifactPath: string
  websiteArtifactPath: string
  registryPayloadPath?: string
}): Promise<void> {
  const verified = await verifyRestoreTupleArtifacts({
    tuple: options.tuple,
    registryArtifactPath: options.registryArtifactPath,
    websiteArtifactPath: options.websiteArtifactPath,
    enforceBasenames: false,
  })
  if (options.registryPayloadPath) {
    const payload = await readRegistryV2(options.registryPayloadPath)
    if (!payload.equals(verified.registryBytes)) {
      throw new Error('persisted reverse registry payload differs from its artifact ZIP')
    }
  }
}

async function verifyStoredRestoreRegistryArtifact(
  tuple: RestoreTuple,
  artifactPath: string
): Promise<Buffer> {
  const bundle = await verifyRegistryArtifactBundle({
    artifactPath,
    artifactId: tuple.registry.artifactId,
    expectedArtifactId: tuple.registry.artifactId,
    expectedArtifactSha256: tuple.registry.artifactSha256,
    candidate: candidateFromRestoreTuple(tuple),
  })
  const bytes = verifiedRegistryPayloads.get(bundle)
  if (!bytes) throw new Error('persisted registry artifact payload is unavailable')
  return bytes
}

async function verifyStoredRestoreWebsiteArtifact(
  tuple: RestoreTuple,
  artifactPath: string
): Promise<void> {
  const bundle = await verifyWebsiteArtifactBundle({
    artifactPath,
    artifactId: tuple.website.artifactId,
    expectedArtifactId: tuple.website.artifactId,
    expectedArtifactSha256: tuple.website.artifactSha256,
    websiteSourceSha: tuple.website.sourceSha,
    websiteBuildRunId: tuple.website.runId,
    candidate: candidateFromRestoreTuple(tuple),
  })
  if (canonicalJson(bundle.manifest) !== canonicalJson({
    schemaVersion: 1,
    registrySha256: tuple.website.registrySha256,
    registryWorkflowRunId: tuple.website.registryWorkflowRunId,
    registryArtifactId: tuple.website.registryArtifactId,
    registryArtifactSha256: tuple.website.registryArtifactSha256,
    websiteSourceSha: tuple.website.sourceSha,
    websiteBuildRunId: tuple.website.runId,
    distSha256: tuple.website.distSha256,
  })) {
    throw new Error('persisted website artifact differs from its restore tuple')
  }
  deployableWebsiteBundles.add(bundle)
}

export async function verifyRestoreOperationV2(options: {
  manifestPath: string
  planPath: string
  intentPath?: string
  reverseRegistryPayloadPath?: string
  reverseRegistryArtifactPath?: string
  reverseWebsiteArtifactPath?: string
  targetRegistryArtifactPath?: string
  targetWebsiteArtifactPath?: string
  authorizedManifestPath?: string
  allowMissingForCas?: boolean
}): Promise<void> {
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  const plan = RestorePlanSchema.parse(await readJson(options.planPath))
  const expected = createRestorePlan({
    manifest,
    mode: plan.mode,
    currentSha256: plan.currentSha256,
    currentEtag: plan.currentEtag,
    provenance: plan.provenance,
  })
  if (canonicalJson(plan) !== canonicalJson(expected.plan)) {
    throw new Error('restore plan differs from the manifest-derived immutable plan')
  }
  if (
    (plan.mode === 'cas' &&
      (plan.currentSha256 !== manifest.from.registry.sha256 ||
        plan.currentEtag !== manifest.from.registry.etag)) ||
    (plan.mode === 'resume' &&
      plan.currentSha256 !== manifest.to.registry.sha256)
  ) {
    throw new Error('restore plan mode does not match its recorded current state')
  }
  const paths = [
    options.intentPath,
    options.reverseRegistryPayloadPath,
    options.reverseRegistryArtifactPath,
    options.reverseWebsiteArtifactPath,
    options.targetRegistryArtifactPath,
    options.targetWebsiteArtifactPath,
    options.authorizedManifestPath,
  ]
  const missing = paths.some((value) => value === undefined)
  if (
    missing &&
    !(
      plan.mode === 'cas' &&
      options.allowMissingForCas === true
    )
  ) {
    throw new Error('restore operation records must all exist for resume/readback')
  }
  if (options.intentPath) {
    const bytes = await readRegularFile(options.intentPath, 'persisted restore intent')
    if (!bytes.equals(canonicalJsonBytes(expected.intent))) {
      throw new Error('persisted restore intent differs from the canonical intent')
    }
  }
  if (options.reverseRegistryPayloadPath) {
    const bytes = await readRegistryV2(options.reverseRegistryPayloadPath)
    if (sha256(bytes) !== manifest.from.registry.sha256) {
      throw new Error('persisted reverse registry payload differs from manifest.from')
    }
  }
  const hasFromPair = Boolean(
    options.reverseRegistryArtifactPath && options.reverseWebsiteArtifactPath
  )
  if (hasFromPair) {
    await verifyStoredRestoreArtifactPair({
      tuple: manifest.from,
      registryArtifactPath: options.reverseRegistryArtifactPath as string,
      websiteArtifactPath: options.reverseWebsiteArtifactPath as string,
      registryPayloadPath: options.reverseRegistryPayloadPath,
    })
  } else {
    if (options.reverseRegistryArtifactPath) {
      const bytes = await verifyStoredRestoreRegistryArtifact(
        manifest.from,
        options.reverseRegistryArtifactPath
      )
      if (options.reverseRegistryPayloadPath) {
        const payload = await readRegistryV2(
          options.reverseRegistryPayloadPath
        )
        if (!payload.equals(bytes)) {
          throw new Error('persisted reverse registry payload differs from its ZIP')
        }
      }
    }
    if (options.reverseWebsiteArtifactPath) {
      await verifyStoredRestoreWebsiteArtifact(
        manifest.from,
        options.reverseWebsiteArtifactPath
      )
    }
  }
  const hasTargetPair =
    options.targetRegistryArtifactPath !== undefined &&
    options.targetWebsiteArtifactPath !== undefined
  if (hasTargetPair) {
    await verifyStoredRestoreArtifactPair({
      tuple: manifest.to,
      registryArtifactPath: options.targetRegistryArtifactPath as string,
      websiteArtifactPath: options.targetWebsiteArtifactPath as string,
    })
  } else {
    if (options.targetRegistryArtifactPath) {
      await verifyStoredRestoreRegistryArtifact(
        manifest.to,
        options.targetRegistryArtifactPath
      )
    }
    if (options.targetWebsiteArtifactPath) {
      await verifyStoredRestoreWebsiteArtifact(
        manifest.to,
        options.targetWebsiteArtifactPath
      )
    }
  }
  if (options.authorizedManifestPath) {
    const persistedBytes = await readRegularFile(
      options.authorizedManifestPath,
      'persisted authorized manifest'
    )
    const persisted = RestoreManifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(persistedBytes)
      )
    )
    if (
      canonicalJson(persisted) !== canonicalJson(manifest) ||
      !persistedBytes.equals(canonicalJsonBytes(persisted))
    ) {
      throw new Error('persisted authorized manifest differs from the requested manifest')
    }
  }
}

function completionIdentity(
  completion: RestoreCompletion
): z.infer<typeof R2OperationArtifactSourceSchema>['completionIdentity'] {
  return {
    mode: completion.mode,
    workflow: completion.workflow,
    targetEtag: completion.observed.targetEtag,
    reverseRegistrySourceEtag: completion.observed.reverseRegistrySourceEtag,
  }
}

function buildRestoreCompletionFromIdentity(options: {
  manifest: RestoreManifest
  operationKey: string
  intentSha256: string
  identity: z.infer<typeof R2OperationArtifactSourceSchema>['completionIdentity']
}): RestoreCompletion {
  if (
    options.identity.workflow.repositoryId !==
      options.manifest.from.producer.repositoryId ||
    options.identity.workflow.repositoryId !==
      options.manifest.to.producer.repositoryId
  ) {
    throw new Error('restore completion repository differs from the registry producer')
  }
  const keys = restoreOperationKeys(options.operationKey)
  return RestoreCompletionSchema.parse({
    schemaVersion: 2,
    kind: 'restore-completion',
    operationKey: options.operationKey,
    mode: options.identity.mode,
    workflow: options.identity.workflow,
    authorizedManifestCanonicalSha256: sha256(
      canonicalJsonBytes(options.manifest)
    ),
    intentSha256: options.intentSha256,
    observed: {
      targetSha256: options.manifest.to.registry.sha256,
      targetEtag: options.identity.targetEtag,
      reverseRegistrySha256: options.manifest.from.registry.sha256,
      reverseRegistrySourceKey: keys.reverseRegistryPayloadKey,
      reverseRegistrySourceEtag: options.identity.reverseRegistrySourceEtag,
    },
    objects: keys,
  })
}

function buildRestoreCompletion(options: {
  manifest: RestoreManifest
  plan: RestorePlan
  observedTargetEtag: string
  reverseRegistrySourceEtag: string
  repositoryId: string
  workflowId: string
  runId: string
  runAttempt: string
  sourceSha: string
}): RestoreCompletion {
  return buildRestoreCompletionFromIdentity({
    manifest: options.manifest,
    operationKey: options.plan.operationKey,
    intentSha256: options.plan.intentSha256,
    identity: {
      mode: options.plan.mode,
      workflow: {
        repositoryId: options.repositoryId,
        workflowId: options.workflowId,
        workflowPath: '.github/workflows/restore.yml',
        runId: options.runId,
        runAttempt: options.runAttempt,
        sourceSha: options.sourceSha,
        event: 'workflow_dispatch',
      },
      targetEtag: options.observedTargetEtag,
      reverseRegistrySourceEtag: options.reverseRegistrySourceEtag,
    },
  })
}

export async function completeRestoreV2(options: {
  manifestPath: string
  planPath: string
  intentPath: string
  reverseRegistryPayloadPath: string
  reverseRegistryArtifactPath: string
  reverseWebsiteArtifactPath: string
  targetRegistryArtifactPath: string
  targetWebsiteArtifactPath: string
  authorizedManifestPath: string
  restoredRegistryPath: string
  observedTargetEtag: string
  reverseRegistrySourceEtag: string
  repositoryId: string
  workflowId: string
  runId: string
  runAttempt: string
  sourceSha: string
  existingCompletionPath?: string
  existingReverseManifestPath?: string
  completionOutputPath: string
  reverseManifestOutputPath: string
}): Promise<{ completion: RestoreCompletion; reverseManifest: RestoreManifest }> {
  await verifyRestoreOperationV2({
    manifestPath: options.manifestPath,
    planPath: options.planPath,
    intentPath: options.intentPath,
    reverseRegistryPayloadPath: options.reverseRegistryPayloadPath,
    reverseRegistryArtifactPath: options.reverseRegistryArtifactPath,
    reverseWebsiteArtifactPath: options.reverseWebsiteArtifactPath,
    targetRegistryArtifactPath: options.targetRegistryArtifactPath,
    targetWebsiteArtifactPath: options.targetWebsiteArtifactPath,
    authorizedManifestPath: options.authorizedManifestPath,
  })
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  const plan = RestorePlanSchema.parse(await readJson(options.planPath))
  const restored = await readRegistryV2(options.restoredRegistryPath)
  if (sha256(restored) !== manifest.to.registry.sha256) {
    throw new Error('completed restore bytes differ from the authorized target')
  }
  const reversePayload = await readRegistryV2(
    options.reverseRegistryPayloadPath
  )
  if (sha256(reversePayload) !== manifest.from.registry.sha256) {
    throw new Error('reverse registry source differs from the authorized from-state')
  }
  const observedTargetEtag = OpaqueEtagSchema.parse(options.observedTargetEtag)
  if (plan.mode === 'resume' && plan.currentEtag !== observedTargetEtag) {
    throw new Error('resume target ETag changed after restore verification')
  }
  const reverseRegistrySourceEtag = OpaqueEtagSchema.parse(
    options.reverseRegistrySourceEtag
  )
  let completion: RestoreCompletion
  let existingCompletionBytes: Buffer | undefined
  let existingReverseBytes: Buffer | undefined
  let existingReverse: RestoreManifest | undefined
  if (options.existingCompletionPath) {
    existingCompletionBytes = await readRegularFile(
      options.existingCompletionPath,
      'existing restore completion'
    )
    const parsed = RestoreCompletionSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(existingCompletionBytes)
      )
    )
    completion = buildRestoreCompletionFromIdentity({
      manifest,
      operationKey: plan.operationKey,
      intentSha256: plan.intentSha256,
      identity: completionIdentity(parsed),
    })
    if (!existingCompletionBytes.equals(canonicalJsonBytes(completion))) {
      throw new Error('existing restore completion is not canonical for this operation')
    }
  } else if (options.existingReverseManifestPath) {
    existingReverseBytes = await readRegularFile(
      options.existingReverseManifestPath,
      'existing reverse manifest'
    )
    existingReverse = RestoreManifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(existingReverseBytes)
      )
    )
    if (
      existingReverse.from.artifactSource.kind !== 'r2-operation' ||
      existingReverse.to.artifactSource.kind !== 'r2-operation'
    ) {
      throw new Error('existing reverse manifest has no parent completion identity')
    }
    completion = buildRestoreCompletionFromIdentity({
      manifest,
      operationKey: plan.operationKey,
      intentSha256: plan.intentSha256,
      identity: existingReverse.from.artifactSource.completionIdentity,
    })
    if (
      sha256(canonicalJsonBytes(completion)) !==
      existingReverse.from.artifactSource.completionSha256
    ) {
      throw new Error('existing reverse manifest completion identity hash mismatch')
    }
  } else {
    completion = buildRestoreCompletion({
      manifest,
      plan,
      observedTargetEtag,
      reverseRegistrySourceEtag,
      repositoryId: options.repositoryId,
      workflowId: options.workflowId,
      runId: options.runId,
      runAttempt: options.runAttempt,
      sourceSha: options.sourceSha,
    })
  }
  if (
    completion.observed.targetEtag !== observedTargetEtag ||
    completion.observed.reverseRegistrySourceEtag !==
      reverseRegistrySourceEtag
  ) {
    throw new Error('persisted completion identity differs from current immutable ETags')
  }
  const reverseManifest = createReverseRestoreManifest({
    manifest,
    operationKey: plan.operationKey,
    intentSha256: plan.intentSha256,
    completionSha256: sha256(canonicalJsonBytes(completion)),
    completionIdentity: completionIdentity(completion),
    observedTargetEtag,
    reverseRegistrySourceEtag: options.reverseRegistrySourceEtag,
  })
  if (options.existingReverseManifestPath) {
    if (!existingReverseBytes || !existingReverse) {
      existingReverseBytes = await readRegularFile(
        options.existingReverseManifestPath,
        'existing reverse manifest'
      )
      existingReverse = RestoreManifestSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(existingReverseBytes)
        )
      )
    }
    if (!existingReverseBytes.equals(canonicalJsonBytes(reverseManifest))) {
      throw new Error('existing reverse manifest differs from deterministic reconstruction')
    }
  }
  if (!options.existingCompletionPath) {
    await writeJsonAtomicExclusive(options.completionOutputPath, completion, true)
  }
  if (!options.existingReverseManifestPath) {
    await writeJsonAtomicExclusive(
      options.reverseManifestOutputPath,
      reverseManifest,
      true
    )
  }
  return { completion, reverseManifest }
}

export async function verifyRestoreCompletionV2(options: {
  manifestPath: string
  planPath: string
  intentPath: string
  reverseRegistryPayloadPath: string
  reverseRegistryArtifactPath: string
  reverseWebsiteArtifactPath: string
  targetRegistryArtifactPath: string
  targetWebsiteArtifactPath: string
  authorizedManifestPath: string
  completionPath: string
  reverseManifestPath: string
  restoredRegistryPath: string
  observedTargetEtag: string
  reverseRegistrySourceEtag: string
}): Promise<void> {
  await verifyRestoreOperationV2({
    manifestPath: options.manifestPath,
    planPath: options.planPath,
    intentPath: options.intentPath,
    reverseRegistryPayloadPath: options.reverseRegistryPayloadPath,
    reverseRegistryArtifactPath: options.reverseRegistryArtifactPath,
    reverseWebsiteArtifactPath: options.reverseWebsiteArtifactPath,
    targetRegistryArtifactPath: options.targetRegistryArtifactPath,
    targetWebsiteArtifactPath: options.targetWebsiteArtifactPath,
    authorizedManifestPath: options.authorizedManifestPath,
  })
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  const plan = RestorePlanSchema.parse(await readJson(options.planPath))
  const completionBytes = await readRegularFile(
    options.completionPath,
    'persisted restore completion'
  )
  const completion = RestoreCompletionSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(completionBytes))
  )
  const expectedCompletion = buildRestoreCompletionFromIdentity({
    manifest,
    operationKey: plan.operationKey,
    intentSha256: plan.intentSha256,
    identity: completionIdentity(completion),
  })
  if (
    !completionBytes.equals(canonicalJsonBytes(expectedCompletion)) ||
    completion.observed.targetEtag !==
      OpaqueEtagSchema.parse(options.observedTargetEtag) ||
    completion.observed.reverseRegistrySourceEtag !==
      OpaqueEtagSchema.parse(options.reverseRegistrySourceEtag)
  ) {
    throw new Error('persisted restore completion differs from the observed operation')
  }
  const reverseManifestBytes = await readRegularFile(
    options.reverseManifestPath,
    'persisted reverse manifest'
  )
  RestoreManifestSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(reverseManifestBytes)
    )
  )
  const expectedReverse = createReverseRestoreManifest({
    manifest,
    operationKey: plan.operationKey,
    intentSha256: plan.intentSha256,
    completionSha256: sha256(completionBytes),
    completionIdentity: {
      mode: completion.mode,
      workflow: completion.workflow,
      targetEtag: completion.observed.targetEtag,
      reverseRegistrySourceEtag:
        completion.observed.reverseRegistrySourceEtag,
    },
    observedTargetEtag: options.observedTargetEtag,
    reverseRegistrySourceEtag: options.reverseRegistrySourceEtag,
  })
  if (!reverseManifestBytes.equals(canonicalJsonBytes(expectedReverse))) {
    throw new Error('persisted reverse manifest differs from the completed operation')
  }
  await verifyRestoredV2({
    manifestPath: options.manifestPath,
    restoredRegistryPath: options.restoredRegistryPath,
    observedEtag: options.observedTargetEtag,
  })
}

export async function verifyRestoredV2(options: {
  manifestPath: string
  restoredRegistryPath: string
  observedEtag: string
}): Promise<void> {
  const manifest = RestoreManifestSchema.parse(await readJson(options.manifestPath))
  OpaqueEtagSchema.parse(options.observedEtag)
  const restored = await readRegistryV2(options.restoredRegistryPath)
  if (sha256(restored) !== manifest.to.registry.sha256) {
    throw new Error('restored registry is not the authorized registry-v2 target')
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const bytes = await readRegularFile(filePath, 'JSON input')
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(source)
}

async function writeManifest(filePath: string, manifest: unknown): Promise<void> {
  await writeJsonAtomicExclusive(filePath, manifest)
}

export async function runReleaseContractCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  if (command === 'candidate' && args.length === 7) {
    const [
      registryArtifactPath,
      outputPath,
      sourceSha,
      runId,
      artifactId,
      expectedArtifactId,
      expectedArtifactSha256,
    ] = args
    const manifest = await createRegistryCandidateManifest({
      registryArtifactPath: registryArtifactPath as string,
      sourceSha: sourceSha as string,
      runId: runId as string,
      artifactId: artifactId as string,
      expectedArtifactId: expectedArtifactId as string,
      expectedArtifactSha256: expectedArtifactSha256 as string,
    })
    await writeManifest(outputPath as string, manifest)
    return
  }
  if (command === 'website' && args.length === 5) {
    const [candidatePath, distDir, outputPath, sourceSha, buildRunId] = args
    const candidate = RegistryCandidateManifestSchema.parse(
      await readJson(candidatePath as string)
    )
    const manifest = await createWebsiteArtifactManifest({
      candidate,
      distDir: distDir as string,
      sourceSha: sourceSha as string,
      buildRunId: buildRunId as string,
    })
    await writeManifest(outputPath as string, manifest)
    return
  }
  if (command === 'verify-registry' && args.length === 4) {
    const [candidatePath, artifactPath, artifactId, extractionRoot] = args
    const candidate = RegistryCandidateManifestSchema.parse(
      await readJson(candidatePath as string)
    )
    const bundle = await verifyRegistryArtifactBundle({
      artifactPath: artifactPath as string,
      artifactId: artifactId as string,
      expectedArtifactId: candidate.registry.artifactId,
      expectedArtifactSha256: candidate.registry.artifactSha256,
      candidate,
    })
    await extractVerifiedRegistryArtifactBundle(
      bundle,
      extractionRoot as string
    )
    return
  }
  if (command === 'verify-promotion' && args.length === 10) {
    const [
      candidatePath,
      registryArtifactPath,
      registryArtifactId,
      websiteArtifactPath,
      websiteArtifactId,
      expectedWebsiteArtifactId,
      expectedWebsiteArtifactSha256,
      websiteSourceSha,
      websiteBuildRunId,
      extractionRoot,
    ] = args
    const bundle = await verifyPromotionBundle({
      candidate: RegistryCandidateManifestSchema.parse(
        await readJson(candidatePath as string)
      ),
      registryArtifactPath: registryArtifactPath as string,
      registryArtifactId: registryArtifactId as string,
      websiteArtifactPath: websiteArtifactPath as string,
      websiteArtifactId: websiteArtifactId as string,
      expectedWebsiteArtifactId: expectedWebsiteArtifactId as string,
      expectedWebsiteArtifactSha256:
        expectedWebsiteArtifactSha256 as string,
      websiteSourceSha: websiteSourceSha as string,
      websiteBuildRunId: websiteBuildRunId as string,
    })
    await extractVerifiedPromotionBundle(bundle, extractionRoot as string)
    return
  }
  if (command === 'release-intent-v2' && args.length === 23) {
    const [
      currentRegistryPath,
      previousEtag,
      backupRegistryPath,
      backupKey,
      backupEtag,
      candidateManifestPath,
      candidateFilename,
      candidateArtifactId,
      candidateArtifactSha256,
      registryArtifactPath,
      registryFilename,
      registryArtifactId,
      registryArtifactSha256,
      websiteArtifactPath,
      websiteFilename,
      websiteArtifactId,
      websiteArtifactSha256,
      websiteSourceSha,
      websiteBuildRunId,
      repository,
      producerRunId,
      operationId,
      outputPath,
    ] = args
    const intent = await createReleaseIntentV2({
      currentRegistryPath: currentRegistryPath as string,
      previousEtag: previousEtag as string,
      backupRegistryPath: backupRegistryPath as string,
      backupKey: backupKey as string,
      backupEtag: backupEtag as string,
      candidateManifestPath: candidateManifestPath as string,
      candidateFilename: candidateFilename as string,
      candidateArtifactId: candidateArtifactId as string,
      candidateArtifactSha256: candidateArtifactSha256 as string,
      registryArtifactPath: registryArtifactPath as string,
      registryFilename: registryFilename as string,
      registryArtifactId: registryArtifactId as string,
      registryArtifactSha256: registryArtifactSha256 as string,
      websiteArtifactPath: websiteArtifactPath as string,
      websiteFilename: websiteFilename as string,
      websiteArtifactId: websiteArtifactId as string,
      websiteArtifactSha256: websiteArtifactSha256 as string,
      websiteSourceSha: websiteSourceSha as string,
      websiteBuildRunId: websiteBuildRunId as string,
      repository: repository as string,
      producerRunId: producerRunId as string,
      operationId: operationId as string,
    })
    await writeManifest(outputPath as string, intent)
    return
  }
  if (command === 'validate-release-intent-v2' && args.length === 4) {
    const [intentPath, repository, producerRunId, operationId] = args
    validateReleaseIntentV2(
      await readJson(intentPath as string),
      repository as string,
      producerRunId as string,
      operationId as string
    )
    return
  }
  if (command === 'inspect-release-intent-v2' && args.length === 5) {
    const [intentPath, repository, producerRunId, operationId, outputPath] = args
    const inspection = inspectReleaseIntentV2(
      await readJson(intentPath as string),
      repository as string,
      producerRunId as string,
      operationId as string
    )
    await writeManifest(outputPath as string, inspection)
    return
  }
  if (command === 'verify-publish-intent-v2' && args.length === 12) {
    const [
      intentPath,
      intentArtifactId,
      intentArtifactSha256,
      currentRegistryPath,
      currentEtag,
      backupRegistryPath,
      backupEtag,
      candidateManifestPath,
      registryArtifactPath,
      websiteArtifactPath,
      extractionRoot,
      planOutputPath,
    ] = args
    const plan = await verifyPublishIntentV2({
      intentPath: intentPath as string,
      intentArtifactId: intentArtifactId as string,
      intentArtifactSha256: intentArtifactSha256 as string,
      currentRegistryPath: currentRegistryPath as string,
      currentEtag: currentEtag as string,
      backupRegistryPath: backupRegistryPath as string,
      backupEtag: backupEtag as string,
      candidateManifestPath: candidateManifestPath as string,
      registryArtifactPath: registryArtifactPath as string,
      websiteArtifactPath: websiteArtifactPath as string,
      extractionRoot: extractionRoot as string,
    })
    await writeManifest(planOutputPath as string, plan)
    return
  }
  if (command === 'complete-release-v2' && args.length === 14) {
    const [
      intentPath,
      intentArtifactId,
      intentArtifactSha256,
      liveSha256,
      liveEtag,
      transitionMode,
      completionRunId,
      completionRunAttempt,
      completionSourceSha,
      completionEvent,
      candidateManifestPath,
      registryArtifactPath,
      websiteArtifactPath,
      outputPath,
    ] = args
    const release = await completeReleaseV2({
      intentPath: intentPath as string,
      intentArtifactId: intentArtifactId as string,
      intentArtifactSha256: intentArtifactSha256 as string,
      liveSha256: liveSha256 as string,
      liveEtag: liveEtag as string,
      transitionMode: transitionMode as string,
      completionRunId: completionRunId as string,
      completionRunAttempt: completionRunAttempt as string,
      completionSourceSha: completionSourceSha as string,
      completionEvent: completionEvent as string,
      candidateManifestPath: candidateManifestPath as string,
      registryArtifactPath: registryArtifactPath as string,
      websiteArtifactPath: websiteArtifactPath as string,
    })
    await writeManifest(outputPath as string, release)
    return
  }
  if (command === 'validate-release-v2' && args.length === 1) {
    validateReleaseManifestV2(await readJson(args[0] as string))
    return
  }
  if (command === 'validate-restore-v2' && args.length === 1) {
    RestoreManifestSchema.parse(await readJson(args[0] as string))
    return
  }
  if (command === 'derive-restore-operation-v2' && args.length === 2) {
    await writeManifest(
      args[1] as string,
      deriveRestoreOperationV2(await readJson(args[0] as string))
    )
    return
  }
  if (command === 'canonicalize-restore-v2' && args.length === 2) {
    const manifest = RestoreManifestSchema.parse(await readJson(args[0] as string))
    await writeJsonAtomicExclusive(args[1] as string, manifest, true)
    return
  }
  if (command === 'verify-restore-v2' && args.length === 15) {
    const [
      manifestPath,
      currentRegistryPath,
      targetRegistrySourcePath,
      targetWebsiteArtifactPath,
      targetRegistryArtifactPath,
      fromWebsiteArtifactPath,
      fromRegistryArtifactPath,
      sourceProofRoot,
      existingIntentPath,
      currentEtag,
      targetSourceEtag,
      extractionRoot,
      planOutputPath,
      intentOutputPath,
      authorizedManifestOutputPath,
    ] = args
    await verifyRestoreV2({
      manifestPath: manifestPath as string,
      currentRegistryPath: currentRegistryPath as string,
      targetRegistrySourcePath: targetRegistrySourcePath as string,
      targetWebsiteArtifactPath: targetWebsiteArtifactPath as string,
      targetRegistryArtifactPath: targetRegistryArtifactPath as string,
      fromWebsiteArtifactPath: fromWebsiteArtifactPath as string,
      fromRegistryArtifactPath: fromRegistryArtifactPath as string,
      sourceProofRoot: sourceProofRoot as string,
      existingIntentPath:
        existingIntentPath === '-' ? undefined : (existingIntentPath as string),
      currentEtag: currentEtag as string,
      targetSourceEtag: targetSourceEtag as string,
      extractionRoot: extractionRoot as string,
      planOutputPath: planOutputPath as string,
      intentOutputPath: intentOutputPath as string,
      authorizedManifestOutputPath: authorizedManifestOutputPath as string,
    })
    return
  }
  if (command === 'verify-restore-self-v2' && args.length === 6) {
    await verifyRestoreSelfV2({
      manifestPath: args[0] as string,
      currentRegistryPath: args[1] as string,
      selfProofRoot: args[2] as string,
      currentEtag: args[3] as string,
      extractionRoot: args[4] as string,
      planOutputPath: args[5] as string,
    })
    return
  }
  if (
    command === 'verify-restore-operation-v2' &&
    (args.length === 9 ||
      (args.length === 10 && args[9] === '--allow-missing-for-cas'))
  ) {
    const optionalPath = (value: string | undefined): string | undefined =>
      value === '-' ? undefined : value
    await verifyRestoreOperationV2({
      manifestPath: args[0] as string,
      planPath: args[1] as string,
      intentPath: optionalPath(args[2]),
      reverseRegistryPayloadPath: optionalPath(args[3]),
      reverseRegistryArtifactPath: optionalPath(args[4]),
      reverseWebsiteArtifactPath: optionalPath(args[5]),
      targetRegistryArtifactPath: optionalPath(args[6]),
      targetWebsiteArtifactPath: optionalPath(args[7]),
      authorizedManifestPath: optionalPath(args[8]),
      allowMissingForCas: args[9] === '--allow-missing-for-cas',
    })
    return
  }
  if (command === 'verify-restored-v2' && args.length === 3) {
    await verifyRestoredV2({
      manifestPath: args[0] as string,
      restoredRegistryPath: args[1] as string,
      observedEtag: args[2] as string,
    })
    return
  }
  if (command === 'complete-restore-v2' && args.length === 21) {
    const optionalPath = (value: string | undefined): string | undefined =>
      value === '-' ? undefined : value
    await completeRestoreV2({
      manifestPath: args[0] as string,
      planPath: args[1] as string,
      intentPath: args[2] as string,
      reverseRegistryPayloadPath: args[3] as string,
      reverseRegistryArtifactPath: args[4] as string,
      reverseWebsiteArtifactPath: args[5] as string,
      targetRegistryArtifactPath: args[6] as string,
      targetWebsiteArtifactPath: args[7] as string,
      authorizedManifestPath: args[8] as string,
      restoredRegistryPath: args[9] as string,
      observedTargetEtag: args[10] as string,
      reverseRegistrySourceEtag: args[11] as string,
      repositoryId: args[12] as string,
      workflowId: args[13] as string,
      runId: args[14] as string,
      runAttempt: args[15] as string,
      sourceSha: args[16] as string,
      existingCompletionPath: optionalPath(args[17]),
      existingReverseManifestPath: optionalPath(args[18]),
      completionOutputPath: args[19] as string,
      reverseManifestOutputPath: args[20] as string,
    })
    return
  }
  if (command === 'verify-restore-completion-v2' && args.length === 14) {
    await verifyRestoreCompletionV2({
      manifestPath: args[0] as string,
      planPath: args[1] as string,
      intentPath: args[2] as string,
      reverseRegistryPayloadPath: args[3] as string,
      reverseRegistryArtifactPath: args[4] as string,
      reverseWebsiteArtifactPath: args[5] as string,
      targetRegistryArtifactPath: args[6] as string,
      targetWebsiteArtifactPath: args[7] as string,
      authorizedManifestPath: args[8] as string,
      completionPath: args[9] as string,
      reverseManifestPath: args[10] as string,
      restoredRegistryPath: args[11] as string,
      observedTargetEtag: args[12] as string,
      reverseRegistrySourceEtag: args[13] as string,
    })
    return
  }
  if (command === 'assert-current' && args.length === 2) {
    assertCandidateIsCurrent(args[0] as string, args[1] as string)
    return
  }
  if (command === 'hash-file' && args.length === 1) {
    console.log(await sha256File(args[0] as string))
    return
  }
  if (command === 'hash-dir' && args.length === 1) {
    console.log(await hashDirectory(args[0] as string))
    return
  }

  throw new Error(
    'usage: release-contract.ts ' +
      '<candidate|website|verify-registry|verify-promotion|release-intent-v2|' +
      'validate-release-intent-v2|inspect-release-intent-v2|' +
      'verify-publish-intent-v2|complete-release-v2|validate-release-v2|' +
      'validate-restore-v2|derive-restore-operation-v2|canonicalize-restore-v2|' +
      'verify-restore-v2|verify-restore-self-v2|verify-restore-operation-v2|' +
      'verify-restored-v2|complete-restore-v2|verify-restore-completion-v2|' +
      'assert-current|' +
      'hash-file|hash-dir> ...'
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runReleaseContractCli(process.argv.slice(2))
}
