import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { ExportResult, ExportSettings, Project } from '../shared/model'
import { projectDuration } from '../shared/model'
import { buildExportArgs, TextPngFile } from './exportCompiler'
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
