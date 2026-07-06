// Pure EDL -> FFmpeg argument compiler. No Electron imports so it can be
// unit-tested headlessly with tsx (scripts/test-export.ts).

import type { Clip, MediaItem, Project } from '../shared/model'
import { isNeutralColor, projectDuration } from '../shared/model'

export interface CompiledExportSettings {
  outPath: string
  width: number
  height: number
  fps: number
  vBitrateK: number
  encoder: 'qsv' | 'x264'
}

/** Text clips are rasterized by the renderer at project resolution; the
 *  compiler receives them as transparent PNG files. */
export interface TextPngFile {
  clipId: string
  pngPath: string
}

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString()
const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2))

/** atempo only accepts 0.5..100 per instance; chain for slower speeds. */
function atempoChain(speed: number): string[] {
  if (speed === 1) return []
  const parts: string[] = []
  let s = speed
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s *= 2
  }
  parts.push(`atempo=${f(s)}`)
  return parts
}

/** eq/colortemperature filters approximating the preview's canvas color pipeline. */
function colorFilters(clip: Clip): string[] {
  const c = clip.color
  if (!c || isNeutralColor(c)) return []
  const parts: string[] = []
  const eq: string[] = []
  if (c.contrast !== 0) eq.push(`contrast=${f(1 + c.contrast)}`)
  if (c.saturation !== 0) eq.push(`saturation=${f(Math.max(0, 1 + c.saturation))}`)
  if (c.exposure !== 0) eq.push(`brightness=${f(c.exposure * 0.25)}`)
  if (eq.length > 0) parts.push('eq=' + eq.join(':'))
  if (c.temperature !== 0) {
    // warm = lower kelvin; clamp inside colortemperature's 1000..40000 range
    parts.push(`colortemperature=temperature=${Math.round(6500 - c.temperature * 2600)}`)
  }
  return parts
}

interface FadeSpec {
  st: number // seconds; timeline time for video, clip-local for audio
  d: number
}

interface TransFades {
  vin?: FadeSpec
  vout?: FadeSpec
  ain?: FadeSpec
  aout?: FadeSpec
}

/**
 * Per-clip alpha/audio fades produced by main-track transitions. The overlap
 * is read from the baked clip geometry (packedMain already pulled the next
 * clip back by the transition duration).
 */
function collectTransitionFades(project: Project): Map<string, TransFades> {
  const map = new Map<string, TransFades>()
  const get = (id: string): TransFades => {
    let v = map.get(id)
    if (!v) {
      v = {}
      map.set(id, v)
    }
    return v
  }
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue
    const clips = [...track.clips].sort((x, y) => x.start - y.start)
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i]
      const b = clips[i + 1]
      const overlap = a.start + a.duration - b.start
      if (overlap <= 0.001) continue
      const type = a.transitionAfter?.type ?? 'cross'
      if (type === 'cross') {
        get(b.id).vin = { st: b.start, d: overlap }
      } else {
        get(a.id).vout = { st: b.start, d: overlap / 2 }
        get(b.id).vin = { st: b.start + overlap / 2, d: overlap / 2 }
      }
      // audio always crossfades over the full overlap
      get(a.id).aout = { st: a.duration - overlap, d: overlap }
      get(b.id).ain = { st: 0, d: overlap }
    }
  }
  return map
}

/** afade chain for user fades + transition fades (clip-local timeline seconds). */
function audioFades(clip: Clip, trans?: TransFades): string[] {
  const parts: string[] = []
  const fi = Math.max(clip.fadeIn ?? 0, 0)
  const fo = Math.max(clip.fadeOut ?? 0, 0)
  if (fi > 0) parts.push(`afade=t=in:st=0:d=${f(fi)}`)
  if (fo > 0) parts.push(`afade=t=out:st=${f(Math.max(0, clip.duration - fo))}:d=${f(fo)}`)
  if (trans?.ain) parts.push(`afade=t=in:st=${f(trans.ain.st)}:d=${f(trans.ain.d)}`)
  if (trans?.aout) parts.push(`afade=t=out:st=${f(trans.aout.st)}:d=${f(trans.aout.d)}`)
  return parts
}

/** One clip's full audio chain: trim -> retime -> fades -> gain -> position. */
function appendAudioChain(
  filters: string[],
  audioLabels: string[],
  idx: number,
  clip: Clip,
  trans: TransFades | undefined
): void {
  const speed = clip.speed || 1
  const aLabel = `a${audioLabels.length}`
  const delayMs = Math.max(0, Math.round(clip.start * 1000))
  const parts = [
    `atrim=start=${f(clip.in)}:end=${f(clip.in + clip.duration * speed)}`,
    'asetpts=PTS-STARTPTS',
    ...atempoChain(speed),
    ...audioFades(clip, trans),
    `volume=${f(clip.volume)}`,
    'aresample=48000',
    `adelay=${delayMs}:all=1`
  ]
  filters.push(`[${idx}:a]${parts.join(',')}[${aLabel}]`)
  audioLabels.push(aLabel)
}

interface FitRect {
  w: number
  h: number
  x: number
  y: number
}

/** "Contain" fit of a source into the output frame, then apply clip transform. */
function fitRect(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  clip: Clip
): FitRect {
  const t = clip.transform
  const base = Math.min(outW / srcW, outH / srcH)
  const w = even(srcW * base * t.scale)
  const h = even(srcH * base * t.scale)
  const x = Math.round((outW - w) / 2 + t.x * outW)
  const y = Math.round((outH - h) / 2 + t.y * outH)
  return { w, h, x, y }
}

export function buildExportArgs(
  project: Project,
  settings: CompiledExportSettings,
  textPngs: TextPngFile[]
): string[] {
  const W = settings.width
  const H = settings.height
  const dur = Math.max(projectDuration(project), 0.1)
  const mediaById = new Map<string, MediaItem>(project.media.map((m) => [m.id, m]))
  const pngByClip = new Map<string, string>(textPngs.map((t) => [t.clipId, t.pngPath]))

  const inputArgs: string[] = []
  let inputCount = 0
  const filters: string[] = []
  const audioLabels: string[] = []

  // ---- collect clips in paint order: main video track -> overlays -> text ----
  const visualClips: Clip[] = []
  for (const track of project.tracks) {
    if (track.kind === 'video' || track.kind === 'overlay') {
      visualClips.push(...[...track.clips].sort((a, b) => a.start - b.start))
    }
  }
  for (const track of project.tracks) {
    if (track.kind === 'text') {
      visualClips.push(...[...track.clips].sort((a, b) => a.start - b.start))
    }
  }
  const audioOnlyClips: Clip[] = []
  for (const track of project.tracks) {
    if (track.kind === 'audio' && !track.muted) {
      audioOnlyClips.push(...track.clips)
    }
  }

  // ---- base canvas ----
  filters.push(`color=c=black:s=${W}x${H}:r=${settings.fps}:d=${f(dur)}[bg]`)
  let lastVideo = 'bg'
  let overlayIdx = 0

  const addOverlay = (srcLabel: string, clip: Clip, rect: FitRect): void => {
    const en = `enable='between(t,${f(clip.start)},${f(clip.start + clip.duration)})'`
    const next = `ov${overlayIdx++}`
    filters.push(
      `[${lastVideo}][${srcLabel}]overlay=x=${rect.x}:y=${rect.y}:${en}[${next}]`
    )
    lastVideo = next
  }

  const transFades = collectTransitionFades(project)

  const alphaChain = (clip: Clip): string => {
    const parts: string[] = [...colorFilters(clip), 'format=rgba']
    if (clip.transform.rotation) {
      const rad = (clip.transform.rotation * Math.PI) / 180
      parts.push(`rotate=${f(rad)}:c=black@0:ow=rotw(${f(rad)}):oh=roth(${f(rad)})`)
    }
    if (clip.transform.opacity < 1) {
      parts.push(`colorchannelmixer=aa=${f(clip.transform.opacity)}`)
    }
    return parts.join(',')
  }

  /** transition alpha fades; PTS is timeline-based at this point in the chain */
  const transitionVideoFades = (clip: Clip): string[] => {
    const t = transFades.get(clip.id)
    const parts: string[] = []
    if (t?.vin) parts.push(`fade=t=in:st=${f(t.vin.st)}:d=${f(t.vin.d)}:alpha=1`)
    if (t?.vout) parts.push(`fade=t=out:st=${f(t.vout.st)}:d=${f(t.vout.d)}:alpha=1`)
    return parts
  }

  const audioChain = (idx: number, clip: Clip): void =>
    appendAudioChain(filters, audioLabels, idx, clip, transFades.get(clip.id))

  let vLabel = 0
  for (const clip of visualClips) {
    if (clip.kind === 'video') {
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
      if (!media) continue
      inputArgs.push('-i', media.path)
      const idx = inputCount++
      const speed = clip.speed || 1
      const rect = fitRect(media.width || W, media.height || H, W, H, clip)
      const label = `v${vLabel++}`
      const chain = [
        `trim=start=${f(clip.in)}:end=${f(clip.in + clip.duration * speed)}`,
        `setpts=(PTS-STARTPTS)/${f(speed)}+${f(clip.start)}/TB`,
        `scale=${rect.w}:${rect.h}`,
        alphaChain(clip),
        ...transitionVideoFades(clip)
      ]
      filters.push(`[${idx}:v]${chain.join(',')}[${label}]`)
      addOverlay(label, clip, rect)

      if (media.hasAudio && !clip.muted && clip.volume > 0) {
        audioChain(idx, clip)
      }
    } else if (clip.kind === 'image' || clip.kind === 'text') {
      const path =
        clip.kind === 'text'
          ? pngByClip.get(clip.id)
          : clip.mediaId
            ? mediaById.get(clip.mediaId)?.path
            : undefined
      if (!path) continue
      inputArgs.push('-loop', '1', '-t', f(clip.duration + 0.5), '-i', path)
      const idx = inputCount++
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
      // Text PNGs are rendered at exact output size and positioned within the
      // image itself, so they cover the full frame with no extra transform.
      const rect =
        clip.kind === 'text'
          ? { w: W, h: H, x: 0, y: 0 }
          : fitRect(media?.width || W, media?.height || H, W, H, clip)
      const label = `v${vLabel++}`
      const chain = [
        `scale=${rect.w}:${rect.h}`,
        clip.kind === 'text' ? 'format=rgba' : alphaChain(clip),
        `setpts=PTS-STARTPTS+${f(clip.start)}/TB`,
        ...transitionVideoFades(clip)
      ]
      filters.push(`[${idx}:v]${chain.join(',')}[${label}]`)
      addOverlay(label, clip, rect)
    }
  }

  for (const clip of audioOnlyClips) {
    const media = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
    if (!media || clip.muted || clip.volume <= 0) continue
    inputArgs.push('-i', media.path)
    audioChain(inputCount++, clip)
  }

  // ---- audio mix: silent base guarantees full duration ----
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f(dur)}[abase]`)
  if (audioLabels.length > 0) {
    filters.push(
      `[abase]${audioLabels.map((l) => `[${l}]`).join('')}` +
        `amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0[aout]`
    )
  } else {
    filters.push(`[abase]anull[aout]`)
  }

  filters.push(`[${lastVideo}]format=yuv420p[vout]`)

  const enc =
    settings.encoder === 'qsv'
      ? ['-c:v', 'h264_qsv', '-b:v', `${settings.vBitrateK}k`, '-maxrate', `${Math.round(settings.vBitrateK * 1.5)}k`]
      : ['-c:v', 'libx264', '-preset', 'fast', '-b:v', `${settings.vBitrateK}k`]

  return [
    '-y',
    '-hide_banner',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    ...enc,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-t', f(dur),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    settings.outPath
  ]
}

/**
 * FFmpeg invocation for the frame-pipe engine: video arrives as raw RGBA
 * frames on stdin (rendered by the GPU compositor), audio is mixed with the
 * same filtergraph logic as the fast path. GL readback is bottom-up, hence
 * the vflip.
 */
export function buildFramePipeArgs(
  project: Project,
  settings: CompiledExportSettings
): string[] {
  const dur = Math.max(projectDuration(project), 0.1)
  const mediaById = new Map<string, MediaItem>(project.media.map((m) => [m.id, m]))
  const transFades = collectTransitionFades(project)
  const inputArgs: string[] = []
  const filters: string[] = []
  const audioLabels: string[] = []
  let inputCount = 1 // input 0 is the rawvideo pipe

  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'audio') continue
      if (clip.muted || clip.volume <= 0) continue
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : undefined
      if (!media || !media.hasAudio) continue
      inputArgs.push('-i', media.path)
      appendAudioChain(filters, audioLabels, inputCount++, clip, transFades.get(clip.id))
    }
  }

  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f(dur)}[abase]`)
  if (audioLabels.length > 0) {
    filters.push(
      `[abase]${audioLabels.map((l) => `[${l}]`).join('')}` +
        `amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0[aout]`
    )
  } else {
    filters.push(`[abase]anull[aout]`)
  }
  filters.push(`[0:v]vflip,format=yuv420p[vout]`)

  const enc =
    settings.encoder === 'qsv'
      ? ['-c:v', 'h264_qsv', '-b:v', `${settings.vBitrateK}k`, '-maxrate', `${Math.round(settings.vBitrateK * 1.5)}k`]
      : ['-c:v', 'libx264', '-preset', 'fast', '-b:v', `${settings.vBitrateK}k`]

  return [
    '-y',
    '-hide_banner',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-video_size', `${settings.width}x${settings.height}`,
    '-framerate', String(settings.fps),
    '-i', 'pipe:0',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    ...enc,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-t', f(dur),
    '-movflags', '+faststart',
    settings.outPath
  ]
}
