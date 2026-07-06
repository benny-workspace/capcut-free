# LocalCut — Free, Fully-Offline CapCut-Class Video Editor

> Working name "LocalCut" (rename anytime). This is a CapCut Pro/Ultra **feature-equivalent** editor,
> not a branding clone — copying CapCut's name, logo, and pixel-exact UI would be a trademark/trade-dress
> problem. The layout will be the familiar one (media pool top-left, preview top-right, properties right,
> timeline bottom) with our own theme.

## 1. Ground rules

- **Zero cost, zero cloud.** Every dependency is open-source (MIT/BSD/Apache/GPL-tool-use) or a free
  static binary (FFmpeg). No API keys, no LLM calls, no telemetry.
- **Hardware budget (Dell Inspiron 15 3520):** i5-1235U (2P+8E, 12 threads), Intel UHD iGPU
  (Quick Sync available for HW encode/decode), 8 GB RAM, ~90 GB disk.
  - All AI models: quantized (int8) CPU/ONNX, loaded **one at a time**, lazily, unloaded after use.
  - Internal AI analysis resolution: 720p proxies. Editing/preview target: 1080p. Export: up to 4K
    (slow but works via Quick Sync).
  - Total model + toolchain disk footprint: ~6 GB.
- **Honesty about scope:** CapCut is built by a large ByteDance team; its generative Ultra features
  (text-to-video, AI avatars, generative expand, server-grade video upscaling) run on datacenter GPUs
  and are **physically impossible** on this laptop. Everything else has a local equivalent (see matrix).
  "Zero bugs" is not a thing in software this size; instead, every phase ends with the app launched
  and a real video rendered as the acceptance test.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell / UI | Electron + React + TypeScript + Vite | Fast iteration, WebGL/WebCodecs access |
| Timeline & preview render | Canvas/WebGL (custom) + WebCodecs for HW-accelerated decode | Real-time-ish 1080p preview on iGPU |
| Media probe/render/export | FFmpeg static build (gyan.dev), `h264_qsv`/`hevc_qsv` Quick Sync encode | Free, battle-tested, HW accel |
| AI worker | Python 3.11 venv sidecar, JSON-RPC over stdio/local HTTP | Best local-AI ecosystem |
| Speech-to-text (captions) | faster-whisper `small` int8 (CTranslate2) | Word-level timestamps, runs well on this CPU |
| Background removal / matting | Robust Video Matting (RVM) ONNX, 720p | Best quality/speed matting on CPU |
| Scene detection | PySceneDetect | Standard, fast |
| Silence / filler detection | energy + faster-whisper VAD | cheap |
| Audio denoise | FFmpeg `arnndn` (RNNoise) | built into FFmpeg, no extra model runtime |
| Beat detection (music sync) | librosa | standard |
| Content understanding / tagging | OpenCLIP ViT-B/32 int8 | clip-level tags: person/talking/outdoor/food/gaming… |
| Face detect / auto-reframe | MediaPipe / YuNet (OpenCV) | tiny, fast |
| Photo upscale | Real-ESRGAN ONNX (photos only) | video upscaling too slow on CPU — excluded |
| Frame interpolation (slow-mo) | RIFE ONNX — **experimental**, offline pass | slow on CPU, acceptable as background job |
| TTS (text-to-speech) | Piper TTS | free local voices (no voice *cloning* — too heavy) |
| Style/learning database | SQLite (better-sqlite3 + Python) | the compounding "brain" |

## 3. Architecture

```
electron-app/
  src/main/          # Electron main: windows, ffmpeg orchestration, sqlite, python worker mgmt
  src/renderer/      # React UI: media pool, preview, inspector, timeline, export, auto-edit wizard
  src/shared/        # Project model, EDL types, IPC contracts
ai-worker/           # Python sidecar (venv)
  server.py          # JSON-RPC: transcribe, matte, scenes, beats, tags, faces, upscale, interpolate
  models/            # downloaded once, cached
tools/ffmpeg/        # static ffmpeg + ffprobe
data/
  projects/          # project JSON (EDL), autosaves, proxies, caches
  style.db           # learning database
```

**Project model:** a project is a JSON Edit Decision List (EDL): tracks → clips → (source, in/out,
transform keyframes, effects, transitions, text/caption entities, audio envelope). Preview renders the
EDL live via WebCodecs+WebGL; export compiles the same EDL to an FFmpeg filtergraph (or frame-pipe for
effects FFmpeg can't express). One source of truth, no drift between preview and export.

## 4. Feature parity matrix (CapCut Pro/Ultra → LocalCut)

**Full parity (local):** multi-track magnetic timeline; split/ripple/roll/slip trim; speed curves &
reverse; keyframes (position/scale/rotation/opacity); transitions; text with animation presets &
styled templates; stickers/overlays (local pack + user imports); filters + LUT import + manual color
(exposure/contrast/temp/tint/HSL); chroma key; masks (shape + matting-based); picture-in-picture;
audio fade/ducking/denoise/extract/waveforms; adjustment layers; auto captions with word-level
karaoke styles; background removal & portrait matting; auto-reframe (9:16/1:1/16:9); silence/filler
removal; scene detection; beat-synced cuts; noise reduction; photo upscale; keyframe graph editor;
video stabilization (FFmpeg vid.stab); motion tracking (OpenCV CSRT — pin text/stickers/blur/PiP to a
moving subject); local template system (save any edit as a reusable template; ships with a starter
pack — note CapCut's *community* template library is cloud content and can't be mirrored);
project autosave/undo history; export presets incl. 4K, bitrate control, HW encoding.

**Non-negotiable core (user requirement):** auto silence cut, auto cut (scene/beat/take-aware),
auto captions, and auto background removal must all ship and must all be wired into Auto-Edit.

**Degraded but present:** frame interpolation slow-mo (offline background job, slow); "AI relight/
retouch" → conventional beauty/skin-smooth filters; voice effects → DSP (pitch/formant/reverb), not
neural voice clone; TTS → Piper's stock voices.

**Impossible on this hardware (excluded, stated up front):** text/image-to-video generation, AI
avatars, neural voice cloning, generative expand/inpaint, AI video upscaling, cloud stock library,
cloud sync/collab.

## 5. Auto-Edit pipeline (the centerpiece)

Input: raw clips (+ optional music track, + style template or "my style").

1. **Ingest & proxy** — ffprobe metadata, 720p proxy generation.
2. **Analysis pass** (each model loaded/unloaded serially to fit 8 GB):
   scene boundaries; speech transcript w/ word timing; VAD/silence & filler-word map; per-shot quality
   score (sharpness, exposure, shake); face/subject tracks; CLIP content tags per shot; music beat grid.
3. **EDL generation (rule engine, parameterized by style profile):**
   pick best takes (dedupe repeated takes via transcript similarity + quality score); cut dead air &
   fillers; pace cuts to beat grid (montage) or sentence boundaries (talking-head); order shots
   (chronological / energy-arc); apply per-style caption template, transitions, color preset, bg-removal
   where the style calls for it (e.g., talking-head over b-roll); duck music under speech; hook-first
   opening for short-form styles.
4. **Draft lands on the timeline** — fully editable, nothing destructive.
5. **Every manual correction is captured** as a delta vs. the generated EDL → feeds §6.

Built-in style templates to start: Talking-head/tutorial, Vlog, Beat montage, Gaming highlights,
Short-form (9:16 hook-cut-caption) — each is just a parameter set the learning system can drift.

## 6. Style learning ("compounding brain") — no LLM, pure local statistics

SQLite `style.db`:
- `sessions(id, date, style_template, content_tags)`
- `deltas(session, kind, before, after)` — cut moved/added/removed, caption restyled, transition swapped,
  music level changed, color changed, clip reordered…
- `style_params(key, value, confidence, n_observations)` — e.g. `avg_cut_len.montage=1.8s`,
  `caption.font=…`, `caption.position=bottom-center`, `transition.pref=whip>cross`, `music_duck_db=-14`,
  `filler_removal=aggressive`, per-content-type overrides keyed by CLIP tags.

Learning = exponentially-weighted updates of `style_params` from deltas (recent edits matter more),
with confidence gating (a preference is only auto-applied after N consistent observations). The
auto-edit rule engine reads `style_params` first, template defaults second — so every project you
correct makes the next draft closer to what you'd have done. A "Style report" panel shows what it has
learned and lets you pin/reset any parameter. This is honest preference learning: it will genuinely
converge on your pacing, caption look, transition taste, and structure per content type; it does not
"understand" narratives the way a cloud LLM would.

### 6b. Performance feedback loop (optional online module — Instagram Graph API)

Editing stays fully offline; this is an opt-in sync job. It uses the **official Instagram Graph API**
(free; requires the user's IG account switched to Creator/Business and a free Meta developer app —
one-time ~30 min setup, no recurring cost). No scraping, no community "Instagram MCPs" (ToS risk,
unreliable).

- New tables: `posts(project_id, platform, media_id, posted_at)` and
  `metrics(post_id, ts, views, reach, likes, comments, saves, shares)` — snapshots over time so
  early velocity vs. long-tail can be distinguished.
- On export, LocalCut fingerprints the project's edit parameters (duration, hook length, cut pace,
  caption style, color preset, content tags). After posting, the sync job matches the IG media to the
  export and appends metric snapshots.
- Learning: weighted correlation of edit parameters vs. engagement outcomes, with **small-sample
  damping** — under ~20 posts the signal is treated as a nudge on `style_params` (low confidence),
  never a rule. The Style report shows "learned from my edits" vs. "learned from performance"
  separately, and each is pin/reset-able.

## 6c. MCP decision log

- User rule: connect MCPs only if completely free.
- **Perplexity MCP: excluded** — requires a paid Sonar API key (no free tier). Marginal value for a
  video editor anyway.
- **Instagram: no official MCP exists**; community ones are scrapers. Replaced by the native Graph
  API integration in §6b, which is the better architecture (MCP connects tools to an AI assistant;
  the app needs the data directly, permanently).
- Optional, dev-time only: a free no-API-key web-search MCP can be added to Claude Code later if
  trend context during template design ever seems useful. Revisit at P4; not part of the app.

## 7. Phase roadmap (each phase = runnable app + rendered-video acceptance test)

- **P0 — Scaffold:** Electron+React boots; FFmpeg fetched & detected; import media; play a clip. 
- **P1 — Editor MVP:** multi-track timeline, split/trim/move/snap, text layer, volume, undo, autosave,
  1080p Quick Sync export. *Test: cut 3 clips together with a title and export.*
- **P2 — Manual parity:** keyframes, transitions, speed curves, filters/LUT/color, chroma key, masks,
  PiP, audio suite, sticker/animation presets, adjustment layers, export presets.
- **P3 — AI tools:** Python worker; captions, bg removal, scene detect, silence cut, denoise, beats,
  auto-reframe, photo upscale, (exp.) RIFE. Each exposed as a normal editor tool.
- **P4 — Auto-Edit:** full pipeline §5 with the 5 style templates.
- **P5 — Compounding:** delta capture, style.db, learned parameterization, Style report UI, plus the
  Instagram Graph API performance sync and correlation learning (§6b).
- **P6 — Polish/packaging:** installer (electron-builder), perf passes, crash recovery, webcam/screen
  recording with teleprompter overlay.

Order of implementation risk: preview engine (P1) and the EDL→FFmpeg export compiler are the two
hardest components; both are front-loaded deliberately.

## 8. Known risks on this machine

- 8 GB RAM: Electron + Chromium + a loaded model is tight → strict one-model-at-a-time policy,
  720p proxies mandatory, models int8.
- iGPU preview: complex stacks (many layers + effects) may drop below realtime → background-rendered
  preview cache for heavy sections (same trick CapCut uses).
- RVM matting on CPU ≈ 2–6 fps processing → bg removal runs as an offline pass with a progress bar,
  not live.
- CPU-only RIFE/ESRGAN are minutes-per-second-of-video → photos-only upscale, interpolation flagged
  experimental.
