// dsh-manifest-tool 渲染进程
const $ = (id) => document.getElementById(id);

// ---- i18n ----
const I18N = {
  zh: {
    'select-dir': '选择目录', 'lang': '语言', 'video-list': '视频列表',
    'preview': '视频预览', 'manifest': 'manifest 信息',
    'no-dir': '未选择目录', 'no-videos': '目录下未找到视频',
    'preview-empty': '点击左侧视频进行预览', 'form-empty': '点击左侧视频查看 / 编辑标注',
    'play': '播放', 'pause': '暂停', 'save': '直接保存', 'save-new': '新建并保存', 'save-as': '另存为',
    'add-field': '+ 新增字段', 'saved': '已保存', 'saved-as': '已另存为：',
    'prompt-field': '请输入新字段名（英文）',
    'prev-frame': '-1帧', 'next-frame': '+1帧',
    'frame': '帧', 'ok': '确定', 'cancel': '取消',
  },
  en: {
    'select-dir': 'Select Directory', 'lang': 'Language', 'video-list': 'Video List',
    'preview': 'Preview', 'manifest': 'Manifest Info',
    'no-dir': 'No directory selected', 'no-videos': 'No videos found',
    'preview-empty': 'Click a video to preview', 'form-empty': 'Click a video to edit annotations',
    'play': 'Play', 'pause': 'Pause', 'save': 'Save', 'save-new': 'Save New', 'save-as': 'Save As',
    'add-field': '+ Add Field', 'saved': 'Saved', 'saved-as': 'Saved as: ',
    'prompt-field': 'Enter new field name',
    'prev-frame': '-1f', 'next-frame': '+1f',
    'frame': 'Frame', 'ok': 'OK', 'cancel': 'Cancel',
  },
};
let lang = 'zh';
function t(key) { return (I18N[lang] && I18N[lang][key]) || key; }
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.title = (lang === 'zh' ? 'manifest 校对工具' : 'manifest Tool');
  if (state.currentVideo) updateProgress();
}

const state = {
  dir: null,
  videos: [],
  manifest: { exists: false, clips: [] },
  currentFile: null,
  currentVideo: null,
  currentClipIndex: -1,
};

const DEFAULT_KEYS = ['file', 'category', 'product', 'title', 'description', 'tags', 'duration', 'resolution'];

function formatTime(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

// ---- 视频列表 ----
function renderVideoList() {
  const ul = $('video-list');
  ul.innerHTML = '';
  if (!state.videos.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('no-videos');
    ul.appendChild(li);
    return;
  }
  for (const v of state.videos) {
    const li = document.createElement('li');
    li.dataset.file = v.file;
    const name = document.createElement('div');
    name.className = 'v-name';
    name.textContent = v.file;
    const meta = document.createElement('div');
    meta.className = 'v-meta';
    meta.textContent = formatTime(v.duration) + ' · ' + v.width + 'x' + v.height + ' · ' + v.fps + 'fps';
    li.appendChild(name);
    li.appendChild(meta);
    li.addEventListener('click', () => onSelectVideo(v.file));
    ul.appendChild(li);
  }
}

async function onSelectDir() {
  const dir = await window.api.selectDir();
  if (!dir) return;
  state.dir = dir;
  $('current-dir').textContent = dir;
  const vr = await window.api.listVideos(dir);
  state.videos = (vr && vr.videos) || [];
  const mr = await window.api.readManifest(dir);
  state.manifest = mr || { exists: false, clips: [] };
  state.currentFile = null;
  state.currentVideo = null;
  state.currentClipIndex = -1;
  renderVideoList();
  renderForm(null);
  loadPreview(null);
}

function onSelectVideo(file) {
  state.currentFile = file;
  document.querySelectorAll('#video-list li').forEach((li) => {
    li.classList.toggle('active', li.dataset.file === file);
  });
  const v = state.videos.find((x) => x.file === file) || null;
  state.currentVideo = v;
  const idx = state.manifest.clips.findIndex((c) => c.file === file);
  state.currentClipIndex = idx;
  loadPreview(v);
  renderForm(idx >= 0 ? state.manifest.clips[idx] : null);
}

// ---- 预览 ----
const video = $('video');

function loadPreview(v) {
  if (!v) {
    video.classList.add('hidden');
    video.removeAttribute('src');
    video.load();
    $('preview-empty').style.display = '';
    $('preview-info').textContent = '';
    return;
  }
  $('preview-empty').style.display = 'none';
  video.classList.remove('hidden');
  video.src = v.fileUrl;
  video.load();
}

// ---- 帧级进度条 ----
const progressBar = $('progress-bar');
const progressFill = $('progress-fill');

function currentFrame() {
  const v = state.currentVideo;
  if (!v || !v.fps) return 0;
  return Math.round(video.currentTime * v.fps);
}
function totalFrames() {
  const v = state.currentVideo;
  if (!v || !v.fps || !v.duration) return 0;
  return Math.round(v.duration * v.fps);
}
function seekToFrame(frame) {
  const v = state.currentVideo;
  if (!v || !v.fps) return;
  video.currentTime = Math.max(0, Math.min(v.duration, frame / v.fps));
}
function updateProgress() {
  const v = state.currentVideo;
  if (!v) return;
  const frame = currentFrame();
  const total = totalFrames();
  progressFill.style.width = (total ? (frame / total) * 100 : 0) + '%';
  $('preview-info').textContent =
    t('frame') + ' ' + frame + ' / ' + total + ' · ' + formatTime(video.currentTime) + ' / ' + formatTime(v.duration);
}
video.addEventListener('loadedmetadata', updateProgress);
video.addEventListener('timeupdate', updateProgress);

let seeking = false;
function progressSeek(e) {
  const rect = progressBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekToFrame(Math.round(ratio * totalFrames()));
}
progressBar.addEventListener('mousedown', (e) => { seeking = true; progressSeek(e); document.body.style.userSelect = 'none'; });
document.addEventListener('mousemove', (e) => { if (seeking) progressSeek(e); });
document.addEventListener('mouseup', () => { seeking = false; document.body.style.userSelect = ''; });

// ---- 播放 / 快进 / 加速 ----
function togglePlay() { if (video.paused) video.play(); else video.pause(); }
video.addEventListener('play', () => { $('btn-play-pause').textContent = t('pause'); });
video.addEventListener('pause', () => { $('btn-play-pause').textContent = t('play'); });
function stepFrames(n) { seekToFrame(currentFrame() + n); }
function stepSeconds(n) { video.currentTime = Math.max(0, video.currentTime + n); }
$('btn-play-pause').addEventListener('click', togglePlay);
$('btn-prev-frame').addEventListener('click', () => stepFrames(-1));
$('btn-next-frame').addEventListener('click', () => stepFrames(1));
$('btn-step-back1').addEventListener('click', () => stepSeconds(-1));
$('btn-step-fwd1').addEventListener('click', () => stepSeconds(1));
$('btn-step-back10').addEventListener('click', () => stepSeconds(-10));
$('btn-step-fwd10').addEventListener('click', () => stepSeconds(10));
$('speed-select').addEventListener('change', (e) => { video.playbackRate = Number(e.target.value); });

document.addEventListener('keydown', (e) => {
  if (!state.currentVideo) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrames(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(1); }
});

// ---- manifest 表单 ----
function fieldToText(key, value) {
  if (key === 'tags' && Array.isArray(value)) return value.join(', ');
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function addFieldRow(form, key, value) {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.dataset.key = key;
  const label = document.createElement('label');
  label.textContent = key;
  label.title = key;
  let input;
  if (key === 'description') { input = document.createElement('textarea'); input.rows = 4; }
  else { input = document.createElement('input'); input.type = 'text'; }
  input.value = fieldToText(key, value);
  row.appendChild(label);
  row.appendChild(input);
  const actionRow = form.querySelector('.add-field-row');
  if (actionRow) form.insertBefore(row, actionRow);
  else form.appendChild(row);
  return row;
}

function addActionRow(form) {
  const row = document.createElement('div');
  row.className = 'field-row add-field-row';
  const btnAdd = document.createElement('button');
  btnAdd.type = 'button';
  btnAdd.className = 'btn-add-field';
  btnAdd.textContent = t('add-field');
  btnAdd.addEventListener('click', () => {
    row.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('prompt-field');
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn';
    okBtn.textContent = t('ok');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = t('cancel');
    row.appendChild(input);
    row.appendChild(okBtn);
    row.appendChild(cancelBtn);
    input.focus();
    const commit = () => {
      const name = input.value.trim();
      if (name) addFieldRow(form, name, '');
      row.innerHTML = '';
      row.appendChild(btnAdd);
    };
    const cancel = () => { row.innerHTML = ''; row.appendChild(btnAdd); };
    okBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') cancel();
    });
  });
  row.appendChild(btnAdd);
  form.appendChild(row);
  return row;
}

function addSaveActions(form, isNew) {
  const row = document.createElement('div');
  row.className = 'form-actions';
  const btnSave = document.createElement('button');
  btnSave.className = 'btn primary';
  btnSave.textContent = isNew ? t('save-new') : t('save');
  btnSave.addEventListener('click', () => save(false));
  const btnSaveAs = document.createElement('button');
  btnSaveAs.className = 'btn';
  btnSaveAs.textContent = t('save-as');
  btnSaveAs.addEventListener('click', () => save(true));
  row.appendChild(btnSave);
  row.appendChild(btnSaveAs);
  form.appendChild(row);
}

function renderForm(clip) {
  const form = $('manifest-form');
  form.innerHTML = '';
  if (!state.currentVideo) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('form-empty');
    form.appendChild(empty);
    return;
  }
  const isNew = !clip;
  const v = state.currentVideo;
  if (clip) {
    const keys = Object.keys(clip).length ? Object.keys(clip) : DEFAULT_KEYS;
    for (const k of keys) addFieldRow(form, k, clip[k]);
  } else {
    addFieldRow(form, 'file', v.file);
    addFieldRow(form, 'category', '');
    addFieldRow(form, 'product', '');
    addFieldRow(form, 'title', '');
    addFieldRow(form, 'description', '');
    addFieldRow(form, 'tags', '');
    addFieldRow(form, 'duration', Math.round(v.duration * 100) / 100);
    addFieldRow(form, 'resolution', (v.width && v.height) ? (v.width + 'x' + v.height) : '');
  }
  addActionRow(form);
  addSaveActions(form, isNew);
}

function collectFields() {
  const fields = {};
  document.querySelectorAll('#manifest-form .field-row').forEach((row) => {
    const key = row.dataset.key;
    const input = row.querySelector('input, textarea');
    if (!key || !input) return;
    const raw = input.value.trim();
    if (key === 'tags') {
      fields[key] = raw ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
    } else if (key === 'duration') {
      if (raw !== '') fields[key] = Number(raw);
    } else {
      fields[key] = raw;
    }
  });
  return fields;
}

async function save(asNewFile) {
  if (!state.dir) return;
  const fields = collectFields();
  const clips = state.manifest.clips.slice();
  if (state.currentClipIndex >= 0) clips[state.currentClipIndex] = fields;
  else clips.push(fields);
  const data = { clips };
  const res = asNewFile
    ? await window.api.saveAsManifest(data)
    : await window.api.saveManifest(state.dir, data);
  if (res && res.ok) {
    state.manifest = { exists: true, clips };
    if (!asNewFile) {
      state.currentClipIndex = clips.findIndex((c) => c.file === fields.file);
    }
    renderForm(clips[state.currentClipIndex] || null);
    alert(asNewFile ? (t('saved-as') + res.path) : t('saved'));
  }
}

// ---- 顶部 ----
$('btn-select-dir').addEventListener('click', onSelectDir);
$('lang-switch').addEventListener('change', (e) => {
  lang = e.target.value;
  applyI18n();
  renderVideoList();
  renderForm(state.currentClipIndex >= 0 ? state.manifest.clips[state.currentClipIndex] : null);
});

// ---- 左右栏拖拽 ----
const app = $('app');
const divider = $('divider');
const leftPanel = $('left-panel');
let dragging = false;
divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragging = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = app.getBoundingClientRect();
  const w = Math.max(0, Math.min(rect.width * 0.5, e.clientX - rect.left));
  leftPanel.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// 初始渲染
applyI18n();
