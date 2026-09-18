import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { connect } from './browser.mjs';
import { ROOT, SHOTS, ensureDirs, readState, writeState } from './paths.mjs';

/**
 * Screen recording without a daemon and without Page.startScreencast. The
 * `record start` invocation persists the recording in state.json; from then on
 * every CLI invocation that can change pixels (open, click, type, js, …) saves
 * one JPEG of the viewport to disk before it exits. `record stop` feeds the
 * frames to ffmpeg with per-frame durations, so the gaps between invocations —
 * which are the agent thinking, not the user waiting — are capped at --max-gap
 * seconds and the video shows the interaction, not the reasoning. The GIF goes
 * through a constant-fps MP4 intermediate (concat → MP4 → palette) because
 * feeding the VFR JPEG stream straight to palettegen proved fragile. There is
 * no background process at any point: the browser is only ever driven by the
 * short-lived CLI processes themselves.
 */

export const RECORD_DIR = join(ROOT, 'record');
const FRAMES_DIR = join(RECORD_DIR, 'frames');
const FRAME_FILE = /^f\d{6}-(\d+)\.jpg$/;

const active = () => readState().recording || null;

/* ------------------------------------------------------------------ ffmpeg */

const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

/** ffmpeg is optional by design; detection must be loud, not silent. */
export const findFfmpeg = () => {
  for (const cand of [process.env.BROWSIN_FFMPEG, 'ffmpeg', ...FFMPEG_PATHS]) {
    if (!cand) continue;
    try { execFileSync(cand, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] }); return cand; } catch { /* next */ }
  }
  return null;
};

/* ----------------------------------------------------------------- capture */

const captureFrame = async (cdp, viewport) => {
  const rec = active();
  if (!rec) return null;
  const now = Date.now();
  // --max-seconds is enforced here, at the only moment a frame can be born.
  if (rec.maxSeconds && now - rec.startedAt > rec.maxSeconds * 1000) {
    if (!rec.capped) writeState({ recording: { ...rec, capped: true } });
    return null;
  }
  const vp = viewport || readState().viewport || { width: 1280, height: 800, dpr: 1 };
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: rec.quality,
    captureBeyondViewport: false,
    // Same division snap does: CDP multiplies clip.scale by the emulated DPR,
    // so 1/(dpr) yields frames at CSS pixel size regardless of the viewport.
    clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 / (vp.dpr || 1) },
  });
  mkdirSync(FRAMES_DIR, { recursive: true });
  const file = join(FRAMES_DIR, `f${String(rec.frames + 1).padStart(6, '0')}-${now}.jpg`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  writeState({ recording: { ...rec, frames: rec.frames + 1, lastFrameAt: now } });
  return file;
};

/**
 * The auto-frame. Called by every pixel-changing command right before it
 * detaches; a capture failure must never fail the action that already happened.
 */
export const afterAction = async (cdp) => {
  if (!active()) return;
  try { await captureFrame(cdp); } catch { /* the action already succeeded */ }
};

/* ------------------------------------------------------------ record start */

export const startRecording = async (args = {}) => {
  if (active()) {
    throw new Error('a recording is already active — `browsin record status` (stop or cancel it first)');
  }
  const name = String(args.name || 'recording').replace(/[^\w.-]+/g, '-').replace(/^-+/, '').slice(0, 60) || 'recording';
  // Same validation policy as --max-gap: a provided value that is not a number
  // is a loud error; a missing one falls back to the documented default.
  const fpsRaw = Number(args.fps);
  const qualityRaw = Number(args.quality);
  const rawMax = Number(args.maxSeconds);
  if (args.fps !== undefined && !Number.isFinite(fpsRaw)) throw new Error('--fps must be a number (frames per second)');
  if (args.quality !== undefined && !Number.isFinite(qualityRaw)) throw new Error('--quality must be a number (1–100)');
  if (args.maxSeconds !== undefined && !Number.isFinite(rawMax)) throw new Error('--max-seconds must be a number (0 disables the cap)');
  const fps = Math.min(Math.max(fpsRaw || 12, 1), 50);
  const quality = Math.min(Math.max(qualityRaw || 80, 1), 100);
  // 300s by default so an abandoned recording cannot grow without bound; an
  // explicit `--max-seconds 0` means no cap.
  const maxSeconds = args.maxSeconds === undefined ? 300 : Math.max(rawMax, 0);

  // Stale frames from a recording whose stop never ran — start over clean.
  rmSync(RECORD_DIR, { recursive: true, force: true });
  const { cdp, viewport } = await connect();
  writeState({ recording: { startedAt: Date.now(), name, fps, quality, maxSeconds, frames: 0, capped: false, lastFrameAt: 0 } });
  try {
    const first = await captureFrame(cdp, viewport);
    if (!first) throw new Error('first frame was not captured');
  } catch (err) {
    // A recording without a first frame is a lie in state.json — fail loudly
    // and leave nothing behind.
    cdp.close();
    cancelRecording();
    throw new Error(`could not capture the first frame — recording aborted (${err.message})`);
  }
  cdp.close();

  const ffmpeg = findFfmpeg();
  return [
    `rec   started — frames in ${FRAMES_DIR}`,
    `rec   ${fps} fps · quality ${quality}${maxSeconds ? ` · cap ${maxSeconds}s` : ' · no cap'}`,
    ffmpeg
      ? `rec   ffmpeg found (${ffmpeg}) — a frame is captured at the end of every visual command`
      : 'WARN  ffmpeg not found — frames will be captured but `record stop` cannot assemble. brew install ffmpeg',
  ].join('\n');
};

/* ------------------------------------------------------------- record stop */

const listFrames = () => {
  if (!existsSync(FRAMES_DIR)) return [];
  return readdirSync(FRAMES_DIR)
    .filter((f) => FRAME_FILE.test(f))
    .sort()
    .map((f) => ({ file: join(FRAMES_DIR, f), t: Number(FRAME_FILE.exec(f)[1]) }));
};

/** JPEG dimensions straight from the SOF marker — no image library needed. */
const jpegSize = (buf) => {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
};

export const stopRecording = async (args = {}) => {
  const rec = active();
  if (!rec) throw new Error('no active recording — `browsin record start` first');
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    throw new Error(`ffmpeg not found — install it (macOS: brew install ffmpeg); frames kept in ${FRAMES_DIR}`);
  }
  const frames = listFrames();
  if (!frames.length) {
    cancelRecording();
    throw new Error('nothing was captured — recording canceled');
  }

  // Output: -o/--out wins, and its extension (gif|mp4) infers the format;
  // --format must agree with it — a conflict is a loud error, never a silent
  // rename. With neither flag, `<name>.gif` lands in shots/.
  let requested = args.o || args.out;
  const declared = args.format ? String(args.format).toLowerCase() : null;
  if (declared && declared !== 'gif' && declared !== 'mp4') {
    throw new Error(`unknown --format ${declared} (gif, mp4)`);
  }
  const ext = requested ? extname(requested).slice(1).toLowerCase() : null;
  if (requested && ext && ext !== 'gif' && ext !== 'mp4') {
    throw new Error(`${requested}: unknown extension .${ext} — use .gif or .mp4, or pass --format`);
  }
  const format = declared || ext || 'gif';
  if (declared && ext && declared !== ext) {
    throw new Error(`--format ${declared} conflicts with the extension of ${requested} (.${ext})`);
  }
  if (requested && !ext) requested = `${requested}.${format}`;
  let out = requested;
  if (!out) {
    ensureDirs();
    out = join(SHOTS, `${rec.name}.${format}`);
    for (let n = 2; existsSync(out); n++) out = join(SHOTS, `${rec.name}-${n}.${format}`);
  }
  const parent = dirname(out);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // Per-frame duration: the real gap between invocations, floored at one tick
  // and capped at --max-gap (default 1s — the gap is the agent thinking, not
  // the user waiting; 0 lifts the cap) so reasoning time does not become video
  // time. The last frame is held ~1s so the video does not end on a blink.
  const tick = 1000 / rec.fps;
  const maxGap = args.maxGap === undefined ? 1 : Number(args.maxGap);
  if (!Number.isFinite(maxGap) || maxGap < 0) {
    throw new Error('--max-gap must be a non-negative number of seconds (0 disables the cap)');
  }
  const cap = maxGap > 0 ? maxGap * 1000 : Infinity;
  const finalHold = Math.min(1000, cap);
  let cappedGaps = 0;
  const durs = frames.map((f, i) => {
    if (i === frames.length - 1) return finalHold;
    const gap = frames[i + 1].t - f.t;
    if (gap > cap) cappedGaps++;
    return Math.min(Math.max(gap, tick), cap);
  });

  // ffconcat keeps the timing honest; the trailing repeat exists so the last
  // duration is honoured (the duplicate shows the same pixels, so it is free).
  // Paths are quoted ffmpeg-style: a single quote closes, escapes, reopens.
  const ffq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
  const listFile = join(RECORD_DIR, 'ffconcat.txt');
  writeFileSync(listFile, ['ffconcat version 1.0',
    ...frames.flatMap((f, i) => [`file ${ffq(f.file)}`, `duration ${(durs[i] / 1000).toFixed(3)}`]),
    `file ${ffq(frames[frames.length - 1].file)}`].join('\n'));

  // Everything is normalised to the first frame (a viewport change mid-flow
  // must not corrupt the stream); --width overrides it.
  const first = jpegSize(readFileSync(frames[0].file)) || { w: 1280, h: 800 };
  const width = Math.max(Number(args.width) || first.w, 2);
  const even = (n) => Math.max(Math.round(n) - (Math.round(n) % 2), 2);
  // GIF also passes through an H.264/yuv420p intermediate, so both dimensions
  // must be even for both output formats.
  const outW = even(width);
  const outH = even(first.h * width / first.w);

  // The direct concat→palette run failed on real frames; the robust order is
  // concat → constant-fps MP4 (timing and size normalised once) → palette GIF.
  // For mp4 the concat feed is already the target container, so one pass.
  const scale = `scale=${outW}:${outH}:flags=lanczos`;
  const midFile = join(RECORD_DIR, 'pipeline.mp4');
  const run = (ffArgs) => {
    try {
      execFileSync(ffmpeg, ['-v', 'error', '-y', ...ffArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`ffmpeg failed: ${String(err.stderr || err.message).split('\n')[0]}\n      frames kept in ${FRAMES_DIR}`);
    }
  };
  try {
    if (format === 'gif') {
      run(['-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', scale, '-r', String(rec.fps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', midFile]);
      run(['-i', midFile,
        '-vf', 'split[a][b];[a]palettegen=128[p];[b][p]paletteuse', '-loop', '0', out]);
    } else {
      const mp4Args = (vfrFlag) => ['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', scale,
        ...vfrFlag, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
      try { run(mp4Args(['-fps_mode', 'vfr'])); }
      catch { run(mp4Args(['-vsync', 'vfr'])); } // ffmpeg older than 5 spelled VFR this way
    }
  } finally {
    rmSync(midFile, { force: true });
  }

  const videoMs = durs.reduce((a, b) => a + b, 0);
  const wallMs = frames[frames.length - 1].t - frames[0].t + durs[durs.length - 1];
  const meta = {
    format,
    output: out,
    width: outW,
    height: outH,
    frames: frames.length,
    fps: rec.fps,
    quality: rec.quality,
    startedAt: rec.startedAt,
    stoppedAt: Date.now(),
    durationSeconds: Number((videoMs / 1000).toFixed(2)),
    wallSeconds: Number((wallMs / 1000).toFixed(2)),
    maxGapSeconds: cap === Infinity ? null : maxGap,
    cappedGaps,
    cappedByMaxSeconds: !!rec.capped,
    keptFrames: !!args['keep-frames'],
  };
  writeFileSync(`${out}.json`, JSON.stringify(meta, null, 2));

  const keep = !!args['keep-frames'];
  if (!keep) rmSync(RECORD_DIR, { recursive: true, force: true });
  writeState({ recording: null });

  // Headline matches the other commands (`snap  <path>`), so the harness can
  // parse the artifact path from one line.
  return [`record  ${out}`,
    `size  ${outW}x${outH} · ${frames.length} frame(s) · ${(videoMs / 1000).toFixed(1)}s · ${(statSync(out).size / 1024).toFixed(0)} KB`,
    `note  sidecar ${out}.json${cappedGaps ? ` · ${cappedGaps} gap(s) capped at ${maxGap}s` : ''}${keep ? ` · frames kept in ${FRAMES_DIR}` : ''}`]
    .join('\n');
};

/* ------------------------------------------------- record status / cancel */

export const statusRecording = () => {
  const rec = active();
  if (!rec) return 'rec   not recording';
  const wall = rec.lastFrameAt ? `${((Date.now() - rec.startedAt) / 1000).toFixed(0)}s` : '—';
  const ffmpeg = findFfmpeg();
  return [
    `rec   active — ${rec.frames} frame(s) · ${wall} wall`,
    `rec   ${rec.fps} fps · quality ${rec.quality}${rec.maxSeconds ? ` · cap ${rec.maxSeconds}s${rec.capped ? ' (reached — new frames dropped)' : ''}` : ''}`,
    `rec   frames in ${FRAMES_DIR}`,
    ffmpeg ? `rec   ffmpeg found (${ffmpeg})` : 'WARN  ffmpeg not found — `record stop` will fail (brew install ffmpeg)',
  ].join('\n');
};

/** Drops the frames and the state. `down` runs it; so does `record cancel`. */
export const cancelRecording = () => {
  const was = active();
  if (!was) return false; // no-op: `cancel`/`down` must not conjure a state.json
  rmSync(RECORD_DIR, { recursive: true, force: true });
  writeState({ recording: null });
  return true;
};
