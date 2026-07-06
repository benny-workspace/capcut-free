import { contextBridge, ipcRenderer } from 'electron'

const RECEIVE_CHANNELS = ['media:proxy-ready', 'export:progress', 'bgremove:progress'] as const

const api = {
  openMediaDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:open-media'),
  savePathDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-path', defaultName),
  ingest: (paths: string[]): Promise<unknown[]> => ipcRenderer.invoke('media:ingest', paths),
  saveProject: (project: unknown): Promise<boolean> => ipcRenderer.invoke('project:save', project),
  loadLastProject: (): Promise<unknown | null> => ipcRenderer.invoke('project:load-last'),
  exportRun: (project: unknown, settings: unknown, textPngs: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('export:run', project, settings, textPngs),
  exportCancel: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
  export2Start: (project: unknown, settings: unknown): Promise<unknown> =>
    ipcRenderer.invoke('export2:start', project, settings),
  export2Frame: (buf: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('export2:frame', buf),
  export2End: (): Promise<unknown> => ipcRenderer.invoke('export2:end'),
  export2Cancel: (): Promise<void> => ipcRenderer.invoke('export2:cancel'),
  smokeSetup: (): Promise<unknown> => ipcRenderer.invoke('smoke:setup'),
  toolSilence: (path: string, start: number, dur: number): Promise<unknown> =>
    ipcRenderer.invoke('tool:silence', path, start, dur),
  toolScenes: (path: string, start: number, dur: number, thr?: number): Promise<unknown> =>
    ipcRenderer.invoke('tool:scenes', path, start, dur, thr),
  toolBeats: (path: string): Promise<unknown> => ipcRenderer.invoke('tool:beats', path),
  toolTranscribe: (path: string, start: number, dur: number, lang?: string): Promise<unknown> =>
    ipcRenderer.invoke('tool:transcribe', path, start, dur, lang),
  toolRemoveBg: (path: string, mediaId: string, duration: number): Promise<unknown> =>
    ipcRenderer.invoke('tool:remove-bg', path, mediaId, duration),
  sysInfo: (): Promise<unknown> => ipcRenderer.invoke('sys:info'),
  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:show-item', path),
  on: (channel: (typeof RECEIVE_CHANNELS)[number], cb: (payload: unknown) => void): (() => void) => {
    if (!RECEIVE_CHANNELS.includes(channel)) return () => {}
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
