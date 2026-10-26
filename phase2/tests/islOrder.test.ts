import { describe, expect, it } from 'vitest'
import { reorderForIsl } from '@/lib/sign/islOrder'
import { extractSentences } from '@/lib/sign/phase1'

/**
 * The textbook's example sentences (NIOS Indian Sign Language 230, Lesson 10 and Lesson 9), the gloss the book gives, and what Phase 1's LLM layer actually returned
 * for the English sentence when it was run on 26 Oct 2026 (Groq openai/gpt-oss-120b, prompt 8.0). `rule` says which textbook rule the sentence shows.
 */
type Case = { english: string; book: string; layer1: string; rule: Rule[]; expected: string }
type Rule = 'time-first' | 'not-last' | 'have-last' | 'must-last' | 'question-last' | 'verb-last'

const CASES: Case[] = [
  { english: 'Do you have a brother or sister?', book: 'BROTHER/SISTER HAVE', layer1: 'YOU HAVE BROTHER OR SISTER', rule: ['have-last'], expected: 'YOU BROTHER OR SISTER HAVE' },
  { english: 'I do not like sleeping late in the morning.', book: 'MORNING SLEEP LATE LIKE NOT', layer1: 'I NOT LIKE SLEEP LATE MORNING', rule: ['time-first', 'not-last'], expected: 'MORNING I LIKE SLEEP LATE NOT' },
  { english: 'I will go home late tonight.', book: 'I TONIGHT HOME GO LATE', layer1: 'I WILL GO HOME LATE TONIGHT', rule: ['time-first'], expected: 'TONIGHT I WILL HOME LATE GO' },
  { english: 'I will not come home tonight.', book: 'TONIGHT HOME COME NOT', layer1: 'I WILL NOT COME HOME TONIGHT', rule: ['time-first', 'not-last'], expected: 'TONIGHT I WILL HOME COME NOT' },
  { english: 'Where are you going?', book: 'YOU GO WHERE', layer1: 'WHERE YOU GO', rule: ['question-last'], expected: 'YOU GO WHERE' },
  { english: 'Have you finished your food?', book: 'YOU FOOD FINISH', layer1: 'YOU FINISH YOUR FOOD', rule: ['verb-last'], expected: 'YOU YOUR FOOD FINISH' },
  { english: 'Students must sit in the class.', book: 'CLASS STUDENTS SIT MUST', layer1: 'STUDENTS MUST SIT IN CLASS', rule: ['must-last'], expected: 'STUDENTS IN CLASS SIT MUST' },
  // Phase 1 returned these two English sentences as one row (it did not split after "Class X."): left alone, two subjects.
  { english: 'I passed Class X. I go to class every Friday.', book: 'I 10 PASS / CLASS GO FRIDAY++', layer1: 'I PASS CLASS X I GO CLASS EVERY FRIDAY', rule: [], expected: 'I PASS CLASS X I GO CLASS EVERY FRIDAY' },
  { english: 'If it rains, I will not go to school.', book: 'RAIN SCHOOL GO NOT', layer1: 'IF IT RAIN I NOT GO SCHOOL', rule: [], expected: 'IF IT RAIN I NOT GO SCHOOL' },
  { english: 'I plan to go to Delhi by train.', book: 'I PLAN DELHI TRAIN GO', layer1: 'I PLAN GO FS:DELHI BY TRAIN', rule: [], expected: 'I PLAN GO FS:DELHI BY TRAIN' },
  { english: 'You must take a ticket for the Delhi train.', book: 'YOU DELHI TRAIN TICKET MUST', layer1: 'YOU MUST TAKE TICKET FOR FS:DELHI TRAIN', rule: ['must-last'], expected: 'YOU TICKET FOR FS:DELHI TRAIN TAKE MUST' },
  { english: 'It is raining heavily at my home.', book: 'HOME RAIN HEAVY', layer1: 'IT RAIN HEAVILY AT MY HOME', rule: ['verb-last'], expected: 'IT HEAVILY AT MY HOME RAIN' },
  { english: 'I have seen this movie many times.', book: 'MOVIE SEE++', layer1: 'I SEE THIS MOVIE MANY TIMES', rule: ['verb-last'], expected: 'I THIS MOVIE MANY TIMES SEE' },
]
const words = (s: string) => s.split(' ')

// The textbook's position rules, as checks on a gloss.
const TIME = new Set(['YESTERDAY', 'TODAY', 'TOMORROW', 'TONIGHT', 'MORNING', 'EVENING', 'NIGHT', 'FRIDAY'])
const checks: Record<Rule, (t: string[]) => boolean> = {
  'time-first': (t) => TIME.has(t[0]),
  'not-last': (t) => ['NOT', 'NO'].includes(t[t.length - 1]),
  'have-last': (t) => t[t.length - 1] === 'HAVE',
  'must-last': (t) => t[t.length - 1] === 'MUST',
  'question-last': (t) => ['WHERE', 'WHO', 'WHAT', 'WHEN', 'WHY', 'HOW'].includes(t[t.length - 1]),
  'verb-last': (t) => {
    const last = t[t.length - 1]
    return ['FINISH', 'RAIN', 'SEE', 'GO', 'COME', 'SIT', 'TAKE', 'SLEEP'].includes(last)
  },
}

describe('the textbook sentences through the word-order step', () => {
  for (const c of CASES) {
    it(`${c.english}`, () => {
      const r = reorderForIsl(words(c.layer1))
      expect(r.tokens.join(' ')).toBe(c.expected)
      expect(r.changed).toBe(c.expected !== c.layer1)
    })
  }

  it('satisfies every textbook position rule the sentences show, where Phase 1 satisfied none of the end-position ones', () => {
    const END: Rule[] = ['not-last', 'have-last', 'must-last', 'question-last']
    const tally = { all: { total: 0, before: 0, after: 0 }, end: { total: 0, before: 0, after: 0 } }
    for (const c of CASES) {
      const raw = words(c.layer1)
      const fixed = reorderForIsl(raw).tokens
      for (const rule of c.rule) {
        for (const bucket of rule === 'time-first' || rule === 'verb-last' ? [tally.all] : [tally.all, tally.end]) {
          bucket.total += 1
          if (checks[rule](raw)) bucket.before += 1
          if (checks[rule](fixed)) bucket.after += 1
        }
      }
    }
    // 12 rule checks over the 14 sentences; 6 of them are end-position rules (NOT x2, HAVE, MUST x2, question word).
    expect(tally.all.total).toBe(12)
    expect(tally.end).toEqual({ total: 6, before: 0, after: 6 })
    expect(tally.all.after).toBe(12)
    expect(tally.all.before).toBeLessThan(5)
  })

  it('moves the same words, never adding, dropping or renaming one', () => {
    for (const c of CASES) {
      const raw = words(c.layer1)
      const fixed = reorderForIsl(raw).tokens
      expect([...fixed].sort()).toEqual([...raw].sort())
    }
  })

  it('is stable: ordering an ordered sentence changes nothing', () => {
    for (const c of CASES) {
      const once = reorderForIsl(words(c.layer1)).tokens
      const twice = reorderForIsl(once)
      expect(twice.changed).toBe(false)
      expect(twice.tokens).toEqual(once)
    }
  })
})

describe('what the rules do and do not do', () => {
  it('puts a time phrase first, keeping EVERY and number-unit phrases together', () => {
    expect(reorderForIsl(words('I GO SCHOOL EVERY FRIDAY')).tokens.join(' ')).toBe('EVERY FRIDAY I SCHOOL GO')
    expect(reorderForIsl(words('I LIVE HERE 3 YEARS')).tokens.join(' ')).toBe('3 YEARS I HERE LIVE')
    expect(reorderForIsl(words('I MEET FRIEND LAST WEEK')).tokens.join(' ')).toBe('LAST WEEK I FRIEND MEET')
  })
  it('leaves a time word that is already first, and moves only the verb', () => {
    expect(reorderForIsl(words('TOMORROW I SCHOOL GO')).changed).toBe(false)
    expect(reorderForIsl(words('TOMORROW I GO SCHOOL')).tokens.join(' ')).toBe('TOMORROW I SCHOOL GO')
  })
  it('puts several tail words in the textbook order: MUST, HAVE, negation, question word', () => {
    expect(reorderForIsl(words('WHY NOT MUST YOU GO')).tokens.join(' ')).toBe('YOU GO MUST NOT WHY')
  })
  it('does not treat the greeting GOOD_MORNING or a longer label as a time word', () => {
    expect(reorderForIsl(words('GOOD_MORNING EVERYONE I WANT SAY')).changed).toBe(false)
  })
  it('leaves a clause with two verbs in the order it has, apart from the position words', () => {
    const r = reorderForIsl(words('I WANT GO MARKET'))
    expect(r.changed).toBe(false)
    expect(r.notes[0]).toMatch(/several verbs/)
  })
  it('leaves multi-clause sentences alone and says why', () => {
    for (const s of ['IF IT RAIN I NOT GO', 'I STAY HOME BECAUSE RAIN', 'I EAT AND DRINK', 'I GO HE COME']) {
      const r = reorderForIsl(words(s))
      expect(r.changed).toBe(false)
      expect(r.notes[0]).toMatch(/Left in place/)
    }
  })
  it('does nothing to one word, an empty list, or a sentence with no rule to apply', () => {
    expect(reorderForIsl([]).changed).toBe(false)
    expect(reorderForIsl(['HELLO']).changed).toBe(false)
    expect(reorderForIsl(words('MY NAME FS:AMIT')).changed).toBe(false)
  })
  it('does not change its input', () => {
    const input = words('I NOT LIKE SLEEP LATE MORNING')
    const copy = [...input]
    reorderForIsl(input)
    expect(input).toEqual(copy)
  })
})

describe('in the Phase 1 adapter', () => {
  const llm = (tokens: string[]) => ({ llm: { rows: [{ sentence_id: 's1', source_text: 'x', status: 'translated', final_tokens: tokens }] }, spacy: { rows: [] } })

  it('reorders the LLM layer, marks the sentence and keeps what Phase 1 wrote', () => {
    const s = extractSentences(llm(['I', 'WILL', 'NOT', 'COME', 'HOME', 'TONIGHT'])).sentences[0]
    expect(s.tokens).toEqual(['TONIGHT', 'I', 'WILL', 'HOME', 'COME', 'NO'])
    expect(s.reordered).toBe(true)
    expect(s.originalTokens).toEqual(['I', 'WILL', 'NOT', 'COME', 'HOME', 'TONIGHT'])
    expect(s.notes.join(' ')).toMatch(/Reordered by the ISL word-order rules/)
    expect(s.notes.join(' ')).toMatch(/Phase 1 wrote: I WILL NOT COME HOME TONIGHT/)
  })
  it('leaves an already-ordered sentence unmarked', () => {
    const s = extractSentences(llm(['YOU', 'GO', 'WHERE'])).sentences[0]
    expect(s.reordered).toBe(false)
    expect(s.originalTokens).toBeNull()
  })
  it('does not reorder the spaCy layer, which already follows the rules', () => {
    const answer = {
      llm: { error: { message: 'no key' }, rows: [{ sentence_id: 's1', source_text: 'x', status: 'failed', final_tokens: [] }] },
      spacy: { rows: [{ sentence_id: 's1', source_text: 'x', spacy_status: 'ok', spacy_tokens: ['yesterday', 'i', 'school', 'go', 'not'] }] },
    }
    const s = extractSentences(answer).sentences[0]
    expect(s.engine).toBe('spacy')
    expect(s.reordered).toBe(false)
    expect(s.tokens).toEqual(['YESTERDAY', 'I', 'SCHOOL', 'GO', 'NO'])
  })
})
