# Motrix 插件注册表

[English](./README.md) | 简体中文

本仓库是 Motrix 插件目录背后的公开数据源（data-only registry）。合并到
这里的条目会被聚合为一个 `plugins.json`，发布地址：

```
https://dl.motrix.app/registry/plugins.json
```

有两个对等的消费方读取该文件：[motrix.app/plugins](https://motrix.app/plugins)
插件目录和 Motrix 应用内的插件市场。publish workflow 完成的那一刻，新插件
即在两端同时上线——无需等待官网或 App 发版。

## 提交插件

1. Fork 本仓库，只需新增**一个文件**：`plugins/<你的插件id>.json`。
   文件名必须与插件 `id` 完全一致。可以从现有条目复制起步，或参考带注释的
   schema：[`schema/registry.ts`](schema/registry.ts)。
2. Community 条目必须包含 `package` 块——指向 GitHub release 资产
   （或 dl.motrix.app）的 `https` 地址，及其 `sha256` 与 `size`。
   Motrix 在解包前校验哈希，不匹配会直接拒绝。
3. 图标 / 截图可选。文件放在 `assets/<你的插件id>/` 下，并以发布后的
   URL 引用：`https://dl.motrix.app/registry/assets/<你的插件id>/<文件名>`。
4. 提交 PR。CI 会运行 `pnpm validate`（schema + 策略：id 命名空间、
   package 地址白名单、已注册的 categories、资产路径前缀）。maintainer
   review 是信任关卡——registry 会锁定你的包哈希，因此每次发布新版本
   都需要一个 bump 版本号的 PR。

CI 强制执行的规则：

- `id` 为点分隔的小写命名（`author.plugin-name`）；`motrix.*` 命名空间
  保留给 builtin 插件。
- `name` / `description` 至少提供英文；有条件请补充 `zh`——消费方会
  自动回退到 `en`。
- `categories` 必须已在 `schema/registry.ts` 中注册（没有合适的先提
  PR 新增 slug）。
- 权限字段只是安装确认页的**预览**；实际授权始终以包内 manifest 为准，
  manifest 与 registry 条目不一致的包会被 App 拒绝。

## 发布流程

merge 到 `main` 触发 `.github/workflows/publish.yml`：
validate → aggregate（生成 `dist/plugins.json`，并盖上 `generatedAt`
时间戳）→ 连同 `assets/` 一起上传到 `motrix-registry` R2 bucket。
消费方使用 ETag 缓存该文件并保留最后一份可用副本，因此一次糟糕的发布
永远不会把插件目录清空。

## 契约与 lockstep

`schema/registry.ts` 中的 wire schema 是 **source of truth**；各消费方
vendor 与之逐字节一致的 schema 副本和 `schema/registry.fixture.json`。
改变 wire 结构意味着在同一个 PR 周期内更新所有消费方，且演进只增不删：
永远不要重命名、更改类型或移除已发布的字段。

## 开发

```bash
pnpm install
pnpm test        # fixture lockstep + 条目策略测试
pnpm validate    # CI 对 plugins/ 运行的检查
pnpm aggregate   # 本地构建 dist/plugins.json
```
