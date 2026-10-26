import { describe, expect, it } from 'vitest'
import { KEY_POSE_HOLD_SECONDS, MAX_FRAME_SECONDS, RADIANS_PER_SECOND, ResolutionGovernor, easedStep, frameSeconds, keyPoseHoldMs } from '@/lib/sign/motion'

/** Seconds a bone takes to travel `distance` radians when frames arrive every `frame` seconds. */
function travelTime(distance: number, frame: number, speed = 1): number {
  let remaining = distance
  let t = 0
  while (remaining > 1e-9 && t < 60) {
    remaining -= easedStep(remaining, frame, speed)
    t += frame
  }
  return t
}

describe('frame length', () => {
  it('is the time between frames in seconds', () => {
    expect(frameSeconds(1016, 1000)).toBeCloseTo(0.016)
  })
  it('assumes 60 fps for the first frame', () => {
    expect(frameSeconds(5000, null)).toBeCloseTo(1 / 60)
  })
  it('caps a stall and ignores a clock that went backwards', () => {
    expect(frameSeconds(9000, 1000)).toBe(MAX_FRAME_SECONDS)
    expect(frameSeconds(1000, 1100)).toBe(0)
  })
})

describe('moving a bone by time', () => {
  it('takes the same time at 30 fps as at 60 fps', () => {
    const at60 = travelTime(1.2, 1 / 60)
    const at30 = travelTime(1.2, 1 / 30)
    expect(Math.abs(at60 - at30)).toBeLessThan(1 / 30 + 1e-9)
  })
  it('is 1.5 times as fast at speed 1.5', () => {
    const normal = travelTime(1.2, 1 / 60)
    const fast = travelTime(1.2, 1 / 60, 1.5)
    expect(normal / fast).toBeGreaterThan(1.4)
    expect(normal / fast).toBeLessThan(1.6)
  })
  it('moves at the tuned rate far from the target', () => {
    expect(easedStep(2, 1 / 60, 1)).toBeCloseTo(RADIANS_PER_SECOND / 60, 6)
  })
  it('slows near the target but never stops, and never overshoots', () => {
    const far = easedStep(1, 1 / 60, 1)
    const near = easedStep(0.05, 1 / 60, 1)
    expect(near).toBeLessThan(far)
    expect(near).toBeGreaterThan(0)
    expect(easedStep(0.001, 1 / 60, 1)).toBe(0.001)
  })
  it('does nothing when already there', () => {
    expect(easedStep(0, 1 / 60, 1)).toBe(0)
    expect(easedStep(-1, 1 / 60, 1)).toBe(0)
  })
  it('arrives in bounded time even for a tiny move', () => {
    expect(travelTime(0.02, 1 / 60)).toBeLessThan(0.5)
  })
})

describe('hold on a key pose', () => {
  it('is shorter than the old 170 ms and shrinks with speed', () => {
    expect(keyPoseHoldMs(1)).toBeCloseTo(KEY_POSE_HOLD_SECONDS * 1000)
    expect(keyPoseHoldMs(1)).toBeLessThan(170)
    expect(keyPoseHoldMs(1.5)).toBeLessThan(keyPoseHoldMs(1))
  })
})

describe('resolution governor', () => {
  it('leaves a smooth display alone', () => {
    const g = new ResolutionGovernor(2)
    for (let i = 0; i < 600; i += 1) expect(g.frame(16.7)).toBeNull()
    expect(g.pixelRatio).toBe(2)
  })
  it('steps down by half after sustained slow frames, and keeps stepping while they stay slow', () => {
    const g = new ResolutionGovernor(3)
    const changes: number[] = []
    for (let i = 0; i < 1000; i += 1) {
      const next = g.frame(40)
      if (next !== null) changes.push(next)
    }
    expect(changes).toEqual([2.5, 2, 1.5, 1])
  })
  it('does not react to one long frame', () => {
    const g = new ResolutionGovernor(2)
    for (let i = 0; i < 100; i += 1) g.frame(16.7)
    expect(g.frame(900)).toBeNull()
    for (let i = 0; i < 100; i += 1) expect(g.frame(16.7)).toBeNull()
  })
  it('never goes below 1 and never goes back up', () => {
    const g = new ResolutionGovernor(1)
    for (let i = 0; i < 500; i += 1) expect(g.frame(60)).toBeNull()
    for (let i = 0; i < 500; i += 1) g.frame(8)
    expect(g.pixelRatio).toBe(1)
  })
})
