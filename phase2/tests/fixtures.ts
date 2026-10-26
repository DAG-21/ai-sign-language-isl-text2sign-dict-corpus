import { buildIndex } from '@/lib/sign/manifest'
import { EMPTY_MAPPINGS, type ApprovedMappings, type ManifestAsset } from '@/lib/sign/types'
import { SUPPORTED_TOKEN_SET } from '@/lib/islVocabulary'
import { normalizeLabel } from '@/lib/sign/normalize'
import type { ResolverContext } from '@/lib/sign/resolver'

/** Synthetic assets: shape follows the manifest contract, not real ISLRTC data. */
export function asset(id: string, label: string, extra: Partial<ManifestAsset> = {}): ManifestAsset {
  return {
    asset_id: id,
    label,
    label_norm: normalizeLabel(label),
    aliases: [],
    variant: null,
    rel_path: `clips/${id}.mp4`,
    container: 'mp4',
    codec: 'hevc',
    duration_s: 2,
    status: 'verified',
    ...extra,
  }
}

export function context(assets: ManifestAsset[], mappings: ApprovedMappings = EMPTY_MAPPINGS, fileExists?: ResolverContext['fileExists']): ResolverContext {
  const index = buildIndex({ schema_version: '1.0', source: 'test', generated_at: 'x', assets })
  return { yapTokens: SUPPORTED_TOKEN_SET, index, mappings, fileExists }
}
