/**
 * The Apply Patch page in the Plugins center (设置 -> 插件 -> dsh-apply-patch).
 *
 * Registers into the `plugins.bundle.config` keyed slot, so the form renders on
 * this bundle's own page in the plugin center — the same placement the official
 * web-search and agent-team pages use — instead of adding an entry to the
 * settings sidebar. Content: two switches that hide DSH's built-in `edit` and
 * `write` tools while the plugin's `apply_patch` tool stays enabled, plus the
 * `allowUnobservedOverwrite` policy switch. Writes go through the client
 * `configForms` scope; the Host reads its volatile settings at use time.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Switch } from './switch'
import {
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
} from '../shared/constants'
import { LOCALE_NS } from './locales'
import styles from './plugin-config.css'

/** Effective settings document as the bound form projects it. */
export interface ApplyPatchConfigValue {
  disableEdit?: boolean
  disableWrite?: boolean
  allowUnobservedOverwrite?: boolean
}

/** Props the plugin center's bundle page supplies to a configuration section. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the form. */
  view: 'summary' | 'page'
}

/** The inject face this page receives from its registration. */
export interface ApplyPatchConfigFace {
  scope: ConfigForm<ApplyPatchConfigValue>
}

export interface ApplyPatchConfigProps extends PluginConfigViewProps, ApplyPatchConfigFace {}

/** Build the page component bound to the client locale service. */
export function makeApplyPatchConfig(ctx: ClientContext): (props: ApplyPatchConfigProps) => JSX.Element | null {
  const t = ctx.locale.bind(LOCALE_NS)

  return function ApplyPatchConfig(props: ApplyPatchConfigProps): JSX.Element | null {
    const { scope, view } = props
    const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
    const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
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
        const landed = await scope.mutate([{ op: 'set', path: [field], value: next }], snapshot.revision)
        if (!landed) throw new Error(t('saveConflict'))
        setSaved(true)
      } catch (cause) {
        setError(t('saveFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      } finally {
        setBusy(false)
      }
    }, [scope, t, snapshot.revision])

    if (snapshot.status === 'unavailable') return null
    // `writable` is false while the first Host document is still arriving, so the
    // read-only notice is tied to a ready document instead of to a missing one.
    const loading = snapshot.status === 'loading'
    const writable = snapshot.status === 'ready' && snapshot.writable

    // The bundle page asks for `summary` when it lists the section elsewhere and
    // `page` for the real form; this page only ever contributes the form.
    if (view !== 'page') return null

    return (
      <div className="ap-config">
        <style>{styles}</style>
        <header className="ap-config-head">
          <h3 className="ap-config-title">{t('sectionTitle')}</h3>
          <p className="ap-config-sub">{t('sectionSub')}</p>
        </header>
        <div className="ap-config-body">
          {!loading && !writable && (
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
