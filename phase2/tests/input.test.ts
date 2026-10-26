import { describe, expect, it } from 'vitest'
import { parseGlossInput } from '@/lib/sign/input'

describe('parseGlossInput', () => {
  it('reads a Phase 1 gloss.json and skips sentences without tokens', () => {
    const json = JSON.stringify({
      results: [
        { chunk_id: 'x-0001', source_text: 'Hello students', final_tokens: ['HELLO', 'STUDENT', 'FS:AMIT'] },
        { chunk_id: 'x-0002', source_text: 'failed', final_tokens: null },
        { chunk_id: 'x-0003', source_text: 'Thanks', final_tokens: ['THANK_YOU'] },
      ],
    })
    const out = parseGlossInput(json)
    expect(out.map((s) => s.id)).toEqual(['x-0001', 'x-0003'])
    expect(out[0].tokens).toEqual(['HELLO', 'STUDENT', 'FS:AMIT'])
    expect(out[0].label).toBe('Hello students')
  })

  it('reads arrays and plain text, including .gloss.txt style lines', () => {
    expect(parseGlossInput('["A","B"]')[0].tokens).toEqual(['A', 'B'])
    expect(parseGlossInput('[["A"],["B","C"]]')).toHaveLength(2)
    const txt = '# title\n\n[x-0001] Hello there\n    GLOSS: HELLO THERE   <review_required>\nYOU HOME GO'
    expect(parseGlossInput(txt).map((s) => s.tokens)).toEqual([['HELLO', 'THERE'], ['YOU', 'HOME', 'GO']])
  })

  it('never throws on empty or broken input', () => {
    expect(parseGlossInput('')).toEqual([])
    expect(parseGlossInput('{"results": 3}')).toEqual([])
    expect(parseGlossInput('{broken')).toHaveLength(1)
  })
})
