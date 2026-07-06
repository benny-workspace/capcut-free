import type { Clip, ColorAdjust, TextStyle, TransitionType } from '@shared/model'
import { MAIN_TRACK_ID, defaultColor } from '@shared/model'
import { FILTER_PRESETS, FONT_FAMILIES } from '../lib'
import { findClip, useEditor } from '../store'

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommitStart
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onCommitStart: () => void
}): React.JSX.Element {
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
      <span className="insp-value">{value.toFixed(2)}</span>
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
          {clip.kind === 'text' ? 'Text clip' : clip.kind === 'audio' ? 'Audio clip' : 'Clip'}
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
          </>
        )}

        {clip.kind !== 'audio' && (
          <>
            <div className="insp-section">Transform</div>
            <Slider label="X" value={t.x} min={-0.5} max={0.5} step={0.005} onCommitStart={beginInteraction} onChange={(v) => patchTransform({ x: v })} />
            <Slider label="Y" value={t.y} min={-0.5} max={0.5} step={0.005} onCommitStart={beginInteraction} onChange={(v) => patchTransform({ y: v })} />
            <Slider label="Scale" value={t.scale} min={0.05} max={3} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patchTransform({ scale: v })} />
            <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={1} onCommitStart={beginInteraction} onChange={(v) => patchTransform({ rotation: v })} />
            <Slider label="Opacity" value={t.opacity} min={0} max={1} step={0.01} onCommitStart={beginInteraction} onChange={(v) => patchTransform({ opacity: v })} />
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
