import type { PlaybackState, Segment } from './playback'
import type { ResolvedSign, SignSource } from './types'

/**
 * Which word of the plan is being signed, which are done, and which have no sign at all. Pure, so the demo's word row can be tested.
 *
 *  - pending   not reached yet
 *  - current   being signed now
 *  - done      signed (as an avatar motion, a hand-made animation, the recorded video or fingerspelling)
 *  - skipped   no sign exists for it, so it was passed over
 *  - failed    its sign was meant to play but did not (a video or track that could not be loaded or timed out)
 */
export type WordStatus = 'pending' | 'current' | 'done' | 'skipped' | 'failed'

export function segmentLength(segment: Segment): number {
  return segment.type === 'avatar' || segment.type === 'pose' ? segment.items.length : 1
}

/** Tokens the hand-made animation player spends on one plan item: a word is one, a fingerspelled name is one per letter. */
function tokensOf(item: ResolvedSign): number {
  return item.kind === 'fingerspelling' ? Math.max(1, item.letters.length) : 1
}

/**
 * The item of an avatar segment that a token position falls in, as an offset into `items`. A position past the last token means the whole
 * phrase is finished and returns `items.length`.
 */
export function itemAtToken(items: readonly ResolvedSign[], tokenIndex: number): number {
  let end = 0
  for (let i = 0; i < items.length; i += 1) {
    end += tokensOf(items[i])
    if (tokenIndex < end) return i
  }
  return items.length
}

/** The status of every word of the plan, given the playback state and the offset of the current word inside the current segment. */
export function wordStatuses(plan: readonly ResolvedSign[], segments: readonly Segment[], state: PlaybackState, offset: number): WordStatus[] {
  const out: WordStatus[] = plan.map(() => 'pending')
  if (state.status === 'idle') return out
  segments.forEach((segment, si) => {
    const count = segmentLength(segment)
    for (let k = 0; k < count; k += 1) {
      const at = segment.start + k
      const finished = state.status === 'done' || si < state.index
      if (finished) {
        const outcome = state.outcomes[si]
        out[at] = plan[at].kind === 'unresolved' ? 'skipped' : outcome === 'error' ? 'failed' : 'done'
      } else if (si === state.index) {
        out[at] = k < offset ? 'done' : k === offset ? 'current' : 'pending'
      }
    }
  })
  return out
}

export type CoverageLine = {
  words: number
  covered: number
  /** Words with no sign at all, in order. */
  missing: string[]
  /** How the covered words are signed. */
  by: Record<Exclude<SignSource, 'unresolved'>, number>
}

/** What the plan covers: every word that is signed one way or another, and the words that are not. */
export function coverageLine(plan: readonly ResolvedSign[]): CoverageLine {
  const by = { yap_animation: 0, islrtc_pose: 0, islrtc_video: 0, fingerspelling: 0 }
  const missing: string[] = []
  for (const item of plan) {
    if (item.kind === 'unresolved') missing.push(item.gloss)
    else by[item.kind] += 1
  }
  return { words: plan.length, covered: plan.length - missing.length, missing, by }
}
