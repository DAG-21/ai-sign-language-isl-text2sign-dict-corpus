import { NextResponse } from 'next/server'
import { Phase1Error, Phase1Unreachable, callPhase1, extractSentences } from '@/lib/sign/phase1'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CHARS = 6000
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/

type Body = { text?: unknown; job_id?: unknown; max_sentences?: unknown }

/**
 * POST { text } or { job_id } -> Phase 1 (cleaning, sentences, context groups, LLM layer, spaCy layer) -> the gloss to sign, per sentence.
 * 503 with `fallback: true` when Phase 1 is not running, so the page can use the offline engine instead.
 */
export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  const jobId = typeof body.job_id === 'string' && body.job_id ? body.job_id : null
  if (jobId && !JOB_ID.test(jobId)) return NextResponse.json({ error: 'That is not a valid video job id.' }, { status: 400 })
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!jobId) {
    if (!text) return NextResponse.json({ error: 'Type a sentence or a paragraph first.' }, { status: 400 })
    if (text.length > MAX_CHARS) return NextResponse.json({ error: `That is ${text.length} characters; at most ${MAX_CHARS} are accepted.` }, { status: 413 })
  }
  const maxSentences = typeof body.max_sentences === 'number' && Number.isFinite(body.max_sentences) ? Math.max(1, Math.min(200, Math.floor(body.max_sentences))) : undefined

  try {
    const answer = await callPhase1('/api/translate', { method: 'POST', body: jobId ? { job_id: jobId, max_sentences: maxSentences } : { text } })
    return NextResponse.json(extractSentences(answer))
  } catch (e) {
    if (e instanceof Phase1Unreachable) return NextResponse.json({ error: e.message, fallback: true }, { status: 503 })
    if (e instanceof Phase1Error) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 502 })
    return NextResponse.json({ error: 'Phase 1 failed unexpectedly.' }, { status: 502 })
  }
}
