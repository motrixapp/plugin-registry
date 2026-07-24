# Builtin 签名 Package(Phase 2)— 设计

日期:2026-07-24
状态:已批准
父设计:`motrix-turbo/docs/superpowers/specs/2026-07-18-builtin-plugin-independent-update-design.md` §2(registry schema 扩展)与 §5(更新检查)。本 spec 覆盖 Phase 2 —— registry 侧的数据 + schema + 策略 + 发布自动化,用以激活 motrix-turbo 里已发布但休眠的 Phase 3 客户端。

## 1. 背景与目标

Motrix builtin 热更新客户端(motrix-turbo Phase 3)已完整实现但休眠:只有当 registry 条目携带带 Ed25519 `signature`(信任根)的 `package` 块时,才会提供 builtin 更新。当前 registry 的三个 builtin 条目完全没有 `package`,且 registry 的 wire schema(`schema/registry.ts`,源头)没有 `signature` 字段。Phase 2 闭合此缺口:

1. 给 `package` 块加可选 `signature` 字段,在三份 vendored schema 副本间 lockstep 落地。
2. 给三个 builtin 条目填真实、已验证的 `package` 块。
3. 收紧仓库策略:带 package 却无 signature 的 builtin 不得合并。
4. 自动化后续更新:builtin-plugins 的签名发布自动开 registry PR。

## 2. 仓库足迹(影响范围)

加 `signature` 是 additive-only 的 wire-shape 变更,但按 `CLAUDE.md` 的硬规则必须在三份 vendored 副本 + 其 fixture 间 lockstep 落地:

| 仓库 | 文件 | 改动 |
|------|------|------|
| **plugin-registry**(主) | `schema/registry.ts`、`schema/registry.fixture.json`、`scripts/lib.ts`、`scripts/entry-from-release.ts`(新)、`.github/workflows/*`(新/改)、`plugins/motrix.*.json`(×3)、`tests/*` | schema + 策略 + 数据 + 生成器 + CI + 测试 |
| **motrix-website** | `src/data/plugins.ts`、`src/data/registry.fixture.json` | lockstep:加 `signature`、同步 fixture |
| **motrix-turbo** | `src/shared/schemas/registry.fixture.json`(对齐),核对 `src/shared/schemas/registry.ts` | 已有 `signature`;仅 fixture 对齐 |
| **builtin-plugins** | `.github/workflows/release.yml` | 签名发布成功后追加一步 `repository_dispatch` 通知 plugin-registry |

**当前 lockstep 已破**:motrix-turbo(Phase-1B 工作中)已给 vendored schema 加了 `signature`、给 fixture 加了占位 builtin 条目,领先于源头。Phase 2 让三份重新字节一致。

## 3. Schema 变更(源头)

`plugin-registry/schema/registry.ts` 的 `package` 对象增加一个可选字段,**与 motrix-turbo 已 vendored 的逐字一致**:

```ts
package: z
  .object({
    url: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive(),
    // Phase 2 of the builtin independent-update design: detached ed25519
    // signature (base64) over the .moext bytes. THE trust boundary for
    // builtin hot updates; sha256 above is a pre-check only.
    signature: z.string().min(1).optional(),
  })
  .optional(),
```

同一 additive 字段落到 `motrix-website/src/data/plugins.ts` 的 `package` 块。**刻意不加 `minMotrix`** —— 父设计提过,但 motrix-turbo 只 vendored 了 `signature` 并用现有 `engines.motrix` 做兼容门;现在加 minMotrix 会再造漂移且对消费方无益。

字段在 wire 层保持 `.optional()`(community package 无签名;强制要求是仓库策略,见 §4)。additive-only:不改名/改型/删除任何已发布字段。

## 4. 策略变更(`scripts/lib.ts` `validateEntry`)

给仓库合并策略加一条规则(wire schema 保持宽松;策略只 gate 本仓库可合并什么):

- **若 `entry.origin === 'builtin'` 且 `entry.package` 存在,则 `entry.package.signature` 必须存在。** 无签名的 builtin package 无法被客户端热更新(`BuiltinUpdater` 以 `builtin_no_signature` 拒绝),且是潜在信任漏洞 —— 合并时拒绝。

不变:builtin **不**强制要 package(尚未独立发布的 builtin 可省略);community 保持现有规则(需 package、不需 signature);`PACKAGE_URL_ALLOWLIST` 已接受 builtin 用的 GitHub Releases 下载 URL。

## 5. 真实 builtin 数据

给三个 builtin 条目各填一个 `package` 块。版本已与发布 tag 及 motrix-turbo lockfile(`scripts/builtins.lock.json`)一致 —— 无需 bump:

| id | version | tag | sha256 / size | 来源 |
|----|---------|-----|---------------|------|
| motrix.filename-template | 1.0.1 | `motrix.filename-template@1.0.1` | `d7c2…815d` / 2085 | 已发布 |
| motrix.scraper-hook | 1.0.0 | `motrix.scraper-hook@1.0.0` | `2b6d…cb25` / 2218 | 已发布 |
| motrix.url-resolver | 1.0.0 | `motrix.url-resolver@1.0.0` | `308d…4a9e` / 3161 | 已发布 |

`package.url` = `https://github.com/motrixapp/builtin-plugins/releases/download/<url 编码的 tag>/<id>-<version>.moext`。`sha256`/`size` 来自各 release 的 `.metadata.json`(等于 lockfile)。`signature`(base64)来自 release 的 `.moext.sig` 边车。

**不变量 —— 绝不手抄数据。** 这些值由生成器脚本(§6)产出,它读取 release 资产并**在写入前对 `keys/signing-key.pub.pem` 验签**。验签不过则中止写入。这与 `builtin-plugins/scripts/verify.mjs` 的校验一致,也是 motrix-turbo pin 的同一把钥匙。

## 6. 生成器脚本(`scripts/entry-from-release.ts`)

一个脚本,两个调用方(CI + 一次性初始填充 —— DRY):

输入:插件 id + tag(如 `motrix.url-resolver@1.0.0`)。来源,按序:
1. 本地 artifact 目录覆盖(环境变量 `MOTRIX_BUILTIN_ARTIFACT_DIR`,含 `<file>.moext`、`<file>.moext.sig`、`<file>.metadata.json`)—— 供一次性离线填充与测试。
2. 否则从 GitHub Releases 下载该 tag 的三个公开资产。

步骤:
1. 读/解析 `.metadata.json` → `{ id, version, file, sha256, size }`;断言 `id`/`version` 与 tag 一致。
2. 对 `.moext` 字节重算 sha256,断言等于 metadata 的 sha256(绝不只信 metadata —— 与 motrix-turbo lockfile 纪律一致)。
3. 从 `.moext.sig` 读 base64 签名;对 `keys/signing-key.pub.pem` 做 `crypto.verify('ed25519', bytes, publicKey, sig)`;失败中止。
4. 加载现有 `plugins/<id>.json`,**只** patch `version` + `package { url, sha256, size, signature }`(name/description/categories/engines/permissions/features 等保持不动),写回,并对结果重跑 `validateEntry`。

当下复用:对由已验证 release 资产组装的本地 artifact 目录运行它,写入三个初始 `package` 块。

## 7. CI 自动化(dispatch-to-registry 模型)

把跨仓库凭证降到最低 —— PR 由 plugin-registry 自己的 `GITHUB_TOKEN` 创建;唯一跨仓库凭证是 dispatch 触发。

```
builtin-plugins .github/workflows/release.yml  (sign job 的 gh release create 成功后)
  → repository_dispatch (event_type: builtin-released, payload { id, version, tag })
     到 motrixapp/plugin-registry
plugin-registry .github/workflows/registry-entry-update.yml
  on: repository_dispatch (types: [builtin-released]) 与 workflow_dispatch (手动: id, tag 输入)
  → checkout、pnpm install
  → node scripts/entry-from-release.ts <id> <tag>   (下载公开资产、验签、patch)
  → pnpm validate && pnpm test                        (开 PR 前自门禁)
  → 用 peter-evans/create-pull-request(或 gh)以 GITHUB_TOKEN 建分支 + PR
  → PR 上跑现有 validate/test/lockstep CI;人工 merge
```

- **需要的凭证(带外、由你提供)**:builtin-plugins 里一个有权向 `motrixapp/plugin-registry` 发 `repository_dispatch` 的 token(细粒度 PAT 或 GitHub App 安装 token),存为 secret `REGISTRY_DISPATCH_TOKEN`。workflow 引用它;提供它是仓库管理动作,不在本次改动内。未设置前,plugin-registry 的 workflow 仍可经 `workflow_dispatch`(手动 id+tag)使用,故特性不被 secret 阻塞。
- 生成器的下载路径无需认证(release 资产公开)。
- PR 路径用 workflow 原生 `GITHUB_TOKEN`(对自己仓库有 contents+PR 写权限)—— 需在 plugin-registry 设置里开启「Allow GitHub Actions to create and approve pull requests」(同为一次性仓库管理开关;已文档化)。

## 8. Fixture lockstep

三份 `registry.fixture.json` 必须字节一致,且必须含一个行使 `signature` 字段的 builtin 条目(schema round-trip 覆盖)。motrix-turbo 已有一个占位 `motrix.url-resolver` builtin 条目(合成 sha256/signature);把同一条目(逐字)采纳进 plugin-registry 和 motrix-website 的 fixture。fixture 是 schema 校验测试数据 —— 合成签名字符串可接受且让 fixture 稳定;它**不是**真实 registry 数据。

## 9. 测试

- **plugin-registry**:`pnpm check`(tsc)、`pnpm test`(fixture lockstep + 策略)、`pnpm validate`(对 `plugins/` 的 CI 门)、`pnpm aggregate`(构建 `dist/plugins.json`)。新测试:策略拒绝「带 package 无 signature 的 builtin」;`entry-from-release.ts` 写前验签(篡改的 `.moext` 或错误密钥签名 → 中止,不写);三个真实条目通过 `validateEntry` 并干净聚合。
- **motrix-website**:`tsc`/test 确认 schema+fixture 改动可解析;无消费方回归。
- **motrix-turbo**:fixture 对齐后现有 `registry.test.ts` + 全套件保持绿。
- **跨仓库 lockstep 校验**:三份 schema 的 `package` 块与三份 fixture 字节一致(小的 diff 断言,手动或脚本跑)。

## 10. 范围之外

- 加 `minMotrix`(见 §3)。
- 签名基础设施 / 私钥处理 —— 归 builtin-plugins,本次不动。
- Community 插件的 registry 提交流程 —— 不变。
- 客户端热更新逻辑的任何改动(Phase 3,motrix-turbo 已发布)。
