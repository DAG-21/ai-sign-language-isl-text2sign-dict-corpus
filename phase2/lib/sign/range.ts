export type ByteRange = { start: number; end: number }

/**
 * Parse a single-range HTTP `Range: bytes=...` header against a file size.
 * Returns null when there is no (usable) Range header, `'unsatisfiable'` when
 * the range lies outside the file. Multi-range requests are served whole.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
