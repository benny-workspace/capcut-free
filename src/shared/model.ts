// LocalCut project model — the single EDL (edit decision list) that drives
// both the live preview and the export compiler.

export type MediaType = 'video' | 'audio' | 'image'

export interface MediaItem {
  id: string
  path: string
  /** 720p h264 proxy used for preview when the source codec can't play in Chromium */
  proxyPath?: string
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

export type ClipKind = 'video' | 'audio' | 'image' | 'text'

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
  color?: ColorAdjust
  fadeIn?: number // audio fade-in, seconds
  fadeOut?: number // audio fade-out, seconds
  /** main-track only: transition into the following clip */
  transitionAfter?: Transition
  text?: string
  textStyle?: TextStyle
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
