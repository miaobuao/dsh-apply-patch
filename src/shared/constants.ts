/**
 * Pure constants shared by host and client — deliberately free of any
 * schemastery import so the client bundle purity gate lets both halves share
 * them.
 */

/** Settings namespace of this plugin (lowercase kebab, matches package short name). */
export const APPLY_PATCH_SETTINGS_NS = 'dsh-apply-patch'

/**
 * Wire name of the tool this plugin registers.
 *
 * The Client half dispatches its dedicated row by the same name through the
 * keyed `tool.call.toolview` slot, so both halves read it from here instead of
 * each carrying their own literal.
 */
export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

/** Built-in tool names this plugin can hide; both come from @deepseek-ai/dsh-tool-fs. */
export const BUILTIN_EDIT_TOOL = 'edit'
export const BUILTIN_WRITE_TOOL = 'write'

/**
 * Defaults of the settings switches: the document defaults the schema carries
 * and the settings page shows, not tuning knobs the host reads. Installing the
 * plugin replaces the built-in file-editing tools by default.
 */
export const DEFAULT_DISABLE_EDIT = true
export const DEFAULT_DISABLE_WRITE = true

/**
 * Codex compatibility: Add/Move may replace a file that exists but was never
 * read, and Delete may remove one. Turning this off makes those operations go
 * through the observation policy's read-before-write guard.
 */
export const DEFAULT_ALLOW_UNOBSERVED_OVERWRITE = true
