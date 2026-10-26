import fs from 'node:fs'
import path from 'node:path'
import { buildIndexFiles } from '../lib/sign/indexer'

/**
 * Index a downloaded ISLRTC dictionary from its file names and write manifest.json + approved_mappings.json.
 * Only directory listings are read, never the videos, so it is cheap even on a streamed Google Drive folder.
 *
 *   npx vite-node scripts/build-manifest.ts -- --data-dir "G:\My Drive\islrtc" [--out-dir data/islrtc]
 */

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const value = i >= 0 ? process.argv[i + 1] : fallback
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

const dataDir = arg('data-dir')
const outDir = arg('out-dir', path.join('data', 'islrtc'))

const files = listFiles(dataDir)
const { manifest, mappings, stats } = buildIndexFiles(files)

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1))
fs.writeFileSync(path.join(outDir, 'approved_mappings.json'), JSON.stringify(mappings, null, 1))

console.log(`Indexed ${stats.files} video files from ${dataDir}`)
console.log('Status:', stats.byStatus)
console.log(`Words with several entries: ${stats.multiEntryKeys} (default chosen: ${stats.defaultsChosen}, left ambiguous: ${stats.leftAmbiguous})`)
console.log(`Wrote ${path.join(outDir, 'manifest.json')} and ${path.join(outDir, 'approved_mappings.json')}`)
