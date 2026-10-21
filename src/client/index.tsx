/**
 * dsh-apply-patch client half: two surfaces registered from one bundle.
 *
 * 1. The plugin's configuration section in the Plugins center
 *    (设置 -> 插件 -> dsh-apply-patch) — one suppression switch per built-in
 *    file-editing tool plus the unread-overwrite policy switch. The host half
 *    always offers `apply_patch`, so this page owns no enable/disable switch
 *    and does not add a settings-sidebar entry.
 * 2. The `apply_patch` row in the conversation (`tool.call.toolview`, keyed by
 *    wire Tool name), which renders the patch as ordered file operations
 *    instead of the generic card's raw argument text.
 */
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { APPLY_PATCH_SETTINGS_NS, APPLY_PATCH_TOOL_NAME } from '../shared/constants'
import { LOCALE_NS, TOOL_LOCALE_NS, zh, en, toolZh, toolEn } from './locales'
import { makeApplyPatchConfig, type ApplyPatchConfigValue } from './plugin-config'
import { ApplyPatchRow } from './tool-row'

/**
 * The key this page registers in `plugins.bundle.config`.
 *
 * That slot is keyed by the BUNDLE package name and renders the section on the
 * bundle's own page in the plugin center. Here the bundle package name, the
 * settings namespace, and the loader entry id are all `dsh-apply-patch`: the
 * bundle patch inserts one row named after the package (cordis.patch.yml), and
 * the form binds that entry's config.
 */
const BUNDLE_NAME = APPLY_PATCH_SETTINGS_NS

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale', 'configForms']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const offSettings = ctx.locale.register(LOCALE_NS, { zh, en })
    const offTool = ctx.locale.register(TOOL_LOCALE_NS, { zh: toolZh, en: toolEn })
    return () => {
      offSettings()
      offTool()
    }
  }, 'dsh-apply-patch: dictionaries')

  const forms = ctx.configForms
  const ApplyPatchConfig = makeApplyPatchConfig(ctx)
  const scope = forms.get<ApplyPatchConfigValue>(APPLY_PATCH_SETTINGS_NS)

  // Register the bundle configuration section while the host serves this entry:
  // the plugin center renders it on the bundle's page, between the description
  // and the rows. The bound config form reaches the page through the inject
  // face; withdrawing the entry removes the section with it.
  ctx.effect(
    () =>
      forms.whileServed([APPLY_PATCH_SETTINGS_NS], () =>
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE_NAME,
              locale: LOCALE_NS,
              inject: () => ({ scope }),
            },
            ApplyPatchConfig,
          ),
        ),
      ),
    'dsh-apply-patch: plugin center page',
  )

  // Chat row: claim the `apply_patch` key of the keyed `tool.call.toolview`
  // slot, so the call renders as its parsed file operations instead of the
  // generic Tool card's raw patch text. Registration waits for the owning Tool
  // call tree to declare the slot and is withdrawn with it.
  ctx.effect(
    () =>
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: APPLY_PATCH_TOOL_NAME,
            locale: TOOL_LOCALE_NS,
          },
          ApplyPatchRow,
        ),
      ),
    'dsh-apply-patch: apply_patch tool view',
  )
}
