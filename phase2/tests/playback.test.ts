import { describe, expect, it } from 'vitest'
import { IDLE, buildSegments, step, type PlaybackState } from '@/lib/sign/playback'
import { summarize } from '@/lib/sign/coverage'
import { resolveGloss } from '@/lib/sign/resolver'
import { asset, context } from './fixtures'

const plan = () =>
  resolveGloss(['HELLO', 'STUDENT', 'RELIGION', 'FS:AMIT', 'PHILOSOPHY', 'RELIGION', 'GOOD'], context([asset('r1', 'Religion')]))

describe('segments', () => {
  it('merges adjacent avatar items and keeps videos and unresolved items separate, in order', () => {
    const segs = buildSegments(plan())
    expect(segs.map((s) => s.type)).toEqual(['avatar', 'video', 'avatar', 'unresolved', 'video', 'avatar'])
    expect(segs[0]).toMatchObject({ phrase: 'HELLO STUDENT' })
    expect(segs[2]).toMatchObject({ phrase: 'A M I T' })
  })

  it('an empty plan has no segments', () => {
    expect(buildSegments([])).toEqual([])
  })
})

describe('playback progression through mixed asset types', () => {
  it('advances one segment per event and finishes', () => {
    const n = buildSegments(plan()).length
    let s: PlaybackState = step(IDLE, { type: 'start' }, n)
    const seen: number[] = []
    while (s.status === 'playing') {
      seen.push(s.index)
      s = step(s, { type: 'finished' }, n)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
    expect(s).toMatchObject({ status: 'done', index: n })
    expect(s.outcomes).toHaveLength(n)
  })

  it('records a video error and keeps going instead of stalling', () => {
    const n = 3
    let s = step(IDLE, { type: 'start' }, n)
    s = step(s, { type: 'finished' }, n)
    s = step(s, { type: 'failed' }, n)
    s = step(s, { type: 'skip' }, n)
    expect(s.status).toBe('done')
    expect(s.outcomes).toEqual(['completed', 'error', 'skipped'])
  })

  it('ignores stray events when not playing, and an empty plan completes immediately', () => {
    expect(step(IDLE, { type: 'finished' }, 3)).toBe(IDLE)
    expect(step(IDLE, { type: 'start' }, 0).status).toBe('done')
    const done = step(step(IDLE, { type: 'start' }, 1), { type: 'finished' }, 1)
    expect(step(done, { type: 'finished' }, 1)).toBe(done)
  })
})

describe('coverage summary', () => {
  it('counts occurrences separately from unique vocabulary and never calls a video an avatar animation', () => {
    const c = summarize(plan())
    expect(c.totalOccurrences).toBe(7)
    expect(c.bySource.islrtc_video).toEqual({ occurrences: 2, unique: 1 })
    expect(c.bySource.yap_animation).toEqual({ occurrences: 3, unique: 3 })
    expect(c.bySource.fingerspelling).toEqual({ occurrences: 1, unique: 1 })
    expect(c.bySource.unresolved).toEqual({ occurrences: 1, unique: 1 })
    expect(c.poseSequence).toEqual({ occurrences: 0, unique: 0 })
    const sum = Object.values(c.bySource).reduce((a, b) => a + b.occurrences, 0)
    expect(sum).toBe(c.totalOccurrences)
  })
})
