'use client'

/**
 * EXPERIMENT (not part of the product UI): plays a landmark-derived bone track on the Y Bot so it can be compared with the source clip.
 *   /lab/retarget?clip=<asset id>&frame=<n>      one still frame (used for screenshots)
 *   /lab/retarget?clip=<asset id>&play=1         real-time playback
 * Tracks are produced by ai-sign-language/run_islrtc_retarget.py into public/lab/<asset id>.bones.json (git-ignored derived data).
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

type Track = { frames: { t: number; bones: Record<string, number[]> }[] }

export default function RetargetLab() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const params = new URLSearchParams(window.location.search)
    const clip = params.get('clip') ?? ''
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clip)) {
      mount.textContent = 'invalid clip id'
      return
    }
    const frameIndex = Math.max(0, Number(params.get('frame') ?? 0) | 0)
    const play = params.get('play') === '1'

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#efede7')
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 1000)
    camera.position.set(0, 0.55, 3.1)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(720, 720, false)
    renderer.domElement.style.cssText = 'width:720px;height:720px;display:block'
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)
    scene.add(new THREE.HemisphereLight('#fff9ed', '#8f9e82', 2.4))
    const key = new THREE.DirectionalLight('#ffffff', 3.6)
    key.position.set(3, 5, 4)
    scene.add(key)

    let disposed = false
    let raf = 0
    const apply = (avatar: THREE.Object3D, track: Track, index: number) => {
      const frame = track.frames[Math.min(index, track.frames.length - 1)]
      for (const [name, q] of Object.entries(frame.bones)) {
        const bone = avatar.getObjectByName(name)
        if (bone) bone.quaternion.set(q[0], q[1], q[2], q[3])
      }
    }

    Promise.all([
      fetch(`/lab/${clip}.bones.json`).then((r) => (r.ok ? (r.json() as Promise<Track>) : Promise.reject(new Error(`track ${r.status}`)))),
      new Promise<THREE.Group>((resolve, reject) => new GLTFLoader().load('/models/ybot.glb', (g) => resolve(g.scene), undefined, reject)),
    ])
      .then(([track, avatar]) => {
        if (disposed) return
        avatar.position.y = -0.85
        avatar.traverse((c) => (c.frustumCulled = false))
        scene.add(avatar)
        document.title = `frames:${track.frames.length}`
        if (!play) {
          apply(avatar, track, frameIndex)
          renderer.render(scene, camera)
          document.body.setAttribute('data-ready', '1')
          return
        }
        const t0 = performance.now()
        const loop = () => {
          const t = (performance.now() - t0) / 1000
          const last = track.frames[track.frames.length - 1].t
          const tt = t % (last + 0.5)
          let i = track.frames.findIndex((f) => f.t >= tt)
          if (i < 0) i = track.frames.length - 1
          apply(avatar, track, i)
          renderer.render(scene, camera)
          raf = requestAnimationFrame(loop)
        }
        loop()
      })
      .catch((error) => {
        mount.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`
      })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      renderer.dispose()
      mount.replaceChildren()
    }
  }, [])

  return <div ref={mountRef} style={{ width: 720, height: 720 }} />
}
