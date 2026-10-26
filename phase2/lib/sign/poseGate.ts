/**
 * Quality gate for avatar tracks extracted from ISLRTC clips (data/pose, written by scripts/pose/batch_extract.py).
 *
 * A track is only used in place of the dictionary video when the extraction found the signer's hands and body for enough of the clip.
 * These are coverage checks, not proof that the avatar's hand shapes read correctly: a track that passes is still unreviewed.
 */

export const POSE_GATE = {
  /** Share of frames in which at least one hand was found. Hands are down for part of every clip, so this is not 100%. */
  minHandFrac: 0.3,
  /** Share of frames in which the shoulders were found (the signer was in view). */
  minBodyFrac: 0.9,
} as const

export type PoseGateConfig = { minHandFrac: number; minBodyFrac: number }
export type PoseGateReason = 'few_hands' | 'body_lost' | 'no_window'

export type PoseQualityRow = {
  id: string
  label: string
  mb: number
  frames: number
  fps: number
  handFrac: number
  poseFrac: number
  /** First and last source frame in which the full model ran (the signing window), or null when none. */
  window: [number, number] | null
}

export function evaluateGate(row: Pick<PoseQualityRow, 'handFrac' | 'poseFrac' | 'window'>, gate: PoseGateConfig = POSE_GATE): { ok: boolean; reasons: PoseGateReason[] } {
  const reasons: PoseGateReason[] = []
  if (row.handFrac < gate.minHandFrac) reasons.push('few_hands')
  if (row.poseFrac < gate.minBodyFrac) reasons.push('body_lost')
  if (!row.window) reasons.push('no_window')
  return { ok: reasons.length === 0, reasons }
}

/** What the resolver and player need to know about one usable track. */
export type PoseSummary = {
  handFrac: number
  poseFrac: number
  frames: number
  fps: number
  /** Signing window as source frame indices; the player trims the track to it. */
  window: [number, number]
}

export type PoseIndexEntry = { handFrac: number; poseFrac: number; frames: number; fps: number; window: [number, number] | null; ok: boolean; reasons: PoseGateReason[] }

export type PoseIndexFile = {
  schema_version: '1.0'
  generated_at: string
  gate: PoseGateConfig
  counts: { total: number; ok: number; rejected: number; byReason: Record<PoseGateReason, number> }
  assets: Record<string, PoseIndexEntry>
}

/** Minimal CSV reader for data/pose/quality.csv (no quoted commas: labels are written with the csv module, so a label with a comma is quoted). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some((x) => x !== '')) rows.push(row)
  }
  const [header, ...body] = rows
  if (!header) return []
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])))
}

/** Join quality.csv with the runner's progress log (window and fps) and apply the gate. */
export function buildPoseIndex(
  quality: Record<string, string>[],
  progress: { id: string; status?: string; fps?: number; window?: [number, number] | null }[],
  gate: PoseGateConfig = POSE_GATE,
  generatedAt = new Date().toISOString(),
): PoseIndexFile {
  const prog = new Map<string, (typeof progress)[number]>()
  for (const p of progress) if (p.status === 'ok') prog.set(p.id, p)

  const assets: Record<string, PoseIndexEntry> = {}
  const byReason: Record<PoseGateReason, number> = { few_hands: 0, body_lost: 0, no_window: 0 }
  let ok = 0
  for (const q of quality) {
    const p = prog.get(q.id)
    if (!q.id || !p) continue // a score without a finished clip is never offered
    const window = Array.isArray(p.window) && p.window.length === 2 ? ([Number(p.window[0]), Number(p.window[1])] as [number, number]) : null
    const entry = { handFrac: Number(q.hand_frac), poseFrac: Number(q.pose_frac), frames: Number(q.frames), fps: Number(p.fps) || 25, window }
    const verdict = evaluateGate(entry, gate)
    assets[q.id] = { ...entry, ok: verdict.ok, reasons: verdict.reasons }
    if (verdict.ok) ok += 1
    for (const r of verdict.reasons) byReason[r] += 1
  }
  const total = Object.keys(assets).length
  return { schema_version: '1.0', generated_at: generatedAt, gate, counts: { total, ok, rejected: total - ok, byReason }, assets }
}
