import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createDiffView, type DiffRow, type DiffSegment } from '../src/shared/file-diff.js'
import { scanPatchPreview } from '../src/shared/patch-preview.js'

const changed = (segments: readonly DiffSegment[] | null): string[] =>
  segments?.filter(part => part.changed).map(part => part.text) ?? []
const rowsOf = (rows: readonly DiffRow[], kind: DiffRow['kind']): DiffRow[] =>
  rows.filter(row => row.kind === kind)
const model = (body: string, header = '@@') => createDiffView(scanPatchPreview(
  `*** Begin Patch\n*** Update File: a\n${header}\n${body}\n*** End Patch`,
  { lineLimit: Number.POSITIVE_INFINITY },
).operations[0]!)

it('renders a bare hunk as remove/add rows without a synthetic header', () => {
  const rows = model('-const value = old\n+const value = new')
  assert.ok(rows.every(row => row.kind !== 'hunk'))
  const removed = rowsOf(rows, 'remove')[0]!
  const added = rowsOf(rows, 'add')[0]!
  assert.equal(removed.oldLine, null)
  assert.equal(removed.newLine, null)
  assert.equal(added.oldLine, null)
  assert.equal(added.newLine, null)
  assert.deepEqual(changed(removed.segments), ['old'])
  assert.deepEqual(changed(added.segments), ['new'])
  assert.equal(removed.text, 'const value = old')
  assert.equal(added.text, 'const value = new')
})

it('uses authored line numbers and a normalized hunk header when present', () => {
  const rows = model('-value = 1\n+value = 2', '@@ -10,1 +20,1 @@')
  assert.equal(rows[0]!.text, '@@ -10,1 +20,1 @@')
  assert.equal(rowsOf(rows, 'remove')[0]!.oldLine, 10)
  assert.equal(rowsOf(rows, 'add')[0]!.newLine, 20)
})

it('aligns a line that expands into two lines by content', () => {
  const rows = model('-const value = oldValue\n+const value =\n+  newValue')
  const removed = rowsOf(rows, 'remove')[0]!
  const added = rowsOf(rows, 'add')
  assert.deepEqual(removed.segments, [
    { text: 'const value =', changed: false },
    { text: ' old', changed: true },
    { text: 'Value', changed: false },
  ])
  assert.equal(added[0]!.text, 'const value =')
  assert.equal(added[0]!.segments, null)
  assert.deepEqual(added[1]!.segments, [
    { text: '  new', changed: true },
    { text: 'Value', changed: false },
  ])
})

it('aligns inline changes by content after a leading inserted line', () => {
  const rows = model([
    '-alpha old', '-beta old', '-gamma old',
    '+inserted', '+alpha new', '+beta new', '+gamma new',
  ].join('\n'))
  const removed = rowsOf(rows, 'remove')
  const added = rowsOf(rows, 'add')
  assert.deepEqual(removed[0]!.segments, [
    { text: 'alpha ', changed: false },
    { text: 'old', changed: true },
  ])
  assert.deepEqual(added[1]!.segments, [
    { text: 'alpha ', changed: false },
    { text: 'new', changed: true },
  ])
})

it('aligns inline changes around a line inserted in the middle of a replacement', () => {
  const rows = model([
    '-alpha old', '-beta old', '-gamma old',
    '+alpha new', '+inserted', '+beta new', '+gamma new',
  ].join('\n'))
  const removed = rowsOf(rows, 'remove')
  const added = rowsOf(rows, 'add')
  assert.deepEqual(removed[1]!.segments, [
    { text: 'beta ', changed: false },
    { text: 'old', changed: true },
  ])
  assert.deepEqual(added[2]!.segments, [
    { text: 'beta ', changed: false },
    { text: 'new', changed: true },
  ])
})

it('keeps ordered matches around repeated lines', () => {
  const rows = model([
    '-item old', '-item old', '-tail old',
    '+item new', '+inserted', '+item new', '+tail new',
  ].join('\n'))
  const added = rowsOf(rows, 'add')
  assert.deepEqual(added.map(row => row.text), ['item new', 'inserted', 'item new', 'tail new'])
  assert.deepEqual(added[2]!.segments, [
    { text: 'item ', changed: false },
    { text: 'new', changed: true },
  ])
})

it('projects a one-line split and a two-line merge without losing content', () => {
  const split = model('-alphabeta\n+alpha\n+beta')
  assert.deepEqual(rowsOf(split, 'remove').map(row => row.text), ['alphabeta'])
  assert.deepEqual(rowsOf(split, 'add').map(row => row.text), ['alpha', 'beta'])

  const merge = model('-alpha\n-beta\n+alphabeta')
  assert.deepEqual(rowsOf(merge, 'remove').map(row => row.text), ['alpha', 'beta'])
  assert.deepEqual(rowsOf(merge, 'add').map(row => row.text), ['alphabeta'])
})

it('keeps the added rows as their own content in the repeated assertion case', () => {
  const rows = model([
    String.raw`-    assert.match(inlinedCss(markup), /\.ap-tool-diff-remove \.ap-tool-diff-char\s*\{[^}]*--dsw-alias-code-diff-deleted/)`,
    String.raw`+    assert.match(inlinedCss(markup), /\.ap-tool-diff-char\s*\{[^}]*color-mix\([^}]*state-success-primary[^}]*36%/)`,
    String.raw`+    assert.match(inlinedCss(markup), /\.ap-tool-diff-char\s*\{[^}]*color-mix\([^}]*state-error-primary[^}]*36%/)`,
  ].join('\n'))
  const added = rowsOf(rows, 'add')
  assert.equal(added.length, 2)
  assert.ok(added[0]!.segments?.some(part => part.changed))
  assert.ok(added[0]!.segments?.some(part => !part.changed))
  assert.ok(added[1]!.segments?.some(part => part.changed))
  assert.deepEqual(added[1]!.segments?.at(-1), { text: '/)', changed: false })
})

it('numbers an add-file hunk from one and marks its lines as added', () => {
  const rows = createDiffView({
    kind: 'add', path: 'a', added: 2, removed: 0, lineCount: 2, truncated: false,
    lines: [{ kind: 'add', text: 'first' }, { kind: 'add', text: 'second' }],
  })
  assert.deepEqual(rows[0], { kind: 'hunk', text: '@@ -0,0 +1,2 @@', oldLine: null, newLine: null, segments: null })
  assert.deepEqual(rowsOf(rows, 'add').map(row => [row.newLine, row.text]), [[1, 'first'], [2, 'second']])
  assert.deepEqual(changed(rowsOf(rows, 'add')[0]!.segments), ['first'])
})

it('keeps context rows between hunks; a bare header has no absolute numbers', () => {
  const rows = model(' context\n-old\n+new\n context2')
  const contexts = rowsOf(rows, 'context')
  assert.deepEqual(contexts.map(row => [row.oldLine, row.newLine, row.text]), [
    [null, null, 'context'],
    [null, null, 'context2'],
  ])
  assert.ok(rows.every(row => row.kind !== 'hunk'))
})

it('marks the first row of a headerless follow-up hunk with a divider', () => {
  const rows = model('-a\n+b\n@@\n-c\n+d')
  assert.equal(rows[0]!.kind, 'remove')
  assert.equal(rows[0]!.hunkStart, undefined)
  const second = rowsOf(rows, 'remove')[1]!
  assert.equal(second.text, 'c')
  assert.equal(second.hunkStart, true)
})

it('drops a context-only chunk instead of surrounding it with dividers', () => {
  const rows = model('-a\n+b\n@@\n context\n@@\n-c\n+d')
  assert.deepEqual(rows.map(row => row.text), ['a', 'b', 'c', 'd'])
  assert.equal(rowsOf(rows, 'context').length, 0)
  assert.equal(rowsOf(rows, 'remove')[1]!.hunkStart, true)
})

it('keeps an empty trailing line instead of collapsing it into the last newline', () => {
  const rows = model('-alpha\n+alpha\n+')
  const added = rowsOf(rows, 'add')
  assert.equal(added.length, 1)
  assert.equal(added[0]!.text, '')
  assert.equal(added[0]!.newLine, null)
})

it('keeps emoji and combining sequences whole inside a changed line', () => {
  const rows = model('-hello 👨‍👩‍👧‍👦!\n+hello 👨‍👩‍👦!')
  assert.deepEqual(changed(rowsOf(rows, 'remove')[0]!.segments), ['👨‍👩‍👧‍👦'])
  assert.equal(rowsOf(rows, 'add')[0]!.text, 'hello 👨‍👩‍👦!')
})

it('falls back to numbered raw rows for a block beyond the diff budget', () => {
  const lines = Array.from({ length: 4_097 }, (_, index) => ({
    kind: index < 2_049 ? 'remove' as const : 'add' as const,
    text: `line ${index}`,
  }))
  const rows = createDiffView({
    kind: 'update', path: 'a', added: 2_048, removed: 2_049, lineCount: lines.length,
    moveTo: null, truncated: false, chunks: [{ context: '-10,3 +20,3 @@', lines }],
  })
  assert.equal(rows[0]!.kind, 'hunk')
  assert.equal(rows[0]!.text, '@@ -10,3 +20,3 @@')
  assert.equal(rows.length, 1 + lines.length)
  assert.ok(rows.slice(1).every(row => row.segments === null))
  assert.equal(rows[1]!.oldLine, 10)
})

it('keeps hunk rows but drops nested segments without a grapheme segmenter', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!
  try {
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true })
    const url = new URL('../src/shared/file-diff.ts?without-segmenter', import.meta.url)
    const fallback = await import(url.href)
    const rows = fallback.createDiffView(scanPatchPreview(
      '*** Begin Patch\n*** Update File: a\n@@ -1,1 +1,1 @@\n-hello 👨‍👩‍👧‍👦!\n+hello 👨‍👩‍👦!\n*** End Patch',
    ).operations[0]!)
    assert.equal(rows[0].kind, 'hunk')
    assert.ok(rows.slice(1).every((row: DiffRow) => row.segments === null))
  } finally {
    Object.defineProperty(Intl, 'Segmenter', descriptor)
  }
})
