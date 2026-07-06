import { createRoot } from 'react-dom/client'
import type { Project, SysInfo } from '@shared/model'
import App from './App'
import { api, hasApi } from './api'
import { useEditor } from './store'
import './styles.css'

const AUTOSAVE_MS = 3000

async function boot(): Promise<void> {
  if (hasApi) {
    const [last, sys] = await Promise.all([api.loadLastProject(), api.sysInfo()])
    if (last) useEditor.getState().init(last as Project)
    useEditor.getState().setSys(sys as SysInfo)

    api.on('media:proxy-ready', (payload) => {
      const { mediaId, proxyPath } = payload as { mediaId: string; proxyPath: string }
      useEditor.getState().proxyReady(mediaId, proxyPath)
    })

    setInterval(() => {
      const s = useEditor.getState()
      if (s.saveState !== 'dirty') return
      s.setSaveState('saving')
      api
        .saveProject(s.project)
        .then(() => {
          // an edit during the save re-marks the project dirty; keep it that way
          const cur = useEditor.getState()
          if (cur.saveState === 'saving') cur.setSaveState('saved')
        })
        .catch(() => useEditor.getState().setSaveState('dirty'))
    }, AUTOSAVE_MS)
  }

  createRoot(document.getElementById('root')!).render(<App />)
  // deliberate escape hatch for scripted smoke/UI tests
  ;(window as unknown as Record<string, unknown>).__editor = useEditor

  if (hasApi && new URLSearchParams(location.search).has('smoke')) {
    const { runSmoke } = await import('./smoke')
    void runSmoke()
  }
}

void boot()
