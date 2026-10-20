/**
 * Shared settings contract for dsh-apply-patch.
 *
 * The plugin always offers `apply_patch`; two suppression switches decide
 * whether DSH's built-in file-editing tools stay visible to the model, and one
 * policy switch decides whether Add/Move/Delete may touch unread files. Both
 * halves (host + client) key off the same namespace, field names, and defaults,
 * so this file stays free of any schemastery import (the client bundle purity
 * gate and the client tsconfig both rely on that): the Config schema the host
 * validates with lives in `src/host/settings-schema.ts`.
 */
import {
  APPLY_PATCH_SETTINGS_NS,
  BUILTIN_EDIT_TOOL,
  BUILTIN_WRITE_TOOL,
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
} from './constants.js'

export {
  APPLY_PATCH_SETTINGS_NS,
  BUILTIN_EDIT_TOOL,
  BUILTIN_WRITE_TOOL,
  DEFAULT_ALLOW_UNOBSERVED_OVERWRITE,
  DEFAULT_DISABLE_EDIT,
  DEFAULT_DISABLE_WRITE,
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
