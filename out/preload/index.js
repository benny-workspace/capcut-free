"use strict";
const electron = require("electron");
const RECEIVE_CHANNELS = ["media:proxy-ready", "export:progress", "bgremove:progress"];
const api = {
  openMediaDialog: () => electron.ipcRenderer.invoke("dialog:open-media"),
  savePathDialog: (defaultName) => electron.ipcRenderer.invoke("dialog:save-path", defaultName),
  ingest: (paths) => electron.ipcRenderer.invoke("media:ingest", paths),
  saveProject: (project) => electron.ipcRenderer.invoke("project:save", project),
  loadLastProject: () => electron.ipcRenderer.invoke("project:load-last"),
  exportRun: (project, settings, textPngs) => electron.ipcRenderer.invoke("export:run", project, settings, textPngs),
  exportCancel: () => electron.ipcRenderer.invoke("export:cancel"),
  export2Start: (project, settings) => electron.ipcRenderer.invoke("export2:start", project, settings),
  export2Frame: (buf) => electron.ipcRenderer.invoke("export2:frame", buf),
  export2End: () => electron.ipcRenderer.invoke("export2:end"),
  export2Cancel: () => electron.ipcRenderer.invoke("export2:cancel"),
  smokeSetup: () => electron.ipcRenderer.invoke("smoke:setup"),
  toolSilence: (path, start, dur) => electron.ipcRenderer.invoke("tool:silence", path, start, dur),
  toolScenes: (path, start, dur, thr) => electron.ipcRenderer.invoke("tool:scenes", path, start, dur, thr),
  toolBeats: (path) => electron.ipcRenderer.invoke("tool:beats", path),
  toolTranscribe: (path, start, dur, lang) => electron.ipcRenderer.invoke("tool:transcribe", path, start, dur, lang),
  toolRemoveBg: (path, mediaId, duration) => electron.ipcRenderer.invoke("tool:remove-bg", path, mediaId, duration),
  sysInfo: () => electron.ipcRenderer.invoke("sys:info"),
  showItemInFolder: (path) => electron.ipcRenderer.invoke("shell:show-item", path),
  on: (channel, cb) => {
    if (!RECEIVE_CHANNELS.includes(channel)) return () => {
    };
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
