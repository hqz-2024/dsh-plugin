// test/convert-filter.mjs — convert + filter smoke test.
import { FFMPEG, probe, convert, applyFilters, run } from '../lib/ffmpeg.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'dsh-vs-cf-'));
const ok = (n) => console.log('PASS ' + n);
try {
  const c1 = join(tmp, 'c1.mp4');
  let r = await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=red:size=640x480:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', c1]);
  if (r.error || r.code !== 0) throw new Error('gen: ' + (r.error || String(r.stderr).slice(-300)));

  const mp3 = join(tmp, 'out.mp3');
  await convert(c1, mp3, {});
  let st = await stat(mp3);
  if (st.size < 1000) throw new Error('mp3 too small');
  ok('mp4 -> mp3');

  const gif = join(tmp, 'out.gif');
  await convert(c1, gif, { fps: 10, scale: '320:-1' });
  st = await stat(gif);
  if (st.size < 1000) throw new Error('gif too small');
  ok('mp4 -> gif');

  const mov = join(tmp, 'out.mov');
  await convert(c1, mov, {});
  const pm = await probe(mov);
  if (!pm.hasVideo) throw new Error('mov no video');
  ok('mp4 -> mov');

  const f1 = join(tmp, 'f_bright.mp4');
  await applyFilters(c1, f1, [{ type: 'brightness', value: 0.2 }], 20);
  const p1 = await probe(f1);
  if (!p1.hasVideo) throw new Error('brightness no video');
  ok('brightness');

  const f2 = join(tmp, 'f_chain.mp4');
  await applyFilters(c1, f2, [{ type: 'grayscale' }, { type: 'rotate', angle: 90 }, { type: 'hflip' }], 20);
  const p2 = await probe(f2);
  if (!p2.hasVideo) throw new Error('chain no video');
  ok('chain grayscale+rotate+hflip');

  console.log('ALL CONVERT/FILTER OK');
} catch (e) {
  console.log('FAIL: ' + e.message);
  process.exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
