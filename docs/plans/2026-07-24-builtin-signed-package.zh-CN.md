# Builtin 签名 Package(Phase 2)实现计划

> **致 agentic worker:**必须使用子技能:superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务执行。步骤用 checkbox(`- [ ]`)。所有代码块以英文版 `2026-07-24-builtin-signed-package.md` 对应 Task/Step 为 canonical。

**目标:**给 registry 的三个 builtin 条目加签名 `package` 块(Ed25519 `signature` 字段),在所有 vendored schema 副本间 lockstep,配生成器脚本 + CI 使其随 builtin-plugins 发布自动更新 —— 激活 motrix-turbo 里休眠的 builtin 热更新客户端。

**架构:**additive wire-schema 变更(`package.signature`,可选)在三仓库 byte-identical 落地;仓库合并策略要求 builtin package 带签名;一个 `tsx` 生成器抓取/验签 release 并 patch 条目(CI 与一次性填充复用);dispatch-to-registry 的 CI:builtin-plugins 通知 plugin-registry,后者用自身 token 开自门禁 PR。

**Spec:**`docs/specs/2026-07-24-builtin-signed-package-design.md`(+ `.zh-CN.md`)

## 全局约束

- **Lockstep(硬规则)**:`plugin-registry/schema/registry.ts` 是 wire 契约源头;`motrix-website/src/data/plugins.ts` 与 `motrix-turbo/src/shared/schemas/registry.ts` vendored byte-identical 副本,连同 byte-identical 的 `registry.fixture.json`。任何 wire-shape 变更同周期落三仓库;**additive-only**。
- `signature` 字段必须恰为 `signature: z.string().min(1).optional()`,置于 `package` 对象内 —— 与 motrix-turbo 已 vendored 的一致。
- **不加 `minMotrix`**(spec §3)。
- **签名数据绝不手抄** —— 由生成器产出,写前对 `keys/signing-key.pub.pem`(motrix-turbo pin 的同一 Ed25519 钥)验签;不过即中止。
- 各仓库门禁(在你改的仓库里跑):plugin-registry `pnpm check && pnpm test && pnpm validate`;motrix-website `pnpm exec tsc --noEmit && pnpm test`;motrix-turbo `pnpm exec tsc --noEmit && pnpm exec vitest run src/shared/schemas/`。
- Conventional Commits,英文,无 AI 署名。各仓库各自 feature 分支各自 commit。
- 分支:plugin-registry 已在 `feature/builtin_signed_package_20260724`;motrix-website/motrix-turbo/builtin-plugins 各自从默认分支建同名分支再改。

## Canonical fixture

Task 1/5/6 写同一份 `registry.fixture.json`。定义一次:即 **motrix-turbo 当前的 `src/shared/schemas/registry.fixture.json` 恰改一处** —— builtin `motrix.url-resolver` 条目的 `"categories": ["network"]` 改为 `"categories": ["integration"]`。理由:motrix-website 的 schema 用 `z.enum(pluginCategoryKeys)`(注册键 = site-resolver | post-action | automation | integration)严格校验分类,`"network"` 非法会破 website 解析;`"integration"` 在三处 schema 都合法。其余(两个 community 条目、builtin 条目占位 `sha256`=64 个 `a`、`size` 12345、`signature` `"c2lnbmF0dXJl"`、`engines.motrix` `"^2.0.0"`)保持 byte-identical。占位值是合成 schema 测试数据,非真实 registry 数据(spec §8)。

---

### Task 1:plugin-registry —— schema `signature` 字段 + canonical fixture

**文件:**`schema/registry.ts`(package 对象)、`schema/registry.fixture.json`(采纳 canonical,2→3 条)、`tests/registry.test.ts`(fixture 长度 2→3 + signature 保留断言)。

- [ ] Step 1:改测试断言(英文版 Task 1 Step 1:长度 3、builtin `package.signature === 'c2lnbmF0dXJl'`)
- [ ] Step 2:`pnpm test` 确认失败(现 fixture 2 条且 signature 被 strip)
- [ ] Step 3:`package` 对象加 `signature`(代码以英文版 Task 1 Step 3;并更新其上方注释)
- [ ] Step 4:用 canonical fixture 覆写 `schema/registry.fixture.json`(拷 turbo 的,`network`→`integration`)
- [ ] Step 5:`pnpm test` 确认通过
- [ ] Step 6:门禁 + 提交:`git commit -m "feat: add optional package.signature to the registry wire schema"`

### Task 2:plugin-registry —— builtin package 签名策略

**文件:**`scripts/lib.ts`(`validateEntry`)、`tests/registry.test.ts`(策略测试)。

- [ ] Step 1:加失败测试(英文版 Task 2 Step 1:builtin 有 package 无 signature → 拒绝;有 signature → 接受)
- [ ] Step 2:`pnpm test` 确认失败
- [ ] Step 3:实现规则(英文版 Task 2 Step 3:`origin==='builtin' && package && !package.signature` → push problem)
- [ ] Step 4:`pnpm test` 确认通过
- [ ] Step 5:门禁 + 提交:`git commit -m "feat: require an ed25519 signature on builtin package entries"`

### Task 3:plugin-registry —— `entry-from-release.ts` 生成器

**文件:**新建 `scripts/entry-from-release.ts` + `tests/entry-from-release.test.ts`;改 `package.json`(加 `"entry:from-release": "tsx scripts/entry-from-release.ts"`);把 `builtin-plugins/keys/signing-key.pub.pem` 拷进 `plugin-registry/keys/`(与 motrix-turbo pin 的对比一致)。

**接口:**`buildPackageBlock(a, tag, pubPem)`(重算 sha256、比对 metadata、验签,任一不符即 throw,返回 version + package 块)、`patchEntry(id, block)`(只 patch version+package,写回后重跑 validateEntry)、CLI(`<id> <tag>`,`MOTRIX_BUILTIN_ARTIFACT_DIR` 覆盖否则从 GitHub Releases 下载)。

- [ ] Step 1:写失败测试(英文版 Task 3 Step 1:好 release → 验证块;错钥/sha 不符/tag 不符 → throw)
- [ ] Step 2:`pnpm exec vitest run tests/entry-from-release.test.ts` 确认失败(模块缺失)
- [ ] Step 3:实现脚本(代码以英文版 Task 3 Step 3 为准)
- [ ] Step 4:拷公钥 `mkdir -p keys && cp ../builtin-plugins/keys/signing-key.pub.pem keys/` 并 `diff` 对比 motrix-turbo 的确认一致
- [ ] Step 5:加 package.json 脚本
- [ ] Step 6:`pnpm exec vitest run tests/entry-from-release.test.ts` 确认通过
- [ ] Step 7:门禁 + 提交:`git commit -m "feat: add signature-verifying release-to-entry generator"`

### Task 4:plugin-registry —— 填三个 builtin 的 package 块

**文件:**`plugins/motrix.{filename-template,scraper-hook,url-resolver}.json`(经生成器写,非手填)。

- [ ] Step 1:组装本地已验证 artifact 目录(`.moext`+`.metadata.json` 来自 `builtin-plugins/dist/artifacts/`,`.moext.sig` 来自 `motrix-turbo/node_modules/.cache/motrix-builtins/`;命令见英文版 Task 4 Step 1)。缺文件则停并报告,不伪造。
- [ ] Step 2:对三个插件跑生成器(英文版 Task 4 Step 2 三条 `MOTRIX_BUILTIN_ARTIFACT_DIR=… pnpm entry:from-release …`),每条须打印 patched 并验签通过;若签名/sha 不符则停并报告。
- [ ] Step 3:核对三个 `plugins/*.json` 的 package(url 为 GitHub Releases、sha256 与 `motrix-turbo/scripts/builtins.lock.json` 一致、有 base64 signature)
- [ ] Step 4:全量门禁 `pnpm check && pnpm test && pnpm validate && pnpm aggregate`(published entries 绿、validate PASS、aggregate 写 dist/plugins.json;dist/ 是 gitignore,不提交)
- [ ] Step 5:提交:`git commit -m "feat: publish signed package blocks for the three builtin plugins"`

### Task 5:motrix-website —— lockstep schema + fixture

**文件(`../motrix-website`):**`src/data/plugins.ts`(package 加 signature)、`src/data/registry.fixture.json`(采纳 canonical)、`src/data/plugins.test.ts`(长度 2→3 + signature 断言)。

- [ ] Step 1:建分支 `git -C ../motrix-website checkout -b feature/builtin_signed_package_20260724`
- [ ] Step 2:改测试(长度 3 + builtin signature 断言,英文版 Task 5 Step 2)
- [ ] Step 3:`pnpm test` 确认失败
- [ ] Step 4:`PluginEntrySchema` 的 package 加同样的 `signature`(注释同 Task 1)
- [ ] Step 5:用 canonical fixture 覆写 `src/data/registry.fixture.json`(与 plugin-registry 的 byte-identical;builtin 条目须为 `["integration"]` —— website 的分类枚举会拒 `network`)
- [ ] Step 6:`pnpm test` + `pnpm exec tsc --noEmit` 确认通过
- [ ] Step 7:提交:`git -C ../motrix-website commit -m "feat: vendor package.signature and sync the registry fixture"`

### Task 6:motrix-turbo —— fixture 分类对齐

**文件(`../motrix-turbo`):**`src/shared/schemas/registry.fixture.json`(builtin `["network"]`→`["integration"]`)。turbo 已有 signature 字段与 3 条 fixture,唯一需要的就是这处分类编辑以达成三份 byte-identical;其 schema 分类宽松,行为中性。

- [ ] Step 1:建分支 `git -C ../motrix-turbo checkout -b feature/builtin_signed_package_20260724`
- [ ] Step 2:改 fixture 分类;先 `grep -rn '"network"' src/` 查有无硬编码断言,有则一并改
- [ ] Step 3:三份 fixture 三方 `diff` 确认 byte-identical
- [ ] Step 4:门禁 `pnpm exec tsc --noEmit && pnpm exec vitest run src/shared/schemas/`
- [ ] Step 5:提交:`git -C ../motrix-turbo commit -m "chore: align shared registry fixture category with the registry canonical"`

### Task 7:CI 自动化 —— dispatch-to-registry

**文件:**新建 `plugin-registry/.github/workflows/registry-entry-update.yml`;改 `builtin-plugins/.github/workflows/release.yml`(sign job 追加 dispatch 步);新建/改 `plugin-registry/docs/releasing.md`(记录所需 secret + 仓库开关)。

- [ ] Step 1:plugin-registry workflow(YAML 以英文版 Task 7 Step 1 为准:`repository_dispatch: [builtin-released]` + `workflow_dispatch`;跑 `pnpm entry:from-release`;`pnpm validate && pnpm test` 自门禁;`peter-evans/create-pull-request@v7` 用 `GITHUB_TOKEN` 开 PR)
- [ ] Step 2:builtin-plugins 建分支并在 release.yml 的 sign job「Create release」后追加 Notify 步(YAML 以英文版 Task 7 Step 2 为准 —— **空 token 的 shell 判空守卫**,不用 step 级 `if: secrets`;未设 secret 时跳过、发布仍成功)
- [ ] Step 3:写 `docs/releasing.md`(英文版 Task 7 Step 3:需 builtin-plugins 的 `REGISTRY_DISPATCH_TOKEN` secret + plugin-registry「Allow Actions to create PRs」开关;手动 fallback `gh workflow run`)
- [ ] Step 4:lint YAML(有 actionlint 则跑,否则 `python3 -c "import yaml;yaml.safe_load(open(f))"`);本任务不运行 workflow
- [ ] Step 5:两仓库分别提交(英文版 Task 7 Step 5)

### Task 8:跨仓库 lockstep 校验(仅验证)

- [ ] Step 1:三份 schema 的 `package` 块字段(url/sha256/size/signature)一致(英文版 Task 8 Step 1 的 grep)
- [ ] Step 2:三份 fixture 三方 diff byte-identical
- [ ] Step 3:各仓库最终门禁(英文版 Task 8 Step 3)
- [ ] Step 4:不提交,结果记入最终总结

---

## 与 spec 覆盖对照(自查)

- §3 schema signature(3 仓库)—— Task 1/5/6
- §4 策略(builtin+package⇒signature)—— Task 2
- §5 真实 builtin 数据 —— Task 4(经 Task 3 生成器,不手抄)
- §6 写前验签生成器 —— Task 3
- §7 CI dispatch-to-registry + 带外 secret/开关文档 —— Task 7
- §8 fixture lockstep(network→integration 适配 website 枚举)—— Task 1/5/6/8
- §9 测试 —— Task 1-4/5/6/8
- 推迟/无:`minMotrix`(§3 刻意省),签名基础设施(§10,归 builtin-plugins)
