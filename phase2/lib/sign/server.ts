import fs from 'node:fs'
import path from 'node:path'
import { buildIndex, validateManifest, validateMappings, type ManifestIndex } from './manifest'
import type { ApprovedMappings, ManifestAsset } from './types'

/**
 * Server-side access to the ISLRTC manifest and media.
 *
 * Environment:
 *  - ISLRTC_DATA_DIR      root of the downloaded dictionary (read in place, never copied)
 *  - ISLRTC_MANIFEST      path to the manifest JSON written by the indexing script
 *  - ISLRTC_MAPPINGS      optional path to the reviewed mappings JSON (select / alias / split)
 *  - ISLRTC_CACHE_DIR     where on-demand H.264 copies are written (default: .cache/islrtc)
 *  - ISLRTC_TRANSCODE     "1" to build a browser-compatible H.264 copy of requested HEVC clips
 */

export const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type MediaLookup =
  | { ok: true; asset: ManifestAsset; absolutePath: string; contentType: string }
  | { ok: false; status: 400 | 404 | 415 | 503; error: string }

export type Loaded = { index: ManifestIndex; mappings: ApprovedMappings; root: string | null }

let cached: { key: string; value: Loaded } | null = null

// The manifest and dataset live wherever the environment says, so these paths are runtime-only by design. The comments stop Turbopack
// from tracing the whole project into the server bundle because of them.
const exists = (p: string) => fs.existsSync(/*turbopackIgnore: true*/ p)
const mtimeOf = (p: string) => fs.statSync(/*turbopackIgnore: true*/ p).mtimeMs
const readText = (p: string) => fs.readFileSync(/*turbopackIgnore: true*/ p, 'utf8')
const realpath = (p: string) => fs.realpathSync(/*turbopackIgnore: true*/ p)

export function readEnv() {
  return {
    dataDir: process.env.ISLRTC_DATA_DIR || '',
    manifest: process.env.ISLRTC_MANIFEST || path.join(process.cwd(), 'data', 'islrtc', 'manifest.json'),
    mappings: process.env.ISLRTC_MAPPINGS || path.join(process.cwd(), 'data', 'islrtc', 'approved_mappings.json'),
    cacheDir: process.env.ISLRTC_CACHE_DIR || path.join(process.cwd(), '.cache', 'islrtc'),
    transcode: process.env.ISLRTC_TRANSCODE === '1',
  }
}

/** Load (and memoise by file mtime) the manifest. Returns null when no manifest exists yet. */
export function loadSignData(): Loaded | null {
  const env = readEnv()
  if (!exists(env.manifest)) return null
  const mtime = mtimeOf(env.manifest)
  const mappingsMtime = exists(env.mappings) ? mtimeOf(env.mappings) : 0
  const key = `${env.manifest}:${mtime}:${env.mappings}:${mappingsMtime}:${env.dataDir}`
  if (cached?.key === key) return cached.value

  const manifest = validateManifest(JSON.parse(readText(env.manifest)))
  const mappings = exists(env.mappings) ? validateMappings(JSON.parse(readText(env.mappings))) : validateMappings({})
  const root = env.dataDir && exists(env.dataDir) ? realpath(env.dataDir) : null
  const value: Loaded = { index: buildIndex(manifest), mappings, root }
  cached = { key, value }
  return value
}

/** True when `candidate` (already real-pathed) is inside `root`. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Turn an asset id into a file path. Only ids present in the manifest are
 * accepted; the requested "path" never comes from the client.
 */
export function lookupMedia(assetId: string, data: Loaded | null = loadSignData()): MediaLookup {
  if (!ID_PATTERN.test(assetId)) return { ok: false, status: 400, error: 'Invalid asset id.' }
  if (!data) return { ok: false, status: 503, error: 'No ISLRTC manifest is configured.' }
  if (!data.root) return { ok: false, status: 503, error: 'ISLRTC_DATA_DIR is not set or does not exist.' }

  const asset = data.index.byId.get(assetId)
  if (!asset || asset.status === 'missing_file') return { ok: false, status: 404, error: 'Unknown asset.' }

  const rel = asset.rel_path
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { ok: false, status: 400, error: 'Manifest path is not a safe relative path.' }
  }
  const contentType = ALLOWED_EXTENSIONS[path.extname(rel).toLowerCase()]
  if (!contentType) return { ok: false, status: 415, error: 'Unsupported media type.' }

  let real: string
  try {
    real = fs.realpathSync(path.resolve(data.root, rel))
  } catch {
    return { ok: false, status: 404, error: 'Media file not found.' }
  }
  if (!isInside(data.root, real)) return { ok: false, status: 400, error: 'Path escapes the dataset root.' }
  if (!fs.statSync(real).isFile()) return { ok: false, status: 404, error: 'Media file not found.' }
  return { ok: true, asset, absolutePath: real, contentType }
}

/** Resolver hook: does the file behind this asset exist right now? */
export function mediaExists(asset: ManifestAsset, data: Loaded): boolean {
  return lookupMedia(asset.asset_id, data).ok
}
