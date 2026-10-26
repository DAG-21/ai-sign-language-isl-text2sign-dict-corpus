import type { PoseSummary } from './poseGate'

/**
 * Pure maths for playing extracted avatar tracks: bone rotations per frame for the Y Bot rig (the format written by scripts/pose/retarget_ybot.py).
 * No DOM or three.js here, so it can be tested directly. The player applies the result with `bone.quaternion.set(...)`.
 */

export type Quat = [number, number, number, number] // x, y, z, w (three.js order)
export type Pose = Record<string, Quat>
export type PoseTrack = { fps: number; frames: { t: number; bones: Record<string, Quat> }[] }
/** A track trimmed to the frames in which the sign is made (inclusive indices). */
export type PoseClip = { track: PoseTrack; start: number; end: number }

/** Seconds over which one sign is cross-faded into the next (and the first sign out of the starting pose, the last into the ending pose). */
export const OVERLAP_SECONDS = 0.25
/** Kept for callers that think of the same value as a blend length. */
export const BLEND_SECONDS = OVERLAP_SECONDS
/** Frames kept before the first and after the last moment the hands are clearly raised. */
export const WINDOW_PAD_FRAMES = 3
/**
 * Hand height (-1 hanging by the side, 0 straight out, +1 overhead) above which the hands count as signing. Hands hang at about -0.9 and
 * every sign I looked at keeps them above -0.5, so -0.6 separates the sign from the rest periods before and after it.
 */
export const RAISED_HEIGHT = -0.6

const isQuat = (q: unknown): q is Quat => Array.isArray(q) && q.length === 4 && q.every((v) => typeof v === 'number' && Number.isFinite(v))

/** Shape check for a track fetched from the server: a malformed file must fall back to the video, never reach the avatar. */
export function isPoseTrack(value: unknown): value is PoseTrack {
  const track = value as PoseTrack | null
  if (!track || typeof track !== 'object' || !(track.fps > 0) || !Array.isArray(track.frames) || track.frames.length < 2) return false
  return track.frames.every((f) => f && typeof f.t === 'number' && f.bones && typeof f.bones === 'object' && Object.values(f.bones).every(isQuat))
}

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function rotateY(q: Quat, v: [number, number, number]): number {
  const p: Quat = [v[0], v[1], v[2], 0]
  return qmul(qmul(q, p), [-q[0], -q[1], -q[2], q[3]])[1]
}

/**
 * How high the higher hand is held, from the arm and forearm rotations: the vertical part of the arm direction and the forearm direction,
 * averaged (the two bones are about the same length). The tracks store each bone's rotation in the rig's own T-pose, where the left arm
 * points along +x and the right arm along -x. NaN when the arm bones are missing.
 */
export function handHeight(bones: Record<string, Quat>): number {
  let best = NaN
  for (const [side, dir] of [['Left', 1], ['Right', -1]] as const) {
    const arm = bones[`mixamorig${side}Arm`]
    const fore = bones[`mixamorig${side}ForeArm`]
    if (!arm || !fore) continue
    const height = (rotateY(arm, [dir, 0, 0]) + rotateY(qmul(arm, fore), [dir, 0, 0])) / 2
    if (!(height <= best)) best = height
  }
  return best
}

/**
 * Trim a track to the part in which the hands are signing: from the first to the last frame with a hand raised above RAISED_HEIGHT, inside the
 * extraction's signing window, plus a few frames. The window itself still includes the hands rising from and returning to rest, which made every
 * sign start and end at rest. Without arm bones, or if the hands never rise, the window (with the same padding) is used.
 */
export function clipFor(track: PoseTrack, summary: Pick<PoseSummary, 'window'>, pad = WINDOW_PAD_FRAMES): PoseClip {
  const last = track.frames.length - 1
  const lo = Math.max(0, Math.min(last - 1, Math.round(summary.window[0])))
  const hi = Math.max(lo + 1, Math.min(last, Math.round(summary.window[1])))
  let first = -1
  let final = -1
  for (let i = lo; i <= hi; i += 1) {
    if (handHeight(track.frames[i].bones) > RAISED_HEIGHT) {
      if (first < 0) first = i
      final = i
    }
  }
  const [a, b] = first >= 0 ? [first, final] : [lo, hi]
  const start = Math.max(0, Math.min(last - 1, a - pad))
  const end = Math.max(start + 1, Math.min(last, b + pad))
  return { track, start, end }
}

/**
 * Remove one- and two-frame glitches (a hand that drops out of detection for a moment flips its wrist and fingers) and soften the rest:
 * a median of five on each quaternion component, then a light [1 2 1] average. Applied once when a track is loaded.
 */
export function smoothTrack(track: PoseTrack): PoseTrack {
  const n = track.frames.length
  if (n < 5) return track
  const names = new Set<string>()
  for (const f of track.frames) for (const name of Object.keys(f.bones)) names.add(name)
  const out = track.frames.map((f) => ({ t: f.t, bones: {} as Record<string, Quat> }))
  const median = (v: number[]) => v.sort((x, y) => x - y)[v.length >> 1]
  for (const name of names) {
    const series: Quat[] = []
    let prev: Quat | null = null
    for (const f of track.frames) {
      let q: Quat = f.bones[name] ?? prev ?? [0, 0, 0, 1]
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]
      series.push(q)
      prev = q
    }
    const med = series.map((_, i) => {
      const window = [-2, -1, 0, 1, 2].map((d) => series[Math.min(n - 1, Math.max(0, i + d))])
      return [0, 1, 2, 3].map((c) => median(window.map((q) => q[c])))
    })
    for (let i = 0; i < n; i += 1) {
      const a = med[Math.max(0, i - 1)]
      const b = med[i]
      const c = med[Math.min(n - 1, i + 1)]
      const v = [0, 1, 2, 3].map((k) => (a[k] + 2 * b[k] + c[k]) / 4)
      const len = Math.hypot(v[0], v[1], v[2], v[3]) || 1
      out[i].bones[name] = [v[0] / len, v[1] / len, v[2] / len, v[3] / len]
    }
  }
  return { fps: track.fps, frames: out }
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let wa: number
  let wb: number
  if (dot > 0.9995) {
    wa = 1 - t
    wb = t
  } else {
    const theta = Math.acos(Math.min(1, dot))
    const sin = Math.sin(theta)
    wa = Math.sin((1 - t) * theta) / sin
    wb = Math.sin(t * theta) / sin
  }
  const x = wa * a[0] + wb * bx
  const y = wa * a[1] + wb * by
  const z = wa * a[2] + wb * bz
  const w = wa * a[3] + wb * bw
  const n = Math.hypot(x, y, z, w) || 1
  return [x / n, y / n, z / n, w / n]
}

/** Blend two poses; a bone present on one side only is taken as is. */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {}
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const qa = a[name]
    const qb = b[name]
    out[name] = qa && qb ? slerp(qa, qb, t) : (qa ?? qb)
  }
  return out
}

export function clipSeconds(clip: PoseClip): number {
  return (clip.end - clip.start) / clip.track.fps
}

/** The pose `seconds` into the clip (clamped to its ends), interpolating between the two nearest frames. */
export function sampleClip(clip: PoseClip, seconds: number): Pose {
  const position = Math.min(clip.end, Math.max(clip.start, clip.start + seconds * clip.track.fps))
  const lo = Math.floor(position)
  const hi = Math.min(clip.end, lo + 1)
  const a = clip.track.frames[lo].bones
  return hi === lo ? a : blendPose(a, clip.track.frames[hi].bones, position - lo)
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** Smootherstep: zero velocity and acceleration at both ends. */
const ease = (u: number) => clamp01(u) ** 3 * (clamp01(u) * (clamp01(u) * 6 - 15) + 10)

/** `indexAt(seconds)` is the sign the run is on: the earlier one until the middle of the overlap, the later one after it. */
export type RunPlan = { duration: number; sample: (seconds: number) => Pose; indexAt: (seconds: number) => number }

/**
 * Plan a run of signs as one continuous movement. Each sign is cross-faded into the next over `overlap` seconds while both are still moving
 * (the end of one and the start of the next play together), so the hands never stop and restart between signs. The first sign is faded in
 * from `from` and the last faded out into `to`, which normally hold the avatar's starting pose and its neutral pose.
 */
export function planRun(clips: readonly PoseClip[], from: Pose, to: Pose, overlap = OVERLAP_SECONDS): RunPlan {
  if (!clips.length) return { duration: 0, sample: () => to, indexAt: () => 0 }
  const lengths = clips.map(clipSeconds)
  const starts = [0]
  const overlaps: number[] = []
  for (let i = 0; i < clips.length - 1; i += 1) {
    const o = Math.min(overlap, lengths[i] / 2, lengths[i + 1] / 2)
    overlaps.push(o)
    starts.push(starts[i] + lengths[i] - o)
  }
  const last = clips.length - 1
  const duration = starts[last] + lengths[last]
  const leadIn = Math.min(overlap, lengths[0] / 2)
  const tailOut = Math.min(overlap, lengths[last] / 2)

  const sample = (seconds: number): Pose => {
    if (seconds >= duration) return to
    let i = 0
    while (i < last && starts[i + 1] <= seconds) i += 1
    let pose: Pose
    if (i > 0 && seconds - starts[i] < overlaps[i - 1]) {
      pose = blendPose(sampleClip(clips[i - 1], seconds - starts[i - 1]), sampleClip(clips[i], seconds - starts[i]), ease((seconds - starts[i]) / overlaps[i - 1]))
    } else {
      pose = sampleClip(clips[i], seconds - starts[i])
    }
    if (seconds < leadIn) pose = blendPose(from, pose, ease(seconds / leadIn))
    if (seconds > duration - tailOut) pose = blendPose(pose, to, ease((seconds - (duration - tailOut)) / tailOut))
    return pose
  }
  const indexAt = (seconds: number): number => {
    let i = 0
    while (i < last && starts[i + 1] <= seconds) i += 1
    return i > 0 && seconds - starts[i] < overlaps[i - 1] / 2 ? i - 1 : i
  }
  return { duration, sample, indexAt }
}

export function runDuration(clips: readonly PoseClip[], overlap = OVERLAP_SECONDS): number {
  return planRun(clips, {}, {}, overlap).duration
}

/** The pose `seconds` into a run (see planRun). */
export function sampleRun(clips: readonly PoseClip[], seconds: number, from: Pose, to: Pose, overlap = OVERLAP_SECONDS): Pose {
  return planRun(clips, from, to, overlap).sample(seconds)
}
