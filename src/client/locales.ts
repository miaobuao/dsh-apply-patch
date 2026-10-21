/**
 * Locale dictionaries for this plugin's Client surfaces.
 *
 * `settings.applyPatch` is the bundle configuration section in the Plugins
 * center (`plugins.bundle.config`): the plugin itself is always enabled, so
 * the copy explains what the switches do rather than whether to enable
 * anything. `applyPatch.tool` is the dedicated Chat row for the `apply_patch`
 * Tool call (`tool.call.toolview`), which renders the patch as ordered file
 * operations instead of its raw argument text.
 */
export const LOCALE_NS = 'settings.applyPatch'

/** Namespace of the `apply_patch` Tool call row. */
export const TOOL_LOCALE_NS = 'applyPatch.tool'

export const zh = {
  sectionTitle: '内置文件编辑工具',
  sectionSub: 'apply_patch 已启用。这里决定是否让模型继续看到 DSH 内置的文件编辑工具。',
  disableEditLabel: '隐藏内置 edit 工具',
  disableEditHint: '不让模型使用定点文本编辑（edit）。apply_patch 的 Update File 可以完成同样的事。',
  disableWriteLabel: '隐藏内置 write 工具',
  disableWriteHint: '不让模型整文件写入（write）。apply_patch 的 Add File / Update File 可以完成同样的事。',
  allowUnobservedOverwriteLabel: '允许覆盖未读取的文件',
  allowUnobservedOverwriteHint: '默认开启，与 Codex 行为一致：Add File / Move to 可以覆盖已存在但模型没读过的文件，Delete File 也可以直接删除。关闭后，这类操作要求模型先读取文件。',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存失败：{message}',
  saveConflict: '配置已被其他改动更新，请重试。',
  readOnly: '当前部署为只读，无法修改配置。',
} as const

export const en = {
  sectionTitle: 'Built-in file-editing tools',
  sectionSub: 'apply_patch is enabled. These switches decide whether the model still sees DSH\'s built-in file-editing tools.',
  disableEditLabel: 'Hide the built-in edit tool',
  disableEditHint: 'Stops the model from using targeted text edits (edit). apply_patch\'s Update File does the same job.',
  disableWriteLabel: 'Hide the built-in write tool',
  disableWriteHint: 'Stops whole-file writes (write). apply_patch\'s Add File / Update File do the same job.',
  allowUnobservedOverwriteLabel: 'Allow overwriting unread files',
  allowUnobservedOverwriteHint: 'On by default, matching Codex: Add File / Move to may replace an existing file the model never read, and Delete File may remove one. Turn off to require a prior read.',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed: {message}',
  saveConflict: 'Configuration changed elsewhere; try again.',
  readOnly: 'This deployment is read-only; configuration cannot be changed.',
} as const

/**
 * `apply_patch` Tool row copy.
 *
 * The row shows the parsed file operations in patch order, their diff totals,
 * and the settled verdict; the locale owner is the same plugin, so the
 * namespace is declared here beside the settings dictionary.
 */
export const toolZh = {
  toolTitle: '应用补丁',
  toolPreparing: '接收补丁…',
  toolNoOperations: '没有文件操作',
  toolInvalid: '补丁语法无法解析',
  pathSeparator: '、',
  titleAdd: '新增 {path}',
  titleUpdate: '更新 {path}',
  titleDelete: '删除 {path}',
  titleMove: '移动 {path} → {to}',
  titleAddMany: '新增 {count} 个文件 · {paths}',
  titleUpdateMany: '更新 {count} 个文件 · {paths}',
  titleDeleteMany: '删除 {count} 个文件 · {paths}',
  titleMoveMany: '移动 {count} 个文件 · {paths}',
  titleEditMany: '修改 {count} 个文件 · {paths}',
  toolApplied: '已应用',
  toolUnapplied: '未执行',
  toolAppliedCount: '已应用 {applied}/{total}',
  diffExpand: '展开 {count} 行',
  diffCollapse: '收起',
  toolMoreLines: '还有 {count} 行',
  toolInspect: '查看调用',
  toolStatusPreparing: '准备中',
  toolStatusRunning: '执行中',
  toolStatusSucceeded: '已应用',
  toolStatusFailed: '失败',
} as const

export const toolEn = {
  toolTitle: 'Apply patch',
  toolPreparing: 'Receiving patch…',
  toolNoOperations: 'No file operations',
  toolInvalid: 'Unreadable patch syntax',
  pathSeparator: ', ',
  titleAdd: 'Add {path}',
  titleUpdate: 'Update {path}',
  titleDelete: 'Delete {path}',
  titleMove: 'Move {path} → {to}',
  titleAddMany: 'Add {count} files · {paths}',
  titleUpdateMany: 'Update {count} files · {paths}',
  titleDeleteMany: 'Delete {count} files · {paths}',
  titleMoveMany: 'Move {count} files · {paths}',
  titleEditMany: 'Edit {count} files · {paths}',
  toolApplied: 'Applied',
  toolUnapplied: 'Not applied',
  toolAppliedCount: '{applied}/{total} applied',
  diffExpand: 'Show {count} lines',
  diffCollapse: 'Collapse',
  toolMoreLines: '{count} more lines',
  toolInspect: 'Inspect call',
  toolStatusPreparing: 'Preparing',
  toolStatusRunning: 'Running',
  toolStatusSucceeded: 'Applied',
  toolStatusFailed: 'Failed',
} as const
