// Headless acceptance test for the AI tool layer: silence detection, scene
// detection, beat detection, and whisper transcription — using REAL speech
// generated with the Windows built-in TTS voice. Run: npx tsx scripts/test-tools.ts

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { detectBeats, detectScenes, detectSilence, transcribe, whisperAvailable } from '../src/main/tools'
import { modnetAvailable } from '../src/main/tools'
import { removeBackground } from '../src/main/toolsBg'

const root = resolve(process.cwd())
const ffmpeg = join(root, 'tools/ffmpeg/ffmpeg.exe')
const work = join(root, 'data', 'cache', 'test-tools')

let failures = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
  if (!ok) failures++
}

function sh(exe: string, args: string[]): number {
  return spawnSync(exe, args, { windowsHide: true, stdio: 'ignore' }).status ?? -1
}

async function main(): Promise<void> {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  // ---- real speech via Windows SAPI TTS: two sentences with a long pause ----
  const speechWav = join(work, 'speech.wav')
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.SetOutputToWaveFile('${speechWav.replace(/'/g, "''")}');`,
    "$s.Speak('Hello and welcome to Local Cut.');",
    "$s.Speak([System.Speech.Synthesis.PromptBuilder]::new());",
    '$b = New-Object System.Speech.Synthesis.PromptBuilder;',
    "$b.AppendBreak([TimeSpan]::FromSeconds(2));",
    '$s.Speak($b);',
    "$s.Speak('Automatic captions are working.');",
    '$s.Dispose();'
  ].join(' ')
  const tts = spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })
  check('tts-generate', tts.status === 0 && existsSync(speechWav), speechWav)

  // speech video (for silence/caption context a plain wav is enough; tools take any media)

  // ---- silence detection: expect the 2s break to be found ----
  const silences = await detectSilence(speechWav, 0, 12)
  const midSilence = silences.find((s) => s.end - s.start > 1.2)
  check(
    'silence-detect',
    !!midSilence,
    `found ${silences.length} silences: ` +
      silences.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(', ')
  )

  // ---- scene detection: two visually distinct halves ----
  const sceneVid = join(work, 'scenes.mp4')
  sh(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'smptehdbars=size=320x180:rate=30:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', sceneVid
  ])
  const scenes = await detectScenes(sceneVid, 0, 4, 0.3)
  check(
    'scene-detect',
    scenes.some((t) => Math.abs(t - 2) < 0.2),
    `boundaries: [${scenes.map((t) => t.toFixed(2)).join(', ')}] (expected ~2.00)`
  )

  // ---- beat detection: click track at 120 BPM ----
  const clickWav = join(work, 'clicks.wav')
  sh(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=8',
    '-af', "volume='if(lt(mod(t,0.5),0.07),1,0.02)':eval=frame",
    clickWav
  ])
  const beats = await detectBeats(clickWav)
  check(
    'beat-detect',
    beats.beats.length >= 12 && Math.abs(beats.bpm - 120) <= 8,
    `${beats.beats.length} beats, ${beats.bpm} BPM (expected ~16 @ 120)`
  )

  // ---- transcription (whisper.cpp) ----
  if (whisperAvailable()) {
    const tr = await transcribe(speechWav, 0, 12, 'en')
    const text = tr.words.map((w) => w.text).join(' ').toLowerCase()
    check(
      'transcribe',
      tr.ok && text.includes('welcome') && text.includes('captions'),
      tr.ok ? `"${text}" (${tr.words.length} words)` : tr.error || 'failed'
    )
    const timed = tr.words.every((w) => w.t1 > w.t0 && w.t0 >= 0)
    check('word-timestamps', timed && tr.words.length > 5, `${tr.words.length} word stamps, monotonic`)
  } else {
    check('transcribe', false, 'whisper binary or model missing')
  }

  // ---- background removal pipeline (matte quality needs real portraits;
  // this verifies decode -> MODNet -> VP9-alpha encode end to end) ----
  if (modnetAvailable()) {
    const fakeSender = { send: () => {} } as unknown as Parameters<typeof removeBackground>[0]
    const bg = await removeBackground(fakeSender, sceneVid, 'testmedia', 4)
    if (!bg.ok) {
      check('bg-remove', false, bg.error || 'failed')
    } else {
      const probe = spawnSync(
        join(root, 'tools/ffmpeg/ffprobe.exe'),
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', bg.mattePath!],
        { encoding: 'utf8', windowsHide: true }
      )
      const j = JSON.parse(probe.stdout || '{}')
      const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video')
      const dur = parseFloat(j.format?.duration ?? '0')
      // VP9 alpha lives in container side data: stream tag alpha_mode=1
      const hasAlpha = v?.tags?.alpha_mode === '1' || v?.pix_fmt?.startsWith('yuva')
      check(
        'bg-remove',
        v?.codec_name === 'vp9' && hasAlpha && Math.abs(dur - 4) < 0.5,
        `${v?.codec_name} alpha_mode=${v?.tags?.alpha_mode} ${dur.toFixed(2)}s -> ${bg.mattePath}`
      )
    }
  } else {
    check('bg-remove', false, 'modnet.onnx missing')
  }

  console.log(failures === 0 ? 'ALL TOOL TESTS PASSED' : `${failures} TOOL TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
