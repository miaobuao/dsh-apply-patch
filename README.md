# dsh-apply-patch

DSH 插件：为模型注入 **codex 风格的 `apply_patch` 工具**。

GPT 系列模型在训练时大量使用 OpenAI Codex 的 `apply_patch` 工具，因此在 DSH 里使用 GPT 模型时，模型会本能地调用 `apply_patch` —— 但 DSH 默认不提供该工具，导致报错。本插件通过 DSH 强大的插件系统补上这个工具，并且**完全走 DSH 自带的沙盒系统**，绝不绕过沙盒直接修改文件。

## 功能

- **`apply_patch` 工具**：与 OpenAI Codex 完全一致的补丁格式（`*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` / `*** End of File` / `*** End Patch`），并支持 gpt-4.1 风格 heredoc（`<<'EOF' ... EOF`）的宽松解析。
- **沙盒写入**：所有文件写入都通过 `ctx.fs`（DSH 沙盒文件系统）执行，删除通过沙盒 bash 执行 —— 沙盒拒绝时返回 `[sandbox: ...]` 错误，绝不绕过。
- **按模型条件注入**：设置里的配置卡片只有一个下拉选择：
  - **关闭**：完全不注入 `apply_patch`
  - **仅GPT模型**（默认）：只对模型 id 以 `gpt-` 开头的模型注入
  - **所有模型**：对所有模型注入
- **设置卡片**：设置 → 插件 → 插件配置 → Apply Patch；选择写进本插件条目的 entry config，改动会重启该条目随即生效。

## 安装

通过 `dsh plugin` 命令安装到目标 profile（默认 `web`）：

### 从 GitHub 安装

```bash
# 默认分支（仓库带 prepare 构建脚本，pnpm 会自动构建）
dsh plugin --profile web add github:miaobuao/dsh-apply-patch

# 指定分支
dsh plugin --profile web add github:miaobuao/dsh-apply-patch#main
```

### 本地源码链接安装（开发）

```bash
pnpm build
dsh plugin --profile web add .
```

安装后插件通过 `cordis.patch.yml` 自动挂载：服务端注册 `apply_patch` 工具，注入范围来自本插件条目的 entry config（由插件 `Config` schema 声明，dsh ≥ 0.1.7 据此生成设置表单），web 端注册 `settings.section` 设置页（设置 → 插件 → 插件配置 → Apply Patch）。**安装后需要重启 dsh web 进程生效**。

### 删除插件

```bash
dsh plugin --profile web remove @fonlan/dsh-apply-patch
```

### 升级

```bash
dsh plugin --profile web update @fonlan/dsh-apply-patch
```

## 使用

模型（尤其是 GPT 系列）会像在 Codex 中一样直接调用 `apply_patch`，例如：

```
*** Begin Patch
*** Update File: hello.py
@@
-print("hello")
+print("hello, world")
*** Add File: new.py
+x = 1
*** Delete File: old.py
*** End Patch
```

工具返回 codex 风格的摘要：

```
Success. Updated the following files:
M /path/to/hello.py
A /path/to/new.py
D /path/to/old.py
```

## 沙盒说明

所有变更都通过 DSH 内置沙盒：

| 操作 | 沙盒路径 |
| --- | --- |
| Add / Update / Move 写入 | `ctx.fs.writeText`（沙盒文件系统，遵守会话 sandbox mode 与 workspace root） |
| Delete / Move 删除原文件 | `ctx.shell`（沙盒 bash `rm`，遵守同一策略） |

- `read-only` 模式下任何写入都会被沙盒拒绝，返回 `[sandbox: file access denied under read-only mode]`。
- `workspace-write` 模式下只允许写入 workspace root（以及沙盒策略允许的 `/tmp`）。
- 观察策略（fs-observation-policy）要求先读后写，工具内部自动完成 stat/read/observe/write 流程。

## 工作原理

1. 通过插件 `Config`（schemastery schema，单字段 `mode`）声明注入范围：dsh ≥ 0.1.7 用它生成设置表单，并把选择写进本条目 entry config；`mode` 标记为 `volatile()`，因此 `apply()` 拿到的是实时句柄，每次组装工具列表时重新读取，改设置无需重启会话。
2. 通过 `ctx.tools.register` 注册 `apply_patch` 工具（`defineTool`）。
3. 挂钩 `system-prompt/assemble` 瀑布：组装工具列表时，按 `mode` + 当前会话模型决定是否保留 `apply_patch`。
4. 模型判定优先读取组装变量中的 `variables.model`（模型选择层注入的权威值，切换模型零延迟），回退到 `agent/request` 捕获的已解析路由、会话请求头、`agentDefaultModel` 默认值。

## Codex 行为兼容性

补丁解析和文件应用语义对齐 `openai/codex` 提交
`014489466a1739c2c563cdfe57880c2c7c8680e3`，并使用该版本的 25 组原始场景
fixtures 做回归验证：

- `Add File` 可以覆盖已有文件；覆盖仍受 DSH 沙盒和写入观察策略约束。
- 匹配依次尝试精确、忽略尾部空白、忽略两端空白和 Unicode 标点归一化。
- 更新保留上下文行原文及 LF / CRLF / CR 混合换行；新行使用文件的首个换行风格。
- 纯插入追加在所有原有逻辑行之后；EOF 匹配不会退回已经处理的区域。
- `Move to` 必须位于修改块之前；EOF 后的新块必须以 `@@` 开始。
- Add/Delete 后裸空行不是分隔符；新增空行应写为 `+`，Update 中裸空行是上下文。

DSH 接入仍使用 `{ patch: string }` 参数、`ctx.fs` 写入及沙盒 shell 删除。
这不是 Codex 运行时的完整移植：不提供其 freeform 工具传输、流式 diff 事件、
执行 delta 跟踪或多执行环境路由。`Environment ID` 目前仅校验语法，执行仍在 DSH
会话工作目录；不应使用它选择远程环境。多文件补丁按顺序执行，失败不会回滚此前变更。

## 开发

```bash
pnpm install
pnpm build        # 构建 host + client
pnpm typecheck    # 类型检查
pnpm test         # 单元测试（解析器/应用器）+ 集成测试（真实 cordis + 沙盒 fs）
```

## License

本项目是 [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch)
的 fork，由 miaobuao 于 2026-10-20 修改，整体按 **GPL-3.0-or-later** 分发。
完整 GPLv3 文本见 [LICENSE](LICENSE)。本声明允许使用 GPL 第 3 版或任何后续版本。

原作者 `Copyright (c) 2026 fonlan` 及完整 MIT 许可保留于
[LICENSES/MIT.txt](LICENSES/MIT.txt)，上游材料原有的 MIT 授权继续有效。
Codex 相关改编及测试 fixtures 的 Apache-2.0 许可见
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，来源说明见 [NOTICE](NOTICE)。

本 fork 通过上述 GitHub 地址安装；npm 上的 `@fonlan/dsh-apply-patch`
属于原项目，不代表本 fork。分发构建包时，请同时提供对应版本的源码及构建文件。
