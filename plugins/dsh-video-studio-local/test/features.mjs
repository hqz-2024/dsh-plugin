// test/features.mjs — full feature smoke test for the FFmpeg wrapper.
import { FFMPEG, probe, cut, concat, concatTransitions, mixBgm, burnSubtitle, thumbnail, run } from '../lib/ffmpeg.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'dsh-vs-feat-'));
const ok = (name) => console.log('PASS ' + name);
const fail = (name, e) => { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; };

try {
  // fixtures: 4s clips with audio, a bgm, an srt
  const c1 = join(tmp, 'c1.mp4');
  const c2 = join(tmp, 'c2.mp4');
  const mkClip = (out, color) => run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':size=640x480:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ]);
  let r = await mkClip(c1, 'red'); if (r.error || r.code !== 0) throw new Error('c1: ' + (r.error || r.stderr));
  r = await mkClip(c2, 'blue'); if (r.error || r.code !== 0) throw new Error('c2: ' + (r.error || r.stderr));
  const bgm = join(tmp, 'bgm.mp3');
  r = await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=10', bgm]);
  if (r.error || r.code !== 0) throw new Error('bgm: ' + (r.error || r.stderr));
  const srt = join(tmp, 'sub.srt');
  await writeFile(srt, '1\n00:00:00,000 --> 00:00:03,000\n测试字幕\n', 'utf8');

  // 1. probe
  const m1 = await probe(c1);
  if (m1.duration < 3.9 && m1.duration > 4.1) throw new Error('probe duration');
  ok('probe');

  // 2. cut (normal, 2s)
  const s1 = join(tmp, 's1.mp4');
  await cut(c1, s1, { start: 0, dur: 2, width: 640, height: 480, fps: 30, hasAudio: m1.hasAudio });
  let p = await probe(s1);
  if (p.duration < 1.9 || p.duration > 2.1) throw new Error('cut duration=' + p.duration);
  ok('cut normal');

  // 3. speed 2x (2s output from 4s input), pitch preserved (atempo)
  const fast = join(tmp, 'fast.mp4');
  await cut(c1, fast, { start: 0, dur: 2, speed: 2, width: 640, height: 480, fps: 30, hasAudio: m1.hasAudio });
  p = await probe(fast);
  if (p.duration < 1.9 || p.duration > 2.1) throw new Error('speed duration=' + p.duration);
  if (!p.hasAudio) throw new Error('speed lost audio');
  ok('speed 2x');

  // 4. speed 0.5x (2s output, half speed)
  const slow = join(tmp, 'slow.mp4');
  await cut(c1, slow, { start: 0, dur: 2, speed: 0.5, width: 640, height: 480, fps: 30, hasAudio: m1.hasAudio });
  p = await probe(slow);
  if (p.duration < 1.9 || p.duration > 2.1) throw new Error('slow duration=' + p.duration);
  ok('speed 0.5x');

  // 5. resize (different resolution)
  const resized = join(tmp, 'resized.mp4');
  await cut(c1, resized, { start: 0, dur: 2, width: 320, height: 180, fps: 24, hasAudio: m1.hasAudio });
  p = await probe(resized);
  if (p.width !== 320 || p.height !== 180) throw new Error('resize ' + p.width + 'x' + p.height);
  ok('resize');

  // 6. mute (silent audio track, so it still concatenates cleanly)
  const muted = join(tmp, 'muted.mp4');
  await cut(c1, muted, { start: 0, dur: 2, width: 640, height: 480, fps: 30, mute: true, hasAudio: m1.hasAudio });
  p = await probe(muted);
  if (!p.hasVideo || !p.hasAudio) throw new Error('mute produced invalid clip');
  const vol = await run(FFMPEG, ['-i', muted, '-af', 'volumedetect', '-f', 'null', '-']);
  const mm = vol.stderr.match(/mean_volume: ([-0-9.]+) dB/);
  const db = mm ? Number(mm[1]) : 0;
  if (db > -80) throw new Error('mute not silent: ' + db + ' dB');
  ok('mute (silent, ' + db + ' dB)');

  // 7. concat (hard cut)
  const s2 = join(tmp, 's2.mp4');
  await cut(c2, s2, { start: 0, dur: 2, width: 640, height: 480, fps: 30, hasAudio: true });
  const joined = join(tmp, 'joined.mp4');
  await concat([s1, s2], joined);
  p = await probe(joined);
  if (p.duration < 3.9 || p.duration > 4.1) throw new Error('concat duration=' + p.duration);
  ok('concat');

  // 8. transitions (xfade 0.5s: 2+2-0.5 = 3.5s)
  const xf = join(tmp, 'xfade.mp4');
  await concatTransitions([s1, s2], xf, { transition: 'fade', duration: 0.5, crf: 20 });
  p = await probe(xf);
  if (p.duration < 3.3 || p.duration > 3.7) throw new Error('xfade duration=' + p.duration);
  ok('xfade transition');

  // 9. bgm mix (replace)
  const withBgm = join(tmp, 'withbgm.mp4');
  await mixBgm(joined, bgm, withBgm, { volume: 0.5, keepOriginal: false });
  p = await probe(withBgm);
  if (!p.hasAudio) throw new Error('bgm lost audio');
  if (p.duration < 3.9 || p.duration > 4.1) throw new Error('bgm duration=' + p.duration);
  ok('bgm mix');

  // 10. subtitle burn (srt, Chinese font)
  const subbed = join(tmp, 'subbed.mp4');
  await burnSubtitle(joined, srt, subbed, { font: 'Microsoft YaHei' });
  p = await probe(subbed);
  if (!p.hasVideo) throw new Error('subtitle lost video');
  ok('subtitle burn');

  // 11. thumbnail
  const thumb = join(tmp, 'thumb.jpg');
  await thumbnail(c1, thumb, 1.0);
  const st = await stat(thumb);
  if (st.size < 100) throw new Error('thumbnail too small');
  ok('thumbnail');

  console.log('ALL FEATURES OK');
} catch (e) {
  fail('(top)', e);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
