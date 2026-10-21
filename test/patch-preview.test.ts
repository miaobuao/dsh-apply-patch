/**
 * Preview-scanner tests: the browser-safe, tolerant read of a codex patch.
 *
 * The Host parser tests own validity; these cases pin the preview contract a
 * streaming Tool view depends on — ordered operations, exact added/removed
 * counts, a bounded line preview, and no throw on a half-arrived document.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanPatchPreview } from '../src/shared/patch-preview.js'

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`

describe('scanPatchPreview', () => {
  it('reads operations in patch order with exact counts', () => {
    const preview = scanPatchPreview(wrap([
      '*** Update File: src/a.ts',
      '@@ keep',
      ' same',
      '-old',
      '+new',
      '+extra',
      '*** Add File: src/b.ts',
      '+one',
      '+two',
      '*** Delete File: old.txt',
    ].join('\n')))

    assert.equal(preview.complete, true)
    assert.equal(preview.invalid, false)
    assert.deepEqual(preview.operations.map((operation) => [operation.kind, operation.path]), [
      ['update', 'src/a.ts'],
      ['add', 'src/b.ts'],
      ['delete', 'old.txt'],
    ])
    const [update, add, remove] = preview.operations
    assert.ok(update !== undefined && update.kind === 'update')
    assert.equal(update.added, 2)
    assert.equal(update.removed, 1)
    assert.equal(update.chunks.length, 1)
    assert.equal(update.chunks[0]?.context, 'keep')
    assert.deepEqual(update.chunks[0]?.lines.map((line) => [line.kind, line.text]), [
      ['context', 'same'],
      ['remove', 'old'],
      ['add', 'new'],
      ['add', 'extra'],
    ])
    assert.ok(add !== undefined && add.kind === 'add')
    assert.equal(add.added, 2)
    assert.deepEqual(add.lines.map((line) => line.text), ['one', 'two'])
    assert.ok(remove !== undefined && remove.kind === 'delete')
    assert.equal(remove.added, 0)
    assert.equal(remove.removed, 0)
  })

  it('reads a streaming prefix without throwing or reporting it invalid', () => {
    const preview = scanPatchPreview('*** Begin Patch\n*** Add File: src/part', { allowIncomplete: true })
    assert.equal(preview.complete, false)
    assert.equal(preview.invalid, false)
    assert.deepEqual(preview.operations.map((operation) => [operation.kind, operation.path]), [
      ['add', 'src/part'],
    ])
  })

  it('tolerates a half-arrived line inside the body', () => {
    const preview = scanPatchPreview('*** Begin Patch\n*** Add File: a.ts\n+one\n*** Add F', { allowIncomplete: true })
    assert.equal(preview.invalid, false)
    assert.equal(preview.operations.length, 1)
    assert.equal(preview.operations[0]?.added, 1)
  })

  it('reports malformed complete content as invalid but keeps parsed operations', () => {
    const preview = scanPatchPreview('*** Begin Patch\n*** Delete File: gone.txt\nstray content\n*** End Patch')
    assert.equal(preview.complete, true)
    assert.equal(preview.invalid, true)
    assert.deepEqual(preview.operations.map((operation) => operation.path), ['gone.txt'])
  })

  it('keeps counts exact while bounding the line preview', () => {
    const body = ['*** Add File: big.txt', ...Array.from({ length: 5 }, (_, index) => `+line ${index}`)].join('\n')
    const preview = scanPatchPreview(wrap(body), { lineLimit: 2 })
    const operation = preview.operations[0]
    assert.ok(operation !== undefined && operation.kind === 'add')
    assert.equal(operation.added, 5)
    assert.equal(operation.lines.length, 2)
    assert.equal(operation.truncated, true)
  })

  it('carries a Move to destination on the update operation', () => {
    const preview = scanPatchPreview(wrap([
      '*** Update File: src/from.ts',
      '*** Move to: src/to.ts',
      '@@',
      '-a',
      '+b',
      '*** End of File',
    ].join('\n')))
    const [operation] = preview.operations
    assert.ok(operation !== undefined && operation.kind === 'update')
    assert.equal(operation.moveTo, 'src/to.ts')
    assert.equal(operation.added, 1)
    assert.equal(operation.removed, 1)
  })

  it('skips a heredoc wrapper before the begin marker', () => {
    const preview = scanPatchPreview("<<'EOF'\n*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\nEOF\n")
    assert.equal(preview.complete, true)
    assert.deepEqual(preview.operations.map((operation) => operation.path), ['a.ts'])
  })

  it('reads an empty patch as complete with no operations', () => {
    const preview = scanPatchPreview(wrap(''))
    assert.equal(preview.complete, true)
    assert.equal(preview.invalid, false)
    assert.deepEqual(preview.operations, [])
  })

  it('normalizes CRLF line endings', () => {
    const preview = scanPatchPreview(
      '*** Begin Patch\r\n*** Add File: a.ts\r\n+one\r\n*** Delete File: b.ts\r\n*** End Patch',
    )
    assert.equal(preview.complete, true)
    assert.equal(preview.operations[0]?.path, 'a.ts')
    assert.equal(preview.operations[0]?.added, 1)
    assert.deepEqual(preview.operations.map((operation) => operation.path), ['a.ts', 'b.ts'])
  })
})
