import { useCallback, useEffect, useRef } from 'react'
import type { Clip, Track } from '@shared/model'
import { MAIN_TRACK_ID, projectDuration } from '@shared/model'
import { clamp, formatTime } from '../lib'
import { findClip, useEditor } from '../store'

const trackHeight = (kind: Track['kind']): number =>
  kind === 'video' ? 56 : kind === 'overlay' ? 44 : 32

function trackAccepts(track: Track, clip: Clip): boolean {
  if (clip.kind === 'text') return track.kind === 'text'
  if (clip.kind === 'audio') return track.kind === 'audio'
  return track.kind === 'video' || track.kind === 'overlay'
}

interface DragState {
  mode: 'move' | 'trim-l' | 'trim-r'
  clipId: string
  trackId: string
  startClientX: number
  startClientY: number
  orig: Clip
  moved: boolean
  undoPushed: boolean
}

function PlayheadLine(): React.JSX.Element {
  const playhead = useEditor((s) => s.playhead)
  const pps = useEditor((s) => s.pps)
  return <div className="playhead" style={{ left: playhead * pps }} />
}

function Ruler({ width }: { width: number }): React.JSX.Element {
  const pps = useEditor((s) => s.pps)
  const intervals = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120]
  const interval = intervals.find((i) => i * pps >= 70) ?? 120
  const count = Math.ceil(width / pps / interval) + 1
  const ticks: React.JSX.Element[] = []
  for (let i = 0; i < count && i < 600; i++) {
    const t = i * interval
    ticks.push(
      <span key={i} className="tick" style={{ left: t * pps }}>
        {formatTime(t).slice(0, 5)}
      </span>
    )
  }
  return <div className="tl-ruler-ticks">{ticks}</div>
}

export function Timeline(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const pps = useEditor((s) => s.pps)
  const snap = useEditor((s) => s.snap)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)

  const dur = projectDuration(project)
  const width = Math.max((dur + 10) * pps, 800)

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = contentRef.current?.getBoundingClientRect()
      if (!rect) return 0
      return Math.max(0, (clientX - rect.left) / useEditor.getState().pps)
    },
    []
  )

  const snapTime = useCallback((t: number, excludeClipId: string): number => {
    const s = useEditor.getState()
    if (!s.snap) return t
    const candidates: number[] = [0, s.playhead]
    for (const track of s.project.tracks) {
      for (const c of track.clips) {
        if (c.id === excludeClipId) continue
        candidates.push(c.start, c.start + c.duration)
      }
    }
    let best = t
    let bestDist = 8 / s.pps
    for (const cand of candidates) {
      const d = Math.abs(cand - t)
      if (d < bestDist) {
        bestDist = d
        best = cand
      }
    }
    return best
  }, [])

  // ---- scrubbing on the ruler ----
  const onRulerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    const s = useEditor.getState()
    s.setPlaying(false)
    s.setPlayhead(timeAt(e.clientX))
    const move = (ev: PointerEvent): void => useEditor.getState().setPlayhead(timeAt(ev.clientX))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- clip drag / trim ----
  const onClipDown = (e: React.PointerEvent, clip: Clip, track: Track): void => {
    e.stopPropagation()
    e.preventDefault()
    const s = useEditor.getState()
    s.select(clip.id)
    const target = e.target as HTMLElement
    const mode: DragState['mode'] = target.classList.contains('handle-l')
      ? 'trim-l'
      : target.classList.contains('handle-r')
        ? 'trim-r'
        : 'move'
    drag.current = {
      mode,
      clipId: clip.id,
      trackId: track.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      orig: { ...clip, transform: { ...clip.transform } },
      moved: false,
      undoPushed: false
    }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
  }

  const rowLayout = (): { track: Track; top: number; height: number }[] => {
    const s = useEditor.getState()
    const rows: { track: Track; top: number; height: number }[] = []
    let top = 0
    for (const track of s.project.tracks) {
      const height = trackHeight(track.kind)
      rows.push({ track, top, height })
      top += height + 4
    }
    return rows
  }

  const onDragMove = useCallback((e: PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const s = useEditor.getState()
    const dx = (e.clientX - d.startClientX) / s.pps
    if (!d.moved && Math.abs(e.clientX - d.startClientX) < 3 && Math.abs(e.clientY - d.startClientY) < 3) {
      return
    }
    if (!d.moved) {
      d.moved = true
      if (!d.undoPushed) {
        s.beginInteraction()
        d.undoPushed = true
      }
    }

    const loc = findClip(s.project, d.clipId)
    if (!loc) return
    const media = d.orig.mediaId ? s.project.media.find((m) => m.id === d.orig.mediaId) : undefined

    const speed = d.orig.speed || 1

    if (d.mode === 'trim-r') {
      // timeline seconds available = remaining source seconds / speed
      const maxDur = media && media.duration > 0 ? (media.duration - d.orig.in) / speed : 3600
      const duration = clamp(d.orig.duration + dx, 0.1, maxDur)
      s.updateClip(d.clipId, { duration }, false)
      return
    }

    if (d.mode === 'trim-l') {
      const isMedia = d.orig.kind === 'video' || d.orig.kind === 'audio'
      const minDelta = isMedia
        ? -d.orig.in / speed
        : loc.track.id === MAIN_TRACK_ID
          ? -3600
          : -d.orig.start
      const delta = clamp(dx, minDelta, d.orig.duration - 0.1)
      const patch: Partial<Clip> = {
        duration: d.orig.duration - delta
      }
      if (isMedia) patch.in = d.orig.in + delta * speed
      if (loc.track.id !== MAIN_TRACK_ID) patch.start = Math.max(0, d.orig.start + delta)
      s.updateClip(d.clipId, patch, false)
      return
    }

    // ---- move ----
    const pointerTime = timeAt(e.clientX)
    // vertical: which row is the pointer over?
    const contentRect = contentRef.current?.getBoundingClientRect()
    const rulerH = 26
    const py = contentRect ? e.clientY - contentRect.top - rulerH : 0
    const rows = rowLayout()
    let targetRow = rows.find((r) => py >= r.top && py < r.top + r.height)
    if (targetRow && !trackAccepts(targetRow.track, d.orig)) targetRow = undefined
    const targetTrackId = targetRow ? targetRow.track.id : loc.track.id

    if (targetTrackId === MAIN_TRACK_ID) {
      const main = s.project.tracks.find((t) => t.id === MAIN_TRACK_ID)
      if (!main) return
      if (loc.track.id === MAIN_TRACK_ID) {
        // reorder within the magnetic track
        let idx = 0
        for (const c of main.clips) {
          if (c.id === d.clipId) continue
          if (pointerTime > c.start + c.duration / 2) idx++
        }
        s.reorderMain(d.clipId, idx)
      } else {
        let idx = 0
        for (const c of main.clips) if (pointerTime > c.start + c.duration / 2) idx++
        s.moveToTrack(d.clipId, MAIN_TRACK_ID, 0, idx)
      }
    } else {
      const rawStart = Math.max(0, d.orig.start + dx)
      const start = snapTime(rawStart, d.clipId)
      if (targetTrackId === loc.track.id) {
        s.updateClip(d.clipId, { start }, false)
      } else {
        s.moveToTrack(d.clipId, targetTrackId, start)
      }
    }
  }, [snapTime, timeAt])

  const onDragUp = useCallback((): void => {
    drag.current = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
  }, [onDragMove])

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragUp)
    }
  }, [onDragMove, onDragUp])

  // ctrl+wheel zoom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const s = useEditor.getState()
      s.setPps(s.pps * (e.deltaY < 0 ? 1.15 : 0.87))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead)
  const deleteClip = useEditor((s) => s.deleteClip)
  const addTextClip = useEditor((s) => s.addTextClip)
  const toggleSnap = useEditor((s) => s.toggleSnap)
  const setPps = useEditor((s) => s.setPps)
  const select = useEditor((s) => s.select)

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button className="btn" onClick={splitAtPlayhead} title="Split at playhead (S)">
          ✂ Split
        </button>
        <button
          className="btn"
          onClick={() => selectedClipId && deleteClip(selectedClipId)}
          disabled={!selectedClipId}
          title="Delete selected (Del)"
        >
          🗑 Delete
        </button>
        <button className="btn" onClick={addTextClip} title="Add a text clip (T)">
          T Text
        </button>
        <label className="snap-toggle">
          <input type="checkbox" checked={snap} onChange={toggleSnap} /> Snap
        </label>
        <div className="spacer" />
        <button className="btn icon" onClick={() => setPps(pps * 0.8)} title="Zoom out">
          −
        </button>
        <input
          type="range"
          min={8}
          max={300}
          value={pps}
          onChange={(e) => setPps(Number(e.target.value))}
          className="zoom-slider"
        />
        <button className="btn icon" onClick={() => setPps(pps * 1.25)} title="Zoom in">
          +
        </button>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <div className="tl-ruler-corner" />
          {project.tracks.map((track) => (
            <div
              key={track.id}
              className="tl-label"
              style={{ height: trackHeight(track.kind) }}
            >
              {track.name}
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div
            className="tl-content"
            ref={contentRef}
            style={{ width }}
            onPointerDown={() => select(null)}
          >
            <div className="tl-ruler" onPointerDown={onRulerDown}>
              <Ruler width={width} />
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`tl-track kind-${track.kind}`}
                style={{ height: trackHeight(track.kind) }}
              >
                {track.clips.map((clip) => {
                  const media = clip.mediaId
                    ? project.media.find((m) => m.id === clip.mediaId)
                    : undefined
                  return (
                    <div
                      key={clip.id}
                      className={`tl-clip kind-${clip.kind} ${selectedClipId === clip.id ? 'selected' : ''}`}
                      style={{ left: clip.start * pps, width: Math.max(clip.duration * pps, 6) }}
                      onPointerDown={(e) => onClipDown(e, clip, track)}
                    >
                      {media?.thumbnail && clip.kind !== 'audio' && (
                        <div
                          className="clip-thumb"
                          style={{ backgroundImage: `url(${media.thumbnail})` }}
                        />
                      )}
                      <span className="clip-label">
                        {clip.kind === 'text' ? `T ${clip.text || ''}` : media?.name || clip.kind}
                      </span>
                      <div className="handle handle-l" />
                      <div className="handle handle-r" />
                    </div>
                  )
                })}
              </div>
            ))}
            <PlayheadLine />
          </div>
        </div>
      </div>
    </div>
  )
}
