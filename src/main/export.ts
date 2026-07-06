import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { ExportResult, ExportSettings, Project } from '../shared/model'
import { projectDuration } from '../shared/model'
import { buildExportArgs, buildFramePipeArgs, TextPngFile } from './exportCompiler'
import { detectQsv, ffmpegPath } from './ffmpeg'
import { cacheDir } from './projects'

let current: ChildProcess | null = null

export function cancelExport(): void {
  if (current) {
    current.kill('SIGKILL')
    current = null
  }
}

interface TextPngPayload {
  clipId: string
  dataUrl: string
}

async function writeTextPngs(pngs: TextPngPayload[]): Promise<TextPngFile[]> {
  const dir = join(cacheDir(), 'export-text')
  await fs.mkdir(dir, { recursive: true })
  const out: TextPngFile[] = []
  for (const p of pngs) {
    const b64 = p.dataUrl.split(',')[1]
    if (!b64) continue
    const file = join(dir, `${p.clipId}.png`)
    await fs.writeFile(file, Buffer.from(b64, 'base64'))
    out.push({ clipId: p.clipId, pngPath: file })
  }
  return out
}

function runFfmpeg(
  args: string[],
  durationSec: number,
  sender: WebContents
): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    current = child
    let log = ''
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim())
        if (m && durationSec > 0) {
          const ratio = Math.min(0.999, parseInt(m[1]) / 1e6 / durationSec)
          sender.send('export:progress', { ratio, phase: 'encoding' })
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      log += d.toString()
      if (log.length > 60000) log = log.slice(-40000)
    })
    child.on('error', (e) => {
      current = null
      resolve({ code: -1, log: log + '\nspawn error: ' + e.message })
    })
    child.on('close', (code) => {
      current = null
      resolve({ code, log })
    })
  })
}

// ---------- frame-pipe engine: raw RGBA frames from the GPU compositor ----------

interface PipeSession {
  child: ChildProcess
  getLog: () => string
  closed: Promise<number | null>
}

let pipe: PipeSession | null = null

export async function framePipeStart(
  project: Project,
  settings: ExportSettings
): Promise<{ ok: boolean; encoder?: string; error?: string }> {
  if (pipe) {
    pipe.child.kill('SIGKILL')
    pipe = null
  }
  try {
    const encoder: 'qsv' | 'x264' =
      settings.encoder === 'auto' ? ((await detectQsv()) ? 'qsv' : 'x264') : settings.encoder
    const args = buildFramePipeArgs(project, { ...settings, encoder })
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    let log = ''
    child.stderr!.on('data', (d: Buffer) => {
      log += d.toString()
      if (log.length > 60000) log = log.slice(-40000)
    })
    child.stdin!.on('error', () => {}) // EPIPE when ffmpeg dies early; surfaced via exit code
    child.on('error', (e) => {
      log += '\nspawn error: ' + e.message
    })
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
    pipe = { child, getLog: () => log, closed }
    return { ok: true, encoder }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Returns false when ffmpeg is gone — the renderer stops sending frames. */
export function framePipeFrame(buf: ArrayBuffer): Promise<boolean> {
  const child = pipe?.child
  if (!child || !child.stdin || child.stdin.destroyed || child.exitCode !== null) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const ok = child.stdin!.write(Buffer.from(buf), (err) => {
      if (err) resolve(false)
    })
    if (ok) resolve(true)
    else child.stdin!.once('drain', () => resolve(true))
  })
}

export async function framePipeEnd(): Promise<ExportResult> {
  if (!pipe) return { ok: false, error: 'no active frame-pipe export' }
  const session = pipe
  pipe = null
  session.child.stdin?.end()
  const code = await session.closed
  if (code !== 0) {
    return { ok: false, error: session.getLog().split('\n').slice(-15).join('\n') }
  }
  return { ok: true }
}

export function framePipeCancel(): void {
  if (pipe) {
    pipe.child.kill('SIGKILL')
    pipe = null
  }
}

export async function runExport(
  sender: WebContents,
  project: Project,
  settings: ExportSettings,
  textPngs: TextPngPayload[]
): Promise<ExportResult> {
  try {
    sender.send('export:progress', { ratio: 0, phase: 'preparing' })
    const pngFiles = await writeTextPngs(textPngs)
    const dur = Math.max(projectDuration(project), 0.1)

    let encoder: 'qsv' | 'x264' =
      settings.encoder === 'auto' ? ((await detectQsv()) ? 'qsv' : 'x264') : settings.encoder

    let args = buildExportArgs(project, { ...settings, encoder }, pngFiles)
    let r = await runFfmpeg(args, dur, sender)

    if (r.code !== 0 && encoder === 'qsv') {
      // Quick Sync can fail on driver quirks — retry in software once.
      encoder = 'x264'
      args = buildExportArgs(project, { ...settings, encoder }, pngFiles)
      r = await runFfmpeg(args, dur, sender)
    }

    if (r.code !== 0) {
      const tail = r.log.split('\n').slice(-15).join('\n')
      sender.send('export:progress', { ratio: 0, phase: 'error', message: tail })
      return { ok: false, error: tail }
    }

    sender.send('export:progress', { ratio: 1, phase: 'done' })
    return { ok: true, encoderUsed: encoder === 'qsv' ? 'h264_qsv (Quick Sync)' : 'libx264', outPath: settings.outPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    sender.send('export:progress', { ratio: 0, phase: 'error', message: msg })
    return { ok: false, error: msg }
  }
}
