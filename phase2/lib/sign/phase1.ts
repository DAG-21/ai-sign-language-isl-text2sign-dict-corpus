/**
 * Bridge to Phase 1 (the Python pipeline in the sibling `phase1` folder: transcript cleaning, sentence chunking, context grouping, the LLM gloss layer and
 * the spaCy layer). Phase 1 runs as its own local server (`run_webui.py`, port 8765); this app only talks to it over HTTP and never reads its key.
 *
 * `extractSentences` is pure so the mapping from a Phase 1 answer to the gloss the resolver takes can be tested without the server.
 */

import { reorderForIsl } from './islOrder'

export type GlossEngine = 'llm' | 'spacy' | 'none'

export type Phase1Sentence = {
  id: string
  /** The English sentence as Phase 1 cleaned it. */
  source: string
  /** Gloss tokens to sign, upper case. Empty when neither layer produced any. */
  tokens: string[]
  /** Which Phase 1 layer the tokens came from. */
  engine: GlossEngine
  /** Phase 1 flagged this sentence for a human to look at (model doubt, validation warning, or a fallback to the second layer). */
  needsReview: boolean
  notes: string[]
  /** True when the word order was rearranged by the ISL word-order rules (lib/sign/islOrder.ts). */
  reordered: boolean
  /** The gloss as Phase 1 wrote it, when `reordered`. */
  originalTokens: string[] | null
}

export type Phase1Result = {
  sentences: Phase1Sentence[]
  tokens: string[]
  /** Why the LLM layer did not run or failed (missing key, quota...), else null. Sentences then come from the spaCy layer. */
  llmError: string | null
  model: string | null
}

export const DEFAULT_PHASE1_URL = 'http://127.0.0.1:8765'
const SAFE_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/

/** Where Phase 1 listens. Only loopback addresses are accepted: the Phase 1 server refuses anything else, and the app must not send text elsewhere. */
export function phase1BaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.PHASE1_URL || DEFAULT_PHASE1_URL).trim().replace(/\/+$/, '')
  return SAFE_URL.test(raw) ? raw : DEFAULT_PHASE1_URL
}

type Row = Record<string, unknown>
const asRows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object') : [])
const asTokens = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toUpperCase().replace(/\s+/g, '_')).filter(Boolean) : []
const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Words Phase 1 writes that the sign inventory knows under another name. Kept short and explicit: each entry is a decision about the sign,
 * and the sentence's notes say when one was applied.
 */
export const SIGN_ALIASES: Readonly<Record<string, string>> = { NOT: 'NO', HI: 'HELLO' }

/**
 * Phase 1 `/api/translate` answer -> one entry per sentence. The LLM layer's final gloss is used when it translated the sentence; otherwise
 * the spaCy layer's gloss stands in, and the sentence is marked for review because it is the weaker candidate.
 */
export function extractSentences(answer: unknown): Phase1Result {
  const root = (answer && typeof answer === 'object' ? answer : {}) as Row
  const llm = (root.llm && typeof root.llm === 'object' ? root.llm : {}) as Row
  const spacy = (root.spacy && typeof root.spacy === 'object' ? root.spacy : {}) as Row

  const llmRows = asRows(llm.rows)
  const spacyById = new Map(asRows(spacy.rows).map((r) => [asString(r.sentence_id), r] as const))
  const err = llm.error && typeof llm.error === 'object' ? asString((llm.error as Row).message) || asString((llm.error as Row).kind) : ''

  const sentences: Phase1Sentence[] = []
  const bases: Row[] = llmRows.length > 0 ? llmRows : asRows(spacy.rows)
  bases.forEach((row, i) => {
    const id = asString(row.sentence_id) || `sentence-${i + 1}`
    const sp = spacyById.get(id)
    const llmTokens = row.status === 'translated' ? asTokens(row.final_tokens) : []
    const spacyTokens = sp && sp.spacy_status === 'ok' ? asTokens(sp.spacy_tokens) : []
    const notes: string[] = []
    let engine: GlossEngine = 'none'
    let tokens: string[] = []
    let needsReview = row.needs_human_review === true
    if (llmTokens.length > 0) {
      engine = 'llm'
      tokens = llmTokens
      for (const n of Array.isArray(row.uncertainty_notes) ? row.uncertainty_notes : []) if (typeof n === 'string' && n) notes.push(n)
      for (const w of asRows(row.warnings)) if (asString(w.message)) notes.push(asString(w.message))
    } else if (spacyTokens.length > 0) {
      engine = 'spacy'
      tokens = spacyTokens
      needsReview = true
      notes.push(err ? `LLM layer unavailable (${err}); used the spaCy layer` : 'The LLM layer gave no gloss for this sentence; used the spaCy layer')
    } else if (asString(row.error)) {
      notes.push(asString(row.error))
    }
    // The LLM layer writes English word order (the textbook's order differs: time first, NOT / HAVE / MUST / question word last). Layer 2 already follows it.
    let reordered = false
    let originalTokens: string[] | null = null
    if (engine === 'llm') {
      const order = reorderForIsl(tokens)
      if (order.changed) {
        reordered = true
        originalTokens = tokens
        tokens = order.tokens
        notes.push(`Reordered by the ISL word-order rules (${order.notes.join('; ')}). Phase 1 wrote: ${originalTokens.join(' ')}`)
      }
    }
    const renamed = new Set<string>()
    tokens = tokens.map((t) => {
      const alias = SIGN_ALIASES[t]
      if (alias) renamed.add(`${t} → ${alias}`)
      return alias ?? t
    })
    if (renamed.size > 0) notes.push(`Signed as: ${[...renamed].join(', ')}`)
    sentences.push({ id, source: asString(row.source_text) || asString(sp?.source_text), tokens, engine, needsReview, notes, reordered, originalTokens })
  })

  return {
    sentences,
    tokens: sentences.flatMap((s) => s.tokens),
    llmError: err || null,
    model: asString(llm.model) || null,
  }
}

/** Calls Phase 1. Throws `Phase1Unreachable` when nothing answers, so a caller can fall back to the offline engine. */
export class Phase1Unreachable extends Error {}
export class Phase1Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export async function callPhase1(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  const url = `${phase1BaseUrl()}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 180_000),
      cache: 'no-store',
    })
  } catch {
    throw new Phase1Unreachable(`Phase 1 is not running at ${phase1BaseUrl()}. Start it with scripts\\dev-all.ps1, or run_webui.py in the signLanguage folder.`)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // fall through with null
  }
  if (!res.ok) {
    const message = data && typeof data === 'object' && typeof (data as Row).error === 'string' ? ((data as Row).error as string) : `Phase 1 answered ${res.status}`
    throw new Phase1Error(message, res.status)
  }
  return data
}
