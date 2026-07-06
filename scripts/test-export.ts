// Headless P1 acceptance test: builds a real multi-clip project EDL,
// compiles it with the export compiler, renders it with FFmpeg, and
// verifies the output with ffprobe. Run with: npm run test:export

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { buildExportArgs } from '../src/main/exportCompiler'
import type { Clip, MediaItem, Project, Transform } from '../src/shared/model'

const root = resolve(process.cwd())
const ffmpeg = existsSync(join(root, 'tools/ffmpeg/ffmpeg.exe'))
  ? join(root, 'tools/ffmpeg/ffmpeg.exe')
  : 'ffmpeg'
const ffprobe = existsSync(join(root, 'tools/ffmpeg/ffprobe.exe'))
  ? join(root, 'tools/ffmpeg/ffprobe.exe')
  : 'ffprobe'
const work = join(root, 'data', 'cache', 'test-export')

function sh(exe: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function die(msg: string, detail?: string): never {
  console.error('FAIL: ' + msg)
  if (detail) console.error(detail.split('\n').slice(-20).join('\n'))
  process.exit(1)
}

function gen(name: string, args: string[]): string {
  const out = join(work, name)
  const r = sh(ffmpeg, ['-y', '-hide_banner', ...args, out])
  if (r.code !== 0) die(`could not generate test asset ${name}`, r.err)
  return out
}

const tf = (patch: Partial<Transform> = {}): Transform => ({
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...patch
})

function clip(patch: Partial<Clip> & Pick<Clip, 'id' | 'kind' | 'start' | 'duration'>): Clip {
  return { in: 0, volume: 1, muted: false, speed: 1, transform: tf(), ...patch }
}

// ---------- 1. toolchain ----------
const ver = sh(ffmpeg, ['-version'])
if (ver.code !== 0) die('ffmpeg not found (tools/ffmpeg/ffmpeg.exe or PATH)')
console.log('ffmpeg: ' + ver.out.split('\n')[0])

const qsvProbe = sh(ffmpeg, [
  '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.3',
  '-c:v', 'h264_qsv', '-f', 'null', '-'
])
const hasQsv = qsvProbe.code === 0
console.log('Quick Sync (h264_qsv): ' + (hasQsv ? 'available' : 'NOT available — using libx264'))

// ---------- 2. test assets ----------
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const src1 = gen('clip1.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest'
])
const src2 = gen('clip2.mp4', [
  '-f', 'lavfi', '-i', 'smptehdbars=size=640x360:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest'
])
const src3 = gen('clip3.mp4', [
  '-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest'
])
const music = gen('music.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac'])
// stands in for the caption PNG the renderer rasterizes from a text clip
const textPng = gen('text.png', [
  '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1280x720,format=rgba',
  '-vf', 'drawbox=x=340:y=560:w=600:h=90:color=white@0.8:t=fill',
  '-frames:v', '1'
])
console.log('test assets generated')

// ---------- 3. project EDL ----------
const media: MediaItem[] = [
  { id: 'm1', path: src1, name: 'clip1', type: 'video', duration: 4, width: 640, height: 360, fps: 30, hasAudio: true, vcodec: 'h264' },
  { id: 'm2', path: src2, name: 'clip2', type: 'video', duration: 4, width: 640, height: 360, fps: 30, hasAudio: true, vcodec: 'h264' },
  { id: 'm3', path: src3, name: 'clip3', type: 'video', duration: 4, width: 640, height: 360, fps: 30, hasAudio: true, vcodec: 'h264' },
  { id: 'mus', path: music, name: 'music', type: 'audio', duration: 12, hasAudio: true }
]

// Main track exercises P2 features:
//  c1 (2s, cross 0.6s into c2) -> c2 (2s at 2x speed, Vivid color, fadeblack 0.4s) -> c3 (2s, audio fades)
// packedMain semantics baked into starts: c2 at 1.4, c3 at 3.0 -> total 5.0s
const project: Project = {
  id: 'test',
  name: 'export-test',
  width: 1280,
  height: 720,
  fps: 30,
  media,
  createdAt: '',
  modifiedAt: '',
  tracks: [
    {
      id: 'main', kind: 'video', name: 'Main',
      clips: [
        clip({
          id: 'c1', kind: 'video', mediaId: 'm1', start: 0, duration: 2, in: 0.5,
          transitionAfter: { type: 'cross', duration: 0.6 }
        }),
        clip({
          id: 'c2', kind: 'video', mediaId: 'm2', start: 1.4, duration: 2, speed: 2,
          color: { exposure: 0.05, contrast: 0.15, saturation: 0.35, temperature: 0.3 },
          transitionAfter: { type: 'fadeblack', duration: 0.4 }
        }),
        clip({ id: 'c3', kind: 'video', mediaId: 'm3', start: 3.0, duration: 2, in: 1, fadeIn: 0.3, fadeOut: 0.3 })
      ]
    },
    {
      id: 'overlay1', kind: 'overlay', name: 'Overlay',
      clips: [
        clip({
          id: 'pip', kind: 'video', mediaId: 'm1', start: 1, duration: 3, muted: true,
          transform: tf({ scale: 0.35, x: 0.25, y: -0.2, rotation: 12, opacity: 0.9 })
        })
      ]
    },
    {
      id: 'text1', kind: 'text', name: 'Text',
      clips: [clip({ id: 'title', kind: 'text', start: 0.5, duration: 4, text: 'LocalCut', volume: 0, muted: true })]
    },
    {
      id: 'audio1', kind: 'audio', name: 'Audio',
      clips: [clip({ id: 'bgm', kind: 'audio', mediaId: 'mus', start: 0, duration: 5, volume: 0.4, fadeOut: 1 })]
    }
  ]
}

const EXPECTED_DUR = 5.0

// ---------- 4. render ----------
function render(encoder: 'qsv' | 'x264'): void {
  const outPath = join(work, `out-${encoder}.mp4`)
  const args = buildExportArgs(
    project,
    { outPath, width: 1280, height: 720, fps: 30, vBitrateK: 6000, encoder },
    [{ clipId: 'title', pngPath: textPng }]
  )
  const t0 = Date.now()
  const r = sh(ffmpeg, args)
  if (r.code !== 0) die(`ffmpeg export failed (${encoder})`, r.err)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const p = sh(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outPath])
  if (p.code !== 0) die('ffprobe failed on output', p.err)
  const j = JSON.parse(p.out)
  const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video')
  const a = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio')
  const dur = parseFloat(j.format?.duration ?? '0')

  if (!v) die('output has no video stream')
  if (!a) die('output has no audio stream')
  if (v.width !== 1280 || v.height !== 720) die(`wrong resolution ${v.width}x${v.height}`)
  if (Math.abs(dur - EXPECTED_DUR) > 0.3) die(`wrong duration ${dur}s (expected ~${EXPECTED_DUR}s)`)
  const size = Math.round(statSync(outPath).size / 1024)
  console.log(`PASS [${encoder}] ${outPath} — ${dur.toFixed(2)}s, ${v.width}x${v.height} ${v.codec_name} + ${a.codec_name}, ${size} KB, rendered in ${secs}s`)
}

render('x264')
if (hasQsv) render('qsv')

console.log('ALL EXPORT TESTS PASSED')
