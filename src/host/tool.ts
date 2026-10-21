/**
 * Original work: Copyright (c) 2026 fonlan (MIT; see LICENSES/MIT.txt).
 * Modifications: Copyright (c) 2026 miaobuao.
 * Modified 2026-10-20: Codex compatibility and regression coverage.
 * This fork is distributed under GPL-3.0-or-later; see LICENSE and NOTICE.
 */
/**
 * The `apply_patch` tool definition.
 *
 * Model-facing name and argument shape mirror OpenAI Codex's apply_patch
 * tool ({"command":["apply_patch","*** Begin Patch\n..."]}) so GPT-family
 * models that were trained on codex call it without adaptation: one `patch`
 * argument carrying the full codex patch document.
 *
 * The description carries only what the model cannot discover from its
 * parameters or from an error message; the grammar rules live on the `patch`
 * parameter, next to the value they constrain.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { parsePatch } from './parser.js'
import { applyHunks, renderSummary, type ApplyPatchCapabilities } from './applier.js'
import { APPLY_PATCH_TOOL_NAME } from '../shared/constants.js'

/** Model-facing description: what the tool does, plus the one document sample. */
export const APPLY_PATCH_DESCRIPTION = [
  'Apply a codex-style patch document to files in the workspace:',
  '',
  '```',
  '*** Begin Patch',
  '*** Update File: path/to/file.py',
  '@@ optional context line',
  '- line to remove',
  '+ line to add',
  ' context line',
  '*** Add File: path/to/new.py',
  '+file content',
  '*** Delete File: path/to/old.py',
  '*** End Patch',
  '```',
  '',
  'A failed patch is not rolled back: whatever was applied before the failure stays applied.',
  'Relative paths resolve against the session working directory.',
].join('\n')

/** Argument schema, exported so tests assert the rules the model actually gets. */
export const APPLY_PATCH_PARAMETERS = {
  patch: {
    type: 'string',
    required: true,
    description: [
      'The complete patch document: one `*** Begin Patch` / `*** End Patch` pair holding one or more file hunks.',
      'Inside an Update hunk, `*** Move to: <path>` writes the updated content to that path and removes the original, and `*** End of File` anchors the block at the end of the file.',
    ].join(' '),
  },
} as const satisfies ParameterSchemaSpec

/** Capability faces the tool needs from the host composition. */
export interface ToolFaces {
  fs: FileSystem
  /**
   * Sandboxed shell, resolved per execution; absent when the deployment mounts
   * none (Delete then errors). Resolved lazily so a later-mounted shell is seen.
   */
  resolveShell(): ShellExecutor | undefined
  /** Whether Add/Move/Delete may touch a target the model never read. */
  resolveAllowUnobservedOverwrite(): boolean
  /** Resolve the per-session sandbox policy for one execution. */
  resolvePolicy(exec: ToolExecution): SandboxExecutionPolicy | undefined
  /** Session workspace cwd (relative hunk paths resolve against it). */
  resolveCwd(exec: ToolExecution): string | undefined
}

/** Register the apply_patch tool (host side). */
export function registerApplyPatchTool(
  ctx: Context,
  faces: ToolFaces,
): () => void {
  return ctx.tools.register(defineTool({
    name: APPLY_PATCH_TOOL_NAME,
    description: APPLY_PATCH_DESCRIPTION,
    parameters: APPLY_PATCH_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const patch: unknown = args.patch
      if (typeof patch !== 'string' || patch.length === 0) {
        throw new Error(
          'apply_patch: the `patch` argument is empty — pass the whole document from '
          + '`*** Begin Patch` to `*** End Patch`',
        )
      }
      const hunks = parsePatch(patch)

      const policy = faces.resolvePolicy(exec)
      const cwd = faces.resolveCwd(exec)
      const resolveTarget = (path: string): Promise<FsTarget> =>
        faces.fs.resolve(path, {
          ...cwd !== undefined ? { cwd } : {},
          signal: exec.signal,
        })

      const capabilities: ApplyPatchCapabilities = {
        fs: faces.fs,
        shell: faces.resolveShell(),
        observe: (target, observation) => {
          ctx.emit('fs/observed', target, observation, exec)
        },
        writeIntent: (target: FsTarget): Promise<FsWriteIntent | undefined> =>
          ctx.waterfall('fs/write-intent', target, exec, () => undefined),
      }

      const affected = await applyHunks(
        hunks,
        resolveTarget,
        capabilities,
        policy,
        exec.signal,
        { allowUnobservedOverwrite: faces.resolveAllowUnobservedOverwrite() },
      )
      return renderSummary(affected)
    },
  }))
}
