/**
 * Timing for the hand-made key-pose animations. They used to move a fixed angle per rendered frame, so the same sign ran at half speed on a display that
 * managed 30 frames a second instead of 60, and every key pose ended with a dead stop. These helpers move by elapsed time instead, and slow only
 * the last stretch of each move so it settles rather than stops.
 */

/** Angular speed at speed 1. The animations were tuned at 0.05 rad per frame on a 60 fps display. */
export const RADIANS_PER_SECOND = 3

/** A frame longer than this (a stalled tab, a slow load) is treated as this long, so one hiccup does not jump the avatar across a whole move. */
export const MAX_FRAME_SECONDS = 0.12

/** Pause on each authored key pose at speed 1. It was 0.17 s; with the eased arrival a shorter hold still reads. */
export const KEY_POSE_HOLD_SECONDS = 0.1

/** The last stretch of a move (about 20 degrees) is eased. Outside it the bone moves at full speed. */
const EASE_RADIANS = 0.35
/** Share of full speed at the very end of a move; above zero so every move arrives in bounded time. */
const MIN_SPEED_SHARE = 0.4

/** Seconds between two frame timestamps (milliseconds), never negative and never longer than `MAX_FRAME_SECONDS`. */
export function frameSeconds(nowMs: number, lastMs: number | null): number {
  if (lastMs === null) return 1 / 60
  return Math.min(Math.max((nowMs - lastMs) / 1000, 0), MAX_FRAME_SECONDS)
}

/** How far a bone moves this frame toward a target `remaining` radians away: by elapsed time, scaled by `speed`, easing out near the target. Never overshoots. */
export function easedStep(remaining: number, seconds: number, speed: number): number {
  if (remaining <= 0) return 0
  const t = Math.min(remaining / EASE_RADIANS, 1)
  const share = MIN_SPEED_SHARE + (1 - MIN_SPEED_SHARE) * t * t * (3 - 2 * t)
  return Math.min(remaining, RADIANS_PER_SECOND * seconds * speed * share)
}

/** Milliseconds to hold a finished key pose at this speed. */
export function keyPoseHoldMs(speed: number): number {
  return (KEY_POSE_HOLD_SECONDS * 1000) / Math.max(speed, 0.1)
}

/**
 * Keeps the drawing resolution affordable. Feed it each frame's length; when frames stay slow for long enough it lowers the pixel ratio by half a step (never
 * below 1) and says so. It never raises it again, so it cannot flap between two settings.
 */
export class ResolutionGovernor {
  private average = 1000 / 60
  private slow = 0

  constructor(
    public pixelRatio: number,
    private readonly slowMs = 22,
    private readonly slowFramesNeeded = 20,
  ) {}

  /** Returns the new pixel ratio when it should change, else null. */
  frame(frameMs: number): number | null {
    this.average = this.average * 0.9 + Math.min(frameMs, 100) * 0.1
    if (this.average <= this.slowMs) {
      this.slow = 0
      return null
    }
    this.slow += 1
    if (this.slow < this.slowFramesNeeded || this.pixelRatio <= 1) return null
    this.pixelRatio = Math.max(1, this.pixelRatio - 0.5)
    this.slow = 0
    this.average = 1000 / 60
    return this.pixelRatio
  }
}
