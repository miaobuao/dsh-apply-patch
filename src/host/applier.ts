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

/** Pure line transformation failure (context/old lines not found). */
export class ApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApplyError'
  }
}

/**
 * Find `pattern` inside `lines` at/after `start`, with codex's decreasing
 * strictness: exact match, then trailing-whitespace-insensitive, then
 * fully-trimmed. With `eof`, search starts at the end of the file.
 */
function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return null
  const searchStart = eof && lines.length >= pattern.length
    ? Math.max(lines.length - pattern.length, start)
    : start
  const max = lines.length - pattern.length

  const exact = (i: number) => {
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k] !== pattern[k]) return false
    }
    return true
  }
  const rstrip = (i: number) => {
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k].trimEnd() !== pattern[k].trimEnd()) return false
    }
    return true
  }
  const trim = (i: number) => {
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k].trim() !== pattern[k].trim()) return false
    }
    return true
  }

  for (let i = searchStart; i <= max; i++) if (exact(i)) return i
  for (let i = searchStart; i <= max; i++) if (rstrip(i)) return i
  for (let i = searchStart; i <= max; i++) if (trim(i)) return i
  const normalise = (value: string) => value.trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ')
  for (let i = searchStart; i <= max; i++) {
    if (pattern.every((line, k) => normalise(lines[i + k]) === normalise(line))) return i
  }
  return null
}

/** Compute `(start, oldLen, newLines)` replacements for one file's chunks. */
function computeReplacements(
  originalLines: string[],
  path: string,
  chunks: UpdateChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (idx === null) {
        throw new ApplyError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      }
      lineIndex = idx + 1
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition appends after every logical source line, including blank lines.
      replacements.push([originalLines.length, 0, chunk.newLines.slice()])
      continue
    }

    let pattern = chunk.oldLines
    let newSlice = chunk.newLines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)

    if (found === null && pattern[pattern.length - 1] === '') {
      // Trailing-empty sentinel: retry without it (EOF-touching replacements).
      const trimmedPattern = pattern.slice(0, -1)
      const trimmedNew = newSlice[newSlice.length - 1] === '' ? newSlice.slice(0, -1) : newSlice
      found = seekSequence(originalLines, trimmedPattern, lineIndex, chunk.isEndOfFile)
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
  return replacements
}

/** Preserve source terminators and context bytes, as Codex SourceFile does. */
export function deriveNewContents(originalContents: string, path: string, chunks: UpdateChunk[]): string {
  const lines: Array<{ text: string; ending: string }> = []
  let start = 0
  let preferredEnding: string | undefined
  for (const match of originalContents.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0]
    preferredEnding ??= ending
    lines.push({ text: originalContents.slice(start, match.index), ending })
    start = match.index + ending.length
  }
  preferredEnding ??= '\n'
  if (start < originalContents.length) lines.push({ text: originalContents.slice(start), ending: '' })
  const replacements = computeReplacements(lines.map(line => line.text), path, chunks)
  const result: typeof lines = []
  let cursor = 0
  for (const [index, oldLen, newLines] of replacements) {
    result.push(...lines.slice(cursor, index))
    result.push(...newLines.map(text => ({ text, ending: preferredEnding })))
    cursor = index + oldLen
  }
  result.push(...lines.slice(cursor))
  return result.map(line => line.text + (line.ending || preferredEnding)).join('')
}

/** Quote a path for single-quoted shell use. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}

/** Map an fs mutation failure: sandbox denials become the shared `[sandbox: ...]` marker error. */
function mapMutationError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
  if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED' && policy !== undefined) {
    return new FsError(
      `${sandboxDenialMarker(policy.mode)} apply_patch: the sandbox denied the file operation.`,
      'FS_SANDBOX_DENIED',
      { cause: error },
    )
  }
  return error
}

/**
 * Apply parsed hunks through the sandboxed seams.
 *
 * @param hunks - parsed codex hunks.
 * @param resolveTarget - resolves a hunk path (relative against session cwd).
 * @param caps - fs + shell + observation/intent faces.
 * @param policy - the per-session sandbox policy stamping every mutation.
 * @param signal - caller cancellation.
 * @returns the affected-path summary (codex A/M/D vocabulary).
 */
export async function applyHunks(
  hunks: PatchHunk[],
  resolveTarget: (path: string) => Promise<FsTarget>,
  caps: ApplyPatchCapabilities,
  policy: SandboxExecutionPolicy | undefined,
  signal: AbortSignal,
): Promise<AffectedPaths> {
  if (hunks.length === 0) throw new ApplyError('No files were modified.')

  const affected: AffectedPaths = { added: [], modified: [], deleted: [] }
  const { fs } = caps

  for (const hunk of hunks) {
    if (hunk.kind === 'add') {
      const target = await resolveTarget(hunk.path)
      const info = await fs.stat(target, signal)
      if (info !== undefined) caps.observe(target, { kind: 'present', version: info.version })
      else caps.observe(target, { kind: 'absent' })
      const intent = await caps.writeIntent(target)
      let outcome
      try {
        outcome = await fs.writeText(target, hunk.contents, intent, signal, policy)
      } catch (error) {
        throw mapMutationError(error, policy)
      }
      caps.observe(target, { kind: 'present', version: outcome.version })
      affected.added.push(target.displayPath)
      continue
    }

    if (hunk.kind === 'delete') {
      const target = await resolveTarget(hunk.path)
      const info = await fs.stat(target, signal)
      if (info === undefined) {
        caps.observe(target, { kind: 'absent' })
        throw new ApplyError(
          `Failed to delete file ${target.displayPath}: no such file`,
        )
      }
      if (info.type === 'directory') {
        throw new ApplyError(`Failed to delete file ${target.displayPath}: is a directory`)
      }
      caps.observe(target, { kind: 'present', version: info.version })
      await deleteViaShell(caps, target, policy, signal)
      caps.observe(target, { kind: 'absent' })
      affected.deleted.push(target.displayPath)
      continue
    }

    // update (+ optional move)
    const target = await resolveTarget(hunk.path)
    const info = await fs.stat(target, signal)
    if (info === undefined) {
      caps.observe(target, { kind: 'absent' })
      throw new ApplyError(
        `Failed to update file ${target.displayPath}: no such file. Use *** Add File: to create new files.`,
      )
    }
    if (info.type !== 'file') {
      throw new ApplyError(`Failed to update file ${target.displayPath}: not a regular file`)
    }
    caps.observe(target, { kind: 'present', version: info.version })
    let original: string
    try {
      original = await fs.readText(target, signal)
    } catch (error) {
      throw mapMutationError(error, policy)
    }
    const newContents = deriveNewContents(original, target.displayPath, hunk.chunks)

    if (hunk.movePath !== null) {
      const dest = await resolveTarget(hunk.movePath)
      const destInfo = await fs.stat(dest, signal)
      if (destInfo !== undefined) caps.observe(dest, { kind: 'present', version: destInfo.version })
      else caps.observe(dest, { kind: 'absent' })
      const destIntent = await caps.writeIntent(dest)
      let destOutcome
      try {
        destOutcome = await fs.writeText(dest, newContents, destIntent, signal, policy)
      } catch (error) {
        throw mapMutationError(error, policy)
      }
      caps.observe(dest, { kind: 'present', version: destOutcome.version })
      await deleteViaShell(caps, target, policy, signal)
      caps.observe(target, { kind: 'absent' })
      affected.modified.push(target.displayPath)
      continue
    }

    const intent = await caps.writeIntent(target)
    let outcome
    try {
      outcome = await fs.writeText(target, newContents, intent, signal, policy)
    } catch (error) {
      throw mapMutationError(error, policy)
    }
    caps.observe(target, { kind: 'present', version: outcome.version })
    affected.modified.push(target.displayPath)
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
      `[sandbox: file access denied under ${result.sandbox.mode} mode] ` +
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
