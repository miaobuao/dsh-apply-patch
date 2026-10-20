/**
 * The Apply Patch page in the Plugins center (设置 -> 插件 -> dsh-apply-patch).
 *
 * Registers into the `plugins.bundle.config` keyed slot, so the form renders on
 * this bundle's own page in the plugin center — the same placement the official
 * web-search and agent-team pages use — instead of adding an entry to the
 * settings sidebar. Content: two switches that hide DSH's built-in `edit` and
 * `write` tools while the plugin's `apply_patch` tool stays enabled, plus the
 * `allowUnobservedOverwrite` policy switch. Writes go through the client
 * `configForms` scope (the transport the built-in pages use), so a flip
 * restarts the host entry with the new switches.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
} from '../shared/constants'
import { LOCALE_NS } from './locales'
import './plugin-config.css'

/** One write in the client config-form protocol (`settings/mutate` ops). */
export type ConfigFormOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Effective settings document as the bound form projects it. */
export interface ApplyPatchConfigValue {
  disableEdit?: boolean
  disableWrite?: boolean
  allowUnobservedOverwrite?: boolean
}

/** Snapshot of one bound client config form. */
export interface ConfigFormSnapshot {
  status?: string
  writable: boolean
  /** Effective document (the stored override merged over the composition default). */
  value?: ApplyPatchConfigValue | undefined
  /** Optimistic-concurrency revision this read is based on. */
  revision?: unknown
  [key: string]: unknown
}

/**
 * Bound client config form — the `configForms.get(<entry id>)` scope.
 *
 * dsh 0.1.7 replaced the old `settingsScope` service with `configForms`: the
 * scope is bound by entry id (not namespace) and writes ride
 * `mutate(ops, revision)` instead of `set(field, value)`. Declared structurally
 * because this package's devDependency typings predate it; keep in sync with
 * the `configForms` scope the official settings pages bind.
 */
export interface ConfigFormScopeFace {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  /** @returns false when the write was rejected as stale (revision moved on). */
  mutate(ops: ConfigFormOp[], revision?: unknown): Promise<boolean>
}

/** Props the plugin center's bundle page supplies to a configuration section. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the form. */
  view: 'summary' | 'page'
}

/** The inject face this page receives from its registration. */
export interface ApplyPatchConfigFace {
  scope: ConfigFormScopeFace
}

export interface ApplyPatchConfigProps extends PluginConfigViewProps, ApplyPatchConfigFace {}

/** Build the page component bound to the client locale service. */
export function makeApplyPatchConfig(ctx: ClientContext): (props: ApplyPatchConfigProps) => JSX.Element | null {
  const t: Translate = (() => {
    try {
      return ctx.locale.bind(LOCALE_NS) as unknown as Translate
    } catch {
      return (key: string) => key
    }
  })()

  return function ApplyPatchConfig(props: ApplyPatchConfigProps): JSX.Element | null {
    const { scope, view } = props
    const snapshot = useSyncExternalStore(
      (listener) => scope.subscribe(listener),
      () => scope.getSnapshot(),
    )
    const [busy, setBusy] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const disableEdit = snapshot.value?.disableEdit ?? DEFAULT_DISABLE_EDIT
    const disableWrite = snapshot.value?.disableWrite ?? DEFAULT_DISABLE_WRITE
    const allowUnobservedOverwrite = snapshot.value?.allowUnobservedOverwrite ?? DEFAULT_ALLOW_UNOBSERVED_OVERWRITE

    const change = useCallback(async (
      field: 'disableEdit' | 'disableWrite' | 'allowUnobservedOverwrite',
      next: boolean,
    ) => {
      setBusy(true)
      setError(null)
      setSaved(false)
      try {
        // Write against the revision this render was based on: the host rejects a
        // stale write instead of silently overwriting a concurrent change.
        const revision = scope.getSnapshot().revision
        const landed = await scope.mutate([{ op: 'set', path: [field], value: next }], revision)
        if (!landed) throw new Error(t('saveConflict'))
        setSaved(true)
      } catch (cause) {
        setError(t('saveFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      } finally {
        setBusy(false)
      }
    }, [scope, t])

    if (snapshot.status === 'unavailable') return null
    const writable = snapshot.writable

    // The bundle page asks for `summary` when it lists the section elsewhere and
    // `page` for the real form; this page only ever contributes the form.
    if (view !== 'page') return null

    return (
      <div className="ap-config">
        <header className="ap-config-head">
          <h3 className="ap-config-title">{t('sectionTitle')}</h3>
          <p className="ap-config-sub">{t('sectionSub')}</p>
        </header>
        <div className="ap-config-body">
          {!writable && (
            <p className="ap-config-readonly" role="status">{t('readOnly')}</p>
          )}
          <div className="ap-toggle-field">
            <label className="ap-toggle-row">
              <span className="ap-toggle-label">{t('disableEditLabel')}</span>
              <Switch
                checked={disableEdit}
                label={t('disableEditLabel')}
                disabled={busy || !writable}
                onChange={(next) => void change('disableEdit', next)}
              />
            </label>
            <p className="ap-toggle-hint">{t('disableEditHint')}</p>
          </div>
          <div className="ap-toggle-field">
            <label className="ap-toggle-row">
              <span className="ap-toggle-label">{t('disableWriteLabel')}</span>
              <Switch
                checked={disableWrite}
                label={t('disableWriteLabel')}
                disabled={busy || !writable}
                onChange={(next) => void change('disableWrite', next)}
              />
            </label>
            <p className="ap-toggle-hint">{t('disableWriteHint')}</p>
          </div>
          <div className="ap-toggle-field">
            <label className="ap-toggle-row">
              <span className="ap-toggle-label">{t('allowUnobservedOverwriteLabel')}</span>
              <Switch
                checked={allowUnobservedOverwrite}
                label={t('allowUnobservedOverwriteLabel')}
                disabled={busy || !writable}
                onChange={(next) => void change('allowUnobservedOverwrite', next)}
              />
            </label>
            <p className="ap-toggle-hint">{t('allowUnobservedOverwriteHint')}</p>
          </div>
          {busy && <p className="ap-config-status" role="status">{t('saving')}</p>}
          {!busy && saved && error === null && <p className="ap-config-status ap-config-status-ok" role="status">{t('saved')}</p>}
          {error !== null && <p className="ap-config-status ap-config-status-error" role="alert">{error}</p>}
        </div>
      </div>
    )
  }
}
