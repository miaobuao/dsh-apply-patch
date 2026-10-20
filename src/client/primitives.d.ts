/**
 * Minimal structural typing for the shell primitives this plugin renders.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` lives in the Web shell's frozen
 * module table — the built client bundle requires it at runtime, exactly like
 * the official client packages do — but it is not installed as a dependency of
 * this package (the official ones list it only as a devDependency for types).
 * Declaring the narrow surface used here keeps `tsc -p tsconfig.client.json`
 * green without adding a copy of the shell's UI kit to the package graph.
 * Extend this declaration when another primitive is used.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export interface SwitchProps {
    /** Whether the switch is on. */
    checked: boolean
    /** Called with the next state when the user toggles it. */
    onChange: (checked: boolean) => void
    /** Accessible name for the control. */
    label?: string
    disabled?: boolean
    id?: string
  }

  export const Switch: ComponentType<SwitchProps>
}
