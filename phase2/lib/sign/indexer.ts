import { createHash } from 'node:crypto'
import { normalizeLabel } from './normalize'
import { EMPTY_MAPPINGS, type ApprovedMappings, type AssetStatus, type Manifest, type ManifestAlias, type ManifestAsset } from './types'

/**
 * Build a manifest and mappings from dictionary FILE NAMES only (no media is opened).
 *
 * The ISLRTC download has no label table, so everything here comes from names such as `Can_(Sign_2).mp4` or `Region_(Math).mp4`.
 * Nothing is reviewed by a person: entries are `source_label` (clean name) or `needs_review` (the name carries a sense qualifier,
 * a trailing number or is a long phrase). Codec and duration are not probed and stay null.
 */

export type ParsedName = {
  stem: string
  /** Name without trailing (...) groups, underscores turned into spaces. */
  label: string
  /** `(Sign_2)` style alternates of the same word: 1 for `(Sign)`/`(Sign_1)`, null when the name has none. */
  altNumber: number | null
  /** `(Math)`, `(History)` and similar: a different sense, or an explanation video, of the word. */
  senses: string[]
  /** `(GCED)` style acronyms given in the name. */
  acronyms: string[]
  /** Parts of `A_or_B_or_C` names. */
  orParts: string[]
  trailingNumber: boolean
  /** The name ends in ` - English` (about 290 files). The dataset does not say what the tag means, so it is only recorded as a variant and ranked after the plain file. */
  english: boolean
}

const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov)$/i
const ENGLISH_SUFFIX = /\s*-\s*English(?:_?(\d+))?\s*$/i
const ALT_QUALIFIER = /^sign(?:[_\s]?(\d+))?$/i
const ACRONYM_QUALIFIER = /^[A-Z][A-Z0-9.&]+$/
const MAX_PLAIN_WORDS = 6
const MAX_OR_PARTS = 3

const tidy = (value: string) => value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()

export function parseName(relPath: string): ParsedName {
  const file = relPath.split('/').pop() ?? relPath
  const stem = file.replace(VIDEO_EXTENSIONS, '')

  let rest = stem
  let trailingNumber = false
  const english = ENGLISH_SUFFIX.exec(rest)
  if (english) {
    if (english[1]) trailingNumber = true
    rest = rest.slice(0, english.index)
  }
  const qualifiers: string[] = []
  for (;;) {
    const m = /^(.*?)[_\s]*\(([^()]*)\)\s*$/.exec(rest)
    if (!m || !m[1].trim()) break
    qualifiers.unshift(m[2].trim())
    rest = m[1]
  }

  let altNumber: number | null = null
  const senses: string[] = []
  const acronyms: string[] = []
  for (const q of qualifiers) {
    const alt = ALT_QUALIFIER.exec(q)
    if (alt) altNumber = alt[1] ? Number(alt[1]) : 1
    else if (/^\d+$/.test(q)) trailingNumber = true
    else if (ACRONYM_QUALIFIER.test(q)) acronyms.push(q)
    else senses.push(tidy(q))
  }

  const label = tidy(rest)
  if (/(?:^|\s)\d+$/.test(label)) trailingNumber = true
  const parts = label.split(/\s+or\s+/i).map((p) => p.trim()).filter(Boolean)
  return { stem, label, altNumber, senses, acronyms, orParts: parts.length > 1 ? parts : [], trailingNumber, english: Boolean(english) }
}

function statusOf(p: ParsedName, labelNorm: string): AssetStatus {
  if (!labelNorm) return 'needs_review'
  if (p.senses.length > 0 || p.trailingNumber) return 'needs_review'
  if (p.orParts.length > MAX_OR_PARTS) return 'needs_review'
  const words = labelNorm.split(' ').length
  if (words > MAX_PLAIN_WORDS && p.acronyms.length === 0 && p.orParts.length === 0) return 'needs_review'
  return 'source_label'
}

export function assetIdFor(relPath: string): string {
  return `isl_${createHash('sha1').update(relPath).digest('hex').slice(0, 12)}`
}

type Entry = { asset: ManifestAsset; parsed: ParsedName }

export type IndexStats = {
  files: number
  byStatus: Record<string, number>
  /** Words with several entries (alternates or senses). */
  multiEntryKeys: number
  /** Of those, how many got one default sign written to `select`. */
  defaultsChosen: number
  /** Of those, how many stay ambiguous because every candidate needs review. */
  leftAmbiguous: number
}

export function buildIndexFiles(relPaths: readonly string[], now: Date = new Date()): { manifest: Manifest; mappings: ApprovedMappings; stats: IndexStats } {
  const entries: Entry[] = []
  for (const relPath of [...relPaths].sort()) {
    if (!VIDEO_EXTENSIONS.test(relPath)) continue
    const parsed = parseName(relPath)
    const labelNorm = normalizeLabel(parsed.label)
    const aliases: ManifestAlias[] = []
    const seen = new Set<string>([labelNorm])
    const addAlias = (text: string, source: string) => {
      const key = normalizeLabel(text)
      if (!key || seen.has(key)) return
      seen.add(key)
      aliases.push({ text, verified: true, source })
    }
    for (const a of parsed.acronyms) addAlias(a, 'file_name_acronym')
    if (parsed.orParts.length <= MAX_OR_PARTS) for (const part of parsed.orParts) addAlias(part, 'file_name_or')

    const variantParts = [...(parsed.altNumber ? [`Sign ${parsed.altNumber}`] : []), ...(parsed.english ? ['English'] : []), ...parsed.senses]
    entries.push({
      parsed,
      asset: {
        asset_id: assetIdFor(relPath),
        label: parsed.label,
        label_norm: labelNorm,
        aliases,
        variant: variantParts.length ? variantParts.join(', ') : null,
        rel_path: relPath,
        container: relPath.toLowerCase().split('.').pop() ?? null,
        codec: null,
        duration_s: null,
        status: statusOf(parsed, labelNorm),
        reviewed: false,
        flags: parsed.trailingNumber ? ['trailing_number'] : undefined,
      },
    })
  }

  // Every searchable key (own label and aliases) -> entries.
  const byKey = new Map<string, Entry[]>()
  for (const e of entries) {
    const keys = new Set<string>([e.asset.label_norm, ...e.asset.aliases.map((a) => normalizeLabel(a.text))])
    for (const key of keys) {
      if (!key) continue
      const list = byKey.get(key) ?? []
      list.push(e)
      byKey.set(key, list)
    }
  }

  const select: Record<string, string> = {}
  const autoDefault: Record<string, string[]> = {}
  let multiEntryKeys = 0
  let defaultsChosen = 0
  let leftAmbiguous = 0
  for (const [key, list] of byKey) {
    if (list.length < 2) continue
    multiEntryKeys += 1
    // One fixed default per word: the entry that is the word itself, a clean name over a flagged one, no sense qualifier, the base file, the lowest (Sign_N), then path.
    const rank = (e: Entry) => [
      e.asset.label_norm === key ? 0 : 1,
      e.asset.status === 'source_label' ? 0 : 1,
      e.parsed.senses.length > 0 ? 1 : 0,
      e.parsed.altNumber === null && !e.parsed.english ? 0 : 1,
      e.parsed.altNumber ?? 0,
    ]
    const sorted = [...list].sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i]
      return a.asset.rel_path < b.asset.rel_path ? -1 : a.asset.rel_path > b.asset.rel_path ? 1 : 0
    })
    // Never pick silently among entries that all still need review: those words stay ambiguous until a person chooses.
    if (sorted[0].asset.status === 'source_label') {
      select[key] = sorted[0].asset.asset_id
      autoDefault[key] = sorted.map((e) => e.asset.asset_id)
      defaultsChosen += 1
    } else {
      leftAmbiguous += 1
    }
  }

  const byStatus: Record<string, number> = {}
  for (const e of entries) byStatus[e.asset.status] = (byStatus[e.asset.status] ?? 0) + 1

  return {
    manifest: {
      schema_version: '1.0',
      source: 'ISLRTC Indian Sign Language Dictionary (Hugging Face re-encode silentone0725/Indian_Sign_Language_Data.gov_Rencoded), indexed from file names only',
      generated_at: now.toISOString(),
      assets: entries.map((e) => e.asset),
    },
    mappings: { ...EMPTY_MAPPINGS, select, auto_default: autoDefault, synonyms: {} },
    stats: { files: entries.length, byStatus, multiEntryKeys, defaultsChosen, leftAmbiguous },
  }
}
