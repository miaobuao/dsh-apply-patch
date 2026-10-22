/**
 * Windowing math for a virtualized diff list.
 *
 * Kept out of the React row so the arithmetic can be tested without a DOM:
 * given the total line count, the scroll offset, and the geometry, it returns
 * the half-open row range that should exist as nodes. The caller renders
 * spacers for the rows outside the window so the scrollbar keeps the full
 * content height.
 */

/** Geometry of one virtualized list. */
export interface DiffWindowMetrics {
  /** Rendered height of one row, in CSS pixels. */
  readonly lineHeight: number
  /** Visible viewport height, in CSS pixels. */
  readonly viewport: number
  /** Extra rows rendered on each side of the viewport. */
  readonly overscan: number
}

/** Half-open `[start, end)` row range that should be rendered. */
export interface DiffWindow {
  readonly start: number
  readonly end: number
}

/**
 * Compute the rows to render for one scroll offset.
 * @param lineCount - total rows in the list.
 * @param scrollTop - current scroll offset in CSS pixels (negative clamps to 0).
 * @param metrics - row height, viewport height, and overscan.
 * @returns the half-open range to render; `start === end` for an empty list.
 */
export function diffWindow(lineCount: number, scrollTop: number, metrics: DiffWindowMetrics): DiffWindow {
  const total = Math.max(0, Math.floor(lineCount))
  if (total === 0) return { start: 0, end: 0 }
  const lineHeight = Math.max(1, metrics.lineHeight)
  const overscan = Math.max(0, Math.floor(metrics.overscan))
  const firstVisible = Math.max(0, Math.floor(Math.max(0, scrollTop) / lineHeight))
  const visibleRows = Math.ceil(Math.max(1, metrics.viewport) / lineHeight)
  const windowRows = visibleRows + overscan * 2
  // Clamp within the list: a stale scroll offset (for example after the list
  // shrank) must not produce a start past the end.
  const start = Math.min(Math.max(0, firstVisible - overscan), Math.max(0, total - windowRows))
  const end = Math.min(total, start + windowRows)
  return { start, end }
}

/**
 * Width budget for a horizontally scrollable diff canvas, in columns.
 *
 * The canvas keeps a fixed width for the whole diff so the horizontal
 * scrollbar does not jump while the virtualized list scrolls, and so each
 * line's added/removed background spans the full scrollable width. Tabs are
 * expanded to the next 8-column stop, and East Asian wide/fullwidth characters
 * (plus emoji) count as two columns: a terminal-style monospace font renders
 * them at roughly twice the narrow advance, so counting one column would let
 * the text outrun its tinted row.
 * @param texts - every line text in the diff.
 * @param minimum - floor width, so short diffs still fill their container.
 * @param slack - extra columns reserved for line padding and glyph rounding.
 * @returns the canvas width in `ch` units.
 */
export function diffCanvasColumns(
  texts: readonly string[],
  minimum = 20,
  slack = 6,
): number {
  let widest = 0
  for (const text of texts) {
    let column = 0
    for (const char of text) {
      if (char === '\t') {
        column += 8 - (column % 8)
        continue
      }
      column += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
    }
    if (column > widest) widest = column
  }
  return Math.max(minimum, widest + slack)
}

/**
 * Whether a code point is rendered at roughly two monospace cells.
 * @param code - Unicode code point.
 * @returns true for East Asian wide/fullwidth characters and emoji.
 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) // Hangul Jamo
    || (code >= 0x2e80 && code <= 0x303e) // CJK radicals and punctuation
    || (code >= 0x3041 && code <= 0x33ff) // kana, CJK compatibility
    || (code >= 0x3400 && code <= 0x4dbf) // CJK extension A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK unified ideographs
    || (code >= 0xa000 && code <= 0xa4cf) // Yi
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
    || (code >= 0xfe30 && code <= 0xfe6f) // CJK compatibility forms
    || (code >= 0xff00 && code <= 0xff60) // fullwidth forms
    || (code >= 0xffe0 && code <= 0xffe6) // fullwidth signs
    || (code >= 0x1f300 && code <= 0x1faff) // emoji
    || (code >= 0x20000 && code <= 0x3fffd) // CJK extensions B+
  )
}
