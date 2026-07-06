"use strict";
const electron = require("electron");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const child_process = require("child_process");
const isNeutralColor = (c) => !c || c.exposure === 0 && c.contrast === 0 && c.saturation === 0 && c.temperature === 0;
function projectDuration(project) {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
}
const f = (n) => (Math.round(n * 1e3) / 1e3).toString();
const even = (n) => Math.max(2, 2 * Math.round(n / 2));
function atempoChain(speed) {
  if (speed === 1) return [];
  const parts = [];
  let s = speed;
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s *= 2;
  }
  parts.push(`atempo=${f(s)}`);
  return parts;
}
function colorFilters(clip) {
  const c = clip.color;
  if (!c || isNeutralColor(c)) return [];
  const parts = [];
  const eq = [];
  if (c.contrast !== 0) eq.push(`contrast=${f(1 + c.contrast)}`);
  if (c.saturation !== 0) eq.push(`saturation=${f(Math.max(0, 1 + c.saturation))}`);
  if (c.exposure !== 0) eq.push(`brightness=${f(c.exposure * 0.25)}`);
  if (eq.length > 0) parts.push("eq=" + eq.join(":"));
  if (c.temperature !== 0) {
    parts.push(`colortemperature=temperature=${Math.round(6500 - c.temperature * 2600)}`);
  }
  return parts;
}
function collectTransitionFades(project) {
  const map = /* @__PURE__ */ new Map();
  const get = (id) => {
    let v = map.get(id);
    if (!v) {
      v = {};
      map.set(id, v);
    }
    return v;
  };
  for (const track of project.tracks) {
    if (track.kind !== "video") continue;
    const clips = [...track.clips].sort((x, y) => x.start - y.start);
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const overlap = a.start + a.duration - b.start;
      if (overlap <= 1e-3) continue;
      const type = a.transitionAfter?.type ?? "cross";
      if (type === "cross") {
        get(b.id).vin = { st: b.start, d: overlap };
      } else {
        get(a.id).vout = { st: b.start, d: overlap / 2 };
        get(b.id).vin = { st: b.start + overlap / 2, d: overlap / 2 };
      }
      get(a.id).aout = { st: a.duration - overlap, d: overlap };
      get(b.id).ain = { st: 0, d: overlap };
    }
  }
  return map;
}
function audioFades(clip, trans) {
  const parts = [];
  const fi = Math.max(clip.fadeIn ?? 0, 0);
  const fo = Math.max(clip.fadeOut ?? 0, 0);
  if (fi > 0) parts.push(`afade=t=in:st=0:d=${f(fi)}`);
  if (fo > 0) parts.push(`afade=t=out:st=${f(Math.max(0, clip.duration - fo))}:d=${f(fo)}`);
  if (trans?.ain) parts.push(`afade=t=in:st=${f(trans.ain.st)}:d=${f(trans.ain.d)}`);
  if (trans?.aout) parts.push(`afade=t=out:st=${f(trans.aout.st)}:d=${f(trans.aout.d)}`);
  return parts;
}
function appendAudioChain(filters, audioLabels, idx, clip, trans) {
  const speed = clip.speed || 1;
  const aLabel = `a${audioLabels.length}`;
  const delayMs = Math.max(0, Math.round(clip.start * 1e3));
  const parts = [
    `atrim=start=${f(clip.in)}:end=${f(clip.in + clip.duration * speed)}`,
    "asetpts=PTS-STARTPTS",
    ...atempoChain(speed),
    ...audioFades(clip, trans),
    `volume=${f(clip.volume)}`,
    "aresample=48000",
    `adelay=${delayMs}:all=1`
  ];
  filters.push(`[${idx}:a]${parts.join(",")}[${aLabel}]`);
  audioLabels.push(aLabel);
}
function fitRect(srcW, srcH, outW, outH, clip) {
  const t = clip.transform;
  const base = Math.min(outW / srcW, outH / srcH);
  const w = even(srcW * base * t.scale);
  const h = even(srcH * base * t.scale);
  const x = Math.round((outW - w) / 2 + t.x * outW);
  const y = Math.round((outH - h) / 2 + t.y * outH);
  return { w, h, x, y };
}
function buildExportArgs(project, settings, textPngs) {
  const W = settings.width;
  const H = settings.height;
  const dur = Math.max(projectDuration(project), 0.1);
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const pngByClip = new Map(textPngs.map((t) => [t.clipId, t.pngPath]));
  const inputArgs = [];
  let inputCount = 0;
  const filters = [];
  const audioLabels = [];
  const visualClips = [];
  for (const track of project.tracks) {
    if (track.kind === "video" || track.kind === "overlay") {
      visualClips.push(...[...track.clips].sort((a, b) => a.start - b.start));
    }
  }
  for (const track of project.tracks) {
    if (track.kind === "text") {
      visualClips.push(...[...track.clips].sort((a, b) => a.start - b.start));
    }
  }
  const audioOnlyClips = [];
  for (const track of project.tracks) {
    if (track.kind === "audio" && !track.muted) {
      audioOnlyClips.push(...track.clips);
    }
  }
  filters.push(`color=c=black:s=${W}x${H}:r=${settings.fps}:d=${f(dur)}[bg]`);
  let lastVideo = "bg";
  let overlayIdx = 0;
  const addOverlay = (srcLabel, clip, rect) => {
    const en = `enable='between(t,${f(clip.start)},${f(clip.start + clip.duration)})'`;
    const next = `ov${overlayIdx++}`;
    filters.push(
      `[${lastVideo}][${srcLabel}]overlay=x=${rect.x}:y=${rect.y}:${en}[${next}]`
    );
    lastVideo = next;
  };
  const transFades = collectTransitionFades(project);
  const alphaChain = (clip) => {
    const parts = [...colorFilters(clip), "format=rgba"];
    if (clip.transform.rotation) {
      const rad = clip.transform.rotation * Math.PI / 180;
      parts.push(`rotate=${f(rad)}:c=black@0:ow=rotw(${f(rad)}):oh=roth(${f(rad)})`);
    }
    if (clip.transform.opacity < 1) {
      parts.push(`colorchannelmixer=aa=${f(clip.transform.opacity)}`);
    }
    return parts.join(",");
  };
  const transitionVideoFades = (clip) => {
    const t = transFades.get(clip.id);
    const parts = [];
    if (t?.vin) parts.push(`fade=t=in:st=${f(t.vin.st)}:d=${f(t.vin.d)}:alpha=1`);
    if (t?.vout) parts.push(`fade=t=out:st=${f(t.vout.st)}:d=${f(t.vout.d)}:alpha=1`);
    return parts;
  };
  const audioChain = (idx, clip) => appendAudioChain(filters, audioLabels, idx, clip, transFades.get(clip.id));
  let vLabel = 0;
  for (const clip of visualClips) {
    if (clip.kind === "video") {
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : void 0;
      if (!media) continue;
      inputArgs.push("-i", media.path);
      const idx = inputCount++;
      const speed = clip.speed || 1;
      const rect = fitRect(media.width || W, media.height || H, W, H, clip);
      const label = `v${vLabel++}`;
      const chain = [
        `trim=start=${f(clip.in)}:end=${f(clip.in + clip.duration * speed)}`,
        `setpts=(PTS-STARTPTS)/${f(speed)}+${f(clip.start)}/TB`,
        `scale=${rect.w}:${rect.h}`,
        alphaChain(clip),
        ...transitionVideoFades(clip)
      ];
      filters.push(`[${idx}:v]${chain.join(",")}[${label}]`);
      addOverlay(label, clip, rect);
      if (media.hasAudio && !clip.muted && clip.volume > 0) {
        audioChain(idx, clip);
      }
    } else if (clip.kind === "image" || clip.kind === "text") {
      const path2 = clip.kind === "text" ? pngByClip.get(clip.id) : clip.mediaId ? mediaById.get(clip.mediaId)?.path : void 0;
      if (!path2) continue;
      inputArgs.push("-loop", "1", "-t", f(clip.duration + 0.5), "-i", path2);
      const idx = inputCount++;
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : void 0;
      const rect = clip.kind === "text" ? { w: W, h: H, x: 0, y: 0 } : fitRect(media?.width || W, media?.height || H, W, H, clip);
      const label = `v${vLabel++}`;
      const chain = [
        `scale=${rect.w}:${rect.h}`,
        clip.kind === "text" ? "format=rgba" : alphaChain(clip),
        `setpts=PTS-STARTPTS+${f(clip.start)}/TB`,
        ...transitionVideoFades(clip)
      ];
      filters.push(`[${idx}:v]${chain.join(",")}[${label}]`);
      addOverlay(label, clip, rect);
    }
  }
  for (const clip of audioOnlyClips) {
    const media = clip.mediaId ? mediaById.get(clip.mediaId) : void 0;
    if (!media || clip.muted || clip.volume <= 0) continue;
    inputArgs.push("-i", media.path);
    audioChain(inputCount++, clip);
  }
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f(dur)}[abase]`);
  if (audioLabels.length > 0) {
    filters.push(
      `[abase]${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0[aout]`
    );
  } else {
    filters.push(`[abase]anull[aout]`);
  }
  filters.push(`[${lastVideo}]format=yuv420p[vout]`);
  const enc = settings.encoder === "qsv" ? ["-c:v", "h264_qsv", "-b:v", `${settings.vBitrateK}k`, "-maxrate", `${Math.round(settings.vBitrateK * 1.5)}k`] : ["-c:v", "libx264", "-preset", "fast", "-b:v", `${settings.vBitrateK}k`];
  return [
    "-y",
    "-hide_banner",
    ...inputArgs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...enc,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    f(dur),
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    settings.outPath
  ];
}
function buildFramePipeArgs(project, settings) {
  const dur = Math.max(projectDuration(project), 0.1);
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const transFades = collectTransitionFades(project);
  const inputArgs = [];
  const filters = [];
  const audioLabels = [];
  let inputCount = 1;
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video" && clip.kind !== "audio") continue;
      if (clip.muted || clip.volume <= 0) continue;
      const media = clip.mediaId ? mediaById.get(clip.mediaId) : void 0;
      if (!media || !media.hasAudio) continue;
      inputArgs.push("-i", media.path);
      appendAudioChain(filters, audioLabels, inputCount++, clip, transFades.get(clip.id));
    }
  }
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f(dur)}[abase]`);
  if (audioLabels.length > 0) {
    filters.push(
      `[abase]${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0[aout]`
    );
  } else {
    filters.push(`[abase]anull[aout]`);
  }
  filters.push(`[0:v]vflip,format=yuv420p[vout]`);
  const enc = settings.encoder === "qsv" ? ["-c:v", "h264_qsv", "-b:v", `${settings.vBitrateK}k`, "-maxrate", `${Math.round(settings.vBitrateK * 1.5)}k`] : ["-c:v", "libx264", "-preset", "fast", "-b:v", `${settings.vBitrateK}k`];
  return [
    "-y",
    "-hide_banner",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-video_size",
    `${settings.width}x${settings.height}`,
    "-framerate",
    String(settings.fps),
    "-i",
    "pipe:0",
    ...inputArgs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...enc,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    f(dur),
    "-movflags",
    "+faststart",
    settings.outPath
  ];
}
function appRoot() {
  return electron.app.getAppPath();
}
function toolsDir() {
  return path.join(appRoot(), "tools", "ffmpeg");
}
function ffmpegPath() {
  const p = path.join(toolsDir(), "ffmpeg.exe");
  return fs.existsSync(p) ? p : "ffmpeg";
}
function ffprobePath() {
  const p = path.join(toolsDir(), "ffprobe.exe");
  return fs.existsSync(p) ? p : "ffprobe";
}
function run(exe, args, timeoutMs = 12e4) {
  return new Promise((resolve) => {
    const child = child_process.spawn(exe, args, { windowsHide: true });
    const out = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err += d.toString());
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}
const VIDEO_EXT = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".ts", ".3gp", ".flv"];
const AUDIO_EXT = [".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus", ".wma"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];
function mediaTypeFor(file) {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (IMAGE_EXT.includes(ext)) return "image";
  return null;
}
const MEDIA_FILTERS = [
  { name: "Media", extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => e.slice(1)) },
  { name: "Video", extensions: VIDEO_EXT.map((e) => e.slice(1)) },
  { name: "Audio", extensions: AUDIO_EXT.map((e) => e.slice(1)) },
  { name: "Images", extensions: IMAGE_EXT.map((e) => e.slice(1)) }
];
const PLAYABLE_VCODECS = ["h264", "vp8", "vp9", "av1"];
async function probeMedia(file, id) {
  const type = mediaTypeFor(file);
  if (!type) return null;
  const name = file.replace(/\\/g, "/").split("/").pop() || file;
  if (type === "image") {
    const r2 = await run(ffprobePath(), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      file
    ]);
    let width, height;
    try {
      const j = JSON.parse(r2.stdout.toString());
      const v = (j.streams || []).find((s) => s.codec_type === "video");
      width = v?.width;
      height = v?.height;
    } catch {
    }
    return { id, path: file, name, type, duration: 4, width, height, hasAudio: false };
  }
  const r = await run(ffprobePath(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file
  ]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout.toString());
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const a = (j.streams || []).find((s) => s.codec_type === "audio");
    const duration = parseFloat(j.format?.duration ?? v?.duration ?? a?.duration ?? "0");
    let fps;
    if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
      const [n, d] = v.avg_frame_rate.split("/").map(Number);
      if (d > 0) fps = n / d;
    }
    if (type === "video" && !v) return null;
    return {
      id,
      path: file,
      name,
      type,
      duration: isFinite(duration) && duration > 0 ? duration : 0,
      width: v?.width,
      height: v?.height,
      fps,
      hasAudio: !!a,
      vcodec: v?.codec_name,
      acodec: a?.codec_name
    };
  } catch {
    return null;
  }
}
function needsProxy(item) {
  if (item.type !== "video") return false;
  return !PLAYABLE_VCODECS.includes(item.vcodec || "");
}
async function thumbnailDataUrl(file, at, isImage) {
  const args = isImage ? ["-i", file, "-frames:v", "1", "-vf", "scale=168:-2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"] : ["-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=168:-2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
  const r = await run(ffmpegPath(), args, 3e4);
  if (r.code !== 0 || r.stdout.length === 0) return void 0;
  return "data:image/jpeg;base64," + r.stdout.toString("base64");
}
async function makeProxy(src, dest) {
  const r = await run(
    ffmpegPath(),
    [
      "-y",
      "-i",
      src,
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      dest
    ],
    6e5
  );
  return r.code === 0;
}
let qsvCache = null;
async function detectQsv() {
  if (qsvCache !== null) return qsvCache;
  const r = await run(
    ffmpegPath(),
    ["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.3", "-c:v", "h264_qsv", "-f", "null", "-"],
    6e4
  );
  qsvCache = r.code === 0;
  return qsvCache;
}
async function ffmpegVersion() {
  const r = await run(ffmpegPath(), ["-version"], 15e3);
  if (r.code !== 0) return void 0;
  return r.stdout.toString().split("\n")[0]?.trim();
}
function dataDir() {
  return path.join(appRoot(), "data");
}
function projectsDir() {
  return path.join(dataDir(), "projects");
}
function cacheDir() {
  return path.join(dataDir(), "cache");
}
function proxiesDir() {
  return path.join(cacheDir(), "proxies");
}
async function ensureDataDirs() {
  await fs.promises.mkdir(projectsDir(), { recursive: true });
  await fs.promises.mkdir(proxiesDir(), { recursive: true });
}
const lastPointer = () => path.join(dataDir(), "last-project.txt");
async function saveProject(project) {
  project.modifiedAt = (/* @__PURE__ */ new Date()).toISOString();
  const file = path.join(projectsDir(), `${project.id}.json`);
  const tmp = file + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(project, null, 1), "utf8");
  await fs.promises.rename(tmp, file).catch(async () => {
    await fs.promises.copyFile(tmp, file);
    await fs.promises.unlink(tmp).catch(() => {
    });
  });
  await fs.promises.writeFile(lastPointer(), project.id, "utf8");
}
async function loadLastProject() {
  try {
    const id = (await fs.promises.readFile(lastPointer(), "utf8")).trim();
    const raw = await fs.promises.readFile(path.join(projectsDir(), `${id}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
let current = null;
function cancelExport() {
  if (current) {
    current.kill("SIGKILL");
    current = null;
  }
}
async function writeTextPngs(pngs) {
  const dir = path.join(cacheDir(), "export-text");
  await fs.promises.mkdir(dir, { recursive: true });
  const out = [];
  for (const p of pngs) {
    const b64 = p.dataUrl.split(",")[1];
    if (!b64) continue;
    const file = path.join(dir, `${p.clipId}.png`);
    await fs.promises.writeFile(file, Buffer.from(b64, "base64"));
    out.push({ clipId: p.clipId, pngPath: file });
  }
  return out;
}
function runFfmpeg(args, durationSec, sender) {
  return new Promise((resolve) => {
    const child = child_process.spawn(ffmpegPath(), args, { windowsHide: true });
    current = child;
    let log = "";
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && durationSec > 0) {
          const ratio = Math.min(0.999, parseInt(m[1]) / 1e6 / durationSec);
          sender.send("export:progress", { ratio, phase: "encoding" });
        }
      }
    });
    child.stderr.on("data", (d) => {
      log += d.toString();
      if (log.length > 6e4) log = log.slice(-4e4);
    });
    child.on("error", (e) => {
      current = null;
      resolve({ code: -1, log: log + "\nspawn error: " + e.message });
    });
    child.on("close", (code) => {
      current = null;
      resolve({ code, log });
    });
  });
}
let pipe = null;
async function framePipeStart(project, settings) {
  if (pipe) {
    pipe.child.kill("SIGKILL");
    pipe = null;
  }
  try {
    const encoder = settings.encoder === "auto" ? await detectQsv() ? "qsv" : "x264" : settings.encoder;
    const args = buildFramePipeArgs(project, { ...settings, encoder });
    const child = child_process.spawn(ffmpegPath(), args, { windowsHide: true });
    let log = "";
    child.stderr.on("data", (d) => {
      log += d.toString();
      if (log.length > 6e4) log = log.slice(-4e4);
    });
    child.stdin.on("error", () => {
    });
    child.on("error", (e) => {
      log += "\nspawn error: " + e.message;
    });
    const closed = new Promise((resolve) => child.on("close", resolve));
    pipe = { child, getLog: () => log, closed };
    return { ok: true, encoder };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function framePipeFrame(buf) {
  const child = pipe?.child;
  if (!child || !child.stdin || child.stdin.destroyed || child.exitCode !== null) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const ok = child.stdin.write(Buffer.from(buf), (err) => {
      if (err) resolve(false);
    });
    if (ok) resolve(true);
    else child.stdin.once("drain", () => resolve(true));
  });
}
async function framePipeEnd() {
  if (!pipe) return { ok: false, error: "no active frame-pipe export" };
  const session = pipe;
  pipe = null;
  session.child.stdin?.end();
  const code = await session.closed;
  if (code !== 0) {
    return { ok: false, error: session.getLog().split("\n").slice(-15).join("\n") };
  }
  return { ok: true };
}
function framePipeCancel() {
  if (pipe) {
    pipe.child.kill("SIGKILL");
    pipe = null;
  }
}
async function runExport(sender, project, settings, textPngs) {
  try {
    sender.send("export:progress", { ratio: 0, phase: "preparing" });
    const pngFiles = await writeTextPngs(textPngs);
    const dur = Math.max(projectDuration(project), 0.1);
    let encoder = settings.encoder === "auto" ? await detectQsv() ? "qsv" : "x264" : settings.encoder;
    let args = buildExportArgs(project, { ...settings, encoder }, pngFiles);
    let r = await runFfmpeg(args, dur, sender);
    if (r.code !== 0 && encoder === "qsv") {
      encoder = "x264";
      args = buildExportArgs(project, { ...settings, encoder }, pngFiles);
      r = await runFfmpeg(args, dur, sender);
    }
    if (r.code !== 0) {
      const tail = r.log.split("\n").slice(-15).join("\n");
      sender.send("export:progress", { ratio: 0, phase: "error", message: tail });
      return { ok: false, error: tail };
    }
    sender.send("export:progress", { ratio: 1, phase: "done" });
    return { ok: true, encoderUsed: encoder === "qsv" ? "h264_qsv (Quick Sync)" : "libx264", outPath: settings.outPath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sender.send("export:progress", { ratio: 0, phase: "error", message: msg });
    return { ok: false, error: msg };
  }
}
const SMOKE = !!process.env.LOCALCUT_SMOKE;
electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);
function mimeFor(p) {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif"
  };
  return map[ext] || "application/octet-stream";
}
function registerMediaProtocol() {
  electron.protocol.handle("media", async (request) => {
    try {
      const u = new URL(request.url);
      let p = decodeURIComponent(u.pathname);
      if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      const stat = await fs.promises.stat(p);
      const mime = mimeFor(p);
      const range = request.headers.get("range");
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1]) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2]), stat.size - 1) : stat.size - 1;
        const stream2 = fs.createReadStream(p, { start, end });
        return new Response(stream.Readable.toWeb(stream2), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
            "Content-Type": mime
          }
        });
      }
      const stream$1 = fs.createReadStream(p);
      return new Response(stream.Readable.toWeb(stream$1), {
        status: 200,
        headers: {
          "Content-Length": String(stat.size),
          "Accept-Ranges": "bytes",
          "Content-Type": mime
        }
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
async function smokeSetupAssets() {
  const dir = path.join(cacheDir(), "smoke");
  await fs.promises.mkdir(dir, { recursive: true });
  const basePath = path.join(dir, "base.mp4");
  const greenPath = path.join(dir, "green.mp4");
  const outPath = path.join(dir, "out.mp4");
  if (!fs.existsSync(basePath)) {
    await run(ffmpegPath(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-shortest",
      basePath
    ]);
  }
  if (!fs.existsSync(greenPath)) {
    await run(ffmpegPath(), [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x00D000:s=640x360:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x120:r=30:d=4",
      "-filter_complex",
      "[0][1]overlay=x=60+t*80:y=120",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-t",
      "4",
      greenPath
    ]);
  }
  return { basePath, greenPath, outPath };
}
async function verifySmokeExport(outPath) {
  const p = await run(ffprobePath(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    outPath
  ]);
  if (p.code !== 0) {
    console.error("SMOKE VERIFY: ffprobe failed on " + outPath);
    return false;
  }
  try {
    const j = JSON.parse(p.stdout.toString());
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const a = (j.streams || []).find((s) => s.codec_type === "audio");
    const dur = parseFloat(j.format?.duration ?? "0");
    console.log(
      `SMOKE VERIFY dur=${dur.toFixed(2)}s video=${v ? `${v.width}x${v.height} ${v.codec_name}` : "none"} audio=${a ? a.codec_name : "none"}`
    );
    if (!v || !a) return false;
    if (Math.abs(dur - 4) > 0.4) return false;
    await run(ffmpegPath(), [
      "-y",
      "-ss",
      "2",
      "-i",
      outPath,
      "-frames:v",
      "1",
      path.join(appRoot(), "smoke-export-frame.png")
    ]);
    return true;
  } catch {
    return false;
  }
}
let win = null;
let mediaSeq = 0;
const proxyQueue = [];
let proxyRunning = false;
async function pumpProxyQueue() {
  if (proxyRunning) return;
  proxyRunning = true;
  while (proxyQueue.length > 0) {
    const item = proxyQueue.shift();
    const dest = path.join(proxiesDir(), `${item.id}.mp4`);
    const ok = await makeProxy(item.path, dest);
    if (ok && win && !win.isDestroyed()) {
      win.webContents.send("media:proxy-ready", { mediaId: item.id, proxyPath: dest });
    }
  }
  proxyRunning = false;
}
function registerIpc() {
  electron.ipcMain.handle("dialog:open-media", async () => {
    if (SMOKE) {
      console.log("[smoke] open-media dialog invoked");
      return [];
    }
    if (!win) return [];
    const r = await electron.dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: MEDIA_FILTERS
    });
    return r.canceled ? [] : r.filePaths;
  });
  electron.ipcMain.handle("dialog:save-path", async (_e, defaultName) => {
    if (!win) return null;
    const r = await electron.dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }]
    });
    return r.canceled ? null : r.filePath;
  });
  electron.ipcMain.handle("media:ingest", async (_e, paths) => {
    const items = [];
    for (const p of paths) {
      const id = "m" + Date.now().toString(36) + (mediaSeq++).toString(36);
      const item = await probeMedia(p, id);
      if (!item) continue;
      item.thumbnail = await thumbnailDataUrl(
        p,
        Math.min(0.5, (item.duration || 1) / 2),
        item.type === "image"
      );
      if (needsProxy(item)) {
        proxyQueue.push(item);
        void pumpProxyQueue();
      }
      items.push(item);
    }
    return items;
  });
  electron.ipcMain.handle("project:save", async (_e, project) => {
    if (SMOKE) return true;
    await saveProject(project);
    return true;
  });
  electron.ipcMain.handle("project:load-last", async () => loadLastProject());
  electron.ipcMain.handle(
    "export:run",
    async (e, project, settings, textPngs) => runExport(e.sender, project, settings, textPngs)
  );
  electron.ipcMain.handle("export:cancel", () => cancelExport());
  electron.ipcMain.handle(
    "export2:start",
    (_e, project, settings) => framePipeStart(project, settings)
  );
  electron.ipcMain.handle("export2:frame", (_e, buf) => framePipeFrame(buf));
  electron.ipcMain.handle("export2:end", () => framePipeEnd());
  electron.ipcMain.handle("export2:cancel", () => framePipeCancel());
  electron.ipcMain.handle("smoke:setup", async () => {
    if (!SMOKE) throw new Error("smoke:setup is only available in smoke mode");
    return smokeSetupAssets();
  });
  electron.ipcMain.handle("sys:info", async () => {
    const version = await ffmpegVersion();
    return {
      ffmpegFound: !!version,
      qsv: version ? await detectQsv() : false,
      ffmpegVersion: version
    };
  });
  electron.ipcMain.handle("shell:show-item", (_e, path2) => electron.shell.showItemInFolder(path2));
}
function createWindow() {
  win = new electron.BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#101014",
    show: false,
    autoHideMenuBar: true,
    title: "LocalCut",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.once("ready-to-show", () => SMOKE ? win?.showInactive() : win?.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL + (SMOKE ? "?smoke=1" : ""));
  } else {
    void win.loadFile(
      path.join(__dirname, "../renderer/index.html"),
      SMOKE ? { query: { smoke: "1" } } : void 0
    );
  }
  if (SMOKE) {
    win.webContents.on("console-message", (event) => {
      const { level, message } = event;
      if (level === "warning" || level === "error") console.log("[renderer]", message);
      if (!message.startsWith("SMOKE-RESULT ")) return;
      void (async () => {
        let pass = false;
        try {
          const result = JSON.parse(message.slice("SMOKE-RESULT ".length));
          if (result.ok) pass = await verifySmokeExport(path.join(cacheDir(), "smoke", "out.mp4"));
        } catch (e) {
          console.error("SMOKE verify error", e);
        }
        try {
          const img = await win.webContents.capturePage();
          const out = process.env.LOCALCUT_SMOKE_OUT || path.join(appRoot(), "smoke.png");
          await fs.promises.writeFile(out, img.toPNG());
          console.log("SMOKE screenshot -> " + out);
        } catch (e) {
          console.error("SMOKE screenshot failed", e);
        }
        console.log(pass ? "SMOKE OK" : "SMOKE FAILED");
        electron.app.exit(pass ? 0 : 1);
      })();
    });
    setTimeout(() => {
      console.error("SMOKE TIMEOUT");
      electron.app.exit(1);
    }, 15e4);
  }
}
electron.app.whenReady().then(async () => {
  await ensureDataDirs();
  registerMediaProtocol();
  registerIpc();
  console.log("[localcut] ffmpeg at:", ffmpegPath());
  createWindow();
});
electron.app.on("window-all-closed", () => {
  electron.app.quit();
});
