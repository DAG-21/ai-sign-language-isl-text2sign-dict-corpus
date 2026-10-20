/**
 * End-to-end check with REAL data: actual Phase 1 gloss output + the real ISLRTC manifest + the real files on disk.
 * Skipped unless these are set (so the normal suite does not depend on the dataset):
 *   PHASE1_GLOSS_DIR   folder with Phase 1 *.gloss.json files (ai-sign-language/data/translations)
 *   ISLRTC_MANIFEST    manifest.json from run_islrtc_index.py
 *   ISLRTC_DATA_DIR    dataset root (clips must exist)
 *   ISLRTC_MAPPINGS    approved_mappings.json (optional; with it, the automatic default signs are exercised)
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_TOKEN_SET } from '@/lib/islVocabulary'
import { parseGlossInput } from '@/lib/sign/input'
import { buildIndex, validateManifest, validateMappings } from '@/lib/sign/manifest'
import { buildSegments } from '@/lib/sign/playback'
import { resolveGloss } from '@/lib/sign/resolver'
import { summarize } from '@/lib/sign/coverage'
import { lookupMedia, type Loaded } from '@/lib/sign/server'

const glossDir = process.env.PHASE1_GLOSS_DIR
const manifestPath = process.env.ISLRTC_MANIFEST
const dataDir = process.env.ISLRTC_DATA_DIR
const mappingsPath = process.env.ISLRTC_MAPPINGS
const configured = Boolean(glossDir && manifestPath && dataDir && fs.existsSync(glossDir) && fs.existsSync(manifestPath) && fs.existsSync(dataDir))

describe.skipIf(!configured)('real Phase 1 sentences through the real dictionary', () => {
  const manifest = configured ? validateManifest(JSON.parse(fs.readFileSync(manifestPath!, 'utf8'))) : null
  const index = manifest ? buildIndex(manifest) : null
  const mappings = validateMappings(mappingsPath && fs.existsSync(mappingsPath) ? JSON.parse(fs.readFileSync(mappingsPath, 'utf8')) : {})
  const data: Loaded | null = index ? { index, mappings, root: fs.realpathSync(dataDir!) } : null
  const sentences = configured
    ? fs.readdirSync(glossDir!).filter((f) => f.endsWith('.gloss.json')).flatMap((f) => parseGlossInput(fs.readFileSync(path.join(glossDir!, f), 'utf8')))
    : []

  it('has real sentences to test with', () => {
    expect(sentences.length).toBeGreaterThan(5)
  })

  it('every gloss unit resolves to exactly one of the four kinds, in order, and dictionary items point at real, readable files', () => {
    let units = 0
    let videos = 0
    for (const s of sentences) {
      const plan = resolveGloss(s.tokens, { yapTokens: SUPPORTED_TOKEN_SET, index: index!, mappings })
      expect(plan.length).toBeGreaterThan(0)
      expect(plan.length).toBeLessThanOrEqual(s.tokens.length)
      for (const item of plan) {
        units += 1
        expect(['yap_animation', 'islrtc_video', 'fingerspelling', 'unresolved']).toContain(item.kind)
        if (item.kind === 'islrtc_video') {
          videos += 1
          const media = lookupMedia(item.assetId, data)
          expect(media.ok, `${item.gloss} -> ${item.assetId}`).toBe(true)
          expect(['source_label', 'verified']).toContain(index!.byId.get(item.assetId)!.status)
        }
        if (item.kind === 'unresolved' && item.reason === 'ambiguous') expect(item.candidates.length).toBeGreaterThan(1)
      }
      // The playback segments must account for every item, none twice.
      const covered = buildSegments(plan).reduce((n, seg) => n + (seg.type === 'avatar' ? seg.items.length : 1), 0)
      expect(covered).toBe(plan.length)
      const cov = summarize(plan)
      expect(Object.values(cov.bySource).reduce((n, c) => n + c.occurrences, 0)).toBe(plan.length)
    }
    expect(units).toBeGreaterThan(50)
    expect(videos).toBeGreaterThan(0) // the dictionary must actually contribute on real sentences
  })

  it.skipIf(!mappingsPath)('with the indexed defaults no word is left ambiguous, and every word keeps the same sign across all sentences', () => {
    const seen = new Map<string, string>()
    for (const s of sentences) {
      const plan = resolveGloss(s.tokens, { yapTokens: SUPPORTED_TOKEN_SET, index: index!, mappings })
      for (const item of plan) {
        if (item.kind === 'unresolved') expect(item.reason, item.gloss).not.toBe('ambiguous')
        if (item.kind !== 'islrtc_video') continue
        const key = item.gloss.toLowerCase()
        const previous = seen.get(key)
        if (previous) expect(item.assetId, `${item.gloss} changed sign between occurrences`).toBe(previous)
        seen.set(key, item.assetId)
      }
    }
    expect(seen.size).toBeGreaterThan(10)
  })
})
