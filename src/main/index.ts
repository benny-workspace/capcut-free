import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { createReadStream, existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import type { ExportSettings, MediaItem, Project, SysInfo } from '../shared/model'
import {
  cancelExport,
  framePipeCancel,
  framePipeEnd,
  framePipeFrame,
  framePipeStart,
  runExport
} from './export'
import {
  appRoot,
  detectQsv,
  ffmpegPath,
  ffprobePath,
  ffmpegVersion,
  MEDIA_FILTERS,
  makeProxy,
  needsProxy,
  probeMedia,
  run,
  thumbnailDataUrl
} from './ffmpeg'
import { cacheDir, ensureDataDirs, loadLastProject, proxiesDir, saveProject } from './projects'

const SMOKE = !!process.env.LOCALCUT_SMOKE

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

function mimeFor(p: string): string {
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif'
  }
  return map[ext] || 'application/octet-stream'
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    try {
      const u = new URL(request.url)
      let p = decodeURIComponent(u.pathname)
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
      const stat = await fs.stat(p)
      const mime = mimeFor(p)
      const range = request.headers.get('range')
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)
        const start = m ? parseInt(m[1]) : 0
        const end = m && m[2] ? Math.min(parseInt(m[2]), stat.size - 1) : stat.size - 1
        const stream = createReadStream(p, { start, end })
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': mime
          }
        })
      }
      const stream = createReadStream(p)
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Content-Type': mime
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// ---------- smoke-test support: generated assets + rendered-file check ----------

async function smokeSetupAssets(): Promise<{ basePath: string; greenPath: string; outPath: string }> {
  const dir = join(cacheDir(), 'smoke')
  await fs.mkdir(dir, { recursive: true })
  const basePath = join(dir, 'base.mp4')
  const greenPath = join(dir, 'green.mp4')
  const outPath = join(dir, 'out.mp4')
  if (!existsSync(basePath)) {
    await run(ffmpegPath(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest',
      basePath
    ])
  }
  if (!existsSync(greenPath)) {
    // green screen with a moving pattern box, for chroma-key verification
    await run(ffmpegPath(), [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x00D000:s=640x360:r=30:d=4',
      '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=4',
      '-filter_complex', '[0][1]overlay=x=60+t*80:y=120',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-t', '4',
      greenPath
    ])
  }
  return { basePath, greenPath, outPath }
}

async function verifySmokeExport(outPath: string): Promise<boolean> {
  const p = await run(ffprobePath(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outPath
  ])
  if (p.code !== 0) {
    console.error('SMOKE VERIFY: ffprobe failed on ' + outPath)
    return false
  }
  try {
    const j = JSON.parse(p.stdout.toString())
    const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video')
    const a = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio')
    const dur = parseFloat(j.format?.duration ?? '0')
    console.log(
      `SMOKE VERIFY dur=${dur.toFixed(2)}s video=${v ? `${v.width}x${v.height} ${v.codec_name}` : 'none'} audio=${a ? a.codec_name : 'none'}`
    )
    if (!v || !a) return false
    if (Math.abs(dur - 4) > 0.4) return false
    await run(ffmpegPath(), [
      '-y', '-ss', '2', '-i', outPath, '-frames:v', '1', join(appRoot(), 'smoke-export-frame.png')
    ])
    return true
  } catch {
    return false
  }
}

let win: BrowserWindow | null = null
let mediaSeq = 0
const proxyQueue: MediaItem[] = []
let proxyRunning = false

async function pumpProxyQueue(): Promise<void> {
  if (proxyRunning) return
  proxyRunning = true
  while (proxyQueue.length > 0) {
    const item = proxyQueue.shift()!
    const dest = join(proxiesDir(), `${item.id}.mp4`)
    const ok = await makeProxy(item.path, dest)
    if (ok && win && !win.isDestroyed()) {
      win.webContents.send('media:proxy-ready', { mediaId: item.id, proxyPath: dest })
    }
  }
  proxyRunning = false
}

function registerIpc(): void {
  ipcMain.handle('dialog:open-media', async () => {
    if (SMOKE) {
      console.log('[smoke] open-media dialog invoked')
      return []
    }
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:save-path', async (_e, defaultName: string) => {
    if (!win) return null
    const r = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('media:ingest', async (_e, paths: string[]) => {
    const items: MediaItem[] = []
    for (const p of paths) {
      const id = 'm' + Date.now().toString(36) + (mediaSeq++).toString(36)
      const item = await probeMedia(p, id)
      if (!item) continue
      item.thumbnail = await thumbnailDataUrl(
        p,
        Math.min(0.5, (item.duration || 1) / 2),
        item.type === 'image'
      )
      if (needsProxy(item)) {
        proxyQueue.push(item)
        void pumpProxyQueue()
      }
      items.push(item)
    }
    return items
  })

  ipcMain.handle('project:save', async (_e, project: Project) => {
    if (SMOKE) return true // don't persist injected smoke-test projects
    await saveProject(project)
    return true
  })

  ipcMain.handle('project:load-last', async () => loadLastProject())

  ipcMain.handle(
    'export:run',
    async (e, project: Project, settings: ExportSettings, textPngs: { clipId: string; dataUrl: string }[]) =>
      runExport(e.sender, project, settings, textPngs)
  )

  ipcMain.handle('export:cancel', () => cancelExport())

  ipcMain.handle('export2:start', (_e, project: Project, settings: ExportSettings) =>
    framePipeStart(project, settings)
  )
  ipcMain.handle('export2:frame', (_e, buf: ArrayBuffer) => framePipeFrame(buf))
  ipcMain.handle('export2:end', () => framePipeEnd())
  ipcMain.handle('export2:cancel', () => framePipeCancel())

  ipcMain.handle('smoke:setup', async () => {
    if (!SMOKE) throw new Error('smoke:setup is only available in smoke mode')
    return smokeSetupAssets()
  })

  ipcMain.handle('sys:info', async (): Promise<SysInfo> => {
    const version = await ffmpegVersion()
    return {
      ffmpegFound: !!version,
      qsv: version ? await detectQsv() : false,
      ffmpegVersion: version
    }
  })

  ipcMain.handle('shell:show-item', (_e, path: string) => shell.showItemInFolder(path))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101014',
    show: false,
    autoHideMenuBar: true,
    title: 'LocalCut',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (SMOKE) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('[renderer]', message)
    })
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // populate the timeline through the store so the screenshot shows real UI state
          const diag = await win!.webContents.executeJavaScript(`(() => {
            const ed = window.__editor
            if (ed) {
              // reset any autosaved state so smoke runs are deterministic
              for (const m of [...ed.getState().project.media]) ed.getState().removeMedia(m.id)
              for (const tr of ed.getState().project.tracks)
                for (const c of [...tr.clips]) ed.getState().deleteClip(c.id)
              ed.getState().addMedia([
                { id: 'demo1', path: 'X:/demo1.mp4', name: 'demo1.mp4', type: 'video', duration: 5, width: 1920, height: 1080, fps: 30, hasAudio: true, vcodec: 'h264' },
                { id: 'demo2', path: 'X:/demo2.mp4', name: 'demo2.mp4', type: 'video', duration: 3, width: 1920, height: 1080, fps: 30, hasAudio: true, vcodec: 'h264' }
              ])
              ed.getState().addToTimeline('demo1')
              ed.getState().addToTimeline('demo2')
              ed.getState().addTextClip()
              const main = ed.getState().project.tracks.find((t) => t.id === 'main')
              ed.getState().updateClip(main.clips[0].id, {
                speed: 2,
                transitionAfter: { type: 'cross', duration: 0.5 },
                color: { exposure: 0.1, contrast: 0.2, saturation: 0.4, temperature: 0.4 }
              })
              ed.getState().select(main.clips[0].id)
              ed.getState().setPlayhead(2)
            }
            const styleOf = (sel) => {
              const el = document.querySelector(sel)
              if (!el) return 'MISSING'
              const r = el.getBoundingClientRect()
              return getComputedStyle(el).backgroundColor + ' @ ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
            }
            return JSON.stringify({
              hasEditor: !!ed,
              mainTrack: styleOf('.tl-track.kind-video'),
              overlayTrack: styleOf('.tl-track.kind-overlay'),
              clips: document.querySelectorAll('.tl-clip').length,
              importBtn: document.querySelector('.media-pool .btn.primary')?.textContent,
              activeEl: document.activeElement?.tagName + '.' + document.activeElement?.className
            })
          })()`)
          console.log('SMOKE DIAG ' + diag)
          await new Promise((r) => setTimeout(r, 800))
          const img = await win!.webContents.capturePage()
          const out = process.env.LOCALCUT_SMOKE_OUT || join(app.getAppPath(), 'smoke.png')
          await fs.writeFile(out, img.toPNG())
          console.log('SMOKE OK -> ' + out)
        } catch (e) {
          console.error('SMOKE FAILED', e)
        }
        app.exit(0)
      }, 5000)
    })
    setTimeout(() => app.exit(1), 40000)
  }
}

app.whenReady().then(async () => {
  await ensureDataDirs()
  registerMediaProtocol()
  registerIpc()
  console.log('[localcut] ffmpeg at:', ffmpegPath())
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
