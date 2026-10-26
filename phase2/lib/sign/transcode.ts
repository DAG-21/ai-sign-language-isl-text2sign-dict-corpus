import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readEnv } from './server'

/**
 * Optional on-demand H.264 copy of a single clip, for browsers that cannot play
 * HEVC. Originals are never modified and the dataset is never transcoded in
 * bulk: a clip is converted the first time it is requested, then reused.
 */

const inflight = new Map<string, Promise<string>>()

export function cachedPath(assetId: string): string {
  return path.join(readEnv().cacheDir, `${assetId}.h264.mp4`)
}

export function ensureH264(assetId: string, source: string): Promise<string> {
  const target = cachedPath(assetId)
  if (fs.existsSync(target)) return Promise.resolve(target)
  const running = inflight.get(assetId)
  if (running) return running

  const job = new Promise<string>((resolve, reject) => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const partial = `${target}.partial`
    // Arguments are passed as an array (no shell), so file names cannot inject options.
    const args = ['-nostdin', '-y', '-v', 'error', '-i', source, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-vf', "scale=-2:'min(720,ih)'", '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', partial]
    const child = spawn(/*turbopackIgnore: true*/ process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk).slice(0, 2000)))
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(partial, target)
        resolve(target)
      } else {
        fs.rmSync(partial, { force: true })
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
      }
    })
  }).finally(() => inflight.delete(assetId))

  inflight.set(assetId, job)
  return job
}
