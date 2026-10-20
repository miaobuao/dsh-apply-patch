# dsh-apply-patch

[中文](README.md)

Adds a Codex-style `apply_patch` tool to DSH for creating, editing, deleting,
and moving files. Patch parsing and application follow Codex behavior, and all
file changes go through the DSH sandbox.

## Installation

```bash
dsh plugin --profile web add github:miaobuao/dsh-apply-patch
```

## Usage notes

- `apply_patch` is enabled as soon as the plugin is installed; no extra setting is needed.
- The plugin's page lives in **Settings → Plugins → dsh-apply-patch** (the same
  place as the official web-search and agent-team pages). Its two switches hide
  the built-in `edit` (targeted text edits) and `write` (whole-file writes)
  tools; both default to hidden, so the model starts with `apply_patch` only.
- Turning a switch off restores the corresponding built-in tool.
- `Add File` can overwrite existing files.
- Multi-file patches run sequentially; a failure does not roll back earlier changes.
- Operations use the DSH session directory. Selecting another environment through
  `Environment ID` is not supported.

## License and attribution

Based on [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch),
modified by miaobuao and distributed as a whole under [GPL-3.0-or-later](LICENSE).
The original copyright and MIT license are retained in
[LICENSES/MIT.txt](LICENSES/MIT.txt). Apache-2.0 terms for Codex-derived adaptations
and test fixtures are in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
See [NOTICE](NOTICE) for attribution and modification details.
