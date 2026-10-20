/**
 * Locale dictionaries for the apply-patch page in the Plugins center.
 *
 * The page is a bundle configuration section (`plugins.bundle.config`): the
 * plugin itself is always enabled, so the copy explains what the two switches
 * hide rather than whether to enable anything.
 */
export const LOCALE_NS = 'settings.applyPatch'

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
