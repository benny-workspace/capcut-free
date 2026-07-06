# LocalCut

A free, fully-offline video editor for Windows. No cloud, no accounts, no telemetry —
everything (including the AI tools) runs on your machine.

## Opening the app

- **Start Menu**: press the Windows key, type **LocalCut**, hit Enter.
  To pin it: right-click it in *All apps* → *Pin to Start*.
- **Desktop**: double-click the **LocalCut** shortcut.
- Terminal (from this folder): `npx electron .`

Your project autosaves every 3 seconds and reopens automatically next launch.
**New** (top-left) starts a fresh project.

## What works today (all verified by automated tests)

**Editing**
- Magnetic multi-track timeline (main video, overlay, text, audio) — drag to move or reorder,
  edge-drag to trim, `S` split at playhead, `Del` delete, Ctrl+Z/Y undo/redo, Ctrl+wheel zoom, snapping
- Text clips with fonts, size, colors, outline, bold/italic (`T`)
- Picture-in-picture (PiP button on any media), transform (position/scale/rotation/opacity)
- **Keyframes** on transform properties — ◆ button next to each slider adds a keyframe at the
  playhead; edit a keyframed slider to auto-key; smooth eased interpolation
- Speed 0.25×–4× (pitch preserved), audio fade in/out, volume, mute
- Transitions between main-track clips: crossfade, fade-to-black
- Color: exposure/contrast/saturation/warmth + presets (Vivid, Warm, Cool, B&W, Film)
- **Chroma key** (green screen) with similarity/smoothness/spill controls
- **Masks**: rect / ellipse / linear with feather, rotation, invert
- **Adjustment layers** (◧ Adjust) — color-grade everything beneath them

**AI tools** (select a video clip → Inspector → *AI tools*; all local, no internet)
- ✂ **Silence cut** — removes dead air automatically
- 🎬 **Scene cut** — splits at camera/scene changes
- 💬 **Auto captions** — word-accurate captions via whisper.cpp (multilingual base model)
- 👤 **Remove BG** — AI portrait matting (MODNet); runs as an offline pass with progress,
  then toggles on/off per clip

**✨ Auto-Edit** (top bar) — pick clips, optional music, and a style:
- *Talking head*: silence-cut + auto captions + ducked music
- *Beat montage*: scene detection + cuts paced to the music's beat grid + crossfades
- *Short-form 9:16*: vertical, hook-style big captions
The result is a fully editable draft — Ctrl+Z reverts it.

**Export** — 720p/1080p/4K, 24/30/60 fps, bitrate control, watermark-free.
Uses Intel Quick Sync hardware encoding when available (verified working on this machine).
Projects using chroma key / masks / adjustment layers / keyframes automatically switch to the
GPU frame-pipe engine so the export is pixel-identical to the preview.

## Not implemented yet (honest list)

- LUT (.cube) import, video stabilization, motion tracking, sticker packs, template system
- Speed *curves* (constant speed only), audio waveform display on clips
- Style-learning database + Instagram performance sync (P5 of the plan)
- Webcam/screen recording with teleprompter (P6), one-file installer
- Karaoke word-highlight inside captions (word timings are already stored on each caption clip)
- Background removal for clips longer than 15 min (trim first); non-portrait matting is weaker —
  MODNet is a people/portrait model
- Sources Chromium can't decode (e.g. HEVC) preview and frame-pipe-export via a 720p proxy

## Performance notes (8 GB / iGPU laptop)

- Preview targets the project resolution; heavy stacks (many layers + effects) may drop frames —
  export is always full quality regardless
- AI passes are CPU-bound and run one model at a time by design: captions ≈ faster-than-realtime,
  background removal ≈ 2–6 fps of footage (progress shown)

## For development

```
npm install          # once
npm run dev          # hot-reload dev app
npm run typecheck    # TS both processes
npm run test:export  # headless: EDL -> FFmpeg export engines (x264 + QSV)
npm run test:tools   # headless: silence/scene/beats/whisper/BG-removal on real generated media
$env:LOCALCUT_SMOKE="1"; npx electron .   # full end-to-end: GL scene -> frame-pipe export -> ffprobe
```

Binaries live in `tools/` (FFmpeg 8.1.2, whisper.cpp + ggml-base-q5_1, MODNet ONNX). All open source:
FFmpeg (GPL build), whisper.cpp (MIT), MODNet (Apache-2.0), onnxruntime (MIT).
