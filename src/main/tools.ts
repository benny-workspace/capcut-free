// Analysis tools backing the auto features. No Python: FFmpeg does silence
// and scene detection, beat detection is a JS onset detector over raw PCM,
// and captions come from a local whisper.cpp binary + quantized ggml model.

import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { cpus } from 'os'
import { join } from 'path'
import { appRoot, ffmpegPath, run } from './ffmpeg'
import { cacheDir } from './projects'

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString()

// ---------- silence detection ----------

export interface SilenceRange {
  start: number // seconds relative to the analyzed range start
  end: number
}

export async function detectSilence(
  path: string,
  start: number,
  duration: number,
  noiseDb = -35,
  minSilence = 0.4
): Promise<SilenceRange[]> {
  const r = await run(ffmpegPath(), [
    '-ss', f(start), '-t', f(duration), '-i', path,
    '-af', `silencedetect=n=${noiseDb}dB:d=${f(minSilence)}`,
    '-f', 'null', '-'
  ], 600000)
  const out: SilenceRange[] = []
  let cur: number | null = null
  for (const line of r.stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) cur = Math.max(0, parseFloat(s[1]))
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (e && cur !== null) {
      out.push({ start: cur, end: Math.min(duration, parseFloat(e[1])) })
      cur = null
    }
  }
  if (cur !== null) out.push({ start: cur, end: duration }) // silence runs to the end
  return out
}

// ---------- scene detection ----------

/** Returns scene-change times (seconds, relative to the analyzed range start). */
export async function detectScenes(
  path: string,
  start: number,
  duration: number,
  threshold = 0.3
): Promise<number[]> {
  const r = await run(ffmpegPath(), [
    '-ss', f(start), '-t', f(duration), '-i', path,
    '-vf', `select='gt(scene,${f(threshold)})',showinfo`,
    '-f', 'null', '-'
  ], 900000)
  const times: number[] = []
  for (const line of r.stderr.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue
    const m = /pts_time:\s*([\d.]+)/.exec(line)
    if (m) {
      const t = parseFloat(m[1])
      if (t > 0.2 && t < duration - 0.2) times.push(t)
    }
  }
  return times
}

// ---------- beat detection (spectral-energy onset picking) ----------

export interface BeatResult {
  beats: number[] // seconds
  bpm: number
}

export function detectBeats(path: string): Promise<BeatResult> {
  const SR = 22050
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath(),
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'],
      { windowsHide: true }
    )
    const chunks: Buffer[] = []
    let total = 0
    const MAX = SR * 2 * 60 * 12 // cap at 12 minutes of PCM
    child.stdout.on('data', (d: Buffer) => {
      if (total < MAX) {
        chunks.push(d)
        total += d.length
      }
    })
    child.on('close', () => {
      const pcm = Buffer.concat(chunks)
      const n = Math.floor(pcm.length / 2)
      const hop = 512
      const frames = Math.floor(n / hop) - 1
      if (frames < 8) return resolve({ beats: [], bpm: 0 })

      // energy per hop, then positive flux
      const energy = new Float64Array(frames)
      for (let i = 0; i < frames; i++) {
        let e = 0
        const base = i * hop
        for (let j = 0; j < hop; j++) {
          const v = pcm.readInt16LE((base + j) * 2) / 32768
          e += v * v
        }
        energy[i] = e
      }
      const flux = new Float64Array(frames)
      for (let i = 1; i < frames; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1])

      // adaptive threshold: local mean over ~1s * factor
      const w = Math.round(SR / hop) // ~43 frames = 1s
      const beats: number[] = []
      let last = -1
      for (let i = 2; i < frames - 2; i++) {
        let sum = 0
        let cnt = 0
        for (let j = Math.max(0, i - w); j < Math.min(frames, i + w); j++) {
          sum += flux[j]
          cnt++
        }
        const thr = (sum / cnt) * 2.2 + 1e-9
        const isPeak = flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]
        const t = (i * hop) / SR
        if (isPeak && (last < 0 || t - last > 0.22)) {
          beats.push(Math.round(t * 1000) / 1000)
          last = t
        }
      }

      // bpm from median inter-onset interval
      let bpm = 0
      if (beats.length > 3) {
        const iois = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
        let ioi = iois[Math.floor(iois.length / 2)]
        while (ioi < 0.3) ioi *= 2
        while (ioi > 1.2) ioi /= 2
        bpm = Math.round(60 / ioi)
      }
      resolve({ beats, bpm })
    })
    child.on('error', () => resolve({ beats: [], bpm: 0 }))
  })
}

// ---------- transcription via whisper.cpp ----------

export interface Word {
  t0: number // seconds relative to the analyzed range start
  t1: number
  text: string
}

function whisperExe(): string | null {
  const dir = join(appRoot(), 'tools', 'whisper')
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  // release zips sometimes nest binaries one level down
  for (const sub of ['bin', 'Release']) {
    for (const name of ['whisper-cli.exe', 'main.exe']) {
      const p = join(dir, sub, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

function whisperModel(): string | null {
  const p = join(appRoot(), 'tools', 'models', 'ggml-base-q5_1.bin')
  return existsSync(p) ? p : null
}

export function whisperAvailable(): boolean {
  return !!whisperExe() && !!whisperModel()
}

export function modnetAvailable(): boolean {
  return existsSync(join(appRoot(), 'tools', 'models', 'modnet.onnx'))
}

export async function transcribe(
  path: string,
  start: number,
  duration: number,
  lang = 'auto'
): Promise<{ ok: boolean; words: Word[]; error?: string }> {
  const exe = whisperExe()
  const model = whisperModel()
  if (!exe || !model) return { ok: false, words: [], error: 'whisper model not installed' }

  const dir = join(cacheDir(), 'tools')
  await fs.mkdir(dir, { recursive: true })
  const stamp = Date.now().toString(36)
  const wav = join(dir, `tr-${stamp}.wav`)
  const outBase = join(dir, `tr-${stamp}`)

  const ex = await run(ffmpegPath(), [
    '-y', '-ss', f(start), '-t', f(duration), '-i', path,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav
  ], 600000)
  if (ex.code !== 0) return { ok: false, words: [], error: 'audio extract failed' }

  const threads = Math.max(2, Math.min(6, cpus().length - 2))
  const args = [
    '-m', model, '-f', wav,
    '-oj', '-of', outBase,
    '-ml', '1', '-sow',
    '-t', String(threads)
  ]
  if (lang && lang !== 'auto') args.push('-l', lang)
  else args.push('-l', 'auto')
  const w = await run(exe, args, 1800000)
  await fs.unlink(wav).catch(() => {})
  if (w.code !== 0) {
    return { ok: false, words: [], error: 'whisper failed: ' + w.stderr.split('\n').slice(-4).join(' ') }
  }

  try {
    const raw = await fs.readFile(outBase + '.json', 'utf8')
    await fs.unlink(outBase + '.json').catch(() => {})
    const j = JSON.parse(raw)
    const words: Word[] = []
    for (const seg of j.transcription || []) {
      const text = String(seg.text || '').trim()
      if (!text || /^[\s.,!?;:—-]+$/.test(text)) continue
      const t0 = (seg.offsets?.from ?? 0) / 1000
      const t1 = Math.max(t0 + 0.05, (seg.offsets?.to ?? 0) / 1000)
      words.push({ t0, t1, text })
    }
    return { ok: true, words }
  } catch (e) {
    return { ok: false, words: [], error: 'could not parse whisper output: ' + String(e) }
  }
}
