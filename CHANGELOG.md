# 变更记录

## 0.0.1-alpha.1 - 2026-10-20

首个版本，基于上游 `@fonlan/dsh-apply-patch@0.1.6`。本次发布的主要变更：
`apply_patch` 改为安装即启用并以 `disableEdit` / `disableWrite` 开关替代按模型注入；
补丁解析与应用对齐 openai/codex `0144894`；项目整体改为 GPL-3.0-or-later 分发。

### 兼容性

- 宿主版本：`@deepseek-ai/dsh-*` `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1`
  （`peerDependencies` 声明），`@deepseek-ai/cordis` `^4.0.1`。
- 自动化测试基线：`typecheck` / `build` / `test` 基于 `@deepseek-ai/*` `0.2.1-alpha.1`。
- 运行时验证：dsh web `0.2.1-rc.2` 下插件加载、工具注入及 `apply_patch`
  新增/修改/删除均正常，文件变更均经由 DSH 沙盒完成。

### 破坏性变更

- **包名与仓库**：由 `@fonlan/dsh-apply-patch` 更名为 `dsh-apply-patch`，仓库迁移至
  `github.com/miaobuao/dsh-apply-patch`，版本号重置为 `0.0.1-alpha.1`；
  `cordis.patch.yml` 的条目标识与客户端 bundle id 同步更新。已安装上游版本的
  profile 需移除旧条目后重新安装。
- **启用与注入**：`apply_patch` 改为安装即启用，删除 `mode`（`off` / `gpt-only` /
  `all`）注入范围设置，不再按模型过滤，工具对所有模型可用。
- **配置项与设置页**：`mode` 下拉替换为 `disableEdit` / `disableWrite` 两个开关，
  默认均为 `true`（隐藏 DSH 内置 `edit` / `write` 工具）；设置页由设置侧栏迁移至
  插件中心（设置 → 插件 → dsh-apply-patch）的插件页面，旧 `mode` 配置不再读取。
- **许可证**：由 MIT 改为 GPL-3.0-or-later，保留上游 MIT 与 Codex Apache-2.0
  授权声明。

### 升级说明

1. 移除旧包：`dsh plugin --profile web remove @fonlan/dsh-apply-patch`
2. 安装新包：`dsh plugin --profile web add github:miaobuao/dsh-apply-patch`
3. 重启 dsh web 进程。原 `mode` 配置不再生效；如需恢复内置 `edit` / `write`
   工具，在插件页面关闭对应开关。

### 新增

- `disableEdit` / `disableWrite` 配置项及对应插件中心开关，可独立隐藏内置
  `edit` / `write` 工具。
- 25 个来自 openai/codex 的兼容性 fixture（`test/fixtures/codex/`，Apache-2.0），
  以及 CRLF/混合换行、Unicode 匹配、纯新增位置、EOF 约束、结构校验等回归测试。
- `LICENSES/MIT.txt`、`LICENSES/Apache-2.0.txt` 与 `NOTICE` 许可证/归属文件。
- 发布流程：npm OIDC trusted publishing、预发布版本 dist-tag 自动推导
  （`0.0.1-alpha.1` → `alpha`）、发布前 typecheck 及 `--provenance`。
- npm 包内容补充 `CHANGELOG.md`、`NOTICE`、`LICENSES/`、构建配置与 lockfile。

### 变更

- 补丁解析与应用对齐 openai/codex `0144894`，涵盖 `Add File` 覆盖、换行符与上下文
  保留、Unicode 匹配、纯新增位置、EOF 锚定及结构校验（详见“修复”）。
- 插件配置页改用插件中心 `plugins.bundle.config` 槽位，与官方插件页面一致；
  配置写入使用 `configForms` 并带 revision 冲突检测。
- `apply_patch` 工具描述同步 Codex 语义（`Add File` 可覆盖、`End of File` 锚定前
  一 block）。
- README 中英双语重写，聚焦安装、使用及许可来源。

### 修复

- 被隐藏的内置 `edit` / `write` 工具此前只是从工具列表中移除，模型直接按名称调用
  仍会执行；现已增加执行层 `tools.guard` 拒绝此类调用。
- `*** Add File:` 覆盖已存在文件，不再报错。
- 更新文件时保留源文件换行符（LF、CRLF、CR 及混合）与上下文原始字节，仅替换实际
  变更片段。
- 行匹配在精确 → rstrip → trim 之外，增加 Unicode 标点与不间断空格归一化。
- 纯新增 chunk 追加到全部逻辑行之后（包含文件末尾空行）。
- `*** End of File` 正确锚定前一个 chunk，之后不再向前回溯，且不允许普通变更行。
- 收紧补丁结构校验：`*** Move to:` 必须位于 chunk 之前；拒绝 `*** End Patch`
  之后的多余内容、hunk 内嵌补丁标记、空 chunk 上的 `*** End of File`；heredoc
  包裹兼容 CRLF；`*** Environment ID:` 后必须带空格。

### 验证

- `typecheck`、`build` 通过。
- `test` 75 项中 74 项通过；删除路径的集成用例受本地环境限制（无法嵌套
  `sandbox-exec`）未能通过，该路径已在 dsh web `0.2.1-rc.2` 运行时验证中覆盖。
