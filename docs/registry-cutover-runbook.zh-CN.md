# Registry v2 切换与恢复 Runbook

[English](registry-cutover-runbook.md) | 简体中文

本 runbook 管理 registry/website 的协调发布与恢复。只有
`.github/workflows/publish.yml` 和 `.github/workflows/restore.yml` 可以修改
production。绝不能手工上传 R2 bytes 或部署 website。

## 1. 不可变标识

- 公开 URL：`https://dl.motrix.app/registry/plugins.json`
- R2 bucket/key：`motrix-registry` / `plugins.json`
- Root protocol version：`2`
- Publisher 输出：`dist/plugins.json`
- App cache 文件名：`registry-cache.json`
- 受保护 GitHub environment：`plugin-publishing`
- Publish/restore 共用 concurrency group：`registry-production`

不得引入第二个 URL、key、文件名、dual reader 或 dual writer。不得手工编辑生成的
registry 输出。

## 2. 审批与 trust root

一个 coordinator 从 no-write evidence 到 completion 全程负责同一个 operation。
仓库只有一位 maintainer 时，把该 maintainer 配置为 required reviewer，并保持
**Prevent self-review** 关闭。这是有意识的二次 operator confirmation，不是独立
review。一旦有第二位 maintainer，就要求另一位 maintainer 审批并开启
**Prevent self-review**。

Production job 使用：

- 精确 raw GitHub artifact id、name、digest、run metadata 与 producer workflow
  metadata；
- 限定 bucket 的 R2 read/write credential；
- 最小权限的 Cloudflare website deploy token；
- 按下述规则从 current `main` 解析的 source 与 deploy code。

配置 repository variable `WEBSITE_REPOSITORY`、可选 `WEBSITE_REF` 与
`CLOUDFLARE_ACCOUNT_ID`；repository-level read-only secret
`WEBSITE_READ_TOKEN`、`R2_READ_ACCESS_KEY_ID` 与
`R2_READ_SECRET_ACCESS_KEY`；以及 environment-scoped write/deploy secret
`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CLOUDFLARE_ACCOUNT_ID` 与
`CLOUDFLARE_API_TOKEN`。R2 read-only identity 绝不能有 write permission。

Historical source commit 只证明 provenance。Restore deployment 由另行冻结的
current-`main` website checkout 驱动；historical code 绝不能接触当前 production
credential。

## 3. 第一次 registry-v2 cutover 只能向前

Bounded previous live bytes 与其 private backup 仅作为 opaque CAS/backup
identity 与 forensic evidence。Coordinator 不解析 legacy root version、plugin array 或
localized shape。不得把这些 bytes 交给 `restore.yml`、解析为 release tuple、
与 legacy website 配对，或重新写回 `plugins.json`。

只有 completed registry-v2 publish 保留 matching raw registry/website artifact 后，
才启用 restore。后续每次 restore 都必须在两个完整、互不相同的 registry-v2 release
tuple 之间移动。没有 compatibility adapter，incident 也不能例外。

## 4. 精确 artifact 与 publish journal

Registry raw artifact 是单个 ZIP，根目录精确只有一个 regular `plugins.json`。
Website raw artifact 是单个 ZIP，根目录精确只有一个
`website-artifact-manifest.json`，其余 regular file 都在 `dist/` 下。Verification
检查 raw archive SHA/id/name、完整 EOCD 与 central/local 一致性、bounded expansion、
安全且唯一的 path、embedded payload/manifest，以及 registry/website tuple equality。
只有 fresh safe extraction 可以部署。

这些 version space 彼此独立。公开 registry root 为 `version: 2`；未改 shape 的
candidate/website artifact manifest 保持 `schemaVersion: 1`；release/restore journal
保持内部 `schemaVersion: 2`。该内部 v2 workflow contract 从未在 production
激活，因此本次 clean break 直接删除 draft pre-state classification，不创建
内部 v3，也不支持旧 v2 record。

Approval 后，publish 创建或复用 immutable private backup，并在第一次 live mutation
前上传 canonical `ReleaseIntentSchema` v2 artifact。Intent 绑定：

- stable `operationId`；
- registry/website producer source 与 run identity；
- opaque previous registry SHA/ETag；
- immutable backup key/ETag；
- 精确 candidate manifest、registry ZIP、website ZIP 与 embedded tuple。

Intent verifier 只有两种结果：

- `cas`：current SHA 与 ETag 精确等于 intent previous identity；
- `resume`：current registry 是合法 registry v2，且 SHA 精确等于 candidate。

任何第三状态都失败。Resume dispatch 指定 retained operation id，并重新下载原始
journal-bound artifact；不得替换 retry artifact，也不得重新解释 current object。

最终 `ReleaseManifestSchema` v2 绑定 operation/intent artifact、原 registry/website
producer tuple、completion run/attempt/source/event 与 transition mode、
previous/backup/result registry identity、website artifact/tree identity，以及
candidate-manifest artifact。它是后续 restore tuple 使用独立 raw-artifact digest 与
manifest-content digest 认证的内层 completion manifest。

## 5. Forward publish 流程

1. 确认三个仓库的 fixture/conformance parity 与 required local gate。
2. 从 registry `main` 启动 `publish.yml`。Event SHA 与选中的 website `main` SHA
   必须 current。
3. Registry candidate 只 build 一次；downstream 不得重新 aggregate。
4. 验证 raw registry artifact，只从 fresh extraction 通过 loopback build website，
   并上传不可拆分的 website ZIP。
5. Approval 前按 id 重新下载两个 raw artifact，校验 provenance、bytes、layout、
   manifest、dist tree、source currency 与 prebuilt deployment dry-run。
6. Review evidence 并审批 `plugin-publishing`。
7. Approval 后完整重复 no-write verification。拒绝 in-band asset publication；assets
   使用独立 protocol。
8. 读取 current R2 bytes/ETag，创建或验证 immutable backup，创建 stable operation
   id，并保留 canonical publish intent。
9. 重新下载并验证 intent 与其原始 raw artifact。分类 strict `cas`/`resume`，然后
   冻结 current source ref。
10. 不 rebuild 地部署 intent-bound prebuilt website。
11. 重新读取 intent、artifact、current object 与 backup。`cas` 使用 `If-Match`
    写入精确 candidate；`resume` 不执行 PutObject。
12. 验证 direct R2 SHA/ETag 与 cache-busted public SHA/ETag。
13. 保留 strict `ReleaseManifestSchema` v2 completion record。若 R2 已成功 transition
    但 public probe 失败，保留 completion record 并 resume 相同 operation；不得启动
    另一 publish 掩盖 partial state。

## 6. RestoreManifest v2

`scripts/release-contract.ts` 会严格拒绝 unknown field。`ReleaseManifest` 与
`RestoreManifest` 都使用 `schemaVersion: 2`。Restore 的精确 shape 为：

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

两侧 website embedded registry tuple 都必须等于同侧 registry tuple。Candidate、
registry、website 与 completion artifact 必须相互独立；candidate/registry/website
tuple 绑定其 raw producer run，而 successful completion run 以结构化方式绑定该原始
tuple，且可以是另一个 recovery run。`from`/`to` registry SHA 必须不同，且双方
producer repository id 必须一致。
`from.registry.etag` 是 authorized pre-state。
`to.registry.sourceKey/sourceEtag` 标识 immutable private source object；其 bytes
必须同时等于 `to.registry.sha256` 与 target registry ZIP 的 payload。Source key
只允许 `private/backups/plugins/**/*.json` object，或精确生成的
`restore-operations/v2/<operationKey>/reverse/plugins.json` object。

双方必须选择同一种 artifact-source generation。GitHub generation 通过 successful
completion-manifest run 绑定原始 raw artifact；wrapper 的 `artifactSha256` 认证下载的
raw completion artifact，`manifestSha256` 则认证内层 `ReleaseManifest` v2 bytes，
二者不得混用。R2 generation 要求双方指向同一个 direct parent operation、其 canonical
intent/completion digest、精确 reverse manifest key、匹配的 reverse 或 target
registry/website pair，以及 `completionIdentity` 中完整 restore workflow identity 与
observed target/source ETag。不得混合来源，也不得从 path 猜测来源。

协议刻意没有 `restoreEtag`。ETag 是 observed object version 的 opaque identity。
不能根据同样 bytes 上次 live 时的 ETag 预测新 PutObject result。

## 7. 准备与 dry-run restore

1. 选择一个 completed registry-v2 release 作为 `from`，另一个不同的 completed
   registry-v2 release 作为 `to`。
2. 从 retained completion record 复制双方完整 release tuple，包括 candidate-manifest
   artifact、raw registry/website artifact、completion 外层与内层 digest、producer
   identity，以及一个显式 artifact source。不得拼接不同 run 或 source generation。
3. 把 `from.registry.etag` 设为精确 authorized current R2 ETag。
4. 把 `to.registry.sourceKey/sourceEtag` 设为 immutable private target payload，
   并确认它不是 opaque pre-registry-v2 forensic backup。
5. 本地校验 JSON：

```bash
pnpm exec tsx scripts/release-contract.ts validate-restore-v2 \
  restore-manifest.json
```

6. Dispatch 前运行 release-contract test suite：

```bash
pnpm exec vitest run tests/release-contract.test.ts
```

对于完全 materialized 的 local evidence set，先创建 `SOURCE_PROOF_ROOT`。GitHub source
必须包含 strict `from/` 与 `to/` proof directory，其中保存 raw producer metadata、
candidate/registry/website artifact metadata，以及 completion run/workflow/artifact 与
内层 release manifest。R2 source 则精确包含 direct parent 的 `intent.json`、
`completion.json` 与 `reverse-manifest.json`。Strict verifier 参数顺序为：

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-v2 \
  restore-manifest.json current-plugins.json target-source-plugins.json \
  to-website.zip to-registry.zip from-website.zip from-registry.zip \
  SOURCE_PROOF_ROOT EXISTING_INTENT_OR_DASH \
  CURRENT_ETAG TARGET_SOURCE_ETAG /absolute/new-extraction-root \
  restore-plan.json restore-intent.json authorized-manifest.json
```

每个 output path 都必须是新路径。使用以下命令验证 persisted operation record：

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-operation-v2 \
  restore-manifest.json restore-plan.json intent.json reverse-plugins.json \
  reverse-registry.zip reverse-website.zip target-registry.zip \
  target-website.zip authorized-manifest.json
```

只有 pre-mutation `cas` inspection 可以把任意不存在的 initial-record path 替换为
`-`，并追加 `--allow-missing-for-cas`。所有已存在 path 仍必须严格验证。补齐并 readback
后，以及所有 `resume` 中，七个 path 都是必需的。

7. 从 current registry `main` dispatch `restore.yml`，使用 `dry_run: true` 与精确
   JSON。Dry-run 只允许 read-only R2 与 GitHub artifact access；不得获得 R2 write 或
   website deploy credential。

No-write job 要么校验双方 GitHub completion-attested tuple，要么校验一个完整的
direct-parent R2 proof；随后下载四个 raw ZIP，校验两个 registry-v2 payload 与 website
bundle，证明 target source bytes，安全解压双侧 website，分类 `cas`/`resume`，并计算
deterministic operation plan、intent 与 canonical authorized manifest。它还从冻结的
current-`main` driver 运行 target/reverse prebuilt deployment dry-run。Synthetic id
只属于 local test evidence；`dry_run` 不会生成供后续 actual dispatch 消费的机器可验证
attestation，因此 actual dispatch 必须完整重复 preflight。

## 8. Immutable restore operation record

Approved restore 修改任一服务前，派生
`operationKey = sha256(canonical from/to tuples)`，并在
`restore-operations/v2/<operationKey>/` 下持久化以下 private R2 object：

- `intent.json` — canonical `RestoreIntentSchema` v2；
- `authorized-manifest.json` — canonical reviewed `RestoreManifest` v2；
- `reverse/plugins.json` — 精确 outgoing registry-v2 payload；
- `reverse/registry.zip` 与 `reverse/website.zip` — outgoing raw artifact；
- `target/registry.zip` 与 `target/website.zip` — target raw artifact；
- `completion.json` — canonical `RestoreCompletionSchema` v2，只能在观测到 target
  ETag 与 reverse-source ETag 后创建；
- `reverse/restore-manifest.json` — 从 direct-parent intent 与 completion
  deterministic 派生的 swapped manifest。

前七个 initial record 分别使用 create-only semantics 写入。该流程刻意容忍 crash：
pre-write `cas` probe 接受任意 subset，严格校验每个已存在 object，只补齐 missing key，
随后在 website deploy 前要求完整 readback。`resume` 始终要求 initial set 完整，并且
绝不替换它。

`RestoreCompletion` 绑定 operation key/mode、完整 restore workflow tuple、canonical
authorized-manifest 与 intent digest、observed target/reverse-source identity，以及每个
derived object key。Completion 与 reverse manifest 同样 create-only。若 crash 只留下
其中一个，retry 必须 deterministic 重建缺失 object 并验证两者。Reverse manifest 不
包含 self hash；它的 R2 descriptor 绑定 direct parent 的 intent digest、completion
digest/identity 与精确 raw artifact key。这样既避免 hash cycle，也使 continuation 与
reverse recovery 不依赖 GitHub artifact retention。

## 9. 经审批的 restore 流程

1. 从 current registry `main` dispatch `restore.yml`，设置 `dry_run: false` 并传入
   reviewed v2 manifest。
2. Review 冻结的 current-`main` registry/website driver identity、no-write tuple
   evidence 与 state classification；审批 `plugin-publishing`。
3. 重新获取并验证双方向 producer metadata 与四个 raw artifact；读取 current 与
   target-source R2 object。
4. 只接受 `cas`/`resume`，并派生相同 operation key/intent。
5. `cas` 严格接受任何合法 partial initial journal，只创建 missing record，随后要求
   七个 record 全部 readback；`resume` 要求完整 initial journal。两种模式都必须再次
   获取并逐字节验证全部 record。
6. 从冻结的 current-`main` website driver 先 dry-run，再仅部署 verified `to`
   prebuilt extraction。Historical source 不可执行。
7. Website deployment 后，只重新读取 live `plugins.json` object 及其 ETag。使用
   step 5 刚刚 strict readback 的七个 persisted file 构造 self-proof，运行
   `verify-restore-self-v2`，并比较 pre/post plan 与 operation identity；二者不得变化。
   本 step 不宣称再次从 R2 获取 target source 或 operation record。
8. `cas` 使用 `If-Match(from.registry.etag)` 把精确 target bytes 写入
   `plugins.json`；`resume` 不执行 registry write。
9. 观测 result R2 ETag，并通过 direct R2 read 验证精确 registry-v2 target。
10. Canonically 创建并 readback `completion.json` 与 deterministic reverse manifest。
    使用 direct R2 bytes、精确 observed ETag、workflow tuple、intent 与 authorized
    manifest 验证二者。此时 durable recovery chain 已保留。
11. 之后才运行带 bounded connect/total timeout 与 retry 的 cache-busted public probe。
    要求 target SHA 与非空 HTTP ETag。若 public convergence 失败，保留已经验证的
    completion/reverse record，并重跑精确相同 manifest；不得启动 replacement operation。
    保留包含 mode、workflow tuple、manifest/intent/completion SHA、object key、artifact
    SHA、deployment outcome、direct/public outcome 与 reverse seed 的 evidence。

Direct-object verifier 为：

```bash
pnpm exec tsx scripts/release-contract.ts verify-restored-v2 \
  restore-manifest.json restored-r2-plugins.json OBSERVED_R2_ETAG
```

两个 post-transition record 都存在后，使用以下命令验证完整 journal：

```bash
pnpm exec tsx scripts/release-contract.ts verify-restore-completion-v2 \
  restore-manifest.json restore-plan.json intent.json reverse-plugins.json \
  reverse-registry.zip reverse-website.zip target-registry.zip \
  target-website.zip authorized-manifest.json completion.json \
  reverse-restore-manifest.json restored-r2-plugins.json \
  OBSERVED_TARGET_ETAG REVERSE_SOURCE_ETAG
```

## 10. Reverse recovery 必须重新审批

只有 initial record readback、website deployment、post-deploy verification、registry
transition，以及 completion/reverse readback 都完成后，execution evidence 才能把
reverse seed 标为 executable。Seed 交换完整 `from`/`to` tuple，只使用 persisted
private artifact/source key，并把新 `from.registry.etag` 替换为 transition 后实际观测
的 ETag。它从 direct-parent intent 与 completion 重建；stored reverse manifest 必须
与重建结果比较，不能用 self-authentication。

它不是自动 rollback。必须 materialize 并 review 新 v2 manifest，从 current `main`
启动新的 `restore.yml` dispatch，运行 read-only preflight，并获得新的
`plugin-publishing` approval。不得复用旧 approval，也不得只恢复 registry bytes。

## 11. Partial-state 处理

Website deployment、private R2 record 与 public registry CAS 无法组成一个原子
transaction。必须显式处理：

- **Intent/operation record 前：**production 未变化；修复 evidence 后启动新
  operation。
- **七个 initial record 的任意 subset 已存在、website 未部署：**在 `cas` 中用精确
  manifest 重跑；验证每个 existing object，只创建 missing object，再要求完整 readback。
- **Initial record 已全部持久化、website 未部署：**使用精确相同 manifest 重跑并
  readback 相同 record。
- **Website 已部署，registry 仍是 `from`：**重跑精确 operation，重新验证并继续
  forward；不得启动无关 release。
- **Registry 已经是 `to`：**只有 `resume` 合法。不再 PutObject，只重新验证 record、
  website、direct R2 与 public evidence。
- **只存在 completion 或只存在 reverse manifest：**从 direct-parent operation 重建
  缺失成员，要求 canonical bytes 一致，再 readback 并验证两者。
- **任何第三种 registry state、任何 altered existing record，或 `resume` 中缺少
  initial record：**fail closed 并升级处理；不得削弱检查或手工复制 bytes。
- **Direct R2 与 completion/reverse readback 成功后，public probe 仍未收敛：**durable
  completion 已存在。保留全部 evidence，并重跑相同 operation。

Incident 或 retention window 未关闭时，绝不能删除 forensic backup、completed
release artifact 或 private operation record。

## 12. 独立 App operator record

App compatibility guidance 必须放在 machine manifest 外：

```yaml
appSourceSha: <40-hex commit>
blockingEvidenceId: <CI run id 或 local-only:test-label>
localBuildLabel: <可选 human label>
```

这不是 binary attestation，绝不能 gate registry/website write。只有 remote
coordination 成功后，才能启动记录的 compatible App。未来若引入 App distribution，
必须替换为 required App artifact id、SHA-256 与 workflow-run attestation。

## 13. Evidence checklist

- [ ] 精确 registry/website current-`main` driver SHA
- [ ] 双侧 release tuple 的 producer run/workflow API evidence
- [ ] 所有 raw artifact id、name、SHA-256 与 embedded hash
- [ ] Approval 前后 no-write log
- [ ] Publish intent 或 restore operation key 与 canonical intent SHA
- [ ] Previous/current/target source SHA 与 observed ETag
- [ ] Immutable backup 与全部 restore-operation readback evidence
- [ ] Prebuilt-only website dry-run/deployment outcome
- [ ] Direct R2 verification
- [ ] Strict completion/reverse readback 与 execution evidence artifact
- [ ] Completion readback 后的 cache-busted public verification
- [ ] 要求新审批的 reverse seed
- [ ] 独立、非 attesting App compatibility record
- [ ] 仅正式发布前：精确 Electron/browser ICU/CLDR runtime 的
      `Intl.Locale.maximize()` resolver-corpus evidence
- [ ] Manual language/search/install/update smoke result
