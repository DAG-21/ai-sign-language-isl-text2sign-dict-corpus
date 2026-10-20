import type { ManifestIndex } from './manifest'
import { fsLetters, isFsToken, normalizeLabel } from './normalize'
import type { ApprovedMappings, ManifestAsset, ResolveOptions, ResolvedSign } from './types'

export type ResolverContext = {
  /** Gloss tokens the Yap avatar has a hand-authored animation for (`SUPPORTED_TOKENS`). */
  yapTokens: ReadonlySet<string>
  index: ManifestIndex
  mappings: ApprovedMappings
  /** Optional: confirm the media file exists. Absent means "trust the manifest status". */
  fileExists?: (asset: ManifestAsset) => boolean
  /** Only auto-select entries a person approved (`verified`). Default false: clean dataset labels (`source_label`) are accepted too. */
  requireReview?: boolean
}

type Hit = Exclude<ResolvedSign, { kind: 'fingerspelling' }>

const MAX_YAP_WORDS = 4

/** Statuses that count as a real, distinct sign for a term (so they take part in the ambiguity check). */
const SENSE_STATUSES: ReadonlySet<string> = new Set(['verified', 'source_label', 'needs_review'])

/** normalised phrase -> Yap token, e.g. "thank you" -> THANK_YOU. */
function yapLookup(tokens: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const token of tokens) map.set(normalizeLabel(token), token)
  return map
}

const yapCache = new WeakMap<ReadonlySet<string>, Map<string, string>>()
function yapMap(tokens: ReadonlySet<string>) {
  let map = yapCache.get(tokens)
  if (!map) yapCache.set(tokens, (map = yapLookup(tokens)))
  return map
}

/**
 * Look up one normalised key in priority order. Returns null when nothing is
 * known for it, so callers decide on fallbacks. Never guesses between variants.
 */
function lookupKey(key: string, gloss: string, token: string, ctx: ResolverContext, depth = 0): Hit | null {
  const yap = yapMap(ctx.yapTokens).get(key)
  if (yap) return { kind: 'yap_animation', gloss, token: yap }

  const aliasTarget = ctx.mappings.alias[key]
  const lookupKeyName = aliasTarget ?? key
  if (aliasTarget && depth === 0) {
    const yapViaAlias = yapMap(ctx.yapTokens).get(aliasTarget)
    if (yapViaAlias) return { kind: 'yap_animation', gloss, token: yapViaAlias }
  }

  const selectedId = ctx.mappings.select[key]
  if (selectedId) {
    const asset = ctx.index.byId.get(selectedId)
    // A reviewer's explicit choice may point at an entry that is still flagged needs_review.
    if (asset && SENSE_STATUSES.has(asset.status) && fileOk(asset, ctx)) {
      const auto = ctx.mappings.auto_default?.[key]
      const isAutoDefault = Boolean(auto && auto[0] === asset.asset_id)
      return {
        kind: 'islrtc_video', gloss, token, assetId: asset.asset_id, label: asset.label, variant: asset.variant, reviewed: isReviewed(asset),
        via: isAutoDefault ? 'default' : 'selected', ...(isAutoDefault ? { alternates: auto!.slice(1) } : {}),
      }
    }
    return { kind: 'unresolved', gloss, token, reason: asset ? reasonFor(asset, ctx) : 'no_asset', candidates: selectedId ? [selectedId] : [] }
  }

  const found = ctx.index.byLabel.get(lookupKeyName)
  if (!found || found.length === 0) return null

  const live = found.filter((a) => a.status !== 'duplicate')
  const senses = live.filter((a) => SENSE_STATUSES.has(a.status))
  if (senses.length > 1) {
    // Several distinct signs / senses for one term: a human must choose (mappings.select). Never pick silently.
    return { kind: 'unresolved', gloss, token, reason: 'ambiguous', candidates: senses.map((a) => a.asset_id) }
  }
  const usables = senses.filter((a) => usable(a, ctx))
  if (usables.length === 0) {
    const first = senses[0] ?? live[0] ?? found[0]
    return { kind: 'unresolved', gloss, token, reason: reasonFor(first, ctx), candidates: found.map((a) => a.asset_id) }
  }
  const asset = usables[0]
  const exact = (asset.label_norm || normalizeLabel(asset.label)) === lookupKeyName && !aliasTarget
  return {
    kind: 'islrtc_video',
    gloss,
    token,
    assetId: asset.asset_id,
    label: asset.label,
    variant: asset.variant,
    reviewed: isReviewed(asset),
    via: exact ? 'exact' : 'alias',
  }
}

function isReviewed(asset: ManifestAsset): boolean {
  return asset.reviewed ?? asset.status === 'verified'
}

function fileOk(asset: ManifestAsset, ctx: ResolverContext): boolean {
  return ctx.fileExists ? ctx.fileExists(asset) : true
}

function usable(asset: ManifestAsset, ctx: ResolverContext): boolean {
  const accepted = asset.status === 'verified' || (asset.status === 'source_label' && !ctx.requireReview)
  return accepted && fileOk(asset, ctx)
}

function reasonFor(asset: ManifestAsset, ctx: ResolverContext): 'file_missing' | 'unreadable' | 'not_verified' {
  if (asset.status === 'missing_file') return 'file_missing'
  if (asset.status === 'unreadable') return 'unreadable'
  if ((asset.status === 'verified' || asset.status === 'source_label') && !fileOk(asset, ctx)) return 'file_missing'
  return 'not_verified'
}

/**
 * Resolve a Phase 1 gloss sequence into playable items, in order.
 *
 * Priority per unit: Yap animation, verified ISLRTC video, fingerspelling
 * (always for `FS:` names; for other words only with `fingerspellUnknown`),
 * then an explicit `unresolved` result. Multiword phrases are tried before
 * single words. Fuzzy matching is deliberately absent.
 */
export function resolveGloss(rawTokens: readonly string[], ctx: ResolverContext, options: ResolveOptions = {}): ResolvedSign[] {
  const tokens = rawTokens.map((t) => String(t ?? '').trim()).filter((t) => t.length > 0)
  const out: ResolvedSign[] = []
  const maxWords = Math.max(ctx.index.maxWords, MAX_YAP_WORDS)

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]

    if (isFsToken(token)) {
      const letters = fsLetters(token)
      out.push(letters.length ? { kind: 'fingerspelling', gloss: token, token, letters } : { kind: 'unresolved', gloss: token, token, reason: 'empty', candidates: [] })
      i += 1
      continue
    }

    // Longest multiword phrase first, built from adjacent (non-FS) tokens.
    let consumed = 0
    for (let n = Math.min(maxWords, tokens.length - i); n >= 2 && !consumed; n -= 1) {
      const window = tokens.slice(i, i + n)
      if (window.some(isFsToken)) continue
      const hit = lookupKey(normalizeLabel(window.join(' ')), window.join(' '), window.join('_'), ctx)
      if (hit) {
        out.push(hit)
        consumed = n
      }
    }
    if (consumed) {
      i += consumed
      continue
    }

    out.push(...resolveOne(token, ctx, options, 0))
    i += 1
  }
  return out
}

function resolveOne(token: string, ctx: ResolverContext, options: ResolveOptions, depth: number): ResolvedSign[] {
  const key = normalizeLabel(token)
  if (!key) return [{ kind: 'unresolved', gloss: token, token, reason: 'empty', candidates: [] }]

  const hit = lookupKey(key, token, token, ctx)
  // An ambiguous / unverified dictionary entry is final: do not decompose or spell around it.
  if (hit) return [hit]

  const split = ctx.mappings.split[key]
  if (split && depth === 0) return split.flatMap((part) => resolveOne(part, ctx, options, depth + 1))

  // The word has no sign of its own: fall back to a word that means (nearly) the same, if allowed. The original word is kept; the substitution is recorded.
  const level = options.synonyms ?? 'exact'
  const syn = ctx.mappings.synonyms?.[key]
  if (syn && level !== 'off' && (syn.confidence === 'exact' || level === 'close') && depth === 0) {
    for (const target of syn.to) {
      const found = lookupKey(target, token, token, ctx)
      if (found && found.kind !== 'unresolved') return [{ ...found, synonym: { to: target, confidence: syn.confidence } }]
    }
  }

  if (options.fingerspellUnknown) {
    const letters = fsLetters(token)
    if (letters.length) return [{ kind: 'fingerspelling', gloss: token, token, letters }]
  }
  return [{ kind: 'unresolved', gloss: token, token, reason: 'no_asset', candidates: [] }]
}
