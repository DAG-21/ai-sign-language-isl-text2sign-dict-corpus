import fs from 'node:fs'
import path from 'node:path'
import { SUPPORTED_TOKENS, SUPPORTED_TOKEN_SET } from '../lib/islVocabulary'
import { normalizeLabel } from '../lib/sign/normalize'
import { loadPoseIndex, poseResolverHook, readPoseEnv } from '../lib/sign/poseServer'
import { resolveGloss } from '../lib/sign/resolver'
import { loadSignData } from '../lib/sign/server'
import { EMPTY_MAPPINGS } from '../lib/sign/types'

/**
 * One row per distinct word (every dictionary headword plus the hand-made vocabulary): how the app would sign it today, and why not when it cannot.
 * Uses the real resolver with the real manifest, mappings and avatar tracks, with synonym fallback off, so the list says what each word is on its own.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/build-word-coverage.ts -- [--out data/coverage/word_coverage.csv]
 */

const outIdx = process.argv.indexOf('--out')
const out = outIdx >= 0 ? process.argv[outIdx + 1] : path.join('data', 'coverage', 'word_coverage.csv')

const data = loadSignData()
if (!data) throw new Error('No manifest: set ISLRTC_MANIFEST or create data/islrtc/manifest.json')
const pose = poseResolverHook()
const poseIndex = loadPoseIndex()
const sizesFile = path.join(readPoseEnv().dir, 'sizes.json')
const sizes: Record<string, number | null> = fs.existsSync(sizesFile) ? JSON.parse(fs.readFileSync(sizesFile, 'utf8')).sizes : {}
const ctx = { yapTokens: SUPPORTED_TOKEN_SET, index: data.index, mappings: data.mappings ?? EMPTY_MAPPINGS, pose: pose ?? undefined }

const STATUS = { yap_animation: 'hand-made animation', islrtc_pose: 'avatar motion', islrtc_video: 'video only', unresolved: 'no sign' } as const
const WHY: Record<string, string> = {
  not_verified: 'dictionary entry needs review (sense qualifier, long phrase or unclear label)',
  ambiguous: 'the dictionary has several signs for this word and a person must choose one',
  file_missing: 'the clip file is missing',
  unreadable: 'the clip could not be read',
  no_asset: 'not in the dictionary',
  empty: 'empty',
}

const words = new Map<string, string>() // normalised key -> spelling to resolve
for (const a of data.index.byId.values()) words.set(normalizeLabel(a.label), a.label)
for (const t of SUPPORTED_TOKENS) words.set(normalizeLabel(t), t)

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const HEADER = ['word', 'status', 'how_resolved', 'why_no_sign_or_no_avatar_motion', 'dictionary_clip', 'clip_variant', 'clip_reviewed', 'asset_id', 'clip_mb', 'track_hands_fraction', 'track_body_fraction', 'also_hand_made', 'alternate_clips']

type Row = Record<(typeof HEADER)[number], string | number>
const rows: Row[] = []

for (const [key, spelling] of words) {
  const tokens = spelling.split(/[\s_]+/).filter(Boolean)
  const [item] = resolveGloss(tokens, ctx, { synonyms: 'off' })
  const row: Row = Object.fromEntries(HEADER.map((h) => [h, ''])) as Row
  row.word = spelling.replace(/_/g, ' ')
  row.status = STATUS[item.kind as keyof typeof STATUS] ?? item.kind

  const clips = data.index.byLabel.get(key) ?? []
  if (item.kind === 'yap_animation') {
    row.also_hand_made = 'yes'
    row.dictionary_clip = clips.length ? `${clips.length} dictionary clip${clips.length > 1 ? "s also exist" : " also exists"} (not used: the hand-made sign comes first)` : 'no dictionary clip'
  } else if (item.kind === 'islrtc_pose' || item.kind === 'islrtc_video') {
    const asset = data.index.byId.get(item.assetId)
    const p = poseIndex?.assets[item.assetId]
    row.how_resolved = item.via
    row.dictionary_clip = asset ? asset.rel_path.split('/').pop() ?? '' : ''
    row.clip_variant = item.variant ?? ''
    row.clip_reviewed = item.reviewed ? 'yes' : 'no'
    row.asset_id = item.assetId
    const size = asset ? sizes[asset.rel_path] : null
    row.clip_mb = size ? Math.round((size / 1e6) * 100) / 100 : ''
    row.alternate_clips = item.alternates?.length ?? ''
    if (p) {
      row.track_hands_fraction = p.handFrac
      row.track_body_fraction = p.poseFrac
    }
    if (item.kind === 'islrtc_video') {
      row.why_no_sign_or_no_avatar_motion = !p
        ? 'avatar motion not extracted for this clip (clips over 5 MB were not processed)'
        : `avatar motion rejected by the quality check: ${p.reasons.map((r) => ({ few_hands: 'hands seen in too few frames', body_lost: 'signer lost in too many frames', no_window: 'no signing found' })[r]).join(', ')}`
    }
  } else if (item.kind === 'unresolved') {
    row.why_no_sign_or_no_avatar_motion = WHY[item.reason] ?? item.reason
    row.alternate_clips = item.candidates.length || ''
    row.dictionary_clip = clips.map((a) => a.rel_path.split('/').pop()).slice(0, 3).join(' | ')
  }
  rows.push(row)
}

const ORDER = ['hand-made animation', 'avatar motion', 'video only', 'no sign']
rows.sort((a, b) => ORDER.indexOf(String(a.status)) - ORDER.indexOf(String(b.status)) || String(a.word).localeCompare(String(b.word), 'en', { sensitivity: 'base' }))

fs.mkdirSync(path.dirname(out), { recursive: true })
// UTF-8 with a byte-order mark and CRLF line ends so Excel opens it correctly.
fs.writeFileSync(out, '﻿' + [HEADER.join(','), ...rows.map((r) => HEADER.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n', 'utf8')
const counts: Record<string, number> = {}
for (const r of rows) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1
console.log(`${rows.length} words -> ${out}`)
console.log(counts)
