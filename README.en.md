# dsh-apply-patch

DSH plugin: inject a **codex-style `apply_patch` tool** for models.

GPT-family models were trained heavily on OpenAI Codex's `apply_patch` tool, so when you use a GPT model inside DSH it instinctively calls `apply_patch` — but DSH does not ship that tool by default, causing errors. This plugin adds it through DSH's plugin system, and every mutation goes through DSH's built-in sandbox — never bypassing it.

## Features

- **`apply_patch` tool**: byte-compatible with the OpenAI Codex patch format (`*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` / `*** End of File` / `*** End Patch`), including lenient gpt-4.1-style heredoc (`<<'EOF' ... EOF`) unwrapping.
- **Sandboxed writes**: all file mutations go through `ctx.fs` (the DSH sandboxed filesystem); deletes run through the sandboxed shell. Sandbox denials surface as `[sandbox: ...]` errors — never bypassed.
- **Model-conditional injection**: one dropdown in the settings card:
  - **Off** — never inject `apply_patch`
  - **GPT models only** (default) — inject only for models whose id starts with `gpt-`
  - **All models** — inject for every model
- **Settings card**: 设置 → 插件 → 插件配置 → Apply Patch; the choice is written to this entry's config and the entry restarts with it.

## Install

Install into a profile (default `web`) with the `dsh plugin` command:

### From GitHub

```bash
# default branch (the repo ships a prepare build script; pnpm builds it)
dsh plugin --profile web add github:miaobuao/dsh-apply-patch

# specific release tag
dsh plugin --profile web add github:miaobuao/dsh-apply-patch#main
```

### Local source link (development)

```bash
pnpm build
dsh plugin --profile web add .
```

After install the plugin mounts through `cordis.patch.yml`: the host registers the `apply_patch` tool and declares the injection scope through its `Config` schema (dsh ≥ 0.1.7 derives the settings form from it and stores the choice in this entry's config); the web client registers the `settings.section` settings page (设置 → 插件 → 插件配置 → Apply Patch). **Restart the dsh web process after install.**

### Uninstall

```bash
dsh plugin --profile web remove @fonlan/dsh-apply-patch
```

### Upgrade

```bash
dsh plugin --profile web update @fonlan/dsh-apply-patch
```

## Usage

Models (especially GPT) call `apply_patch` exactly as they would in Codex:

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

The tool returns the codex-style summary:

```
Success. Updated the following files:
M /path/to/hello.py
A /path/to/new.py
D /path/to/old.py
```

## Sandbox notes

| Operation | Sandbox path |
| --- | --- |
| Add / Update / Move writes | `ctx.fs.writeText` (sandboxed filesystem; honors the session sandbox mode and workspace root) |
| Delete / Move removal | `ctx.shell` (sandboxed bash `rm`, same policy) |

- Under `read-only` every write is denied: `[sandbox: file access denied under read-only mode]`.
- Under `workspace-write` only paths inside the workspace root (plus `/tmp` per policy) are writable.
- The observation policy (fs-observation-policy) requires read-before-write; the tool performs stat/read/observe/write internally.

## How it works

1. The plugin `Config` schema declares the single `mode` field (marked `volatile()`, so `apply()` receives a live handle it re-reads on every tool-list assembly); dsh ≥ 0.1.7 derives the settings form from that schema and stores the choice in this entry's config.
2. `ctx.tools.register` registers the `apply_patch` tool via `defineTool`.
3. Hooks the `system-prompt/assemble` waterfall: when the per-step tool list is assembled, it keeps `apply_patch` only when `mode` + the session's current model allow it.
4. Model resolution prefers `variables.model` from the assembled prompt (the authoritative value injected by the model-selection layer — zero lag on model switch), falling back to the `agent/request` captured route, the session's logged request header, then `agentDefaultModel`.

## Development

```bash
pnpm install
pnpm build        # host + client bundles
pnpm typecheck
pnpm test         # unit (parser/applier) + integration (real cordis + sandboxed fs)
```

## License

This is a fork of [fonlan/dsh-apply-patch](https://github.com/fonlan/dsh-apply-patch),
modified by miaobuao on 2026-10-20 and distributed as a whole under
**GPL-3.0-or-later**. See [LICENSE](LICENSE) for GPLv3; you may use version 3
or, at your option, any later version.

The upstream copyright, `Copyright (c) 2026 fonlan`, and complete MIT notice
are retained in [LICENSES/MIT.txt](LICENSES/MIT.txt). The upstream MIT grant
remains valid for the original material. Apache-2.0 terms for Codex-derived
adaptations and test fixtures are in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
See [NOTICE](NOTICE) for attribution.

Install this fork from the GitHub URL above. The npm package
`@fonlan/dsh-apply-patch` belongs to upstream and does not represent this fork.
Distributions of built packages must include access to corresponding source
and build files for the same version.

## Codex compatibility

Patch parsing and application target openai/codex commit
`014489466a1739c2c563cdfe57880c2c7c8680e3`, with 25 upstream scenario fixtures.
Add may overwrite existing files. Matching includes Unicode punctuation fallback;
updates preserve source context and LF/CRLF/CR endings, and new lines use the
first source ending. Pure additions append after all source lines. EOF matching
never searches backwards. Move headers must precede chunks; a new chunk after
EOF requires `@@`. Bare blank lines after Add/Delete are invalid; inside Update
they are context lines.

The DSH adapter retains JSON `{ patch: string }`, sandboxed filesystem writes and
shell deletion. Codex freeform transport, streaming diff events, execution delta
tracking and environment routing are not provided. Environment IDs are currently
syntax-checked only; execution uses the DSH session directory. Patches are
sequential and do not roll back prior writes on failure.
