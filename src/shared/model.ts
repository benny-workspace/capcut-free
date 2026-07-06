// LocalCut project model — the single EDL (edit decision list) that drives
// both the live preview and the export compiler.

export type MediaType = 'video' | 'audio' | 'image'

export interface MediaItem {
  id: string
  path: string
  /** 720p h264 proxy used for preview when the source codec can't play in Chromium */
  proxyPath?: string
  /** VP9+alpha webm produced by the background-removal tool */
  mattePath?: string
  name: string
  type: MediaType
  duration: number // seconds; images get a nominal duration
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  vcodec?: string
  acodec?: string
  thumbnail?: string // data URL (jpeg)
}

export interface Transform {
  /** normalized offset from frame center, -0.5..0.5 of frame size */
  x: number
  y: number
  scale: number
  rotation: number // degrees
  opacity: number // 0..1
}

export interface TextStyle {
  fontFamily: string
  fontSize: number // px at project resolution
  color: string
  bold: boolean
  italic: boolean
  outlineColor: string
  outlineWidth: number
  bgColor: string // '' = none
  align: 'left' | 'center' | 'right'
}

export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'adjust'

export interface ChromaKey {
  enabled: boolean
  color: string // hex key color
  similarity: number // 0.01..0.45, CbCr distance below which pixels are fully keyed
  smoothness: number // 0..0.4, feather band above similarity
  spill: number // 0..1, desaturation of key-color spill near the edge
}

export interface Mask {
  /** clip-local: coordinates are normalized to the clip's drawn rect */
  type: 'rect' | 'ellipse' | 'linear'
  cx: number // center x, 0..1
  cy: number // center y, 0..1
  w: number // 0..2 (rect/ellipse extent; linear ignores)
  h: number // 0..2
  feather: number // 0..0.5
  rotation: number // degrees
  invert: boolean
}

/** All values are -1..1, 0 = neutral. */
export interface ColorAdjust {
  exposure: number
  contrast: number
  saturation: number
  temperature: number // negative = cool/blue, positive = warm/orange
}

export type TransitionType = 'cross' | 'fadeblack'

export interface Transition {
  type: TransitionType
  duration: number // seconds of overlap with the next main-track clip
}

export interface WordStamp {
  t0: number // clip-local timeline seconds
  t1: number
  text: string
}

export type KfProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'

export interface Keyframe {
  t: number // clip-local timeline seconds
  v: number
}

export interface Clip {
  id: string
  kind: ClipKind
  mediaId?: string
  start: number // timeline position, seconds
  duration: number // timeline seconds (already divided by speed)
  in: number // source offset, seconds (media clips)
  volume: number // 0..2
  muted: boolean
  speed: number // playback rate; source seconds consumed = duration * speed
  transform: Transform
  keyframes?: Partial<Record<KfProp, Keyframe[]>>
  color?: ColorAdjust
  chromaKey?: ChromaKey
  mask?: Mask
  /** render via the media's alpha matte (AI background removal) */
  bgRemoved?: boolean
  fadeIn?: number // audio fade-in, seconds
  fadeOut?: number // audio fade-out, seconds
  /** main-track only: transition into the following clip */
  transitionAfter?: Transition
  text?: string
  textStyle?: TextStyle
  /** word-level timing behind auto captions (karaoke data) */
  words?: WordStamp[]
}

/** Transform at a clip-local time, honoring keyframes (linear interpolation). */
export function evalTransform(clip: Clip, tLocal: number): Transform {
  const kf = clip.keyframes
  if (!kf) return clip.transform
  const out: Transform = { ...clip.transform }
  for (const prop of ['x', 'y', 'scale', 'rotation', 'opacity'] as KfProp[]) {
    const list = kf[prop]
    if (!list || list.length === 0) continue
    if (tLocal <= list[0].t) {
      out[prop] = list[0].v
      continue
    }
    if (tLocal >= list[list.length - 1].t) {
      out[prop] = list[list.length - 1].v
      continue
    }
    for (let i = 0; i < list.length - 1; i++) {
      if (tLocal >= list[i].t && tLocal <= list[i + 1].t) {
        const span = list[i + 1].t - list[i].t
        const p = span > 0 ? (tLocal - list[i].t) / span : 0
        // smoothstep easing reads better than raw linear for motion
        const e = p * p * (3 - 2 * p)
        out[prop] = list[i].v + (list[i + 1].v - list[i].v) * e
        break
      }
    }
  }
  return out
}

export function hasKeyframes(clip: Clip): boolean {
  const kf = clip.keyframes
  if (!kf) return false
  for (const k of Object.values(kf)) if (k && k.length > 0) return true
  return false
}

export type TrackKind = 'video' | 'overlay' | 'text' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  clips: Clip[]
  muted?: boolean
}

export interface Project {
  id: string
  name: string
  width: number
  height: number
  fps: number
  tracks: Track[]
  media: MediaItem[]
  createdAt: string
  modifiedAt: string
}

export interface ExportSettings {
  outPath: string
  width: number
  height: number
  fps: number
  vBitrateK: number
  encoder: 'auto' | 'qsv' | 'x264'
}

export interface ExportProgress {
  ratio: number // 0..1
  phase: 'preparing' | 'encoding' | 'done' | 'error'
  message?: string
}

export interface ExportResult {
  ok: boolean
  encoderUsed?: string
  outPath?: string
  error?: string
}

export interface SysInfo {
  ffmpegFound: boolean
  qsv: boolean
  ffmpegVersion?: string
  /** whisper.cpp binary + model present (auto captions) */
  whisper: boolean
  /** MODNet model present (background removal) */
  modnet: boolean
}

export const defaultTransform = (): Transform => ({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 })

export const defaultColor = (): ColorAdjust => ({
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0
})

export const isNeutralColor = (c?: ColorAdjust): boolean =>
  !c || (c.exposure === 0 && c.contrast === 0 && c.saturation === 0 && c.temperature === 0)

/**
 * Effective overlap (seconds) of a main-track clip into its successor.
 * Clamped so a transition can never consume more than half of either clip.
 */
export function transitionOverlap(a: Clip, b: Clip | undefined): number {
  if (!a.transitionAfter || !b) return 0
  return Math.min(a.transitionAfter.duration, a.duration / 2, b.duration / 2)
}

export const defaultChromaKey = (): ChromaKey => ({
  enabled: true,
  color: '#00d000',
  similarity: 0.12,
  smoothness: 0.08,
  spill: 0.5
})

export const defaultMask = (type: Mask['type']): Mask => ({
  type,
  cx: 0.5,
  cy: 0.5,
  w: 0.7,
  h: 0.7,
  feather: 0.05,
  rotation: 0,
  invert: false
})

/**
 * True when the project uses effects the FFmpeg filtergraph engine can't
 * express; export then renders video through the GPU compositor frame pipe.
 */
export function needsFramePipe(project: Project): boolean {
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.kind === 'adjust') return true
      if (c.chromaKey?.enabled) return true
      if (c.mask) return true
      if (c.bgRemoved) return true
      if (hasKeyframes(c)) return true
    }
  }
  return false
}

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: 'Segoe UI',
  fontSize: 72,
  color: '#ffffff',
  bold: true,
  italic: false,
  outlineColor: '#000000',
  outlineWidth: 4,
  bgColor: '',
  align: 'center'
})

export function projectDuration(project: Project): number {
  let end = 0
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

export const MAIN_TRACK_ID = 'main'

export function newProject(name: string, width: number, height: number): Project {
  const now = new Date().toISOString()
  return {
    id: 'p' + Date.now().toString(36),
    name,
    width,
    height,
    fps: 30,
    media: [],
    tracks: [
      { id: MAIN_TRACK_ID, kind: 'video', name: 'Main', clips: [] },
      { id: 'overlay1', kind: 'overlay', name: 'Overlay', clips: [] },
      { id: 'text1', kind: 'text', name: 'Text', clips: [] },
      { id: 'audio1', kind: 'audio', name: 'Audio', clips: [] }
    ],
    createdAt: now,
    modifiedAt: now
  }
}
