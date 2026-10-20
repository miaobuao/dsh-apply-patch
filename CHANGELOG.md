# 变更记录

## Unreleased

- **Breaking**: `apply_patch` is now always enabled on install; the `mode`
  setting (`off` / `gpt-only` / `all`) is replaced by two switches,
  `disableEdit` and `disableWrite`, which hide the built-in `edit` and `write`
  tools (both default to hidden). The settings entry moved from the settings
  sidebar to the plugin's own page in the Plugins center.

- Distribute this fork under GPL-3.0-or-later, preserving upstream MIT and Codex Apache-2.0 notices.

- Align patch parsing and application with Codex `0144894`: overwrite on Add, Unicode matching, source context and newline preservation, append placement, and EOF cursor/state constraints.
- Add 25 upstream compatibility fixtures and sandbox overwrite regression coverage.

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.1.6

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。
- 删除 `@deepseek-ai/dsh-invariants` devDependency：该包在 `0.2.1-alpha.1` 已下线，宿主侧 38 个包也一并移除了 `./invariant` 子路径导出。

**验证**：`pnpm install` / `typecheck` / `build` / `test`（43 项）全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
