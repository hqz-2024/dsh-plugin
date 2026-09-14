// dsh-video-studio host half: bundled FFmpeg + model tools to select, trim and
// concatenate labeled clip material into product showcase videos.
//
// FFmpeg runs on THIS server (spawned directly), not through dsh-local-bridge,
// because both the uploaded clips and the bundled ffmpeg.exe live here. Outputs
// land in the session workspace, so everyone in the same workspace sees the
// finished videos (workspace-level isolation only, per deployment decision).
//
// Confinement mirrors the session sandbox policy: written outputs must stay
// inside the session workspace root unless the session holds danger-full-access.

import { mkdtemp, mkdir, rm, readFile, realpath, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { run, FFMPEG, probe, cut, concat, concatTransitions, mixBgm, burnSubtitle, thumbnail, convert, applyFilters } from './ffmpeg.js';

const { createRequire } = await import('module');
const require = createRequire(import.meta.url);

// dsh home: DSH_HOME env, else platform default (~/.dsh). Same semantics as
// @deepseek-ai/dsh-home-paths without taking that dependency.
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

let defineTool = null;
try {
  const profileRequire = createRequire(join(DSH_HOME, 'profiles', 'web', 'package.json'));
  const toolsEntry = profileRequire.resolve('@deepseek-ai/dsh-tools');
  const toolsModule = await import(pathToFileURL(toolsEntry).href);
  defineTool = typeof toolsModule.defineTool === 'function' ? toolsModule.defineTool : null;
} catch (e) { defineTool = null; }

export const name = 'dsh-video-studio';
export const inject = ['webServer'];

export function apply(ctx, config) {
  // 下载端点：serve manifest-tool.exe，供局域网用户下载桌面校对工具
  const webServer = ctx.webServer;
  if (webServer) {
    const exePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'manifest-tool.exe');
    const disposeServe = webServer.register({
      kind: 'exact',
      path: '/dsh-video-studio/manifest-tool',
      handler: (req, res) => {
        try {
          const buf = readFileSync(exePath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="manifest-tool.exe"',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
          });
          res.end(buf);
        } catch (e) {
          res.writeHead(404);
          res.end('manifest-tool.exe not found');
        }
      },
    });
    ctx.effect(() => () => { if (disposeServe) disposeServe(); }, 'dsh-video-studio: manifest-tool download');
  }

  const tools = ctx.get('tools');
  if (!tools || !defineTool) {
    if (ctx.logger) ctx.logger.warn('[video-studio] tools registry or defineTool unavailable; tools not registered');
    return;
  }

  const maxConcurrent = (config && Number(config.maxConcurrent) > 0) ? Number(config.maxConcurrent) : 2;
  const outputDirDefault = (config && typeof config.outputDir === 'string' && config.outputDir) ? config.outputDir : 'out';

  let sandboxPolicy = null;
  try { sandboxPolicy = ctx.get('sandboxPolicy'); } catch (e) { sandboxPolicy = null; }

  const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const realpathLenient = async (p) => { try { return await realpath(p); } catch (e) { return p; } };
  const tail = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(-n) : t; };
  const ABS_RE = /^[A-Za-z]:[\\/]/;

  const workspaceOf = async (exec) => {
    let mode = 'danger-full-access';
    let root = '';
    if (sandboxPolicy) {
      const session = exec && exec.agent ? exec.agent.session : undefined;
      try {
        const resolved = sandboxPolicy.resolve(session ? { session } : {});
        mode = resolved.mode || 'danger-full-access';
        root = resolved.workspaceRoot || '';
      } catch (e) { /* keep defaults */ }
    }
    return { mode, root: await realpathLenient(root) };
  };
  const resolvePath = (root, p) => {
    if (!p) return p;
    return isAbsolute(p) ? p : join(root, p);
  };
  const inRoot = (root, p) => {
    if (!root) return true;
    const rn = normPath(root);
    const pn = normPath(p);
    return pn === rn || pn.startsWith(rn + '/');
  };
  const assertWritable = (ws, p) => {
    if (ws.mode === 'danger-full-access') return null;
    return inRoot(ws.root, p) ? null : ('输出路径超出会话工作区范围：' + (ws.root || '(未配置)'));
  };

  // Concurrency limiter: FFmpeg re-encode is CPU-heavy; cap parallel renders.
  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < maxConcurrent) { active += 1; return Promise.resolve(); }
    return new Promise((res) => waiting.push(res));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const errText = (e) => (e && e.message) ? String(e.message) : String(e);

  // Normalize spec defaults.
  const specOf = (spec) => ({
    width: Number(spec && spec.width) || 1080,
    height: Number(spec && spec.height) || 1920,
    fps: Number(spec && spec.fps) || 30,
    crf: Number(spec && spec.crf) || 20,
    fill: (spec && spec.fill === 'crop') ? 'crop' : 'fit',
  });

  // Cut every selected clip to a normalized segment, then join (hard or xfade).
  const assemble = async (clips, spec, transition, outAbs, tmpDir) => {
    const parts = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const meta = await probe(c.file);
      const seg = join(tmpDir, 'seg-' + String(i).padStart(3, '0') + '.mp4');
      await cut(c.file, seg, {
        start: c.start || 0,
        dur: c.trim_to || 3,
        speed: c.speed || 1,
        width: spec.width, height: spec.height, fps: spec.fps, crf: spec.crf, fill: spec.fill,
        mute: !!c.mute,
        hasAudio: meta.hasAudio,
      });
      parts.push(seg);
    }
    if (transition && transition.type) {
      await concatTransitions(parts, outAbs, { transition: transition.type, duration: Number(transition.duration) || 0.5, crf: spec.crf });
    } else {
      await concat(parts, outAbs);
    }
    return outAbs;
  };

  const probeTool = defineTool({
    name: 'video_probe',
    description: 'Inspect a media file with ffprobe. Returns duration, resolution, frame rate, and whether it has audio. Use this to verify a clip or the finished video before/after assembly.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the media file. Relative paths resolve against the session workspace root; absolute paths are used as-is.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          duration: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
          fps: { type: 'number' }, hasVideo: { type: 'boolean' }, hasAudio: { type: 'boolean' },
          codec: { type: 'string' }, error: { type: 'string' }
        },
        additionalProperties: true
      },
      render: (_a, v) => [{ type: 'text', text: (v && v.error) ? ('探测失败：' + v.error) : ('时长 ' + v.duration + 's，' + v.width + 'x' + v.height + '@' + v.fps + 'fps，' + (v.hasAudio ? '有音轨' : '无音轨') + '，编码 ' + v.codec) }]
    },
    async execute(args, exec) {
      try {
        const ws = await workspaceOf(exec);
        return probe(resolvePath(ws.root, args.path));
      } catch (e) { return { error: errText(e) }; }
    },
    presentCall: (args) => ({ card: 'generic', title: '视频探测 ' + String(args.path || ''), kind: 'run', rawInput: String(args.path || '') })
  });

  const listTool = defineTool({
    name: 'video_list',
    description: 'Read a manifest.json of labeled clips and return them grouped by category with description and tags, so you can decide which clips to select. The manifest is { "clips": [ { "file", "category", "product", "title", "description", "tags", "duration" } ] }. This is optional: you may also work with clip files directly by path.',
    parameters: {
      dir: { type: 'string', description: 'Directory that contains manifest.json. Relative to the workspace root; defaults to the workspace root.' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          manifest: { type: 'string' }, total: { type: 'number' },
          categories: { type: 'object', additionalProperties: true },
          clips: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' }
        },
        additionalProperties: true
      },
      render: (_a, v) => {
        if (v && v.error) return [{ type: 'text', text: '读取清单失败：' + v.error }];
        const cats = v.categories ? Object.keys(v.categories).map((k) => k + '=' + v.categories[k].length).join('，') : '';
        return [{ type: 'text', text: '共 ' + v.total + ' 段素材（' + cats + '），来自 ' + v.manifest }];
      }
    },
    async execute(args, exec) {
      try {
        const ws = await workspaceOf(exec);
        const dir = resolvePath(ws.root, args.dir || '.');
        const mf = join(dir, 'manifest.json');
        const raw = await readFile(mf, 'utf8');
        const data = JSON.parse(raw);
        const clips = data.clips || [];
        const categories = {};
        for (const c of clips) {
          const k = c.category || 'other';
          (categories[k] = categories[k] || []).push(c);
        }
        return { manifest: mf, total: clips.length, categories, clips };
      } catch (e) { return { error: errText(e) }; }
    },
    presentCall: (args) => ({ card: 'generic', title: '读取素材清单', kind: 'run', rawInput: String(args.dir || '工作区根目录') })
  });

  const buildTool = defineTool({
    name: 'video_build',
    description: 'One-stop: select, trim, speed, resize, join (with optional xfade transitions), mix BGM, and burn subtitles, then write the finished video into the workspace. Pass recipe as a JSON string:\n' +
      '{\n  "manifest": "manifest.json",\n  "spec": { "width": 1080, "height": 1920, "fps": 30, "crf": 20, "fill": "fit" },\n  "clips": [ { "file": "clips/p001.mp4", "start": 0, "trim_to": 3.0, "speed": 1 } ],\n  "transition": { "type": "fade", "duration": 0.5 },\n  "bgm": "assets/bgm.mp3", "bgm_volume": 0.8, "bgm_keep_original": true,\n  "subtitle": "assets/sub.srt", "font": "Microsoft YaHei",\n  "output": "out/video.mp4"\n}\n' +
      'clips is the exact ordered selection (call video_list first, or pass file paths directly). Each entry: file (relative to workspace), start (seconds, default 0), trim_to (output seconds), speed (1=normal, 2=2x, 0.5=half; pitch preserved), mute (optional bool). ' +
      'Alternatively use steps: [ { "category": "product", "count": 1, "trim_to": 3.0 } ] to auto-pick the first N clips of each category (needs manifest). ' +
      'spec is optional (default 1080x1920@30). fill: fit=letterbox, crop=fill. transition/bgm/subtitle are optional. The finished video is written into the workspace.',
    parameters: {
      recipe: { type: 'string', required: true, description: 'JSON string describing the build (see the tool description for the exact schema).' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string' }, segments: { type: 'number' }, duration: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' },
          error: { type: 'string' }
        },
        additionalProperties: true
      },
      render: (_a, v) => {
        if (v && v.error) return [{ type: 'text', text: '出片失败：' + v.error }];
        return [{ type: 'text', text: '成片已生成：' + v.output + '（' + v.segments + ' 段，' + v.duration + 's，' + v.width + 'x' + v.height + '@' + v.fps + 'fps）' }];
      }
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          let recipe;
          try { recipe = JSON.parse(args.recipe); } catch (e) { return { error: 'recipe 不是合法 JSON：' + errText(e) }; }
          const spec = specOf(recipe.spec);

          let clips = [];
          if (Array.isArray(recipe.clips) && recipe.clips.length) {
            clips = recipe.clips.map((c) => ({ file: resolvePath(ws.root, c.file), start: Number(c.start) || 0, trim_to: Number(c.trim_to) || 3, speed: Number(c.speed) || 1, mute: !!c.mute }));
          } else {
            const manifestRel = recipe.manifest || 'manifest.json';
            const manifest = JSON.parse(await readFile(resolvePath(ws.root, manifestRel), 'utf8'));
            const allClips = manifest.clips || [];
            const steps = recipe.steps || [];
            const groups = {};
            for (const c of allClips) { const k = c.category || 'other'; (groups[k] = groups[k] || []).push(c); }
            for (const s of steps) {
              const cands = groups[s.category] || [];
              const n = Number(s.count) || 1;
              if (cands.length < n) return { error: '素材不足：类别 ' + s.category + ' 需要 ' + n + ' 段，仅 ' + cands.length + ' 段' };
              for (let i = 0; i < n; i++) {
                const c = cands[i];
                clips.push({ file: resolvePath(ws.root, c.file), start: 0, trim_to: Number(s.trim_to) || Number(c.duration) || 3, speed: Number(s.speed) || 1, mute: false });
              }
            }
          }
          if (!clips.length) return { error: '未选中任何片段' };

          const outRel = recipe.output || (outputDirDefault + '/video-' + Date.now() + '.mp4');
          const outAbs = resolvePath(ws.root, outRel);
          const confine = assertWritable(ws, outAbs);
          if (confine) return { error: confine };

          const tmp = await mkdtemp(join(tmpdir(), 'dsh-vs-'));
          try {
            let cur = join(tmp, 'joined.mp4');
            await assemble(clips, spec, recipe.transition, cur, tmp);

            if (recipe.bgm) {
              const bgmOut = join(tmp, 'bgm.mp4');
              await mixBgm(cur, resolvePath(ws.root, recipe.bgm), bgmOut, { volume: Number(recipe.bgm_volume) || 0.8, keepOriginal: recipe.bgm_keep_original !== false });
              cur = bgmOut;
            }
            if (recipe.subtitle) {
              const subOut = join(tmp, 'sub.mp4');
              await burnSubtitle(cur, resolvePath(ws.root, recipe.subtitle), subOut, { font: recipe.font || 'Microsoft YaHei', crf: spec.crf });
              cur = subOut;
            }

            await mkdir(dirname(outAbs), { recursive: true });
            await copyFile(cur, outAbs);
            const finalMeta = await probe(outAbs);
            return { output: outAbs, segments: clips.length, duration: Math.round(finalMeta.duration * 100) / 100, width: finalMeta.width, height: finalMeta.height, fps: finalMeta.fps };
          } finally {
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
          }
        } catch (e) {
          return { error: errText(e) };
        }
      } finally {
        release();
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '批量出片', kind: 'run', rawInput: 'video_build' })
  });

  const cutTool = defineTool({
    name: 'video_cut',
    description: 'Trim, speed-change (pitch preserved), resize, and/or mute a single clip into a normalized segment. Speed 2 = 2x (half length), 0.5 = half speed; fill fit=letterbox, crop=fill. Output is written into the workspace.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input media path (relative to workspace, or absolute).' },
      output: { type: 'string', required: true, description: 'Output path (relative to workspace).' },
      start: { type: 'number', description: 'Start time in seconds (default 0).' },
      trim_to: { type: 'number', description: 'Output length in seconds (default 3).' },
      speed: { type: 'number', description: 'Playback speed (default 1; pitch preserved).' },
      width: { type: 'number', description: 'Target width (default 1080).' },
      height: { type: 'number', description: 'Target height (default 1920).' },
      fps: { type: 'number', description: 'Target fps (default 30).' },
      crf: { type: 'number', description: 'H.264 quality (default 20).' },
      fill: { type: 'string', enum: ['fit', 'crop'], description: 'fit=letterbox (default), crop=fill.' },
      mute: { type: 'boolean', description: 'Silence the audio track (default false).' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('剪切失败：' + v.error) : ('片段已生成：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const src = resolvePath(ws.root, args.input);
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          const meta = await probe(src);
          const spec = specOf({ width: args.width, height: args.height, fps: args.fps, crf: args.crf, fill: args.fill });
          await mkdir(dirname(out), { recursive: true });
          await cut(src, out, { start: args.start || 0, dur: args.trim_to || 3, speed: args.speed || 1, width: spec.width, height: spec.height, fps: spec.fps, crf: spec.crf, fill: spec.fill, mute: !!args.mute, hasAudio: meta.hasAudio });
          return { output: out };
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '剪切/变速片段', kind: 'run', rawInput: String(args.input || '') })
  });

  const concatTool = defineTool({
    name: 'video_concat',
    description: 'Normalize and join a list of clips (hard cut, or xfade transitions). All clips are resized to the same resolution/fps and re-encoded, then joined in order.',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered list of input clip paths (relative to workspace).' },
      output: { type: 'string', required: true, description: 'Output path (relative to workspace).' },
      transition: { type: 'string', description: 'xfade transition name (e.g. fade, wipeleft, slideleft); omit for hard cut.' },
      transition_duration: { type: 'number', description: 'Transition duration in seconds (default 0.5).' },
      width: { type: 'number', description: 'Target width (default 1080).' },
      height: { type: 'number', description: 'Target height (default 1920).' },
      fps: { type: 'number', description: 'Target fps (default 30).' },
      crf: { type: 'number', description: 'H.264 quality (default 20).' },
      fill: { type: 'string', enum: ['fit', 'crop'], description: 'fit=letterbox (default), crop=fill.' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('拼接失败：' + v.error) : ('拼接完成：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const files = (args.files || []).map((f) => resolvePath(ws.root, f));
          if (files.length < 2) return { error: '至少需要 2 个片段' };
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          const spec = specOf({ width: args.width, height: args.height, fps: args.fps, crf: args.crf, fill: args.fill });
          const tmp = await mkdtemp(join(tmpdir(), 'dsh-vs-'));
          try {
            const clips = files.map((f) => ({ file: f, start: 0, trim_to: 0, speed: 1, mute: false }));
            // trim_to 0 => cut defaults to 3; instead probe durations to keep full length
            const parts = [];
            for (let i = 0; i < files.length; i++) {
              const meta = await probe(files[i]);
              const seg = join(tmp, 'seg-' + String(i).padStart(3, '0') + '.mp4');
              await cut(files[i], seg, { start: 0, dur: meta.duration || 3, width: spec.width, height: spec.height, fps: spec.fps, crf: spec.crf, fill: spec.fill, hasAudio: meta.hasAudio });
              parts.push(seg);
            }
            await mkdir(dirname(out), { recursive: true });
            if (args.transition) {
              await concatTransitions(parts, out, { transition: args.transition, duration: Number(args.transition_duration) || 0.5, crf: spec.crf });
            } else {
              await concat(parts, out);
            }
            return { output: out };
          } finally {
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
          }
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '拼接片段', kind: 'run', rawInput: 'video_concat' })
  });

  const audioTool = defineTool({
    name: 'video_audio',
    description: 'Mix a background music track over a video (keep the original audio and duck it under, or replace it entirely), then write the result into the workspace.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input video path (relative to workspace).' },
      bgm: { type: 'string', required: true, description: 'Background music path (relative to workspace).' },
      output: { type: 'string', required: true, description: 'Output path (relative to workspace).' },
      bgm_volume: { type: 'number', description: 'BGM volume multiplier (default 0.8).' },
      keep_original: { type: 'boolean', description: 'Keep original audio under the BGM (default true).' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('配乐失败：' + v.error) : ('配乐完成：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const src = resolvePath(ws.root, args.input);
          const bgm = resolvePath(ws.root, args.bgm);
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          await mkdir(dirname(out), { recursive: true });
          await mixBgm(src, bgm, out, { volume: Number(args.bgm_volume) || 0.8, keepOriginal: args.keep_original !== false });
          return { output: out };
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '配乐', kind: 'run', rawInput: String(args.input || '') })
  });

  const subTool = defineTool({
    name: 'video_subtitle',
    description: 'Burn an SRT or ASS subtitle file onto a video (hard subtitles). For SRT, specify a Chinese-capable font (default Microsoft YaHei). Output is written into the workspace.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input video path (relative to workspace).' },
      subtitle: { type: 'string', required: true, description: 'Subtitle file path, .srt or .ass (relative to workspace).' },
      output: { type: 'string', required: true, description: 'Output path (relative to workspace).' },
      font: { type: 'string', description: 'Font name for SRT (default Microsoft YaHei).' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('字幕失败：' + v.error) : ('字幕已烧录：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const src = resolvePath(ws.root, args.input);
          const sub = resolvePath(ws.root, args.subtitle);
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          await mkdir(dirname(out), { recursive: true });
          await burnSubtitle(src, sub, out, { font: args.font || 'Microsoft YaHei' });
          return { output: out };
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '烧录字幕', kind: 'run', rawInput: String(args.input || '') })
  });

  const thumbTool = defineTool({
    name: 'video_thumbnail',
    description: 'Extract a single frame from a video as a JPEG thumbnail (for previews or verification). Writes <path>.thumb.jpg next to the source.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the media file (relative to workspace root, or absolute).' },
      at: { type: 'number', description: 'Time in seconds to grab the frame (default 0.5).' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('缩略图失败：' + v.error) : ('缩略图已生成：' + v.output) }]
    },
    async execute(args, exec) {
      try {
        const ws = await workspaceOf(exec);
        const p = resolvePath(ws.root, args.path);
        const out = p + '.thumb.jpg';
        await thumbnail(p, out, args.at);
        return { output: out };
      } catch (e) { return { error: errText(e) }; }
    },
    presentCall: (args) => ({ card: 'generic', title: '视频抽帧', kind: 'run', rawInput: String(args.path || '') })
  });

  const convertTool = defineTool({
    name: 'video_convert',
    description: 'Convert a media file to another format: transcode between video containers (mp4/mov/mkv/webm/avi/ts/flv), extract audio (mp3/wav/aac/m4a/flac/ogg), convert video to GIF, or extract a single frame as an image (jpg/png/webp). The output file extension selects the target format and codec. Output is written into the workspace.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input media path (relative to workspace, or absolute).' },
      output: { type: 'string', required: true, description: 'Output path; the extension selects the format, e.g. out.mov, out.mp3, out.gif, out.jpg.' },
      crf: { type: 'number', description: 'Video quality for mp4/mov/mkv (default 20, lower = better).' },
      fps: { type: 'number', description: 'Frame rate for GIF (default 10).' },
      scale: { type: 'string', description: 'Width for GIF, e.g. "480:-1" (default 480 wide).' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('转换失败：' + v.error) : ('转换完成：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const src = resolvePath(ws.root, args.input);
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          await mkdir(dirname(out), { recursive: true });
          await convert(src, out, { crf: args.crf, fps: args.fps, scale: args.scale });
          return { output: out };
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '格式转换', kind: 'run', rawInput: String(args.input || '') })
  });

  const filterTool = defineTool({
    name: 'video_filter',
    description: 'Apply common visual filters to a video (video re-encoded, audio copied). Pass filters as an array, applied in order; each is { "type", "value", "angle" }. Supported types: brightness (value -1..1), contrast (value, 1=normal), saturation (value, 1=normal), hue (angle degrees), blur (value = gaussian sigma), sharpen (value = amount), grayscale, negate, rotate (angle degrees), hflip (horizontal flip), vflip (vertical flip). Output is written into the workspace.',
    parameters: {
      input: { type: 'string', required: true, description: 'Input video path (relative to workspace).' },
      output: { type: 'string', required: true, description: 'Output path (relative to workspace).' },
      filters: { type: 'array', required: true, items: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'number' }, angle: { type: 'number' } }, additionalProperties: true }, description: 'Array of filter objects, applied in order.' }
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v && v.error ? ('滤镜失败：' + v.error) : ('滤镜已应用：' + v.output) }]
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const src = resolvePath(ws.root, args.input);
          const out = resolvePath(ws.root, args.output);
          const confine = assertWritable(ws, out);
          if (confine) return { error: confine };
          await mkdir(dirname(out), { recursive: true });
          await applyFilters(src, out, args.filters || [], 20);
          return { output: out };
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: '应用滤镜', kind: 'run', rawInput: String(args.input || '') })
  });

  const rawTool = defineTool({
    name: 'ffmpeg_run',
    description: 'Run the bundled FFmpeg directly with arbitrary arguments (full-featured escape hatch for anything the semantic tools do not cover). Pass args as an array exactly as you would on the command line, but WITHOUT the ffmpeg binary name, e.g. ["-i", "in.mp4", "-vf", "setpts=0.5*PTS", "out.mp4"]. Relative paths resolve against the workspace; the process runs with the workspace as its working directory. In workspace-write sessions, absolute paths are rejected. Returns exit code plus the tail of stdout/stderr so you can correct the command on failure.',
    parameters: {
      args: { type: 'array', items: { type: 'string' }, required: true, description: 'FFmpeg arguments (array of strings), excluding the binary name.' }
    },
    output: {
      schema: { type: 'object', properties: { exitCode: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => {
        if (!v) return [{ type: 'text', text: '无输出' }];
        if (v.error) return [{ type: 'text', text: 'ffmpeg 执行失败：' + v.error }];
        const parts = [];
        if (typeof v.exitCode === 'number' && v.exitCode !== 0) parts.push('exitCode: ' + v.exitCode);
        if (v.stderr) parts.push('stderr(尾):\n' + v.stderr);
        if (v.stdout) parts.push('stdout(尾):\n' + v.stdout);
        return [{ type: 'text', text: parts.join('\n') || '完成（exit 0）' }];
      }
    },
    async execute(args, exec) {
      await acquire();
      try {
        try {
          const ws = await workspaceOf(exec);
          const argArr = Array.isArray(args.args) ? args.args.map(String) : [];
          if (!argArr.length) return { error: 'args 不能为空' };
          if (ws.mode !== 'danger-full-access') {
            for (const a of argArr) {
              if (ABS_RE.test(a) || String(a).startsWith('\\\\') || String(a).startsWith('/')) {
                return { error: 'workspace-write 会话禁止绝对路径参数，请改用相对工作区的相对路径' };
              }
            }
          }
          const res = await run(FFMPEG, argArr, { timeoutMs: 900000, cwd: ws.root || undefined });
          const out = {};
          if (typeof res.code === 'number') out.exitCode = res.code;
          const so = tail(res.stdout, 2000); if (so) out.stdout = so;
          const se = tail(res.stderr, 3000); if (se) out.stderr = se;
          if (res.error) out.error = res.error;
          return out;
        } catch (e) { return { error: errText(e) }; }
      } finally { release(); }
    },
    presentCall: (args) => ({ card: 'generic', title: 'FFmpeg 直跑', kind: 'run', rawInput: (args.args || []).join(' ') })
  });

  ctx.effect(() => {
    const disposers = [probeTool, listTool, buildTool, cutTool, concatTool, audioTool, subTool, thumbTool, convertTool, filterTool, rawTool].map((t) => tools.register(t));
    return () => { for (const d of disposers) { if (d) d(); } };
  }, 'dsh-video-studio: tools');
}
