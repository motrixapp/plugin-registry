# Motrix 插件注册表

[English](./README.md) | 简体中文

本仓库是 Motrix 插件目录背后的公开数据源（data-only registry）。合并到
这里的条目会被聚合为一个 `plugins.json`，发布地址：

```
https://dl.motrix.app/registry/plugins.json
```

有两个对等的消费方读取该文件：[motrix.app/plugins](https://motrix.app/plugins)
插件目录和 Motrix 应用内的插件市场。合并后会构建经过校验的注册表产物，
通过 `plugin-publishing` 环境审批后才发布。官网仍由维护者单独构建和手动部署；
本仓库的工作流只发布注册表数据与资源。

## 提交插件

1. Fork 本仓库，只需新增**一个文件**：`plugins/<你的插件id>.json`。
   文件名必须与插件 `id` 完全一致。可以从现有条目复制起步，或参考带注释的
   schema：[`schema/registry.ts`](schema/registry.ts)。
2. Community 条目必须包含 `package` 块——指向 GitHub release 资产
   （或 dl.motrix.app）的 `https` 地址，及其 `sha256` 与 `size`。
   Motrix 在解包前校验哈希，不匹配会直接拒绝。
3. 图标 / 截图可选。文件放在 `assets/<你的插件id>/` 下，并以发布后的
   URL 引用：`https://dl.motrix.app/registry/assets/<你的插件id>/<文件名>`。
4. 编辑文案统一放在 `listing` 下。当前 publisher 策略要求
   `defaultLocale: "en-US"`；default record 必须包含 `name` 与
   `description`，其他 canonical BCP 47 locale 可以只提供部分字段：

   ```json
   {
     "listing": {
       "defaultLocale": "en-US",
       "localizations": {
         "en-US": { "name": "Example", "description": "Example plugin" },
         "zh-CN": { "name": "示例" },
         "ja-JP": { "description": "サンプルプラグイン" }
       }
     }
   }
   ```

5. 提交 PR。CI 会运行 typecheck、test、validate、aggregate 与最终 UTF-8
   产物大小闸门。maintainer
   review 是信任关卡——registry 会锁定你的包哈希，因此每次发布新版本
   都需要一个 bump 版本号的 PR。

CI 强制执行的规则：

- `id` 为点分隔的小写命名（`author.plugin-name`）；`motrix.*` 命名空间
  保留给 builtin 插件。
- Locale key 必须是无 extension/private-use 的 canonical BCP 47 tag。
  新增 `ja-JP` 等语言只需改数据，不需改 schema。消费方逐字段按 exact、
  structural parent、inferred language-script、language、default 回退；显式
  空 list 表示有意覆盖。
- `categories` 必须已在 `schema/registry.ts` 中注册（没有合适的先提
  PR 新增 slug）。
- 权限字段只是安装确认页的**预览**；实际授权始终以包内 manifest 为准，
  manifest 与 registry 条目不一致的包会被 App 拒绝。

## 发布流程

合并到 `main` 后，先执行 `check → test → validate → aggregate`，再进入审批。
工作流将生成的 `plugins.json` 原始字节上传为不可变产物，记录 SHA-256、大小、
产物 ID 和源码提交。审批后按 ID 下载，校验字节与 v2 schema，不重新构建。

发布前确认 `main` 没有更新，备份 R2 中的旧对象，从已审查的提交上传引用的资源，
仅当旧对象的 ETag 仍匹配时才替换固定的 `plugins.json`。随后校验 R2 读回和
公开地址的 SHA-256。官网继续独立手动部署，本流程不需要官网 GitHub 仓库或
网站部署凭据。

## 契约与 lockstep

`schema/registry.ts` 中的 tolerant wire schema 与 resolver 是
**source of truth**。各消费方 vendor wire-equivalent 实现，以及逐字节一致的
`schema/registry.fixture.json` 与 `schema/registry.conformance.json`。
Strict publisher-authoring schema 有意更窄，不是 consumer contract。Registry v2
的 tolerant consumer 也会显式拒绝 v1 plugin-root 字段 `name`、`description` 与 `features`，但仍保留其他未来字段。
Registry v2 此后仅 additive-only：永远不要重命名、更改类型或移除已发布字段。

## 开发

```bash
pnpm install
pnpm check       # TypeScript
pnpm test        # schema、corpus、策略、aggregate、发布产物完整性
pnpm validate    # CI 对 plugins/ 运行的检查
pnpm aggregate   # 本地构建 dist/plugins.json
```

不要手工编辑或提交 `dist/plugins.json`。公开 URL、root `version: 2`、
R2 key `plugins.json` 与输出文件名保持不变。
