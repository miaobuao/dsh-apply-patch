/**
 * Original work: Copyright (c) 2026 fonlan (MIT; see LICENSES/MIT.txt).
 * Modifications: Copyright (c) 2026 miaobuao.
 * Modified 2026-10-20: Codex compatibility and regression coverage.
 * This fork is distributed under GPL-3.0-or-later; see LICENSE and NOTICE.
 */
/**
 * Model-facing-surface tests for `apply_patch`: the description and the
 * `patch` parameter carry the grammar rules, and nothing else.
 *
 * The assertions pin the contract the model reads, not the prose: the sample
 * document it copies, the grammar rules, and the two facts it cannot learn
 * from an error message. Every additional sentence is context it pays for on
 * every request, so the size bound is part of the test.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_PARAMETERS } from '../src/host/tool.js'

/** Words in a prompt string (the crude unit the size bound is stated in). */
function words(text: string): number {
  return text.trim().split(/\s+/).length
}

describe('apply_patch description', () => {
  const description = APPLY_PATCH_DESCRIPTION
  const patchParam = APPLY_PATCH_PARAMETERS.patch

  it('keeps the codex document sample the model copies', () => {
    for (const marker of [
      '*** Begin Patch',
      '*** Update File: path/to/file.py',
      '@@ optional context line',
      '*** Add File: path/to/new.py',
      '*** Delete File: path/to/old.py',
      '*** End Patch',
    ]) {
      assert.ok(description.includes(marker), `sample keeps ${marker}`)
    }
  })

  it('carries no bullet list of rules', () => {
    assert.ok(!description.includes('Rules:'), 'no rule list heading')
    assert.deepEqual(
      description.split('\n').filter((line) => line.startsWith('* ')),
      [],
      'no bullet lines',
    )
  })

  it('states the two facts an error message cannot teach', () => {
    assert.match(description, /not rolled back/)
    assert.match(description, /session working directory/)
  })

  it('leaves hunk grammar to the patch parameter', () => {
    // Say each fact once: these belong next to the value they constrain.
    assert.ok(!description.includes('*** Move to:'))
    assert.ok(!description.includes('*** End of File'))
    // Recovery advice belongs in the error text, not in every request.
    assert.ok(!description.includes('do not retry another way'))
    // Unconditional claims are wrong when `allowUnobservedOverwrite` is off.
    assert.ok(!description.includes('Overwrites the file'))
  })

  it('stays short', () => {
    assert.ok(words(description) <= 100, `description is ${words(description)} words`)
  })

  it('describes one required string parameter', () => {
    assert.equal(patchParam.type, 'string')
    assert.equal(patchParam.required, true)
  })

  it('states the document grammar on the patch parameter', () => {
    const text = patchParam.description
    for (const rule of [
      '*** Begin Patch',
      '*** End Patch',
      'one or more file hunks',
      '*** Move to: <path>',
      '*** End of File',
    ]) {
      assert.ok(text.includes(rule), `patch description states ${rule}`)
    }
  })
})
