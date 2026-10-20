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
  type FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
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
  fs: FileSystem
  shell: ShellExecutor | undefined
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
  constructor(message: string) {
    super(message)
    this.name = 'ApplyError'
  }
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
    return new FsError(
      `${sandboxDenialMarker(policy.mode)} apply_patch: the sandbox denied the file operation.`,
      'FS_SANDBOX_DENIED',
      { cause: error },
    )
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
 * created. Writes are therefore never prefetched or parallelised. On failure
 * the error keeps its type/code and is annotated with the paths that already
 * changed, so the model can reason about the partial state (Codex semantics:
 * an applied hunk is never rolled back).
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

  try {
    for (const hunk of hunks) {
      signal.throwIfAborted()

      if (hunk.kind === 'add') {
        const target = await resolveTarget(hunk.path)
        const intent = await destinationIntent(caps, target, allow)
        let outcome
        try {
          outcome = await fs.writeText(target, hunk.contents, intent, signal, policy)
        } catch (error) {
          throw mapMutationError(error, policy, allow)
        }
        caps.observe(target, { kind: 'present', version: outcome.version })
        affected.added.push(target.displayPath)
        applied.push(`A ${target.displayPath}`)
        continue
      }

      if (hunk.kind === 'delete') {
        const target = await resolveTarget(hunk.path)
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
        await deleteViaShell(caps, target, policy, signal)
        caps.observe(target, { kind: 'absent' })
        affected.deleted.push(target.displayPath)
        applied.push(`D ${target.displayPath}`)
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
      let original: string
      try {
        original = await fs.readText(target, signal)
      } catch (error) {
        throw mapMutationError(error, policy, allow)
      }
      const newContents = deriveNewContents(original, target.displayPath, hunk.chunks)
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
        caps.observe(destination, { kind: 'present', version: outcome.version })
      }

      if (hunk.movePath !== null) {
        const destination = await resolveTarget(hunk.movePath)
        if (sameTarget(target, destination)) {
          // Moving onto itself would write the new contents and then delete the
          // file; treat it as a plain in-place update instead.
          await writeUpdated(target)
          affected.modified.push(target.displayPath)
          applied.push(`M ${target.displayPath}`)
          continue
        }
        const intent = await destinationIntent(caps, destination, allow)
        let outcome
        try {
          outcome = await fs.writeText(destination, newContents, intent, signal, policy)
        } catch (error) {
          throw mapMutationError(error, policy, allow)
        }
        caps.observe(destination, { kind: 'present', version: outcome.version })
        applied.push(`M ${destination.displayPath}`)
        await deleteViaShell(caps, target, policy, signal)
        caps.observe(target, { kind: 'absent' })
        affected.modified.push(destination.displayPath)
        continue
      }

      await writeUpdated(target)
      affected.modified.push(target.displayPath)
      applied.push(`M ${target.displayPath}`)
    }
  } catch (error) {
    if (applied.length > 0 && error instanceof Error) {
      error.message += `\n\nApplied before the failure:\n${applied.join('\n')}`
    }
    throw error
  }

  return affected
}

/** Remove one file through the sandboxed shell seam (`rm`), never bypassing the sandbox. */
async function deleteViaShell(
  caps: ApplyPatchCapabilities,
  target: FsTarget,
  policy: SandboxExecutionPolicy | undefined,
  signal: AbortSignal,
): Promise<void> {
  // One shell run per file is deliberate: a batched `rm -- a b ...` would lose
  // the per-file outcome and change failure ordering (the shell stops at a
  // different point than sequential hunks do). Batching becomes worthwhile
  // only when the upstream FileSystem grows a remove capability.
  const shell = caps.shell
  if (shell === undefined) {
    throw new ApplyError(
      `Cannot delete ${target.displayPath}: no sandboxed shell is mounted in this composition. ` +
      `Use *** Update File: to empty the file instead.`,
    )
  }
  // The process path comes from the fs backend (same execution world).
  const processPath = caps.fs.processPath(target)
  // The seam has no one-shot `run(request)`: `resolve()` turns the request into
  // a fully-resolved spec, `execute(spec)` prepares and spawns it, and the
  // handle's foreground projection `result()` settles with the run outcome.
  // Both are abstract on `ShellExecutor` and identical in dsh 0.1.7-rc.2 and
  // 0.2.0-rc.1; only `result()` carries `exitCode` / `signal` / `sandbox`.
  const spec = shell.resolve({
    command: `rm -- ${shellQuote(processPath)}`,
    sandboxPolicy: policy,
    signal,
  })
  const execution = await shell.execute(spec)
  const result = await execution.result()
  if (result.sandbox?.denied) {
    throw new ApplyError(
      `${sandboxDenialMarker(result.sandbox.mode)} ` +
      `Cannot delete ${target.displayPath}: the sandbox denied the removal.`,
    )
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    const detail = result.signal !== null
      ? `killed by signal: ${result.signal}`
      : `exit code: ${result.exitCode}`
    throw new ApplyError(`Failed to delete file ${target.displayPath} (${detail})`)
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
