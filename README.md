# dsh-apply-patch

[English](README.en.md)

为 DSH 提供 Codex 风格的 `apply_patch` 工具，支持新增、修改、删除和移动文件。
补丁解析与应用行为参照 Codex，所有文件变更都经 DSH 的沙盒能力完成。

## 安装

```bash
dsh plugin --profile web add github:miaobuao/dsh-apply-patch
```

## 使用

安装后 `apply_patch` 立即注册，无需额外配置。插件页面位于 **设置 → 插件 →
dsh-apply-patch**（与网页搜索等官方插件同一槽位 `plugins.bundle.config`）。页面上有
三个开关：

- **隐藏内置 `edit` 工具**（`disableEdit`，默认开启）：定点文本编辑由 `Update File` 承担。
- **隐藏内置 `write` 工具**（`disableWrite`，默认开启）：整文件写入由 `Add File` /
  `Update File` 承担。
- **允许覆盖未读取的文件**（`allowUnobservedOverwrite`，默认开启）：见下。

### 工具调用卡片

对话里的 `apply_patch` 调用使用专用卡片（`tool.call.toolview` 槽位的 `apply_patch`
键），不再显示通用工具卡片的原始参数文本：

- 折叠行的标题直接由补丁动作与文件名生成：单文件是「更新 src/a.ts」「新增
  src/b.ts」「删除 old.txt」「移动 a.ts → b.ts」，多文件按动作聚合为「更新 3 个
  文件 · src/a.ts、src/b.ts、src/c.ts」（文件名按补丁顺序全部列出，超出一行时
  自动省略号截断）或混合时「修改 3 个文件 · …」，并显示总 `+A -R` 行数；
- 展开行按补丁顺序列出每个文件操作（`A` 新增 / `M` 更新 / `D` 删除 / `M →` 移动），
  路径可点击在侧栏打开，并附带该操作的 diff 与行数；长 diff 默认折叠中间，首尾
  各保留 3 行变化行（外侧再带 1 行上下文），点击「展开 N 行」看**完整** diff
  （虚拟化渲染，只有可视行进入 DOM），展开后可再「收起」；折叠态只做计数扫描，
  不保留行文本，流式阶段仍有 200 行预览上限、调用结束后解除；
- 运行中随 `patch` 参数流式列出已经出现的操作；结束后按结果标注「已应用 /
  未执行」，失败时显示错误原文与「已应用 x/y」。
- 替换行在红绿行底色内，以更强的底色标出改动。对每个 `@@` 块，把上下文和删除行重建
  为旧文本、上下文和新增行重建为新文本，用 diff-match-patch 对整块做一次字符级 diff
  和 `diff_cleanupSemantic`，再按换行把编辑脚本投影回行。这样拆行、合行、前插行、
  中间插行都按内容对齐；多出来的整行就是新增或删除，不会被硬配给某条旧行。带位置
  或标签的 `@@` 显示 hunk header；行号取自 `@@ -a,b +c,d @@`，裸 `@@` 不显示 header
  和行号，因为 patch 本身没有绝对位置；后续裸块之间用细分隔线分开。
  改动段使用更强的主题底色并铺满行高，长行自动换行；超过 800 行的 diff 仍使用固定
  行高虚拟化和横向滚动，避免展开大 patch 时一次性铺满 DOM。精确保留空白和源文本，
  高亮边界不会拆开 emoji 或组合字符。块过大或缺少 grapheme segmenter 时保留行级底色。

卡片只从会话日志记录的调用参数与结果推导，历史会话回放同样生效。客户端半边不导入
其它 Harness Client 包（只看槽位的公开契约），样式只使用 `--dsw-alias-*` 主题
token，随宿主明暗主题切换。

### 隐藏内置工具

隐藏由两个彼此独立的机制组成，都按工具名工作，因此不关心工具注册在哪一层：

**装配过滤（`system-prompt/assemble`）** 负责“看不见”：

- 每个步骤组装出的工具清单里去掉被隐藏的工具；紧接着的步骤生效，不需要重启。
- 同时去掉同名的引导段落（`tool:edit` / `tool:write`）。这些段落的文本由
  `@deepseek-ai/dsh-tool-fs` 依据工具注册表生成，注册表里仍留着定义，所以只过滤工具
  清单会让提示继续描述一个模型已经不能调用的工具。

**执行守卫（`ctx.tools.guard`）** 负责堵住剩余入口：

- 按名拒绝任何调用，无论它是否带 agent 作用域。

之所以不采用 `ctx.tools.restrict`：它只能遮住 agent 继承的**全局**工具，而实际部署里
`@deepseek-ai/dsh-tool-fs` 由 agent preset 挂载（`dsh-web-app/presets/*.patch.yml` 中的
`tool-fs` 行），工具注册在 **agent 作用域**，作用域本地的名字根本不可限制，只做限制会
一个工具都遮不住。若要让工具真正从注册表消失，应在组合层关闭它们：给
`@deepseek-ai/dsh-tool-fs` 行加 `config: { edit: false, write: false }`。

开关值在每次使用时从 volatile 配置读取（`config.<field>.get()`），改开关不会重新加载
插件。

### 覆盖未读取的文件

默认开启，与 Codex 一致：`Add File` / `Move to` 可以覆盖已存在但模型没读过的文件，
`Delete File` 也可以直接删除。关闭后，这三类操作要求模型先读取目标，否则返回读后写
策略的错误。`Update File` 不受影响（补丁上下文匹配本身即证明模型读过文件）。

## 行为与保证

- 多文件补丁严格按补丁顺序执行，不并行、不预取。
- 失败不回滚：已生效的改动保留。应用阶段的失败以结构化 `ApplyFailure` 抛出，字段包含
  `stage`（失败步骤：`resolve` / `add` / `delete` / `read` / `derive`（纯文本派生，
  上下文匹配失败出现在这里）/ `verify`（写入前再取版本）/ `update` / `move-write` /
  `move-remove`）、`applied`（已生效的 `A`/`M`/`D` 条目）、`affected`（按新增 / 修改 /
  删除分组）、`code`、`landedAt`、`removal`。已有改动生效时，面向模型的错误消息末尾
  带 “Applied before the failure:” 列表；补丁文本解析失败仍抛 `PatchParseError`。
- `*** Move to:` 指向源文件自身时按原地更新处理，不会先写后删。
- `Update File` 在读取之后、写入之前再取一次版本；期间文件被外部改动时以
  `FS_STALE_VERSION` 失败，并且不为该文件记录读取观察。
- `Delete File` 与 `Move to` 的删除步骤经 DSH 沙盒 shell 执行（`rm -- <path>`），需要
  宿主挂载 sandboxed shell。缺少 shell 时，删除与移动都在改动任何文件之前失败
  （`Move to` 在写目标之前）。
- 删除是“检查后删除”，**不是原子操作**：沙盒能力层没有带版本条件的删除原语。执行 `rm`
  前会再取一次版本：`Delete File` 只在严格模式（关闭“允许覆盖未读取的文件”）下校验；
  `Move to` 在两种模式下都校验源文件版本（目标内容正是基于该版本派生）。这缩小但不消除
  竞态窗口。
- `Move to` 实现为“先写目标、再删源”，不保留源文件权限位（上游 `FileSystem` 没有
  remove / rename 能力）。若目标已写入而源删除未获确认：确定为“未启动删除”时，消息说明
  目标已写入、源文件仍在原处；已请求删除但无法确认时，消息说明源删除未确认、要求在重试
  前检查两个路径，并在结果未知时另附 “Removal outcome is unknown for <path>…”。
- 每次删除单独启动一次沙盒 shell，以保留逐文件的失败归因与顺序语义。

## 环境选择

补丁中可出现 `*** Environment ID: <id>`：解析器只校验它最多出现一次、且不能为空，然后
**丢弃该行**，不据此切换环境。hunk 路径始终按会话工作目录解析。

## 兼容性

- `peerDependencies` 声明：`@deepseek-ai/dsh-*` 为 `^0.2.1-alpha.1`，
  `@deepseek-ai/cordis` 为 `~4.0.5-alpha.1`。
- 支持 `0.2.1-alpha.1` 起的宿主。`0.1.x` 不受支持：客户端设置页依赖 `configForms`
  （旧 `settingsScope` 时代已不兼容），宿主侧依赖作用域 `tools.restrict` 与 `agents`
  服务。
- 本仓库的开发与验证基线：`@deepseek-ai/*` `0.2.1-alpha.1`（`devDependencies` 固定），
  `typecheck` 与 `test` 在该基线上通过。

## 许可与来源

本项目基于 [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch)，
由 miaobuao 修改，整体按 [GPL-3.0-or-later](LICENSE) 分发。
原作者版权及 MIT 许可保留于 [LICENSES/MIT.txt](LICENSES/MIT.txt)。
Codex 相关改编和测试数据的 Apache-2.0 许可见
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，完整来源及修改说明见 [NOTICE](NOTICE)。
