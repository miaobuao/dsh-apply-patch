/**
 * Copyright (c) 2026 miaobuao.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Created 2026-10-20 for Codex compatibility regression coverage.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import { applyHunks, deriveNewContents, type ApplyPatchCapabilities } from '../src/host/applier.js'
import { parsePatch } from '../src/host/parser.js'

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`

it('preserves CRLF, CR, mixed endings and original fuzzy-matched context', () => {
  const chunks = parsePatch(wrap('*** Update File: f\n@@\n before\n-old\n+new\n after'))[0]
  assert.equal(chunks.kind, 'update')
  if (chunks.kind !== 'update') return
  for (const ending of ['\n', '\r\n', '\r']) {
    assert.equal(deriveNewContents(` before  ${ending}old${ending}after${ending}`, 'f', chunks.chunks),
      ` before  ${ending}new${ending}after${ending}`)
  }
  assert.equal(deriveNewContents('before\r\nold\nafter\r', 'f', chunks.chunks), 'before\r\nnew\r\nafter\r')
})

it('normalises Unicode punctuation and odd spaces when matching', () => {
  const hunk = parsePatch(wrap('*** Update File: f\n@@\n-hello-"world" there\n+new'))[0]
  if (hunk.kind !== 'update') throw new Error('expected update')
  assert.equal(deriveNewContents('hello—“world”\u00a0there\n', 'f', hunk.chunks), 'new\n')
})

it('appends after real trailing blank lines', () => {
  assert.equal(deriveNewContents('a\n\n', 'f', [{ changeContext: null, oldLines: [], newLines: ['b'], isEndOfFile: false }]), 'a\n\nb\n')
})

it('does not search backwards after a previous EOF chunk', () => {
  const chunk = { changeContext: null, oldLines: ['b'], newLines: ['B'], isEndOfFile: true }
  assert.throws(() => deriveNewContents('a\nb\n', 'f', [chunk, chunk]), /Failed to find/)
})

it('rejects late Move to, content after EOF and embedded patch markers', () => {
  for (const body of [
    '*** Update File: f\n@@\n-a\n+b\n*** Move to: g',
    '*** Update File: f\n@@\n-a\n+b\n*** End of File\n+c',
    '*** Add File: f\n+a\n*** Begin Patch',
    '*** Add File: f\n+a\n*** End Patch\n*** Add File: g\n+b',
    '*** Add File: f\n+a\n',
  ]) assert.throws(() => parsePatch(wrap(body)))
})

// Run the upstream byte-for-byte fixtures against the real parser/applier.
const fixtures = new URL('./fixtures/codex/', import.meta.url)
for (const scenario of readdirSync(fixtures)) {
  if (!/^\d/.test(scenario)) continue
  it(`upstream Codex fixture: ${scenario}`, async () => {
    const root = join(fixtures.pathname, scenario)
    const collect = (dir: string, prefix = ''): Map<string, string> => {
      const files = new Map<string, string>()
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = prefix + entry.name
          if (entry.isDirectory()) {
            for (const item of collect(join(dir, entry.name), path + '/')) files.set(...item)
          } else files.set(path, readFileSync(join(dir, entry.name), 'utf8'))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return files
    }
    const files = collect(join(root, 'input'))
    const expected = collect(join(root, 'expected'))
    const isDirectory = (path: string) => [...files.keys()].some(key => key.startsWith(path + '/'))
    const pathOf = (target: { displayPath: string }) => target.displayPath
    const caps = {
      fs: {
        stat: async (target: { displayPath: string }) => files.has(pathOf(target)) ? { type: 'file', version: 'v' } : isDirectory(pathOf(target)) ? { type: 'directory', version: 'v' } : undefined,
        readText: async (target: { displayPath: string }) => files.get(pathOf(target))!,
        writeText: async (target: { displayPath: string }, content: string) => {
          const path = pathOf(target)
          if (isDirectory(path)) throw new Error('is a directory')
          files.set(path, content)
          return { version: 'v' }
        },
        processPath: pathOf,
      },
      shell: {
        resolve: (spec: { command: string }) => spec,
        execute: async (spec: { command: string }) => ({ result: async () => {
          const path = spec.command.slice("rm -- '".length, -1).replaceAll("'\\''", "'")
          const deleted = files.delete(path)
          return { exitCode: deleted ? 0 : 1, signal: null }
        } }),
      },
      observe() {},
      writeIntent: async () => undefined,
    } as unknown as ApplyPatchCapabilities
    let failed = false
    try {
      await applyHunks(parsePatch(readFileSync(join(root, 'patch.txt'), 'utf8')),
        async path => ({ displayPath: path }) as never,
        caps, undefined, new AbortController().signal)
    } catch { failed = true }
    assert.equal(failed, /rejects|fails|failure|requires_existing/.test(scenario), scenario)
    assert.deepEqual([...files].sort(), [...expected].sort(), scenario)
  })
}
