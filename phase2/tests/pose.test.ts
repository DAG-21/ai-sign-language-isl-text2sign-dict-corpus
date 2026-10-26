import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POSE_GATE, buildPoseIndex, evaluateGate, parseCsv, type PoseIndexFile, type PoseSummary } from '@/lib/sign/poseGate'
import { BLEND_SECONDS, blendPose, clipFor, clipSeconds, isPoseTrack, runDuration, sampleClip, sampleRun, slerp, type Pose, type PoseTrack, type Quat } from '@/lib/sign/poseTrack'
import { loadPoseClips, poseToVideo } from '@/lib/sign/poseClient'
import { lookupPoseTrack, poseResolverHook } from '@/lib/sign/poseServer'
import { resolveGloss } from '@/lib/sign/resolver'
import { buildSegments } from '@/lib/sign/playback'
import { summarize } from '@/lib/sign/coverage'
import type { PoseSign, ResolvedSign } from '@/lib/sign/types'
import { asset, context } from './fixtures'

const ID: Quat = [0, 0, 0, 1]
const Z90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2] // 90 degrees about z
const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5))

/** A 5-frame track at 10 fps whose bone "B" turns from identity to 90 degrees about z. */
function track(): PoseTrack {
  return { fps: 10, frames: [0, 1, 2, 3, 4].map((i) => ({ t: i / 10, bones: { B: slerp(ID, Z90, i / 4) } })) }
}
const summary = (window: [number, number] = [1, 3]): PoseSummary => ({ handFrac: 0.6, poseFrac: 1, frames: 5, fps: 10, window })

describe('quality gate', () => {
  it('accepts a track with enough hands, a visible body and a window', () => {
    expect(evaluateGate({ handFrac: 0.3, poseFrac: 0.9, window: [2, 40] })).toEqual({ ok: true, reasons: [] })
  })
  it('names every reason a track is rejected', () => {
    expect(evaluateGate({ handFrac: 0.29, poseFrac: 1, window: [0, 5] })).toEqual({ ok: false, reasons: ['few_hands'] })
    expect(evaluateGate({ handFrac: 0.9, poseFrac: 0.89, window: [0, 5] }).reasons).toEqual(['body_lost'])
    expect(evaluateGate({ handFrac: 0, poseFrac: 0.5, window: null }).reasons).toEqual(['few_hands', 'body_lost', 'no_window'])
  })
  it('parses the CSV the extraction writes, including quoted commas and CRLF', () => {
    const rows = parseCsv('id,label,mb\r\na1,"Rock, paper",0.3\r\na2,Plain,1.5\r\n')
    expect(rows).toEqual([
      { id: 'a1', label: 'Rock, paper', mb: '0.3' },
      { id: 'a2', label: 'Plain', mb: '1.5' },
    ])
  })
  it('joins quality with the progress log, ignores unfinished clips and counts the reasons', () => {
    const quality = [
      { id: 'good', label: 'Good', mb: '1', frames: '100', hand_frac: '0.6', pose_frac: '1' },
      { id: 'few', label: 'Few', mb: '1', frames: '100', hand_frac: '0.1', pose_frac: '1' },
      { id: 'lost', label: 'Lost', mb: '1', frames: '100', hand_frac: '0.7', pose_frac: '0.5' },
      { id: 'err', label: 'Err', mb: '1', frames: '100', hand_frac: '0.7', pose_frac: '1' },
      { id: 'orphan', label: 'Orphan', mb: '1', frames: '100', hand_frac: '0.7', pose_frac: '1' },
    ]
    const progress = [
      { id: 'good', status: 'ok', fps: 25, window: [3, 90] as [number, number] },
      { id: 'few', status: 'ok', fps: 25, window: [3, 90] as [number, number] },
      { id: 'lost', status: 'ok', fps: 30, window: null },
      { id: 'err', status: 'error' },
    ]
    const idx = buildPoseIndex(quality, progress, POSE_GATE, 't')
    expect(Object.keys(idx.assets).sort()).toEqual(['few', 'good', 'lost'])
    expect(idx.assets.good).toMatchObject({ ok: true, window: [3, 90], fps: 25 })
    expect(idx.assets.lost).toMatchObject({ ok: false, fps: 30, reasons: ['body_lost', 'no_window'] })
    expect(idx.counts).toEqual({ total: 3, ok: 1, rejected: 2, byReason: { few_hands: 1, body_lost: 1, no_window: 1 } })
  })
})

describe('track playback maths', () => {
  it('slerp hits both ends, takes the short way round and stays unit length', () => {
    near(slerp(ID, Z90, 0), ID)
    near(slerp(ID, Z90, 1), Z90)
    near(slerp(ID, [0, 0, -Z90[2], -Z90[3]], 1), Z90) // the negated quaternion is the same rotation
    const mid = slerp(ID, Z90, 0.5)
    expect(Math.hypot(...mid)).toBeCloseTo(1, 6)
    near(mid, [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)])
  })
  it('blends bones present on one side only as they are', () => {
    const out = blendPose({ A: ID }, { B: Z90 }, 0.5)
    near(out.A, ID)
    near(out.B, Z90)
  })
  it('trims a track to its signing window with padding, clamped to the frames that exist', () => {
    expect(clipFor(track(), summary([1, 3]), 0)).toMatchObject({ start: 1, end: 3 })
    expect(clipFor(track(), summary([1, 3]), 6)).toMatchObject({ start: 0, end: 4 })
    const odd = clipFor(track(), summary([4, 4]), 0)
    expect(odd.end).toBeGreaterThan(odd.start)
    expect(odd.end).toBeLessThanOrEqual(4)
  })
  it('samples a clip between frames and clamps outside it', () => {
    const clip = clipFor(track(), summary([0, 4]), 0)
    expect(clipSeconds(clip)).toBeCloseTo(0.4, 6)
    near(sampleClip(clip, 0).B, ID)
    near(sampleClip(clip, 0.4).B, Z90)
    near(sampleClip(clip, 0.2).B, slerp(ID, Z90, 0.5))
    near(sampleClip(clip, 9).B, Z90)
  })
  it('plays a run: eases in from the neutral pose, plays the sign, eases back out', () => {
    const clip = clipFor(track(), summary([0, 4]), 0)
    const from: Pose = { B: [0, 0, -Math.SQRT1_2, Math.SQRT1_2] }
    const to: Pose = { B: [0, 0, 0.3826834324, 0.9238795325] }
    expect(runDuration([clip])).toBeCloseTo(0.4 + 2 * BLEND_SECONDS, 6)
    near(sampleRun([clip], 0, from, to).B, from.B)
    near(sampleRun([clip], BLEND_SECONDS + 0.2, from, to).B, slerp(ID, Z90, 0.5)) // inside the sign
    near(sampleRun([clip], runDuration([clip]), from, to).B, to.B)
    near(sampleRun([clip], 99, from, to).B, to.B)
    expect(sampleRun([], 1, from, to)).toBe(to)
  })
  it('is continuous where one sign hands over to the next', () => {
    const a = clipFor(track(), summary([0, 4]), 0)
    const b = clipFor({ fps: 10, frames: [ID, ID, ID].map((q, i) => ({ t: i / 10, bones: { B: q } })) }, summary([0, 2]), 0)
    const neutral: Pose = { B: ID }
    const join = BLEND_SECONDS + clipSeconds(a)
    const before = sampleRun([a, b], join - 1e-4, neutral, neutral).B
    const after = sampleRun([a, b], join + 1e-4, neutral, neutral).B
    expect(Math.hypot(before[2] - after[2], before[3] - after[3])).toBeLessThan(0.01)
  })
  it('validates a fetched track before the avatar sees it', () => {
    expect(isPoseTrack(track())).toBe(true)
    expect(isPoseTrack(null)).toBe(false)
    expect(isPoseTrack({ fps: 25, frames: [] })).toBe(false)
    expect(isPoseTrack({ fps: 0, frames: track().frames })).toBe(false)
    expect(isPoseTrack({ fps: 25, frames: [{ t: 0, bones: { B: [1, 2, 3] } }, { t: 1, bones: {} }] })).toBe(false)
    expect(isPoseTrack({ fps: 25, frames: [{ t: 0, bones: { B: [0, 0, 0, NaN] } }, { t: 1, bones: {} }] })).toBe(false)
  })
})

describe('serving avatar tracks safely', () => {
  let dir: string
  let secret: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-test-'))
    fs.mkdirSync(path.join(dir, 'tracks'))
    const index: PoseIndexFile = {
      schema_version: '1.0',
      generated_at: 't',
      gate: POSE_GATE,
      counts: { total: 3, ok: 2, rejected: 1, byReason: { few_hands: 1, body_lost: 0, no_window: 0 } },
      assets: {
        good: { handFrac: 0.6, poseFrac: 1, frames: 5, fps: 25, window: [1, 3], ok: true, reasons: [] },
        nofile: { handFrac: 0.6, poseFrac: 1, frames: 5, fps: 25, window: [1, 3], ok: true, reasons: [] },
        weak: { handFrac: 0.1, poseFrac: 1, frames: 5, fps: 25, window: [1, 3], ok: false, reasons: ['few_hands'] },
      },
    }
    fs.writeFileSync(path.join(dir, 'pose_index.json'), JSON.stringify(index))
    fs.writeFileSync(path.join(dir, 'tracks', 'good.bones.json.gz'), Buffer.alloc(10, 1))
    fs.writeFileSync(path.join(dir, 'tracks', 'weak.bones.json.gz'), Buffer.alloc(10, 1))
    secret = path.join(path.dirname(dir), `secret-${path.basename(dir)}.bones.json.gz`)
    fs.writeFileSync(secret, 'secret')
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(secret, { force: true })
  })

  it('serves a track the gate accepted', () => {
    const r = lookupPoseTrack('good', dir)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.size).toBe(10)
      expect(r.summary).toEqual({ handFrac: 0.6, poseFrac: 1, frames: 5, fps: 25, window: [1, 3] })
    }
  })
  it('refuses a rejected track even though its file exists, and a track whose file is gone', () => {
    expect(lookupPoseTrack('weak', dir)).toMatchObject({ ok: false, status: 404 })
    expect(lookupPoseTrack('nofile', dir)).toMatchObject({ ok: false, status: 404 })
    expect(lookupPoseTrack('unknown', dir)).toMatchObject({ ok: false, status: 404 })
  })
  it.each(['../secret', '..\\secret', 'good/../good', 'a b', '', 'x'.repeat(80), 'good.bones.json.gz'])('rejects the invalid id %j', (id) => {
    expect(lookupPoseTrack(id, dir)).toMatchObject({ ok: false, status: 400 })
  })
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('does not treat the object key %j as an asset', (id) => {
    expect(lookupPoseTrack(id, dir)).toMatchObject({ ok: false, status: 404 })
  })
  it('reports 503 when no index is configured', () => {
    expect(lookupPoseTrack('good', path.join(dir, 'nowhere'))).toMatchObject({ ok: false, status: 503 })
    expect(poseResolverHook(path.join(dir, 'nowhere'))).toBeNull()
  })
  it('offers the resolver only usable tracks', () => {
    const hook = poseResolverHook(dir)!
    expect(hook.lookup('good')).toMatchObject({ window: [1, 3] })
    expect(hook.lookup('weak')).toBeNull()
    expect(hook.lookup('nofile')).toBeNull()
  })
})

describe('resolving to avatar tracks', () => {
  const assets = [asset('w1', 'World'), asset('p1', 'Paramedic'), asset('t1', 'Tradition', { status: 'source_label' })]
  const hook = (usable: string[]) => ({ lookup: (id: string) => (usable.includes(id) ? summary() : null) })

  it('resolves a dictionary word as an avatar track when one passed the gate', () => {
    const ctx = { ...context(assets), pose: hook(['w1']) }
    const [world, para] = resolveGloss(['WORLD', 'PARAMEDIC'], ctx)
    expect(world).toMatchObject({ kind: 'islrtc_pose', assetId: 'w1', label: 'World', via: 'exact', reviewed: true, pose: summary() })
    // no usable track: still the recorded video, exactly as before
    expect(para).toMatchObject({ kind: 'islrtc_video', assetId: 'p1' })
  })
  it('changes nothing when no tracks are configured', () => {
    expect(resolveGloss(['WORLD'], context(assets))[0]).toMatchObject({ kind: 'islrtc_video', assetId: 'w1' })
  })
  it('keeps a Yap animation ahead of an avatar track', () => {
    const ctx = { ...context([asset('h1', 'Hello')]), pose: hook(['h1']) }
    expect(resolveGloss(['HELLO'], ctx)[0].kind).toBe('yap_animation')
  })
  it('keeps the synonym note on a pose sign', () => {
    const ctx = {
      ...context(assets, { select: {}, alias: {}, split: {}, synonyms: { custom: { to: ['tradition'], confidence: 'exact' } } }),
      pose: hook(['t1']),
    }
    expect(resolveGloss(['CUSTOM'], ctx)[0]).toMatchObject({ kind: 'islrtc_pose', assetId: 't1', gloss: 'CUSTOM', synonym: { to: 'tradition', confidence: 'exact' }, reviewed: false })
  })
  it('counts avatar tracks separately from videos and from Yap animations', () => {
    const plan = resolveGloss(['WORLD', 'PARAMEDIC', 'HELLO'], { ...context([...assets, asset('h1', 'Hello')]), pose: hook(['w1']) })
    const c = summarize(plan)
    expect(c.bySource.islrtc_pose).toEqual({ occurrences: 1, unique: 1 })
    expect(c.bySource.islrtc_video).toEqual({ occurrences: 1, unique: 1 })
    expect(c.bySource.yap_animation).toEqual({ occurrences: 1, unique: 1 })
    expect(c.poseSequence).toEqual({ occurrences: 1, unique: 1 })
    expect(c.note).toMatch(/unreviewed/)
  })
  it('groups consecutive avatar tracks into one segment, split by anything else', () => {
    const ctx = { ...context([...assets, asset('h1', 'Hello'), asset('c1', 'Cup')]), pose: hook(['w1', 'p1']) }
    const segs = buildSegments(resolveGloss(['WORLD', 'PARAMEDIC', 'HELLO', 'CUP', 'WORLD'], ctx))
    expect(segs.map((s) => s.type)).toEqual(['pose', 'avatar', 'video', 'pose'])
    const first = segs[0]
    expect(first.type === 'pose' && first.items.map((i) => i.assetId)).toEqual(['w1', 'p1'])
  })
})

describe('loading tracks in the browser', () => {
  const plan = resolveGloss(['WORLD', 'PARAMEDIC', 'WORLD'], { ...context([asset('w1', 'World'), asset('p1', 'Paramedic')]), pose: { lookup: () => summary() } })
  const goodTrack = track()
  const respond = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response

  it('loads each track once and keeps the plan', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return respond(goodTrack)
    }) as unknown as typeof fetch
    const out = await loadPoseClips(plan, fetchImpl)
    expect(calls.sort()).toEqual(['/api/islrtc-pose/p1', '/api/islrtc-pose/w1'])
    expect(out.plan.map((p) => p.kind)).toEqual(['islrtc_pose', 'islrtc_pose', 'islrtc_pose'])
    expect([...out.clips.keys()].sort()).toEqual(['p1', 'w1'])
    expect(out.clips.get('w1')).toMatchObject({ start: 0, end: 4 }) // window [1,3] padded by 6 frames and clamped
  })
  it('turns a sign back into its video when the track is missing, malformed or unreachable', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/w1')) return respond({ error: 'nope' }, false)
      if (url.endsWith('/p1')) return respond({ fps: 25, frames: [] })
      throw new Error('network')
    }) as unknown as typeof fetch
    const out = await loadPoseClips(plan, fetchImpl)
    expect(out.plan.map((p) => p.kind)).toEqual(['islrtc_video', 'islrtc_video', 'islrtc_video'])
    expect(out.clips.size).toBe(0)
    const video = out.plan[0]
    expect(video).toMatchObject({ kind: 'islrtc_video', assetId: 'w1', label: 'World', via: 'exact' })
    expect('pose' in video).toBe(false)
  })
  it('degrades only the sign whose track failed', async () => {
    const fetchImpl = (async (url: string) => (url.endsWith('/w1') ? respond(goodTrack) : respond({}, false))) as unknown as typeof fetch
    const out = await loadPoseClips(plan, fetchImpl)
    expect(out.plan.map((p) => p.kind)).toEqual(['islrtc_pose', 'islrtc_video', 'islrtc_pose'])
  })
  it('leaves a plan without avatar tracks alone and fetches nothing', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return respond({})
    }) as unknown as typeof fetch
    const plain: ResolvedSign[] = [{ kind: 'yap_animation', gloss: 'HELLO', token: 'HELLO' }]
    expect((await loadPoseClips(plain, fetchImpl)).plan).toEqual(plain)
    expect(called).toBe(false)
  })
  it('poseToVideo keeps every field except the pose summary', () => {
    const p = plan[0] as PoseSign
    expect(poseToVideo(p)).toEqual({ kind: 'islrtc_video', gloss: 'WORLD', token: 'WORLD', assetId: 'w1', label: 'World', variant: null, reviewed: true, via: 'exact' })
  })
})
