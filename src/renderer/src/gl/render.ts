// EDL -> compositor layer walk, shared by the live preview and the
// frame-pipe exporter so both produce identical frames.

import type { Clip, MediaItem, Project } from '@shared/model'
import { evalTransform } from '@shared/model'
import { drawTextClip, fitRect, transitionAlphas } from '../lib'
import type { Compositor } from './compositor'

export interface SourceProvider {
  /** null = frame not decodable yet; layer is skipped */
  getVideo(media: MediaItem, clip: Clip): { source: TexImageSource; w: number; h: number } | null
  getImage(media: MediaItem): { source: TexImageSource; w: number; h: number } | null
}

// ---- text rasterization cache (canvas -> texture upload keyed by content) ----

interface TextRaster {
  key: string
  canvas: HTMLCanvasElement
}

const textCache = new Map<string, TextRaster>()

export function textRasterFor(clip: Clip, w: number, h: number): TextRaster {
  const key = JSON.stringify([clip.text, clip.textStyle, clip.transform, w, h])
  let entry = textCache.get(clip.id)
  if (!entry || entry.key !== key) {
    const canvas = entry?.canvas ?? document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, w, h)
      drawTextClip(ctx, clip, w, h)
    }
    entry = { key, canvas }
    textCache.set(clip.id, entry)
    if (textCache.size > 64) {
      const first = textCache.keys().next().value
      if (first !== undefined) textCache.delete(first)
    }
  }
  return entry
}

// ---- frame render ----

const active = (c: Clip, t: number): boolean => t >= c.start && t < c.start + c.duration

export function renderFrame(
  comp: Compositor,
  project: Project,
  t: number,
  sources: SourceProvider,
  outW: number,
  outH: number
): void {
  comp.setSize(outW, outH)
  comp.begin()
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const transAlpha = transitionAlphas(project, t)

  for (const track of project.tracks) {
    if ((track.kind !== 'video' && track.kind !== 'overlay') || track.muted) continue
    for (const clip of track.clips) {
      if (!active(clip, t)) continue
      const tf = evalTransform(clip, t - clip.start)
      const alpha = tf.opacity * (transAlpha.get(clip.id) ?? 1)
      if (alpha <= 0) continue

      if (clip.kind === 'adjust') {
        comp.applyAdjust(clip.color, alpha)
        continue
      }

      const media = clip.mediaId ? byId.get(clip.mediaId) : undefined
      if (!media) continue
      const src =
        clip.kind === 'video' ? sources.getVideo(media, clip) : sources.getImage(media)
      if (!src) continue
      comp.drawLayer({
        ownerId: (clip.bgRemoved && media.mattePath ? 'mm:' : 'm:') + media.id,
        source: src.source,
        dynamic: clip.kind === 'video',
        contentKey: clip.kind === 'video' ? undefined : 'static',
        rect: fitRect(src.w, src.h, outW, outH, { ...clip, transform: tf }),
        rotationDeg: tf.rotation,
        opacity: alpha,
        color: clip.color,
        chromaKey: clip.chromaKey,
        mask: clip.mask
      })
    }
  }

  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.muted) continue
    for (const clip of track.clips) {
      if (!active(clip, t) || !(clip.text || '').trim()) continue
      // rasterized at project resolution (transform + opacity baked in),
      // GL scales the full-frame quad to the output resolution
      const raster = textRasterFor(clip, project.width, project.height)
      comp.drawLayer({
        ownerId: 'text:' + clip.id,
        source: raster.canvas,
        dynamic: false,
        contentKey: raster.key,
        rect: { x: 0, y: 0, w: outW, h: outH },
        rotationDeg: 0,
        opacity: 1
      })
    }
  }
}
