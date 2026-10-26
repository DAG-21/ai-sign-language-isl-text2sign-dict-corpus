import { lookupPoseTrack, readTrack } from '@/lib/sign/poseServer'

// Reads the local file system at request time; never cache or prerender.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function fail(status: number, error: string) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * GET /api/islrtc-pose/<asset id>: the avatar track extracted from one dictionary clip (bone rotations per frame for the Y Bot rig).
 * The file is stored gzipped and sent as is with Content-Encoding: gzip, so the browser inflates it. Only tracks that passed the quality gate
 * are served; anything else is a 404 and the player falls back to the recorded video.
 */
async function serve(params: Promise<{ id: string }>, headOnly: boolean) {
  const { id } = await params
  const found = lookupPoseTrack(id)
  if (!found.ok) return fail(found.status, found.error)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Encoding': 'gzip',
    'Content-Length': String(found.size),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  }
  if (headOnly) return new Response(null, { status: 200, headers })
  return new Response(new Uint8Array(readTrack(found.absolutePath)), { status: 200, headers })
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return serve(ctx.params, false)
}

export async function HEAD(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return serve(ctx.params, true)
}
