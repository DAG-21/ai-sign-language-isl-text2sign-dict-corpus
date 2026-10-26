import type { ResolvedSign } from './types'

/**
 * Turns a resolved plan into playback segments and steps through them.
 *
 * Consecutive avatar items (Yap animations and fingerspelling) are merged into
 * one phrase so the existing AvatarPlayer queue plays them exactly as before;
 * dictionary videos and unresolved markers are separate segments. Consecutive avatar tracks (`islrtc_pose`) form one segment so the player can blend
 * from one sign into the next. Isolated
 * signs played one after another are not continuous, grammatical ISL.
 */
/** `start` is the index in the plan of the segment's first item, so the UI can tell which words are being played. */
export type Segment =
  | { type: 'avatar'; start: number; phrase: string; items: ResolvedSign[] }
  | { type: 'video'; start: number; item: Extract<ResolvedSign, { kind: 'islrtc_video' }> }
  | { type: 'pose'; start: number; items: Extract<ResolvedSign, { kind: 'islrtc_pose' }>[] }
  | { type: 'unresolved'; start: number; item: Extract<ResolvedSign, { kind: 'unresolved' }> }

export function buildSegments(plan: readonly ResolvedSign[]): Segment[] {
  const segments: Segment[] = []
  for (const [start, item] of plan.entries()) {
    if (item.kind === 'islrtc_video') {
      segments.push({ type: 'video', start, item })
    } else if (item.kind === 'islrtc_pose') {
      const last = segments[segments.length - 1]
      if (last?.type === 'pose') last.items.push(item)
      else segments.push({ type: 'pose', start, items: [item] })
    } else if (item.kind === 'unresolved') {
      segments.push({ type: 'unresolved', start, item })
    } else {
      const words = item.kind === 'yap_animation' ? [item.token] : item.letters
      const last = segments[segments.length - 1]
      if (last?.type === 'avatar') {
        last.items.push(item)
        last.phrase += ' ' + words.join(' ')
      } else {
        segments.push({ type: 'avatar', start, phrase: words.join(' '), items: [item] })
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
