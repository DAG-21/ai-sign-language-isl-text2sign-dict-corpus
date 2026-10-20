/**
 * Coverage report: run real Phase 1 gloss files through the real resolver and manifest.
 *
 *   npx vite-node scripts/coverage-report.ts -- --manifest <manifest.json> --gloss <a.gloss.json> [--gloss ...]
 *        [--mappings approved_mappings.json] [--require-review] [--fingerspell-unknown] [--synonyms off|exact|close] [--json out.json]
 *
 * Occurrence counts (every gloss unit) are kept separate from unique vocabulary counts. A dictionary video is never counted as avatar
 * animation, and lookup success says nothing about linguistic correctness.
 */
import fs from 'node:fs'
import { SUPPORTED_TOKEN_SET } from '../lib/islVocabulary'
import { buildIndex, validateManifest, validateMappings } from '../lib/sign/manifest'
import { resolveGloss } from '../lib/sign/resolver'
import { summarize } from '../lib/sign/coverage'
import { parseGlossInput } from '../lib/sign/input'
import type { ResolvedSign } from '../lib/sign/types'

function arg(name: string, many = false): string[] {
  const out: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1])
  return many ? out : out.slice(0, 1)
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const [manifestPath] = arg('manifest')
const glossFiles = arg('gloss', true)
if (!manifestPath || glossFiles.length === 0) {
  console.error('usage: coverage-report.ts --manifest M --gloss G [--gloss G2 ...] [--mappings P] [--require-review] [--fingerspell-unknown] [--json OUT]')
  process.exit(2)
}

const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
const [mappingsPath] = arg('mappings')
const mappings = validateMappings(mappingsPath && fs.existsSync(mappingsPath) ? JSON.parse(fs.readFileSync(mappingsPath, 'utf8')) : {})
const index = buildIndex(manifest)
const ctx = { yapTokens: SUPPORTED_TOKEN_SET, index, mappings, requireReview: flag('require-review') }
const synonymLevel = (arg('synonyms')[0] ?? 'exact') as 'off' | 'exact' | 'close'
const options = { fingerspellUnknown: flag('fingerspell-unknown'), synonyms: synonymLevel }

const plan: ResolvedSign[] = []
let sentences = 0
for (const file of glossFiles) {
  for (const s of parseGlossInput(fs.readFileSync(file, 'utf8'))) {
    sentences += 1
    plan.push(...resolveGloss(s.tokens, ctx, options))
  }
}
const cov = summarize(plan)

// Vocabulary view: how many distinct dictionary keys can be auto-selected at all.
let unambiguousKeys = 0
let ambiguousKeys = 0
let defaultedKeys = 0
let notAutoKeys = 0
for (const [key, assets] of index.byLabel.entries()) {
  const senses = assets.filter((a) => ['verified', 'source_label', 'needs_review'].includes(a.status))
  if (senses.length === 0) continue
  if (senses.length > 1) {
    if (mappings.select[key]) defaultedKeys += 1 // one sign was fixed for this word (automatic default or reviewer), so it always resolves the same way
    else ambiguousKeys += 1
  }
  else if (senses[0].status === 'verified' || (senses[0].status === 'source_label' && !ctx.requireReview)) unambiguousKeys += 1
  else notAutoKeys += 1
}

const unresolvedReasons: Record<string, number> = {}
const unresolvedGlosses = new Map<string, number>()
for (const item of plan) {
  if (item.kind !== 'unresolved') continue
  unresolvedReasons[item.reason] = (unresolvedReasons[item.reason] ?? 0) + 1
  unresolvedGlosses.set(item.gloss, (unresolvedGlosses.get(item.gloss) ?? 0) + 1)
}
const ambiguousGlosses = [...new Set(plan.filter((p) => p.kind === 'unresolved' && p.reason === 'ambiguous').map((p) => p.gloss))]
const unreviewedVideos = plan.filter((p) => p.kind === 'islrtc_video' && !p.reviewed).length

const dictionaryMatches = [
  ...new Map(
    plan
      .filter((p): p is Extract<ResolvedSign, { kind: 'islrtc_video' }> => p.kind === 'islrtc_video')
      .map((p) => [`${p.gloss}|${p.assetId}`, `${p.gloss} -> ${p.label}${p.variant ? ` [${p.variant}]` : ''} (${p.via}, ${p.assetId})`] as const),
  ).values(),
]

const synonymUses = [
  ...new Set(
    plan.flatMap((p) => ((p.kind === 'yap_animation' || p.kind === 'islrtc_video') && p.synonym ? [`${p.gloss} -> ${p.synonym.to.toUpperCase()} (${p.synonym.confidence})`] : [])),
  ),
]

const result = {
  sentences,
  options: { requireReview: ctx.requireReview, fingerspellUnknown: options.fingerspellUnknown, synonyms: synonymLevel },
  gloss: cov,
  unresolvedReasons,
  ambiguousGlosses,
  topUnresolved: [...unresolvedGlosses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
  unreviewedDictionaryVideoOccurrences: unreviewedVideos,
  dictionaryMatches,
  synonymUses,
  vocabulary: {
    yapAnimationTokens: SUPPORTED_TOKEN_SET.size,
    dictionaryKeysAutoSelectable: unambiguousKeys,
    dictionaryKeysWithSeveralSignsAndAFixedDefault: defaultedKeys,
    dictionaryKeysAmbiguousNoDefault: ambiguousKeys,
    dictionaryKeysNeedingReview: notAutoKeys,
    poseSequenceKeys: 0,
  },
}

const [jsonOut] = arg('json')
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1))
console.log(JSON.stringify(result, null, 1))
