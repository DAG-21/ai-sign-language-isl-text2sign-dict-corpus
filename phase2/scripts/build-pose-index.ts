import fs from 'node:fs'
import path from 'node:path'
import { POSE_GATE, buildPoseIndex, parseCsv } from '../lib/sign/poseGate'

/**
 * Apply the quality gate to the extracted avatar tracks and write data/pose/pose_index.json, which the resolver reads.
 * Inputs: quality.csv (hand/body coverage per clip) and progress.jsonl (signing window and fps), both written by scripts/pose/batch_extract.py.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/build-pose-index.ts -- [--dir data/pose] [--min-hand 0.3] [--min-body 0.9]
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = arg('dir', path.join('data', 'pose'))
const gate = { minHandFrac: Number(arg('min-hand', String(POSE_GATE.minHandFrac))), minBodyFrac: Number(arg('min-body', String(POSE_GATE.minBodyFrac))) }

const quality = parseCsv(fs.readFileSync(path.join(dir, 'quality.csv'), 'utf8'))
const progress = fs
  .readFileSync(path.join(dir, 'progress.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const index = buildPoseIndex(quality, progress, gate)
// Only offer a track whose file is really there.
let missing = 0
for (const [id, entry] of Object.entries(index.assets)) {
  if (!entry.ok) continue
  if (!fs.existsSync(path.join(dir, 'tracks', `${id}.bones.json.gz`))) {
    entry.ok = false
    missing += 1
  }
}
index.counts.ok -= missing
index.counts.rejected += missing

fs.writeFileSync(path.join(dir, 'pose_index.json'), JSON.stringify(index))
const c = index.counts
console.log(`pose index: ${c.total} tracks scored, ${c.ok} usable, ${c.rejected} rejected (gate: hands >= ${gate.minHandFrac}, body >= ${gate.minBodyFrac})`)
console.log(`rejected because: few hands ${c.byReason.few_hands}, body lost ${c.byReason.body_lost}, no signing window ${c.byReason.no_window}${missing ? `, track file missing ${missing}` : ''}`)
