/**
 * dsh-apply-patch host half.
 *
 * Always registers the codex-style `apply_patch` tool over DSH's built-in
 * sandbox (ctx.fs for Add/Update/Move writes, ctx.shell for Delete), and hides
 * the built-in file-editing tools the `dsh-apply-patch` settings namespace asks
 * to disable (`edit` / `write`, both from `@deepseek-ai/dsh-tool-fs`).
 *
 * Installing the plugin is enough to enable `apply_patch`; the settings are the
 * two suppression switches plus the overwrite policy switch. The Web UI exposes
 * them on the plugin's own page in the Plugins center
 * (`plugins.bundle.config`), not in the settings sidebar.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import {
  APPLY_PATCH_SETTINGS_NS,
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
  type ApplyPatchSettings,
} from './shared/config.js'
import {
  ApplyPatchSettingsSchema,
  type LiveSettingsField,
  type ResolvedApplyPatchSettings,
} from './host/settings-schema.js'
import { registerApplyPatchTool, type ToolFaces } from './host/tool.js'
import {
  installToolGuard,
  installToolSuppressor,
  suppressedTools,
  type SuppressionFlags,
} from './host/injector.js'

export const name = 'dsh-apply-patch'

export const inject = [
  'tools',
  'fs',
  'systemPrompt',
  'sandboxPolicy',
]

// The plugin's Config is the settings form: dsh >= 0.1.7 derives the settings
// page from this schema, and a config change restarts the entry, so `apply`
// always sees the current switches. Its resolved shape is
// `ResolvedApplyPatchSettings` — each switch arrives as a live volatile handle,
// not as the plain boolean `ApplyPatchSettings` describes.
export const Config = ApplyPatchSettingsSchema

/** Session cwd helper: the agent's workspace root. */
function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * The registered symbol cosmokit marks a volatile cell with.
 *
 * `Symbol.for` makes it reachable across module copies (the `link:` install
 * loads its own cosmokit), which is how dsh-settings distinguishes a cell from
 * the plain value — same check as the sibling dsh-ssh host half.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a resolved config field is a live volatile cell rather than its value. */
function isVolatileCell(value: unknown): value is LiveSettingsField<unknown> {
  if (typeof value !== 'object' || value === null) return false
  return VOLATILE_WRITE in value || typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read one boolean switch out of the entry config.
 *
 * A `volatile()` field does NOT arrive as its value on dsh >= 0.1.7: it arrives
 * as a live cosmokit cell (`{ get() }`, `typeof === 'object'`,
 * `JSON.stringify` → `{}`). Reading `config.disableEdit` directly would return
 * the cell (truthy for every state), so the cell is unwrapped here; it is read
 * on every assembly so a settings edit takes effect without re-registering.
 * @param field - the value the config carries for this switch.
 * @param fallback - the composition default for an absent or unusable value.
 * @returns the switch value.
 */
function readSwitch(field: unknown, fallback: boolean): boolean {
  if (field === undefined || field === null) return fallback
  const value = isVolatileCell(field) ? field.get() : field
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Last suppression set per entry config object.
 *
 * `readSuppressed` runs on every system-prompt assembly (once per agent step)
 * and on every `tools.guard` decision, so rebuilding the Set each time is pure
 * churn. The entry config object is stable for the life of the entry; only the
 * volatile cell values inside it change, which the cached flag pair detects.
 */
interface SuppressionCache {
  disableEdit: boolean
  disableWrite: boolean
  hidden: Set<string>
}
const suppressionCache = new WeakMap<object, SuppressionCache>()

/**
 * The built-in tool names the current entry config asks to hide.
 *
 * Accepts both the schema's resolved shape (`ResolvedApplyPatchSettings`, each
 * switch a live handle) and a hand-written plain `ApplyPatchSettings` document.
 * @param config - the entry config this host half was applied with.
 * @returns the current suppression set; empty when both suppression switches are off.
 */
export function readSuppressed(
  config: ResolvedApplyPatchSettings | ApplyPatchSettings | undefined,
): Set<string> {
  const fields = config as { disableEdit?: unknown; disableWrite?: unknown } | undefined
  const flags: SuppressionFlags = {
    disableEdit: readSwitch(fields?.disableEdit, DEFAULT_DISABLE_EDIT),
    disableWrite: readSwitch(fields?.disableWrite, DEFAULT_DISABLE_WRITE),
  }
  const owner = typeof config === 'object' && config !== null ? config : undefined
  if (owner !== undefined) {
    const cached = suppressionCache.get(owner)
    if (cached !== undefined && cached.disableEdit === flags.disableEdit && cached.disableWrite === flags.disableWrite) {
      return cached.hidden
    }
  }
  const hidden = suppressedTools(flags)
  if (owner !== undefined) suppressionCache.set(owner, { ...flags, hidden })
  return hidden
}

export function apply(ctx: Context, config: ResolvedApplyPatchSettings): void {
  // 1. The switches come from the entry config (settings page / patch yaml);
  //    they are re-read from the live volatile handles on every assembly.
  const readSuppressedTools = () => readSuppressed(config)

  // 2. Optional sandboxed shell (needed only for *** Delete File:). It is
  //    resolved per tool execution, not captured here: a composition may mount
  //    or replace the shell service after this entry is applied.
  const sandboxPolicyService = ctx.get('sandboxPolicy')

  // 3. Register the tool unconditionally: installing the plugin enables it.
  const faces: ToolFaces = {
    fs: ctx.fs,
    resolveShell: () => ctx.get('shell') as ShellExecutor | undefined,
    resolveAllowUnobservedOverwrite: () => readSwitch(
      (config as { allowUnobservedOverwrite?: unknown }).allowUnobservedOverwrite,
      DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
    ),
    resolvePolicy(exec) {
      if (sandboxPolicyService === undefined) return undefined
      return sandboxPolicyService.resolve({
        ...exec.agent !== undefined ? { session: exec.agent.session } : {},
      })
    },
    resolveCwd(exec) {
      return sessionCwd(exec)
    },
  }
  const disposeTool = registerApplyPatchTool(ctx, faces)

  // 4. Hide the built-in file-editing tools the settings ask to replace: drop
  //    them from every assembled tool list AND deny calls that name them.
  const disposeSuppressor = installToolSuppressor(ctx, readSuppressedTools)
  const disposeGuard = installToolGuard(ctx, readSuppressedTools)

  ctx.effect(() => {
    return () => {
      disposeTool()
      disposeSuppressor()
      disposeGuard()
    }
  }, 'dsh-apply-patch: teardown')
}

export { ApplyPatchSettingsSchema, APPLY_PATCH_SETTINGS_NS }
export type { ApplyPatchSettings, ResolvedApplyPatchSettings }
