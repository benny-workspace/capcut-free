import { useEffect, useState } from 'react'
import type { Clip, ColorAdjust, KfProp, Mask, TextStyle, TransitionType } from '@shared/model'
import {
  MAIN_TRACK_ID,
  defaultChromaKey,
  defaultColor,
  defaultMask,
  hasKeyframes
} from '@shared/model'
import { api } from '../api'
import { FILTER_PRESETS, FONT_FAMILIES } from '../lib'
import { findClip, useEditor } from '../store'

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommitStart,
  onKeyframe,
  hasKf
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onCommitStart: () => void
  onKeyframe?: () => void
  hasKf?: boolean
}): React.JSX.Element {
  // the number is directly editable: click, type, Enter/blur to commit
  const [draft, setDraft] = useState<string | null>(null)
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  const clampV = (v: number): number => Math.min(max, Math.max(min, v))
  return (
    <label className="insp-row">
      <span className="insp-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onCommitStart}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="num-input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft ?? value.toFixed(decimals)}
        onFocus={(e) => {
          onCommitStart()
          setDraft(value.toFixed(decimals))
          e.target.select()
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          const v = parseFloat(e.target.value)
          if (isFinite(v)) onChange(clampV(v))
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {onKeyframe && (
        <button
          className={`btn kf ${hasKf ? 'active' : ''}`}
          title="Add keyframe at playhead"
          onClick={(e) => {
            e.preventDefault()
            onKeyframe()
          }}
        >
          ◆
        </button>
      )}
    </label>
  )
}

function ProjectSettings(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const setProjectMeta = useEditor((s) => s.setProjectMeta)
  const aspects: { label: string; w: number; h: number }[] = [
    { label: '9:16', w: 1080, h: 1920 },
    { label: '16:9', w: 1920, h: 1080 },
    { label: '1:1', w: 1080, h: 1080 },
    { label: '4:5', w: 1080, h: 1350 }
  ]
  return (
    <div className="inspector-body">
      <div className="insp-section">Project</div>
      <label className="insp-row">
        <span className="insp-label">Name</span>
        <input
          type="text"
          value={project.name}
          onChange={(e) => setProjectMeta({ name: e.target.value })}
        />
      </label>
      <div className="insp-row">
        <span className="insp-label">Aspect</span>
        <div className="btn-group">
          {aspects.map((a) => (
            <button
              key={a.label}
              className={`btn small ${project.width === a.w && project.height === a.h ? 'active' : ''}`}
              onClick={() => setProjectMeta({ width: a.w, height: a.h })}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="insp-row">
        <span className="insp-label">FPS</span>
        <div className="btn-group">
          {[24, 30, 60].map((f) => (
            <button
              key={f}
              className={`btn small ${project.fps === f ? 'active' : ''}`}
              onClick={() => setProjectMeta({ fps: f })}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="empty-hint">Select a clip to edit its properties.</div>
    </div>
  )
}

export function Inspector(): React.JSX.Element {
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const project = useEditor((s) => s.project)
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const deleteClip = useEditor((s) => s.deleteClip)
  const applyStyleToAllCaptions = useEditor((s) => s.applyStyleToAllCaptions)

  const loc = selectedClipId ? findClip(project, selectedClipId) : null

  if (!loc) {
    return (
      <div className="inspector">
        <div className="panel-header">
          <span>Inspector</span>
        </div>
        <ProjectSettings />
      </div>
    )
  }

  const clip = loc.clip
  const t = clip.transform
  const patchTransform = (p: Partial<Clip['transform']>): void =>
    updateClip(clip.id, { transform: { ...t, ...p } }, false)
  const patchStyle = (p: Partial<TextStyle>): void => {
    if (!clip.textStyle) return
    updateClip(clip.id, { textStyle: { ...clip.textStyle, ...p } })
  }

  return (
    <div className="inspector">
      <div className="panel-header">
        <span>
          {clip.kind === 'text'
            ? 'Text clip'
            : clip.kind === 'audio'
              ? 'Audio clip'
              : clip.kind === 'adjust'
                ? 'Adjustment layer'
                : 'Clip'}
        </span>
        <button className="btn small danger" onClick={() => deleteClip(clip.id)}>
          Delete
        </button>
      </div>
      <div className="inspector-body">
        {clip.kind === 'text' && clip.textStyle && (
          <>
            <div className="insp-section">Text</div>
            <textarea
              className="text-input"
              rows={3}
              value={clip.text || ''}
              onChange={(e) => updateClip(clip.id, { text: e.target.value }, false)}
              onFocus={beginInteraction}
            />
            <label className="insp-row">
              <span className="insp-label">Font</span>
              <select
                value={clip.textStyle.fontFamily}
                onChange={(e) => patchStyle({ fontFamily: e.target.value })}
              >
                {FONT_FAMILIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <Slider
              label="Size"
              value={clip.textStyle.fontSize}
              min={16}
              max={300}
              step={1}
              onCommitStart={beginInteraction}
              onChange={(v) => patchStyle({ fontSize: v })}
            />
            <label className="insp-row">
              <span className="insp-label">Color</span>
              <input
                type="color"
                value={clip.textStyle.color}
                onChange={(e) => patchStyle({ color: e.target.value })}
              />
              <span className="insp-label">Outline</span>
              <input
                type="color"
                value={clip.textStyle.outlineColor}
                onChange={(e) => patchStyle({ outlineColor: e.target.value })}
              />
            </label>
            <Slider
              label="Outline W"
              value={clip.textStyle.outlineWidth}
              min={0}
              max={20}
              step={1}
              onCommitStart={beginInteraction}
              onChange={(v) => patchStyle({ outlineWidth: v })}
            />
            <div className="insp-row">
              <span className="insp-label">Style</span>
              <div className="btn-group">
                <button
                  className={`btn small ${clip.textStyle.bold ? 'active' : ''}`}
                  onClick={() => patchStyle({ bold: !clip.textStyle!.bold })}
                >
                  B
                </button>
                <button
                  className={`btn small ${clip.textStyle.italic ? 'active' : ''}`}
                  onClick={() => patchStyle({ italic: !clip.textStyle!.italic })}
                >
                  I
                </button>
              </div>
            </div>
            {clip.words && (
              <div className="insp-row">
                <span className="insp-label" />
                <button
                  className="btn small primary"
                  title="Copy this caption's font, colors and position onto every auto caption"
                  onClick={() => applyStyleToAllCaptions(clip.id)}
                >
                  Apply to all captions
                </button>
              </div>
            )}
          </>
        )}

        {clip.kind !== 'audio' && clip.kind !== 'adjust' && (
          <TransformSection clip={clip} />
        )}

        {clip.kind === 'video' && <AiToolsSection clip={clip} />}

        {clip.kind === 'adjust' && (
          <>
            <div className="insp-section">Adjustment</div>
            <Slider
              label="Intensity"
              value={t.opacity}
              min={0}
              max={1}
              step={0.01}
              onCommitStart={beginInteraction}
              onChange={(v) => patchTransform({ opacity: v })}
            />
            <ColorSection clip={clip} />
          </>
        )}

        {(clip.kind === 'video' || clip.kind === 'image') && (
          <>
            <ChromaSection clip={clip} />
            <MaskSection clip={clip} />
          </>
        )}

        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <>
            <div className="insp-section">Speed</div>
            <Slider
              label="Speed"
              value={clip.speed || 1}
              min={0.25}
              max={4}
              step={0.05}
              onCommitStart={beginInteraction}
              onChange={(v) => {
                // keep the same source range: timeline duration rescales
                const old = clip.speed || 1
                updateClip(clip.id, { speed: v, duration: (clip.duration * old) / v }, false)
              }}
            />
          </>
        )}

        {(clip.kind === 'video' || clip.kind === 'image') && (
          <ColorSection clip={clip} />
        )}

        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <>
            <div className="insp-section">Audio</div>
            <Slider
              label="Volume"
              value={clip.volume}
              min={0}
              max={2}
              step={0.01}
              onCommitStart={beginInteraction}
              onChange={(v) => updateClip(clip.id, { volume: v }, false)}
            />
            <label className="insp-row">
              <span className="insp-label">Muted</span>
              <input
                type="checkbox"
                checked={clip.muted}
                onChange={(e) => updateClip(clip.id, { muted: e.target.checked })}
              />
            </label>
            <Slider
              label="Fade in"
              value={clip.fadeIn ?? 0}
              min={0}
              max={3}
              step={0.05}
              onCommitStart={beginInteraction}
              onChange={(v) => updateClip(clip.id, { fadeIn: v }, false)}
            />
            <Slider
              label="Fade out"
              value={clip.fadeOut ?? 0}
              min={0}
              max={3}
              step={0.05}
              onCommitStart={beginInteraction}
              onChange={(v) => updateClip(clip.id, { fadeOut: v }, false)}
            />
          </>
        )}

        {loc.track.id === MAIN_TRACK_ID && loc.index < loc.track.clips.length - 1 && (
          <TransitionSection clip={clip} />
        )}
      </div>
    </div>
  )
}

function TransformSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const setKeyframe = useEditor((s) => s.setKeyframe)
  const clearKeyframes = useEditor((s) => s.clearKeyframes)
  const playhead = useEditor((s) => s.playhead)
  const t = clip.transform
  const anyKf = hasKeyframes(clip)

  // when a property is keyframed, slider edits write a keyframe at the playhead
  const change = (prop: KfProp, v: number): void => {
    if (clip.keyframes?.[prop]?.length) {
      setKeyframe(clip.id, prop, playhead - clip.start, v)
    } else {
      updateClip(clip.id, { transform: { ...t, [prop]: v } }, false)
    }
  }
  const addKf = (prop: KfProp, v: number): void => {
    beginInteraction()
    setKeyframe(clip.id, prop, playhead - clip.start, v)
  }
  const kfProps: { prop: KfProp; label: string; min: number; max: number; step: number }[] = [
    { prop: 'x', label: 'X', min: -0.5, max: 0.5, step: 0.005 },
    { prop: 'y', label: 'Y', min: -0.5, max: 0.5, step: 0.005 },
    { prop: 'scale', label: 'Scale', min: 0.05, max: 3, step: 0.01 },
    { prop: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1 },
    { prop: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 }
  ]

  return (
    <>
      <div className="insp-section">Transform</div>
      {kfProps.map(({ prop, label, min, max, step }) => (
        <Slider
          key={prop}
          label={label}
          value={t[prop]}
          min={min}
          max={max}
          step={step}
          onCommitStart={beginInteraction}
          onChange={(v) => change(prop, v)}
          onKeyframe={() => addKf(prop, t[prop])}
          hasKf={!!clip.keyframes?.[prop]?.length}
        />
      ))}
      {anyKf && (
        <div className="insp-row">
          <span className="insp-label" />
          <button className="btn small" onClick={() => clearKeyframes(clip.id)}>
            Clear all keyframes
          </button>
        </div>
      )}
    </>
  )
}

function AiToolsSection({ clip }: { clip: Clip }): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const sys = useEditor((s) => s.sys)
  const updateClip = useEditor((s) => s.updateClip)
  const replaceClipWithSegments = useEditor((s) => s.replaceClipWithSegments)
  const addCaptionClips = useEditor((s) => s.addCaptionClips)
  const setMediaMatte = useEditor((s) => s.setMediaMatte)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [bgRatio, setBgRatio] = useState(0)

  const media = clip.mediaId ? project.media.find((m) => m.id === clip.mediaId) : undefined
  useEffect(
    () =>
      api.on('bgremove:progress', (p) => {
        const { mediaId, ratio } = p as { mediaId: string; ratio: number }
        if (mediaId === media?.id) setBgRatio(ratio)
      }),
    [media?.id]
  )
  if (!media) return <></>

  const speed = clip.speed || 1
  const srcStart = clip.in
  const srcDur = clip.duration * speed
  const guard = async (name: string, fn: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(name)
    setMsg('')
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(null)
    }
  }

  const silenceCut = (): Promise<void> =>
    guard('silence', async () => {
      const sil = await api.toolSilence(media.path, srcStart, srcDur)
      if (sil.length === 0) return 'No silence found.'
      const PAD = 0.075
      const keep: { in: number; duration: number }[] = []
      let pos = 0
      for (const r of sil) {
        const end = Math.min(r.start + PAD, srcDur)
        if (end - pos > 0.25) keep.push({ in: srcStart + pos, duration: end - pos })
        pos = Math.max(pos, r.end - PAD)
      }
      if (srcDur - pos > 0.25) keep.push({ in: srcStart + pos, duration: srcDur - pos })
      if (keep.length === 0) return 'Clip is entirely silent.'
      replaceClipWithSegments(clip.id, keep)
      const removed = srcDur - keep.reduce((a, k) => a + k.duration, 0)
      return `Removed ${removed.toFixed(1)}s of silence (${keep.length} segments).`
    })

  const sceneCut = (): Promise<void> =>
    guard('scenes', async () => {
      const bounds = await api.toolScenes(media.path, srcStart, srcDur, 0.3)
      if (bounds.length === 0) return 'No scene changes found.'
      const cuts = [0, ...bounds, srcDur]
      const segs: { in: number; duration: number }[] = []
      for (let i = 0; i < cuts.length - 1; i++) {
        const d = cuts[i + 1] - cuts[i]
        if (d > 0.15) segs.push({ in: srcStart + cuts[i], duration: d })
      }
      replaceClipWithSegments(clip.id, segs)
      return `Split into ${segs.length} scenes.`
    })

  const captions = (): Promise<void> =>
    guard('captions', async () => {
      const r = await api.toolTranscribe(media.path, srcStart, srcDur)
      if (!r.ok) return r.error || 'transcription failed'
      if (r.words.length === 0) return 'No speech detected.'
      addCaptionClips(clip.id, r.words, project.height > project.width)
      return `Added captions (${r.words.length} words).`
    })

  const removeBg = (): Promise<void> =>
    guard('bg', async () => {
      if (media.mattePath) {
        updateClip(clip.id, { bgRemoved: !clip.bgRemoved })
        return clip.bgRemoved ? 'Background restored.' : 'Background removed.'
      }
      setBgRatio(0)
      const r = await api.toolRemoveBg(media.path, media.id, media.duration)
      if (!r.ok || !r.mattePath) return r.error || 'background removal failed'
      setMediaMatte(media.id, r.mattePath)
      updateClip(clip.id, { bgRemoved: true })
      return 'Background removed.'
    })

  return (
    <>
      <div className="insp-section">AI tools</div>
      <div className="insp-row">
        <div className="btn-group wrap">
          <button className="btn small" disabled={!!busy} onClick={silenceCut}>
            {busy === 'silence' ? 'Analyzing…' : '✂ Silence cut'}
          </button>
          <button className="btn small" disabled={!!busy} onClick={sceneCut}>
            {busy === 'scenes' ? 'Analyzing…' : '🎬 Scene cut'}
          </button>
          <button
            className="btn small"
            disabled={!!busy || !sys?.whisper}
            title={sys?.whisper ? 'Word-accurate auto captions' : 'Whisper model not installed'}
            onClick={captions}
          >
            {busy === 'captions' ? 'Transcribing…' : '💬 Auto captions'}
          </button>
          <button
            className="btn small"
            disabled={!!busy || (!sys?.modnet && !media.mattePath)}
            title={sys?.modnet || media.mattePath ? 'AI portrait matting (offline pass)' : 'MODNet model not installed'}
            onClick={removeBg}
          >
            {busy === 'bg'
              ? `Matting… ${Math.round(bgRatio * 100)}%`
              : clip.bgRemoved
                ? '👤 Restore BG'
                : '👤 Remove BG'}
          </button>
        </div>
      </div>
      {msg && <div className="tool-msg">{msg}</div>}
    </>
  )
}

function ChromaSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const ck = clip.chromaKey

  return (
    <>
      <div className="insp-section">Chroma key</div>
      <label className="insp-row">
        <span className="insp-label">Enabled</span>
        <input
          type="checkbox"
          checked={!!ck?.enabled}
          onChange={(e) =>
            updateClip(clip.id, {
              chromaKey: e.target.checked
                ? { ...(ck ?? defaultChromaKey()), enabled: true }
                : ck
                  ? { ...ck, enabled: false }
                  : undefined
            })
          }
        />
        {ck?.enabled && (
          <>
            <span className="insp-label">Key color</span>
            <input
              type="color"
              value={ck.color}
              onChange={(e) => updateClip(clip.id, { chromaKey: { ...ck, color: e.target.value } }, false)}
            />
          </>
        )}
      </label>
      {ck?.enabled && (
        <>
          <Slider label="Similarity" value={ck.similarity} min={0.01} max={0.45} step={0.005} onCommitStart={beginInteraction} onChange={(v) => updateClip(clip.id, { chromaKey: { ...ck, similarity: v } }, false)} />
          <Slider label="Smooth" value={ck.smoothness} min={0} max={0.4} step={0.005} onCommitStart={beginInteraction} onChange={(v) => updateClip(clip.id, { chromaKey: { ...ck, smoothness: v } }, false)} />
          <Slider label="Spill" value={ck.spill} min={0} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => updateClip(clip.id, { chromaKey: { ...ck, spill: v } }, false)} />
        </>
      )}
    </>
  )
}

function MaskSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const m = clip.mask
  const patch = (p: Partial<Mask>): void => {
    if (!m) return
    updateClip(clip.id, { mask: { ...m, ...p } }, false)
  }
  const types: { label: string; value: Mask['type'] | null }[] = [
    { label: 'None', value: null },
    { label: 'Rect', value: 'rect' },
    { label: 'Ellipse', value: 'ellipse' },
    { label: 'Linear', value: 'linear' }
  ]

  return (
    <>
      <div className="insp-section">Mask</div>
      <div className="insp-row">
        <span className="insp-label">Type</span>
        <div className="btn-group">
          {types.map((tp) => (
            <button
              key={tp.label}
              className={`btn small ${(m?.type ?? null) === tp.value ? 'active' : ''}`}
              onClick={() =>
                updateClip(clip.id, {
                  mask: tp.value ? { ...defaultMask(tp.value), ...(m ? { ...m, type: tp.value } : {}) } : undefined
                })
              }
            >
              {tp.label}
            </button>
          ))}
        </div>
      </div>
      {m && (
        <>
          <Slider label="Center X" value={m.cx} min={0} max={1} step={0.005} onCommitStart={beginInteraction} onChange={(v) => patch({ cx: v })} />
          <Slider label="Center Y" value={m.cy} min={0} max={1} step={0.005} onCommitStart={beginInteraction} onChange={(v) => patch({ cy: v })} />
          {m.type !== 'linear' && (
            <>
              <Slider label="Width" value={m.w} min={0.05} max={2} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ w: v })} />
              <Slider label="Height" value={m.h} min={0.05} max={2} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ h: v })} />
            </>
          )}
          <Slider label="Feather" value={m.feather} min={0} max={0.5} step={0.005} onCommitStart={beginInteraction} onChange={(v) => patch({ feather: v })} />
          <Slider label="Rotation" value={m.rotation} min={-180} max={180} step={1} onCommitStart={beginInteraction} onChange={(v) => patch({ rotation: v })} />
          <label className="insp-row">
            <span className="insp-label">Invert</span>
            <input type="checkbox" checked={m.invert} onChange={(e) => patch({ invert: e.target.checked })} />
          </label>
        </>
      )}
    </>
  )
}

function ColorSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const color = clip.color ?? defaultColor()
  const patch = (p: Partial<ColorAdjust>): void =>
    updateClip(clip.id, { color: { ...color, ...p } }, false)

  return (
    <>
      <div className="insp-section">Color</div>
      <div className="insp-row">
        <span className="insp-label">Preset</span>
        <div className="btn-group wrap">
          {FILTER_PRESETS.map((p) => (
            <button
              key={p.name}
              className="btn small"
              onClick={() => {
                beginInteraction()
                updateClip(clip.id, { color: { ...p.color } }, false)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <Slider label="Exposure" value={color.exposure} min={-1} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ exposure: v })} />
      <Slider label="Contrast" value={color.contrast} min={-1} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ contrast: v })} />
      <Slider label="Saturation" value={color.saturation} min={-1} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ saturation: v })} />
      <Slider label="Warmth" value={color.temperature} min={-1} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patch({ temperature: v })} />
    </>
  )
}

function TransitionSection({ clip }: { clip: Clip }): React.JSX.Element {
  const updateClip = useEditor((s) => s.updateClip)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const cur = clip.transitionAfter

  const setType = (type: TransitionType | null): void => {
    updateClip(clip.id, {
      transitionAfter: type ? { type, duration: cur?.duration ?? 0.5 } : undefined
    })
  }

  return (
    <>
      <div className="insp-section">Transition to next</div>
      <div className="insp-row">
        <span className="insp-label">Type</span>
        <div className="btn-group">
          <button className={`btn small ${!cur ? 'active' : ''}`} onClick={() => setType(null)}>
            None
          </button>
          <button
            className={`btn small ${cur?.type === 'cross' ? 'active' : ''}`}
            onClick={() => setType('cross')}
          >
            Cross
          </button>
          <button
            className={`btn small ${cur?.type === 'fadeblack' ? 'active' : ''}`}
            onClick={() => setType('fadeblack')}
          >
            Fade black
          </button>
        </div>
      </div>
      {cur && (
        <Slider
          label="Duration"
          value={cur.duration}
          min={0.1}
          max={1.5}
          step={0.05}
          onCommitStart={beginInteraction}
          onChange={(v) => updateClip(clip.id, { transitionAfter: { ...cur, duration: v } }, false)}
        />
      )}
    </>
  )
}
