import { NextResponse } from 'next/server'
import { Phase1Unreachable, callPhase1 } from '@/lib/sign/phase1'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Is Phase 1 running, does it have its LLM key, and can it read YouTube links? Never returns the key. */
export async function GET() {
  try {
    const status = (await callPhase1('/api/status', { timeoutMs: 20_000 })) as Record<string, unknown>
    return NextResponse.json({ available: true, llmKeyPresent: status.llm_key_present === true, spacyAvailable: status.spacy_available === true, youtube: status.youtube ?? null })
  } catch (e) {
    return NextResponse.json({ available: false, reason: e instanceof Phase1Unreachable ? e.message : 'Phase 1 did not answer.' })
  }
}
