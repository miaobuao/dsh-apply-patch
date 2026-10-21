/**
 * Dedicated Chat row for the `apply_patch` Tool call.
 *
 * The generic Tool card shows a Tool name plus its raw argument text, which for
 * a patch is the least readable view of the call. This row registers under the
 * `apply_patch` key of the `tool.call.toolview` slot and renders what the patch
 * means instead: the file operations in patch order, their added/removed line
 * counts, and — once the call settles — which of them actually landed.
 *
 * The row is deliberately self-contained: a plugin must not import another
 * Harness Client package as a module (the purity gate enforces it, and a throw
 * would blank the whole slot entry), so the markup, the diff lines, and the
 * disclosure behavior are local, styled with `--dsw-alias-*` theme tokens.
 */
import { useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { APPLY_PATCH_TOOL_NAME } from '../shared/constants'
import {
  scanPatchPreview,
  type PatchPreview,
  type PreviewLine,
  type PreviewOperation,
} from '../shared/patch-preview'
import { TOOL_LOCALE_NS } from './locales'
import type {
  ToolContentBlock,
  ToolResultNode,
  ToolCallOwnerProps,
} from './tool-contract'
import styles from './tool-row.css'

/** Props of the keyed Tool view: the owner currency plus the bound locale seat. */
export type ApplyPatchRowProps = ToolCallOwnerProps & PropsLocale<typeof TOOL_LOCALE_NS>

/** Lifecycle the collapsed row reports. */
type RowState = 'preparing' | 'applying' | 'applied' | 'failed'

/** Per-operation verdict derived from the settled result text. */
type OperationState = 'applied' | 'notApplied' | 'unknown'

/** One `A`/`M`/`D` line from the model-facing result summary. */
interface AppliedEntry {
  readonly letter: 'A' | 'M' | 'D'
  readonly path: string
}

/** One operation as the row renders it. */
interface OperationView {
  readonly operation: PreviewOperation
  /** Workspace-relative (or home-abbreviated) path for the row. */
  readonly pathLabel: string
  /** Display form of a Move destination, when the operation carries one. */
  readonly moveLabel: string | null
  readonly state: OperationState
}

/** Everything one render needs, derived from the stage block and the preview. */
interface RowModel {
  readonly preview: PatchPreview
  readonly operations: readonly OperationView[]
  readonly state: RowState
  readonly errorText: string | null
  readonly added: number
  readonly removed: number
  readonly appliedCount: number
}

/** Diff line count above which the middle folds behind a click. */
const DIFF_FOLD_THRESHOLD = 6

/** Context lines kept outside the first/last change of a folded diff. */
const DIFF_CONTEXT_EDGE = 1

/** Change-side lines kept at each folded edge, so changed lines stay visible. */
const DIFF_CHANGE_EDGE = 3

/** Hidden-line count worth folding; below it the change window is shown whole. */
const DIFF_MIN_HIDDEN = 3

/** Marker the Host writes before the applied-when-failed list. */
const FAILURE_APPLIED_MARKER = 'Applied before the failure:'

/** Marker of the successful result summary. */
const SUCCESS_MARKER = 'Success. Updated the following files:'

/** One `A path` / `M path` / `D path` line. */
const ENTRY_PATTERN = /^([AMD])\s+(.+)$/

/**
 * Render one `apply_patch` call: a collapsed summary of the parsed operations
 * and an expandable list with their per-file verdicts and diff previews.
 * @param props - keyed Tool view props.
 * @returns the row.
 */
export function ApplyPatchRow(props: ApplyPatchRowProps): JSX.Element {
  const { t, useDisclosure, cwd, home, openFile, inspect } = props
  const disclosure = useDisclosure()
  const args = props.block.args
  // Re-scan at coarse text-length steps: the row re-renders as arguments stream,
  // but parsing a large patch on every chunk would be wasted work.
  const lengthStep = args.stringLength('patch', { step: 1024 }) ?? 0
  const preview = useMemo(
    () => scanPatchPreview(args.text('patch') ?? '', { allowIncomplete: props.phase === 'preparing' }),
    [props.phase, lengthStep],
  )
  const result = props.phase === 'result' ? props.block : null
  const model = useMemo(() => buildModel(props.phase, result, preview, cwd, home), [props.phase, result, preview, cwd, home])

  const fileCount = model.operations.length
  const errorSummary = model.errorText === null ? null : firstLine(model.errorText)
  const title = titleFor(model.operations, t)
  // The title already names the action and the first file, so the summary is
  // reserved for the states the title cannot express: no operations yet, and
  // the settled failure message.
  const summary = model.state === 'failed'
    ? errorSummary ?? ''
    : fileCount === 0
      ? model.state === 'preparing' ? t('toolPreparing') : t('toolNoOperations')
      : ''
  const expandable = fileCount > 0 || model.errorText !== null
  const open = expandable && disclosure.expanded

  return (
    <div
      className="ap-tool"
      data-tool={APPLY_PATCH_TOOL_NAME}
      data-state={model.state}
      data-open={open || undefined}
    >
      <style>{styles}</style>
      <span className="ap-tool-visually-hidden">{statusLabel(model.state, t)}</span>
      <div className="ap-tool-header" data-disclosure-header>
        <button
          type="button"
          className="ap-tool-row"
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? disclosure.toggle : undefined}
        >
          <span className="ap-tool-leading" aria-hidden="true">
            {open ? CHEVRON_UP_ICON : (
              <>
                <span className="ap-tool-icon-idle">{PATCH_ICON}</span>
                {expandable && <span className="ap-tool-chevron-hover">{CHEVRON_DOWN_ICON}</span>}
              </>
            )}
          </span>
          <span className="ap-tool-title">{title}</span>
          {summary !== '' && <span className="ap-tool-sep" aria-hidden="true" />}
          <span className={model.state === 'failed' ? 'ap-tool-summary ap-tool-summary-error' : 'ap-tool-summary'}>
            {summary}
          </span>
          {model.state !== 'failed' && <Totals added={model.added} removed={model.removed} className="ap-tool-stat" />}
          {model.state === 'failed' && model.appliedCount > 0 && (
            <span className="ap-tool-stat ap-tool-applied-count">
              {t('toolAppliedCount', { applied: model.appliedCount, total: fileCount })}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div className="ap-tool-body">
          {fileCount > 0 && (
            <ol className="ap-tool-ops">
              {model.operations.map((view, index) => (
                <OperationRow
                  key={`${index}:${view.operation.kind}:${view.operation.path}`}
                  view={view}
                  t={t}
                  openFile={openFile}
                />
              ))}
            </ol>
          )}
          {model.errorText !== null && <pre className="ap-tool-error" role="alert">{model.errorText}</pre>}
          {model.preview.invalid && model.state !== 'failed' && (
            <p className="ap-tool-note">{t('toolInvalid')}</p>
          )}
          {fileCount === 0 && model.errorText === null && (
            <p className="ap-tool-empty">{t('toolNoOperations')}</p>
          )}
          {inspect !== undefined && (
            <button type="button" className="ap-tool-inspect" onClick={inspect}>
              {t('toolInspect')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** One file operation: badge, openable path, diff totals, verdict, preview. */
function OperationRow({ view, t, openFile }: {
  readonly view: OperationView
  readonly t: ApplyPatchRowProps['t']
  readonly openFile: ApplyPatchRowProps['openFile']
}): JSX.Element {
  const [diffOpen, setDiffOpen] = useState(false)
  const { operation } = view
  const lines = operationLines(operation)
  // Fold the MIDDLE around the changes, not the tail: each visible edge must
  // contain changed lines, otherwise the collapsed card would hide the very
  // thing the patch did (a hunk's leading context lines are not interesting).
  const changeIndices: number[] = []
  lines.forEach((line, index) => {
    if (line.kind !== 'context') changeIndices.push(index)
  })
  const foldable = lines.length > DIFF_FOLD_THRESHOLD && changeIndices.length > 0
  const folded = foldable && !diffOpen
  const firstChange = changeIndices[0] ?? 0
  const lastChange = changeIndices[changeIndices.length - 1] ?? 0
  const topStart = Math.max(0, firstChange - DIFF_CONTEXT_EDGE)
  const topEnd = Math.min(lines.length, firstChange + DIFF_CHANGE_EDGE)
  const bottomEnd = Math.min(lines.length, lastChange + 1 + DIFF_CONTEXT_EDGE)
  const bottomStart = Math.max(topEnd, bottomEnd - DIFF_CHANGE_EDGE - DIFF_CONTEXT_EDGE)
  const hiddenMiddle = folded ? Math.max(0, bottomStart - topEnd) : 0
  const showFold = folded && hiddenMiddle >= DIFF_MIN_HIDDEN
  // When the two change edges nearly meet, show the whole change window rather
  // than folding a couple of context lines.
  const headLines = !folded
    ? lines
    : showFold
      ? lines.slice(topStart, topEnd)
      : lines.slice(topStart, bottomEnd)
  const tailLines = showFold ? lines.slice(bottomStart, bottomEnd) : []
  // Counts are exact even when the scanner itself capped the retained lines.
  const hiddenByLimit = operation.lineCount - lines.length
  return (
    <li className="ap-tool-op" data-kind={operation.kind} data-state={view.state}>
      <div className="ap-tool-op-head">
        <span className="ap-tool-badge" aria-hidden="true">{operationBadge(operation)}</span>
        <button
          type="button"
          className="ap-tool-path"
          title={operation.path}
          onClick={() => openFile(operation.path)}
        >
          {view.pathLabel}
        </button>
        {view.moveLabel !== null && (
          <span className="ap-tool-move">
            <span className="ap-tool-arrow" aria-hidden="true">→</span>
            <button
              type="button"
              className="ap-tool-path ap-tool-path-move"
              title={operation.kind === 'update' ? operation.moveTo ?? '' : ''}
              onClick={() => operation.kind === 'update' && operation.moveTo !== null && openFile(operation.moveTo)}
            >
              {view.moveLabel}
            </button>
          </span>
        )}
        <Totals added={operation.added} removed={operation.removed} className="ap-tool-op-stat" />
        {view.state !== 'unknown' && (
          <span className="ap-tool-op-state">
            {view.state === 'applied' ? t('toolApplied') : t('toolUnapplied')}
          </span>
        )}
      </div>
      {lines.length > 0 && (
        <div className="ap-tool-diff">
          <div className="ap-tool-diff-body">
            {headLines.map((line, index) => (
              <div key={`head-${index}`} className={`ap-tool-diff-line ap-tool-diff-${line.kind}`}>
                {line.text}
              </div>
            ))}
            {showFold && (
              <button
                type="button"
                className="ap-tool-diff-fold"
                onClick={() => setDiffOpen(true)}
              >
                {t('diffExpand', { count: hiddenMiddle })}
              </button>
            )}
            {tailLines.map((line, index) => (
              <div key={`tail-${index}`} className={`ap-tool-diff-line ap-tool-diff-${line.kind}`}>
                {line.text}
              </div>
            ))}
          </div>
          {foldable && diffOpen && (
            <button
              type="button"
              className="ap-tool-diff-collapse"
              onClick={() => setDiffOpen(false)}
            >
              {t('diffCollapse')}
            </button>
          )}
        </div>
      )}
      {hiddenByLimit > 0 && (
        <p className="ap-tool-more">{t('toolMoreLines', { count: hiddenByLimit })}</p>
      )}
    </li>
  )
}

/** Added/removed line counts; renders nothing when both are zero. */
function Totals({ added, removed, className }: {
  readonly added: number
  readonly removed: number
  readonly className: string
}): JSX.Element | null {
  if (added === 0 && removed === 0) return null
  return (
    <span className={className}>
      {added > 0 && <span className="ap-tool-added">{`+${added}`}</span>}
      {added > 0 && removed > 0 ? ' ' : null}
      {removed > 0 && <span className="ap-tool-removed">{`-${removed}`}</span>}
    </span>
  )
}

/**
 * Derive the row model from the current stage.
 * @param phase - Tool call phase.
 * @param result - settled result node, or null while preparing/applying.
 * @param preview - parsed preview of the patch text so far.
 * @param cwd - session workspace root for relative labels.
 * @param home - Host home for `~` abbreviations.
 * @returns operations, verdicts, and totals.
 */
function buildModel(
  phase: ApplyPatchRowProps['phase'],
  result: ToolResultNode | null,
  preview: PatchPreview,
  cwd: string | undefined,
  home: string | undefined,
): RowModel {
  const state: RowState = result === null
    ? phase === 'preparing' ? 'preparing' : 'applying'
    : result.isError ? 'failed' : 'applied'
  const resultText = result === null ? '' : contentText(result.content)
  const entries = result === null
    ? []
    : result.isError ? parseFailureEntries(resultText) : parseSuccessEntries(resultText)
  const operations = preview.operations.length > 0
    ? preview.operations
    : entries.map(operationOfEntry)
  let appliedCount = 0
  const views = operations.map((operation): OperationView => {
    let verdict: OperationState = 'unknown'
    if (state === 'applied') {
      verdict = 'applied'
      appliedCount += 1
    } else if (state === 'failed') {
      const matched = entries.some((entry) =>
        sameTarget(entry.path, operation.path)
        || (operation.kind === 'update' && operation.moveTo !== null && sameTarget(entry.path, operation.moveTo)))
      verdict = matched ? 'applied' : 'notApplied'
      if (matched) appliedCount += 1
    }
    return {
      operation,
      pathLabel: displayPath(operation.path, cwd, home),
      moveLabel: operation.kind === 'update' && operation.moveTo !== null
        ? displayPath(operation.moveTo, cwd, home)
        : null,
      state: verdict,
    }
  })
  return {
    preview,
    operations: views,
    state,
    errorText: result !== null && result.isError ? errorTextOf(resultText) : null,
    added: operations.reduce((total, operation) => total + operation.added, 0),
    removed: operations.reduce((total, operation) => total + operation.removed, 0),
    appliedCount,
  }
}

/**
 * Concatenate the text blocks of a Tool result.
 * @param content - result content blocks.
 * @returns their text, in order.
 */
function contentText(content: readonly ToolContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/** Collapsed-title verb class of one operation. */
type OperationAction = 'add' | 'delete' | 'update' | 'move'

/**
 * The verb a collapsed title uses for one operation: an update that also moves
 * the file reads as a move.
 * @param operation - previewed operation.
 * @param moveLabel - its display Move destination, when it has one.
 * @returns the action class.
 */
function actionOf(operation: PreviewOperation, moveLabel: string | null): OperationAction {
  if (operation.kind !== 'update') return operation.kind
  return moveLabel === null ? 'update' : 'move'
}

/**
 * Build the collapsed title from the patch's own actions and paths, so a row
 * reads "Update src/a.ts" or "Update 3 files · src/a.ts" instead of a static
 * tool label. Falls back to the tool title before any hunk header arrives.
 * @param operations - rendered operations in patch order.
 * @param t - bound translate function.
 * @returns the title text.
 */
function titleFor(operations: readonly OperationView[], t: ApplyPatchRowProps['t']): string {
  const total = operations.length
  if (total === 0) return t('toolTitle')
  const first = operations[0]!
  const path = first.pathLabel
  const action = actionOf(first.operation, first.moveLabel)
  if (total === 1) {
    switch (action) {
      case 'add': return t('titleAdd', { path })
      case 'delete': return t('titleDelete', { path })
      case 'update': return t('titleUpdate', { path })
      case 'move': return t('titleMove', { path, to: first.moveLabel ?? '' })
    }
  }
  const count = total
  // Every file name is listed; the row's single-line title truncates with an
  // ellipsis when the patch touches more files than fit.
  const paths = operations.map((view) => view.pathLabel).join(t('pathSeparator'))
  if (!operations.every((view) => actionOf(view.operation, view.moveLabel) === action)) {
    return t('titleEditMany', { count, paths })
  }
  switch (action) {
    case 'add': return t('titleAddMany', { count, paths })
    case 'delete': return t('titleDeleteMany', { count, paths })
    case 'update': return t('titleUpdateMany', { count, paths })
    case 'move': return t('titleMoveMany', { count, paths })
  }
}

/**
 * Read the successful `A`/`M`/`D` summary lines.
 * @param text - model-facing result text.
 * @returns the applied entries in Host order.
 */
function parseSuccessEntries(text: string): AppliedEntry[] {
  const index = text.indexOf(SUCCESS_MARKER)
  if (index < 0) return []
  return parseEntries(text.slice(index + SUCCESS_MARKER.length))
}

/**
 * Read the applied-before-failure entries of an error result.
 * @param text - model-facing error text.
 * @returns the entries that landed before the failure.
 */
function parseFailureEntries(text: string): AppliedEntry[] {
  const index = text.indexOf(FAILURE_APPLIED_MARKER)
  if (index < 0) return []
  return parseEntries(text.slice(index + FAILURE_APPLIED_MARKER.length))
}

/**
 * Parse `A path` / `M path` / `D path` lines.
 * @param text - text following a result marker.
 * @returns entries in line order.
 */
function parseEntries(text: string): AppliedEntry[] {
  const entries: AppliedEntry[] = []
  for (const line of text.split('\n')) {
    const match = ENTRY_PATTERN.exec(line.trim())
    if (match === null) continue
    entries.push({ letter: match[1] as AppliedEntry['letter'], path: match[2]! })
  }
  return entries
}

/**
 * Strip the applied-before-failure trailer and the `Error:` prefix from an
 * error result.
 * @param text - model-facing error text.
 * @returns the error message a reader wants first.
 */
function errorTextOf(text: string): string {
  const index = text.indexOf(FAILURE_APPLIED_MARKER)
  const head = (index < 0 ? text : text.slice(0, index)).trim()
  return head.replace(/^Error:\s*/, '').trim()
}

/**
 * Build the fallback operation for a result summary line, used when the call
 * arguments are no longer in the loaded window.
 * @param entry - one applied entry.
 * @returns an operation with its kind but no line preview.
 */
function operationOfEntry(entry: AppliedEntry): PreviewOperation {
  const base = { path: entry.path, added: 0, removed: 0, lineCount: 0 }
  switch (entry.letter) {
    case 'A': return { kind: 'add', ...base, lines: [], truncated: false }
    case 'D': return { kind: 'delete', ...base }
    case 'M': return { kind: 'update', ...base, moveTo: null, chunks: [], truncated: false }
  }
}

/**
 * Classify one operation for its leading glyph.
 * @param operation - previewed operation.
 * @returns `A`, `M`, or `D`.
 */
function operationBadge(operation: PreviewOperation): string {
  switch (operation.kind) {
    case 'add': return 'A'
    case 'delete': return 'D'
    case 'update': return 'M'
  }
}

/**
 * Flatten the preview lines one operation carries.
 * @param operation - previewed operation.
 * @returns its lines in display order.
 */
function operationLines(operation: PreviewOperation): readonly PreviewLine[] {
  if (operation.kind === 'add') return operation.lines
  if (operation.kind === 'update') return operation.chunks.flatMap((chunk) => chunk.lines)
  return []
}

/**
 * Relativize an absolute path to the workspace and abbreviate a POSIX home.
 * Authored relative paths are shown untouched.
 * @param path - authored or recorded path.
 * @param cwd - session workspace root.
 * @param home - Host account home.
 * @returns the display path.
 */
function displayPath(path: string, cwd: string | undefined, home: string | undefined): string {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  if (!absolute) return path
  let display = path
  if (cwd !== undefined && cwd !== '') {
    const root = cwd.replace(/[/\\]+$/, '')
    if (display === root) return '.'
    if (display.startsWith(`${root}/`) || display.startsWith(`${root}\\`)) display = display.slice(root.length + 1)
  }
  const homeRoot = home === undefined || home === '' ? null : home.replace(/\/+$/, '')
  if (homeRoot !== null && !/^[A-Za-z]:[/\\]/.test(display) && !display.startsWith('\\\\')) {
    if (display === homeRoot) return '~'
    if (display.startsWith(`${homeRoot}/`)) display = `~${display.slice(homeRoot.length)}`
  }
  return display
}

/**
 * Whether two recorded paths name the same file, tolerating an absolute record
 * versus a relative authored path.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they match.
 */
function sameTarget(left: string, right: string): boolean {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Normalize separators, a leading `./`, and trailing slashes for comparison.
 * @param path - path to normalize.
 * @returns the comparison key.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * First non-empty line of a multi-line message.
 * @param text - message text.
 * @returns the first line, or the whole text when it has none.
 */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? text
}

/**
 * Localized status label for the screen-reader seat.
 * @param state - row lifecycle.
 * @param t - bound translate function.
 * @returns the status text.
 */
function statusLabel(state: RowState, t: ApplyPatchRowProps['t']): string {
  switch (state) {
    case 'preparing': return t('toolStatusPreparing')
    case 'applying': return t('toolStatusRunning')
    case 'applied': return t('toolStatusSucceeded')
    case 'failed': return t('toolStatusFailed')
  }
}

/**
 * Leading glyph: a patch document — one page carrying the two change marks a
 * patch is made of (an added line and a removed line). The shell's icon set
 * has no patch/diff glyph of its own (its compare-split icon is the
 * split-view control), so this is original artwork on the host's regular icon
 * grid: 16px viewBox, 1px stroke, rounded caps, rendered at 14px.
 */
const PATCH_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    strokeWidth="1"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Page with a folded top-right corner. */}
    <path d="M3 1.5h6L13 5.5v9H3z" stroke="currentColor" />
    <path d="M9 1.5v4h4" stroke="currentColor" />
    {/* Addition, then removal: the patch's own +/- notation. */}
    <path d="M5.6 6.5h4.8M8 4.1v4.8" stroke="currentColor" />
    <path d="M5.6 10.8h4.8" stroke="currentColor" />
  </svg>
)

/**
 * Hover glyph: the shell's disclosure rows reveal a downward chevron in place
 * of their leading icon, meaning "expand downward".
 */
const CHEVRON_DOWN_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
      stroke="currentColor"
      strokeWidth="1"
    />
  </svg>
)

/** Open glyph: an upward chevron, meaning "collapse back up". */
const CHEVRON_UP_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10"
      stroke="currentColor"
      strokeWidth="1"
    />
  </svg>
)
