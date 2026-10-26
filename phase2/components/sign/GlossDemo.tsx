'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AvatarPlayer } from '@/components/avatar/AvatarPlayer'
import { parseGlossInput } from '@/lib/sign/input'
import { loadPoseClips } from '@/lib/sign/poseClient'
import { runDuration, type PoseClip } from '@/lib/sign/poseTrack'
import { IDLE, buildSegments, step, type PlaybackEvent, type PlaybackState } from '@/lib/sign/playback'
import type { ResolvedSign } from '@/lib/sign/types'

// A segment that never reports completion must not freeze the sequence.
const AVATAR_WATCHDOG_MS = 90_000
const VIDEO_WATCHDOG_MS = 30_000
const UNRESOLVED_HOLD_MS = 500

type PlanResponse = { plan: ResolvedSign[] }

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

  const [avatarPhrase, setAvatarPhrase] = useState('')
  const [requestId, setRequestId] = useState(0)
  const [stopId, setStopId] = useState(0)
  // Avatar tracks fetched for the current plan, and the run handed to the avatar for the pose segment being played.
  const poseClips = useRef(new Map<string, PoseClip>())
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

  async function sign() {
    const tokens = parseGlossInput(text).flatMap((s) => s.tokens)
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
      {error && <p className="demo-error" role="alert">{error}</p>}

      <div className="demo-output" aria-live="polite">
        <div className="demo-avatar" style={{ visibility: segment?.type === 'video' ? 'hidden' : 'visible' }}>
          <AvatarPlayer phrase={avatarPhrase} requestId={requestId} stopId={stopId} poseRun={poseRun} onStateChange={onAvatarState} />
        </div>
        {segment?.type === 'video' && (
          <video
            className="demo-video"
            key={`${segment.item.assetId}-${videoFormat}`}
            src={`/api/islrtc/${encodeURIComponent(segment.item.assetId)}${videoFormat === 'h264' ? '?format=h264' : ''}`}
            autoPlay
            muted
            playsInline
            onEnded={() => send('finished')}
            onError={() => (videoFormat === 'original' ? setVideoFormat('h264') : send('failed'))}
          />
        )}
        {segment && <span className="demo-tag">{tagFor(segment)}</span>}
      </div>
    </main>
  )
}
