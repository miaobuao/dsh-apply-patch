/**
 * Browser-safe preview of a codex-format patch.
 *
 * The Host parser (`src/host/parser.ts`) is authoritative and strict: it throws
 * on any document it cannot apply. A Tool view renders while the model is still
 * streaming the `patch` argument, so it needs the opposite contract — total,
 * tolerant, and able to grow with the text. This scanner therefore mirrors only
 * the grammar markers: it reports the file operations it can already see, their
 * added/removed line counts, and a bounded preview of their lines.
 *
 * Nothing here throws. A still-streaming tail or malformed content is reported
 * through `complete`/`invalid`, while `operations` keeps what was parsed before
 * it. Whether a patch actually applies stays the Host parser's decision; the
 * settled card takes its verdict from the Tool result.
 *
 * Grammar (see the Host parser for the authoritative form):
 *   "*** Begin Patch" "*** End Patch"
 *   "*** Add File: " filename ( "+" line )+
 *   "*** Delete File: " filename
 *   "*** Update File: " filename "*** Move to: "? ( "@@" label? / ("+"|"-"|" ") line )*
 *   "*** End of File"
 */

const BEGIN_PATCH_MARKER = '*** Begin Patch'
const END_PATCH_MARKER = '*** End Patch'
const ADD_FILE_MARKER = '*** Add File: '
const DELETE_FILE_MARKER = '*** Delete File: '
const UPDATE_FILE_MARKER = '*** Update File: '
const MOVE_TO_MARKER = '*** Move to: '
const ENVIRONMENT_ID_MARKER = '*** Environment ID: '
const END_OF_FILE_MARKER = '*** End of File'
const CHANGE_CONTEXT_MARKER = '@@'
const CHANGE_CONTEXT_PREFIX = '@@ '

/** Default per-operation preview budget; counts are always exact. */
export const DEFAULT_PREVIEW_LINE_LIMIT = 200

/** One previewed source line, classified the way a diff card shows it. */
export interface PreviewLine {
  readonly kind: 'context' | 'add' | 'remove'
  /** The line without its patch marker. */
  readonly text: string
}

/** One `@@`-anchored block of an Update hunk. */
export interface PreviewChunk {
  /** The label after `@@ `; null for a bare `@@` or no anchor. */
  readonly context: string | null
  readonly lines: readonly PreviewLine[]
}

interface PreviewOperationBase {
  /** The authored path, exactly as the patch writes it. */
  readonly path: string
  /** Lines the operation adds (exact even when the preview is truncated). */
  readonly added: number
  /** Lines the operation removes (exact even when the preview is truncated). */
  readonly removed: number
  /** Lines the operation's body carries, so a view can report what the budget hid. */
  readonly lineCount: number
}

/** A file the patch creates. */
export interface PreviewAddOperation extends PreviewOperationBase {
  readonly kind: 'add'
  /** Added lines, capped at the preview budget. */
  readonly lines: readonly PreviewLine[]
  /** Whether more added lines exist than the preview carries. */
  readonly truncated: boolean
}

/** A file the patch deletes; no content is available before the Host reads it. */
export interface PreviewDeleteOperation extends PreviewOperationBase {
  readonly kind: 'delete'
}

/** A file the patch updates, optionally moving it to another path. */
export interface PreviewUpdateOperation extends PreviewOperationBase {
  readonly kind: 'update'
  /** `*** Move to:` destination, or null for an in-place update. */
  readonly moveTo: string | null
  readonly chunks: readonly PreviewChunk[]
  /** Whether more update lines exist than the preview carries. */
  readonly truncated: boolean
}

/** One ordered file operation as the patch spells it. */
export type PreviewOperation = PreviewAddOperation | PreviewDeleteOperation | PreviewUpdateOperation

/** The whole scan result for one argument prefix. */
export interface PatchPreview {
  /** Operations in patch order; empty until the first hunk header arrives. */
  readonly operations: readonly PreviewOperation[]
  /** Whether `*** End Patch` arrived — i.e. framing produced a whole document. */
  readonly complete: boolean
  /** Whether a complete document could not hold the content seen (tolerant scan only). */
  readonly invalid: boolean
}

/** Options for {@link scanPatchPreview}. */
export interface ScanPatchOptions {
  /**
   * Treat the text as a still-growing prefix: an unrecognized tail is ignored
   * instead of being reported through `invalid`. Pass `true` while the call is
   * preparing (arguments are still streaming).
   */
  readonly allowIncomplete?: boolean
  /** Per-operation preview line budget; defaults to {@link DEFAULT_PREVIEW_LINE_LIMIT}. */
  readonly lineLimit?: number
}

/** One mutable operation while the scanner walks the lines. */
interface MutableOperation {
  kind: 'add' | 'delete' | 'update'
  path: string
  added: number
  removed: number
  lineCount: number
  moveTo: string | null
  lines: PreviewLine[]
  chunks: PreviewChunkInternal[]
  truncated: boolean
}

interface PreviewChunkInternal {
  context: string | null
  lines: PreviewLine[]
}

/**
 * Scan a patch argument prefix into ordered file operations.
 * @param text - decoded `patch` argument text, possibly still streaming.
 * @param options - incompleteness tolerance and preview budget.
 * @returns the operations seen so far plus framing flags; never throws.
 */
export function scanPatchPreview(text: string, options: ScanPatchOptions = {}): PatchPreview {
  const allowIncomplete = options.allowIncomplete ?? false
  const lineLimit = Math.max(1, options.lineLimit ?? DEFAULT_PREVIEW_LINE_LIMIT)
  const operations: MutableOperation[] = []
  const lines = text.split('\n')
  let started = false
  let complete = false
  let invalid = false
  let current: MutableOperation | null = null

  const reject = (): void => {
    if (!allowIncomplete) invalid = true
  }
  const pushLine = (operation: MutableOperation, target: PreviewLine[], line: PreviewLine): void => {
    operation.lineCount += 1
    if (target.length < lineLimit) target.push(line)
    else operation.truncated = true
  }
  const openChunk = (context: string | null): PreviewChunkInternal => {
    const chunk: PreviewChunkInternal = { context, lines: [] }
    current!.chunks.push(chunk)
    return chunk
  }
  const activeChunk = (): PreviewChunkInternal => current!.chunks[current!.chunks.length - 1] ?? openChunk(null)

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.endsWith('\r') ? lines[index]!.slice(0, -1) : lines[index]!
    if (!started) {
      if (raw.trim() === BEGIN_PATCH_MARKER) started = true
      continue
    }
    const trimmed = raw.trim()
    if (trimmed === END_PATCH_MARKER) {
      complete = true
      break
    }
    // Header lines carry no leading indentation; a leading space inside an
    // Update hunk is a context line, exactly as the Host parser reads it.
    const header = raw === raw.trimStart() || current === null
    if (header) {
      if (trimmed === ENVIRONMENT_ID_MARKER.trim()) continue
      if (trimmed.length > ENVIRONMENT_ID_MARKER.length - 1 && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) continue
      if (trimmed.startsWith(ADD_FILE_MARKER)) {
        current = createOperation('add', trimmed.slice(ADD_FILE_MARKER.length))
        operations.push(current)
        continue
      }
      if (trimmed.startsWith(DELETE_FILE_MARKER)) {
        current = createOperation('delete', trimmed.slice(DELETE_FILE_MARKER.length))
        operations.push(current)
        continue
      }
      if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
        current = createOperation('update', trimmed.slice(UPDATE_FILE_MARKER.length))
        operations.push(current)
        continue
      }
      if (current !== null && current.kind === 'update') {
        if (trimmed.startsWith(MOVE_TO_MARKER)) {
          current.moveTo = trimmed.slice(MOVE_TO_MARKER.length)
          continue
        }
        if (trimmed === END_OF_FILE_MARKER) continue
        if (trimmed === CHANGE_CONTEXT_MARKER) {
          openChunk(null)
          continue
        }
        if (trimmed.startsWith(CHANGE_CONTEXT_PREFIX)) {
          openChunk(trimmed.slice(CHANGE_CONTEXT_PREFIX.length) || null)
          continue
        }
      }
      if (trimmed.startsWith('*** ')) {
        // An unknown marker: a complete document could not hold it here.
        reject()
        continue
      }
    }

    const operation = current
    if (operation === null) {
      if (trimmed !== '') reject()
      continue
    }

    // `split('\n')` yields a trailing empty element for text that ends with a
    // newline; it is not patch content.
    if (raw === '' && index === lines.length - 1) continue

    if (operation.kind === 'add') {
      if (!raw.startsWith('+')) {
        reject()
        continue
      }
      pushLine(operation, operation.lines, { kind: 'add', text: raw.slice(1) })
      operation.added += 1
      continue
    }

    if (operation.kind === 'delete') {
      // Delete hunks take no content lines.
      reject()
      continue
    }

    if (raw === '') {
      pushLine(operation, activeChunk().lines, { kind: 'context', text: '' })
      continue
    }
    const marker = raw[0]
    if (marker !== '+' && marker !== '-' && marker !== ' ') {
      reject()
      continue
    }
    const target = activeChunk()
    pushLine(operation, target.lines, {
      kind: marker === '+' ? 'add' : marker === '-' ? 'remove' : 'context',
      text: raw.slice(1),
    })
    if (marker === '+') operation.added += 1
    else if (marker === '-') operation.removed += 1
  }

  return {
    operations: operations.map((operation) => settle(operation)),
    complete,
    invalid,
  }
}

/**
 * Create one mutable operation.
 * @param kind - file operation kind.
 * @param path - authored path (may be a partial path while streaming).
 * @returns the mutable operation.
 */
function createOperation(kind: 'add' | 'delete' | 'update', path: string): MutableOperation {
  return { kind, path, added: 0, removed: 0, lineCount: 0, moveTo: null, lines: [], chunks: [], truncated: false }
}

/**
 * Freeze one mutable operation into its public shape.
 * @param operation - the mutable operation.
 * @returns the public operation.
 */
function settle(operation: MutableOperation): PreviewOperation {
  const base = {
    path: operation.path,
    added: operation.added,
    removed: operation.removed,
    lineCount: operation.lineCount,
  }
  if (operation.kind === 'add') {
    return { kind: 'add', ...base, lines: operation.lines, truncated: operation.truncated }
  }
  if (operation.kind === 'delete') return { kind: 'delete', ...base }
  return {
    kind: 'update',
    ...base,
    moveTo: operation.moveTo,
    chunks: operation.chunks.map((chunk) => ({ context: chunk.context, lines: chunk.lines })),
    truncated: operation.truncated,
  }
}
