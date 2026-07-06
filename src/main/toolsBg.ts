// AI background removal: decode frames with FFmpeg, run MODNet portrait
// matting (onnxruntime, int CPU), upscale the matte, and encode a VP9+alpha
// webm (with the source audio) that both the preview and the frame-pipe
// exporter can play directly. Offline pass with progress, as planned for
// this hardware (~2-6 fps processing).

import { spawn, ChildProcess } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { appRoot, ffmpegPath, probeMedia } from './ffmpeg'
import { cacheDir } from './projects'

// optional dependency — the app must run without it
interface OrtLike {
  InferenceSession: {
    create(path: string, opts?: unknown): Promise<{
      inputNames: string[]
      outputNames: string[]
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>
    }>
  }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}

function loadOrt(): OrtLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('onnxruntime-node') as OrtLike
  } catch {
    return null
  }
}

const MODEL_W = 512
const MODEL_H = 288 // both divisible by 32, 16:9

function modelPath(): string {
  return join(appRoot(), 'tools', 'models', 'modnet.onnx')
}

/** pull-based fixed-size frame reader over a child stdout */
function frameReader(child: ChildProcess, frameSize: number): () => Promise<Buffer | null> {
  const bufs: Buffer[] = []
  let total = 0
  let ended = false
  let waiter: (() => void) | null = null
  const stream = child.stdout!
  stream.on('data', (d: Buffer) => {
    bufs.push(d)
    total += d.length
    waiter?.()
  })
  const onEnd = (): void => {
    ended = true
    waiter?.()
  }
  stream.on('end', onEnd)
  child.on('close', onEnd)
  return async (): Promise<Buffer | null> => {
    while (total < frameSize) {
      if (ended) return null
      await new Promise<void>((r) => {
        waiter = r
      })
      waiter = null
    }
    const all = Buffer.concat(bufs)
    bufs.length = 0
    const frame = Buffer.from(all.subarray(0, frameSize))
    const rest = all.subarray(frameSize)
    if (rest.length > 0) bufs.push(Buffer.from(rest))
    total = rest.length
    return frame
  }
}

function writeWithDrain(child: ChildProcess, buf: Buffer): Promise<boolean> {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed) return Promise.resolve(false)
  return new Promise((resolve) => {
    const ok = stdin.write(buf, (err) => {
      if (err) resolve(false)
    })
    if (ok) resolve(true)
    else stdin.once('drain', () => resolve(true))
  })
}

export async function removeBackground(
  sender: WebContents,
  path: string,
  mediaId: string,
  duration: number
): Promise<{ ok: boolean; mattePath?: string; error?: string }> {
  const ort = loadOrt()
  if (!ort) return { ok: false, error: 'onnxruntime-node is not installed' }
  if (!existsSync(modelPath())) return { ok: false, error: 'MODNet model missing (tools/models/modnet.onnx)' }
  if (duration > 900) return { ok: false, error: 'clip longer than 15 min — trim it first' }

  const probe = await probeMedia(path, 'probe')
  if (!probe) return { ok: false, error: 'could not probe source' }
  const srcW = probe.width || 1280
  const srcH = probe.height || 720
  const fps = probe.fps && probe.fps > 0 && probe.fps <= 60 ? probe.fps : 30
  // work at up to 720p, even dimensions
  const scale = Math.min(1, 720 / srcH)
  const W = 2 * Math.round((srcW * scale) / 2)
  const H = 2 * Math.round((srcH * scale) / 2)

  const outDir = join(cacheDir(), 'mattes')
  await fs.mkdir(outDir, { recursive: true })
  const mattePath = join(outDir, `${mediaId}.webm`)

  const session = await ort.InferenceSession.create(modelPath())
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  const decoder = spawn(
    ffmpegPath(),
    ['-v', 'error', '-i', path, '-vf', `scale=${W}:${H},fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { windowsHide: true }
  )
  const encoder = spawn(
    ffmpegPath(),
    [
      '-y', '-v', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${W}x${H}`, '-framerate', String(fps), '-i', 'pipe:0',
      '-i', path,
      '-map', '0:v', '-map', '1:a?',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '34', '-b:v', '0',
      '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
      '-c:a', 'libopus', '-b:a', '128k',
      '-shortest',
      mattePath
    ],
    { windowsHide: true }
  )
  let encLog = ''
  encoder.stderr!.on('data', (d: Buffer) => {
    encLog += d.toString()
    if (encLog.length > 20000) encLog = encLog.slice(-10000)
  })
  encoder.stdin!.on('error', () => {})
  const encClosed = new Promise<number | null>((r) => encoder.on('close', r))

  const nextFrame = frameReader(decoder, W * H * 3)
  const tensorData = new Float32Array(3 * MODEL_H * MODEL_W)
  const rgba = Buffer.alloc(W * H * 4)
  const totalFrames = Math.max(1, Math.round(duration * fps))
  let frames = 0

  for (;;) {
    const frame = await nextFrame()
    if (!frame) break

    // nearest-sample down to model size, normalize to [-1, 1], NCHW
    for (let y = 0; y < MODEL_H; y++) {
      const sy = Math.min(H - 1, Math.round((y * H) / MODEL_H))
      for (let x = 0; x < MODEL_W; x++) {
        const sx = Math.min(W - 1, Math.round((x * W) / MODEL_W))
        const si = (sy * W + sx) * 3
        const di = y * MODEL_W + x
        tensorData[di] = frame[si] / 127.5 - 1
        tensorData[MODEL_H * MODEL_W + di] = frame[si + 1] / 127.5 - 1
        tensorData[2 * MODEL_H * MODEL_W + di] = frame[si + 2] / 127.5 - 1
      }
    }
    const feeds: Record<string, unknown> = {}
    feeds[inputName] = new ort.Tensor('float32', tensorData, [1, 3, MODEL_H, MODEL_W])
    const results = await session.run(feeds)
    const matte = results[outputName].data // MODEL_H x MODEL_W, 0..1

    // bilinear-upscale matte to working res while packing RGBA
    for (let y = 0; y < H; y++) {
      const fy = (y * (MODEL_H - 1)) / (H - 1)
      const y0 = Math.floor(fy)
      const y1 = Math.min(MODEL_H - 1, y0 + 1)
      const wy = fy - y0
      for (let x = 0; x < W; x++) {
        const fx = (x * (MODEL_W - 1)) / (W - 1)
        const x0 = Math.floor(fx)
        const x1 = Math.min(MODEL_W - 1, x0 + 1)
        const wx = fx - x0
        const m =
          matte[y0 * MODEL_W + x0] * (1 - wx) * (1 - wy) +
          matte[y0 * MODEL_W + x1] * wx * (1 - wy) +
          matte[y1 * MODEL_W + x0] * (1 - wx) * wy +
          matte[y1 * MODEL_W + x1] * wx * wy
        const si = (y * W + x) * 3
        const di = (y * W + x) * 4
        rgba[di] = frame[si]
        rgba[di + 1] = frame[si + 1]
        rgba[di + 2] = frame[si + 2]
        rgba[di + 3] = Math.max(0, Math.min(255, Math.round(m * 255)))
      }
    }

    const ok = await writeWithDrain(encoder, rgba)
    if (!ok) break
    frames++
    if (frames % 5 === 0) {
      sender.send('bgremove:progress', { mediaId, ratio: Math.min(0.99, frames / totalFrames) })
    }
  }

  decoder.kill('SIGKILL')
  encoder.stdin!.end()
  const code = await encClosed
  if (code !== 0 || frames === 0) {
    await fs.unlink(mattePath).catch(() => {})
    return { ok: false, error: 'matte encode failed: ' + encLog.split('\n').slice(-5).join(' ') }
  }
  sender.send('bgremove:progress', { mediaId, ratio: 1 })
  return { ok: true, mattePath }
}
