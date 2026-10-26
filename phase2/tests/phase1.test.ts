import { describe, expect, it } from 'vitest'
import { DEFAULT_PHASE1_URL, extractSentences, phase1BaseUrl } from '@/lib/sign/phase1'

const llmRow = (id: string, over: Record<string, unknown> = {}) => ({
  sentence_id: id,
  source_text: `source ${id}`,
  status: 'translated',
  final_tokens: ['I', 'SCHOOL', 'GO', 'NO'],
  needs_human_review: false,
  uncertainty_notes: [],
  warnings: [],
  error: null,
  ...over,
})
const spacyRow = (id: string, tokens: string[], status = 'ok') => ({ sentence_id: id, source_text: `source ${id}`, spacy_tokens: tokens, spacy_status: status })
const answer = (llm: Record<string, unknown>, spacy: unknown[]) => ({ llm: { model: 'groq/openai/gpt-oss-120b', error: null, rows: [], ...llm }, spacy: { rows: spacy } })

describe('Phase 1 answer -> gloss per sentence', () => {
  it('uses the LLM layer final gloss when it translated the sentence', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1'), llmRow('s2', { final_tokens: ['HELLO'] })] }, [spacyRow('s1', ['x']), spacyRow('s2', ['y'])]))
    expect(r.sentences.map((s) => [s.engine, s.tokens])).toEqual([['llm', ['I', 'SCHOOL', 'GO', 'NO']], ['llm', ['HELLO']]])
    expect(r.tokens).toEqual(['I', 'SCHOOL', 'GO', 'NO', 'HELLO'])
    expect(r.model).toBe('groq/openai/gpt-oss-120b')
    expect(r.llmError).toBeNull()
  })

  it('upper-cases and joins words so the resolver sees dictionary labels', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1', { final_tokens: ['good morning', 'fs:amit'] })] }, []))
    expect(r.sentences[0].tokens).toEqual(['GOOD_MORNING', 'FS:AMIT'])
  })

  it('falls back to the spaCy layer for a sentence the LLM did not translate, and marks it for review', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1', { status: 'failed', final_tokens: [] })] }, [spacyRow('s1', ['yesterday', 'i', 'school', 'go', 'no'])]))
    expect(r.sentences[0]).toMatchObject({ engine: 'spacy', needsReview: true, tokens: ['YESTERDAY', 'I', 'SCHOOL', 'GO', 'NO'] })
    expect(r.sentences[0].notes[0]).toMatch(/spaCy/)
  })

  it('uses the spaCy rows alone when the LLM layer did not run, and says why', () => {
    const r = extractSentences(answer({ error: { kind: 'missing_api_key', message: 'GROQ_API_KEY is not set' }, rows: [] }, [spacyRow('s1', ['hello']), spacyRow('s2', ['bye'])]))
    expect(r.sentences.map((s) => s.engine)).toEqual(['spacy', 'spacy'])
    expect(r.llmError).toBe('GROQ_API_KEY is not set')
    expect(r.sentences[0].notes[0]).toMatch(/GROQ_API_KEY/)
  })

  it('reports no gloss when neither layer produced one, and keeps the sentence in place', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1', { status: 'failed', final_tokens: [], error: 'timeout' })] }, [spacyRow('s1', [], 'error')]))
    expect(r.sentences[0]).toMatchObject({ engine: 'none', tokens: [], notes: ['timeout'] })
    expect(r.tokens).toEqual([])
  })

  it('carries the LLM doubts and the human-review flag through', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1', { needs_human_review: true, uncertainty_notes: ['idiom'], warnings: [{ message: 'unknown token' }] })] }, []))
    expect(r.sentences[0].needsReview).toBe(true)
    expect(r.sentences[0].notes).toEqual(['idiom', 'unknown token'])
  })

  it('renames the few words Phase 1 writes under another name than the signs, and says so', () => {
    const r = extractSentences(answer({ rows: [llmRow('s1', { final_tokens: ['HI', 'I', 'GO', 'NOT'] })] }, []))
    expect(r.sentences[0].tokens).toEqual(['HELLO', 'I', 'GO', 'NO'])
    expect(r.sentences[0].notes).toEqual(['Signed as: HI → HELLO, NOT → NO'])
  })

  it('survives a malformed answer', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { llm: 'no' }, { llm: { rows: 'no' }, spacy: { rows: [null, 3] } }]) {
      expect(extractSentences(bad).sentences).toEqual([])
    }
  })
})

describe('where Phase 1 is reached', () => {
  it('defaults to the local Phase 1 server', () => {
    expect(phase1BaseUrl({})).toBe(DEFAULT_PHASE1_URL)
  })
  it('accepts another loopback port and trims a trailing slash', () => {
    expect(phase1BaseUrl({ PHASE1_URL: 'http://localhost:9000/' })).toBe('http://localhost:9000')
  })
  it('never sends the text to a non-loopback host', () => {
    expect(phase1BaseUrl({ PHASE1_URL: 'https://evil.example.com' })).toBe(DEFAULT_PHASE1_URL)
    expect(phase1BaseUrl({ PHASE1_URL: 'http://127.0.0.1.evil.com:8765' })).toBe(DEFAULT_PHASE1_URL)
  })
})
