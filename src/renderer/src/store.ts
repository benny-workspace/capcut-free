import { create } from 'zustand'
import type { Clip, KfProp, MediaItem, Project, SysInfo, Track, WordStamp } from '@shared/model'
import {
  MAIN_TRACK_ID,
  defaultColor,
  defaultTextStyle,
  defaultTransform,
  newProject,
  projectDuration,
  transitionOverlap
} from '@shared/model'
import { captionClipsFromWords, clamp } from './lib'

let idSeq = 0
export const uid = (p: string): string => p + Date.now().toString(36) + (idSeq++).toString(36)

function replaceTrackClips(project: Project, trackId: string, clips: Clip[]): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t))
  }
}

/** The main track is magnetic: clips sit back-to-back in array order,
 *  overlapping by the transition duration where one is set. */
function packedMain(project: Project): Project {
  const main = project.tracks.find((t) => t.id === MAIN_TRACK_ID)
  if (!main) return project
  let t = 0
  const clips = main.clips.map((c, i) => {
    const nc = { ...c, start: t }
    t += c.duration - transitionOverlap(c, main.clips[i + 1])
    return nc
  })
  return replaceTrackClips(project, MAIN_TRACK_ID, clips)
}

export interface ClipLocation {
  track: Track
  clip: Clip
  index: number
}

export function findClip(project: Project, clipId: string): ClipLocation | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}

type SaveState = 'saved' | 'dirty' | 'saving'

export interface EditorState {
  project: Project
  selectedClipId: string | null
  playhead: number
  playing: boolean
  pps: number // pixels per second (timeline zoom)
  snap: boolean
  saveState: SaveState
  undoStack: Project[]
  redoStack: Project[]
  sys: SysInfo | null

  init: (p: Project) => void
  setSys: (s: SysInfo) => void
  setSaveState: (s: SaveState) => void
  addMedia: (items: MediaItem[]) => void
  removeMedia: (mediaId: string) => void
  proxyReady: (mediaId: string, proxyPath: string) => void
  addToTimeline: (mediaId: string) => void
  addOverlayClip: (mediaId: string) => void
  addTextClip: () => void
  addAdjustClip: () => void
  updateClip: (clipId: string, patch: Partial<Clip>, withUndo?: boolean) => void
  /** replace a clip with sub-clips at the given source ranges (seconds) */
  replaceClipWithSegments: (clipId: string, segments: { in: number; duration: number }[]) => void
  /** create styled caption clips on the text track from word timestamps */
  addCaptionClips: (sourceClipId: string, words: WordStamp[], big: boolean) => void
  setMediaMatte: (mediaId: string, mattePath: string) => void
  setKeyframe: (clipId: string, prop: KfProp, tLocal: number, v: number) => void
  clearKeyframes: (clipId: string) => void
  replaceTimeline: (tracks: Track[], media?: MediaItem[]) => void
  reorderMain: (clipId: string, newIndex: number) => void
  moveToTrack: (clipId: string, trackId: string, start: number, mainIndex?: number) => void
  beginInteraction: () => void
  splitAtPlayhead: () => void
  deleteClip: (clipId: string) => void
  undo: () => void
  redo: () => void
  select: (id: string | null) => void
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  setPps: (v: number) => void
  toggleSnap: () => void
  setProjectMeta: (patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps'>>) => void
}

const pushUndo = (s: EditorState): Project[] => [...s.undoStack.slice(-59), s.project]

export const useEditor = create<EditorState>((set, get) => ({
  project: newProject('My project', 1080, 1920),
  selectedClipId: null,
  playhead: 0,
  playing: false,
  pps: 60,
  snap: true,
  saveState: 'saved',
  undoStack: [],
  redoStack: [],
  sys: null,

  init: (p) =>
    set({
      project: p,
      undoStack: [],
      redoStack: [],
      selectedClipId: null,
      playhead: 0,
      playing: false,
      saveState: 'saved'
    }),

  setSys: (sys) => set({ sys }),
  setSaveState: (saveState) => set({ saveState }),

  addMedia: (items) =>
    set((s) => ({
      project: { ...s.project, media: [...s.project.media, ...items] },
      undoStack: pushUndo(s),
      redoStack: [],
      saveState: 'dirty'
    })),

  removeMedia: (mediaId) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.mediaId !== mediaId)
      }))
      let project: Project = {
        ...s.project,
        tracks,
        media: s.project.media.filter((m) => m.id !== mediaId)
      }
      project = packedMain(project)
      return { project, undoStack: pushUndo(s), redoStack: [], saveState: 'dirty' }
    }),

  proxyReady: (mediaId, proxyPath) =>
    set((s) => ({
      project: {
        ...s.project,
        media: s.project.media.map((m) => (m.id === mediaId ? { ...m, proxyPath } : m))
      },
      saveState: 'dirty'
    })),

  addToTimeline: (mediaId) =>
    set((s) => {
      const media = s.project.media.find((m) => m.id === mediaId)
      if (!media) return {}
      const clip: Clip = {
        id: uid('c'),
        kind: media.type === 'image' ? 'image' : media.type === 'audio' ? 'audio' : 'video',
        mediaId,
        start: 0,
        duration: media.duration > 0 ? media.duration : 4,
        in: 0,
        volume: 1,
        muted: false,
        speed: 1,
        transform: defaultTransform()
      }
      let project = s.project
      if (media.type === 'audio') {
        const track = project.tracks.find((t) => t.kind === 'audio')
        if (!track) return {}
        let start = s.playhead
        for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
          if (start < c.start + c.duration && start + clip.duration > c.start) {
            start = c.start + c.duration
          }
        }
        clip.start = start
        project = replaceTrackClips(project, track.id, [...track.clips, clip])
      } else {
        const main = project.tracks.find((t) => t.id === MAIN_TRACK_ID)
        if (!main) return {}
        project = packedMain(replaceTrackClips(project, MAIN_TRACK_ID, [...main.clips, clip]))
      }
      return {
        project,
        selectedClipId: clip.id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  addOverlayClip: (mediaId) =>
    set((s) => {
      const media = s.project.media.find((m) => m.id === mediaId)
      if (!media || media.type === 'audio') return {}
      const track = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!track) return {}
      const clip: Clip = {
        id: uid('c'),
        kind: media.type === 'image' ? 'image' : 'video',
        mediaId,
        start: s.playhead,
        duration: media.type === 'image' ? 4 : media.duration > 0 ? media.duration : 4,
        in: 0,
        volume: 1,
        muted: false,
        speed: 1,
        transform: { ...defaultTransform(), scale: 0.45, x: 0.22, y: -0.22 }
      }
      return {
        project: replaceTrackClips(s.project, track.id, [...track.clips, clip]),
        selectedClipId: clip.id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  addTextClip: () =>
    set((s) => {
      const track = s.project.tracks.find((t) => t.kind === 'text')
      if (!track) return {}
      const clip: Clip = {
        id: uid('c'),
        kind: 'text',
        start: s.playhead,
        duration: 3,
        in: 0,
        volume: 0,
        muted: true,
        speed: 1,
        transform: defaultTransform(),
        text: 'Your text',
        textStyle: defaultTextStyle()
      }
      return {
        project: replaceTrackClips(s.project, track.id, [...track.clips, clip]),
        selectedClipId: clip.id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  addAdjustClip: () =>
    set((s) => {
      const track = s.project.tracks.find((t) => t.kind === 'overlay')
      if (!track) return {}
      const clip: Clip = {
        id: uid('c'),
        kind: 'adjust',
        start: s.playhead,
        duration: 3,
        in: 0,
        volume: 0,
        muted: true,
        speed: 1,
        transform: defaultTransform(),
        color: defaultColor()
      }
      return {
        project: replaceTrackClips(s.project, track.id, [...track.clips, clip]),
        selectedClipId: clip.id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  updateClip: (clipId, patch, withUndo = true) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc) return {}
      const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
      let project = replaceTrackClips(s.project, loc.track.id, clips)
      if (loc.track.id === MAIN_TRACK_ID) project = packedMain(project)
      return {
        project,
        saveState: 'dirty',
        ...(withUndo ? { undoStack: pushUndo(s), redoStack: [] } : {})
      }
    }),

  reorderMain: (clipId, newIndex) =>
    set((s) => {
      const main = s.project.tracks.find((t) => t.id === MAIN_TRACK_ID)
      if (!main) return {}
      const idx = main.clips.findIndex((c) => c.id === clipId)
      if (idx < 0) return {}
      const target = clamp(newIndex, 0, main.clips.length - 1)
      if (target === idx) return {}
      const clips = [...main.clips]
      const [c] = clips.splice(idx, 1)
      clips.splice(target, 0, c)
      return {
        project: packedMain(replaceTrackClips(s.project, MAIN_TRACK_ID, clips)),
        saveState: 'dirty'
      }
    }),

  moveToTrack: (clipId, trackId, start, mainIndex) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc) return {}
      if (loc.track.id === trackId && trackId !== MAIN_TRACK_ID) {
        // simple move within a free track
        const clips = loc.track.clips.map((c) =>
          c.id === clipId ? { ...c, start: Math.max(0, start) } : c
        )
        return { project: replaceTrackClips(s.project, trackId, clips), saveState: 'dirty' }
      }
      // cross-track move
      let project = replaceTrackClips(
        s.project,
        loc.track.id,
        loc.track.clips.filter((c) => c.id !== clipId)
      )
      if (loc.track.id === MAIN_TRACK_ID) project = packedMain(project)
      const target = project.tracks.find((t) => t.id === trackId)
      if (!target) return {}
      const moved: Clip = { ...loc.clip, start: Math.max(0, start) }
      if (trackId === MAIN_TRACK_ID) {
        const clips = [...target.clips]
        clips.splice(clamp(mainIndex ?? clips.length, 0, clips.length), 0, moved)
        project = packedMain(replaceTrackClips(project, MAIN_TRACK_ID, clips))
      } else {
        project = replaceTrackClips(project, trackId, [...target.clips, moved])
      }
      return { project, saveState: 'dirty' }
    }),

  replaceClipWithSegments: (clipId, segments) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc || segments.length === 0) return {}
      const speed = loc.clip.speed || 1
      let t = loc.clip.start
      const subs: Clip[] = segments.map((seg) => {
        const dur = seg.duration / speed
        const c: Clip = {
          ...loc.clip,
          id: uid('c'),
          in: seg.in,
          start: t,
          duration: dur,
          transitionAfter: undefined
        }
        t += dur
        return c
      })
      const clips = [...loc.track.clips]
      clips.splice(loc.index, 1, ...subs)
      let project = replaceTrackClips(s.project, loc.track.id, clips)
      if (loc.track.id === MAIN_TRACK_ID) project = packedMain(project)
      return {
        project,
        selectedClipId: subs[0].id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  addCaptionClips: (sourceClipId, words, big) =>
    set((s) => {
      const loc = findClip(s.project, sourceClipId)
      const track = s.project.tracks.find((t) => t.kind === 'text')
      if (!loc || !track || words.length === 0) return {}
      const speed = loc.clip.speed || 1
      // words are relative to the analyzed source range; map to timeline time
      const absolute: WordStamp[] = words.map((w) => ({
        text: w.text,
        t0: loc.clip.start + w.t0 / speed,
        t1: loc.clip.start + w.t1 / speed
      }))
      const clips = captionClipsFromWords(absolute, big, () => uid('c'))
      return {
        project: replaceTrackClips(s.project, track.id, [...track.clips, ...clips]),
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  setMediaMatte: (mediaId, mattePath) =>
    set((s) => ({
      project: {
        ...s.project,
        media: s.project.media.map((m) => (m.id === mediaId ? { ...m, mattePath } : m))
      },
      saveState: 'dirty'
    })),

  setKeyframe: (clipId, prop, tLocal, v) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc) return {}
      const t = clamp(tLocal, 0, loc.clip.duration)
      const kf = { ...(loc.clip.keyframes ?? {}) }
      const list = [...(kf[prop] ?? [])].filter((k) => Math.abs(k.t - t) > 0.04)
      list.push({ t, v })
      list.sort((a, b) => a.t - b.t)
      kf[prop] = list
      const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, keyframes: kf } : c))
      return {
        project: replaceTrackClips(s.project, loc.track.id, clips),
        saveState: 'dirty'
      }
    }),

  clearKeyframes: (clipId) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc) return {}
      const clips = loc.track.clips.map((c) =>
        c.id === clipId ? { ...c, keyframes: undefined } : c
      )
      return {
        project: replaceTrackClips(s.project, loc.track.id, clips),
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  replaceTimeline: (tracks, media) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks,
        media: media ?? s.project.media
      },
      selectedClipId: null,
      playhead: 0,
      undoStack: pushUndo(s),
      redoStack: [],
      saveState: 'dirty'
    })),

  beginInteraction: () =>
    set((s) => ({ undoStack: pushUndo(s), redoStack: [] })),

  splitAtPlayhead: () =>
    set((s) => {
      const ph = s.playhead
      let loc: ClipLocation | null = null
      if (s.selectedClipId) {
        const l = findClip(s.project, s.selectedClipId)
        if (l && ph > l.clip.start + 0.05 && ph < l.clip.start + l.clip.duration - 0.05) loc = l
      }
      if (!loc) {
        for (const track of [...s.project.tracks].reverse()) {
          for (let i = 0; i < track.clips.length; i++) {
            const c = track.clips[i]
            if (ph > c.start + 0.05 && ph < c.start + c.duration - 0.05) {
              loc = { track, clip: c, index: i }
              break
            }
          }
          if (loc) break
        }
      }
      if (!loc) return {}
      const off = ph - loc.clip.start
      // the transition (if any) belongs after the second half; source offset
      // advances by timeline offset * speed
      const first: Clip = { ...loc.clip, duration: off, transitionAfter: undefined }
      const second: Clip = {
        ...loc.clip,
        id: uid('c'),
        start: loc.clip.start + off,
        duration: loc.clip.duration - off,
        in: loc.clip.kind === 'text' ? 0 : loc.clip.in + off * (loc.clip.speed || 1)
      }
      const clips = [...loc.track.clips]
      clips.splice(loc.index, 1, first, second)
      let project = replaceTrackClips(s.project, loc.track.id, clips)
      if (loc.track.id === MAIN_TRACK_ID) project = packedMain(project)
      return {
        project,
        selectedClipId: second.id,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  deleteClip: (clipId) =>
    set((s) => {
      const loc = findClip(s.project, clipId)
      if (!loc) return {}
      let project = replaceTrackClips(
        s.project,
        loc.track.id,
        loc.track.clips.filter((c) => c.id !== clipId)
      )
      if (loc.track.id === MAIN_TRACK_ID) project = packedMain(project)
      return {
        project,
        selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId,
        undoStack: pushUndo(s),
        redoStack: [],
        saveState: 'dirty'
      }
    }),

  undo: () =>
    set((s) => {
      const prev = s.undoStack[s.undoStack.length - 1]
      if (!prev) return {}
      return {
        project: prev,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, s.project],
        selectedClipId: null,
        saveState: 'dirty'
      }
    }),

  redo: () =>
    set((s) => {
      const next = s.redoStack[s.redoStack.length - 1]
      if (!next) return {}
      return {
        project: next,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, s.project],
        selectedClipId: null,
        saveState: 'dirty'
      }
    }),

  select: (selectedClipId) => set({ selectedClipId }),

  setPlayhead: (t) =>
    set((s) => ({ playhead: clamp(t, 0, Math.max(projectDuration(s.project), 0)) })),

  setPlaying: (playing) => set({ playing }),
  setPps: (v) => set({ pps: clamp(v, 8, 300) }),
  toggleSnap: () => set((s) => ({ snap: !s.snap })),

  setProjectMeta: (patch) =>
    set((s) => ({
      project: { ...s.project, ...patch },
      undoStack: pushUndo(s),
      redoStack: [],
      saveState: 'dirty'
    }))
}))
