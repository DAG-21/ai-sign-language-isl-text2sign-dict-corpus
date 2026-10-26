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

/** Seconds spent easing from one pose to the next (rest to sign, sign to sign, sign to rest). */
export const BLEND_SECONDS = 0.25
/** Frames kept on each side of the signing window so the hands do not start or stop abruptly. */
export const WINDOW_PAD_FRAMES = 6

const isQuat = (q: unknown): q is Quat => Array.isArray(q) && q.length === 4 && q.every((v) => typeof v === 'number' && Number.isFinite(v))

/** Shape check for a track fetched from the server: a malformed file must fall back to the video, never reach the avatar. */
export function isPoseTrack(value: unknown): value is PoseTrack {
  const track = value as PoseTrack | null
  if (!track || typeof track !== 'object' || !(track.fps > 0) || !Array.isArray(track.frames) || track.frames.length < 2) return false
  return track.frames.every((f) => f && typeof f.t === 'number' && f.bones && typeof f.bones === 'object' && Object.values(f.bones).every(isQuat))
}

/** Trim a track to its signing window (with padding), clamped to the frames that exist. */
export function clipFor(track: PoseTrack, summary: Pick<PoseSummary, 'window'>, pad = WINDOW_PAD_FRAMES): PoseClip {
  const last = track.frames.length - 1
  const start = Math.max(0, Math.min(last - 1, Math.round(summary.window[0]) - pad))
  const end = Math.max(start + 1, Math.min(last, Math.round(summary.window[1]) + pad))
  return { track, start, end }
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
const ease = (u: number) => u * u * (3 - 2 * u)

export function runDuration(clips: readonly PoseClip[], blend = BLEND_SECONDS): number {
  return clips.reduce((sum, c) => sum + clipSeconds(c), 0) + (clips.length + 1) * blend
}

/**
 * The pose `seconds` into a run of clips: ease from `from` into the first sign, play each sign, ease from one sign into the next, and
 * finally ease into `to`. `from` and `to` normally hold the avatar's neutral pose.
 */
export function sampleRun(clips: readonly PoseClip[], seconds: number, from: Pose, to: Pose, blend = BLEND_SECONDS): Pose {
  if (!clips.length) return to
  let cursor = 0
  let previous = from
  for (const clip of clips) {
    const first = sampleClip(clip, 0)
    if (seconds < cursor + blend) return blendPose(previous, first, ease(clamp01((seconds - cursor) / blend)))
    cursor += blend
    const length = clipSeconds(clip)
    if (seconds < cursor + length) return sampleClip(clip, seconds - cursor)
    cursor += length
    previous = sampleClip(clip, length)
  }
  if (seconds < cursor + blend) return blendPose(previous, to, ease(clamp01((seconds - cursor) / blend)))
  return to
}
