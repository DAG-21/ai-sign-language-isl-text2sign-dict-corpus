import { describe, expect, it } from 'vitest'
import { fsLetters, isFsToken, normalizeLabel } from '@/lib/sign/normalize'

// Shared with ai-sign-language tests/test_islrtc_index.py (NORMALIZE_CASES): the indexer and the resolver must agree exactly.
const CASES: [string, string][] = [
  ['  Religion! ', 'religion'],
  ['GOOD_MORNING', 'good morning'],
  ['FS:JONATHAN_YOUNG', 'jonathan young'],
  ['Mother-in-law', 'mother in law'],
  ["Don't", 'dont'],
  ['A/B  Testing', 'a b testing'],
  ['Ache, Pain', 'ache pain'],
  ['120 Volt', '120 volt'],
  ['Café', 'café'],
]

describe('normalizeLabel parity with the Python indexer', () => {
  it.each(CASES)('%j -> %j', (raw, expected) => {
    expect(normalizeLabel(raw)).toBe(expected)
  })

  it('FS helpers', () => {
    expect(isFsToken('fs:amit')).toBe(true)
    expect(fsLetters('FS:Amit_Kumar').join('')).toBe('AMITKUMAR')
  })
})
