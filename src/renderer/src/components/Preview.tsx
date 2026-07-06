import { useEffect, useRef, useState } from 'react'
import type { Clip, MediaItem, Project } from '@shared/model'
import { projectDuration } from '@shared/model'
import { mediaUrl } from '../api'
import { clamp, fadeGainAt, formatTime, transitionAlphas } from '../lib'
import { Compositor } from '../gl/compositor'
import { renderFrame, type SourceProvider } from '../gl/render'
import { useEditor } from '../store'

function audioClips(project: Project): { clip: Clip; media?: MediaItem }[] {
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const out: { clip: Clip; media?: MediaItem }[] = []
  for (const track of project.tracks) {
    if (track.kind === 'audio' && !track.muted) {
      for (const c of track.clips) out.push({ clip: c, media: c.mediaId ? byId.get(c.mediaId) : undefined })
    }
  }
  return out
}

function videoClips(project: Project): { clip: Clip; media: MediaItem }[] {
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const out: { clip: Clip; media: MediaItem }[] = []
  for (const track of project.tracks) {
    if ((track.kind === 'video' || track.kind === 'overlay') && !track.muted) {
      for (const c of track.clips) {
        if (c.kind !== 'video' || !c.mediaId) continue
        const media = byId.get(c.mediaId)
        if (media) out.push({ clip: c, media })
      }
    }
  }
  return out
}

export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoEls = useRef(new Map<string, HTMLVideoElement>())
  const audioEls = useRef(new Map<string, HTMLAudioElement>())
  const imageEls = useRef(new Map<string, HTMLImageElement>())
  const [glError, setGlError] = useState<string | null>(null)

  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let comp: Compositor
    try {
      comp = new Compositor(canvas)
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e))
      return
    }

    let raf = 0
    let lastNow = performance.now()
    const videos = videoEls.current
    const audios = audioEls.current
    const images = imageEls.current

    // bg-removed clips play the alpha-matte webm instead of the source
    const useMatte = (media: MediaItem, clip?: Clip): boolean =>
      !!(clip?.bgRemoved && media.mattePath)

    const getVideoEl = (media: MediaItem, clip?: Clip): HTMLVideoElement => {
      const matte = useMatte(media, clip)
      const key = (matte ? 'matte:' : '') + media.id
      const src = mediaUrl(matte ? media.mattePath! : media.proxyPath || media.path)
      let el = videos.get(key)
      if (el && el.dataset.src !== src) {
        el.pause()
        el.removeAttribute('src')
        el.load()
        videos.delete(key)
        el = undefined
      }
      if (!el) {
        el = document.createElement('video')
        el.dataset.src = src
        el.src = src
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        videos.set(key, el)
      }
      return el
    }

    const getAudioEl = (media: MediaItem): HTMLAudioElement => {
      let el = audios.get(media.id)
      if (!el) {
        el = new Audio(mediaUrl(media.path))
        el.preload = 'auto'
        audios.set(media.id, el)
      }
      return el
    }

    const sources: SourceProvider = {
      getVideo(media, clip) {
        const el = getVideoEl(media, clip)
        if (el.readyState < 2) return null
        return { source: el, w: el.videoWidth || media.width || 1, h: el.videoHeight || media.height || 1 }
      },
      getImage(media) {
        let el = images.get(media.id)
        if (!el) {
          el = new Image()
          el.src = mediaUrl(media.path)
          images.set(media.id, el)
        }
        if (!el.complete || el.naturalWidth === 0) return null
        return { source: el, w: el.naturalWidth, h: el.naturalHeight }
      }
    }

    const syncPlayable = (
      el: HTMLVideoElement | HTMLAudioElement,
      clip: Clip,
      t: number,
      isPlaying: boolean,
      gainMult: number
    ): void => {
      const speed = clip.speed || 1
      const target = clip.in + (t - clip.start) * speed
      el.volume = clamp((clip.muted ? 0 : clip.volume) * fadeGainAt(clip, t) * gainMult, 0, 1)
      el.playbackRate = clamp(speed, 0.0625, 16)
      if (isPlaying) {
        if (el.paused) {
          el.currentTime = target
          void el.play().catch(() => {})
        } else if (Math.abs(el.currentTime - target) > 0.18 * Math.max(1, speed)) {
          el.currentTime = target
        }
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.04 && el.readyState >= 1) {
          el.currentTime = target
        }
      }
    }

    const tick = (): void => {
      const s = useEditor.getState()
      const now = performance.now()
      const dt = (now - lastNow) / 1000
      lastNow = now

      const dur = projectDuration(s.project)
      let t = s.playhead
      if (s.playing) {
        t = t + dt
        if (t >= dur) {
          t = dur
          s.setPlaying(false)
        }
        s.setPlayhead(t)
      }

      const transAlpha = transitionAlphas(s.project, t)
      const activePlayables = new Set<HTMLVideoElement | HTMLAudioElement>()

      for (const { clip, media } of videoClips(s.project)) {
        const isActive = t >= clip.start && t < clip.start + clip.duration
        if (!isActive) continue
        const el = getVideoEl(media, clip)
        syncPlayable(el, clip, t, s.playing, transAlpha.get(clip.id) ?? 1)
        activePlayables.add(el)
      }
      for (const { clip, media } of audioClips(s.project)) {
        if (!media) continue
        const isActive = t >= clip.start && t < clip.start + clip.duration
        if (!isActive) continue
        const el = getAudioEl(media)
        syncPlayable(el, clip, t, s.playing, 1)
        activePlayables.add(el)
      }
      for (const el of videos.values()) if (!activePlayables.has(el) && !el.paused) el.pause()
      for (const el of audios.values()) if (!activePlayables.has(el) && !el.paused) el.pause()

      renderFrame(comp, s.project, t, sources, s.project.width, s.project.height)
      comp.finishToCanvas()

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      for (const el of videos.values()) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
      for (const el of audios.values()) el.pause()
      videos.clear()
      audios.clear()
      images.clear()
      comp.dispose()
    }
  }, [])

  const dur = useEditor((s) => projectDuration(s.project))

  return (
    <div className="preview-panel">
      <div className="preview-stage">
        {glError ? (
          <div className="empty-hint">Preview unavailable — WebGL2 failed: {glError}</div>
        ) : (
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            style={{ aspectRatio: `${width} / ${height}` }}
          />
        )}
      </div>
      <div className="preview-controls">
        <button className="btn icon" title="Go to start" onClick={() => setPlayhead(0)}>
          ⏮
        </button>
        <button
          className="btn icon play"
          title="Play/Pause (Space)"
          onClick={() => setPlaying(!playing)}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <span className="timecode">
          {formatTime(playhead)} / {formatTime(dur)}
        </span>
      </div>
    </div>
  )
}
