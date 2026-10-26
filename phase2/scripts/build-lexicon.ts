import fs from 'node:fs'
import path from 'node:path'
import { buildLexicon, lexiconToCsv } from '../lib/sign/lexicon'
import { validateManifest, validateMappings } from '../lib/sign/manifest'

/**
 * Write one clean list of unique words, each paired with the avatar animation and/or a dictionary clip, and print how many are covered.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/build-lexicon.ts [-- --dir data/islrtc]
 *
 * Reads manifest.json and approved_mappings.json from --dir (build them first with scripts/build-manifest.ts); writes lexicon.csv and lexicon.json there.
 */

const i = process.argv.indexOf('--dir')
const dir = i >= 0 ? process.argv[i + 1] : path.join('data', 'islrtc')

const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')))
const mappingsPath = path.join(dir, 'approved_mappings.json')
const mappings = validateMappings(fs.existsSync(mappingsPath) ? JSON.parse(fs.readFileSync(mappingsPath, 'utf8')) : {})

const { rows, stats } = buildLexicon(manifest, mappings)
fs.writeFileSync(path.join(dir, 'lexicon.csv'), lexiconToCsv(rows))
fs.writeFileSync(path.join(dir, 'lexicon.json'), JSON.stringify({ generated_at: new Date().toISOString(), stats, rows }, null, 1))

const pct = (n: number) => `${((100 * n) / stats.uniqueWords).toFixed(1)}%`
console.log(`Unique words/phrases in the list: ${stats.uniqueWords} (${stats.singleWord} single words, ${stats.multiWord} multi-word)`)
console.log(`  headwords: ${stats.keyTypes.label}, aliases found in file names (acronyms, "A or B" parts): ${stats.keyTypes.alias}`)
console.log(`Playable right now: ${stats.playsNow} (${pct(stats.playsNow)}), of which single words: ${stats.playsNowSingleWord}`)
console.log('By source:')
console.log(`  avatar and dictionary clip : ${stats.bySource.both}`)
console.log(`  avatar only                : ${stats.bySource.yap_only}`)
console.log(`  dictionary clip only       : ${stats.bySource.islrtc_only}`)
console.log(`  needs a decision           : ${stats.bySource.needs_decision}  (dictionary entries exist but none can be auto-selected)`)
console.log(`Avatar vocabulary: ${stats.avatarWords} words (the 26 fingerspelling letters are not counted as words)`)
console.log(`Wrote ${path.join(dir, 'lexicon.csv')} and ${path.join(dir, 'lexicon.json')}`)
