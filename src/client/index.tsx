/**
 * dsh-apply-patch client half: the plugin's configuration section in the
 * Plugins center (设置 -> 插件 -> dsh-apply-patch), one switch per built-in
 * file-editing tool. The host half always offers `apply_patch`, so this page
 * owns no enable/disable switch and does not add a settings-sidebar entry.
 */
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { APPLY_PATCH_SETTINGS_NS } from '../shared/constants'
import { LOCALE_NS, zh, en } from './locales'
import { makeApplyPatchConfig, type ConfigFormScopeFace } from './plugin-config'

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

/** Slots face (local, erased at build). */
interface Slots {
  inject(name: string, callback: () => unknown): unknown
  register(
    def: {
      name: string
      key: string
      locale?: string
      inject?: () => unknown
    },
    component: unknown,
  ): unknown
}

/**
 * The client `configForms` service (subset).
 *
 * dsh 0.1.7 dropped the old `settingsScope` service and binds plugin settings
 * forms by entry id instead. Declared structurally because this package's
 * devDependency typings predate it — the same shape the official settings pages
 * bind.
 */
interface ConfigForms {
  /** Bound form for one entry id (the entry's Config schema drives the writes). */
  get(entryId: string): ConfigFormScopeFace
  /** Run `register` while the host serves any of `entryIds`; returns the withdrawal. */
  whileServed(entryIds: string[], register: () => unknown): () => void
}

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale', 'configForms']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => off()
  }, 'dsh-apply-patch: dictionaries')

  const services = ctx as unknown as { slots: Slots; configForms?: ConfigForms }
  const forms = services.configForms
  // A host without the config-form service (pre-0.1.7) keeps the plugin active
  // but cannot render this section — never touch an absent service directly.
  if (forms === undefined) return

  const ApplyPatchConfig = makeApplyPatchConfig(ctx)
  const scope = forms.get(APPLY_PATCH_SETTINGS_NS)

  // Register the bundle configuration section while the host serves this entry:
  // the plugin center renders it on the bundle's page, between the description
  // and the rows. The bound config form reaches the page through the inject
  // face; withdrawing the entry removes the section with it.
  ctx.effect(
    () =>
      forms.whileServed([APPLY_PATCH_SETTINGS_NS], () =>
        services.slots.inject('plugins.bundle.config', () =>
          services.slots.register(
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
}
