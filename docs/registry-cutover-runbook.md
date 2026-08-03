# Registry v2 Cutover and Recovery Runbook

English | [简体中文](registry-cutover-runbook.zh-CN.md)

This runbook governs coordinated registry/website publishing and recovery.
Only `.github/workflows/publish.yml` and `.github/workflows/restore.yml` may
mutate production. Never upload R2 bytes or deploy the website manually.

## 1. Non-negotiable identifiers

- Public URL: `https://dl.motrix.app/registry/plugins.json`
- R2 bucket/key: `motrix-registry` / `plugins.json`
- Root protocol version: `2`
- Publisher output: `dist/plugins.json`
- App cache filename: `registry-cache.json`
- Protected GitHub environment: `plugin-publishing`
- Shared publish/restore concurrency group: `registry-production`

Do not introduce a second URL, key, filename, dual reader, or dual writer. Do
not hand-edit generated registry output.

## 2. Approval and trust roots

One coordinator owns an operation from no-write evidence through completion.
While there is one maintainer, configure that maintainer as the required
reviewer and leave **Prevent self-review** disabled. This is a deliberate
second-step operator confirmation, not independent review. Require a different
maintainer and enable **Prevent self-review** when one is available.

The production jobs use:

- exact raw GitHub artifact ids, names, digests, run metadata, and producer
  workflow metadata;
- bucket-scoped R2 read/write credentials;
- a minimum-permission Cloudflare website deploy token; and
- source and deploy code resolved from current `main` according to the rules
  below.

Configure repository variables `WEBSITE_REPOSITORY`, optional `WEBSITE_REF`,
and `CLOUDFLARE_ACCOUNT_ID`; repository-level read-only secrets
`WEBSITE_READ_TOKEN`, `R2_READ_ACCESS_KEY_ID`, and
`R2_READ_SECRET_ACCESS_KEY`; and environment-scoped write/deploy secrets
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and
`CLOUDFLARE_API_TOKEN`. The R2 read-only identity must have no write permission.

Historical source commits prove provenance only. Restore deployment is driven
by a separately frozen current-`main` website checkout; historical code never
receives current production credentials.

## 3. First registry-v2 cutover is forward-only

The bounded previous live bytes and their private backup are opaque CAS/backup
identity and forensic evidence only. The coordinator does not parse a legacy
root version, plugin array, or localized shape. Those bytes must never be
passed to `restore.yml`, parsed as a release tuple, paired with a legacy
website, or written back to `plugins.json`.

Restore becomes available only after a completed registry-v2 publish has retained
matching raw registry and website artifacts. Every later restore must move
between two complete, distinct registry-v2 release tuples. There is no compatibility
adapter and no exception for an incident.

## 4. Exact artifacts and publish journal

The registry raw artifact is one ZIP with exactly one regular root entry,
`plugins.json`. The website raw artifact is one ZIP with exactly one root
`website-artifact-manifest.json` plus regular files below `dist/`. Verification
checks raw archive SHA/id/name, complete EOCD and central/local agreement,
bounded expansion, safe unique paths, embedded payloads/manifests, and
registry/website tuple equality. Only a fresh safe extraction is deployable.

These version spaces are independent. The public registry root is `version: 2`;
the unchanged candidate and website artifact manifests remain
`schemaVersion: 1`; and release/restore journals remain internal
`schemaVersion: 2`. The internal v2 workflow contract was never activated in
production, so this clean break removes its draft pre-state classification without
creating an internal v3 or supporting old v2 records.

After approval, publish creates or reuses an immutable private backup and
uploads a canonical `ReleaseIntentSchema` v2 artifact before the first live
mutation. The intent binds:

- stable `operationId`;
- registry and website producer source/run identities;
- opaque previous registry SHA/ETag;
- immutable backup key/ETag;
- exact candidate manifest, registry ZIP, website ZIP, and embedded tuple.

The intent verifier has only two outcomes:

- `cas`: current SHA and ETag exactly equal the intent's previous identity;
- `resume`: current registry is valid registry v2 and its SHA exactly equals the
  candidate.

Every third state fails. A resume dispatch names the retained operation id and
redownloads the original journal-bound artifacts; it never substitutes retry
artifacts or reinterprets the current object.

The resulting `ReleaseManifestSchema` v2 binds the operation and intent
artifact, original registry/website producer tuple, completion run/attempt/
source/event and transition mode, previous/backup/result registry identities,
website artifact/tree identity, and candidate-manifest artifact. It is the
inner completion manifest later authenticated by a restore tuple's separate
raw-artifact and manifest-content digests.

## 5. Forward publish procedure

1. Confirm all three repositories' fixture/conformance parity and required
   local gates.
2. Start `publish.yml` from registry `main`. Its event SHA and selected website
   `main` SHA must be current.
3. Build the registry candidate once. Do not aggregate downstream.
4. Verify the raw registry artifact, build the website from only its fresh
   extraction over loopback, and upload the indivisible website ZIP.
5. Before approval, redownload both raw artifacts by id, verify provenance,
   bytes, layouts, manifests, dist tree, source currency, and the prebuilt
   deployment dry-run.
6. Review the evidence and approve `plugin-publishing`.
7. Repeat the complete no-write verification after approval. Refuse any
   in-band asset publication; assets have a separate protocol.
8. Read current R2 bytes/ETag, create or verify the immutable backup, create
   the stable operation id, and retain the canonical publish intent.
9. Redownload and verify the intent and its original raw artifacts. Classify
   strict `cas` or `resume`, then freeze current source refs.
10. Deploy the intent-bound, prebuilt website without rebuilding.
11. Re-read the intent, artifacts, current object, and backup. In `cas`, put
    the exact candidate with `If-Match`; in `resume`, perform no PutObject.
12. Verify the direct R2 SHA/ETag and cache-busted public SHA/ETag.
13. Retain a strict `ReleaseManifestSchema` v2 completion record. If R2 moved
    successfully but the public probe failed, retain the completion record and
    resume the same operation; never start a different publish to hide the
    partial state.

## 6. RestoreManifest v2

`scripts/release-contract.ts` strictly rejects unknown fields. Both
`ReleaseManifest` and `RestoreManifest` use `schemaVersion: 2`. The restore
shape is:

```ts
interface RestoreManifestV2 {
  schemaVersion: 2
  from: RestoreTuple & {
    registry: RestoreRegistry & { etag: string }
  }
  to: RestoreTuple & {
    registry: RestoreRegistry & {
      sourceKey: string
      sourceEtag: string
    }
  }
}

interface RestoreTuple {
  producer: RestoreProducer
  candidateManifestArtifact: RestoreCandidateManifestArtifact
  registry: RestoreRegistry
  website: RestoreWebsite
  completion: RestoreReleaseCompletion
  artifactSource: { kind: 'github' } | R2OperationArtifactSource
}

interface RestoreProducer {
  repositoryId: string
  workflowId: string
  workflowPath: '.github/workflows/publish.yml'
  sourceSha: string
  event: 'push' | 'workflow_dispatch'
}

interface RestoreCandidateManifestArtifact {
  artifactId: string
  artifactName: string
  artifactSha256: string
  workflowRunId: string
}

interface RestoreRegistry {
  sha256: string
  bytes: number
  artifactId: string
  artifactName: string
  artifactSha256: string
  workflowRunId: string
}

interface RestoreWebsite {
  artifactId: string
  artifactName: string
  artifactSha256: string
  runId: string
  sourceRepository: string
  sourceSha: string
  distSha256: string
  registrySha256: string
  registryArtifactSha256: string
  registryWorkflowRunId: string
  registryArtifactId: string
}

interface RestoreReleaseCompletion {
  artifactId: string
  artifactName: string
  artifactSha256: string // raw completion artifact digest
  manifestSha256: string // inner ReleaseManifest v2 content digest
  runId: string
  runAttempt: string
  sourceSha: string
  event: 'push' | 'workflow_dispatch'
}

interface RestoreWorkflowIdentity {
  repositoryId: string
  workflowId: string
  workflowPath: '.github/workflows/restore.yml'
  runId: string
  runAttempt: string
  sourceSha: string
  event: 'workflow_dispatch'
}

interface R2OperationArtifactSource {
  kind: 'r2-operation'
  parentOperationKey: string
  intentKey: string
  intentSha256: string
  completionKey: string
  completionSha256: string
  reverseManifestKey: string
  completionIdentity: {
    mode: 'cas' | 'resume'
    workflow: RestoreWorkflowIdentity
    targetEtag: string
    reverseRegistrySourceEtag: string
  }
  registryArtifactKey: string
  websiteArtifactKey: string
}
```

Both website embedded registry tuples must equal their sibling registry tuple.
Candidate, registry, website, and completion artifacts are all distinct; the
candidate/registry/website tuple is bound to its raw producer run, while the
successful completion run structurally binds that original tuple and may be a
different recovery run. The `from` and `to` registry SHAs must differ and both
producer repository ids must match. `from.registry.etag` is the authorized
pre-state. `to.registry.sourceKey/sourceEtag` identifies an immutable private
source object whose bytes must equal `to.registry.sha256` and the payload in the
target registry ZIP. The source key is restricted to a
`private/backups/plugins/**/*.json` object or the exact generated
`restore-operations/v2/<operationKey>/reverse/plugins.json` object.

Both sides must select one artifact-source generation. A GitHub generation
uses the successful completion-manifest run to bind the original raw artifacts;
the wrapper's `artifactSha256` authenticates the raw downloaded completion
artifact while `manifestSha256` authenticates the inner `ReleaseManifest` v2
bytes. Do not substitute one digest for the other. An R2 generation requires
both sides to name one direct parent operation, its canonical intent and
completion digests, the exact reverse manifest key, one matching
reverse-or-target registry/website pair, and the complete restore workflow
identity plus observed target/source ETags in `completionIdentity`. Sources may
not be mixed or inferred from paths.

There is intentionally no `restoreEtag`. An ETag is an opaque identity of an
observed object version. A new PutObject result cannot be predicted from an
ETag recorded when equivalent bytes were live previously.

## 7. Prepare and dry-run a restore

1. Select a completed registry-v2 release as `from` and a different completed
   registry-v2 release as `to`.
2. Copy both complete release tuples from retained completion records. Include
   the candidate-manifest artifact, raw registry/website artifacts, outer and
   inner completion digests, producer identities, and one explicit artifact
   source. Never assemble a tuple from unrelated runs or source generations.
3. Set `from.registry.etag` to the exact currently authorized R2 ETag.
4. Set `to.registry.sourceKey/sourceEtag` to the immutable private target
   payload. Confirm it is not the opaque pre-registry-v2 forensic backup.
5. Validate the JSON locally:

```bash
pnpm exec tsx scripts/release-contract.ts validate-restore-v2 \
  restore-manifest.json
```

6. Run the release-contract test suite before dispatch:

```bash
pnpm exec vitest run tests/release-contract.test.ts
```

For a fully materialized local evidence set, create `SOURCE_PROOF_ROOT` first.
For a GitHub source it has strict `from/` and `to/` proof directories containing
the raw producer metadata, candidate/registry/website artifact metadata, and
completion run/workflow/artifact plus inner release manifest. For an R2 source
it contains exactly the direct parent's `intent.json`, `completion.json`, and
`reverse-manifest.json`. The strict verifier argument order is:

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-v2 \
  restore-manifest.json current-plugins.json target-source-plugins.json \
  to-website.zip to-registry.zip from-website.zip from-registry.zip \
  SOURCE_PROOF_ROOT EXISTING_INTENT_OR_DASH \
  CURRENT_ETAG TARGET_SOURCE_ETAG /absolute/new-extraction-root \
  restore-plan.json restore-intent.json authorized-manifest.json
```

Every output path must be new. To verify persisted operation records, use:

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-operation-v2 \
  restore-manifest.json restore-plan.json intent.json reverse-plugins.json \
  reverse-registry.zip reverse-website.zip target-registry.zip \
  target-website.zip authorized-manifest.json
```

Only a pre-mutation `cas` inspection may replace any absent initial-record path
with `-` and append `--allow-missing-for-cas`. Every path that is present is
still verified strictly. After missing records have been filled and read back,
and for every `resume`, all seven paths are mandatory.

7. Dispatch `restore.yml` from current registry `main` with `dry_run: true` and
   the exact JSON. The dry-run may use read-only R2 and GitHub artifact access;
   it receives no R2 write or website deploy credential.

The no-write job verifies either both GitHub completion-attested tuples or one
complete direct-parent R2 proof, downloads all four raw ZIPs, validates both
registry-v2 payloads and website bundles, proves target source bytes, safely
extracts both websites, classifies `cas`/`resume`, and computes the
deterministic operation plan, intent, and canonical authorized manifest. It
also runs target and reverse prebuilt deployment dry-runs from the frozen
current-`main` driver. Synthetic ids are local test evidence only; `dry_run`
does not create a machine-verifiable attestation consumed by a later actual
dispatch, so the actual dispatch repeats the full preflight.

## 8. Immutable restore operation records

Before the approved restore changes either service, it derives
`operationKey = sha256(canonical from/to tuples)` and persists these private R2
objects under `restore-operations/v2/<operationKey>/`:

- `intent.json` — canonical `RestoreIntentSchema` v2;
- `authorized-manifest.json` — canonical reviewed `RestoreManifest` v2;
- `reverse/plugins.json` — exact outgoing registry-v2 payload;
- `reverse/registry.zip` and `reverse/website.zip` — outgoing raw artifacts;
- `target/registry.zip` and `target/website.zip` — target raw artifacts;
- `completion.json` — canonical `RestoreCompletionSchema` v2, created only
  after the target ETag and reverse-source ETag are observed; and
- `reverse/restore-manifest.json` — deterministic swapped manifest derived from
  the direct-parent intent and completion.

The first seven records are individually written with create-only semantics.
This is intentionally crash-tolerant: a pre-write `cas` probe accepts any
subset, verifies every existing object strictly, fills only missing keys, then
requires a complete readback before the website is deployed. A `resume` always
requires the complete initial set and never replaces it.

`RestoreCompletion` binds the operation key/mode, complete restore workflow
tuple, canonical authorized-manifest and intent digests, observed target and
reverse-source identities, and every derived object key. Completion and reverse
manifest are also create-only. If a crash leaves exactly one of the pair, the
retry reconstructs the missing object deterministically and verifies both. The
reverse manifest contains no self hash: its R2 descriptors bind the direct
parent's intent digest, completion digest and identity, and exact raw artifact
keys. This avoids a hash cycle while making continuation and reverse recovery
independent of GitHub artifact retention.

## 9. Approved restore procedure

1. Dispatch `restore.yml` from current registry `main` with `dry_run: false`
   and the reviewed v2 manifest.
2. Review the frozen current-`main` registry and website driver identities,
   no-write tuple evidence, and state classification; approve
   `plugin-publishing`.
3. Re-fetch and verify both directions' producer metadata and all four raw
   artifacts. Read current and target-source R2 objects.
4. Require exactly `cas` or `resume`; derive the same operation key/intent.
5. In `cas`, strictly accept any valid partial initial journal, create only its
   missing records, then require all seven on readback. In `resume`, require the
   full initial journal. Re-fetch and verify every byte in both modes.
6. From the frozen current-`main` website driver, dry-run and then deploy only
   the verified `to` prebuilt extraction. Historical source is not executable.
7. After deployment, re-read only the live `plugins.json` object and its ETag.
   Build the strict self-proof from the seven persisted files that step 5 just
   read back, run `verify-restore-self-v2`, and compare the pre/post plan and
   operation identity. They must not change; this step does not claim another
   R2 fetch of the target source or operation records.
8. In `cas`, write the exact target bytes to `plugins.json` with
   `If-Match(from.registry.etag)`. In `resume`, perform no registry write.
9. Observe the resulting R2 ETag and verify the exact registry-v2 target through a
   direct R2 read.
10. Canonically create and read back `completion.json` and the deterministic
    reverse manifest. Verify them against the direct R2 bytes, exact observed
    ETags, workflow tuple, intent, and authorized manifest. At this point the
    durable recovery chain is retained.
11. Only then run the cache-busted public probe with bounded connect/total
    timeouts and retries. Require the target SHA and a non-empty HTTP ETag. If
    public convergence fails, keep the already verified completion/reverse
    records and rerun this exact manifest; never start a replacement operation.
    Retain evidence including mode, workflow tuple, manifest/intent/completion
    SHAs, object keys, artifact SHAs, deployment outcome, direct/public outcome,
    and reverse seed.

The direct-object verifier is:

```bash
pnpm exec tsx scripts/release-contract.ts verify-restored-v2 \
  restore-manifest.json restored-r2-plugins.json OBSERVED_R2_ETAG
```

After both post-transition records exist, verify the complete journal with:

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-completion-v2 \
  restore-manifest.json restore-plan.json intent.json reverse-plugins.json \
  reverse-registry.zip reverse-website.zip target-registry.zip \
  target-website.zip authorized-manifest.json completion.json \
  reverse-restore-manifest.json restored-r2-plugins.json \
  OBSERVED_TARGET_ETAG REVERSE_SOURCE_ETAG
```

## 10. Reverse recovery requires new approval

The execution evidence can mark a reverse seed executable only after initial
record readback, website deployment, post-deploy verification, registry
transition, and completion/reverse readback. The seed swaps complete `from` and
`to` tuples, uses only persisted private artifact/source keys, and replaces the
new `from.registry.etag` with the ETag actually observed after the transition.
It is rebuilt from the direct-parent intent and completion; the stored reverse
manifest is checked against that reconstruction rather than authenticating
itself.

It is not an automatic rollback. Materialize and review a new v2 manifest,
start a new current-`main` `restore.yml` dispatch, run the read-only preflight,
and obtain a new `plugin-publishing` approval. Never reuse the previous
approval or reverse registry bytes alone.

## 11. Partial-state handling

Website deployment, private R2 records, and the public registry CAS cannot be
one atomic transaction. Treat these states explicitly:

- **Before intent/operation records:** production is unchanged; start a new
  operation after fixing evidence.
- **Any subset of the seven initial records, no website deploy:** rerun the
  exact manifest in `cas`; verify every existing object, create only missing
  objects, then require a complete readback.
- **All initial records persisted, no website deploy:** rerun the exact
  manifest and read back the same records.
- **Website deployed, registry still `from`:** rerun the exact operation. It
  must reverify and finish forward; do not start an unrelated release.
- **Registry already `to`:** only `resume` is legal. Reverify records, website,
  direct R2, and public evidence without another PutObject.
- **Only completion or only reverse manifest exists:** reconstruct the missing
  member from the direct-parent operation, require byte-identical canonical
  output, then read back and verify both.
- **Any third registry state, altered existing record, or missing initial record
  in `resume`:** fail closed and escalate. Do not weaken checks or manually copy
  bytes.
- **Public probe did not converge after direct R2 and completion/reverse
  readback succeeded:** the durable completion already exists. Preserve all
  evidence and rerun the same operation.

Never delete forensic backups, completed release artifacts, or private
operation records while an incident or retention window is open.

## 12. Separate App operator record

Keep App compatibility guidance outside machine manifests:

```yaml
appSourceSha: <40-hex commit>
blockingEvidenceId: <CI run id or local-only:test-label>
localBuildLabel: <optional human label>
```

This is not binary attestation and never gates registry/website writes. Start
the recorded compatible App only after remote coordination succeeds. If App
distribution is introduced, replace this record with required App artifact
id, SHA-256, and workflow-run attestation.

## 13. Evidence checklist

- [ ] Exact registry and website current-`main` driver SHAs
- [ ] Both release tuples' producer run/workflow API evidence
- [ ] All raw artifact ids, names, SHA-256 values, and embedded hashes
- [ ] Pre-approval and post-approval no-write logs
- [ ] Publish intent or restore operation key and canonical intent SHA
- [ ] Previous/current/target source SHA and observed ETags
- [ ] Immutable backup and all restore-operation readback evidence
- [ ] Prebuilt-only website dry-run/deployment outcome
- [ ] Direct R2 verification
- [ ] Strict completion/reverse readback and execution evidence artifact
- [ ] Cache-busted public verification after completion readback
- [ ] Reverse seed requiring a new approval
- [ ] Separate non-attesting App compatibility record
- [ ] Before formal release only: exact Electron/browser ICU/CLDR resolver-
      corpus evidence for `Intl.Locale.maximize()`
- [ ] Manual language/search/install/update smoke results
