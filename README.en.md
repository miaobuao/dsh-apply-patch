# dsh-apply-patch

[中文](README.md)

Adds a Codex-style `apply_patch` tool to DSH for creating, editing, deleting, and
moving files. Patch parsing and application follow Codex behavior, and every file
change goes through DSH's sandboxed capabilities.

## Installation

```bash
dsh plugin --profile web add github:miaobuao/dsh-apply-patch
```

## Usage notes

`apply_patch` is registered as soon as the plugin is installed; no extra
configuration is needed. The plugin's page lives in **Settings → Plugins →
dsh-apply-patch** (the same `plugins.bundle.config` slot as the official
web-search and agent-team pages). It carries three switches:

- **Hide the built-in `edit` tool** (`disableEdit`, on by default): targeted text
  edits are handled by `Update File`.
- **Hide the built-in `write` tool** (`disableWrite`, on by default): whole-file
  writes are handled by `Add File` / `Update File`.
- **Allow overwriting unread files** (`allowUnobservedOverwrite`, on by default):
  see below.

### The Tool call card

An `apply_patch` call in the conversation renders through a dedicated card (the
`apply_patch` key of the `tool.call.toolview` slot) instead of the generic Tool
card's raw argument text:

- The collapsed row derives its title from the patch's own actions and file
  names: a single file reads “Update src/a.ts”, “Add src/b.ts”, “Delete
  old.txt”, or “Move a.ts → b.ts”; several files aggregate by action into
  “Update 3 files · src/a.ts, src/b.ts, src/c.ts” (every name in patch order;
  the single-line title truncates with an ellipsis when it overflows), or
  “Edit 3 files · …” when the actions differ. The row also shows the total
  `+A -R` lines.
- The expanded row lists each file operation in patch order (`A` add / `M`
  update / `D` delete / `M →` move); paths open from the row, and each
  operation carries its diff lines plus totals. A long diff folds its middle:
  each edge keeps three changed lines plus one context line outside them;
  “Show N lines” reveals the rest and “Collapse” folds it back.
- While the `patch` argument streams, operations appear as soon as their hunk
  headers arrive; once settled, each operation is marked applied or not
  applied, and a failure shows the error text with “x/y applied”.

The card derives everything from the logged call arguments and result, so
replaying an older session renders the same way. The Client half imports no
other Harness Client package (it follows the slot's public contract) and styles
itself with `--dsw-alias-*` theme tokens only, so it follows the host's
light/dark switch.

### Hiding the built-in tools

Hiding uses two independent mechanisms, both keyed by tool name so they do not
care which layer a tool is registered in:

**Assembly filter (`system-prompt/assemble`)** makes the tools invisible:

- The tool list assembled for each step drops the hidden tools; the next step
  reflects a switch, with no restart.
- The matching guidance sections (`tool:edit` / `tool:write`) are dropped with
  them. Their text is derived by `@deepseek-ai/dsh-tool-fs` from the tool
  registry, which still holds the definition, so filtering only the tool list
  would leave the prompt describing a tool the model can no longer call.

**Execution guard (`ctx.tools.guard`)** closes the remaining entry:

- Denies any call by name, with or without an agent scope.

`ctx.tools.restrict` is deliberately not used: it can only mask the GLOBAL tools
an agent inherits, while a shipped deployment mounts `@deepseek-ai/dsh-tool-fs`
from the agent preset (the `tool-fs` row in
`dsh-web-app/presets/*.patch.yml`), so the tools are registered in the AGENT
scope and a scope-local name is not restrictable at all — a restrict-only
implementation hides nothing. To remove the tools from the registry for real,
disable them in the composition: give the `@deepseek-ai/dsh-tool-fs` row
`config: { edit: false, write: false }`.

Each switch is read from the volatile config at the point of use
(`config.<field>.get()`); flipping one does not reload the plugin.

- It denies a direct, agentless call to a hidden global tool.

### Overwriting unread files

On by default and matching Codex: `Add File` / `Move to` may replace an existing
file the model never read, and `Delete File` may remove one. Turning it off
requires a prior read for those three operations, otherwise the call returns the
read-before-write policy error. `Update File` is unaffected (a matching hunk
already proves the model read the file).

## Behavior and guarantees

- Multi-file patches run strictly in patch order: no prefetching, no parallelism.
- A failure never rolls back: changes already applied stay applied. Failures in
  the application stage throw a structured `ApplyFailure` carrying `stage` (the
  failing step: `resolve` / `add` / `delete` / `read` / `derive` (pure text
  derivation, where a context mismatch surfaces) / `verify` (the version taken
  again before writing) / `update` / `move-write` / `move-remove`), `applied`
  (committed `A`/`M`/`D` entries), `affected` (paths grouped by added / modified /
  deleted), `code`, `landedAt`, and `removal`. When earlier changes landed, the
  model-facing message ends with the “Applied before the failure:” list. Patch
  text that does not parse still throws `PatchParseError`.
- `*** Move to:` onto the source path is treated as an in-place update instead of
  write-then-delete.
- `Update File` takes the version once more between read and write; a file
  changed in that window fails with `FS_STALE_VERSION` and records no read
  observation for it.
- `Delete File` and the removal half of `Move to` run through the DSH sandboxed
  shell (`rm -- <path>`), so the host must mount a sandboxed shell. When it is
  missing, both delete and move fail before any file changes (a move fails before
  writing its destination).
- Removal is check-then-delete and **not atomic**: the sandbox capability layer
  exposes no version-guarded remove. The version is taken once more immediately
  before `rm`: `Delete File` does so only in strict mode (with **Allow overwriting
  unread files** off), while `Move to` guards the source version in both modes
  (its destination holds content derived from exactly that version). This narrows
  but cannot close the race window.
- `Move to` is write-destination-then-remove-source and does not preserve the
  source file mode (the upstream `FileSystem` exposes no remove / rename
  capability). If the destination was written but source removal is unconfirmed:
  when no removal started, the message says the destination was written and the
  source is still in place; when a removal was requested but cannot be confirmed,
  the message says the removal is unconfirmed and asks you to inspect both paths
  before retrying, adding “Removal outcome is unknown for <path>…” when the
  outcome is genuinely unknown.
- Each removal spawns one sandboxed shell, so per-file failure attribution and
  ordering are preserved.

## Environment selection

A patch may contain `*** Environment ID: <id>`: the parser only enforces that it
appears at most once and is non-empty, then **discards the line**. It never
switches environments; hunk paths always resolve against the session working
directory.

## Compatibility

- `peerDependencies` declares `@deepseek-ai/dsh-*` as `^0.2.1-alpha.1` and
  `@deepseek-ai/cordis` as `~4.0.5-alpha.1`.
- Hosts from `0.2.1-alpha.1` on are supported. `0.1.x` is not supported: the
  plugin page needs `configForms` (the old `settingsScope` era is incompatible),
  and the host half needs the scoped `tools.restrict` and the `agents` service.
- This repository develops and verifies against `@deepseek-ai/*` `0.2.1-alpha.1`
  (pinned in `devDependencies`); `typecheck` and `test` pass on that baseline.

## License and attribution

Based on [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch),
modified by miaobuao and distributed as a whole under [GPL-3.0-or-later](LICENSE).
The original copyright and MIT license are retained in
[LICENSES/MIT.txt](LICENSES/MIT.txt). Apache-2.0 terms for Codex-derived adaptations
and test fixtures are in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
See [NOTICE](NOTICE) for attribution and modification details.
