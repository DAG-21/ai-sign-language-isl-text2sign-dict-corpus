'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as words from './animations/words'
import * as alphabets from './animations/alphabets'
import { defaultPose } from './animations/defaultPose'
import { textToGloss } from './textToGloss'
import { looksPreTranslated } from '@/lib/islVocabulary'
import { ResolutionGovernor, easedStep, frameSeconds, keyPoseHoldMs } from '@/lib/sign/motion'
import { planRun, type Pose, type PoseClip, type RunPlan } from '@/lib/sign/poseTrack'

type SignInstruction = [string, 'rotation', 'x' | 'y' | 'z', number, '+' | '-']
type SignRuntime = {
  animations: SignInstruction[][]
  characters: string[]
  pending: boolean
  model?: 'default' | 'human'
  avatar?: THREE.Object3D
  /** Avatar tracks extracted from dictionary clips, while one is playing (see lib/sign/poseTrack.ts). */
  pose?: PoseRun
  /** For each token of the phrase being played, how many animation frames had been queued up to and including it. */
  wordEnds?: number[]
  /** Animation frames played so far in this phrase. */
  consumed?: number
}

type PoseRun = {
  plan: RunPlan
  start: number | null
  bones: [string, THREE.Object3D][]
}

type BoneUserData = {
  restQuaternion?: THREE.Quaternion
  gestureRestQuaternion?: THREE.Quaternion
  /** The bone's world rotation in the rig's rest pose. Y Bot's is the identity; another rig's bone axes may differ. */
  restWorldQuaternion?: THREE.Quaternion
  restPosition?: THREE.Vector3
  restScale?: THREE.Vector3
  delta?: { x: number; y: number; z: number }
}

type AvatarPlayerProps = {
  phrase: string
  requestId: number
  model?: 'default' | 'human'
  appendToQueue?: boolean
  stopId?: number
  resetId?: number
  speed?: number
  /**
   * Play avatar tracks extracted from dictionary clips (`islrtc_pose`) instead of a phrase. A new `runId` starts a new run; it reports
   * 'signing' when it starts and 'ready' when the last sign has eased back to the neutral pose.
   */
  poseRun?: { runId: number; clips: PoseClip[] } | null
  /**
   * Which word is being signed: for a phrase, the index of the token being played (the token count when the phrase is finished); for a run of
   * dictionary tracks, the index of the sign being played.
   */
  onWordProgress?: (index: number) => void
  onStateChange: (state: 'loading' | 'ready' | 'signing') => void
}

// Remy's rig is in Mixamo's larger units (3.8 m tall at the rig's 0.01 scale); this brings him to Y Bot's 1.78 m so both fill the same frame.
const HUMAN_SCALE = 0.47

const wordAnimations = words as unknown as Record<string, (runtime: SignRuntime) => void>
const alphabetAnimations = alphabets as unknown as Record<string, (runtime: SignRuntime) => void>

export function AvatarPlayer({ phrase, requestId, model = 'default', appendToQueue = false, stopId = 0, resetId = 0, speed = 1, poseRun = null, onWordProgress, onStateChange }: AvatarPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<SignRuntime>({ animations: [], characters: [], pending: true })
  const readyRef = useRef(false)
  const pendingPhraseRef = useRef<{ phrase: string; requestId: number } | null>(null)
  const pendingPoseRef = useRef<{ runId: number; clips: PoseClip[] } | null>(null)
  const appendToQueueRef = useRef(appendToQueue)
  const speedRef = useRef(speed)
  const wordProgressRef = useRef(onWordProgress)

  useEffect(() => {
    appendToQueueRef.current = appendToQueue
  }, [appendToQueue])

  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  useEffect(() => {
    wordProgressRef.current = onWordProgress
  }, [onWordProgress])

  useEffect(() => {
    if (!requestId) return
    const next = { phrase, requestId }
    if (!readyRef.current) {
      pendingPhraseRef.current = next
      onStateChange('loading')
      return
    }
    enqueuePhrase(next.phrase, runtimeRef.current, appendToQueue)
    onStateChange('signing')
  }, [phrase, requestId, onStateChange])

  useEffect(() => {
    if (!poseRun?.runId) return
    if (!readyRef.current) {
      pendingPoseRef.current = poseRun
      onStateChange('loading')
      return
    }
    startPoseRun(poseRun.clips, runtimeRef.current, model)
    onStateChange('signing')
    // A run starts only when a new one is handed in; `model` and the callback changing must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poseRun])

  useEffect(() => {
    if (!stopId) return
    pendingPhraseRef.current = null
    pendingPoseRef.current = null
    const runtime = runtimeRef.current
    if (runtime.pose) {
      runtime.pose = undefined
      resetAvatar(runtime, model)
    }
    runtime.animations = []
    onStateChange('ready')
  }, [stopId, onStateChange])

  useEffect(() => {
    if (!resetId || !readyRef.current) return
    pendingPhraseRef.current = null
    resetAvatar(runtimeRef.current, model)
    onStateChange('ready')
  }, [resetId, model, onStateChange])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const runtime = runtimeRef.current
    runtime.animations = []
    runtime.characters = []
    runtime.pending = true
    runtime.avatar = undefined
    runtime.pose = undefined
    runtime.model = model
    readyRef.current = false
    // Changing the avatar must not silently discard the phrase that is
    // already on screen. The old Human branch loaded correctly, but it did
    // not replay the current request after the new GLB finished loading.
    pendingPhraseRef.current = requestId ? { phrase, requestId } : null
    onStateChange('loading')
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#efede7')
    // Keep the avatar framed from head through the hips, including when the
    // canvas becomes wider on desktop. The old close-up was centered on the
    // chest, which cropped the lower body out of the stage.
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 1000)
    camera.position.set(0, 0.62, 3)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    // Smooth motion matters more than razor edges. Drawing at 2x on an integrated GPU (measured: Intel Iris Xe) dropped the frame rate to about 20 fps
    // with 170 ms stalls, so start at the screen's own density up to 1.5x and let the governor step down further if frames still run slow.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#fff9ed', '#8f9e82', 2.4))
    const keyLight = new THREE.DirectionalLight('#ffffff', 3.6)
    keyLight.position.set(3, 5, 4)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(1024, 1024)
    scene.add(keyLight)
    const rimLight = new THREE.PointLight('#ef714f', 15, 8)
    rimLight.position.set(-2.8, 2, 2)
    scene.add(rimLight)

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect()
      if (!width || !height) return
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(mount)
    resize()

    let disposed = false
    const loader = new GLTFLoader()
    // "Default" is the Y Bot mannequin, "Human" a real human character (Remy). Both use the Mixamo skeleton names and the same T-pose, but
    // not the same bone axes, so every rotation is converted into the rig's own axes (see localFromDelta).
    const modelPath = model === 'human' ? '/models/Remy.glb' : '/models/ybot.glb'
    loader.load(modelPath, (gltf) => {
      if (disposed) return
      const avatar = gltf.scene
      const anisotropy = renderer.capabilities.getMaxAnisotropy()
      avatar.traverse((child) => {
        child.castShadow = true
        child.frustumCulled = false
        // Sharper textures when the surface is seen at an angle (face, sleeves, hands).
        const material = (child as THREE.Mesh).material
        for (const m of Array.isArray(material) ? material : material ? [material] : []) {
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.anisotropy = anisotropy
        }
      })
      runtime.avatar = avatar
      // Preserve the requested close framing, while placing the face just
      // above the canvas centre instead of against the top edge.
      avatar.position.y = -0.85
      if (model === 'human') avatar.scale.setScalar(HUMAN_SCALE)
      scene.add(avatar)
      // Animation tables author each gesture as a delta rotation from rest.
      // YBot's rig ships in a pure identity T-pose, so composing the delta onto
      // each bone's captured rest quaternion reproduces the authored pose. Another
      // rig has the same T-pose but its own bone axes: the delta is carried over
      // through the bone's rest world rotation.
      captureRestQuaternions(avatar)
      // Apply the existing default-pose instructions immediately so every new
      // instance starts clean. Keeping those instructions in the frame queue
      // allowed a switch or reset to display an intermediate bone position.
      resetAvatar(runtime, model)
      readyRef.current = true
      const queuedPose = pendingPoseRef.current
      pendingPoseRef.current = null
      const queuedRequest = pendingPhraseRef.current
      if (queuedPose) {
        startPoseRun(queuedPose.clips, runtime, model)
        onStateChange('signing')
      } else if (queuedRequest) {
        pendingPhraseRef.current = null
        enqueuePhrase(queuedRequest.phrase, runtime, appendToQueueRef.current)
        onStateChange('signing')
      } else {
        onStateChange('ready')
      }
    }, undefined, () => onStateChange('ready'))

    let animationFrame = 0
    let nextFrameAt = 0
    let wasSigning = false
    let lastWord = -1
    let lastPoseWord = -1
    let lastFrameAt: number | null = null
    const governor = new ResolutionGovernor(renderer.getPixelRatio())
    const animate = (now: number) => {
      animationFrame = requestAnimationFrame(animate)
      const seconds = frameSeconds(now, lastFrameAt)
      // Slow frames lower the drawing resolution rather than slowing the signing (a background tab is not counted).
      if (lastFrameAt !== null && document.visibilityState === 'visible') {
        const ratio = governor.frame(now - lastFrameAt)
        if (ratio !== null) {
          renderer.setPixelRatio(ratio)
          resize()
        }
      }
      lastFrameAt = now
      const queue = runtime.animations
      const pose = runtime.pose
      if (runtime.avatar && pose) {
        if (pose.start === null) pose.start = now
        const trackSeconds = ((now - pose.start) / 1000) * speedRef.current
        const word = pose.plan.indexAt(trackSeconds)
        if (word !== lastPoseWord) {
          lastPoseWord = word
          wordProgressRef.current?.(word)
        }
        const frame = pose.plan.sample(trackSeconds)
        for (const [name, bone] of pose.bones) {
          const q = frame[name]
          if (q) bone.quaternion.copy(localFromDelta(bone.userData as BoneUserData, new THREE.Quaternion(q[0], q[1], q[2], q[3])))
        }
        if (trackSeconds >= pose.plan.duration) {
          runtime.pose = undefined
          lastPoseWord = -1
          onStateChange('ready')
        }
      } else if (runtime.avatar && queue.length && now >= nextFrameAt) {
        wasSigning = true
        const ends = runtime.wordEnds ?? []
        const current = ends.findIndex((end) => end > (runtime.consumed ?? 0))
        const word = current < 0 ? ends.length : current
        if (word !== lastWord) {
          lastWord = word
          wordProgressRef.current?.(word)
        }
        const frame = queue[0]
        for (let index = 0; index < frame.length;) {
          const [boneName, , axis, target, direction] = frame[index]
          const bone = getAvatarBone(runtime.avatar, boneName)
          if (!bone) {
            frame.splice(index, 1)
            continue
          }
          const userData = bone.userData as BoneUserData
          const delta = userData.delta ?? (userData.delta = { x: 0, y: 0, z: 0 })
          const [resolvedTarget, resolvedDirection] = resolveInstructionForModel(boneName, axis, target, direction, model)
          const value = delta[axis]
          // Step size drives how fast a bone eases toward its authored target.
          // Too small and long multi-stage signs (HELLO, SORRY, the meal
          // compounds) drag; too large and the shared raised-hand preparation
          // pose makes different signs look identical before their distinct
          // movement is visible. The pace (3 rad/s at speed 1, what 0.05 rad per frame
          // was at 60 fps) now follows elapsed time, so a slower display does not slow the signing,
          // and the last stretch of each move eases out (lib/sign/motion.ts).
          const inProgress = resolvedDirection === '+' ? value < resolvedTarget : value > resolvedTarget
          if (inProgress) {
            const step = easedStep(Math.abs(resolvedTarget - value), seconds, speedRef.current)
            delta[axis] = resolvedDirection === '+' ? Math.min(value + step, resolvedTarget) : Math.max(value - step, resolvedTarget)
            const deltaQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(delta.x, delta.y, delta.z))
            bone.quaternion.copy(localFromDelta(userData, deltaQuaternion))
            index += 1
          } else {
            frame.splice(index, 1)
          }
        }
        if (!frame.length) {
          queue.shift()
          runtime.consumed = (runtime.consumed ?? 0) + 1
          // Brief hold on each authored key pose so the movement still reads,
          // without the dead air that made every sign feel sluggish (was 360, then 170).
          nextFrameAt = now + keyPoseHoldMs(speedRef.current)
        }
      }
      if (wasSigning && !queue.length) {
        wasSigning = false
        wordProgressRef.current?.(runtime.wordEnds?.length ?? 0)
        lastWord = -1
        onStateChange('ready')
      }
      renderer.render(scene, camera)
    }
    animationFrame = requestAnimationFrame(animate)

    return () => {
      disposed = true
      readyRef.current = false
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      renderer.dispose()
      mount.replaceChildren()
    }
  }, [model, onStateChange])

  return <div ref={mountRef} className="avatar-canvas" aria-label="Animated Indian Sign Language avatar" />
}

function getAvatarBone(avatar: THREE.Object3D, boneName: string) {
  // Animation tables use compact Mixamo names. YBot stores
  // `mixamorig:RightArm`; the Ready Player Me human stores `RightArm`.
  // Resolve both forms (and armature-prefixed exporter variants) so the same
  // proven animation files work for both avatars.
  const compact = boneName.replace(/^mixamorig:?/, '')
  const candidates = [boneName, `mixamorig:${compact}`, compact]
  for (const candidate of candidates) {
    const bone = avatar.getObjectByName(candidate)
    if (bone) return bone
  }
  let resolved: THREE.Object3D | undefined
  avatar.traverse((child) => {
    if (resolved || child.type !== 'Bone') return
    const normalized = child.name.split('|').pop()?.replace(/^mixamorig:?/, '')
    if (normalized === compact) resolved = child
  })
  if (resolved) return resolved
  return undefined
}

const IDENTITY_EPSILON = 1e-4

function isIdentity(q: THREE.Quaternion) {
  return Math.abs(q.x) < IDENTITY_EPSILON && Math.abs(q.y) < IDENTITY_EPSILON && Math.abs(q.z) < IDENTITY_EPSILON
}

/**
 * Turn a rotation authored for Y Bot (a delta from its rest pose in world-aligned bone axes, or a track's local rotation, which is the same thing)
 * into the bone's local rotation on this rig, so the bone ends up turned the same way in the world. For Y Bot itself nothing changes.
 */
function localFromDelta(userData: BoneUserData, delta: THREE.Quaternion): THREE.Quaternion {
  const rest = userData.gestureRestQuaternion || userData.restQuaternion
  if (!rest) return delta.clone()
  const world = userData.restWorldQuaternion
  if (!world || isIdentity(world)) return rest.clone().multiply(delta)
  return rest.clone().multiply(world.clone().invert().multiply(delta).multiply(world))
}

/** The inverse of localFromDelta: this rig's local rotation as the Y Bot-space rotation a track would hold. */
function deltaFromLocal(userData: BoneUserData, local: THREE.Quaternion): THREE.Quaternion {
  const rest = userData.gestureRestQuaternion || userData.restQuaternion
  if (!rest) return local.clone()
  const world = userData.restWorldQuaternion
  const inner = rest.clone().invert().multiply(local)
  if (!world || isIdentity(world)) return inner
  return world.clone().multiply(inner).multiply(world.clone().invert())
}

function captureRestQuaternions(avatar: THREE.Object3D) {
  avatar.updateMatrixWorld(true)
  avatar.traverse((child) => {
    if (child.type !== 'Bone') return
    const userData = child.userData as BoneUserData
    userData.restWorldQuaternion = child.getWorldQuaternion(new THREE.Quaternion())
    userData.restQuaternion = child.quaternion.clone()
    userData.gestureRestQuaternion = userData.restQuaternion.clone()
    userData.restPosition = child.position.clone()
    userData.restScale = child.scale.clone()
  })
}

function resetAvatar(runtime: SignRuntime, model: 'default' | 'human') {
  const avatar = runtime.avatar
  if (!avatar) return

  runtime.animations = []
  runtime.characters = []
  avatar.traverse((child) => {
    if (child.type !== 'Bone') return
    const userData = child.userData as BoneUserData
    if (userData.gestureRestQuaternion) child.quaternion.copy(userData.gestureRestQuaternion)
    if (userData.restPosition) child.position.copy(userData.restPosition)
    if (userData.restScale) child.scale.copy(userData.restScale)
    userData.delta = { x: 0, y: 0, z: 0 }
  })

  // Every word table is authored from defaultPose(). Apply that same proven
  // starting pose to both rigs, then snap it before playback begins. The
  // human rig has the same bones without the `mixamorig:` prefix, which
  // getAvatarBone() resolves above.
  defaultPose(runtime)
  for (const frame of runtime.animations) {
    for (const [boneName, , axis, target, direction] of frame) {
      const bone = getAvatarBone(avatar, boneName)
      if (!bone) continue
      const userData = bone.userData as BoneUserData
      const delta = userData.delta ?? (userData.delta = { x: 0, y: 0, z: 0 })
      const [resolvedTarget] = resolveInstructionForModel(boneName, axis, target, direction, model)
      delta[axis] = resolvedTarget
      const deltaQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(delta.x, delta.y, delta.z))
      bone.quaternion.copy(localFromDelta(userData, deltaQuaternion))
    }
  }
  runtime.animations = []
  runtime.characters = []
}

/**
 * Start playing avatar tracks. The run fades in from wherever the avatar is now (the end of the previous animation, not a reset), so nothing
 * snaps, and fades out into the neutral pose that every phrase starts from. Only the bones the tracks drive (arms, hands, fingers, neck, head) are touched.
 */
function startPoseRun(clips: PoseClip[], runtime: SignRuntime, model: 'default' | 'human') {
  const avatar = runtime.avatar
  if (!avatar) return
  const names = new Set<string>()
  for (const clip of clips) {
    for (const index of [clip.start, clip.end]) for (const name of Object.keys(clip.track.frames[index].bones)) names.add(name)
  }
  const bones: [string, THREE.Object3D][] = []
  for (const name of names) {
    const bone = getAvatarBone(avatar, name)
    if (bone) bones.push([name, bone])
  }
  // Poses are held in Y Bot space (what the tracks use); localFromDelta / deltaFromLocal convert to and from this rig's own bone axes.
  const read = (): Pose =>
    Object.fromEntries(
      bones.map(([name, bone]) => {
        const q = deltaFromLocal(bone.userData as BoneUserData, bone.quaternion)
        return [name, [q.x, q.y, q.z, q.w]]
      }),
    ) as Pose
  const from = read()
  // Neutral pose: reset the rig, read it, then put the bones back where they were so nothing moves yet.
  resetAvatar(runtime, model)
  const to = read()
  for (const [name, bone] of bones) bone.quaternion.copy(localFromDelta(bone.userData as BoneUserData, new THREE.Quaternion(from[name][0], from[name][1], from[name][2], from[name][3])))
  runtime.pose = { plan: planRun(clips, from, to), start: null, bones }
}

function resolveInstructionForModel(
  _boneName: string,
  _axis: 'x' | 'y' | 'z',
  target: number,
  direction: '+' | '-',
  _model: 'default' | 'human',
): [number, '+' | '-'] {
  // Both avatars now run on the same ybot rig, so the authored YBot-coordinate
  // tables apply verbatim. The brunette rig's mirrored upper-arm/forearm axes
  // no longer exist; this hook stays as the single place to translate an
  // authored instruction if another rig is ever added.
  return [target, direction]
}

function enqueuePhrase(input: string, runtime: SignRuntime, append = false) {
  if (!append) {
    // Snap the rig back to the neutral pose first. A sign the user interrupted
    // mid-movement leaves bones partway through a gesture, and every sign is
    // authored as deltas from rest — without this the next sign starts from a
    // half-finished pose and can freeze on an unreachable target.
    if (runtime.avatar) resetAvatar(runtime, runtime.model ?? 'default')
    runtime.animations = []
    runtime.wordEnds = []
    runtime.consumed = 0
  }
  runtime.wordEnds ??= []

  // The page now resolves every phrase to canonical ISL gloss (Gemini online,
  // rule-based offline) before it reaches here. When the input is already made
  // of playable tokens, skip re-translation and play it verbatim — this keeps
  // the 3D player dumb and fast. Raw English still falls through to textToGloss
  // so direct callers and legacy paths keep working.
  const tokens = looksPreTranslated(input)
    ? input.trim().toUpperCase().split(/\s+/).filter(Boolean)
    : (textToGloss(input) as { tokens: string[] }).tokens

  const queueNames = tokens.map(token => {
    const word = token.toUpperCase()
    if (word in wordAnimations) {
      // Find the action ID in SUPPORTED_SIGNS if possible, fallback to clip_name
      return `clip_${word.toLowerCase().replace(' ', '')}`
    }
    return token
  })

  console.log(`Input:\n${input}`)
  console.log(`Detected:\n${tokens.join(' ΓåÆ ')}`)
  console.log(`Animation queue:\n${queueNames.join(' ΓåÆ ')}`)

  for (const token of tokens) {
    const word = token.toUpperCase()
    const wordAnimation = wordAnimations[word]
    if (wordAnimation) wordAnimation(runtime)
    else for (const letter of word) alphabetAnimations[letter]?.(runtime)
    runtime.wordEnds.push(runtime.animations.length + (runtime.consumed ?? 0))
  }
}
