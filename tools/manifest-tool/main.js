// dsh-manifest-tool 主进程
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// ffprobe 路径：开发模式复用 dsh-video-studio 插件二进制；打包后走 resources（P4）
function resolveFfprobe() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe');
  }
  return path.join(process.env.USERPROFILE, '.dsh', 'plugins', 'dsh-video-studio-local', 'bin', 'ffprobe.exe');
}
const FFPROBE = resolveFfprobe();

// ffprobe 探测单个文件：有 video 流返回元数据，否则 null
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
          resolve({
            duration: Number(data.format && data.format.duration) || 0,
            width: Number(v.width) || 0,
            height: Number(v.height) || 0,
            fps: Math.round(fps * 100) / 100,
          });
        } catch { resolve(null); }
      });
  });
}

// 遍历目录，列出所有含 video 流的文件（ffmpeg 支持的全格式）
// ffmpeg 支持的常见视频容器扩展名（排除图片/字幕/其他，避免 jpg 被误判为单帧视频）
const VIDEO_EXTS = new Set(['mp4','mov','mkv','webm','avi','ts','m2ts','mts','flv','m4v','wmv','mpg','mpeg','3gp','ogv','vob','mxf']);

async function listVideos(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { error: String(e.message) }; }
  const files = entries
    .filter((e) => e.isFile())
    .filter((e) => VIDEO_EXTS.has(path.extname(e.name).toLowerCase().replace('.', '')))
    .map((e) => path.join(dir, e.name));
  const results = [];
  for (const f of files) {
    const meta = await ffprobeMeta(f);
    if (meta) results.push({ file: path.basename(f), fileUrl: pathToFileURL(f).href, ...meta });
  }
  return { videos: results };
}

// 读 manifest.json，返回 clips 数组
function readManifest(dir) {
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) return { exists: false, clips: [] };
  try {
    const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
    return { exists: true, clips: data.clips || [] };
  } catch (e) {
    return { exists: true, clips: [], error: String(e.message) };
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 650,
    title: 'manifest 校对工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('select-dir', async () => {
    const r = await dialog.showOpenDialog({ title: '选择视频目录', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('list-videos', async (_e, dir) => listVideos(dir));
  ipcMain.handle('read-manifest', async (_e, dir) => readManifest(dir));
  ipcMain.handle('save-manifest', async (_e, dir, data) => {
    const mf = path.join(dir, 'manifest.json');
    fs.writeFileSync(mf, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, path: mf };
  });
  ipcMain.handle('save-as-manifest', async (_e, data) => {
    const r = await dialog.showSaveDialog({
      title: '另存为 manifest',
      defaultPath: 'manifest.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, path: r.filePath };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
