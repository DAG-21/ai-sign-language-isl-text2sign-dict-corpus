import type { ResolvedSign, SignSource } from './types'

export type SourceCount = { occurrences: number; unique: number }

export type CoverageSummary = {
  totalOccurrences: number
  totalUnique: number
  bySource: Record<SignSource, SourceCount>
  /** Experimental pose sequences are counted separately and are 0 until real avatar renders exist. */
  poseSequence: SourceCount
  /** How many gloss units were shown through a synonym (original word kept in `gloss`), by confidence. */
  synonyms: { exact: number; close: number }
  note: string
}

const SOURCES: SignSource[] = ['yap_animation', 'islrtc_video', 'fingerspelling', 'unresolved']

/**
 * Occurrence counts (every gloss unit) are kept apart from unique vocabulary
 * counts (distinct glosses). A dictionary video is never counted as an avatar
 * animation, and a successful lookup says nothing about linguistic correctness.
 */
export function summarize(plan: readonly ResolvedSign[]): CoverageSummary {
  const occ = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<SignSource, number>
  const uniq = Object.fromEntries(SOURCES.map((s) => [s, new Set<string>()])) as Record<SignSource, Set<string>>
  const all = new Set<string>()
  const synonyms = { exact: 0, close: 0 }

  for (const item of plan) {
    const key = item.gloss.toUpperCase()
    occ[item.kind] += 1
    if ((item.kind === 'yap_animation' || item.kind === 'islrtc_video') && item.synonym) synonyms[item.synonym.confidence] += 1
    uniq[item.kind].add(key)
    all.add(key)
  }
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, { occurrences: occ[s], unique: uniq[s].size }])) as Record<SignSource, SourceCount>
  return {
    totalOccurrences: plan.length,
    totalUnique: all.size,
    bySource,
    poseSequence: { occurrences: 0, unique: 0 },
    synonyms,
    note: 'Lookup success is not linguistic correctness. Dictionary videos are recordings, not 3D avatar animation. Concatenated isolated signs are not grammatical, continuous ISL.',
  }
}
