import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExportResult, ExportSettings } from '@shared/model'
import { needsFramePipe, projectDuration } from '@shared/model'
import type { ExportProgress } from '../api'
import { api } from '../api'
import { runFramePipeExport, type CancelToken } from '../exportFramePipe'
import { formatTime, renderTextPngDataUrl } from '../lib'
import { useEditor } from '../store'

const even = (n: number): number => 2 * Math.round(n / 2)

interface Preset {
  label: string
  w: number
  h: number
  defaultBitrateK: number
}

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const sys = useEditor((s) => s.sys)
  const setPlaying = useEditor((s) => s.setPlaying)

  const dur = projectDuration(project)

  const presets = useMemo<Preset[]>(() => {
    const aspect = project.width / project.height
    return [
      { short: 720, label: '720p', defaultBitrateK: 6000 },
      { short: 1080, label: '1080p', defaultBitrateK: 12000 },
      { short: 2160, label: '4K', defaultBitrateK: 35000 }
    ].map(({ short, label, defaultBitrateK }) => {
      const w = aspect >= 1 ? even(short * aspect) : short
      const h = aspect >= 1 ? short : even(short / aspect)
      return { label, w, h, defaultBitrateK }
    })
  }, [project.width, project.height])

  const [presetIdx, setPresetIdx] = useState(1)
  const [fps, setFps] = useState(project.fps)
  const [bitrateK, setBitrateK] = useState(presets[1].defaultBitrateK)
  const [encoder, setEncoder] = useState<ExportSettings['encoder']>('auto')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const cancelToken = useRef<CancelToken | null>(null)
  const usePipe = needsFramePipe(project)

  useEffect(() => setPlaying(false), [setPlaying])
  useEffect(() => api.on('export:progress', (p) => setProgress(p as ExportProgress)), [])

  const pickPreset = (idx: number): void => {
    setPresetIdx(idx)
    setBitrateK(presets[idx].defaultBitrateK)
  }

  const start = async (): Promise<void> => {
    const p = presets[presetIdx]
    const safeName = project.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'export'
    const outPath = await api.savePathDialog(`${safeName}.mp4`)
    if (!outPath) return
    setRunning(true)
    setResult(null)
    setProgress({ ratio: 0, phase: 'preparing' })
    const settings: ExportSettings = {
      outPath,
      width: p.w,
      height: p.h,
      fps,
      vBitrateK: bitrateK,
      encoder
    }
    let r: ExportResult
    if (usePipe) {
      // GPU compositor renders every frame (chroma key / masks / adjust layers)
      cancelToken.current = { cancelled: false }
      r = await runFramePipeExport(
        project,
        settings,
        (ratio) => setProgress({ ratio, phase: 'encoding' }),
        cancelToken.current
      )
    } else {
      // Text is rasterized at project resolution; the compiler scales it to the
      // output frame, so text keeps its relative size at any export resolution.
      const textPngs = project.tracks
        .flatMap((t) => t.clips)
        .filter((c) => c.kind === 'text' && (c.text || '').trim().length > 0)
        .map((c) => ({ clipId: c.id, dataUrl: renderTextPngDataUrl(c, project.width, project.height) }))
      r = await api.exportRun(project, settings, textPngs)
    }
    setRunning(false)
    setResult(r)
  }

  const cancel = async (): Promise<void> => {
    if (cancelToken.current) cancelToken.current.cancelled = true
    else await api.exportCancel()
    setRunning(false)
    setProgress(null)
  }

  const pct = progress ? Math.round(progress.ratio * 100) : 0

  return (
    <div className="modal-overlay" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal">
        <div className="panel-header">
          <span>Export video</span>
          <button className="btn small" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {!running && !result?.ok && (
            <>
              <div className="insp-row">
                <span className="insp-label">Resolution</span>
                <div className="btn-group">
                  {presets.map((p, i) => (
                    <button
                      key={p.label}
                      className={`btn small ${presetIdx === i ? 'active' : ''}`}
                      onClick={() => pickPreset(i)}
                      title={`${p.w}×${p.h}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className="insp-value">
                  {presets[presetIdx].w}×{presets[presetIdx].h}
                </span>
              </div>
              <div className="insp-row">
                <span className="insp-label">Frame rate</span>
                <div className="btn-group">
                  {[24, 30, 60].map((f) => (
                    <button
                      key={f}
                      className={`btn small ${fps === f ? 'active' : ''}`}
                      onClick={() => setFps(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <label className="insp-row">
                <span className="insp-label">Bitrate</span>
                <input
                  type="number"
                  min={1000}
                  max={80000}
                  step={500}
                  value={bitrateK}
                  onChange={(e) => setBitrateK(Number(e.target.value) || 1000)}
                />
                <span className="insp-value">kbps</span>
              </label>
              <div className="insp-row">
                <span className="insp-label">Encoder</span>
                <div className="btn-group">
                  {(['auto', 'qsv', 'x264'] as const).map((enc) => (
                    <button
                      key={enc}
                      className={`btn small ${encoder === enc ? 'active' : ''}`}
                      onClick={() => setEncoder(enc)}
                      disabled={enc === 'qsv' && sys ? !sys.qsv : false}
                    >
                      {enc === 'auto' ? 'Auto' : enc === 'qsv' ? 'Quick Sync' : 'Software'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="insp-row">
                <span className="insp-label">Duration</span>
                <span className="insp-value">{formatTime(dur)}</span>
              </div>
              <div className="insp-row">
                <span className="insp-label">Engine</span>
                <span className="engine-note">
                  {usePipe
                    ? 'GPU frame pipe (chroma key / mask / adjust in use — slower, exact)'
                    : 'FFmpeg filtergraph (fast path)'}
                </span>
              </div>
              {result && !result.ok && (
                <pre className="export-error">{result.error}</pre>
              )}
              <div className="modal-actions">
                <button className="btn primary" onClick={start} disabled={dur <= 0}>
                  {dur <= 0 ? 'Timeline is empty' : 'Choose file & export'}
                </button>
              </div>
            </>
          )}

          {running && (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="insp-row">
                <span className="insp-label">
                  {progress?.phase === 'preparing' ? 'Preparing…' : `Encoding… ${pct}%`}
                </span>
              </div>
              <div className="modal-actions">
                <button className="btn danger" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {!running && result?.ok && (
            <>
              <div className="export-done">
                <div className="export-done-icon">✓</div>
                <div>
                  Exported with <b>{result.encoderUsed}</b>
                </div>
                <div className="export-path">{result.outPath}</div>
              </div>
              <div className="modal-actions">
                <button
                  className="btn"
                  onClick={() => result.outPath && api.showItemInFolder(result.outPath)}
                >
                  Show in folder
                </button>
                <button className="btn primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
