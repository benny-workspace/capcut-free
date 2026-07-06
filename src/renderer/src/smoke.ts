// Scripted end-to-end smoke scenario, run when the app is launched with
// ?smoke=1 (LOCALCUT_SMOKE). Builds a real project from generated media,
// exercises the GL preview (chroma key + mask + adjustment layer + text),
// runs a frame-pipe export, and reports the result on the console where
// the main process picks it up, verifies the file, and exits.

import type { MediaItem } from '@shared/model'
import { defaultChromaKey } from '@shared/model'
import { api } from './api'
import { runFramePipeExport } from './exportFramePipe'
import { useEditor } from './store'

const log = (m: string): void => console.warn('[smoke] ' + m)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runSmoke(): Promise<void> {
  try {
    const st = useEditor.getState
    const assets = await api.smokeSetup()
    log('assets ready')

    st().setProjectMeta({ name: 'smoke', width: 1280, height: 720 })
    const items = (await api.ingest([assets.basePath, assets.greenPath])) as MediaItem[]
    st().addMedia(items)
    const base = items.find((i) => i.path === assets.basePath)
    const green = items.find((i) => i.path === assets.greenPath)
    if (!base || !green) throw new Error('ingest failed')

    st().addToTimeline(base.id)

    st().addOverlayClip(green.id)
    const overlay = (): ReturnType<typeof st>['project']['tracks'][number] =>
      st().project.tracks.find((t) => t.kind === 'overlay')!
    const greenClip = overlay().clips[0]
    st().updateClip(greenClip.id, {
      start: 0,
      duration: 4,
      chromaKey: defaultChromaKey(),
      mask: { type: 'ellipse', cx: 0.5, cy: 0.5, w: 1.7, h: 1.7, feather: 0.1, rotation: 0, invert: false },
      transform: { x: 0.18, y: -0.16, scale: 0.55, rotation: 0, opacity: 1 }
    })

    st().addAdjustClip()
    const adjClip = overlay().clips.find((c) => c.kind === 'adjust')!
    st().updateClip(adjClip.id, {
      start: 0,
      duration: 4,
      color: { exposure: 0.05, contrast: 0.1, saturation: 0.25, temperature: 0.5 }
    })

    st().addTextClip()
    const textTrack = st().project.tracks.find((t) => t.kind === 'text')!
    st().updateClip(textTrack.clips[0].id, { start: 0, duration: 4, text: 'GL smoke' })

    st().select(greenClip.id)
    st().setPlayhead(2)
    log('scene built, waiting for decoders')
    await wait(1800)

    log('starting frame-pipe export')
    const result = await runFramePipeExport(
      st().project,
      { outPath: assets.outPath, width: 640, height: 360, fps: 30, vBitrateK: 2500, encoder: 'auto' },
      () => {},
      { cancelled: false }
    )
    console.warn('SMOKE-RESULT ' + JSON.stringify(result))
  } catch (e) {
    console.warn('SMOKE-RESULT ' + JSON.stringify({ ok: false, error: String(e) }))
  }
}
