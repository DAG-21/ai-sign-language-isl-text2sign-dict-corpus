'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AvatarPlayer } from '@/components/avatar/AvatarPlayer'
import { translateOffline } from '@/lib/islTranslator'
import { parseGlossInput } from '@/lib/sign/input'
import type { Phase1Result, Phase1Sentence } from '@/lib/sign/phase1'
import { loadPoseClips } from '@/lib/sign/poseClient'
import { coverageLine, itemAtToken, wordStatuses } from '@/lib/sign/progress'
import { runDuration, type PoseClip } from '@/lib/sign/poseTrack'
import { IDLE, buildSegments, step, type PlaybackEvent, type PlaybackState } from '@/lib/sign/playback'
import type { ResolvedSign } from '@/lib/sign/types'

// A segment that never reports completion must not freeze the sequence.
const AVATAR_WATCHDOG_MS = 90_000
const VIDEO_WATCHDOG_MS = 30_000
const UNRESOLVED_HOLD_MS = 500

type PlanResponse = { plan: ResolvedSign[] }

type Mode = 'english' | 'video' | 'gloss'
type JobStatus = {
  running?: boolean
  ready?: boolean
  error?: { message?: string; hint?: string | null } | null
  steps?: { key: string; state: string; label: string }[]
  progress?: string[]
  transcript?: { total_segments?: number }
}
type GlossLine = Pick<Phase1Sentence, 'id' | 'source' | 'tokens' | 'needsReview' | 'notes'> &
  Partial<Pick<Phase1Sentence, 'reordered' | 'originalTokens'>> & { engine: Phase1Sentence['engine'] | 'offline' }

const ENGINE_LABEL: Record<GlossLine['engine'], string> = { llm: 'Phase 1 · LLM', spacy: 'Phase 1 · spaCy', offline: 'offline rules', none: 'no gloss' }
const MODE_LABEL: Record<Mode, string> = { english: 'English text', video: 'Video link', gloss: 'Gloss words' }
const JOB_POLL_MS = 2000
/** How fast the avatar signs, and the dictionary videos play, relative to the authored pace. */
const PLAYBACK_SPEED = 1.5

/** The small second line of each word chip: how the word is signed. */
const SOURCE_LABEL: Record<ResolvedSign['kind'], string> = {
  yap_animation: 'hand-made',
  islrtc_pose: 'avatar motion',
  islrtc_video: 'video',
  fingerspelling: 'spelled',
  unresolved: 'no sign',
}
const SOURCE_TITLE: Record<ResolvedSign['kind'], string> = {
  yap_animation: 'Signed by a hand-made avatar animation',
  islrtc_pose: 'Signed by the avatar from motion extracted from the dictionary video (unreviewed)',
  islrtc_video: 'Played as the recorded dictionary video',
  fingerspelling: 'Fingerspelled letter by letter',
  unresolved: 'No sign available for this word: it is skipped',
}

/** Small corner tag: where the sign comes from, plus `HI → HELLO` when a synonym stood in for the word. */
function tagFor(segment: ReturnType<typeof buildSegments>[number]): string {
  if (segment.type === 'unresolved') return ''
  const base = segment.type === 'video' ? 'dictionary video' : segment.type === 'pose' ? 'avatar · motion from dictionary video' : 'avatar'
  const items = segment.type === 'video' ? [segment.item] : segment.items
  const swaps = items.flatMap((i) => ((i.kind === 'yap_animation' || i.kind === 'islrtc_video' || i.kind === 'islrtc_pose') && i.synonym ? [`${i.gloss.replace(/_/g, ' ')} → ${i.synonym.to.toUpperCase().replace(/_/g, ' ')}`] : []))
  return swaps.length ? `${base} · ${swaps.join(', ')}` : base
}

/**
 * Minimal demo: one input box (ISL gloss words) and one output box that signs them. Words the avatar knows are signed by the 3D avatar,
 * other dictionary words are signed by the avatar from motion extracted from the ISLRTC clip when a quality-checked track exists and otherwise play as
 * the recorded video, names are fingerspelled. Words with no sign are skipped.
 */
export function GlossDemo() {
  const [text, setText] = useState('')
  const [plan, setPlan] = useState<ResolvedSign[]>([])
  const [loading, setLoading] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  const [error, setError] = useState('')

  // Where the gloss comes from: typed English (Phase 1), a video link (Phase 1 transcribes it first), or gloss words typed directly.
  const [mode, setMode] = useState<Mode>('english')
  const [phase1, setPhase1] = useState<{ available: boolean; llmKeyPresent?: boolean; reason?: string } | null>(null)
  const [glossLines, setGlossLines] = useState<GlossLine[]>([])
  const [english, setEnglish] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<JobStatus | null>(null)

  const [avatarPhrase, setAvatarPhrase] = useState('')
  const [requestId, setRequestId] = useState(0)
  const [stopId, setStopId] = useState(0)
  // Avatar tracks fetched for the current plan, and the run handed to the avatar for the pose segment being played.
  const poseClips = useRef(new Map<string, PoseClip>())
  // Which word of the current segment is being signed (an offset into the segment's items).
  const [wordOffset, setWordOffset] = useState(0)
  const [poseRun, setPoseRun] = useState<{ runId: number; clips: PoseClip[] } | null>(null)
  const [videoFormat, setVideoFormat] = useState<'original' | 'h264'>('h264')
  // ISLRTC clips are H.265; a browser that cannot decode it is given a cached H.264 copy straight away.
  const [hevcPlayable, setHevcPlayable] = useState(false)
  useEffect(() => {
    setHevcPlayable(document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '')
  }, [])

  const [state, dispatch] = useReducer((s: PlaybackState, e: PlaybackEvent & { count: number }) => step(s, e, e.count), IDLE)
  const segments = useMemo(() => buildSegments(plan), [plan])
  const segment = state.status === 'playing' ? segments[state.index] : undefined
  const playing = state.status === 'playing'

  const statuses = useMemo(() => wordStatuses(plan, segments, state, wordOffset), [plan, segments, state, wordOffset])
  const coverage = useMemo(() => coverageLine(plan), [plan])
  const currentWord = statuses.findIndex((s) => s === 'current')
  const signedSoFar = statuses.filter((s) => s === 'done').length

  const sawSigning = useRef(false)
  const segmentRef = useRef(segment)
  segmentRef.current = segment
  const send = useCallback((type: PlaybackEvent['type']) => dispatch({ type, count: segments.length } as PlaybackEvent & { count: number }), [segments.length])

  const onAvatarState = useCallback(
    (next: 'loading' | 'ready' | 'signing') => {
      if (segmentRef.current?.type !== 'avatar' && segmentRef.current?.type !== 'pose') return
      if (next === 'signing') sawSigning.current = true
      else if (next === 'ready' && sawSigning.current) {
        sawSigning.current = false
        send('finished')
      }
    },
    [send],
  )

  const onWordProgress = useCallback((index: number) => {
    const current = segmentRef.current
    if (current?.type === 'avatar') setWordOffset(itemAtToken(current.items, index))
    else if (current?.type === 'pose') setWordOffset(index)
  }, [])

  // Start playing as soon as a new plan has arrived.
  useEffect(() => {
    if (!autoStart || segments.length === 0) return
    setAutoStart(false)
    setStopId((n) => n + 1)
    send('start')
  }, [autoStart, segments, send])

  // Drive each segment; the effect re-runs only when the segment index changes.
  useEffect(() => {
    if (!playing || !segment) return
    setWordOffset(0)
    setVideoFormat(hevcPlayable ? 'original' : 'h264')
    let timer: ReturnType<typeof setTimeout>
    if (segment.type === 'avatar') {
      sawSigning.current = false
      setAvatarPhrase(segment.phrase)
      setRequestId((n) => n + 1)
      timer = setTimeout(() => send('failed'), AVATAR_WATCHDOG_MS)
    } else if (segment.type === 'pose') {
      const clips = segment.items.flatMap((i) => poseClips.current.get(i.assetId) ?? [])
      sawSigning.current = false
      setPoseRun((run) => ({ runId: (run?.runId ?? 0) + 1, clips }))
      timer = setTimeout(() => send('failed'), Math.max(AVATAR_WATCHDOG_MS, runDuration(clips) * 2000 + 5000))
    } else if (segment.type === 'video') {
      timer = setTimeout(() => send('failed'), VIDEO_WATCHDOG_MS)
    } else {
      timer = setTimeout(() => send('skip'), UNRESOLVED_HOLD_MS)
    }
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, state.index])

  // Warm the sign-plan route and its dictionary data now, so the first Sign does not wait for them.
  useEffect(() => {
    void fetch('/api/sign-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokens: [] }) }).catch(() => undefined)
  }, [])

  useEffect(() => {
    let live = true
    fetch('/api/phase1/status')
      .then((r) => r.json())
      .then((s) => live && setPhase1(s))
      .catch(() => live && setPhase1({ available: false, reason: 'Phase 1 did not answer.' }))
    return () => {
      live = false
    }
  }, [])

  // Follow a video job until its transcript is ready or it fails.
  useEffect(() => {
    if (!jobId) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await fetch(`/api/phase1/youtube?job_id=${encodeURIComponent(jobId)}`)
        const body = (await res.json()) as JobStatus & { error?: JobStatus['error'] | string }
        if (!live) return
        if (!res.ok) {
          setError(typeof body.error === 'string' ? body.error : 'Could not read the video job.')
          return
        }
        setJob(body as JobStatus)
        if (body.running) timer = setTimeout(poll, JOB_POLL_MS)
      } catch {
        if (live) setError('Lost contact with Phase 1 while reading the video.')
      }
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [jobId])

  async function startVideo() {
    setError('')
    setJob(null)
    setJobId('')
    try {
      const res = await fetch('/api/phase1/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: videoUrl }) })
      const body = (await res.json()) as { job_id?: string; error?: string }
      if (!res.ok || !body.job_id) throw new Error(body.error || `Request failed (${res.status})`)
      setJobId(body.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the video.')
    }
  }

  /** English (typed, or a finished video job) -> Phase 1 gloss -> the same sign flow as typed gloss. The offline engine stands in if Phase 1 is down. */
  async function translateAndSign(source: { text: string } | { jobId: string }) {
    setError('')
    setStopId((n) => n + 1)
    dispatch({ type: 'reset', count: 0 })
    setLoading(true)
    let lines: GlossLine[] = []
    try {
      const res = await fetch('/api/phase1/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('jobId' in source ? { job_id: source.jobId, max_sentences: 20 } : { text: source.text }),
      })
      const body = (await res.json()) as Partial<Phase1Result> & { error?: string; fallback?: boolean }
      if (res.ok && body.sentences) {
        lines = body.sentences.map((s) => ({ ...s }))
      } else if (body.fallback && 'text' in source) {
        // Phase 1 is not running: the old rule engine keeps the page usable.
        const offline = translateOffline(source.text)
        lines = [{ id: 'offline', source: source.text, tokens: offline.tokens, engine: 'offline', needsReview: true, notes: ['Phase 1 is not running; used the offline rules'] }]
      } else {
        throw new Error(body.error || `Request failed (${res.status})`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setLoading(false)
      return
    }
    setGlossLines(lines)
    const tokens = lines.flatMap((l) => l.tokens)
    setText(tokens.join(' '))
    if (tokens.length === 0) {
      setError('Phase 1 produced no gloss for this input.')
      setLoading(false)
      return
    }
    await signTokens(tokens)
  }

  function sign() {
    return signTokens(parseGlossInput(text).flatMap((s) => s.tokens))
  }

  async function signTokens(tokens: string[]) {
    setError('')
    if (tokens.length === 0) return
    setStopId((n) => n + 1)
    dispatch({ type: 'reset', count: 0 })
    setLoading(true)
    try {
      const res = await fetch('/api/sign-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokens, synonyms: new URLSearchParams(window.location.search).get('synonyms') ?? undefined }) })
      const body = (await res.json()) as PlanResponse & { error?: string }
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
      // Fetch the avatar tracks first; a sign whose track is unusable goes back to its recorded video.
      const loaded = await loadPoseClips(body.plan)
      poseClips.current = loaded.clips
      setPlan(loaded.plan)
      setAutoStart(true)
      if (!hevcPlayable) {
        // Start the one-off H.264 conversion of the dictionary clips now so playback does not stall on it.
        const ids = [...new Set(loaded.plan.flatMap((p) => (p.kind === 'islrtc_video' ? [p.assetId] : [])))]
        void (async () => {
          for (const id of ids) await fetch(`/api/islrtc/${encodeURIComponent(id)}?format=h264`, { headers: { Range: 'bytes=0-0' } }).catch(() => undefined)
        })()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  function stop() {
    setStopId((n) => n + 1)
    dispatch({ type: 'reset', count: 0 })
  }

  return (
    <main className="demo-page">
      <div className="demo-modes" role="tablist" aria-label="Input">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`demo-mode${mode === m ? ' is-on' : ''}`} onClick={() => setMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
        {mode !== 'gloss' && phase1 && (
          <span className={`demo-phase1${phase1.available ? ' is-up' : ''}`} title={phase1.reason}>
            {phase1.available ? (phase1.llmKeyPresent ? 'Phase 1 connected' : 'Phase 1 connected · no LLM key (spaCy only)') : 'Phase 1 not running · offline rules'}
          </span>
        )}
      </div>

      {mode === 'english' && (
        <>
          <textarea
            className="demo-input"
            value={english}
            onChange={(e) => setEnglish(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!playing && !loading && english.trim()) void translateAndSign({ text: english })
              }
            }}
            placeholder="Type English, e.g. I did not go to school yesterday."
            rows={3}
            aria-label="English text"
          />
          <button type="button" className="demo-button" onClick={playing ? stop : () => void translateAndSign({ text: english })} disabled={loading || (!playing && !english.trim())}>
            {loading ? '…' : playing ? 'Stop' : 'Translate & sign'}
          </button>
        </>
      )}

      {mode === 'video' && (
        <>
          <div className="demo-video-input">
            <input
              className="demo-input demo-url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="Paste a public video link (https://…)"
              aria-label="Video link"
              spellCheck={false}
            />
            <button type="button" className="demo-secondary" onClick={() => void startVideo()} disabled={!videoUrl.trim() || Boolean(job?.running)}>
              Read the video
            </button>
            {job && (
              <ol className="demo-steps">
                {(job.steps ?? []).map((s) => (
                  <li key={s.key} className={`is-${s.state}`}>{s.label}</li>
                ))}
                {job.running && job.progress?.[0] && <li className="is-running">{job.progress[0]}</li>}
                {job.error?.message && <li className="is-failed">{job.error.message}{job.error.hint ? ` — ${job.error.hint}` : ''}</li>}
                {job.ready && <li className="is-done">Transcript ready ({job.transcript?.total_segments ?? '?'} segments). The first 20 sentences are signed.</li>}
              </ol>
            )}
          </div>
          <button type="button" className="demo-button" onClick={playing ? stop : () => void translateAndSign({ jobId })} disabled={loading || (!playing && !job?.ready)}>
            {loading ? '…' : playing ? 'Stop' : 'Translate & sign'}
          </button>
        </>
      )}

      {mode === 'gloss' && (
        <>
          <textarea
            className="demo-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!playing && !loading) void sign()
              }
            }}
            placeholder="Type ISL gloss words, e.g. HELLO STUDENT TODAY WORLD PROFESSOR"
            rows={3}
            aria-label="ISL gloss"
            spellCheck={false}
          />
          <button type="button" className="demo-button" onClick={playing ? stop : sign} disabled={loading || (!playing && !text.trim())}>
            {loading ? '…' : playing ? 'Stop' : 'Sign'}
          </button>
        </>
      )}
      {error && <p className="demo-error" role="alert">{error}</p>}

      {mode !== 'gloss' && glossLines.length > 0 && (
        <ol className="demo-lines" aria-label="Gloss from Phase 1">
          {glossLines.map((l) => (
            <li key={l.id} className={l.needsReview ? 'needs-review' : undefined} title={l.notes.join('\n') || undefined}>
              <span className="demo-line-en">{l.source}</span>
              <span className="demo-line-gloss">
                {l.tokens.join(' ') || '—'}
                {l.reordered && l.originalTokens && <em className="demo-line-was">Phase 1 wrote: {l.originalTokens.join(' ')}</em>}
              </span>
              <small>{ENGINE_LABEL[l.engine]}{l.reordered ? ' · reordered' : ''}{l.needsReview ? ' · review' : ''}</small>
            </li>
          ))}
        </ol>
      )}

      <div className="demo-output">
        {plan.length > 0 && (
          <div className="demo-gloss">
            <ol className="demo-words" aria-label="Gloss words">
              {plan.map((item, i) => (
                <li
                  key={`${i}-${item.gloss}`}
                  className={`demo-word is-${statuses[i]}${item.kind === 'unresolved' ? ' is-missing' : ''}`}
                  aria-current={statuses[i] === 'current' ? 'true' : undefined}
                  title={SOURCE_TITLE[item.kind]}
                >
                  <span>{statuses[i] === 'done' ? '✓ ' : ''}{item.gloss.replace(/_/g, ' ')}</span>
                  <small>{SOURCE_LABEL[item.kind]}</small>
                </li>
              ))}
            </ol>
            <p className="demo-coverage">
              <span className="demo-covered">{coverage.covered} covered</span>
              <span className={coverage.missing.length ? 'demo-notcovered' : ''}>{coverage.missing.length} not covered</span>
              <span>signed so far {signedSoFar} of {coverage.words}</span>
              <span>
                {[
                  coverage.by.yap_animation && `${coverage.by.yap_animation} hand-made`,
                  coverage.by.islrtc_pose && `${coverage.by.islrtc_pose} avatar motion`,
                  coverage.by.islrtc_video && `${coverage.by.islrtc_video} video`,
                  coverage.by.fingerspelling && `${coverage.by.fingerspelling} spelled`,
                ].filter(Boolean).join(' · ')}
              </span>
              {coverage.missing.length > 0 && <span className="demo-notcovered">no sign for: {coverage.missing.join(', ')}</span>}
            </p>
          </div>
        )}
        <div className="demo-stage" aria-live="polite">
          <div className="demo-avatar" style={{ visibility: segment?.type === 'video' ? 'hidden' : 'visible' }}>
            <AvatarPlayer phrase={avatarPhrase} requestId={requestId} stopId={stopId} poseRun={poseRun} model="human" speed={PLAYBACK_SPEED} onWordProgress={onWordProgress} onStateChange={onAvatarState} />
          </div>
          {segment?.type === 'video' && (
            <video
              className="demo-video"
              key={`${segment.item.assetId}-${videoFormat}`}
              src={`/api/islrtc/${encodeURIComponent(segment.item.assetId)}${videoFormat === 'h264' ? '?format=h264' : ''}`}
              autoPlay
              muted
              playsInline
              ref={(el) => {
                if (el) el.playbackRate = PLAYBACK_SPEED
              }}
              onEnded={() => send('finished')}
              onError={() => (videoFormat === 'original' ? setVideoFormat('h264') : send('failed'))}
            />
          )}
          {segment && <span className="demo-tag">{tagFor(segment)}</span>}
          {playing && currentWord >= 0 && <span className="demo-caption">{plan[currentWord].gloss.replace(/_/g, ' ')}</span>}
        </div>
      </div>
    </main>
  )
}
