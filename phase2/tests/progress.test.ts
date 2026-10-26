import { describe, expect, it } from 'vitest'
import { IDLE, buildSegments, step, type PlaybackState } from '@/lib/sign/playback'
import { coverageLine, itemAtToken, segmentLength, wordStatuses } from '@/lib/sign/progress'
import { clipFor, planRun, type Pose, type PoseTrack, type Quat } from '@/lib/sign/poseTrack'
import { resolveGloss } from '@/lib/sign/resolver'
import type { PoseSummary } from '@/lib/sign/poseGate'
import { asset, context } from './fixtures'

const ID: Quat = [0, 0, 0, 1]
const summary: PoseSummary = { handFrac: 0.6, poseFrac: 1, frames: 5, fps: 10, window: [0, 4] }
const hook = { lookup: (id: string) => (id === 'w1' || id === 'p1' ? summary : null) }

// HELLO (hand-made), WORLD (pose), PARAMEDIC (pose), FS:AMIT (spelled, 4 letters), CUP (video), NONSENSEWORD (no sign), GOOD (hand-made)
const ctx = { ...context([asset('w1', 'World'), asset('p1', 'Paramedic'), asset('c1', 'Cup')]), pose: hook }
const plan = () => resolveGloss(['HELLO', 'WORLD', 'PARAMEDIC', 'FS:AMIT', 'CUP', 'NONSENSEWORD', 'GOOD'], ctx)

const playing = (index: number, outcomes: PlaybackState['outcomes'] = []): PlaybackState => ({ status: 'playing', index, outcomes })

describe('word positions in the plan', () => {
  it('records where each segment starts', () => {
    const segs = buildSegments(plan())
    expect(segs.map((s) => [s.type, s.start])).toEqual([['avatar', 0], ['pose', 1], ['avatar', 3], ['video', 4], ['unresolved', 5], ['avatar', 6]])
    expect(segs.map(segmentLength)).toEqual([1, 2, 1, 1, 1, 1])
  })
  it('maps a token position to the plan item, counting each letter of a spelled name', () => {
    const items = resolveGloss(['HELLO', 'FS:AMIT', 'GOOD'], context([]))
    // tokens: HELLO | A M I T | GOOD
    expect([0, 1, 2, 3, 4, 5].map((t) => itemAtToken(items, t))).toEqual([0, 1, 1, 1, 1, 2])
    expect(itemAtToken(items, 6)).toBe(3) // past the end: the phrase is finished
  })
})

describe('which word is being signed', () => {
  it('has nothing current before playback starts', () => {
    const p = plan()
    expect(wordStatuses(p, buildSegments(p), IDLE, 0).every((s) => s === 'pending')).toBe(true)
  })
  it('marks earlier words done, the playing one current, later ones pending', () => {
    const p = plan()
    const segs = buildSegments(p)
    // second segment (the two avatar tracks), on its second sign
    expect(wordStatuses(p, segs, playing(1, ['completed']), 1)).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending', 'pending'])
    // the spelled name is one word however many letters it has
    expect(wordStatuses(p, segs, playing(2, ['completed', 'completed']), 0)[3]).toBe('current')
  })
  it('passes over a word with no sign, and flags a sign that failed', () => {
    const p = plan()
    const segs = buildSegments(p)
    // segments: 0 HELLO, 1 WORLD+PARAMEDIC, 2 AMIT, 3 CUP (video), 4 NONSENSEWORD (no sign), 5 GOOD
    const s = wordStatuses(p, segs, playing(4, ['completed', 'completed', 'completed', 'error']), 0)
    expect(s[4]).toBe('failed') // the video that could not be played
    expect(s[5]).toBe('current') // the unresolved word, while it is held on screen
    const after = wordStatuses(p, segs, playing(5, ['completed', 'completed', 'completed', 'error', 'skipped']), 0)
    expect(after[5]).toBe('skipped')
    expect(after[6]).toBe('current')
  })
  it('marks everything finished when playback is done', () => {
    const p = plan()
    const segs = buildSegments(p)
    let s: PlaybackState = step(IDLE, { type: 'start' }, segs.length)
    while (s.status === 'playing') s = step(s, { type: 'finished' }, segs.length)
    expect(wordStatuses(p, segs, s, 0)).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped', 'done'])
  })
})

describe('coverage of a plan', () => {
  it('counts what is signed, how, and which words have no sign', () => {
    const c = coverageLine(plan())
    expect(c.words).toBe(7)
    expect(c.covered).toBe(6)
    expect(c.missing).toEqual(['NONSENSEWORD'])
    expect(c.by).toEqual({ yap_animation: 2, islrtc_pose: 2, islrtc_video: 1, fingerspelling: 1 })
  })
  it('handles an empty plan', () => {
    expect(coverageLine([])).toEqual({ words: 0, covered: 0, missing: [], by: { yap_animation: 0, islrtc_pose: 0, islrtc_video: 0, fingerspelling: 0 } })
  })
})

describe('which sign of a run of tracks is playing', () => {
  const track: PoseTrack = { fps: 10, frames: [0, 1, 2, 3, 4].map((i) => ({ t: i / 10, bones: { B: ID } })) }
  const clip = () => clipFor(track, { window: [0, 4] }, 0) // 0.4 s each
  const neutral: Pose = { B: ID }

  it('follows the signs in order and switches in the middle of the overlap', () => {
    const plan = planRun([clip(), clip(), clip()], neutral, neutral, 0.1) // starts 0, 0.3, 0.6; each overlap 0.1 s
    expect(plan.indexAt(0)).toBe(0)
    expect(plan.indexAt(0.29)).toBe(0)
    expect(plan.indexAt(0.34)).toBe(0) // first half of the overlap: still the earlier sign
    expect(plan.indexAt(0.36)).toBe(1) // second half: the later one
    expect(plan.indexAt(0.5)).toBe(1)
    expect(plan.indexAt(0.7)).toBe(2)
    expect(plan.indexAt(99)).toBe(2)
  })
  it('is zero for an empty or one-sign run', () => {
    expect(planRun([], neutral, neutral).indexAt(1)).toBe(0)
    expect(planRun([clip()], neutral, neutral).indexAt(0.2)).toBe(0)
  })
})
