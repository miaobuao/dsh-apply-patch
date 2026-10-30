/**
 * dsh-apply-patch host half.
 *
 * Always registers the codex-style `apply_patch` tool over DSH's built-in
 * sandbox (ctx.fs for Add/Update/Move writes, ctx.shell for Delete), and hides
 * the built-in file-editing tools the `dsh-apply-patch` settings namespace asks
 * to disable (`edit` / `write`, both from `@deepseek-ai/dsh-tool-fs`) through
 * `ctx.tools.restrict()` on each agent's own context.
 *
 * Installing the plugin is enough to enable `apply_patch`; the settings are the
 * two suppression switches plus the overwrite policy switch. The Web UI exposes
 * them on the plugin's own page in the Plugins center
 * (`plugins.bundle.config`), not in the settings sidebar.
 */
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: makes `ctx.sandboxPolicy` and `ctx.tools` typed.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { APPLY_PATCH_SETTINGS_NS } from './shared/constants.js'
import {
  ApplyPatchSettingsSchema,
  type ApplyPatchSettings,
  type ResolvedApplyPatchSettings,
} from './host/settings-schema.js'
import { registerApplyPatchTool, type ToolFaces } from './host/tool.js'
import { installToolSuppressor } from './host/injector.js'

export const name = 'dsh-apply-patch'

export const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
]

// The plugin's Config is the settings form: dsh >= 0.1.7 derives the settings
// page from this schema. Its resolved shape is `ResolvedApplyPatchSettings` —
// each switch arrives as a live volatile handle, not as the plain boolean
// `ApplyPatchSettings` describes — and every hook below reads the handle at the
// point of use, so a settings edit reaches the next step without re-applying
// the plugin.
export const Config = ApplyPatchSettingsSchema

/** Session cwd helper: the agent's workspace root. */
function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

export function apply(ctx: Context, config: ResolvedApplyPatchSettings): void {
  // 2. Register the tool unconditionally: installing the plugin enables it. The
  //    callbacks read their volatile switch where they are used, so a settings
  //    change needs no re-registration.
  const faces: ToolFaces = {
    fs: ctx.fs,
    resolveShell: () => ctx.get('shell'),
    resolveAllowUnobservedOverwrite: () => config.allowUnobservedOverwrite.get(),
    resolvePolicy(exec) {
      return ctx.sandboxPolicy.resolve({
        ...exec.agent !== undefined ? { session: exec.agent.session } : {},
      })
    },
    resolveCwd(exec) {
      return sessionCwd(exec)
    },
  }
  registerApplyPatchTool(ctx, faces)

  // Hide the built-in file-editing tools the settings ask to replace, through
  // the official per-agent restriction: schema presentation, lookup, and
  // dispatch stay aligned, and unloading this plugin lifts it again.
  installToolSuppressor(ctx, config)
}

export { ApplyPatchSettingsSchema, APPLY_PATCH_SETTINGS_NS }
export type { ApplyPatchSettings, ResolvedApplyPatchSettings }
