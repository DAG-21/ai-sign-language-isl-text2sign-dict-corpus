import type { ApprovedMappings, Manifest, ManifestAsset } from './types'
import { normalizeLabel } from './normalize'

/** In-memory lookup built once from a manifest. No media is touched here. */
export type ManifestIndex = {
  byId: Map<string, ManifestAsset>
  /** normalised label or verified alias -> assets (several = ambiguous / variants). */
  byLabel: Map<string, ManifestAsset[]>
  /** longest label/alias in words, to bound phrase matching. */
  maxWords: number
}

export function buildIndex(manifest: Manifest): ManifestIndex {
  const byId = new Map<string, ManifestAsset>()
  const byLabel = new Map<string, ManifestAsset[]>()
  let maxWords = 1
  const add = (key: string, asset: ManifestAsset) => {
    if (!key) return
    const list = byLabel.get(key) ?? []
    if (!list.includes(asset)) list.push(asset)
    byLabel.set(key, list)
    maxWords = Math.max(maxWords, key.split(' ').length)
  }
  for (const asset of manifest.assets) {
    byId.set(asset.asset_id, asset)
    add(asset.label_norm || normalizeLabel(asset.label), asset)
    // Only aliases that the source or a reviewer verified are searchable.
    for (const alias of asset.aliases) if (alias.verified) add(normalizeLabel(alias.text), asset)
  }
  return { byId, byLabel, maxWords }
}

export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest
  if (!m || m.schema_version !== '1.0' || !Array.isArray(m.assets)) {
    throw new Error('Unsupported manifest: expected schema_version "1.0" with an assets array')
  }
  return m
}

export function validateMappings(value: unknown): ApprovedMappings {
  const v = (value ?? {}) as Partial<ApprovedMappings>
  return { select: v.select ?? {}, alias: v.alias ?? {}, split: v.split ?? {}, auto_default: v.auto_default ?? {}, synonyms: v.synonyms ?? {} }
}
