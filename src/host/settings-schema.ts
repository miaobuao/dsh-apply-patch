/**
 * The plugin's `Config` schema — the host-only half of the settings contract.
 *
 * dsh owns plugin settings as entry config: the loader validates the profile
 * patch (or the settings page) with this schema and hands the resolved document
 * to `apply()`. Resolution is not a plain-value pass-through: a `volatile()`
 * field arrives as a live handle (`{ get() }`, cosmokit's `Volatile<T>`), so
 * `apply()` takes `ResolvedApplyPatchSettings` while `ApplyPatchSettings` stays
 * the plain shape of a hand-written document. Both are derived from the schema
 * type below, so the document shape cannot drift from what is validated.
 *
 * The schema carries an explicit annotation because this repo's node_modules
 * holds several schemastery copies: the bare inferred type resolves through a
 * copy this package does not import, so `tsc -p tsconfig.build.json`
 * (`declaration: true`) cannot name it (TS2742). Naming the type through the
 * package's own default export (`z<...>`), with locally declared type
 * arguments, keeps the emitted declaration portable.
 *
 * Kept out of src/shared/ on purpose: the client tsconfig compiles src/shared/**
 * too, and a schemastery schema there fails its type resolution.
 */
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
} from '../shared/constants.js'

/**
 * One `volatile()` config field as the loader hands it to `apply()`: a live
 * handle, not the value it currently holds. Spelled structurally rather than as
 * cosmokit's `Volatile<T>` on purpose — cosmokit is a transitive dependency
 * here, and importing it would put a second schemastery/cosmokit pair into the
 * emitted declaration.
 */
export interface LiveSettingsField<T> {
  get(): T
}

/** Plain settings document shape (a hand-written patch or a settings-page write). */
export interface ApplyPatchSettings {
  /** Hide the built-in `edit` tool (targeted text edits). */
  disableEdit?: boolean | null
  /** Hide the built-in `write` tool (whole-file creation/overwrite). */
  disableWrite?: boolean | null
  /**
   * Allow Add/Move to overwrite a file the model never read, and Delete to
   * remove one (Codex semantics, default). Disable to require a prior read.
   */
  allowUnobservedOverwrite?: boolean | null
}

/** The resolved document `apply()` receives: every switch is a live handle. */
export type ResolvedApplyPatchSettings = {
  [K in keyof ApplyPatchSettings]-?: LiveSettingsField<boolean>
}

/**
 * The schema's own type: each switch is accepted as a plain boolean (nullable
 * before their defaults apply) and resolves to live handles above. Exported
 * under a stable name so the declaration build can write it (see the module
 * note).
 *
 * Only the first two type arguments are spelled: `Schema`'s third `Mode`
 * parameter only exists from schemastery 3.18.3 on, while the package's peer
 * range starts at ^3.18.2. Omitting it defaults to `'plain'` — which is exactly
 * what this object schema is — on every supported version.
 */
export type ApplyPatchSettingsSchemaType = z<ApplyPatchSettings, ResolvedApplyPatchSettings>

/** Settings document schema: the two built-in-tool switches. */
export const ApplyPatchSettingsSchema: ApplyPatchSettingsSchemaType = z.object({
  // Volatile: the settings plane (page / settings.replace) only writes
  // volatile-marked fields, so a page toggle reaches this entry live.
  disableEdit: z.boolean().default(DEFAULT_DISABLE_EDIT).volatile(),
  disableWrite: z.boolean().default(DEFAULT_DISABLE_WRITE).volatile(),
  allowUnobservedOverwrite: z.boolean().default(DEFAULT_ALLOW_UNOBSERVED_OVERWRITE).volatile(),
})
