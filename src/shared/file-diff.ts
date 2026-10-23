/**
 * Unified hunk model for one previewed file operation.
 *
 * The patch argument carries only changed/context lines, not the complete file.
 * Each `@@` block still carries enough text to diff its old and new sides as a
 * whole: context + removed lines on the left, context + added lines on the
 * right. diff-match-patch then produces one edit script for that block, and the
 * script is projected back onto lines. This is the model used by dedicated diff
 * viewers: a line that has no counterpart is simply an insertion or a deletion,
 * while a shared piece of text stays unhighlighted wherever it lands.
 *
 * The projection is content-based, not index-based. It therefore handles a line
 * growing into several lines, several lines merging into one, and a line being
 * inserted before or inside a replacement. A row keeps its old/new line number
 * when the authored `@@` header carries one; a bare `@@` starts a hunk-local
 * numbering at 1 because the patch does not contain absolute file positions.
 *
 * Large blocks and missing grapheme segmentation keep the plain line tint:
 * the former bounds UI work, the latter keeps a highlight from splitting an
 * emoji or combining sequence.
 */
import diff_match_patch from 'diff-match-patch'
import type { PreviewLine, PreviewOperation } from './patch-preview'

/** One rendered run of a line, preserving the exact source text. */
export interface DiffSegment {
  readonly text: string
  readonly changed: boolean
}

/** One rendered row: a hunk header, a context line, or a changed line. */
export interface DiffRow {
  readonly kind: 'hunk' | 'context' | 'add' | 'remove'
  readonly text: string
  /** Old-file line number, when known. */
  readonly oldLine: number | null
  /** New-file line number, when known. */
  readonly newLine: number | null
  /** Changed runs, or null for plain line text. */
  readonly segments: readonly DiffSegment[] | null
  /** Whether this is the first row of a headerless hunk. */
  readonly hunkStart?: boolean
}

/** Upper bounds for one hunk; larger hunks keep the plain row model. */
const MAX_DIFF_CHARS = 131_072
const MAX_DIFF_LINES = 4_096

/** Seconds diff-match-patch may spend on one hunk before using its best guess. */
const DIFF_TIMEOUT_SECONDS = 0.05

/** `@@ -old,count +new,count @@` inside the scanner's context text. */
const NUMBERED_HUNK = /^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

/** One mutable side while the edit script is projected onto lines. */
interface MutableLine {
  text: string
  readonly segments: DiffSegment[]
  changed: boolean
}

/** A finished side plus the metadata needed for context detection. */
interface FinishedLine {
  readonly row: DiffRow
  readonly changed: boolean
  readonly text: string
}

/** Absolute or hunk-local start positions for one block. */
interface HunkPosition {
  readonly header: string
  readonly oldStart: number
  readonly newStart: number
  /** Whether the authored header carried absolute file positions. */
  readonly numbered: boolean
}

/**
 * Build the hunk rows for one previewed operation.
 * @param operation - previewed add or update operation.
 * @returns hunk headers interleaved with diff rows.
 */
export function createDiffView(operation: PreviewOperation): readonly DiffRow[] {
  if (operation.kind === 'add') {
    if (operation.lines.length === 0) return []
    const rows: DiffRow[] = [hunkRow(`@@ -0,0 +1,${operation.lines.length} @@`)]
    operation.lines.forEach((line, index) => {
      rows.push({
        kind: 'add',
        text: line.text,
        oldLine: null,
        newLine: index + 1,
        segments: changedText(line.text),
      })
    })
    return rows
  }
  if (operation.kind !== 'update') return []

  const rows: DiffRow[] = []
  for (const chunk of operation.chunks) {
    if (chunk.lines.length === 0) continue
    const position = hunkPosition(chunk.context)
    const chunkRows = diffChunk(chunk.lines, position)
    // A context-only chunk carries no change (and may be an authoring anchor);
    // rendering it would add unchanged rows and a divider around nothing.
    if (!chunkRows.some(row => row.kind === 'add' || row.kind === 'remove')) continue
    // A bare `@@` has no absolute positions and no useful label; showing a
    // header for it only adds an empty `@@` row. Keep labeled/numbered headers.
    const showHeader = position.header !== '@@'
    if (showHeader) rows.push(hunkRow(position.header))
    const previous = rows[rows.length - 1]
    if (!showHeader && previous !== undefined && previous.kind !== 'hunk' && chunkRows.length > 0) {
      rows.push({ ...chunkRows[0]!, hunkStart: true })
      rows.push(...chunkRows.slice(1))
    } else rows.push(...chunkRows)
  }
  return rows
}

/**
 * Diff one block and project its edit script back onto lines.
 * @param lines - authored context/remove/add lines in patch order.
 * @param position - hunk header and old/new start positions.
 * @returns rows for this block, excluding its hunk header.
 */
function diffChunk(lines: readonly PreviewLine[], position: HunkPosition): readonly DiffRow[] {
  const oldLines = lines.filter(line => line.kind !== 'add').map(line => line.text)
  const newLines = lines.filter(line => line.kind !== 'remove').map(line => line.text)
  // A patch line is a complete line, including an empty one. Terminate the
  // reconstruction so a trailing empty line is not mistaken for a bare final
  // newline by the line projector.
  const oldText = oldLines.length === 0 ? '' : `${oldLines.join('\n')}\n`
  const newText = newLines.length === 0 ? '' : `${newLines.join('\n')}\n`
  if (oldText === newText) return rawRows(lines, position)
  if (oldText.length + newText.length > MAX_DIFF_CHARS || lines.length > MAX_DIFF_LINES) {
    return rawRows(lines, position)
  }

  const dmp = new diff_match_patch()
  dmp.Diff_Timeout = DIFF_TIMEOUT_SECONDS
  const diffs = dmp.diff_main(oldText, newText)
  dmp.diff_cleanupSemantic(diffs)
  return projectDiff(diffs, oldText, newText, position)
}

/**
 * Project one diff-match-patch script onto old/new lines.
 * @param diffs - character-level edit script.
 * @param oldText - left-hand block text.
 * @param newText - right-hand block text.
 * @param position - hunk start positions.
 * @returns rendered rows in unified-diff order.
 */
function projectDiff(
  diffs: readonly diff_match_patch.Diff[],
  oldText: string,
  newText: string,
  position: HunkPosition,
): readonly DiffRow[] {
  const rows: DiffRow[] = []
  const pendingOld: DiffRow[] = []
  const pendingNew: DiffRow[] = []
  let oldLineNumber = position.oldStart
  let newLineNumber = position.newStart
  let oldLine = mutableLine()
  let newLine = mutableLine()

  const finishOld = (newlineChanged = false): FinishedLine => {
    const row: DiffRow = {
      kind: 'remove',
      text: oldLine.text,
      oldLine: position.numbered ? oldLineNumber : null,
      newLine: null,
      segments: normalizedSegments(oldLine.text, oldLine.segments),
    }
    oldLineNumber += 1
    const finished = { row, changed: oldLine.changed || newlineChanged, text: oldLine.text }
    oldLine = mutableLine()
    return finished
  }
  const finishNew = (newlineChanged = false): FinishedLine => {
    const row: DiffRow = {
      kind: 'add',
      text: newLine.text,
      oldLine: null,
      newLine: position.numbered ? newLineNumber : null,
      segments: normalizedSegments(newLine.text, newLine.segments),
    }
    newLineNumber += 1
    const finished = { row, changed: newLine.changed || newlineChanged, text: newLine.text }
    newLine = mutableLine()
    return finished
  }
  const flushChanges = (): void => {
    rows.push(...pendingOld, ...pendingNew)
    pendingOld.length = 0
    pendingNew.length = 0
  }
  const finishShared = (): void => {
    const oldFinished = finishOld()
    const newFinished = finishNew()
    if (!oldFinished.changed && !newFinished.changed && oldFinished.text === newFinished.text) {
      flushChanges()
      rows.push({
        kind: 'context',
        text: oldFinished.text,
        oldLine: oldFinished.row.oldLine,
        newLine: newFinished.row.newLine,
        segments: null,
      })
      return
    }
    pendingOld.push(oldFinished.row)
    pendingNew.push(newFinished.row)
  }

  for (const [operation, value] of diffs) {
    const parts = value.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      if (operation !== diff_match_patch.DIFF_INSERT) {
        appendSegment(oldLine, part, operation === diff_match_patch.DIFF_DELETE)
      }
      if (operation !== diff_match_patch.DIFF_DELETE) {
        appendSegment(newLine, part, operation === diff_match_patch.DIFF_INSERT)
      }
      if (index === parts.length - 1) continue
      if (operation === diff_match_patch.DIFF_EQUAL) finishShared()
      else if (operation === diff_match_patch.DIFF_DELETE) pendingOld.push(finishOld(true).row)
      else pendingNew.push(finishNew(true).row)
    }
  }

  const oldTail = oldText !== '' && !oldText.endsWith('\n') ? finishOld() : undefined
  const newTail = newText !== '' && !newText.endsWith('\n') ? finishNew() : undefined
  if (oldTail !== undefined && newTail !== undefined
    && !oldTail.changed && !newTail.changed && oldTail.text === newTail.text) {
    flushChanges()
    rows.push({
      kind: 'context',
      text: oldTail.text,
      oldLine: oldTail.row.oldLine,
      newLine: newTail.row.newLine,
      segments: null,
    })
  } else {
    if (oldTail !== undefined) pendingOld.push(oldTail.row)
    if (newTail !== undefined) pendingNew.push(newTail.row)
    flushChanges()
  }
  return rows
}

/** Stable numbering for a hunk with no parseable absolute header. */
function hunkPosition(context: string | null): HunkPosition {
  const raw = context ?? ''
  const numbered = NUMBERED_HUNK.exec(raw)
  if (numbered !== null) {
    const oldStart = Number(numbered[1])
    const oldCount = numbered[2] === undefined ? 1 : Number(numbered[2])
    const newStart = Number(numbered[3])
    const newCount = numbered[4] === undefined ? 1 : Number(numbered[4])
    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      newStart,
      numbered: true,
    }
  }
  // A bare `@@` carries no absolute file positions. Block-local numbers reset
  // at every hunk and read as a bug, so leave the gutter empty instead of
  // inventing a position the patch never supplied.
  return { header: raw === '' ? '@@' : `@@ ${raw}`, oldStart: 1, newStart: 1, numbered: false }
}

/** Raw rows used when a block is too large to diff or has no changes. */
function rawRows(lines: readonly PreviewLine[], position: HunkPosition): readonly DiffRow[] {
  let oldLine = position.oldStart
  let newLine = position.newStart
  return lines.map((line) => {
    if (line.kind === 'add') {
      const row: DiffRow = {
        kind: 'add',
        text: line.text,
        oldLine: null,
        newLine: position.numbered ? newLine : null,
        segments: null,
      }
      newLine += 1
      return row
    }
    if (line.kind === 'remove') {
      const row: DiffRow = {
        kind: 'remove',
        text: line.text,
        oldLine: position.numbered ? oldLine : null,
        newLine: null,
        segments: null,
      }
      oldLine += 1
      return row
    }
    const row: DiffRow = {
      kind: 'context',
      text: line.text,
      oldLine: position.numbered ? oldLine : null,
      newLine: position.numbered ? newLine : null,
      segments: null,
    }
    oldLine += 1
    newLine += 1
    return row
  })
}

/** Whole unchanged or changed line content for the add-file case. */
function changedText(text: string): readonly DiffSegment[] | null {
  if (text === '' || segmenter === null) return null
  return [{ text, changed: true }]
}

/** One empty mutable line. */
function mutableLine(): MutableLine {
  return { text: '', segments: [], changed: false }
}

/** Append one script fragment to a line and merge adjacent same flags. */
function appendSegment(line: MutableLine, text: string, changed: boolean): void {
  if (text === '') return
  line.text += text
  line.changed ||= changed
  const previous = line.segments[line.segments.length - 1]
  if (previous !== undefined && previous.changed === changed) {
    line.segments[line.segments.length - 1] = { text: previous.text + text, changed }
  } else line.segments.push({ text, changed })
}

/**
 * Snap changed runs to grapheme boundaries.
 * @param text - full line text.
 * @param segments - script fragments for that line.
 * @returns grapheme-aligned segments, or null when no nested highlight applies.
 */
function normalizedSegments(text: string, segments: readonly DiffSegment[]): readonly DiffSegment[] | null {
  if (segmenter === null || text === '' || !segments.some(segment => segment.changed)) return null
  const mask = new Uint8Array(text.length)
  let offset = 0
  for (const segment of segments) {
    if (segment.changed) mask.fill(1, offset, offset + segment.text.length)
    offset += segment.text.length
  }
  if (offset !== text.length) return null
  const result: DiffSegment[] = []
  for (const part of segmenter.segment(text)) {
    let changed = false
    for (let index = part.index; index < part.index + part.segment.length; index += 1) {
      if (mask[index] === 1) {
        changed = true
        break
      }
    }
    const previous = result[result.length - 1]
    if (previous !== undefined && previous.changed === changed) {
      result[result.length - 1] = { text: previous.text + part.segment, changed }
    } else result.push({ text: part.segment, changed })
  }
  return result
}

/** One hunk-header row. */
function hunkRow(text: string): DiffRow {
  return { kind: 'hunk', text, oldLine: null, newLine: null, segments: null }
}
