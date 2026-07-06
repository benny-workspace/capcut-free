import type { Clip, ColorAdjust, Project, WordStamp } from '@shared/model'
import { defaultColor, defaultTextStyle, defaultTransform, transitionOverlap } from '@shared/model'

export interface FitRect {
  w: number
  h: number
  x: number
  y: number
}

/** Same math as the export compiler: "contain" fit + clip transform. */
export function fitRect(srcW: number, srcH: number, outW: number, outH: number, clip: Clip): FitRect {
  const t = clip.transform
  const base = Math.min(outW / srcW, outH / srcH)
  const w = srcW * base * t.scale
  const h = srcH * base * t.scale
  const x = (outW - w) / 2 + t.x * outW
  const y = (outH - h) / 2 + t.y * outH
  return { w, h, x, y }
}

export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  W: number,
  H: number
): void {
  const st = clip.textStyle
  if (!st) return
  const t = clip.transform
  const lines = (clip.text || '').split('\n')
  const size = Math.max(4, st.fontSize * t.scale)
  const lh = size * 1.25

  ctx.save()
  ctx.translate(W / 2 + t.x * W, H / 2 + t.y * H)
  ctx.rotate((t.rotation * Math.PI) / 180)
  ctx.globalAlpha = t.opacity
  ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${size}px "${st.fontFamily}"`
  ctx.textAlign = st.align
  ctx.textBaseline = 'middle'

  const totalH = lh * lines.length

  if (st.bgColor) {
    const pad = size * 0.25
    ctx.fillStyle = st.bgColor
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width
      const y = -totalH / 2 + lh * i
      let x0 = -w / 2 - pad
      if (st.align === 'left') x0 = -pad
      if (st.align === 'right') x0 = -w - pad
      ctx.fillRect(x0, y, w + pad * 2, lh)
    })
  }

  lines.forEach((line, i) => {
    const y = -totalH / 2 + lh * (i + 0.5)
    if (st.outlineWidth > 0) {
      ctx.strokeStyle = st.outlineColor
      ctx.lineWidth = st.outlineWidth * 2 * t.scale
      ctx.lineJoin = 'round'
      ctx.strokeText(line, 0, y)
    }
    ctx.fillStyle = st.color
    ctx.fillText(line, 0, y)
  })
  ctx.restore()
}

/** Rasterize a text clip to a full-frame transparent PNG for export. */
export function renderTextPngDataUrl(clip: Clip, W: number, H: number): string {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')
  if (ctx) drawTextClip(ctx, clip, W, H)
  return c.toDataURL('image/png')
}

export function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const frames = Math.floor((t % 1) * 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frames).padStart(2, '0')}`
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const FONT_FAMILIES = [
  'Segoe UI',
  'Arial',
  'Impact',
  'Georgia',
  'Bahnschrift',
  'Comic Sans MS',
  'Consolas',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana'
]

const PLAYABLE_VCODECS = ['h264', 'vp8', 'vp9', 'av1']

export function proxyPending(type: string, vcodec: string | undefined, proxyPath: string | undefined): boolean {
  return type === 'video' && !proxyPath && !PLAYABLE_VCODECS.includes(vcodec || '')
}

// ---------- color / filters ----------

export const FILTER_PRESETS: { name: string; color: ColorAdjust }[] = [
  { name: 'None', color: defaultColor() },
  { name: 'Vivid', color: { exposure: 0.05, contrast: 0.15, saturation: 0.35, temperature: 0 } },
  { name: 'Warm', color: { exposure: 0.03, contrast: 0.05, saturation: 0.1, temperature: 0.45 } },
  { name: 'Cool', color: { exposure: 0, contrast: 0.05, saturation: 0.05, temperature: -0.45 } },
  { name: 'B&W', color: { exposure: 0, contrast: 0.12, saturation: -1, temperature: 0 } },
  { name: 'Film', color: { exposure: -0.04, contrast: -0.1, saturation: -0.18, temperature: 0.15 } }
]

// ---------- transitions ----------

/** Per-clip alpha multipliers for main-track transitions at time t. */
export function transitionAlphas(project: Project, t: number): Map<string, number> {
  const map = new Map<string, number>()
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue
    for (let i = 0; i < track.clips.length - 1; i++) {
      const a = track.clips[i]
      const b = track.clips[i + 1]
      const overlap = transitionOverlap(a, b)
      if (overlap <= 0) continue
      const sB = b.start
      if (t < sB || t > sB + overlap) continue
      const p = (t - sB) / overlap
      const type = a.transitionAfter!.type
      if (type === 'cross') {
        map.set(b.id, Math.min(map.get(b.id) ?? 1, p))
      } else {
        map.set(a.id, Math.min(map.get(a.id) ?? 1, Math.max(0, 1 - p * 2)))
        map.set(b.id, Math.min(map.get(b.id) ?? 1, Math.max(0, p * 2 - 1)))
      }
    }
  }
  return map
}

/** Group timeline-absolute word stamps into styled caption text clips. */
export function captionClipsFromWords(
  words: WordStamp[],
  big: boolean,
  mkId: () => string
): Clip[] {
  const groups: WordStamp[][] = []
  let cur: WordStamp[] = []
  for (const w of words) {
    const first = cur[0]
    const prev = cur[cur.length - 1]
    if (cur.length >= 4 || (first && w.t1 - first.t0 > 2.4) || (prev && w.t0 - prev.t1 > 0.55)) {
      if (cur.length > 0) groups.push(cur)
      cur = []
    }
    cur.push(w)
  }
  if (cur.length > 0) groups.push(cur)

  return groups.map((g) => {
    const t0 = g[0].t0
    const t1 = g[g.length - 1].t1
    return {
      id: mkId(),
      kind: 'text' as const,
      start: t0,
      duration: Math.max(0.3, t1 - t0 + 0.12),
      in: 0,
      volume: 0,
      muted: true,
      speed: 1,
      transform: { ...defaultTransform(), y: big ? 0.3 : 0.38 },
      text: g.map((w) => w.text).join(' '),
      textStyle: { ...defaultTextStyle(), fontSize: big ? 84 : 60, outlineWidth: big ? 6 : 5 },
      words: g.map((w) => ({ text: w.text, t0: w.t0 - t0, t1: w.t1 - t0 }))
    }
  })
}

/** Audio gain envelope from user fades at timeline time t (clip active assumed). */
export function fadeGainAt(clip: Clip, t: number): number {
  const local = t - clip.start
  let gain = 1
  const fi = clip.fadeIn ?? 0
  const fo = clip.fadeOut ?? 0
  if (fi > 0 && local < fi) gain *= Math.max(0, local / fi)
  if (fo > 0 && local > clip.duration - fo) gain *= Math.max(0, (clip.duration - local) / fo)
  return gain
}
