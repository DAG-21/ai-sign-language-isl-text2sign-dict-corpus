import { NextResponse } from 'next/server'
import { Phase1Error, Phase1Unreachable, callPhase1 } from '@/lib/sign/phase1'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/

function failure(e: unknown) {
  if (e instanceof Phase1Unreachable) return NextResponse.json({ error: e.message, fallback: true }, { status: 503 })
  if (e instanceof Phase1Error) return NextResponse.json({ error: e.message }, { status: e.status >= 400 && e.status < 500 ? e.status : 502 })
  return NextResponse.json({ error: 'Phase 1 failed unexpectedly.' }, { status: 502 })
}

/** POST { url } starts a video job in Phase 1 (detect, extract audio, transcribe). */
export async function POST(request: Request) {
  let body: { url?: unknown }
  try {
    body = (await request.json()) as { url?: unknown }
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url.trim()) || body.url.length > 500) {
    return NextResponse.json({ error: 'Paste a full video link that starts with https://.' }, { status: 400 })
  }
  try {
    return NextResponse.json(await callPhase1('/api/youtube/start', { method: 'POST', body: { url: body.url.trim() }, timeoutMs: 30_000 }))
  } catch (e) {
    return failure(e)
  }
}

/** GET ?job_id=... -> the three video steps and whether the transcript is ready. */
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get('job_id') ?? ''
  if (!JOB_ID.test(jobId)) return NextResponse.json({ error: 'That is not a valid video job id.' }, { status: 400 })
  try {
    return NextResponse.json(await callPhase1(`/api/youtube/status?job_id=${encodeURIComponent(jobId)}`, { timeoutMs: 10_000 }))
  } catch (e) {
    return failure(e)
  }
}
