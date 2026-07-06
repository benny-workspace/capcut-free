// Frame-pipe export driver: renders every frame through the GPU compositor
// at export resolution and streams raw RGBA to FFmpeg (main process) which
// encodes video from stdin and mixes audio from the source files.

import type { ExportResult, ExportSettings, MediaItem, Project } from '@shared/model'
import { projectDuration } from '@shared/model'
import { api, mediaUrl } from './api'
import { Compositor } from './gl/compositor'
import { renderFrame, type SourceProvider } from './gl/render'

const PLAYABLE_VCODECS = ['h264', 'vp8', 'vp9', 'av1']

export interface CancelToken {
  cancelled: boolean
}

function seekTo(el: HTMLVideoElement, time: number): Promise<void> {
  const max = isFinite(el.duration) && el.duration > 0 ? el.duration - 0.001 : time
  const target = Math.max(0, Math.min(time, max))
  if (el.readyState >= 2 && Math.abs(el.currentTime - target) < 0.006) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    let timer = 0
    const finish = (): void => {
      if (done) return
      done = true
      el.removeEventListener('seeked', finish)
      window.clearTimeout(timer)
      resolve()
    }
    timer = window.setTimeout(finish, 800) // decoder hiccup guard
    el.addEventListener('seeked', finish)
    try {
      el.currentTime = target
    } catch {
      finish()
    }
  })
}

function loadVideo(media: MediaItem, matte: boolean): Promise<HTMLVideoElement> {
  const el = document.createElement('video')
  el.muted = true
  el.preload = 'auto'
  // original file when Chromium can decode it; otherwise the preview proxy
  // (720p) — honest limitation until WebCodecs/ffmpeg-decode lands
  const usable = matte
    ? media.mattePath!
    : PLAYABLE_VCODECS.includes(media.vcodec || '') || !media.proxyPath
      ? media.path
      : media.proxyPath
  el.src = mediaUrl(usable)
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (!settled) {
        settled = true
        resolve(el)
      }
    }
    el.addEventListener('loadedmetadata', done, { once: true })
    el.addEventListener('error', done, { once: true })
    setTimeout(done, 5000)
  })
}

export async function runFramePipeExport(
  project: Project,
  settings: ExportSettings,
  onProgress: (ratio: number) => void,
  cancel: CancelToken
): Promise<ExportResult> {
  const dur = projectDuration(project)
  if (dur <= 0) return { ok: false, error: 'Timeline is empty' }
  const { width: W, height: H, fps } = settings
  const totalFrames = Math.max(1, Math.round(dur * fps))

  let comp: Compositor
  try {
    comp = new Compositor(new OffscreenCanvas(W, H))
  } catch (e) {
    return { ok: false, error: 'WebGL2 unavailable: ' + (e instanceof Error ? e.message : e) }
  }

  // dedicated seekable elements per (media, matte) pair used on visual tracks
  const videoEls = new Map<string, HTMLVideoElement>()
  const imageEls = new Map<string, HTMLImageElement>()
  const mediaById = new Map(project.media.map((m) => [m.id, m]))
  const keyFor = (clip: { bgRemoved?: boolean }, media: MediaItem): string =>
    (clip.bgRemoved && media.mattePath ? 'matte:' : '') + media.id
  const wanted = new Map<string, { media: MediaItem; matte: boolean }>()
  for (const track of project.tracks) {
    if (track.kind !== 'video' && track.kind !== 'overlay') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'video' || !clip.mediaId) continue
      const media = mediaById.get(clip.mediaId)
      if (!media) continue
      wanted.set(keyFor(clip, media), { media, matte: !!(clip.bgRemoved && media.mattePath) })
    }
  }
  await Promise.all(
    [...wanted.entries()].map(async ([key, w]) => {
      videoEls.set(key, await loadVideo(w.media, w.matte))
    })
  )

  const sources: SourceProvider = {
    getVideo(media, clip) {
      const el = videoEls.get(keyFor(clip, media))
      if (!el || el.readyState < 2) return null
      return { source: el, w: el.videoWidth || media.width || 1, h: el.videoHeight || media.height || 1 }
    },
    getImage(media) {
      let el = imageEls.get(media.id)
      if (!el) {
        el = new Image()
        el.src = mediaUrl(media.path)
        imageEls.set(media.id, el)
      }
      if (!el.complete || el.naturalWidth === 0) return null
      return { source: el, w: el.naturalWidth, h: el.naturalHeight }
    }
  }

  const cleanup = (): void => {
    for (const el of videoEls.values()) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    comp.dispose()
  }

  const start = await api.export2Start(project, settings)
  if (!start.ok) {
    cleanup()
    return { ok: false, error: start.error || 'could not start FFmpeg' }
  }

  const buf = new Uint8Array(W * H * 4)
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (cancel.cancelled) {
        await api.export2Cancel()
        cleanup()
        return { ok: false, error: 'Cancelled' }
      }
      const t = (i + 0.0001) / fps

      const seeks: Promise<void>[] = []
      for (const track of project.tracks) {
        if (track.kind !== 'video' && track.kind !== 'overlay') continue
        for (const clip of track.clips) {
          if (clip.kind !== 'video' || !clip.mediaId) continue
          if (t < clip.start || t >= clip.start + clip.duration) continue
          const media = mediaById.get(clip.mediaId)
          const el = media ? videoEls.get(keyFor(clip, media)) : undefined
          if (el) seeks.push(seekTo(el, clip.in + (t - clip.start) * (clip.speed || 1)))
        }
      }
      await Promise.all(seeks)

      renderFrame(comp, project, t, sources, W, H)
      comp.finishToPixels(buf)
      // structured clone copies the buffer at call time, so it can be reused
      const accepted = await api.export2Frame(buf.buffer as ArrayBuffer)
      if (!accepted) break // ffmpeg died; export2End surfaces its log

      if (i % 5 === 0) onProgress(i / totalFrames)
    }
  } finally {
    cleanup()
  }

  const result = await api.export2End()
  if (result.ok) {
    result.outPath = settings.outPath
    result.encoderUsed =
      (start.encoder === 'qsv' ? 'h264_qsv (Quick Sync' : 'libx264 (software') + ', frame pipe)'
  }
  onProgress(1)
  return result
}
