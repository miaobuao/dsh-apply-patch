# 变更记录

## 0.1.0 - 2026-10-21

本次更新重做内置工具隐藏、补齐删除/移动的失败保证、新增 `apply_patch` 的专用
工具调用卡片，并收窄宿主版本范围。0.1.0 是首个正式版本，发布到 npm 的
`latest` dist-tag。

### 新增

- 对话中的 `apply_patch` 调用改用专用卡片（`tool.call.toolview` 槽位的
  `apply_patch` 键），不再显示通用工具卡片的原始 patch 文本：
  - 折叠行的标题由补丁动作与文件名生成：单文件为「更新 src/a.ts」「新增
    src/b.ts」「删除 old.txt」「移动 a.ts → b.ts」，多文件按动作聚合为
    「更新 3 个文件 · src/a.ts、src/b.ts、src/c.ts」（全部文件名按补丁顺序
    列出，单行放不下时省略号截断）或混合时「修改 3 个文件 · …」；同时显示
    总 `+A -R` 行数；
  - 展开行按补丁顺序列出每个文件操作（`A` 新增 / `M` 更新 / `D` 删除 /
    `M →` 移动），路径可点击打开，并附带该操作的 diff 与行数；长 diff 默认折叠
    中间，首尾各保留 3 行变化行（外侧再带 1 行上下文），折叠视图不会只剩上下文
    行；点击「展开 N 行」展开、再「收起」折回；
  - 运行中随 `patch` 参数流式列出已经出现的操作，结束后按结果标注
    「已应用 / 未执行」；失败时显示错误原文与「已应用 x/y」；
  - 表头沿用宿主的 disclosure 交互：悬停时前置文件图标换成向下箭头，展开后显示
    向上箭头，行文字从 `label-tertiary` 提升到 `label-secondary`；展开的表头在
    滚动长卡片时吸顶（与 reasoning 块同一实现）；diff 行沿用宿主 diff 卡的
    `markdown-code-block` / `code-diff-added` / `code-diff-deleted` 配色；
  - 前置图标改为自绘的「补丁文档」字形：一页纸 + 一条新增标线与一条删除标线，
    替代普通文件图标与宿主 compare-split 字形；按宿主 regular 图标规格绘制
    （16px viewBox、1px 描边、圆头端点、14px 渲染）；
  - 卡片只从会话日志记录的调用参数与结果推导，历史会话回放同样生效；客户端
    半边不导入其它 Harness Client 包，样式只使用 `--dsw-alias-*` 主题 token。
- 新增共享的容错 patch 扫描器（`src/shared/patch-preview.ts`）与其回归用例：
  流式半截输入不抛错，计数精确，预览行数有上限；Host 侧的严格解析语义不变。

### Breaking

- 隐藏内置 `edit` / `write` 改为「装配过滤 + 按名守卫」，两者都按工具名工作。
  - 装配过滤同时移除同名引导段落；此前只过滤工具清单，`tool:edit` / `tool:write`
    段落会残留在提示里，让模型看到已经不能调用的工具说明。
  - 守卫按名拒绝任何调用（含带 agent 作用域的调用），不再只是拒绝无作用域的直接调用。
  - 不使用 `ctx.tools.restrict`：实际部署中 `@deepseek-ai/dsh-tool-fs` 由 agent preset
    挂载，工具注册在 agent 作用域，而限制只能遮住继承的全局工具。
  - 开关值按使用时读取，改开关在下一个步骤生效，不重启插件。
- peer 范围收窄：`@deepseek-ai/dsh-*` 由
  `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` 收窄为 `^0.2.1-alpha.1`，
  `@deepseek-ai/cordis` 由 `^4.0.1` 收窄为 `~4.0.5-alpha.1`。`0.1.x` 宿主不再声明支持
  （客户端设置页需要 `configForms`，宿主侧需要 `system-prompt/assemble` 与 `tools.guard`）。
- 失败改为结构化 `ApplyFailure`（`stage` / `applied` / `affected` / `code` / `landedAt` /
  `removal`）。`stage` 取 `resolve` / `add` / `delete` / `read` / `derive` / `verify` /
  `update` / `move-write` / `move-remove`。曾按原始错误类型（如 `FsError`）或直接拼接
  `error.message` 判断失败的调用方，需改为读取字段；已有改动生效时，错误消息仍保留
  “Applied before the failure:” 列表。

### Behavior

- `Move to` 在写目标之前预检沙盒 shell；缺少 shell 时不再留下“目标已写、源未删”的半完成
  状态。
- `Move to` 目标已写入而源删除未确认时：未启动删除（`removal.outcome ===
  'not-started'`）说明源文件仍在原处；已请求但无法确认时说明源删除未确认、要求在重试前
  检查两个路径，结果未知（`'unknown'`）时另附
  “Removal outcome is unknown for `<path>`…”。
- `Update File` 在读取后、写入前再取一次版本；期间文件被外部改动时以 `FS_STALE_VERSION`
  失败，且不记录读取观察。
- 删除在 `rm` 前再取一次版本：`Delete File` 仅严格模式校验，`Move to` 两种模式都校验
  源文件版本；缩小（而不消除）“检查后删除”的竞态窗口。
- Host 直接读取 volatile 配置（`config.<field>.get()`），移除私有符号探测、解包兜底与
  模块级缓存。
- 客户端开关按宿主控件复刻（`<button role="switch">` + 拇指 span、36×20 轨道、
  16px 拇指、`aria-checked` 驱动选中态），并只使用 `--dsw-alias-*` 主题 token；
  不再导入 `@deepseek-ai/dsh-client-ui-primitives`。

### Tooling

- `CLIENT_EXTERNALS` 裁剪为客户端半边实际导入的 `react` 与 `react/jsx-runtime`；该表同时
  是客户端 bundle 纯度门禁的白名单。
- CSS 改为导出字符串、由组件渲染 `<style>`，样式随组件挂载与卸载。
- 新增 `verify:manifest` 脚本（`scripts/verify-manifest.mjs`）：校验发布清单与构建产物
  是否一致（入口 / `exports` / `files`、客户端 bundle 的 loader id、bundle 是否引入平台
  模块表之外的依赖、声明中的运行时导入是否已声明，以及每个 `@deepseek-ai/dsh-*` peer 是否
  仍覆盖本包所写的 API 代际）。

## 0.0.1-alpha.2 - 2026-10-20

本次更新集中修复静态分析发现的正确性、架构与性能问题，并新增覆盖策略开关。

### 新增

- 插件页面新增 **允许覆盖未读取的文件**（`allowUnobservedOverwrite`，默认开启）。
  默认行为与 Codex 一致；关闭后 `Add File` / `Move to` 覆盖已存在文件、
  `Delete File` 删除文件都要求模型先读取目标（经 DSH 的读后写观察策略校验）。
- 新增回归用例：15 万行文件更新、观察记录生命周期、严格覆盖模式、`Move to` 自身、
  部分失败进度；删除路径的集成用例改用 `danger-full-access`，在没有可用 OS 沙盒
  后端的主机上也能执行。

### 变更

- `Move to` 的成功摘要报告目标路径（与 Codex 一致），此前报告源路径。
- 多文件补丁中途失败时，错误信息保留原错误类型并列出已经生效的 `A`/`M`/`D` 路径。
- 沙盒 shell 服务不再在插件 `apply()` 时捕获，改为每次工具执行时解析，宿主之后
  挂载或更换 shell 也能生效。
- README（中英）补充严格覆盖开关、部分失败、自移动以及 shell/移动限制的说明。

### 修复

- 大文件更新崩溃：`deriveNewContents` 过去用 `push(...lines.slice(...))` 展开
  数组，超过约 12 万行会抛 `RangeError: Maximum call stack size exceeded`；
  现改为按原字符串偏移切片重建，不再展开大数组。
- `*** Move to:` 指向源文件自身时会“先写入新内容、再删除该文件”，导致文件丢失；
  现按原地更新处理。
- 失败补丁污染读后写状态：过去在每次写入前自行发出 `fs/observed`，失败的补丁
  也会把文件标记为“已读”，后续工具因此可以盲写；现在只在真实读取成功（Update
  的上下文匹配通过）、写入成功或删除成功后记录观察。
- 沙盒拒绝映射依赖 `instanceof FsError`：`github:` 安装可能出现第二份
  `@deepseek-ai/dsh-fs`，导致映射静默失效；现按稳定的 `error.code` 判断。
- 删除被拒时手写的提示改为共享的 `[sandbox: ...]` 文案；删除路径同样使用
  `sandboxDenialMarker`。
- 替换区间缺少重叠校验（理论上会重复输出行）；现在会拒绝重叠/越界替换。
- hunk 之间没有检查取消信号；现在每个 hunk 前检查 `signal`。
- 丢弃 `tool.ts` 中与重抛等价的死代码 try/catch。

### 性能

- 行匹配在精确 → rstrip → trim → Unicode 归一化的多轮搜索中，过去每个候选行都
  重新做 `trimEnd`/`trim`/正则归一化；现按文件惰性缓存各归一化形式并在多个 hunk
  间复用。2 万行文件、40 行失败模式的病态匹配从约 142ms 降到约 17ms。
- 补丁只 `split` 一次（过去是 trim → split → join → split）；`Add File` 内容改为
  行缓冲后一次 `join`。
- 移除 `Add File` 与 `Move to` 目标上多余的 `stat`，删除/更新仍保留必要检查。
- 工具抑制集合按配置值缓存，不再在每次系统提示组装和每次工具调用时重建 `Set`。

### 构建

- `build` 补齐客户端声明产物 `lib/types/client/index.d.ts`，修复
  `exports["./client"].types` 指向不存在文件的问题；`tsconfig.client-types.json`
  参与 `build`。
- npm 发布包不再附带 `pnpm-lock.yaml` / `pnpm-workspace.yaml`；移除仓库根目录
  遗留的调试脚本 `dbg-ap.test.mts`。

### 验证

- `typecheck`、`build` 通过。
- `test` 88 项全部通过；删除路径的集成用例使用 `danger-full-access` 运行，
  在没有可用 OS 沙盒后端（如 macOS 无法使用 `sandbox-exec`）的主机上也可执行。

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
