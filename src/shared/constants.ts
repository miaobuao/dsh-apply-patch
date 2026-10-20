/**
 * Pure constants shared by host and client — deliberately free of any
 * schemastery import so the client bundle purity gate lets both halves share
 * them.
 */

/** Settings namespace of this plugin (lowercase kebab, matches package short name). */
export const APPLY_PATCH_SETTINGS_NS = 'dsh-apply-patch'

/** Built-in tool names this plugin can hide; both come from @deepseek-ai/dsh-tool-fs. */
export const BUILTIN_EDIT_TOOL = 'edit'
export const BUILTIN_WRITE_TOOL = 'write'

/** Installing the plugin replaces the built-in file-editing tools by default. */
export const DEFAULT_DISABLE_EDIT = true
export const DEFAULT_DISABLE_WRITE = true

/**
 * Codex compatibility: Add/Move may replace a file that exists but was never
 * read, and Delete may remove one. Turning this off makes those operations go
 * through the observation policy's read-before-write guard.
 */
export const DEFAULT_ALLOW_UNOBSERVED_OVERWRITE = true
