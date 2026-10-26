import type { ResolvedSign, SignSource } from './types'

export type SourceCount = { occurrences: number; unique: number }

export type CoverageSummary = {
  totalOccurrences: number
  totalUnique: number
  bySource: Record<SignSource, SourceCount>
  /** Dictionary signs played as avatar motion extracted from the recording (`islrtc_pose`): derived from video and not reviewed. 0 when no tracks are loaded. */
  poseSequence: SourceCount
  /** How many gloss units were shown through a synonym (original word kept in `gloss`), by confidence. */
  synonyms: { exact: number; close: number }
  note: string
}

const SOURCES: SignSource[] = ['yap_animation', 'islrtc_video', 'islrtc_pose', 'fingerspelling', 'unresolved']

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
    if ((item.kind === 'yap_animation' || item.kind === 'islrtc_video' || item.kind === 'islrtc_pose') && item.synonym) synonyms[item.synonym.confidence] += 1
    uniq[item.kind].add(key)
    all.add(key)
  }
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, { occurrences: occ[s], unique: uniq[s].size }])) as Record<SignSource, SourceCount>
  return {
    totalOccurrences: plan.length,
    totalUnique: all.size,
    bySource,
    poseSequence: bySource.islrtc_pose,
    synonyms,
    note: 'Lookup success is not linguistic correctness. Dictionary videos are recordings, not 3D avatar animation; avatar tracks extracted from them are derived from the recordings and unreviewed. Concatenated isolated signs are not grammatical, continuous ISL.',
  }
}
