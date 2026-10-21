/**
 * Original work: Copyright (c) 2026 fonlan (MIT; see LICENSES/MIT.txt).
 * Modifications: Copyright (c) 2026 miaobuao.
 * Modified 2026-10-20: Codex compatibility and regression coverage.
 * This fork is distributed under GPL-3.0-or-later; see LICENSE and NOTICE.
 */
/**
 * Codex-format apply_patch applier over DSH's sandboxed capability seams.
 *
 * Ports the application semantics of openai/codex's apply-patch crate
 * (codex-rs/apply-patch/src/lib.rs + seek_sequence.rs): chunk context
 * anchoring, verbatim old-line matching with codex's matching lenience
 * (exact → rstrip → trim → Unicode punctuation normalisation), end-of-file anchoring, and pure-insertion
 * placement, then applies the resulting replacement list.
 *
 * All mutations go through DSH's built-in sandbox:
 *  - Add/Update/Move writes: `ctx.fs.writeText` under the per-session
 *    `sandboxPolicy` (the same seam str_replace_editor / write / edit use) —
 *    sandbox denials surface as `[sandbox: ...]` errors, never bypassed.
 *  - Delete/Move-remove: `ctx.shell` (sandboxed bash) `rm` under the same
 *    resolved policy.
 *
 * Observation contract: this applier only reports `fs/observed` facts it has
 * actually established. A successful write reports the resulting version, a
 * successful delete reports absence, and an Update reports its target only
 * after the hunk has matched the file (that match is the read). It never
 * observes a target merely because it is about to overwrite it — so a failed
 * patch leaves the host's read-before-write state untouched.
 *
 * `allowUnobservedOverwrite` (default true, Codex-compatible) decides whether
 * Add/Move may replace a file that exists but was never read, and whether
 * Delete may remove one. When enabled the applier still uses the policy's
 * version guard whenever the model did observe the target; when disabled the
 * policy's no-clobber guard is passed through unchanged, which rejects the
 * operation with `FS_NOT_OBSERVED`.
 */
import {
  FsError,
  type FileSystem,
  type FsObservation,
  type FsTarget,
  type FsVersion,
  type FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { DEFAULT_ALLOW_UNOBSERVED_OVERWRITE } from '../shared/constants.js'
import type { PatchHunk, UpdateChunk } from './parser.js'

/** The codex applier's per-path outcome vocabulary. */
export interface AffectedPaths {
  added: string[]
  modified: string[]
  deleted: string[]
}

/** Sandboxed capability faces the applier needs. */
export interface ApplyPatchCapabilities {
  fs: Pick<FileSystem, 'stat' | 'readText' | 'writeText' | 'processPath'>
  shell: Pick<ShellExecutor, 'resolve' | 'execute'> | undefined
  /** Emit an `fs/observed` record so the observation policy admits the write. */
  observe(target: FsTarget, observation: FsObservation): void
  /** Resolve the write intent for a target through the fs/write-intent waterfall. */
  writeIntent(target: FsTarget): Promise<FsWriteIntent | undefined>
}

/** Per-call application switches. */
export interface ApplyPatchOptions {
  /**
   * Allow Add/Move to replace an existing file the model never read, and
   * Delete to remove one. `true` keeps Codex's semantics; `false` passes the
   * observation policy's no-clobber guard through, so the mutation is denied
   * with the policy's read-before-write error.
   */
  allowUnobservedOverwrite: boolean
}

/** Pure line transformation failure (context/old lines not found). */
export class ApplyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApplyError'
  }
}

/**
 * The step of one hunk that failed.
 */
export type ApplyStage =
  | 'resolve'
  | 'add'
  | 'delete'
  | 'read'
  | 'derive'
  | 'verify'
  | 'update'
  | 'move-write'
  | 'move-remove'

/** A shell removal either never started or has an unconfirmed result. */
export class RemovalFailure extends ApplyError {
  /**
   * @param path - the file whose removal was attempted.
   * @param outcome - `not-started` when no process was spawned, `unknown` once
   *   one was requested but the fs seam cannot confirm what it did.
   * @param cause - the underlying failure that carried the outcome.
   */
  constructor(
    readonly path: string,
    readonly outcome: 'not-started' | 'unknown',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'RemovalFailure'
  }
  /**
   * Preserve the provider failure code for routing.
   * @returns the cause's `code`, or undefined when it carried none.
   */
  get code(): string | undefined {
    const code = errorCode(this.cause)
    return typeof code === 'string' ? code : undefined
  }
}

/**
 * A failure raised by `applyHunks` after some hunks may have been applied.
 *
 * Applied hunks are never rolled back (Codex semantics), so a failure is often
 * partial: this error keeps the original `cause`, names the `stage` that failed
 * and lists every mutation that already landed. The message is rendered once
 * from those fields, so the model reads the same partial state a caller sees.
 */
export class ApplyFailure extends ApplyError {
  /** The step that failed. */
  readonly stage: ApplyStage
  /** Committed hunks in codex A/M/D vocabulary, in application order. */
  readonly applied: readonly string[]
  /** Paths already mutated, grouped by kind. */
  readonly affected: { readonly [K in keyof AffectedPaths]: readonly string[] }
  /** For a failed Move, the destination that already holds the new contents. */
  readonly landedAt: string | undefined
  /** Machine-routable `code` copied from the cause, so it survives the wrap. */
  readonly code: string | undefined
  /** Removal status, when the failing operation was a shell removal. */
  readonly removal: { readonly path: string; readonly outcome: 'not-started' | 'unknown' } | undefined

  constructor(
    cause: unknown,
    stage: ApplyStage,
    applied: readonly string[],
    affected: Readonly<AffectedPaths>,
    landedAt?: string,
  ) {
    super(renderFailure(cause, applied, landedAt), { cause })
    this.name = 'ApplyFailure'
    this.stage = stage
    this.applied = Object.freeze([...applied])
    this.affected = Object.freeze({
      added: Object.freeze([...affected.added]),
      modified: Object.freeze([...affected.modified]),
      deleted: Object.freeze([...affected.deleted]),
    })
    this.landedAt = landedAt
    const code = errorCode(cause)
    this.code = typeof code === 'string' ? code : undefined
    this.removal = cause instanceof RemovalFailure
      ? Object.freeze({ path: cause.path, outcome: cause.outcome })
      : undefined
  }
}

/**
 * Render one failure for the model: the original message, the move caveat when
 * the destination already landed, then every mutation that preceded the failure.
 *
 * @param cause - the error that stopped the patch.
 * @param applied - committed hunks in A/M/D vocabulary, in order.
 * @param landedAt - a Move destination that already holds the new contents.
 * @returns the model-facing message.
 */
function renderFailure(
  cause: unknown,
  applied: readonly string[],
  landedAt: string | undefined,
): string {
  const lines = [cause instanceof Error ? cause.message : String(cause)]
  if (landedAt !== undefined) {
    lines.push('', cause instanceof RemovalFailure && cause.outcome === 'not-started'
      ? `The updated contents were written to ${landedAt}; the source was left in place because no removal started.`
      : `The updated contents were written to ${landedAt}, but source removal was not confirmed. ` +
        'Inspect both paths before retrying; the source may have changed or been removed.')
  }
  if (cause instanceof RemovalFailure && cause.outcome === 'unknown') {
    lines.push('', `Removal outcome is unknown for ${cause.path}. Read the path before retrying.`)
  }
  if (applied.length > 0) lines.push('', 'Applied before the failure:', ...applied)
  return lines.join('\n')
}

/** Read-only view over one file's lines, with lazily cached normal forms. */
interface LineView {
  /** Verbatim line text (without the terminator). */
  readonly raw: string[]
  /** `trimEnd()` of every line; built on first rstrip pass. */
  rstrip?: string[]
  /** `trim()` of every line; built on first trim pass. */
  trim?: string[]
  /** Unicode-punctuation-normalised lines; built on first normalise pass. */
  normalise?: string[]
}

const PUNCT_DASH = /[\u2010-\u2015\u2212]/g
const PUNCT_SINGLE_QUOTE = /[\u2018-\u201b]/g
const PUNCT_DOUBLE_QUOTE = /[\u201c-\u201f]/g
const ODD_SPACES = /[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g

/** Codex's fuzzy-match normalisation for the final matching pass. */
function normaliseLine(value: string): string {
  return value.trim()
    .replace(PUNCT_DASH, '-')
    .replace(PUNCT_SINGLE_QUOTE, "'")
    .replace(PUNCT_DOUBLE_QUOTE, '"')
    .replace(ODD_SPACES, ' ')
}

/**
 * Find `pattern` inside the view at/after `start`, with codex's decreasing
 * strictness: exact match, then trailing-whitespace-insensitive, then
 * fully-trimmed, then Unicode-punctuation-normalised. With `eof`, the search
 * starts at the end of the file.
 *
 * Each pass compares against a cached normal form of the whole file, so a
 * multi-chunk update normalises once per file instead of once per comparison.
 */
function seekSequence(
  view: LineView,
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start
  const lineCount = view.raw.length
  if (pattern.length > lineCount) return null
  const searchStart = eof && lineCount >= pattern.length
    ? Math.max(lineCount - pattern.length, start)
    : start
  const max = lineCount - pattern.length

  const match = (lines: string[], wanted: string[]): number | null => {
    for (let i = searchStart; i <= max; i++) {
      if (lines[i] !== wanted[0]) continue
      let k = 1
      while (k < wanted.length && lines[i + k] === wanted[k]) k++
      if (k === wanted.length) return i
    }
    return null
  }

  const exact = match(view.raw, pattern)
  if (exact !== null) return exact

  view.rstrip ??= view.raw.map((line) => line.trimEnd())
  const rstrip = match(view.rstrip, pattern.map((line) => line.trimEnd()))
  if (rstrip !== null) return rstrip

  view.trim ??= view.raw.map((line) => line.trim())
  const trimmed = match(view.trim, pattern.map((line) => line.trim()))
  if (trimmed !== null) return trimmed

  view.normalise ??= view.raw.map(normaliseLine)
  return match(view.normalise, pattern.map(normaliseLine))
}

/** Compute `(start, oldLen, newLines)` replacements for one file's chunks. */
function computeReplacements(
  view: LineView,
  path: string,
  chunks: UpdateChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  const lineCount = view.raw.length
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const idx = seekSequence(view, [chunk.changeContext], lineIndex, false)
      if (idx === null) {
        throw new ApplyError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      }
      lineIndex = idx + 1
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition appends after every logical source line, including blank lines.
      replacements.push([lineCount, 0, chunk.newLines.slice()])
      continue
    }

    let pattern = chunk.oldLines
    let newSlice = chunk.newLines
    let found = seekSequence(view, pattern, lineIndex, chunk.isEndOfFile)

    if (found === null && pattern[pattern.length - 1] === '') {
      // Trailing-empty sentinel: retry without it (EOF-touching replacements).
      const trimmedPattern = pattern.slice(0, -1)
      const trimmedNew = newSlice[newSlice.length - 1] === '' ? newSlice.slice(0, -1) : newSlice
      found = seekSequence(view, trimmedPattern, lineIndex, chunk.isEndOfFile)
      if (found !== null) {
        pattern = trimmedPattern
        newSlice = trimmedNew
      }
    }

    if (found === null) {
      throw new ApplyError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
      )
    }
    let oldStart = 0
    let newStart = 0
    for (const [oldContext, newContext] of chunk.contextLineIndices ?? []) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([found + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)])
      }
      oldStart = oldContext + 1
      newStart = newContext + 1
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)])
    }
    lineIndex = found + pattern.length
  }

  replacements.sort((a, b) => a[0] - b[0])
  // Guard the reconstruction below: replacements must be ordered and disjoint.
  let previousEnd = 0
  for (const [index, oldLen] of replacements) {
    if (index < previousEnd || index + oldLen > lineCount) {
      throw new ApplyError(`internal: overlapping replacements while updating ${path}`)
    }
    previousEnd = index + oldLen
  }
  return replacements
}

/**
 * Preserve source terminators and context bytes, as Codex SourceFile does.
 *
 * Reconstructs the result from byte offsets in the original string instead of
 * materialising one object per line, and appends with loops rather than
 * `push(...spread)` — a spread of a large slice overflows the call stack
 * (`RangeError: Maximum call stack size exceeded`) on files above ~120k lines.
 */
export function deriveNewContents(originalContents: string, path: string, chunks: UpdateChunk[]): string {
  const starts: number[] = []
  const texts: string[] = []
  let start = 0
  let preferredEnding: string | undefined
  for (const match of originalContents.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0]
    preferredEnding ??= ending
    starts.push(start)
    texts.push(originalContents.slice(start, match.index))
    start = match.index + ending.length
  }
  const endsWithoutTerminator = start < originalContents.length
  if (endsWithoutTerminator) {
    starts.push(start)
    texts.push(originalContents.slice(start))
  }
  preferredEnding ??= '\n'

  const replacements = computeReplacements({ raw: texts }, path, chunks)
  const offsetOf = (line: number): number =>
    line < starts.length ? starts[line] : originalContents.length

  const out: string[] = []
  // A slice that runs to the end of the original includes the unterminated
  // final line; the previous implementation always gave that line an ending.
  const appendSlice = (from: number, to: number): void => {
    if (from >= to) return
    out.push(originalContents.slice(from, to))
    if (endsWithoutTerminator && to === originalContents.length) out.push(preferredEnding)
  }

  let cursor = 0
  for (const [index, oldLen, newLines] of replacements) {
    appendSlice(offsetOf(cursor), offsetOf(index))
    for (const text of newLines) {
      out.push(text, preferredEnding)
    }
    cursor = index + oldLen
  }
  appendSlice(offsetOf(cursor), originalContents.length)
  return out.join('')
}

/** Quote a path for single-quoted shell use. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}

/** Read the stable error `code` without relying on `instanceof` across module copies. */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
}

/**
 * Build the shared sandbox-denial failure: one marker, one stable code, so a
 * denied removal is the same failure kind as a denied write.
 *
 * @param mode - the sandbox mode that denied the operation.
 * @param message - what was denied, in the caller's wording.
 * @param cause - the underlying failure, when a provider reported one.
 * @returns the machine-routable `FS_SANDBOX_DENIED` error.
 */
function sandboxDenial(mode: SandboxMode, message: string, cause?: unknown): FsError {
  return new FsError(
    `${sandboxDenialMarker(mode)} ${message}`,
    'FS_SANDBOX_DENIED',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Map an fs mutation failure: sandbox denials become the shared `[sandbox: ...]`
 * marker error and the strict no-clobber guard gains an actionable hint.
 *
 * Detection reads `error.code` rather than `instanceof FsError`: a `github:`
 * install can resolve a second copy of @deepseek-ai/dsh-fs, and an instanceof
 * check would then silently miss the host provider's errors.
 */
function mapMutationError(
  error: unknown,
  policy: SandboxExecutionPolicy | undefined,
  allowUnobservedOverwrite: boolean,
): unknown {
  const code = errorCode(error)
  if (code === 'FS_SANDBOX_DENIED' && policy !== undefined) {
    return sandboxDenial(policy.mode, 'apply_patch: the sandbox denied the file operation.', error)
  }
  if (code === 'FS_NOT_OBSERVED' && !allowUnobservedOverwrite) {
    const message = error instanceof Error ? error.message : String(error)
    return new ApplyError(
      `${message}. Read the file first, or enable allowUnobservedOverwrite in the dsh-apply-patch settings.`,
    )
  }
  return error
}

/** Whether two resolved targets address the same file (aliases included). */
function sameTarget(a: FsTarget, b: FsTarget): boolean {
  // Test doubles and older backends may omit targetKey; fall back to the
  // model-facing path in that case.
  if (a.targetKey !== undefined && b.targetKey !== undefined) return a.targetKey === b.targetKey
  return a.displayPath === b.displayPath
}

/**
 * The write intent to pass to the provider for Add/Move destinations.
 *
 * A target the model has already observed present keeps the policy's version
 * guard (so a concurrent external change is not clobbered). An unobserved or
 * absent target has no guard to offer: the default (Codex-compatible) mode
 * writes unconditionally, while strict mode passes the policy's `createIfAbsent`
 * through so an existing unread file is rejected with `FS_NOT_OBSERVED`.
 */
async function destinationIntent(
  caps: ApplyPatchCapabilities,
  target: FsTarget,
  allowUnobservedOverwrite: boolean,
): Promise<FsWriteIntent | undefined> {
  const intent = await caps.writeIntent(target)
  if (intent?.kind === 'replaceIfVersion') return intent
  return allowUnobservedOverwrite ? undefined : intent
}

/**
 * Apply parsed hunks through the sandboxed seams, sequentially in patch order.
 *
 * Hunks must run in order: a later hunk may update a file an earlier hunk just
 * created. Writes are therefore never prefetched or parallelised. On failure it
 * throws an {@link ApplyFailure} carrying the original cause, the step that
 * failed and the paths that already changed, so the model can reason about the
 * partial state (Codex semantics: an applied hunk is never rolled back).
 *
 * @param hunks - parsed codex hunks.
 * @param resolveTarget - resolves a hunk path (relative against session cwd).
 * @param caps - fs + shell + observation/intent faces.
 * @param policy - the per-session sandbox policy stamping every mutation.
 * @param signal - caller cancellation (checked between hunks).
 * @param options - per-call switches; defaults to Codex-compatible overwrite.
 * @returns the affected-path summary (codex A/M/D vocabulary).
 */
export async function applyHunks(
  hunks: PatchHunk[],
  resolveTarget: (path: string) => Promise<FsTarget>,
  caps: ApplyPatchCapabilities,
  policy: SandboxExecutionPolicy | undefined,
  signal: AbortSignal,
  options: ApplyPatchOptions = { allowUnobservedOverwrite: DEFAULT_ALLOW_UNOBSERVED_OVERWRITE },
): Promise<AffectedPaths> {
  if (hunks.length === 0) throw new ApplyError('No files were modified.')

  const affected: AffectedPaths = { added: [], modified: [], deleted: [] }
  const applied: string[] = []
  const { fs } = caps
  const allow = options.allowUnobservedOverwrite
  // The step the loop is attempting, and (for a failed Move source removal) the
  // destination whose contents already landed. Both feed the failure below.
  let stage: ApplyStage = 'resolve'
  let landedAt: string | undefined

  try {
    for (const hunk of hunks) {
      stage = 'resolve'
      landedAt = undefined
      signal.throwIfAborted()

      if (hunk.kind === 'add') {
        const target = await resolveTarget(hunk.path)
        stage = 'add'
        const intent = await destinationIntent(caps, target, allow)
        let outcome
        try {
          outcome = await fs.writeText(target, hunk.contents, intent, signal, policy)
        } catch (error) {
          throw mapMutationError(error, policy, allow)
        }
        affected.added.push(target.displayPath)
        applied.push(`A ${target.displayPath}`)
        caps.observe(target, { kind: 'present', version: outcome.version })
        continue
      }

      if (hunk.kind === 'delete') {
        const target = await resolveTarget(hunk.path)
        stage = 'delete'
        const info = await fs.stat(target, signal)
        if (info === undefined) {
          throw new ApplyError(`Failed to delete file ${target.displayPath}: no such file`)
        }
        if (info.type === 'directory') {
          throw new ApplyError(`Failed to delete file ${target.displayPath}: is a directory`)
        }
        if (!allow) {
          // Strict mode: the shell removal has no version guard, so require a
          // prior read that still matches the observed version.
          const intent = await caps.writeIntent(target)
          if (intent?.kind === 'createIfAbsent' || (intent !== undefined && intent.version !== info.version)) {
            throw new ApplyError(
              `Cannot delete ${target.displayPath}: the file was not read first or changed since it was read. ` +
              `Read it before deleting, or enable allowUnobservedOverwrite in the dsh-apply-patch settings.`,
            )
          }
        }
        // A prior read is the only guard Delete has, so it is re-checked right
        // before the run. Default mode keeps Codex's "delete what is there"
        // semantics and passes no version.
        await deleteViaShell(caps, target, policy, signal, allow ? undefined : info.version)
        affected.deleted.push(target.displayPath)
        applied.push(`D ${target.displayPath}`)
        caps.observe(target, { kind: 'absent' })
        continue
      }

      // update (+ optional move)
      const target = await resolveTarget(hunk.path)
      const info = await fs.stat(target, signal)
      if (info === undefined) {
        throw new ApplyError(
          `Failed to update file ${target.displayPath}: no such file. Use *** Add File: to create new files.`,
        )
      }
      if (info.type !== 'file') {
        throw new ApplyError(`Failed to update file ${target.displayPath}: not a regular file`)
      }
      stage = 'read'
      let original: string
      try {
        original = await fs.readText(target, signal)
      } catch (error) {
        throw mapMutationError(error, policy, allow)
      }
      stage = 'derive'
      const newContents = deriveNewContents(original, target.displayPath, hunk.chunks)
      stage = 'verify'
      const afterRead = await fs.stat(target, signal)
      if (afterRead?.version !== info.version) {
        throw new FsError(
          `cannot update ${target.displayPath}: the file changed while it was being read — `
          + 're-read it, then retry',
          'FS_STALE_VERSION',
        )
      }
      // The hunk matched the current bytes, so this is a genuine read
      // observation. Report it before asking for the version-guarded intent.
      caps.observe(target, { kind: 'present', version: info.version })

      const writeUpdated = async (destination: FsTarget): Promise<void> => {
        const intent = await caps.writeIntent(destination)
        let outcome
        try {
          outcome = await fs.writeText(destination, newContents, intent, signal, policy)
        } catch (error) {
          throw mapMutationError(error, policy, allow)
        }
        affected.modified.push(destination.displayPath)
        applied.push(`M ${destination.displayPath}`)
        caps.observe(destination, { kind: 'present', version: outcome.version })
      }

      if (hunk.movePath !== null) {
        const destination = await resolveTarget(hunk.movePath)
        if (sameTarget(target, destination)) {
          // Moving onto itself would write the new contents and then delete the
          // file; treat it as a plain in-place update instead.
          stage = 'update'
          await writeUpdated(target)
          continue
        }
        stage = 'move-write'
        requireShell(caps)
        const intent = await destinationIntent(caps, destination, allow)
        let outcome
        try {
          outcome = await fs.writeText(destination, newContents, intent, signal, policy)
        } catch (error) {
          throw mapMutationError(error, policy, allow)
        }
        applied.push(`M ${destination.displayPath}`)
        affected.modified.push(destination.displayPath)
        landedAt = destination.displayPath
        caps.observe(destination, { kind: 'present', version: outcome.version })
        // The destination is committed from here on: if the source cannot be
        // removed the file stays at both paths, and the failure says so. The
        // source version is guarded in BOTH modes: the destination now holds
        // content derived from that exact version, so removing a source that
        // moved on would discard the newer bytes.
        stage = 'move-remove'
        await deleteViaShell(caps, target, policy, signal, info.version)
        landedAt = undefined
        caps.observe(target, { kind: 'absent' })
        continue
      }

      stage = 'update'
      await writeUpdated(target)
    }
  } catch (error) {
    throw new ApplyFailure(error, stage, applied, affected, landedAt)
  }

  return affected
}

/** Resolve the optional deletion capability before any dependent mutation. */
function requireShell(caps: ApplyPatchCapabilities): NonNullable<ApplyPatchCapabilities['shell']> {
  if (caps.shell === undefined) {
    throw new ApplyError('cannot remove files: no sandboxed shell is mounted — mount a shell provider, then retry')
  }
  return caps.shell
}

/**
 * Remove one file through the sandboxed shell seam (`rm`), never bypassing the sandbox.
 *
 * The fs seam has no remove capability, so this is a check-then-execute pair and
 * is NOT atomic: `expectedVersion` re-checks the file immediately before the run
 * and refuses a changed or vanished one, which narrows the window but cannot
 * close it. Every failure is raised as a {@link RemovalFailure} so a caller can
 * tell a removal that never started from one whose effect is unconfirmed.
 *
 * @param caps - fs + shell faces the removal goes through.
 * @param target - the resolved file to remove.
 * @param policy - the per-session sandbox policy stamping the run.
 * @param signal - caller cancellation.
 * @param expectedVersion - the version the caller based its work on, when it has one.
 */
async function deleteViaShell(
  caps: ApplyPatchCapabilities,
  target: FsTarget,
  policy: SandboxExecutionPolicy | undefined,
  signal: AbortSignal,
  expectedVersion?: FsVersion,
): Promise<void> {
  // One shell run per file is deliberate: a batched `rm -- a b ...` would lose
  // the per-file outcome and change failure ordering (the shell stops at a
  // different point than sequential hunks do). Batching becomes worthwhile
  // only when the upstream FileSystem grows a remove capability.
  let requested = false
  try {
    signal.throwIfAborted()
    const shell = requireShell(caps)
    if (expectedVersion !== undefined) {
      const info = await caps.fs.stat(target, signal)
      if (info === undefined || info.version !== expectedVersion) {
        throw new FsError(
          `cannot delete ${target.displayPath}: the file changed or disappeared after it was read — `
          + 'read it again, then retry',
          'FS_STALE_VERSION',
        )
      }
    }
    // The process path comes from the fs backend (same execution world).
    const processPath = caps.fs.processPath(target)
    // `resolve()` turns the request into a fully-resolved spec and `execute(spec)`
    // prepares and spawns it; only the handle's foreground projection `result()`
    // carries `exitCode` / `signal` / `sandbox`.
    const spec = shell.resolve({
      command: `rm -- ${shellQuote(processPath)}`,
      sandboxPolicy: policy,
      signal,
    })
    signal.throwIfAborted()
    requested = true
    const execution = await shell.execute(spec)
    const result = await execution.result()
    if (result.sandbox?.denied) {
      throw new RemovalFailure(target.displayPath, 'not-started',
        sandboxDenial(result.sandbox.mode, `Cannot delete ${target.displayPath}: the sandbox denied the removal.`))
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      const detail = result.signal !== null ? `killed by signal: ${result.signal}` : `exit code: ${result.exitCode}`
      throw new RemovalFailure(target.displayPath, 'unknown',
        new ApplyError(`Failed to delete file ${target.displayPath} (${detail})`))
    }
  } catch (error) {
    if (error instanceof RemovalFailure) throw error
    throw new RemovalFailure(target.displayPath, requested ? 'unknown' : 'not-started', error)
  }
}

/** Render the codex success summary. */
export function renderSummary(affected: AffectedPaths): string {
  const lines = ['Success. Updated the following files:']
  for (const path of affected.added) lines.push(`A ${path}`)
  for (const path of affected.modified) lines.push(`M ${path}`)
  for (const path of affected.deleted) lines.push(`D ${path}`)
  return lines.join('\n')
}
