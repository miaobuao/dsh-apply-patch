/**
 * The plugin-local switch control.
 *
 * Copied from the Harness Web shell's own switch (a `<button role="switch">`
 * wrapping one thumb span, styled by `.ap-switch*` in plugin-config.css with the
 * same geometry, tokens, and transition). A plugin must not load another Harness
 * Client package as a module — those change without notice and a throw blanks the
 * whole slot entry — so the control is reproduced here under this plugin's class
 * prefix instead of importing the primitive.
 */
export function Switch({ checked, label, disabled, onChange }: {
  /** Current state. */
  checked: boolean
  /** Accessible name; the visible row label is rendered by the caller. */
  label: string
  /** Blocks interaction while a write is in flight or the deployment is read-only. */
  disabled: boolean
  /** Receives the next state after a user toggle. */
  onChange(checked: boolean): void
}): JSX.Element {
  return (
    <button
      className="ap-switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ap-switch-thumb" />
    </button>
  )
}
