/**
 * dsh-local-bridge sidecar — runs on each user's Windows machine.
 *
 * It dials OUT to the DSH server's /sidecar WebSocket endpoint and executes
 * `run` commands locally (PowerShell, Office, arbitrary scripts), staging any
 * input files and collecting output files. It never listens on a port.
 *
 * Usage:
 *   node sidecar.mjs --server ws://<server>:3080/sidecar --token <token>
 *
 * The token identifies this machine as a specific DSH account (case-sensitive);
 * generate it on the server and keep it private to that user.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';

const MAX_OUT = 1024 * 1024;          // stdout/stderr cap per run (1MB)
const MAX_FILE = 50 * 1024 * 1024;    // per transferred file cap (50MB)

function parseArgs(argv) {
  const out = { server: '', token: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i];
    else if (argv[i] === '--token' && argv[i + 1]) out.token = argv[++i];
  }
  return out;
}

function globToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i += 1; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function collectFiles(workdir, patterns) {
  const files = [];
  const seen = new Set();
  let all = [];
  try { all = readdirSync(workdir, { recursive: true, withFileTypes: true }); } catch { return files; }
  for (const entry of all) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const rel = relative(workdir, full).replace(/\\/g, '/');
    if (!patterns.some((p) => globToRegExp(p).test(rel))) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    try {
      const size = statSync(full).size;
      if (size > MAX_FILE) continue;
      files.push({ path: rel, base64: readFileSync(full).toString('base64') });
    } catch { /* skip unreadable */ }
  }
  return files;
}

function runOnce(request) {
  return new Promise((resolvePromise) => {
    const id = request.id;
    const timeoutMs = request.timeoutMs || 120000;
    let workdir;
    try {
      workdir = request.workdir && request.workdir.trim()
        ? resolve(request.workdir)
        : mkdtempSync(join(tmpdir(), 'dsh-local-'));
    } catch (err) {
      resolvePromise({ type: 'run-result', id, ok: false, error: '无法创建工作目录：' + String(err && err.message || err) });
      return;
    }
    // Stage input files.
    for (const f of (request.files || [])) {
      try {
        if (!f || typeof f.path !== 'string' || typeof f.base64 !== 'string') continue;
        const target = resolve(workdir, f.path);
        if (target !== workdir && !target.startsWith(workdir + sep)) continue; // no traversal
        const bytes = Buffer.from(f.base64, 'base64');
        if (bytes.length > MAX_FILE) continue;
        writeFileSync(target, bytes);
      } catch { /* skip */ }
    }
    let exe = request.exe;
    let args = Array.isArray(request.args) ? request.args.map(String) : [];
    if (exe === 'pwsh' || exe === 'powershell' || exe === 'powershell.exe') {
      exe = 'powershell.exe';
      const script = args.length ? args[0] : '';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    }
    let child;
    try {
      child = spawn(exe, args, { cwd: workdir, windowsHide: true, shell: false });
    } catch (err) {
      resolvePromise({ type: 'run-result', id, ok: false, error: '无法启动程序：' + String(err && err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf, cur) => {
      const s = cur + buf.toString('utf8');
      return s.length > MAX_OUT ? s.slice(0, MAX_OUT) : s;
    };
    if (child.stdout) child.stdout.on('data', (d) => { stdout = cap(d, stdout); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr = cap(d, stderr); });
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ type: 'run-result', id, ok: false, error: '启动失败：' + String(err && err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outFiles = collectFiles(workdir, request.collect || []);
      // Keep the temp dir unless it was an explicit workdir.
      if (!(request.workdir && request.workdir.trim())) { try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ } }
      resolvePromise({
        type: 'run-result', id, ok: !timedOut,
        stdout, stderr, exitCode: code === null ? null : code,
        files: outFiles,
        error: timedOut ? '命令超时被终止（' + timeoutMs + 'ms）' : undefined
      });
    });
  });
}

function connect(server, token) {
  const ws = new WebSocket(server + (server.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token));
  ws.addEventListener('open', () => {
    console.log('[sidecar] connected');
  });
  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (!msg || msg.type !== 'run') return;
    const result = await runOnce(msg);
    try { ws.send(JSON.stringify(result)); } catch (err) { console.error('[sidecar] send failed', err); }
  });
  ws.addEventListener('close', () => {
    console.log('[sidecar] disconnected — reconnecting in 3s');
    setTimeout(() => connect(server, token), 3000);
  });
  ws.addEventListener('error', (err) => {
    console.error('[sidecar] error', err && err.message ? err.message : err);
  });
}

const cfg = parseArgs(process.argv.slice(2));
if (!cfg.server || !cfg.token) {
  console.error('Usage: node sidecar.mjs --server ws://<server>:3080/sidecar --token <token>');
  process.exit(2);
}
console.log('[sidecar] connecting to', cfg.server);
connect(cfg.server, cfg.token);
