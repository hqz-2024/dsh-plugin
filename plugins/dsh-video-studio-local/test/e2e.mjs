// test/e2e.mjs — end-to-end smoke test for the FFmpeg wrapper (probe/cut/concat).
import { FFMPEG, probe, cut, concat, run } from '../lib/ffmpeg.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'dsh-vs-test-'));
try {
  const gen = (out, color) => run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ]);
  const c1 = join(tmp, 'c1.mp4');
  const c2 = join(tmp, 'c2.mp4');
  let r = await gen(c1, 'red');
  if (r.error || r.code !== 0) throw new Error('gen c1: ' + (r.error || String(r.stderr).slice(-300)));
  r = await gen(c2, 'blue');
  if (r.error || r.code !== 0) throw new Error('gen c2: ' + (r.error || String(r.stderr).slice(-300)));

  const m1 = await probe(c1);
  console.log('probe c1:', JSON.stringify(m1));

  const s1 = join(tmp, 's1.mp4');
  const s2 = join(tmp, 's2.mp4');
  await cut(c1, s1, { start: 0, dur: 2, width: 640, height: 480, fps: 30, crf: 20, hasAudio: m1.hasAudio });
  await cut(c2, s2, { start: 0, dur: 2, width: 640, height: 480, fps: 30, crf: 20, hasAudio: m1.hasAudio });

  const out = join(tmp, 'joined.mp4');
  await concat([s1, s2], out);

  const mOut = await probe(out);
  const st = await stat(out);
  console.log('probe joined:', JSON.stringify(mOut));
  console.log('joined bytes:', st.size);
  console.log('E2E OK');
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
