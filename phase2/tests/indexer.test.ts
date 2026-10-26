import { describe, expect, it } from 'vitest'
import { assetIdFor, buildIndexFiles, parseName } from '@/lib/sign/indexer'
import { buildIndex, validateManifest } from '@/lib/sign/manifest'
import { resolveGloss } from '@/lib/sign/resolver'
import { SUPPORTED_TOKEN_SET } from '@/lib/islVocabulary'

describe('parseName', () => {
  it('splits a (Sign_N) alternate from its headword', () => {
    expect(parseName('C/Can_(Sign_2).mp4')).toMatchObject({ label: 'Can', altNumber: 2, senses: [], acronyms: [] })
    expect(parseName('S/Sick_(Sign).mp4').altNumber).toBe(1)
  })

  it('treats other qualifiers as senses and acronyms as acronyms', () => {
    expect(parseName('R/Region_(Math).mp4')).toMatchObject({ label: 'Region', senses: ['Math'], altNumber: null })
    expect(parseName('G/Global_Citizenship_Education_(GCED).mp4')).toMatchObject({ label: 'Global Citizenship Education', acronyms: ['GCED'], senses: [] })
    expect(parseName('O/Office_Memorandum(O.M.).mp4')).toMatchObject({ label: 'Office Memorandum', acronyms: ['O.M.'] })
  })

  it('reads the " - English" tag and "Sign 3" written with a space', () => {
    expect(parseName('W/World - English.mp4')).toMatchObject({ label: 'World', english: true, trailingNumber: false })
    expect(parseName('A/AB Testing- English.mp4')).toMatchObject({ label: 'AB Testing', english: true })
    expect(parseName('X/Foo - English_1.mp4')).toMatchObject({ label: 'Foo', english: true, trailingNumber: true })
    expect(parseName('B/Bharat (Sign 3).mp4')).toMatchObject({ label: 'Bharat', altNumber: 3 })
  })

  it('peels several qualifiers and flags numbers and "or" names', () => {
    expect(parseName('U/United_Nations_Convention_(UNCRPD)_(Sign_2).mp4')).toMatchObject({ label: 'United Nations Convention', altNumber: 2, acronyms: ['UNCRPD'] })
    expect(parseName('T/Tractor_2.mp4').trailingNumber).toBe(true)
    expect(parseName('H/Hotel_or_Motel.mp4').orParts).toEqual(['Hotel', 'Motel'])
  })
})

describe('buildIndexFiles', () => {
  const paths = ['C/Can.mp4', 'C/Can_(Sign_2).mp4', 'R/Region_(Math).mp4', 'R/Region_(Science).mp4', 'G/Global_Citizenship_Education_(GCED).mp4', 'readme.md']

  it('indexes only videos and gives stable ids', () => {
    const { manifest } = buildIndexFiles(paths, new Date(0))
    expect(manifest.assets).toHaveLength(5)
    expect(manifest.assets[0].asset_id).toBe(assetIdFor(manifest.assets[0].rel_path))
    expect(manifest.assets.every((a) => /^[A-Za-z0-9_-]{1,64}$/.test(a.asset_id))).toBe(true)
  })

  it('picks the base file as the one default for a word with alternates, and lists the rest', () => {
    const { manifest, mappings } = buildIndexFiles(paths)
    const base = manifest.assets.find((a) => a.rel_path === 'C/Can.mp4')!
    const alt = manifest.assets.find((a) => a.rel_path === 'C/Can_(Sign_2).mp4')!
    expect(mappings.select.can).toBe(base.asset_id)
    expect(mappings.auto_default?.can).toEqual([base.asset_id, alt.asset_id])
  })

  it('ranks the plain file ahead of its " - English" copy, and resolves a word that only has the English one', () => {
    const { manifest, mappings } = buildIndexFiles(['H/Hero.mp4', 'H/Hero - English.mp4', 'W/World - English.mp4'])
    const plain = manifest.assets.find((a) => a.rel_path === 'H/Hero.mp4')!
    expect(mappings.select.hero).toBe(plain.asset_id)
    const ctx = { yapTokens: SUPPORTED_TOKEN_SET, index: buildIndex(validateManifest(manifest)), mappings }
    expect(resolveGloss(['WORLD'], ctx)[0]).toMatchObject({ kind: 'islrtc_video', label: 'World', variant: 'English' })
  })

  it('leaves a word ambiguous when every candidate still needs review', () => {
    const { mappings, stats } = buildIndexFiles(paths)
    expect(mappings.select.region).toBeUndefined()
    expect(stats.leftAmbiguous).toBe(1)
  })

  it('produces files the resolver accepts: default sign, ambiguity, acronym alias', () => {
    const { manifest, mappings } = buildIndexFiles(paths)
    const ctx = { yapTokens: SUPPORTED_TOKEN_SET, index: buildIndex(validateManifest(manifest)), mappings }
    const [can] = resolveGloss(['CAN'], ctx)
    expect(can).toMatchObject({ kind: 'islrtc_video', via: 'default', reviewed: false })
    const [region] = resolveGloss(['REGION'], ctx)
    expect(region).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' })
    const [gced] = resolveGloss(['GCED'], ctx)
    expect(gced).toMatchObject({ kind: 'islrtc_video', label: 'Global Citizenship Education' })
  })
})
