import { useEffect, useState } from 'react'
import { newProject } from '@shared/model'
import { AutoEditDialog } from './components/AutoEdit'
import { ExportDialog } from './components/ExportDialog'
import { Inspector } from './components/Inspector'
import { MediaPool } from './components/MediaPool'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { useEditor } from './store'

const FRAME = 1 / 30

export default function App(): React.JSX.Element {
  const saveState = useEditor((s) => s.saveState)
  const sys = useEditor((s) => s.sys)
  const projectName = useEditor((s) => s.project.name)
  const [exportOpen, setExportOpen] = useState(false)
  const [autoEditOpen, setAutoEditOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      if (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      ) {
        return
      }
      const s = useEditor.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        s.splitAtPlayhead()
      } else if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey) {
        s.addTextClip()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedClipId) s.deleteClip(s.selectedClipId)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        s.setPlaying(false)
        s.setPlayhead(s.playhead - (e.shiftKey ? 1 : FRAME))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        s.setPlaying(false)
        s.setPlayhead(s.playhead + (e.shiftKey ? 1 : FRAME))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const newProjectClick = (): void => {
    if (!window.confirm('Start a new empty project? Current work stays autosaved.')) return
    const s = useEditor.getState()
    s.init(newProject('My project', 1080, 1920))
    s.setSaveState('dirty') // autosave adopts the new project as "last"
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">LocalCut</span>
        <button className="btn small" onClick={newProjectClick} title="Start a new empty project">
          New
        </button>
        <span className="project-name" title="Rename in the Inspector (deselect any clip)">
          {projectName}
        </span>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? '✓ saved' : saveState === 'saving' ? 'saving…' : '● unsaved'}
        </span>
        <div className="spacer" />
        {sys && !sys.ffmpegFound && (
          <span className="badge warn" title="Place ffmpeg.exe and ffprobe.exe in tools\ffmpeg\">
            FFmpeg missing
          </span>
        )}
        {sys?.ffmpegFound && (
          <span className="badge ok" title={sys.ffmpegVersion}>
            {sys.qsv ? 'Quick Sync ✓' : 'CPU encode'}
          </span>
        )}
        <button className="btn" onClick={() => setAutoEditOpen(true)}>
          ✨ Auto-Edit
        </button>
        <button className="btn primary" onClick={() => setExportOpen(true)}>
          Export
        </button>
      </div>
      <div className="workspace">
        <MediaPool />
        <Preview />
        <Inspector />
      </div>
      <Timeline />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {autoEditOpen && <AutoEditDialog onClose={() => setAutoEditOpen(false)} />}
    </div>
  )
}
