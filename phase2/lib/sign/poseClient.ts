import { clipFor, isPoseTrack, smoothTrack, type PoseClip } from './poseTrack'
import type { PoseSign, ResolvedSign, VideoSign } from './types'

/** The recorded video for the same clip: what a sign falls back to when its avatar track cannot be used. */
export function poseToVideo(item: PoseSign): VideoSign {
  const { pose: _pose, kind: _kind, ...rest } = item
  return { kind: 'islrtc_video', ...rest }
}

/**
 * Fetch the avatar track of every `islrtc_pose` item in a plan. An item whose track is missing, fails to load or is malformed is turned back into
 * its `islrtc_video` item, so a bad track never stops the sentence. Returns the (possibly degraded) plan and the loaded clips by asset id.
 */
export async function loadPoseClips(
  plan: readonly ResolvedSign[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ plan: ResolvedSign[]; clips: Map<string, PoseClip> }> {
  const wanted = new Map<string, PoseSign>()
  for (const item of plan) if (item.kind === 'islrtc_pose' && !wanted.has(item.assetId)) wanted.set(item.assetId, item)

  const clips = new Map<string, PoseClip>()
  await Promise.all(
    [...wanted].map(async ([id, item]) => {
      try {
        const res = await fetchImpl(`/api/islrtc-pose/${encodeURIComponent(id)}`)
        if (!res.ok) return
        const track: unknown = await res.json()
        if (isPoseTrack(track)) clips.set(id, clipFor(smoothTrack(track), item.pose))
      } catch {
        // falls through to the video below
      }
    }),
  )
  return { plan: plan.map((item) => (item.kind === 'islrtc_pose' && !clips.has(item.assetId) ? poseToVideo(item) : item)), clips }
}
