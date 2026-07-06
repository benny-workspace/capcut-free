import { u as useEditor, a as api, d as defaultChromaKey, r as runFramePipeExport } from "./index-BEHm5lSz.js";
const log = (m) => console.warn("[smoke] " + m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function runSmoke() {
  try {
    const st = useEditor.getState;
    const assets = await api.smokeSetup();
    log("assets ready");
    st().setProjectMeta({ name: "smoke", width: 1280, height: 720 });
    const items = await api.ingest([assets.basePath, assets.greenPath]);
    st().addMedia(items);
    const base = items.find((i) => i.path === assets.basePath);
    const green = items.find((i) => i.path === assets.greenPath);
    if (!base || !green) throw new Error("ingest failed");
    st().addToTimeline(base.id);
    st().addOverlayClip(green.id);
    const overlay = () => st().project.tracks.find((t) => t.kind === "overlay");
    const greenClip = overlay().clips[0];
    st().updateClip(greenClip.id, {
      start: 0,
      duration: 4,
      chromaKey: defaultChromaKey(),
      mask: { type: "ellipse", cx: 0.5, cy: 0.5, w: 1.7, h: 1.7, feather: 0.1, rotation: 0, invert: false },
      transform: { x: 0.18, y: -0.16, scale: 0.55, rotation: 0, opacity: 1 }
    });
    st().addAdjustClip();
    const adjClip = overlay().clips.find((c) => c.kind === "adjust");
    st().updateClip(adjClip.id, {
      start: 0,
      duration: 4,
      color: { exposure: 0.05, contrast: 0.1, saturation: 0.25, temperature: 0.5 }
    });
    st().addTextClip();
    const textTrack = st().project.tracks.find((t) => t.kind === "text");
    st().updateClip(textTrack.clips[0].id, { start: 0, duration: 4, text: "GL smoke" });
    st().select(greenClip.id);
    st().setPlayhead(2);
    log("scene built, waiting for decoders");
    await wait(1800);
    log("starting frame-pipe export");
    let lastLogged = -1;
    const result = await runFramePipeExport(
      st().project,
      { outPath: assets.outPath, width: 640, height: 360, fps: 30, vBitrateK: 2500, encoder: "auto" },
      (r) => {
        if (r - lastLogged >= 0.25) {
          lastLogged = r;
          log("export " + Math.round(r * 100) + "%");
        }
      },
      { cancelled: false }
    );
    let phase2 = { segments: 0, captions: 0 };
    try {
      const sp = (await api.ingest([assets.speechPath]))[0];
      if (sp) {
        st().addMedia([sp]);
        st().addToTimeline(sp.id);
        const main = st().project.tracks.find((t) => t.id === "main");
        const spClip = main.clips[main.clips.length - 1];
        const sil = await api.toolSilence(sp.path, 0, sp.duration);
        const PAD = 0.075;
        const keep = [];
        let pos = 0;
        for (const r of sil) {
          const end = Math.min(r.start + PAD, sp.duration);
          if (end - pos > 0.25) keep.push({ in: pos, duration: end - pos });
          pos = Math.max(pos, r.end - PAD);
        }
        if (sp.duration - pos > 0.25) keep.push({ in: pos, duration: sp.duration - pos });
        if (keep.length > 0) st().replaceClipWithSegments(spClip.id, keep);
        const mainAfter = st().project.tracks.find((t) => t.id === "main");
        const firstSeg = mainAfter.clips[mainAfter.clips.length - keep.length];
        const tr = await api.toolTranscribe(sp.path, firstSeg.in, firstSeg.duration);
        if (tr.ok && tr.words.length > 0) st().addCaptionClips(firstSeg.id, tr.words, false);
        phase2 = {
          segments: keep.length,
          captions: st().project.tracks.find((t) => t.kind === "text").clips.length - 1
          // minus the GL smoke title
        };
        log(`phase2: ${phase2.segments} silence-cut segments, ${phase2.captions} caption clips`);
      }
    } catch (e) {
      log("phase2 failed: " + String(e));
    }
    console.warn("SMOKE-RESULT " + JSON.stringify({ ...result, phase2 }));
  } catch (e) {
    console.warn("SMOKE-RESULT " + JSON.stringify({ ok: false, error: String(e) }));
  }
}
export {
  runSmoke
};
