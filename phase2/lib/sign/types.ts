/**
 * Shared types for resolving a Phase 1 gloss token to something the UI can show.
 *
 * A dictionary video is NOT a 3D animation and must never be reported as one:
 * the `kind` field is the only thing the UI and the coverage report may use to
 * say which kind of asset a sign came from.
 */

/**
 * Review state of one dictionary asset.
 *  - `verified`      a person approved it
 *  - `source_label`  clean label taken verbatim from the dataset's file name, not reviewed by a person
 *  - `needs_review`  the name carries a sense qualifier, long phrase, trailing number or weak label
 * Only `verified` and `source_label` may be auto-selected (`verified` only when `requireReview` is set).
 */
export type AssetStatus =
  | 'verified'
  | 'source_label'
  | 'needs_review'
  | 'concept'
  | 'missing_file'
  | 'duplicate'
  | 'unreadable'
  | 'rejected'

export type ManifestAlias = {
  text: string
  /** True only when the dataset metadata (or a human reviewer) confirmed this alias. Never inferred. */
  verified: boolean
  source: string
}

/** One dictionary entry, as written by the indexing script. Paths are relative to ISLRTC_DATA_DIR. */
export type ManifestAsset = {
  asset_id: string
  label: string
  label_norm: string
  aliases: ManifestAlias[]
  /** Variant / sense information exactly as the source gives it; null when absent. */
  variant: string | null
  rel_path: string
  container: string | null
  codec: string | null
  duration_s: number | null
  status: AssetStatus
  /** True only when a reviewer approved the entry. */
  reviewed?: boolean
  entry_type?: string
  flags?: string[]
}

export type Manifest = {
  schema_version: '1.0'
  source: string
  generated_at: string
  assets: ManifestAsset[]
}

/** Reviewed, human-approved decisions that the resolver may follow. */
export type ApprovedMappings = {
  /** normalised gloss -> asset_id to use (resolves an ambiguous term to one variant). */
  select: Record<string, string>
  /** normalised gloss -> normalised dictionary label (an approved alias). */
  alias: Record<string, string>
  /** normalised gloss -> ordered list of normalised glosses to sign instead (approved decomposition). */
  split: Record<string, string[]>
  /** key -> [chosen, ...alternates]: written by the indexer when it picked ONE default sign among several so a word always gets the same sign. */
  auto_default?: Record<string, string[]>
  /** Words with no sign of their own, pointed at an available word that means (nearly) the same. Validated by the indexer against the real vocabulary. */
  synonyms?: Record<string, SynonymEntry>
}

export type SynonymConfidence = 'exact' | 'close'
export type SynonymEntry = { to: string[]; confidence: SynonymConfidence; note?: string }
/** Recorded on a result when a synonym was used, so the original word and the substitution stay visible. */
export type SynonymUse = { to: string; confidence: SynonymConfidence }

export const EMPTY_MAPPINGS: ApprovedMappings = { select: {}, alias: {}, split: {} }

export type SignSource = 'yap_animation' | 'islrtc_video' | 'fingerspelling' | 'unresolved'

export type UnresolvedReason = 'no_asset' | 'ambiguous' | 'not_verified' | 'file_missing' | 'unreadable' | 'empty'

export type ResolvedSign =
  | { kind: 'yap_animation'; gloss: string; token: string; synonym?: SynonymUse }
  | { kind: 'islrtc_video'; gloss: string; token: string; assetId: string; label: string; variant: string | null; reviewed: boolean; via: 'exact' | 'alias' | 'selected' | 'default'; alternates?: string[]; synonym?: SynonymUse }
  | { kind: 'fingerspelling'; gloss: string; token: string; letters: string[] }
  | { kind: 'unresolved'; gloss: string; token: string; reason: UnresolvedReason; candidates: string[] }

export type ResolveOptions = {
  /** Fingerspell plain (non `FS:`) glosses that have no sign. Off by default: spelling a common word is usually not ISL. */
  fingerspellUnknown?: boolean
  /**
   * Use a synonym for a word that has no sign of its own: 'exact' (default) only for interchangeable words such as HI/HELLO, 'close' also for near-synonyms such as SAY/TELL, 'off' never.
   * A word's own sign always wins; a synonym is only a fallback.
   */
  synonyms?: 'off' | 'exact' | 'close'
}
