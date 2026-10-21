/**
 * Built-in tool suppression.
 *
 * `apply_patch` is always registered by this plugin; the settings only decide
 * which built-in file-editing tools the model stops seeing. Suppression needs
 * three hooks because advertisement, guidance, and execution are separate:
 *
 *   - Advertisement: the tool list is assembled per agent step through the
 *     `system-prompt/assemble` waterfall, so filtering the assembled list hides
 *     the tool from the model.
 *   - Guidance: `@deepseek-ai/dsh-tool-fs` registers one `tool:write` /
 *     `tool:edit` section and derives its text from the tool registry, so the
 *     matching section is dropped with the tool — otherwise the prompt keeps
 *     describing a tool the model cannot call.
 *   - Execution: the agent loop resolves a call by NAME through the tool
 *     registry, which still holds the definition, so a monotonic guard denies a
 *     call that names a hidden tool.
 *
 * Why name-based instead of `ctx.tools.restrict`: in a shipped deployment the
 * built-ins are mounted by the agent preset (`dsh-web-app/presets/*.patch.yml`
 * lists a `tool-fs` row), so they are registered in the AGENT scope. A
 * restriction only masks inherited GLOBAL tools — a scope-local name is not
 * restrictable at all — so a restrict-only implementation silently hides
 * nothing. Filtering the assembly and guarding by name covers both layers.
 * To make the tools truly absent from the registry, disable them in the
 * composition instead (a `config: { edit: false, write: false }` row on
 * `@deepseek-ai/dsh-tool-fs`).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { BUILTIN_EDIT_TOOL, BUILTIN_WRITE_TOOL } from '../shared/constants.js'
import type { ResolvedApplyPatchSettings } from './settings-schema.js'

/** The tool this plugin adds (always offered). */
export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

/** Built-in tool names this plugin may hide, in display order. */
export const SUPPRESSIBLE_TOOLS = [BUILTIN_EDIT_TOOL, BUILTIN_WRITE_TOOL] as const

/** Prefix of the guidance sections `dsh-tool-fs` names after its tool. */
const TOOL_SECTION_PREFIX = 'tool:'

/**
 * The set of built-in tool names the current settings hide.
 *
 * The switches are volatile handles, so reading them here (instead of caching a
 * derived set) is what lets a settings change reach the next assembly.
 * @param config - the resolved entry config this host half was applied with.
 * @returns the current suppression set; empty when both switches are off.
 */
export function suppressedTools(config: ResolvedApplyPatchSettings): Set<string> {
  const hidden = new Set<string>()
  if (config.disableEdit.get()) hidden.add(BUILTIN_EDIT_TOOL)
  if (config.disableWrite.get()) hidden.add(BUILTIN_WRITE_TOOL)
  return hidden
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
 * Install the assembly hook. Returns the disposer.
 *
 * The hook drops hidden tools and their guidance sections; when nothing is
 * hidden it returns the assembly untouched (identity-stable for downstream
 * consumers).
 * @param ctx - plugin context carrying the `system-prompt/assemble` waterfall.
 * @param config - resolved volatile settings.
 * @returns the disposer removing the listener.
 */
export function installToolSuppressor(ctx: Context, config: ResolvedApplyPatchSettings): () => void {
  return ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    return withoutHiddenTools(await next(), suppressedTools(config))
  })
}

/**
 * Install the execution guard that denies suppressed tools. Returns the disposer.
 *
 * The assembly filter only changes what the model is OFFERED; a call is resolved
 * by name through the registry, so a hidden `edit` / `write` would still run. The
 * guard closes that gap for every layer the tool may be registered in.
 * @param ctx - plugin context carrying the tools service.
 * @param config - resolved volatile settings.
 * @returns the disposer removing the guard.
 */
export function installToolGuard(ctx: Context, config: ResolvedApplyPatchSettings): () => void {
  return ctx.tools.guard((execution) =>
    suppressedToolDenial(suppressedTools(config), execution.name),
  )
}

/**
 * Drop hidden tools and their guidance sections from one assembly (exported for tests).
 *
 * A section carries guidance for a tool when its name is `tool:<name>` — how
 * `dsh-tool-fs` names its `tool:read` / `tool:write` / `tool:edit` sections. The
 * section text is decided from the tool registry, which still holds a hidden
 * definition, so the section must be removed here rather than left to render.
 * @param assembly - one assembled prompt.
 * @param hidden - current suppression set.
 * @returns the same assembly when nothing changed, else a filtered copy.
 */
export function withoutHiddenTools(assembly: PromptAssembly, hidden: Set<string>): PromptAssembly {
  if (hidden.size === 0) return assembly
  const tools = assembly.tools.filter((tool) => !hidden.has(tool.name))
  const sections = assembly.sections.filter((section) => {
    if (!section.name.startsWith(TOOL_SECTION_PREFIX)) return true
    return !hidden.has(section.name.slice(TOOL_SECTION_PREFIX.length))
  })
  if (tools.length === assembly.tools.length && sections.length === assembly.sections.length) {
    return assembly
  }
  return { ...assembly, tools, sections }
}
