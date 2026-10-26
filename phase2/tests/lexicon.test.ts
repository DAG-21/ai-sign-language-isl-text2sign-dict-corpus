import { describe, expect, it } from 'vitest'
import { buildLexicon, lexiconToCsv } from '@/lib/sign/lexicon'
import { asset } from './fixtures'
import { EMPTY_MAPPINGS, type Manifest } from '@/lib/sign/types'

const manifest = (assets: ReturnType<typeof asset>[]): Manifest => ({ schema_version: '1.0', source: 'test', generated_at: 'x', assets })

describe('buildLexicon', () => {
  const m = manifest([
    asset('a1', 'Hello', { status: 'source_label' }),
    asset('a2', 'Bank', { status: 'source_label' }),
    asset('a3', 'Region', { variant: 'Math', status: 'needs_review' }),
    asset('a4', 'Region', { variant: 'Science', status: 'needs_review' }),
  ])
  const { rows, stats } = buildLexicon(m, EMPTY_MAPPINGS, ['HELLO', 'THANK_YOU'])
  const row = (w: string) => rows.find((r) => r.word === w)!

  it('pairs each unique word with the avatar and/or a dictionary clip', () => {
    expect(row('hello')).toMatchObject({ source: 'both', playsAs: 'yap_animation', yapToken: 'HELLO', islrtcAssetId: 'a1' })
    expect(row('thank you')).toMatchObject({ source: 'yap_only', playsAs: 'yap_animation', words: 2 })
    expect(row('bank')).toMatchObject({ source: 'islrtc_only', playsAs: 'islrtc_video', islrtcAssetId: 'a2' })
  })

  it('marks a word with only unresolvable dictionary entries as needing a decision', () => {
    expect(row('region')).toMatchObject({ source: 'needs_decision', playsNow: false, unresolvedReason: 'ambiguous', candidates: 2 })
  })

  it('counts unique words and what plays now', () => {
    expect(stats).toMatchObject({ uniqueWords: 4, playsNow: 3, avatarWords: 2 })
    expect(stats.bySource).toEqual({ both: 1, yap_only: 1, islrtc_only: 1, needs_decision: 1 })
  })

  it('writes a CSV with a header, quoting where needed', () => {
    const csv = lexiconToCsv(rows)
    expect(csv.startsWith('﻿word,label,words,')).toBe(true)
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(5)
  })
})
