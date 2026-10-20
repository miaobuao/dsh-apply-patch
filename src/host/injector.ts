/**
 * Built-in tool suppression.
 *
 * `apply_patch` is always registered by this plugin; the settings only decide
 * which BUILT-IN file-editing tools the model should stop seeing. The tool list
 * is assembled per agent step through the `system-prompt/assemble` waterfall,
 * so filtering the assembled list is enough: a hidden tool is neither offered
 * to the model nor callable by it in that step.
 *
 * Both hidden names belong to `@deepseek-ai/dsh-tool-fs`; the settings page
 * exposes one switch per tool, and the values are read from the live config
 * handles on every assembly, so a toggle takes effect without re-registering
 * the plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  BUILTIN_EDIT_TOOL,
  BUILTIN_WRITE_TOOL,
} from '../shared/config.js'

/** The tool this plugin adds (always offered). */
export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

/** Built-in tool names this plugin may hide, in display order. */
export const SUPPRESSIBLE_TOOLS = [BUILTIN_EDIT_TOOL, BUILTIN_WRITE_TOOL] as const

/** A snapshot of the two switches, already unwrapped from their volatile cells. */
export interface SuppressionFlags {
  disableEdit: boolean
  disableWrite: boolean
}

/** The set of built-in tool names the current settings hide. */
export function suppressedTools(flags: SuppressionFlags): Set<string> {
  const hidden = new Set<string>()
  if (flags.disableEdit) hidden.add(BUILTIN_EDIT_TOOL)
  if (flags.disableWrite) hidden.add(BUILTIN_WRITE_TOOL)
  return hidden
}

/** Read the current suppression set (called once per assembly). */
export type SuppressionReader = () => Set<string>

/**
 * Install the assembly hook. Returns the disposer.
 *
 * The hook drops hidden tools from the assembled list; when nothing is hidden
 * it returns the assembly untouched (identity-stable for downstream consumers).
 */
export function installToolSuppressor(ctx: Context, readSuppressed: SuppressionReader): () => void {
  return ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    return withoutTools(await next(), readSuppressed())
  })
}

/** Drop named tools from one assembly (exported for tests). */
export function withoutTools(assembly: PromptAssembly, hidden: Set<string>): PromptAssembly {
  if (hidden.size === 0) return assembly
  const tools: ToolSchema[] = assembly.tools
  const kept = tools.filter((tool) => !hidden.has(tool.name))
  if (kept.length === tools.length) return assembly
  return { ...assembly, tools: kept }
}
