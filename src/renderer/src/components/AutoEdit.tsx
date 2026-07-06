// Auto-Edit: analyze chosen clips (silence / scenes / speech / beats) and
// assemble an editable draft on the timeline, styled per template.

import { useState } from 'react'
import type { Clip, MediaItem, Track, WordStamp } from '@shared/model'
import { defaultTransform } from '@shared/model'
import { api } from '../api'
import { captionClipsFromWords } from '../lib'
import { uid, useEditor } from '../store'

type Style = 'talking' | 'montage' | 'short'

const VIVID = { exposure: 0.05, contrast: 0.15, saturation: 0.35, temperature: 0 }
const FILM = { exposure: -0.04, contrast: -0.1, saturation: -0.18, temperature: 0.15 }

function baseClip(mediaId: string, start: number, duration: number, srcIn: number): Clip {
  return {
    id: uid('c'),
    kind: 'video',
    mediaId,
    start,
    duration,
    in: srcIn,
    volume: 1,
    muted: false,
    speed: 1,
    transform: defaultTransform()
  }
}

export function AutoEditDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const media = useEditor((s) => s.project.media)
  const sys = useEditor((s) => s.sys)
  const videos = media.filter((m) => m.type === 'video')
  const audios = media.filter((m) => m.type === 'audio')

  const [sel, setSel] = useState<Set<string>>(new Set(videos.map((v) => v.id)))
  const [musicId, setMusicId] = useState<string>(audios[0]?.id ?? '')
  const [style, setStyle] = useState<Style>('talking')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [log, setLog] = useState<string[]>([])

  const addLog = (m: string): void => setLog((l) => [...l, m])
  const toggle = (id: string): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const run = async (): Promise<void> => {
    const chosen = videos.filter((v) => sel.has(v.id))
    if (chosen.length === 0 || running) return
    setRunning(true)
    setLog([])
    try {
      const st = useEditor.getState()
      const music = audios.find((a) => a.id === musicId)
      const vertical = style === 'short'
      st.setProjectMeta({ width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080 })

      const mainClips: Clip[] = []
      const audioClips: Clip[] = []
      let textClips: Clip[] = []
      let cursor = 0

      if (style === 'montage') {
        let intervals: number[] = []
        if (music) {
          addLog('Detecting beats in ' + music.name + '…')
          const b = await api.toolBeats(music.path)
          addLog(`${b.beats.length} onsets, ~${b.bpm} BPM`)
          let last = b.beats[0] ?? 0
          for (let i = 1; i < b.beats.length; i++) {
            const gap = b.beats[i] - last
            if (gap >= 0.35) {
              intervals.push(Math.min(gap, 2.5))
              last = b.beats[i]
            }
          }
        }
        if (intervals.length === 0) intervals = new Array(80).fill(0.7)

        const pool: { mediaId: string; in: number; dur: number }[] = []
        for (const v of chosen) {
          addLog('Scene detection: ' + v.name + '…')
          const bounds = await api.toolScenes(v.path, 0, v.duration, 0.3)
          const cuts = [0, ...bounds, v.duration]
          for (let i = 0; i < cuts.length - 1; i++) {
            const d = cuts[i + 1] - cuts[i]
            if (d >= 0.5) pool.push({ mediaId: v.id, in: cuts[i], dur: d })
          }
          addLog(`  ${bounds.length + 1} shots`)
        }
        if (pool.length === 0) {
          for (const v of chosen) pool.push({ mediaId: v.id, in: 0, dur: v.duration })
        }

        const target = Math.min(music ? music.duration : 45, 90)
        let pi = 0
        for (const iv of intervals) {
          if (cursor >= target) break
          const seg = pool[pi % pool.length]
          pi++
          const dur = Math.min(iv, seg.dur)
          const c = baseClip(seg.mediaId, cursor, dur, seg.in + Math.max(0, (seg.dur - dur) / 2))
          c.muted = true // music carries the montage
          c.color = { ...VIVID }
          // occasional crossfade, matching packedMain's overlap math
          const prev = mainClips[mainClips.length - 1]
          if (prev && pi % 4 === 0 && prev.duration >= 0.6 && dur >= 0.6) {
            prev.transitionAfter = { type: 'cross', duration: 0.25 }
            c.start = cursor - 0.25
            cursor -= 0.25
          }
          mainClips.push(c)
          cursor += dur
        }
        if (music) {
          audioClips.push({
            ...baseClip(music.id, 0, Math.min(cursor, music.duration), 0),
            kind: 'audio',
            volume: 0.9,
            fadeIn: 0.3,
            fadeOut: 1.2
          })
        }
      } else {
        // talking-head / short-form: silence cut + captions, jump cuts
        const words: WordStamp[] = []
        for (const v of chosen) {
          addLog('Silence analysis: ' + v.name + '…')
          const sil = await api.toolSilence(v.path, 0, v.duration)
          const PAD = 0.075
          const keep: { in: number; duration: number }[] = []
          let pos = 0
          for (const r of sil) {
            const end = Math.min(r.start + PAD, v.duration)
            if (end - pos > 0.3) keep.push({ in: pos, duration: end - pos })
            pos = Math.max(pos, r.end - PAD)
          }
          if (v.duration - pos > 0.3) keep.push({ in: pos, duration: v.duration - pos })
          if (keep.length === 0) keep.push({ in: 0, duration: v.duration })
          addLog(`  kept ${keep.length} segments (cut ${(v.duration - keep.reduce((a, k) => a + k.duration, 0)).toFixed(1)}s)`)

          let vWords: WordStamp[] = []
          if (sys?.whisper) {
            addLog('Transcribing: ' + v.name + '…')
            const tr = await api.toolTranscribe(v.path, 0, v.duration)
            if (tr.ok) {
              vWords = tr.words
              addLog(`  ${tr.words.length} words`)
            } else {
              addLog('  transcription failed: ' + (tr.error || ''))
            }
          }

          for (const seg of keep) {
            const c = baseClip(v.id, cursor, seg.duration, seg.in)
            c.color = { ...FILM }
            mainClips.push(c)
            for (const w of vWords) {
              if (w.t0 >= seg.in && w.t0 < seg.in + seg.duration) {
                words.push({
                  text: w.text,
                  t0: cursor + (w.t0 - seg.in),
                  t1: cursor + Math.min(w.t1 - seg.in, seg.duration)
                })
              }
            }
            cursor += seg.duration
          }
        }
        textClips = captionClipsFromWords(words, vertical, () => uid('c'))
        if (music) {
          audioClips.push({
            ...baseClip(music.id, 0, Math.min(cursor, music.duration), 0),
            kind: 'audio',
            volume: 0.16, // ducked under speech
            fadeIn: 0.5,
            fadeOut: 1
          })
        }
      }

      const tracks: Track[] = [
        { id: 'main', kind: 'video', name: 'Main', clips: mainClips },
        { id: 'overlay1', kind: 'overlay', name: 'Overlay', clips: [] },
        { id: 'text1', kind: 'text', name: 'Text', clips: textClips },
        { id: 'audio1', kind: 'audio', name: 'Audio', clips: audioClips }
      ]
      st.replaceTimeline(tracks)
      addLog(`Draft ready: ${mainClips.length} cuts, ${textClips.length} captions, ${cursor.toFixed(1)}s. Fully editable — Ctrl+Z to revert.`)
      setDone(true)
    } catch (e) {
      addLog('Auto-Edit failed: ' + String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="modal-overlay" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal wide">
        <div className="panel-header">
          <span>✨ Auto-Edit</span>
          <button className="btn small" onClick={onClose} disabled={running}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {videos.length === 0 ? (
            <div className="empty-hint">Import some video first, then run Auto-Edit.</div>
          ) : (
            <>
              <div className="insp-section">Clips</div>
              <div className="ae-clips">
                {videos.map((v) => (
                  <label key={v.id} className="ae-clip">
                    <input type="checkbox" checked={sel.has(v.id)} onChange={() => toggle(v.id)} />
                    {v.thumbnail && <img src={v.thumbnail} alt="" />}
                    <span>{v.name}</span>
                  </label>
                ))}
              </div>
              <div className="insp-row">
                <span className="insp-label">Music</span>
                <select value={musicId} onChange={(e) => setMusicId(e.target.value)}>
                  <option value="">None</option>
                  {audios.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="insp-row">
                <span className="insp-label">Style</span>
                <div className="btn-group">
                  {(
                    [
                      ['talking', 'Talking head'],
                      ['montage', 'Beat montage'],
                      ['short', 'Short-form 9:16']
                    ] as [Style, string][]
                  ).map(([s, label]) => (
                    <button
                      key={s}
                      className={`btn small ${style === s ? 'active' : ''}`}
                      onClick={() => setStyle(s)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {!sys?.whisper && style !== 'montage' && (
                <div className="tool-msg">Whisper model missing — draft will skip captions.</div>
              )}
              {log.length > 0 && (
                <pre className="ae-log">{log.join('\n')}</pre>
              )}
              <div className="modal-actions">
                {done ? (
                  <button className="btn primary" onClick={onClose}>
                    Open draft
                  </button>
                ) : (
                  <button className="btn primary" onClick={run} disabled={running || sel.size === 0}>
                    {running ? 'Analyzing…' : 'Create draft'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
