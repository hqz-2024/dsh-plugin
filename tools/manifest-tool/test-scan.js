// 独立验证 ffprobe 扫描 + 读 manifest（不依赖 electron）
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const FFPROBE = path.join(process.env.USERPROFILE, '.dsh', 'plugins', 'dsh-video-studio-local', 'bin', 'ffprobe.exe');

function ffprobeMeta(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          const v = (data.streams || []).find((s) => s.codec_type === 'video');
          if (!v) return resolve(null);
          const fpsRaw = v.avg_frame_rate || v.r_frame_rate || '0/0';
          const m = String(fpsRaw).split('/');
          const fps = (m.length === 2 && Number(m[1])) ? Number(m[0]) / Number(m[1]) : 0;
          resolve({ duration: Number(data.format && data.format.duration) || 0, width: Number(v.width) || 0, height: Number(v.height) || 0, fps: Math.round(fps * 100) / 100 });
        } catch { resolve(null); }
      });
  });
}

const VIDEO_EXTS = new Set(['mp4','mov','mkv','webm','avi','ts','m2ts','mts','flv','m4v','wmv','mpg','mpeg','3gp','ogv','vob','mxf']);

async function listVideos(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).filter((e) => VIDEO_EXTS.has(path.extname(e.name).toLowerCase().replace('.', ''))).map((e) => path.join(dir, e.name));
  const results = [];
  for (const f of files) {
    const meta = await ffprobeMeta(f);
    if (meta) results.push({ file: path.basename(f), ...meta });
  }
  return results;
}

(async () => {
  const dir = process.argv[2];
  const videos = await listVideos(dir);
  console.log('扫描到视频数:', videos.length);
  for (const v of videos) console.log('  ' + v.file + ' | ' + Math.round(v.duration) + 's | ' + v.width + 'x' + v.height + ' | ' + v.fps + 'fps');
  const mf = path.join(dir, 'manifest.json');
  if (fs.existsSync(mf)) {
    const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
    console.log('manifest clips 数:', (data.clips || []).length);
  } else {
    console.log('无 manifest.json');
  }
})();
