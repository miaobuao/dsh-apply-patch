/**
 * Windowing math tests: which rows a virtualized diff list should mount for a
 * given scroll offset, without needing a DOM.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffCanvasColumns, diffWindow } from '../src/shared/diff-window.js'

/** 240px viewport, 18px rows, six rows of overscan on each side. */
const METRICS = { lineHeight: 18, viewport: 240, overscan: 6 }

describe('diffWindow', () => {
  it('mounts the head window at the top', () => {
    assert.deepEqual(diffWindow(250, 0, METRICS), { start: 0, end: 26 })
  })

  it('moves the window with the scroll offset', () => {
    assert.deepEqual(diffWindow(250, 1800, METRICS), { start: 94, end: 120 })
  })

  it('clamps a stale offset to the end of the list', () => {
    assert.deepEqual(diffWindow(250, 5000, METRICS), { start: 224, end: 250 })
  })

  it('does not window a list shorter than the window', () => {
    assert.deepEqual(diffWindow(10, 0, METRICS), { start: 0, end: 10 })
    assert.deepEqual(diffWindow(10, -50, METRICS), { start: 0, end: 10 })
  })

  it('returns an empty range for an empty list', () => {
    assert.deepEqual(diffWindow(0, 0, METRICS), { start: 0, end: 0 })
  })
})

describe('diffCanvasColumns', () => {
  it('keeps the floor for short diffs', () => {
    assert.equal(diffCanvasColumns(['a', 'bb']), 20)
  })

  it('tracks the widest line plus slack', () => {
    assert.equal(diffCanvasColumns([''.padEnd(30, 'x'), 'short']), 36)
  })

  it('expands tabs to the next eight-column stop', () => {
    // "abc" (3) + tab (to column 8) + "de" (2) = 10 columns, plus slack.
    assert.equal(diffCanvasColumns(['abc\tde'], 0), 16)
  })
})
