// WebGL2 compositor — the single visual truth for LocalCut. The preview
// renders through it every frame; frame-pipe exports render through it at
// export resolution and read the pixels back for FFmpeg.

import type { ChromaKey, ColorAdjust, Mask } from '@shared/model'
import { isNeutralColor } from '@shared/model'
import { FRAG, VERT } from './shaders'

export interface LayerRect {
  x: number
  y: number
  w: number
  h: number
}

export interface DrawLayerOpts {
  ownerId: string
  source: TexImageSource
  /** re-upload every call (video frames) vs cache by contentKey */
  dynamic: boolean
  contentKey?: string
  rect: LayerRect
  rotationDeg: number
  opacity: number
  color?: ColorAdjust
  chromaKey?: ChromaKey
  mask?: Mask
}

interface CachedTex {
  tex: WebGLTexture
  contentKey?: string
  lastUsed: number
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0.82, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export class Compositor {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private u: Record<string, WebGLUniformLocation | null> = {}
  private quad: WebGLVertexArrayObject
  private fboTex: [WebGLTexture, WebGLTexture]
  private fbo: [WebGLFramebuffer, WebGLFramebuffer]
  private accum = 0 // index of the FBO currently accumulating
  private w = 0
  private h = 0
  private texCache = new Map<string, CachedTex>()
  private frame = 0
  private isOffscreen: boolean

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.isOffscreen = typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader compile: ' + gl.getShaderInfoLog(sh))
      }
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(prog))
    }
    this.prog = prog
    gl.useProgram(prog)
    for (const name of [
      'uCanvas', 'uRect', 'uRot', 'uTex', 'uMode', 'uOpacity', 'uUseColor', 'uColorAdj',
      'uChromaOn', 'uKeyColor', 'uChroma', 'uMaskType', 'uMaskRect', 'uMaskExtra'
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name)
    }
    gl.uniform1i(this.u.uTex, 0)

    // unit quad: two triangles, (0,0) top-left .. (1,1) bottom-right
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.quad = vao

    const mkTarget = (): [WebGLTexture, WebGLFramebuffer] => {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      return [tex, fbo]
    }
    const [t0, f0] = mkTarget()
    const [t1, f1] = mkTarget()
    this.fboTex = [t0, t1]
    this.fbo = [f0, f1]
  }

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    const gl = this.gl
    const canvas = gl.canvas
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i])
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex[i], 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  begin(): void {
    const gl = this.gl
    this.frame++
    this.accum = 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.accum])
    gl.viewport(0, 0, this.w, this.h)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.prog)
    gl.bindVertexArray(this.quad)
    gl.uniform2f(this.u.uCanvas, this.w, this.h)
  }

  private getTexture(opts: DrawLayerOpts): WebGLTexture {
    const gl = this.gl
    let entry = this.texCache.get(opts.ownerId)
    if (!entry) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { tex, lastUsed: this.frame }
      this.texCache.set(opts.ownerId, entry)
    }
    entry.lastUsed = this.frame
    const needsUpload = opts.dynamic || entry.contentKey !== (opts.contentKey ?? 'static')
    if (needsUpload) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, opts.source)
      entry.contentKey = opts.contentKey ?? 'static'
    }
    return entry.tex
  }

  drawLayer(opts: DrawLayerOpts): void {
    const gl = this.gl
    const tex = this.getTexture(opts)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.accum])
    gl.viewport(0, 0, this.w, this.h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)

    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.uniform1i(this.u.uMode, 0)
    gl.uniform4f(this.u.uRect, opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h)
    gl.uniform1f(this.u.uRot, (opts.rotationDeg * Math.PI) / 180)
    gl.uniform1f(this.u.uOpacity, opts.opacity)

    const c = opts.color
    if (c && !isNeutralColor(c)) {
      gl.uniform1i(this.u.uUseColor, 1)
      gl.uniform4f(this.u.uColorAdj, c.exposure, c.contrast, c.saturation, c.temperature)
    } else {
      gl.uniform1i(this.u.uUseColor, 0)
    }

    const ck = opts.chromaKey
    if (ck?.enabled) {
      const [r, g, b] = hexToRgb(ck.color)
      gl.uniform1i(this.u.uChromaOn, 1)
      gl.uniform3f(this.u.uKeyColor, r, g, b)
      gl.uniform3f(this.u.uChroma, ck.similarity, ck.smoothness, ck.spill)
    } else {
      gl.uniform1i(this.u.uChromaOn, 0)
    }

    const m = opts.mask
    if (m) {
      const type = m.type === 'rect' ? 1 : m.type === 'ellipse' ? 2 : 3
      gl.uniform1i(this.u.uMaskType, type)
      gl.uniform4f(this.u.uMaskRect, m.cx, m.cy, m.w, m.h)
      gl.uniform3f(this.u.uMaskExtra, m.feather, (m.rotation * Math.PI) / 180, m.invert ? 1 : 0)
    } else {
      gl.uniform1i(this.u.uMaskType, 0)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /** Full-frame color pass over everything accumulated so far. */
  applyAdjust(color: ColorAdjust | undefined, opacity: number): void {
    if (!color || isNeutralColor(color) || opacity <= 0) return
    const gl = this.gl
    const src = this.accum
    const dst = 1 - this.accum
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst])
    gl.viewport(0, 0, this.w, this.h)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex[src])
    gl.uniform1i(this.u.uMode, 1)
    gl.uniform4f(this.u.uRect, 0, 0, this.w, this.h)
    gl.uniform1f(this.u.uRot, 0)
    gl.uniform1f(this.u.uOpacity, opacity)
    gl.uniform4f(this.u.uColorAdj, color.exposure, color.contrast, color.saturation, color.temperature)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    this.accum = dst
  }

  /** Blit the accumulated frame to the canvas backbuffer (preview). */
  finishToCanvas(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.w, this.h)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex[this.accum])
    gl.uniform1i(this.u.uMode, 2)
    gl.uniform4f(this.u.uRect, 0, 0, this.w, this.h)
    gl.uniform1f(this.u.uRot, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    this.pruneTextures()
  }

  /**
   * Read back the accumulated frame (export). Rows come out bottom-up per GL
   * convention; the frame-pipe compensates with an ffmpeg vflip.
   */
  finishToPixels(out: Uint8Array): Uint8Array {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.accum])
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    this.pruneTextures()
    return out
  }

  private pruneTextures(): void {
    if (this.texCache.size < 32) return
    for (const [key, entry] of this.texCache) {
      if (this.frame - entry.lastUsed > 300) {
        this.gl.deleteTexture(entry.tex)
        this.texCache.delete(key)
      }
    }
  }

  dispose(): void {
    const gl = this.gl
    for (const { tex } of this.texCache.values()) gl.deleteTexture(tex)
    this.texCache.clear()
    for (let i = 0; i < 2; i++) {
      gl.deleteTexture(this.fboTex[i])
      gl.deleteFramebuffer(this.fbo[i])
    }
    gl.deleteProgram(this.prog)
    if (!this.isOffscreen) gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
