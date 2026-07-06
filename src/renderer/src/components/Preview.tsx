import { useEffect, useRef } from 'react'
import type { Clip, MediaItem, Project } from '@shared/model'
import { projectDuration } from '@shared/model'
import { mediaUrl } from '../api'
import {
  canvasFilterFor,
  clamp,
  drawTextClip,
  fadeGainAt,
  fitRect,
  formatTime,
  transitionAlphas
} from '../lib'
import { useEditor } from '../store'

/** Visual clips in paint order: main + overlay tracks, then text on top. */
function visualClips(project: Project): { clip: Clip; media?: MediaItem }[] {
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const out: { clip: Clip; media?: MediaItem }[] = []
  for (const track of project.tracks) {
    if ((track.kind === 'video' || track.kind === 'overlay') && !track.muted) {
      for (const c of track.clips) out.push({ clip: c, media: c.mediaId ? byId.get(c.mediaId) : undefined })
    }
  }
  for (const track of project.tracks) {
    if (track.kind === 'text' && !track.muted) for (const c of track.clips) out.push({ clip: c })
  }
  return out
}

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

export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoEls = useRef(new Map<string, HTMLVideoElement>())
  const audioEls = useRef(new Map<string, HTMLAudioElement>())
  const imageEls = useRef(new Map<string, HTMLImageElement>())

  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let lastNow = performance.now()
    const videos = videoEls.current
    const audios = audioEls.current
    const images = imageEls.current

    const getVideo = (media: MediaItem): HTMLVideoElement => {
      const src = mediaUrl(media.proxyPath || media.path)
      let el = videos.get(media.id)
      if (el && el.dataset.src !== src) {
        el.pause()
        el.removeAttribute('src')
        el.load()
        videos.delete(media.id)
        el = undefined
      }
      if (!el) {
        el = document.createElement('video')
        el.dataset.src = src
        el.src = src
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        videos.set(media.id, el)
      }
      return el
    }

    const getAudio = (media: MediaItem): HTMLAudioElement => {
      let el = audios.get(media.id)
      if (!el) {
        el = new Audio(mediaUrl(media.path))
        el.preload = 'auto'
        audios.set(media.id, el)
      }
      return el
    }

    const getImage = (media: MediaItem): HTMLImageElement => {
      let el = images.get(media.id)
      if (!el) {
        el = new Image()
        el.src = mediaUrl(media.path)
        images.set(media.id, el)
      }
      return el
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

      const W = s.project.width
      const H = s.project.height
      if (canvas.width !== W) canvas.width = W
      if (canvas.height !== H) canvas.height = H

      const activePlayables = new Set<HTMLVideoElement | HTMLAudioElement>()
      const visuals = visualClips(s.project)
      const transAlpha = transitionAlphas(s.project, t)

      // sync playable elements
      for (const { clip, media } of visuals) {
        if (clip.kind !== 'video' || !media) continue
        const active = t >= clip.start && t < clip.start + clip.duration
        const el = getVideo(media)
        if (active) {
          syncPlayable(el, clip, t, s.playing, transAlpha.get(clip.id) ?? 1)
          activePlayables.add(el)
        }
      }
      for (const { clip, media } of audioClips(s.project)) {
        if (!media) continue
        const active = t >= clip.start && t < clip.start + clip.duration
        const el = getAudio(media)
        if (active) {
          syncPlayable(el, clip, t, s.playing, 1)
          activePlayables.add(el)
        }
      }
      for (const el of videos.values()) if (!activePlayables.has(el) && !el.paused) el.pause()
      for (const el of audios.values()) if (!activePlayables.has(el) && !el.paused) el.pause()

      // draw
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      for (const { clip, media } of visuals) {
        const active = t >= clip.start && t < clip.start + clip.duration
        if (!active) continue
        if (clip.kind === 'text') {
          drawTextClip(ctx, clip, W, H)
          continue
        }
        if (!media) continue
        let source: CanvasImageSource | null = null
        let srcW = media.width || W
        let srcH = media.height || H
        if (clip.kind === 'video') {
          const el = getVideo(media)
          if (el.readyState >= 2) {
            source = el
            srcW = el.videoWidth || srcW
            srcH = el.videoHeight || srcH
          }
        } else if (clip.kind === 'image') {
          const el = getImage(media)
          if (el.complete && el.naturalWidth > 0) {
            source = el
            srcW = el.naturalWidth
            srcH = el.naturalHeight
          }
        }
        if (!source) continue
        const alpha = clip.transform.opacity * (transAlpha.get(clip.id) ?? 1)
        if (alpha <= 0) continue
        const r = fitRect(srcW, srcH, W, H, clip)
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.translate(r.x + r.w / 2, r.y + r.h / 2)
        if (clip.transform.rotation) ctx.rotate((clip.transform.rotation * Math.PI) / 180)
        ctx.filter = canvasFilterFor(clip.color)
        ctx.drawImage(source, -r.w / 2, -r.h / 2, r.w, r.h)
        ctx.filter = 'none'
        // temperature approximated with a soft-light tint over the clip rect
        const temp = clip.color?.temperature ?? 0
        if (temp !== 0) {
          ctx.globalCompositeOperation = 'soft-light'
          ctx.globalAlpha = alpha * Math.min(0.85, Math.abs(temp))
          ctx.fillStyle = temp > 0 ? '#ff8a33' : '#3d8bff'
          ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h)
        }
        ctx.restore()
      }

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
    }
  }, [])

  const dur = useEditor((s) => projectDuration(s.project))

  return (
    <div className="preview-panel">
      <div className="preview-stage">
        <canvas
          ref={canvasRef}
          className="preview-canvas"
          style={{ aspectRatio: `${width} / ${height}` }}
        />
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
