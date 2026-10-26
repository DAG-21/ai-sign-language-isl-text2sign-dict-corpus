import { NextResponse } from 'next/server'
import { SUPPORTED_TOKEN_SET } from '@/lib/islVocabulary'
import { EMPTY_MAPPINGS } from '@/lib/sign/types'
import { buildIndex } from '@/lib/sign/manifest'
import { resolveGloss } from '@/lib/sign/resolver'
import { summarize } from '@/lib/sign/coverage'
import { loadSignData, mediaExists } from '@/lib/sign/server'
import { poseResolverHook } from '@/lib/sign/poseServer'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_TOKENS = 2000

type Body = { tokens?: unknown; fingerspellUnknown?: unknown; synonyms?: unknown }

/**
 * POST { tokens: string[] } -> the resolved, ordered sign plan for a gloss
 * sequence (Phase 1 `final_tokens`). Without a manifest, the plan still
 * contains Yap animations, fingerspelling and unresolved items, so the
 * existing avatar flow keeps working.
 */
export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  if (!Array.isArray(body.tokens) || !body.tokens.every((t) => typeof t === 'string')) {
    return NextResponse.json({ error: '"tokens" must be an array of strings.' }, { status: 400 })
  }
  if (body.tokens.length > MAX_TOKENS) {
    return NextResponse.json({ error: `At most ${MAX_TOKENS} tokens per request.` }, { status: 413 })
  }

  const data = loadSignData()
  // Avatar tracks extracted from the dictionary clips (quality-gated); absent when none are configured.
  const pose = poseResolverHook()
  const index = data?.index ?? buildIndex({ schema_version: '1.0', source: 'none', generated_at: '', assets: [] })
  const plan = resolveGloss(
    body.tokens as string[],
    {
      yapTokens: SUPPORTED_TOKEN_SET,
      index,
      mappings: data?.mappings ?? EMPTY_MAPPINGS,
      fileExists: data ? (asset) => mediaExists(asset, data) : undefined,
      pose: pose ?? undefined,
    },
    {
      fingerspellUnknown: body.fingerspellUnknown === true,
      synonyms: body.synonyms === 'off' || body.synonyms === 'close' ? body.synonyms : 'exact',
    },
  )
  return NextResponse.json({ plan, coverage: summarize(plan), dictionaryLoaded: Boolean(data), poseTracksLoaded: Boolean(pose) })
}
