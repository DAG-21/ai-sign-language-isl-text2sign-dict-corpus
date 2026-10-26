import fs from 'node:fs'
import path from 'node:path'
import type { PoseIndexFile, PoseSummary } from './poseGate'

/**
 * Server-side access to the extracted avatar tracks (data/pose, written by scripts/pose/batch_extract.py and gated by scripts/build-pose-index.ts).
 *
 * Environment:
 *  - ISLRTC_POSE_DIR   folder holding pose_index.json and tracks/<asset id>.bones.json.gz (default: data/pose)
 *
 * Without pose_index.json nothing here is offered, and every dictionary sign keeps resolving as its video.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// Runtime-only paths, as in server.ts: the comments keep Turbopack from tracing the project into the server bundle.
const exists = (p: string) => fs.existsSync(/*turbopackIgnore: true*/ p)
const mtimeOf = (p: string) => fs.statSync(/*turbopackIgnore: true*/ p).mtimeMs
const readText = (p: string) => fs.readFileSync(/*turbopackIgnore: true*/ p, 'utf8')

export function readPoseEnv() {
  return { dir: process.env.ISLRTC_POSE_DIR || path.join(process.cwd(), 'data', 'pose') }
}

let cached: { key: string; value: PoseIndexFile } | null = null

/** Load (and memoise by file mtime) the gated pose index. Null when no index exists or it is not the expected schema. */
export function loadPoseIndex(dir: string = readPoseEnv().dir): PoseIndexFile | null {
  const file = path.join(dir, 'pose_index.json')
  if (!exists(file)) return null
  const key = `${file}:${mtimeOf(file)}`
  if (cached?.key === key) return cached.value
  const parsed = JSON.parse(readText(file)) as PoseIndexFile
  if (parsed?.schema_version !== '1.0' || typeof parsed.assets !== 'object' || parsed.assets === null) return null
  cached = { key, value: parsed }
  return parsed
}

export function trackPath(dir: string, assetId: string): string {
  return path.join(dir, 'tracks', `${assetId}.bones.json.gz`)
}

export type PoseLookup = { ok: true; absolutePath: string; size: number; summary: PoseSummary } | { ok: false; status: 400 | 404 | 503; error: string }

/**
 * Turn an asset id into a track file. Only ids the gate accepted are served, the id never contributes anything but a file name
 * (it must match the id pattern), and the file must really be there.
 */
export function lookupPoseTrack(assetId: string, dir: string = readPoseEnv().dir, index: PoseIndexFile | null = loadPoseIndex(dir)): PoseLookup {
  if (!ID_PATTERN.test(assetId)) return { ok: false, status: 400, error: 'Invalid asset id.' }
  if (!index) return { ok: false, status: 503, error: 'No avatar tracks are configured.' }
  const entry = Object.hasOwn(index.assets, assetId) ? index.assets[assetId] : undefined
  if (!entry || !entry.ok || !entry.window) return { ok: false, status: 404, error: 'No usable avatar track for this sign.' }
  const file = trackPath(dir, assetId)
  let size: number
  try {
    const stat = fs.statSync(/*turbopackIgnore: true*/ file)
    if (!stat.isFile()) return { ok: false, status: 404, error: 'Track file not found.' }
    size = stat.size
  } catch {
    return { ok: false, status: 404, error: 'Track file not found.' }
  }
  return { ok: true, absolutePath: file, size, summary: { handFrac: entry.handFrac, poseFrac: entry.poseFrac, frames: entry.frames, fps: entry.fps, window: entry.window } }
}

/** Resolver hook: the summary of a usable track, or null. Returns null overall when no index is configured. */
export function poseResolverHook(dir: string = readPoseEnv().dir): { lookup: (assetId: string) => PoseSummary | null } | null {
  const index = loadPoseIndex(dir)
  if (!index) return null
  return {
    lookup: (assetId) => {
      const found = lookupPoseTrack(assetId, dir, index)
      return found.ok ? found.summary : null
    },
  }
}

export function readTrack(absolutePath: string): Buffer {
  return fs.readFileSync(/*turbopackIgnore: true*/ absolutePath)
}
