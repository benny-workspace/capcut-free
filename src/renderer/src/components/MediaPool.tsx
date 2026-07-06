import { useState } from 'react'
import { api, hasApi } from '../api'
import { formatTime, proxyPending } from '../lib'
import { useEditor } from '../store'
import type { MediaItem } from '@shared/model'

export function MediaPool(): React.JSX.Element {
  const media = useEditor((s) => s.project.media)
  const addMedia = useEditor((s) => s.addMedia)
  const removeMedia = useEditor((s) => s.removeMedia)
  const addToTimeline = useEditor((s) => s.addToTimeline)
  const addOverlayClip = useEditor((s) => s.addOverlayClip)
  const [importing, setImporting] = useState(false)

  const doImport = async (): Promise<void> => {
    if (!hasApi || importing) return
    setImporting(true)
    try {
      const paths = await api.openMediaDialog()
      if (paths.length > 0) {
        const items = (await api.ingest(paths)) as MediaItem[]
        if (items.length > 0) addMedia(items)
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="media-pool">
      <div className="panel-header">
        <span>Media</span>
        <button className="btn primary" onClick={doImport} disabled={importing}>
          {importing ? 'Importing…' : '+ Import'}
        </button>
      </div>
      <div className="media-grid">
        {media.length === 0 && (
          <div className="empty-hint">
            Import video, audio or images to get started.
          </div>
        )}
        {media.map((m) => (
          <div key={m.id} className="media-item">
            <div className="media-thumb">
              {m.thumbnail ? (
                <img src={m.thumbnail} alt="" draggable={false} />
              ) : (
                <div className={`thumb-placeholder t-${m.type}`}>
                  {m.type === 'audio' ? '♪' : m.type === 'image' ? '🖼' : '🎬'}
                </div>
              )}
              {m.duration > 0 && m.type !== 'image' && (
                <span className="media-dur">{formatTime(m.duration).slice(0, 5)}</span>
              )}
              {proxyPending(m.type, m.vcodec, m.proxyPath) && (
                <span className="proxy-badge">optimizing…</span>
              )}
            </div>
            <div className="media-name" title={m.path}>
              {m.name}
            </div>
            <div className="media-actions">
              <button className="btn small" onClick={() => addToTimeline(m.id)} title="Add to timeline">
                + Add
              </button>
              {m.type !== 'audio' && (
                <button className="btn small" onClick={() => addOverlayClip(m.id)} title="Add as picture-in-picture overlay">
                  PiP
                </button>
              )}
              <button className="btn small danger" onClick={() => removeMedia(m.id)} title="Remove from project">
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
