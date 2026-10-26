import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildIndex } from '@/lib/sign/manifest'
import { EMPTY_MAPPINGS } from '@/lib/sign/types'
import { isInside, lookupMedia, type Loaded } from '@/lib/sign/server'
import { parseRange } from '@/lib/sign/range'
import { asset } from './fixtures'

let tmp: string
let root: string
let outside: string
let data: Loaded

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'islrtc-test-'))
  root = path.join(tmp, 'dataset')
  outside = path.join(tmp, 'secret.mp4')
  fs.mkdirSync(path.join(root, 'clips'), { recursive: true })
  fs.writeFileSync(path.join(root, 'clips', 'ok.mp4'), Buffer.alloc(1000, 1))
  fs.writeFileSync(path.join(root, 'clips', 'notes.txt'), 'text')
  fs.writeFileSync(outside, 'top secret')
  const assets = [
    asset('ok', 'Ok', { rel_path: 'clips/ok.mp4' }),
    asset('gone', 'Gone', { rel_path: 'clips/gone.mp4' }),
    asset('txt', 'Txt', { rel_path: 'clips/notes.txt' }),
    asset('dots', 'Dots', { rel_path: '../secret.mp4' }),
    asset('abs', 'Abs', { rel_path: outside }),
    asset('flagged', 'Flagged', { rel_path: 'clips/ok.mp4', status: 'missing_file' }),
  ]
  data = { index: buildIndex({ schema_version: '1.0', source: 't', generated_at: 'x', assets }), mappings: EMPTY_MAPPINGS, root: fs.realpathSync(root) }
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('safe media lookup', () => {
  it('serves a manifest asset inside the dataset root', () => {
    const r = lookupMedia('ok', data)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.contentType).toBe('video/mp4')
  })

  it.each(['../secret', 'ok/../../x', 'a b', '', 'x'.repeat(80), 'ok.mp4', 'C:\\Windows\\win.ini'])('rejects the invalid asset id %j', (id) => {
    const r = lookupMedia(id, data)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('returns 404 for ids that are not in the manifest, so arbitrary paths cannot be requested', () => {
    const r = lookupMedia('notinmanifest', data)
    expect(r).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses traversal and absolute paths written into the manifest', () => {
    expect(lookupMedia('dots', data)).toMatchObject({ ok: false, status: 400 })
    expect(lookupMedia('abs', data)).toMatchObject({ ok: false, status: 400 })
  })

  it('handles a missing file, a missing_file status and an unsupported type', () => {
    expect(lookupMedia('gone', data)).toMatchObject({ ok: false, status: 404 })
    expect(lookupMedia('flagged', data)).toMatchObject({ ok: false, status: 404 })
    expect(lookupMedia('txt', data)).toMatchObject({ ok: false, status: 415 })
  })

  it('reports 503 when no manifest or dataset directory is configured', () => {
    expect(lookupMedia('ok', null)).toMatchObject({ ok: false, status: 503 })
    expect(lookupMedia('ok', { ...data, root: null })).toMatchObject({ ok: false, status: 503 })
  })

  it('isInside rejects siblings that merely share a prefix', () => {
    expect(isInside('/data/root', '/data/root/a.mp4')).toBe(true)
    expect(isInside('/data/root', '/data/root-evil/a.mp4')).toBe(false)
    expect(isInside('/data/root', '/data/root')).toBe(false)
  })

  it('does not follow a symlink that leaves the dataset root', () => {
    const link = path.join(root, 'clips', 'link.mp4')
    try {
      fs.symlinkSync(outside, link)
    } catch {
      return // creating symlinks needs privileges on some Windows set-ups; nothing to assert then
    }
    const withLink: Loaded = { ...data, index: buildIndex({ schema_version: '1.0', source: 't', generated_at: 'x', assets: [asset('link', 'Link', { rel_path: 'clips/link.mp4' })] }) }
    expect(lookupMedia('link', withLink)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('byte ranges', () => {
  it('parses normal, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('treats absent or malformed headers as a full response, and out-of-file ranges as unsatisfiable', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('items=1-2', 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=50-10', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })
})

const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'])
describe.skipIf(ffmpeg.status !== 0)('optional H.264 cache (real FFmpeg)', () => {
  it('converts one HEVC clip on request, leaves the original untouched, and reuses the copy', async () => {
    const cache = path.join(tmp, 'cache')
    process.env.ISLRTC_CACHE_DIR = cache
    const src = path.join(root, 'clips', 'hevc.mp4')
    const gen = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', src])
    expect(gen.status).toBe(0)
    const before = fs.statSync(src)

    const { ensureH264 } = await import('@/lib/sign/transcode')
    const out = await ensureH264('hevc1', src)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out])
    expect(String(probe.stdout).trim()).toBe('h264')

    const mtime = fs.statSync(out).mtimeMs
    expect(await ensureH264('hevc1', src)).toBe(out)
    expect(fs.statSync(out).mtimeMs).toBe(mtime)
    expect(fs.statSync(src).size).toBe(before.size)
    expect(fs.statSync(src).mtimeMs).toBe(before.mtimeMs)
  }, 60000)
})
