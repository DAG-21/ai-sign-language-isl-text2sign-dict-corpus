export type GlossSentence = { id: string; label: string; tokens: string[] }

const MAX_SENTENCES = 500

function cleanTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
}

/**
 * Accepts what Phase 1 produces and what a person might paste:
 *  - a Phase 1 `*.gloss.json` (uses `results[].final_tokens`; sentences with no tokens are skipped);
 *  - a JSON array of strings, or an array of such arrays;
 *  - plain text, one sentence per line, optionally in the `GLOSS: A B C` style of the `.gloss.txt` files.
 * Never throws; returns [] for input with no gloss.
 */
export function parseGlossInput(input: string): GlossSentence[] {
  const text = input.trim()
  if (!text) return []

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const results = (value as { results?: unknown }).results
        if (Array.isArray(results)) {
          return results
            .map((r, i) => {
              const row = r as { chunk_id?: unknown; source_text?: unknown; final_tokens?: unknown }
              const tokens = cleanTokens(row.final_tokens)
              const id = typeof row.chunk_id === 'string' ? row.chunk_id : `sentence-${i + 1}`
              const label = typeof row.source_text === 'string' ? row.source_text : id
              return { id, label, tokens }
            })
            .filter((s) => s.tokens.length > 0)
            .slice(0, MAX_SENTENCES)
        }
        return []
      }
      if (Array.isArray(value)) {
        const nested = value.length > 0 && value.every(Array.isArray)
        const rows = nested ? (value as unknown[]).map(cleanTokens) : [cleanTokens(value)]
        return rows.filter((t) => t.length > 0).slice(0, MAX_SENTENCES).map((tokens, i) => ({ id: `sentence-${i + 1}`, label: tokens.join(' '), tokens }))
      }
    } catch {
      // Not JSON after all: fall through to plain text.
    }
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/<review_required>/gi, '').replace(/^\s*GLOSS:\s*/i, '').trim())
    .filter((line) => line && !line.startsWith('#') && !/^\[[^\]]+\]/.test(line))
    .slice(0, MAX_SENTENCES)
    .map((line, i) => {
      const tokens = line.split(/\s+/).filter(Boolean)
      return { id: `sentence-${i + 1}`, label: line, tokens }
    })
}
