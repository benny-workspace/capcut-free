import type {
  ExportProgress,
  ExportResult,
  ExportSettings,
  MediaItem,
  Project,
  SysInfo
} from '@shared/model'

export interface TextPngPayload {
  clipId: string
  dataUrl: string
}

interface Api {
  openMediaDialog(): Promise<string[]>
  savePathDialog(defaultName: string): Promise<string | null>
  ingest(paths: string[]): Promise<MediaItem[]>
  saveProject(p: Project): Promise<boolean>
  loadLastProject(): Promise<Project | null>
  exportRun(p: Project, s: ExportSettings, textPngs: TextPngPayload[]): Promise<ExportResult>
  exportCancel(): Promise<void>
  sysInfo(): Promise<SysInfo>
  showItemInFolder(path: string): Promise<void>
  on(
    channel: 'media:proxy-ready' | 'export:progress',
    cb: (payload: unknown) => void
  ): () => void
}

declare global {
  interface Window {
    api?: Api
  }
}

export const hasApi = typeof window !== 'undefined' && !!window.api

export const api: Api = window.api ?? ({} as Api)

export function mediaUrl(path: string): string {
  return (
    'media:///' +
    encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
  )
}

export type { ExportProgress }
