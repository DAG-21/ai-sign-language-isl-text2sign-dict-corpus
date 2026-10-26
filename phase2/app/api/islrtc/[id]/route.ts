import fs from 'node:fs'
import { Readable } from 'node:stream'
import { readEnv, lookupMedia, loadSignData } from '@/lib/sign/server'
import { parseRange } from '@/lib/sign/range'
import { ensureH264 } from '@/lib/sign/transcode'

// Reads the local file system at request time; never cache or prerender.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NO_STORE = { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }

function fail(status: number, error: string) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function serve(request: Request, params: Promise<{ id: string }>, headOnly: boolean) {
  const { id } = await params
  const found = lookupMedia(id, loadSignData())
  if (!found.ok) return fail(found.status, found.error)

  let filePath = found.absolutePath
  let contentType = found.contentType
  // Optional: browsers without HEVC support get a cached H.264 copy of this one clip.
  if (readEnv().transcode && new URL(request.url).searchParams.get('format') === 'h264') {
    try {
      filePath = await ensureH264(found.asset.asset_id, found.absolutePath)
      contentType = 'video/mp4'
    } catch (error) {
      console.error('[islrtc] transcode failed:', error instanceof Error ? error.message : error)
      return fail(502, 'Could not prepare a browser-compatible copy of this clip.')
    }
  }

  const size = fs.statSync(filePath).size
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...NO_STORE, 'Content-Range': `bytes */${size}` } })
  }

  const headers: Record<string, string> = { ...NO_STORE, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['Content-Length'] = String(range.end - range.start + 1)
  } else {
    headers['Content-Length'] = String(size)
  }
  if (headOnly) return new Response(null, { status: range ? 206 : 200, headers })

  const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined)
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers })
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return serve(request, ctx.params, false)
}

export async function HEAD(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return serve(request, ctx.params, true)
}
