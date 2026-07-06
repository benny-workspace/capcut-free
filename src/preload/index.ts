import { contextBridge, ipcRenderer } from 'electron'

const RECEIVE_CHANNELS = ['media:proxy-ready', 'export:progress'] as const

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
