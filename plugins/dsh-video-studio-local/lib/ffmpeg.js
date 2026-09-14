// FFmpeg/ffprobe spawn wrapper. The binaries are bundled under bin/ so users
// never install FFmpeg; the host resolves them relative to this module and
// always spawns with an argument array (never a shell string), so paths with
// spaces or non-ASCII characters survive.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FFMPEG = join(HERE, '..', 'bin', 'ffmpeg.exe');
export const FFPROBE = join(HERE, '..', 'bin', 'ffprobe.exe');

export function run(exe, args, opts) {
  const timeoutMs = opts && opts.timeoutMs ? opts.timeoutMs : 600000;
  const cwd = opts && opts.cwd ? opts.cwd : undefined;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, stdout, stderr, error: String((err && err.message) || err) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr, error: null }); });
  });
}

export async function probe(path) {
  const res = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60000 });
  if (res.error || res.code !== 0) {
    throw new Error('ffprobe failed: ' + (res.error || res.stderr || ('exit ' + res.code)));
  }
  let data = {};
  try { data = JSON.parse(res.stdout || '{}'); } catch (e) { data = {}; }
  const streams = data.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fpsRaw = v ? (v.avg_frame_rate || v.r_frame_rate || '0/0') : '0/0';
  const m = String(fpsRaw).split('/');
  let fps = 0;
  if (m.length === 2 && Number(m[1]) !== 0) fps = Number(m[0]) / Number(m[1]);
  return {
    duration: Number(data.format && data.format.duration) || (v ? Number(v.duration) : 0) || 0,
    width: v ? (Number(v.width) || 0) : 0,
    height: v ? (Number(v.height) || 0) : 0,
    fps: Math.round(fps * 1000) / 1000,
    hasVideo: !!v,
    hasAudio: !!a,
    codec: v ? (v.codec_name || '') : '',
  };
}

// atempo only accepts 0.5..2.0; chain factors to reach arbitrary speed while
// keeping pitch (speed without pitch change).
function atempoChain(s) {
  const parts = [];
  let r = s;
  while (r > 2.0) { parts.push('2.0'); r /= 2.0; }
  while (r < 0.5) { parts.push('0.5'); r /= 0.5; }
  parts.push(String(Math.round(r * 1000) / 1000));
  return parts.map((p) => 'atempo=' + p).join(',');
}

// Video filter: optional speed (setpts), aspect-preserving scale/pad or
// crop-to-fill, then fixed fps.
function buildVf(o) {
  const parts = [];
  const speed = (o && o.speed) ? o.speed : 1;
  if (speed !== 1) parts.push('setpts=(PTS-STARTPTS)/' + speed);
  const w = (o && o.width) ? o.width : 1080;
  const h = (o && o.height) ? o.height : 1920;
  if (o && o.fill === 'crop') {
    parts.push('scale=' + w + ':' + h + ':force_original_aspect_ratio=increase', 'crop=' + w + ':' + h);
  } else {
    parts.push('scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease', 'pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2');
  }
  parts.push('fps=' + ((o && o.fps) ? o.fps : 30));
  return parts.join(',');
}

// Audio filter: atempo chain for speed, or null when no change.
function buildAf(o) {
  const speed = (o && o.speed) ? o.speed : 1;
  if (speed !== 1) return atempoChain(speed);
  return null;
}

export async function cut(src, dst, o) {
  const start = (o && typeof o.start === 'number') ? o.start : 0;
  const dur = (o && typeof o.dur === 'number') ? o.dur : 3;
  const crf = (o && o.crf) ? o.crf : 20;
  const hasAudio = o && o.hasAudio && !o.mute;
  const vf = buildVf(o);
  const af = buildAf(o);

  const args = ['-y', '-ss', String(start), '-i', src];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  args.push('-t', String(dur), '-vf', vf);
  if (af) args.push('-af', af);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p');
  if (!hasAudio) args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2', '-map', '0:v', '-map', '1:a');
  else args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2');
  args.push(dst);

  const res = await run(FFMPEG, args, { timeoutMs: 300000 });
  if (res.error || res.code !== 0) {
    throw new Error('cut failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}

export async function concat(files, out) {
  const list = files.map((f) => "file '" + String(f) + "'").join('\n');
  const listFile = out + '.concat.txt';
  await writeFile(listFile, list, 'utf8');
  try {
    const res = await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], { timeoutMs: 600000 });
    if (res.error || res.code !== 0) {
      throw new Error('concat failed: ' + (res.error || String(res.stderr || '').slice(-400)));
    }
  } finally {
    await unlink(listFile).catch(() => {});
  }
}

// Join already-normalized clips with a video xfade and an audio acrossfade.
// All clips must share resolution/fps/pix_fmt and AAC 44100 stereo (cut() does).
export async function concatTransitions(files, out, o) {
  const n = files.length;
  if (n < 2) throw new Error('转场拼接至少需要 2 段');
  const trans = (o && o.transition) ? o.transition : 'fade';
  const d = (o && typeof o.duration === 'number') ? o.duration : 0.5;
  const crf = (o && o.crf) ? o.crf : 20;

  const durs = [];
  for (const f of files) { durs.push((await probe(f)).duration); }

  const inputs = [];
  for (const f of files) { inputs.push('-i', f); }

  const vfParts = [];
  const afParts = [];
  let vprev = '[0:v]';
  let aprev = '[0:a]';
  let offset = 0;
  for (let i = 1; i < n; i++) {
    offset = offset + durs[i - 1] - d;
    const vout = '[v' + i + ']';
    const aout = '[a' + i + ']';
    vfParts.push(vprev + '[' + i + ':v]xfade=transition=' + trans + ':duration=' + d + ':offset=' + offset + vout);
    afParts.push(aprev + '[' + i + ':a]acrossfade=d=' + d + aout);
    vprev = vout;
    aprev = aout;
  }
  const filter = vfParts.join(';') + ';' + afParts.join(';');

  const args = ['-y', ...inputs, '-filter_complex', filter, '-map', vprev, '-map', aprev,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', out];
  const res = await run(FFMPEG, args, { timeoutMs: 600000 });
  if (res.error || res.code !== 0) {
    throw new Error('transition concat failed: ' + (res.error || String(res.stderr || '').slice(-600)));
  }
}

export async function mixBgm(video, bgm, out, o) {
  const volume = (o && typeof o.volume === 'number') ? o.volume : 0.8;
  const keep = !(o && o.keepOriginal === false);
  let filter;
  if (keep) {
    filter = '[1:a]volume=' + volume + '[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]';
  } else {
    filter = '[1:a]volume=' + volume + '[a]';
  }
  const args = ['-y', '-i', video, '-i', bgm, '-filter_complex', filter,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2'];
  if (!keep) args.push('-shortest');
  args.push(out);
  const res = await run(FFMPEG, args, { timeoutMs: 300000 });
  if (res.error || res.code !== 0) {
    throw new Error('bgm mix failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}

// Escape a Windows path for the subtitles/ass filter (colon + backslash + quote).
export function escapeSubtitlePath(p) {
  const esc = String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
  return "'" + esc + "'";
}

export async function burnSubtitle(video, sub, out, o) {
  const font = (o && o.font) ? o.font : 'Microsoft YaHei';
  const crf = (o && o.crf) ? o.crf : 20;
  const isAss = /\.ass$/i.test(sub);
  const esc = escapeSubtitlePath(sub);
  let vf;
  if (isAss) vf = 'ass=' + esc;
  else vf = 'subtitles=' + esc + ":force_style='FontName=" + font + "'";
  const args = ['-y', '-i', video, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'copy', out];
  const res = await run(FFMPEG, args, { timeoutMs: 300000 });
  if (res.error || res.code !== 0) {
    throw new Error('subtitle burn failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}

export async function thumbnail(src, dst, at) {
  const t = typeof at === 'number' ? at : 0.5;
  const res = await run(FFMPEG, ['-y', '-ss', String(t), '-i', src, '-frames:v', '1', '-q:v', '3', dst], { timeoutMs: 60000 });
  if (res.error || res.code !== 0) {
    throw new Error('thumbnail failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}
// Convert a media file to another format. The output extension selects the
// target format and codec: video containers (mp4/mov/mkv/webm/avi/ts/flv),
// audio extraction (mp3/wav/aac/m4a/flac/ogg), GIF, or a single frame image
// (jpg/png/webp).
function convertArgs(src, dst, ext, crf, fps, scale) {
  switch (ext) {
    case 'mp4': case 'mov': case 'm4v':
      return ['-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', dst];
    case 'mkv':
      return ['-y', '-i', src, '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', dst];
    case 'webm':
      return ['-y', '-i', src, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', dst];
    case 'avi':
      return ['-y', '-i', src, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', dst];
    case 'ts': case 'flv':
      return ['-y', '-i', src, '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', dst];
    case 'mp3':
      return ['-y', '-i', src, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', dst];
    case 'wav':
      return ['-y', '-i', src, '-vn', '-c:a', 'pcm_s16le', dst];
    case 'm4a': case 'aac':
      return ['-y', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', dst];
    case 'flac':
      return ['-y', '-i', src, '-vn', '-c:a', 'flac', dst];
    case 'ogg':
      return ['-y', '-i', src, '-vn', '-c:a', 'libvorbis', dst];
    case 'gif': {
      const vf = 'fps=' + fps + ',scale=' + scale + ':flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse';
      return ['-y', '-i', src, '-vf', vf, '-loop', '0', dst];
    }
    case 'jpg': case 'jpeg': case 'png': case 'webp':
      return ['-y', '-i', src, '-frames:v', '1', '-q:v', '3', dst];
    default:
      throw new Error('不支持的目标格式扩展名 .' + ext + '（视频 mp4/mov/mkv/webm/avi/ts/flv；音频 mp3/wav/aac/m4a/flac/ogg；动图 gif；图片 jpg/png/webp）');
  }
}

export async function convert(src, dst, o) {
  const ext = String(dst).split('.').pop().toLowerCase();
  const crf = (o && o.crf) ? o.crf : 20;
  const fps = (o && o.fps) ? o.fps : 10;
  const scale = (o && o.scale) ? o.scale : '480:-1';
  const args = convertArgs(src, dst, ext, crf, fps, scale);
  const res = await run(FFMPEG, args, { timeoutMs: 600000 });
  if (res.error || res.code !== 0) {
    throw new Error('convert failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}
// Map a semantic filter object to an FFmpeg video-filter fragment.
function filterToVf(f) {
  const t = f && f.type;
  switch (t) {
    case 'brightness': return 'eq=brightness=' + ((f.value != null) ? f.value : 0.1);
    case 'contrast': return 'eq=contrast=' + ((f.value != null) ? f.value : 1.2);
    case 'saturation': return 'eq=saturation=' + ((f.value != null) ? f.value : 1.2);
    case 'hue': return 'hue=h=' + ((f.angle != null) ? f.angle : 90);
    case 'blur': return 'gblur=sigma=' + ((f.value != null) ? f.value : 3);
    case 'sharpen': return 'unsharp=5:5:' + ((f.value != null) ? f.value : 1.0);
    case 'grayscale': return 'hue=s=0';
    case 'negate': return 'negate';
    case 'rotate': return 'rotate=' + (((f.angle != null) ? f.angle : 90) * Math.PI / 180);
    case 'hflip': return 'hflip';
    case 'vflip': return 'vflip';
    default: throw new Error('未知滤镜类型: ' + t);
  }
}

export async function applyFilters(src, dst, filters, crf) {
  const vf = filters.map(filterToVf).join(',');
  const args = ['-y', '-i', src, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf || 20), '-pix_fmt', 'yuv420p', '-c:a', 'copy', dst];
  const res = await run(FFMPEG, args, { timeoutMs: 300000 });
  if (res.error || res.code !== 0) {
    throw new Error('filter failed: ' + (res.error || String(res.stderr || '').slice(-400)));
  }
}


