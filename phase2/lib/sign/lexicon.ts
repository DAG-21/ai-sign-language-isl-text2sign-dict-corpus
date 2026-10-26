import { SUPPORTED_TOKENS } from '../islVocabulary'
import { buildIndex } from './manifest'
import { normalizeLabel } from './normalize'
import { resolveGloss, type ResolverContext } from './resolver'
import type { ApprovedMappings, Manifest, ResolvedSign } from './types'

/**
 * One clean list of unique words, each paired with the Yap avatar animation and/or an ISLRTC dictionary clip.
 *
 * "Playable" means exactly what `/demo` would do: the real resolver is run on every word, once with the avatar vocabulary and once
 * with the dictionary alone, so this list cannot drift from the product. It says nothing about whether a sign is linguistically right.
 */

export type LexiconSource =
  /** The avatar has it and the dictionary has a clip too (the avatar is played). */
  | 'both'
  | 'yap_only'
  | 'islrtc_only'
  /** The dictionary has entries for it but none can be auto-selected (several senses, or names flagged needs_review). */
  | 'needs_decision'

export type LexiconRow = {
  /** Normalised word or phrase: the unique key. */
  word: string
  label: string
  words: number
  /** `label`: a dictionary headword or an avatar word. `alias`: an acronym or "A or B" part found in a file name. */
  keyType: 'label' | 'alias'
  source: LexiconSource
  playsNow: boolean
  playsAs: 'yap_animation' | 'islrtc_video' | ''
  yapToken: string
  islrtcAssetId: string
  islrtcRelPath: string
  islrtcVariant: string
  islrtcVia: string
  islrtcStatus: string
  /** Other clips for the same word that are not shown. */
  islrtcAlternates: number
  unresolvedReason: string
  candidates: number
}

export type LexiconStats = {
  uniqueWords: number
  singleWord: number
  multiWord: number
  keyTypes: Record<string, number>
  bySource: Record<LexiconSource, number>
  playsNow: number
  playsNowSingleWord: number
  avatarWords: number
}

const OPTIONS = { synonyms: 'off' as const }

export function buildLexicon(
  manifest: Manifest,
  mappings: ApprovedMappings,
  yapTokens: readonly string[] = SUPPORTED_TOKENS,
): { rows: LexiconRow[]; stats: LexiconStats } {
  const index = buildIndex(manifest)
  const yapByKey = new Map<string, string>()
  for (const token of yapTokens) yapByKey.set(normalizeLabel(token), token)

  const full: ResolverContext = { yapTokens: new Set(yapTokens), index, mappings }
  const dictOnly: ResolverContext = { yapTokens: new Set(), index, mappings }

  const keys = [...new Set<string>([...yapByKey.keys(), ...index.byLabel.keys()])].filter(Boolean).sort()
  const rows: LexiconRow[] = keys.map((key) => {
    const yapToken = yapByKey.get(key) ?? ''
    const dict: ResolvedSign = resolveGloss([key], dictOnly, OPTIONS)[0]
    const final: ResolvedSign = yapToken ? resolveGloss([key], full, OPTIONS)[0] : dict
    const hasClip = dict.kind === 'islrtc_video'
    const asset = hasClip ? index.byId.get(dict.assetId) : undefined
    const isLabel = Boolean(yapToken) || (index.byLabel.get(key) ?? []).some((a) => a.label_norm === key)
    const source: LexiconSource = yapToken ? (hasClip ? 'both' : 'yap_only') : hasClip ? 'islrtc_only' : 'needs_decision'
    return {
      word: key,
      label: dict.kind === 'islrtc_video' ? dict.label : yapToken ? yapToken.replace(/_/g, ' ') : (index.byLabel.get(key)?.[0]?.label ?? key),
      words: key.split(' ').length,
      keyType: isLabel ? 'label' : 'alias',
      source,
      playsNow: final.kind === 'yap_animation' || final.kind === 'islrtc_video',
      playsAs: final.kind === 'yap_animation' || final.kind === 'islrtc_video' ? final.kind : '',
      yapToken,
      islrtcAssetId: dict.kind === 'islrtc_video' ? dict.assetId : '',
      islrtcRelPath: asset?.rel_path ?? '',
      islrtcVariant: dict.kind === 'islrtc_video' ? (dict.variant ?? '') : '',
      islrtcVia: dict.kind === 'islrtc_video' ? dict.via : '',
      islrtcStatus: asset?.status ?? '',
      islrtcAlternates: dict.kind === 'islrtc_video' ? (dict.alternates?.length ?? 0) : 0,
      unresolvedReason: dict.kind === 'unresolved' ? dict.reason : '',
      candidates: dict.kind === 'unresolved' ? dict.candidates.length : 0,
    }
  })

  const bySource: Record<LexiconSource, number> = { both: 0, yap_only: 0, islrtc_only: 0, needs_decision: 0 }
  const keyTypes: Record<string, number> = { label: 0, alias: 0 }
  for (const r of rows) {
    bySource[r.source] += 1
    keyTypes[r.keyType] += 1
  }
  return {
    rows,
    stats: {
      uniqueWords: rows.length,
      singleWord: rows.filter((r) => r.words === 1).length,
      multiWord: rows.filter((r) => r.words > 1).length,
      keyTypes,
      bySource,
      playsNow: rows.filter((r) => r.playsNow).length,
      playsNowSingleWord: rows.filter((r) => r.playsNow && r.words === 1).length,
      avatarWords: yapByKey.size,
    },
  }
}

const COLUMNS: { header: string; value: (r: LexiconRow) => string | number | boolean }[] = [
  { header: 'word', value: (r) => r.word },
  { header: 'label', value: (r) => r.label },
  { header: 'words', value: (r) => r.words },
  { header: 'key_type', value: (r) => r.keyType },
  { header: 'source', value: (r) => r.source },
  { header: 'plays_now', value: (r) => (r.playsNow ? 'yes' : 'no') },
  { header: 'plays_as', value: (r) => r.playsAs },
  { header: 'yap_token', value: (r) => r.yapToken },
  { header: 'islrtc_asset_id', value: (r) => r.islrtcAssetId },
  { header: 'islrtc_rel_path', value: (r) => r.islrtcRelPath },
  { header: 'islrtc_variant', value: (r) => r.islrtcVariant },
  { header: 'islrtc_via', value: (r) => r.islrtcVia },
  { header: 'islrtc_status', value: (r) => r.islrtcStatus },
  { header: 'islrtc_alternates', value: (r) => r.islrtcAlternates },
  { header: 'unresolved_reason', value: (r) => r.unresolvedReason },
  { header: 'candidates', value: (r) => r.candidates },
]

const cell = (v: string | number | boolean) => {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV with a byte-order mark so Excel opens it as UTF-8. */
export function lexiconToCsv(rows: readonly LexiconRow[]): string {
  const lines = [COLUMNS.map((c) => c.header).join(','), ...rows.map((r) => COLUMNS.map((c) => cell(c.value(r))).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}
