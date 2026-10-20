/**
 * Built-in tool suppression.
 *
 * `apply_patch` is always registered by this plugin; the settings only decide
 * which BUILT-IN file-editing tools the model should stop seeing. Suppression
 * has two halves, because hiding a tool and preventing a call are separate
 * operations in the host:
 *
 *   - Advertisement: the tool list is assembled per agent step through the
 *     `system-prompt/assemble` waterfall, so filtering the assembled list hides
 *     the tool from the model.
 *   - Execution: the agent loop resolves a call by NAME through the tool
 *     registry, which still holds the built-in definition even when it is not
 *     advertised. A monotonic `tools.guard` therefore denies a call that names
 *     a hidden tool, so a model that emits the name anyway (the system prompt
 *     still mentions `read` / `edit` / `write`) cannot execute it.
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

/** A snapshot of the two suppression switches, already unwrapped from their volatile cells. */
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

/** The `tools.guard` face this hook needs; absent on hosts that predate it. */
interface ToolsGuardFace {
  guard?: (guard: (execution: { readonly name: string }) => string | undefined) => () => void
}

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

/**
 * Denial reason for a direct call to a suppressed built-in tool.
 * @param hidden - current suppression set.
 * @param name - tool name the model called.
 * @returns the denial reason, or undefined when the tool is not suppressed.
 */
export function suppressedToolDenial(hidden: Set<string>, name: string): string | undefined {
  if (!hidden.has(name)) return undefined
  return `tool "${name}" is hidden by dsh-apply-patch; use apply_patch instead`
}

/**
 * Install the execution guard that denies suppressed tools. Returns the disposer.
 *
 * The assembly filter only changes what the model is OFFERED; the agent loop
 * resolves a call by name through the tool registry, so a hidden `edit` /
 * `write` call would still execute. The monotonic guard runs after the
 * extensible pre-execute policy and before the tool body, closing that gap.
 * Hosts without `tools.guard` keep the advertisement-only behaviour.
 */
export function installToolGuard(ctx: Context, readSuppressed: SuppressionReader): () => void {
  const tools = ctx.tools as unknown as ToolsGuardFace
  if (typeof tools.guard !== 'function') return () => {}
  return tools.guard((execution) => suppressedToolDenial(readSuppressed(), execution.name))
}

/** Drop named tools from one assembly (exported for tests). */
export function withoutTools(assembly: PromptAssembly, hidden: Set<string>): PromptAssembly {
  if (hidden.size === 0) return assembly
  const tools: ToolSchema[] = assembly.tools
  const kept = tools.filter((tool) => !hidden.has(tool.name))
  if (kept.length === tools.length) return assembly
  return { ...assembly, tools: kept }
}
