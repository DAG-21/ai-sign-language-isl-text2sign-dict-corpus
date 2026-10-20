import { describe, expect, it } from 'vitest'
import * as words from '@/components/avatar/animations/words'
import { SUPPORTED_TOKENS } from '@/lib/islVocabulary'
import { resolveGloss } from '@/lib/sign/resolver'
import { summarize } from '@/lib/sign/coverage'
import { asset, context } from './fixtures'

const kinds = (r: ReturnType<typeof resolveGloss>) => r.map((x) => x.kind)

describe('existing Yap animation lookup', () => {
  it('every advertised Yap token has a real animation function', () => {
    const missing = SUPPORTED_TOKENS.filter((t) => typeof (words as Record<string, unknown>)[t] !== 'function')
    expect(missing).toEqual([])
  })

  it('prefers the Yap animation even when the dictionary also has the word', () => {
    const [r] = resolveGloss(['HELLO'], context([asset('a1', 'hello')]))
    expect(r.kind).toBe('yap_animation')
  })

  it('matches Yap multiword tokens from underscore form and from adjacent words', () => {
    expect(resolveGloss(['THANK_YOU'], context([]))[0].kind).toBe('yap_animation')
    const r = resolveGloss(['THANK', 'YOU'], context([]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'yap_animation', token: 'THANK_YOU' })
  })
})

describe('ISLRTC-only vocabulary', () => {
  it('exact label match gives a dictionary video that keeps the asset id', () => {
    const [r] = resolveGloss(['RELIGION'], context([asset('a7', 'Religion')]))
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 'a7', via: 'exact' })
  })

  it('normalises case, spaces and punctuation', () => {
    const [r] = resolveGloss(['  religion! '], context([asset('a7', 'Religion')]))
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 'a7' })
  })

  it('only verified aliases are searchable', () => {
    const verified = asset('a1', 'Vehicle', { aliases: [{ text: 'automobile', verified: true, source: 'metadata' }] })
    const unverified = asset('a2', 'Cat', { aliases: [{ text: 'kitty', verified: false, source: 'guess' }] })
    const ctx = context([verified, unverified])
    expect(resolveGloss(['AUTOMOBILE'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'a1', via: 'alias' })
    expect(resolveGloss(['KITTY'], ctx)[0]).toMatchObject({ kind: 'unresolved', reason: 'no_asset' })
  })

  it('approved alias mapping points a gloss at a dictionary label', () => {
    const ctx = context([asset('a9', 'Bike')], { select: {}, alias: { cycle: 'bike' }, split: {} })
    expect(resolveGloss(['CYCLE'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'a9', via: 'alias' })
  })

  it('does not use fuzzy similarity', () => {
    const [r] = resolveGloss(['RELIGIONS'], context([asset('a7', 'Religion')]))
    expect(r.kind).toBe('unresolved')
  })
})

describe('multiword terms', () => {
  it('matches a multiword label from underscore form before single words', () => {
    const ctx = context([asset('m1', 'Religious Studies'), asset('m2', 'Studies')])
    const r = resolveGloss(['RELIGIOUS_STUDIES'], ctx)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'm1' })
  })

  it('matches adjacent single tokens as a phrase and consumes both', () => {
    const ctx = context([asset('m1', 'Religious Studies')])
    const r = resolveGloss(['RELIGIOUS', 'STUDIES', 'TODAY'], ctx)
    expect(r.map((x) => x.kind)).toEqual(['islrtc_video', 'unresolved'])
    expect(r[0]).toMatchObject({ assetId: 'm1' })
  })

  it('does not silently split an unknown multiword gloss', () => {
    const [r] = resolveGloss(['GOOD_AFTERNOON'], context([asset('g', 'Good')]))
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'no_asset' })
  })

  it('splits only through an approved decomposition', () => {
    const ctx = context([], { select: {}, alias: {}, split: { 'good morning': ['good', 'morning'] } })
    expect(resolveGloss(['GOOD_MORNING'], ctx).map((x) => x.kind)).toEqual(['yap_animation', 'yap_animation'])
  })
})

describe('ambiguous terms and alternate signs', () => {
  const two = [asset('b1', 'Bank', { variant: 'money' }), asset('b2', 'Bank', { variant: 'river' })]

  it('refuses to choose between verified variants', () => {
    const [r] = resolveGloss(['BANK'], context(two))
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' })
    expect((r as { candidates: string[] }).candidates.sort()).toEqual(['b1', 'b2'])
  })

  it('follows a reviewed selection', () => {
    const [r] = resolveGloss(['BANK'], context(two, { select: { bank: 'b2' }, alias: {}, split: {} }))
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 'b2', via: 'selected', variant: 'river' })
  })

  it('does not fall back to fingerspelling around an ambiguous entry', () => {
    const [r] = resolveGloss(['BANK'], context(two), { fingerspellUnknown: true })
    expect(r.kind).toBe('unresolved')
  })

  it('ignores duplicates, concept, unreadable and rejected entries when choosing', () => {
    const ctx = context([
      asset('c1', 'Cup'),
      asset('c2', 'Cup', { status: 'duplicate' }),
      asset('c3', 'Cup', { status: 'concept' }),
      asset('c4', 'Cup', { status: 'unreadable' }),
      asset('c5', 'Cup', { status: 'rejected' }),
    ])
    expect(resolveGloss(['CUP'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'c1' })
  })

  it('treats a needs_review sense (a "(Financial Term)" entry) as a competing sign', () => {
    const ctx = context([asset('k1', 'Bank'), asset('k2', 'Bank', { status: 'needs_review', variant: 'Financial Term' })])
    expect(resolveGloss(['BANK'], ctx)[0]).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' })
  })

  it('a reviewer selection may point at a needs_review entry', () => {
    const ctx = context([asset('k1', 'Bank'), asset('k2', 'Bank', { status: 'needs_review' })], { select: { bank: 'k2' }, alias: {}, split: {} })
    expect(resolveGloss(['BANK'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'k2', via: 'selected' })
  })
})

describe('missing and unsupported assets', () => {
  it('reports file_missing when the manifest says so', () => {
    const [r] = resolveGloss(['TREE'], context([asset('t1', 'Tree', { status: 'missing_file' })]))
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'file_missing' })
  })

  it('reports file_missing when the file check fails', () => {
    const [r] = resolveGloss(['TREE'], context([asset('t1', 'Tree')], undefined, () => false))
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'file_missing' })
  })

  it('does not use unverified or concept entries', () => {
    const ctx = context([asset('x1', 'Freedom', { status: 'needs_review' }), asset('x2', 'Honesty', { status: 'concept' })])
    expect(resolveGloss(['FREEDOM'], ctx)[0]).toMatchObject({ kind: 'unresolved', reason: 'not_verified' })
    expect(resolveGloss(['HONESTY'], ctx)[0]).toMatchObject({ kind: 'unresolved', reason: 'not_verified' })
  })
})

describe('default sign for alternates', () => {
  const alts = [asset('g1', 'Tree'), asset('g2', 'Tree', { variant: 'sign_2' }), asset('g3', 'Tree', { variant: 'sign_3' })]
  const mappings = { select: { tree: 'g1' }, alias: {}, split: {}, auto_default: { tree: ['g1', 'g2', 'g3'] } }

  it('uses the indexed default and reports that it is a default with its alternates', () => {
    const [r] = resolveGloss(['TREE'], context(alts, mappings))
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 'g1', via: 'default', alternates: ['g2', 'g3'] })
  })

  it('the same word always gets the same sign, everywhere it occurs', () => {
    const plan = resolveGloss(['TREE', 'HELLO', 'tree', 'TREE', 'Tree!'], context(alts, mappings))
    const ids = plan.filter((p) => p.kind === 'islrtc_video').map((p) => (p as { assetId: string }).assetId)
    expect(ids).toEqual(['g1', 'g1', 'g1', 'g1'])
  })

  it('a reviewer selection that is not an automatic default is reported as selected', () => {
    const reviewed = { select: { tree: 'g2' }, alias: {}, split: {}, auto_default: {} }
    expect(resolveGloss(['TREE'], context(alts, reviewed))[0]).toMatchObject({ assetId: 'g2', via: 'selected' })
  })

  it('without a mapping the word stays ambiguous (no silent choice)', () => {
    expect(resolveGloss(['TREE'], context(alts))[0]).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' })
  })

  it('a default pointing at an unreadable clip is unresolved, not swapped for an alternate', () => {
    const broken = [asset('g1', 'Tree', { status: 'unreadable' }), asset('g2', 'Tree', { variant: 'sign_2' })]
    expect(resolveGloss(['TREE'], context(broken, mappings))[0]).toMatchObject({ kind: 'unresolved', reason: 'unreadable' })
  })
})

describe('synonyms for words with no sign', () => {
  const syn = {
    hi: { to: ['hello'], confidence: 'exact' as const },
    say: { to: ['tell'], confidence: 'close' as const },
    cellphone: { to: ['nonexistent word', 'phone'], confidence: 'exact' as const },
    tradition: { to: ['traditions'], confidence: 'exact' as const },
    bank2: { to: ['bank'], confidence: 'exact' as const },
    good: { to: ['hello'], confidence: 'exact' as const }, // GOOD has its own Yap sign: this entry must never be used
  }
  const mappings = { select: {}, alias: {}, split: {}, synonyms: syn }
  const ctx = (assets = [asset('t1', 'Traditions')]) => context(assets, mappings)

  it('HI is signed as HELLO, keeping the original word and recording the substitution', () => {
    const [r] = resolveGloss(['HI'], ctx())
    expect(r).toMatchObject({ kind: 'yap_animation', gloss: 'HI', token: 'HELLO', synonym: { to: 'hello', confidence: 'exact' } })
  })

  it("a word's own sign always wins over a synonym entry", () => {
    const [r] = resolveGloss(['GOOD'], ctx())
    expect(r).toMatchObject({ kind: 'yap_animation', token: 'GOOD' })
    expect((r as { synonym?: unknown }).synonym).toBeUndefined()
  })

  it('close synonyms are off by default and used only when asked for', () => {
    expect(resolveGloss(['SAY'], ctx())[0]).toMatchObject({ kind: 'unresolved', reason: 'no_asset' })
    expect(resolveGloss(['SAY'], ctx(), { synonyms: 'close' })[0]).toMatchObject({ kind: 'yap_animation', token: 'TELL', gloss: 'SAY', synonym: { confidence: 'close' } })
  })

  it("synonyms: 'off' disables even exact ones", () => {
    expect(resolveGloss(['HI'], ctx(), { synonyms: 'off' })[0]).toMatchObject({ kind: 'unresolved' })
  })

  it('targets are tried in order and a missing target is skipped', () => {
    const [r] = resolveGloss(['CELLPHONE'], ctx())
    expect(r).toMatchObject({ kind: 'yap_animation', token: 'PHONE', synonym: { to: 'phone' } })
  })

  it('a synonym can point at a dictionary video', () => {
    const [r] = resolveGloss(['TRADITION'], ctx())
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 't1', gloss: 'TRADITION', synonym: { to: 'traditions', confidence: 'exact' } })
  })

  it('an ambiguous target is not guessed: the word stays unresolved', () => {
    const c = ctx([asset('b1', 'Bank'), asset('b2', 'Bank', { variant: 'sign_2' })])
    expect(resolveGloss(['BANK2'], c)[0]).toMatchObject({ kind: 'unresolved' })
  })

  it('falls back to fingerspelling only after a failed synonym, and not at all when the synonym works', () => {
    expect(resolveGloss(['HI'], ctx(), { fingerspellUnknown: true })[0].kind).toBe('yap_animation')
    expect(resolveGloss(['SAY'], ctx(), { fingerspellUnknown: true })[0].kind).toBe('fingerspelling')
  })

  it('coverage counts substitutions by confidence and keeps the original word as the gloss', () => {
    const plan = resolveGloss(['HI', 'HELLO', 'SAY', 'TRADITION'], ctx(), { synonyms: 'close' })
    const c = summarize(plan)
    expect(c.synonyms).toEqual({ exact: 2, close: 1 })
    expect(plan.map((p) => p.gloss)).toEqual(['HI', 'HELLO', 'SAY', 'TRADITION'])
  })

  it('mappings without a synonyms table behave exactly as before', () => {
    expect(resolveGloss(['HI'], context([]))[0]).toMatchObject({ kind: 'unresolved', reason: 'no_asset' })
  })
})

describe('review levels', () => {
  it('accepts unreviewed source labels by default and marks them unreviewed', () => {
    const [r] = resolveGloss(['TREE'], context([asset('s1', 'Tree', { status: 'source_label' })]))
    expect(r).toMatchObject({ kind: 'islrtc_video', assetId: 's1', reviewed: false })
  })

  it('requireReview only auto-selects approved entries', () => {
    const ctx = { ...context([asset('s1', 'Tree', { status: 'source_label' }), asset('s2', 'Leaf', { status: 'verified', reviewed: true })]), requireReview: true }
    expect(resolveGloss(['TREE'], ctx)[0]).toMatchObject({ kind: 'unresolved', reason: 'not_verified' })
    expect(resolveGloss(['LEAF'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', assetId: 's2', reviewed: true })
  })

  it('reports unreadable clips', () => {
    expect(resolveGloss(['TREE'], context([asset('u1', 'Tree', { status: 'unreadable' })]))[0]).toMatchObject({ kind: 'unresolved', reason: 'unreadable' })
  })
})

describe('fingerspelling and unresolved', () => {
  it('FS: names are fingerspelled with word gaps removed', () => {
    const [r] = resolveGloss(['FS:JONATHAN_YOUNG'], context([]))
    expect(r.kind).toBe('fingerspelling')
    expect((r as { letters: string[] }).letters.join('')).toBe('JONATHANYOUNG')
  })

  it('plain unknown words are unresolved by default and spelled only on request', () => {
    expect(resolveGloss(['PHILOSOPHY'], context([]))[0]).toMatchObject({ kind: 'unresolved', reason: 'no_asset' })
    expect(resolveGloss(['PHILOSOPHY'], context([]), { fingerspellUnknown: true })[0].kind).toBe('fingerspelling')
  })

  it('drops empty tokens and keeps order, one result per gloss unit', () => {
    const r = resolveGloss(['', 'HELLO', '  ', 'FS:AMIT', 'ZZZ'], context([]))
    expect(kinds(r)).toEqual(['yap_animation', 'fingerspelling', 'unresolved'])
  })
})
