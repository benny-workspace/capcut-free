import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { MediaItem } from '../shared/model'

export function appRoot(): string {
  return app.getAppPath()
}

export function toolsDir(): string {
  return join(appRoot(), 'tools', 'ffmpeg')
}

export function ffmpegPath(): string {
  const p = join(toolsDir(), 'ffmpeg.exe')
  return existsSync(p) ? p : 'ffmpeg'
}

export function ffprobePath(): string {
  const p = join(toolsDir(), 'ffprobe.exe')
  return existsSync(p) ? p : 'ffprobe'
}

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

export function run(exe: string, args: string[], timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: err })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: err })
    })
  })
}

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv', '.ts', '.3gp', '.flv']
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']

export function mediaTypeFor(file: string): 'video' | 'audio' | 'image' | null {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (IMAGE_EXT.includes(ext)) return 'image'
  return null
}

export const MEDIA_FILTERS = [
  { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => e.slice(1)) },
  { name: 'Video', extensions: VIDEO_EXT.map((e) => e.slice(1)) },
  { name: 'Audio', extensions: AUDIO_EXT.map((e) => e.slice(1)) },
  { name: 'Images', extensions: IMAGE_EXT.map((e) => e.slice(1)) }
]

/** Codecs Chromium can decode natively — anything else gets a preview proxy. */
const PLAYABLE_VCODECS = ['h264', 'vp8', 'vp9', 'av1']

export async function probeMedia(file: string, id: string): Promise<MediaItem | null> {
  const type = mediaTypeFor(file)
  if (!type) return null
  const name = file.replace(/\\/g, '/').split('/').pop() || file

  if (type === 'image') {
    const r = await run(ffprobePath(), [
      '-v', 'error', '-print_format', 'json', '-show_streams', file
    ])
    let width: number | undefined, height: number | undefined
    try {
      const j = JSON.parse(r.stdout.toString())
      const v = (j.streams || []).find((s: any) => s.codec_type === 'video')
      width = v?.width
      height = v?.height
    } catch {
      /* image may still render in Chromium */
    }
    return { id, path: file, name, type, duration: 4, width, height, hasAudio: false }
  }

  const r = await run(ffprobePath(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ])
  if (r.code !== 0) return null
  try {
    const j = JSON.parse(r.stdout.toString())
    const v = (j.streams || []).find((s: any) => s.codec_type === 'video')
    const a = (j.streams || []).find((s: any) => s.codec_type === 'audio')
    const duration = parseFloat(j.format?.duration ?? v?.duration ?? a?.duration ?? '0')
    let fps: number | undefined
    if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
      const [n, d] = v.avg_frame_rate.split('/').map(Number)
      if (d > 0) fps = n / d
    }
    if (type === 'video' && !v) return null
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
    }
  } catch {
    return null
  }
}

export function needsProxy(item: MediaItem): boolean {
  if (item.type !== 'video') return false
  return !PLAYABLE_VCODECS.includes(item.vcodec || '')
}

export async function thumbnailDataUrl(file: string, at: number, isImage: boolean): Promise<string | undefined> {
  const args = isImage
    ? ['-i', file, '-frames:v', '1', '-vf', 'scale=168:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
    : ['-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=168:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
  const r = await run(ffmpegPath(), args, 30000)
  if (r.code !== 0 || r.stdout.length === 0) return undefined
  return 'data:image/jpeg;base64,' + r.stdout.toString('base64')
}

export async function makeProxy(src: string, dest: string): Promise<boolean> {
  const r = await run(
    ffmpegPath(),
    [
      '-y', '-i', src,
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      dest
    ],
    600000
  )
  return r.code === 0
}

let qsvCache: boolean | null = null

export async function detectQsv(): Promise<boolean> {
  if (qsvCache !== null) return qsvCache
  const r = await run(
    ffmpegPath(),
    ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.3', '-c:v', 'h264_qsv', '-f', 'null', '-'],
    60000
  )
  qsvCache = r.code === 0
  return qsvCache
}

export async function ffmpegVersion(): Promise<string | undefined> {
  const r = await run(ffmpegPath(), ['-version'], 15000)
  if (r.code !== 0) return undefined
  return r.stdout.toString().split('\n')[0]?.trim()
}
