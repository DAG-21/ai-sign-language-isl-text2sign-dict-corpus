import type { ResolvedSign } from './types'

/**
 * Turns a resolved plan into playback segments and steps through them.
 *
 * Consecutive avatar items (Yap animations and fingerspelling) are merged into
 * one phrase so the existing AvatarPlayer queue plays them exactly as before;
 * dictionary videos and unresolved markers are separate segments. Isolated
 * signs played one after another are not continuous, grammatical ISL.
 */
export type Segment =
  | { type: 'avatar'; phrase: string; items: ResolvedSign[] }
  | { type: 'video'; item: Extract<ResolvedSign, { kind: 'islrtc_video' }> }
  | { type: 'unresolved'; item: Extract<ResolvedSign, { kind: 'unresolved' }> }

export function buildSegments(plan: readonly ResolvedSign[]): Segment[] {
  const segments: Segment[] = []
  for (const item of plan) {
    if (item.kind === 'islrtc_video') {
      segments.push({ type: 'video', item })
    } else if (item.kind === 'unresolved') {
      segments.push({ type: 'unresolved', item })
    } else {
      const words = item.kind === 'yap_animation' ? [item.token] : item.letters
      const last = segments[segments.length - 1]
      if (last?.type === 'avatar') {
        last.items.push(item)
        last.phrase += ' ' + words.join(' ')
      } else {
        segments.push({ type: 'avatar', phrase: words.join(' '), items: [item] })
      }
    }
  }
  return segments
}

export type Outcome = 'completed' | 'error' | 'skipped'

export type PlaybackState = {
  status: 'idle' | 'playing' | 'done'
  /** Index of the segment being played; equals segments.length when done. */
  index: number
  outcomes: Outcome[]
}

export type PlaybackEvent = { type: 'start' } | { type: 'finished' } | { type: 'failed' } | { type: 'skip' } | { type: 'reset' }

export const IDLE: PlaybackState = { status: 'idle', index: 0, outcomes: [] }

/** Pure transition. Failures and unresolved items are recorded and playback moves on; it never stalls. */
export function step(state: PlaybackState, event: PlaybackEvent, segmentCount: number): PlaybackState {
  if (event.type === 'reset') return IDLE
  if (event.type === 'start') {
    return segmentCount === 0 ? { status: 'done', index: 0, outcomes: [] } : { status: 'playing', index: 0, outcomes: [] }
  }
  if (state.status !== 'playing') return state

  const outcome: Outcome = event.type === 'finished' ? 'completed' : event.type === 'failed' ? 'error' : 'skipped'
  const outcomes = [...state.outcomes, outcome]
  const index = state.index + 1
  return index >= segmentCount ? { status: 'done', index: segmentCount, outcomes } : { status: 'playing', index, outcomes }
}
