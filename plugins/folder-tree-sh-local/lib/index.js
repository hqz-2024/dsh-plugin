/**
 * dsh-ftree host half: local HTTP routes for the workspace file tree.
 * Routes: /dsh-ftree-list, /dsh-ftree-read, /dsh-ftree-op, /dsh-ftree-pdf.
 * The browser client (lib/client.js) talks to these same-origin routes with fetch.
 */
const FULL = { mode: 'danger-full-access' };
const MAX_FILE = 100 * 1024 * 1024;
const CHUNK = 3 * 349526; // multiple of 3 → base64 chunk concatenation stays valid
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
// realpath-based workspace path guard (symlink/junction escape hardening,
// per security review P0) — see lib/pathguard.js.
import { assertWorkspacePath, realpathLenient } from './pathguard.js';
import { writeFileSync, renameSync, copyFileSync, cpSync, rmSync, mkdirSync, statSync } from 'node:fs';
import XLSX from 'xlsx';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
// Version now comes from package.json (single source of truth).
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const PKG = require('../package.json');
const VERSION = (PKG && PKG.version) || '0.0.0';
// LOCAL FORK (2026-09-02): the runtime's tool-definition factory resolves
// through the profile's healed node_modules mirror (same instance the runtime
// uses), imported fail-safe so a resolution problem never breaks the pane.
let defineTool = null;
try {
	const profileRequire = createRequire(join(dshHomePath(), 'profiles/web/package.json'));
	const toolsEntry = profileRequire.resolve('@deepseek-ai/dsh-tools');
	const toolsModule = await import(pathToFileURL(toolsEntry).href);
	defineTool = typeof toolsModule.defineTool === 'function' ? toolsModule.defineTool : null;
} catch { defineTool = null; }

// Origin allowlist is derived from the actual web server config (webStartup):
// loopback authorities plus the configured bind host and any --trusted-host
// authority. Only HOSTNAMES are compared (scheme and port are ignored) so the
// guard stays correct behind an HTTPS reverse proxy, where the browser Origin
// is `https://<LAN-IP>:8443` while the backend binds loopback:3080 — the
// authority's host is the stable identity across the proxy.
// Same-origin / local-only request guard (security hardening):
// - blocks cross-site simple requests (<img>/<form>/GET fetch) via
//   Sec-Fetch-Site: cross-site, and any request carrying a foreign Origin;
// - Origin can be spoofed by non-browser clients, so every MUTATING route
//   additionally requires the per-process anti-CSRF token (/dsh-ftree-token).
let GUARD_HOSTS = null; // null = LAN mode → rely on the anti-CSRF token only
const authorityHostname = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    return (u.hostname || '').replace(/^\[|\]$/g, '') || null;
  } catch { return null; }
};
const allowRequest = (req) => {
  const hdrs = (req && req.headers) || {};
  const sfs = hdrs['sec-fetch-site'];
  if (sfs && sfs === 'cross-site') return false;
  if (GUARD_HOSTS === null) return true;
  const origin = hdrs['origin'];
  if (!origin) return true;
  const hostname = authorityHostname(origin);
  return hostname !== null && GUARD_HOSTS.has(hostname);
};

// LOCAL FORK (2026-09-02): the auth gate stamps the authenticated role on
// every /dsh-ftree-* request. Admin requests bypass the workspace-root
// whitelist so the pane can browse the whole machine; every other role keeps
// the whitelist (and the gate itself confines mapped accounts to their own
// workspace folder before the request ever reaches a handler).
const roleOf = (req) => String((req && req.headers && req.headers['x-dsh-role']) || '');
const adminRequest = (req) => roleOf(req) === 'admin';
const UPLOAD_MAX = 50 * 1024 * 1024;

// mammoth (docx → HTML) and iconv-lite (GBK fallback) are optional.
let mammoth = null;
try { mammoth = (await import('mammoth')).default ?? (await import('mammoth')); } catch { mammoth = null; }
let iconv = null;
try { iconv = (await import('iconv-lite')).default ?? (await import('iconv-lite')); } catch { iconv = null; }

function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = len % 3;
  if (rem === 1) out = out.slice(0, -2) + '==';
  else if (rem === 2) out = out.slice(0, -1) + '=';
  return out;
}

function parseQs(url) {
  const out = {};
  const q = String(url || '').split('?')[1] || '';
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i > 0 ? kv.slice(0, i) : kv;
    const v = i > 0 ? kv.slice(i + 1) : '';
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export default {
  inject: ['webServer', 'fs'],
  apply(ctx) {
  const webServer = ctx.get('webServer');
  const fs = ctx.get('fs');
  const shell = ctx.get('shell');
  if (webServer === undefined || fs === undefined) return;
  // Derive the origin allowlist from the live web server config.
  try {
    const ws = ctx.get('webStartup') || {};
    const host = (ws && ws.host) || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::' || host === '[::]') {
      GUARD_HOSTS = null; // wildcard bind → LAN access, token is the guard
    } else {
      const set = new Set(['127.0.0.1', 'localhost', '::1']);
      const hostH = authorityHostname(host);
      if (hostH) set.add(hostH);
      if (Array.isArray(ws.trustedHosts)) {
        for (const t of ws.trustedHosts) {
          const h = authorityHostname(t);
          if (h) set.add(h);
        }
      }
      GUARD_HOSTS = set;
    }
  } catch (e) {
    GUARD_HOSTS = new Set(['127.0.0.1']);
  }
  const token = 'ft' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cacheMap = new Map(); // path -> { path, kind, mime, total, bytes, text } (per-path, no cross-file clobber)
  const CACHE_MAX = 64;
  // Canonical (realpath'd) workspace roots, cached 30s (pathguard model).
  let rootsCache = { at: 0, roots: null };
  const realRoots = async (paths) => {
    const now = Date.now();
    if (rootsCache.roots && now - rootsCache.at < 30000) return rootsCache.roots;
    const out = [];
    for (const p of paths) {
      const r = await realpathLenient(p);
      if (r) out.push(r);
    }
    rootsCache = { at: now, roots: out.length ? out : null };
    return rootsCache.roots;
  };
  const workspaceRoots = async () => {
    // Allowlist = registered workspace roots (fallback: sandbox workspace root).
    // null means "unknown" → all paths denied (deny by default).
    try {
      const reg = ctx.get('workspaceRegistry');
      if (reg) {
        const ws = await reg.list();
        const paths = ws.map((w) => w && w.path ? w.path : null).filter(Boolean);
        if (paths.length) return await realRoots(paths);
      }
    } catch (e) {}
    try {
      const sp = ctx.get('sandboxPolicy');
      if (sp && sp.workspaceRoot) return await realRoots([sp.workspaceRoot]);
    } catch (e) {}
    return null;
  };
  // realpath-based containment check (rejects symlink/junction escapes).
  const pathAllowed = async (p, roots) => {
    if (!p || roots === null || !Array.isArray(roots) || roots.length === 0) return false;
    return (await assertWorkspacePath(p, roots)) !== null;
  };

  const sendJson = (res, obj) => {
    try { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch { /* ignore */ }
  };
  const runShell = async (script, stdoutMaxBytes) => {
    const spec = shell.resolve({ command: script, stdoutMaxBytes: stdoutMaxBytes || 16384, sandboxPolicy: FULL });
    return shell.run(spec);
  };
  const shellOk = (res) => res && (res.exitCode === null || res.exitCode === 0) && ((res.stderr && res.stderr.text) || '').trim().length === 0;
  const shellErr = (res) => ((res && res.stderr && res.stderr.text) || '').trim();
  const psq = (s) => String(s).replace(/'/g, "''");
  // LOCAL FORK (2026-09-03): body readers use `for await` so they work with
  // both the live request stream and the auth gate's replayable proxy (which
  // replays a buffered body only through Symbol.asyncIterator, not the
  // `on('data')` event API). Reading via `on('data')` on a replayable request
  // hung forever because the original stream had already ended — the client
  // then timed out on rename/copy/paste/new-file/new-folder/delete.
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      chunks.push(c);
      size += c.length;
      if (size > MAX_FILE + 4096) throw new Error('body too large');
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  // Raw-bytes body reader for uploads (50MB cap).
  const readBodyBuf = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      chunks.push(c);
      size += c.length;
      if (size > UPLOAD_MAX + 4096) throw new Error('too large');
    }
    return Buffer.concat(chunks);
  };
  const existsPath = async (p) => {
    try { const t = await fs.resolve(p); const st = await fs.stat(t); return !!(st && st.type); } catch { return false; }
  };
  const dupNameFor = (p, i) => {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dir = idx >= 0 ? p.slice(0, idx) : '';
    const name = idx >= 0 ? p.slice(idx + 1) : p;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const suffix = i === 1 ? ' (副本)' : ' (副本 ' + i + ')';
    return (dir ? dir + (p.indexOf('/') !== -1 ? '/' : '\\') : '') + base + suffix + ext;
  };
  const uniquePath = async (p) => {
    let cand = p;
    let i = 1;
    while (await existsPath(cand)) { cand = dupNameFor(p, i); i += 1; }
    return cand;
  };
  // LOCAL FORK: sync stat for node:fs-based ops (paste dir detection).
  const isDirSync = (p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  };
  // LOCAL FORK: spreadsheet read/edit support (SheetJS round-trip). The
  // workbook object is cached per path so edits apply to the parsed model
  // and a save rewrites the same workbook in place.
  const xlsxCache = new Map(); // path -> { mtime, wb }
  const XLSX_ROW_CAP = 1000;
  const XLSX_COL_CAP = 100;
  const xlsxCellText = (cell) => {
    if (!cell) return null;
    if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
    if (cell.t === 'e') return String(cell.v || '');
    return cell.v === undefined || cell.v === null ? null : String(cell.v);
  };
  const xlsxPayloadOf = (wb) => {
    const sheets = [];
    const names = wb.SheetNames.slice(0, 12);
    for (const name of names) {
      const ws = wb.Sheets[name];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const maxR = Math.min(range.e.r, XLSX_ROW_CAP - 1);
      const maxC = Math.min(range.e.c, XLSX_COL_CAP - 1);
      const rows = [];
      for (let r = 0; r <= maxR; r += 1) {
        const row = [];
        for (let c = 0; c <= maxC; c += 1) row.push(xlsxCellText(ws[XLSX.utils.encode_cell({ r, c })]));
        rows.push(row);
      }
      const merges = (ws['!merges'] || []).map((m) => XLSX.utils.encode_range(m)).slice(0, 500);
      const colWidths = [];
      for (let c = 0; c <= maxC; c += 1) {
        const info = ws['!cols'] && ws['!cols'][c];
        colWidths.push(info && typeof info.wch === 'number' ? info.wch : null);
      }
      sheets.push({ name, rows, merges, colWidths });
    }
    return { sheets, names };
  };

  const disposers = [];

  // GET /dsh-ftree-meta → { version } used by the client for stale-cache detection
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-meta',
    handler: async (req, res) => {
      if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
      sendJson(res, { ok: true, version: VERSION })
    }
  }));

  // GET /dsh-ftree-token → { token } per-process anti-CSRF token for mutating routes
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-token',
    handler: async (req, res) => {
      if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
      sendJson(res, { ok: true, token })
    }
  }));

  // GET /dsh-ftree-list?path=&withMtime=1 → { path, entries:[{name,kind,size,path,mtime}] } | { error }
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-list',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        const q = parseQs(req.url);
        const path = q.path;
        if (!path) return sendJson(res, { error: 'missing path' });
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(path, roots))) return sendJson(res, { error: '路径不在工作区内' });
        const target = await fs.resolve(path);
        const entries = await fs.listDir(target);
        const withMtime = q.withMtime === '1' || q.withMtime === 'true';
        const out = [];
        for (const e of entries) {
          const item = {
            name: e.name,
            kind: e.type === 'directory' ? 'dir' : e.type === 'file' ? 'file' : 'other',
            size: typeof e.size === 'number' ? e.size : null,
            path: e.target.displayPath ?? String(e.target)
          };
          if (withMtime) {
            try {
              const st = await fs.stat(e.target);
              const ms = st && (typeof st.mtimeMs === 'number' ? st.mtimeMs : (st.mtime && st.mtime.getTime ? st.mtime.getTime() : null));
              item.mtime = typeof ms === 'number' ? ms : null;
            } catch { item.mtime = null; }
          }
          out.push(item);
        }
        sendJson(res, { path: target.displayPath ?? path, entries: out });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // GET /dsh-ftree-read?path=&offset=&whole= → chunked content (same shape as the dynamic RPC)
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-read',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        const q = parseQs(req.url);
        const path = q.path;
        const offset = Number(q.offset) > 0 ? Number(q.offset) : 0;
        const whole = q.whole === 'true' || q.whole === '1';
        if (!path) return sendJson(res, { error: 'missing path' });
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(path, roots))) return sendJson(res, { error: '路径不在工作区内' });
        const m = path.match(/\.([a-zA-Z0-9]+)$/);
        const lower = (m ? '.' + m[1] : '').toLowerCase();
        const target = await fs.resolve(path);
        let c = cacheMap.get(path);
        if (c) {
          // Stale-cache guard: re-stat the file; when its size changed since it
          // was cached (external edit, another tool, our own write) drop the
          // entry so the next read re-loads fresh content.
          try {
            const fresh = await fs.stat(target);
            const freshSize = fresh && typeof fresh.size === 'number' ? fresh.size : -1;
            if (freshSize !== c.size) { cacheMap.delete(path); c = null; }
          } catch { cacheMap.delete(path); c = null; }
        }
        if (!c) {
          const info = await fs.stat(target);
          const size = info && typeof info.size === 'number' ? info.size : 0;
          if (size > MAX_FILE) return sendJson(res, { error: '文件过大（超过 100MB），暂不支持预览' });
          if (MIME[lower]) {
            const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
            c = { path, kind: 'image', mime: MIME[lower], total: bytes.length, bytes, text: null, size: bytes.length };
          } else if (lower === '.pdf') {
            c = { path, kind: 'pdf', mime: 'application/pdf', total: size, bytes: null, text: null, size };
          } else if (lower === '.docx') {
            const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
            if (mammoth) {
              let html = '';
              try {
                const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
                  convertImage: mammoth.images.imgElement((image) =>
                    image.readAsBase64String().then((b64) => ({ src: 'data:' + image.contentType + ';base64,' + b64 })))
                });
                html = result && result.value ? String(result.value) : '';
              } catch (e) {
                return sendJson(res, { error: 'docx 转换失败：' + String((e && e.message) || e) });
              }
              if (html.length > MAX_FILE) html = html.slice(0, MAX_FILE);
              c = { path, kind: 'docx-html', mime: null, total: html.length, bytes: null, text: html, size };
            } else {
              if (shell === undefined) return sendJson(res, { error: 'docx 预览需要 shell 服务' });
              const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; $p = \'' + psq(path) + '\'; $z = [System.IO.Compression.ZipFile]::OpenRead($p); try { $e = $z.GetEntry(\'word/document.xml\'); if ($e -eq $null) { Write-Output \'NO_ENTRY\'; exit 0 }; $r = New-Object System.IO.StreamReader($e.Open()); $x = $r.ReadToEnd(); $r.Close(); $t = $x -replace \'<w:p[^>]*>\', [string][char]10 -replace \'<[^>]+>\', \'\'; $t = [System.Net.WebUtility]::HtmlDecode($t); $out = Join-Path ([Environment]::GetFolderPath(\'LocalApplicationData\') + [IO.Path]::DirectorySeparatorChar + \'Temp\') (\'dsh-docx-\' + [guid]::NewGuid().ToString(\'N\') + \'.txt\'); [System.IO.File]::WriteAllText($out, $t, (New-Object System.Text.UTF8Encoding($false))); Write-Output (\'OK \' + $out) } finally { $z.Dispose() }';
              const rr = await runShell(script, 1 * 1024 * 1024);
              const out = (rr && rr.stdout && typeof rr.stdout.text === 'string' ? rr.stdout.text : '') || '';
              const m2 = out.match(/^OK (.+)$/m);
              if (!m2) return sendJson(res, { error: 'docx 提取失败' });
              const tempTarget = await fs.resolve(m2[1].trim());
              let text = await fs.readText(tempTarget);
              if (text.length > MAX_FILE) text = text.slice(0, MAX_FILE);
              c = { path, kind: 'docx', mime: null, total: text.length, bytes: null, text, size };
            }
          } else if (lower === '.xlsx' || lower === '.xlsm' || lower === '.xls') {
            const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
            let wb;
            try {
              wb = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
            } catch (e) {
              return sendJson(res, { error: 'xlsx 解析失败：' + String((e && e.message) || e) });
            }
            xlsxCache.set(path, { mtime: Date.now(), wb });
            c = { path, kind: 'xlsx', mime: null, total: size, bytes: null, text: null, size, payload: xlsxPayloadOf(wb) };
          } else if (lower === '.doc') {
            return sendJson(res, { error: '旧版 .doc 格式暂不支持预览，请用 Word 另存为 .docx 后再打开' });
          } else {
            const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
            let text;
            try { text = new TextDecoder('utf-8').decode(bytes); } catch { return sendJson(res, { error: '无法解码文件内容' }); }
            if (text.indexOf('\u0000') !== -1) return sendJson(res, { error: '二进制文件，暂不支持预览' });
            const repl = (text.match(/\uFFFD/g) || []).length;
            if (bytes.length > 0 && repl / bytes.length > 0.02) {
              // UTF-8 decode failed → try GBK (common on Chinese Windows for txt/md)
              let gbkText = null;
              if (iconv) {
                try {
                  const gbk = iconv.decode(Buffer.from(bytes), 'gbk');
                  const gbkRepl = (gbk.match(/\uFFFD/g) || []).length;
                  const ctrl = (gbk.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
                  if (gbk.indexOf('\u0000') === -1 && gbk.length > 0 && gbkRepl / gbk.length <= 0.01 && ctrl / gbk.length < 0.05) gbkText = gbk;
                } catch { gbkText = null; }
              }
              if (gbkText === null) return sendJson(res, { error: '二进制文件，暂不支持预览' });
              text = gbkText;
            }
            c = { path, kind: 'text', mime: null, total: text.length, bytes: null, text, size: bytes.length };
          }
          cacheMap.set(path, c);
          if (cacheMap.size > CACHE_MAX) cacheMap.clear();
        }
        if (whole && c.total > 20 * 1024 * 1024) return sendJson(res, { error: '文件过大（超过 20MB），请使用分块读取' });
        if (c.kind === 'pdf') return sendJson(res, { ok: true, kind: 'pdf', size: c.total, page: 1, pages: 1 });
        if (c.kind === 'xlsx') return sendJson(res, { ok: true, kind: 'xlsx', size: c.total, payload: c.payload });
        if (whole) {
          if (c.kind === 'image') return sendJson(res, { ok: true, kind: 'image', mime: c.mime, size: c.total, offset: 0, done: true, base64: bytesToBase64(c.bytes) });
          return sendJson(res, { ok: true, kind: c.kind, size: c.total, offset: 0, done: true, text: c.text });
        }
        if (c.kind === 'image') {
          const start = Math.min(offset, c.total);
          const end = Math.min(c.total, start + CHUNK);
          return sendJson(res, { ok: true, kind: 'image', mime: c.mime, size: c.total, offset: start, done: end >= c.total, base64: bytesToBase64(c.bytes.subarray(start, end)) });
        }
        const start = Math.min(offset, c.total);
        const end = Math.min(c.total, start + CHUNK);
        sendJson(res, { ok: true, kind: c.kind, size: c.total, offset: start, done: end >= c.total, text: c.text.slice(start, end) });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // POST /dsh-ftree-op  body: { token, op, ...args } → rename|delete|paste|open
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-op',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' });
        const body = await readBody(req);
        let q = {};
        try { q = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'invalid body' }); }
        if (!q.token || q.token !== token) return sendJson(res, { error: 'forbidden' });
        const op = q.op;
        const roots = await workspaceRoots();
        const involved = [q.path, q.srcPath, q.destDir].filter(Boolean);
        const involvedResults = await Promise.all(involved.map((p) => pathAllowed(p, roots)));
        if (!adminRequest(req) && involvedResults.some((ok) => !ok)) return sendJson(res, { error: '路径不在工作区内' });
        // LOCAL FORK (2026-09-02): every op below is implemented with node:fs
        // directly — no PowerShell dependency. The shell executor (when
        // mounted) is only an enhancement for Recycle-Bin deletes and
        // explorer launches.
        if (op === 'rename') {
          const path = q.path;
          const newName = (q.newName || '').trim();
          if (!path) return sendJson(res, { error: 'missing path' });
          if (newName.length === 0 || newName.length > 200) return sendJson(res, { error: '无效的文件名' });
          if (/[\\/:*?"<>|]/.test(newName)) return sendJson(res, { error: '文件名包含非法字符' });
          const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
          const dir = idx >= 0 ? path.slice(0, idx) : '';
          const newPath = (dir ? dir + (path.indexOf('/') !== -1 ? '/' : '\\') : '') + newName;
          const finalPath = await uniquePath(newPath);
          renameSync(path, finalPath);
          return sendJson(res, { ok: true, newPath: finalPath, conflict: finalPath !== newPath });
        }
        if (op === 'delete') {
          const path = q.path;
          if (!path) return sendJson(res, { error: 'missing path' });
          if (shell !== undefined) {
            // Recycle Bin (recoverable) when a shell executor is mounted.
            const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; $p = \'' + psq(path) + '\'; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, \'OnlyErrorDialogs\', \'SendToRecycleBin\', \'DoNothing\') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, \'OnlyErrorDialogs\', \'SendToRecycleBin\', \'DoNothing\') }';
            const r = await runShell(script);
            if (!shellOk(r)) return sendJson(res, { error: '删除失败：' + (shellErr(r).slice(0, 200) || '未知错误') });
            return sendJson(res, { ok: true, recycle: true });
          }
          // Fallback: recoverable per-folder trash directory.
          const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
          const dir = idx >= 0 ? path.slice(0, idx) : '';
          const sep = path.indexOf('/') !== -1 ? '/' : '\\';
          const leaf = path.slice(idx + 1);
          const trashDir = (dir || '.') + sep + '.dsh-recycle';
          mkdirSync(trashDir, { recursive: true });
          const trashPath = trashDir + sep + Date.now() + '-' + leaf;
          renameSync(path, trashPath);
          return sendJson(res, { ok: true, recycle: false, trash: trashPath });
        }
        if (op === 'paste') {
          const srcPath = q.srcPath;
          const destDir = q.destDir;
          const mode = q.mode === 'cut' ? 'cut' : 'copy';
          const newName = q.newName || null;
          if (!srcPath || !destDir) return sendJson(res, { error: 'missing args' });
          if (mode === 'cut' && !newName) {
            const idx = Math.max(srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
            const srcDir = idx >= 0 ? srcPath.slice(0, idx) : '';
            if (srcDir === destDir) return sendJson(res, { error: '文件已在该文件夹' });
          }
          const sep = destDir.indexOf('/') !== -1 ? '/' : '\\';
          const leaf = newName || srcPath.slice(Math.max(srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\')) + 1);
          const dst = await uniquePath(destDir + (destDir.endsWith('/') || destDir.endsWith('\\') ? '' : sep) + leaf);
          const srcIsDir = isDirSync(srcPath);
          if (mode === 'cut') {
            try {
              renameSync(srcPath, dst);
            } catch {
              // Cross-device move: copy then remove.
              if (srcIsDir) cpSync(srcPath, dst, { recursive: true });
              else copyFileSync(srcPath, dst);
              rmSync(srcPath, { recursive: true, force: true });
            }
          } else if (srcIsDir) {
            cpSync(srcPath, dst, { recursive: true });
          } else {
            copyFileSync(srcPath, dst);
          }
          cacheMap.delete(destDir);
          return sendJson(res, { ok: true, newPath: dst, conflict: dst !== destDir + (destDir.endsWith('/') || destDir.endsWith('\\') ? '' : sep) + leaf });
        }
        if (op === 'mkdir' || op === 'newfile') {
          const path = q.path; // target directory
          const name = (q.name || '').trim();
          if (!path || !name) return sendJson(res, { error: 'missing args' });
          if (name.length === 0 || name.length > 200) return sendJson(res, { error: '无效的文件名' });
          if (/[\\/:*?"<>|]/.test(name)) return sendJson(res, { error: '文件名包含非法字符' });
          const sep = path.indexOf('/') !== -1 ? '/' : '\\';
          const dir2 = path.endsWith('/') || path.endsWith('\\') ? path.slice(0, -1) : path;
          const full = await uniquePath(dir2 + sep + name);
          const finalLeaf = full.slice(Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\')) + 1);
          if (op === 'mkdir') mkdirSync(full);
          else writeFileSync(full, '');
          return sendJson(res, { ok: true, newPath: full, conflict: finalLeaf !== name });
        }
        if (op === 'open') {
          const path = q.path;
          if (!path) return sendJson(res, { error: 'missing path' });
          if (shell === undefined) return sendJson(res, { error: '当前环境不支持打开资源管理器' });
          const script = q.select === 'true'
            ? "[System.Diagnostics.Process]::Start('explorer.exe', '/select,\"" + psq(path) + "\"')"
            : "[System.Diagnostics.Process]::Start('" + psq(path) + "')";
          const r = await runShell(script);
          if (!shellOk(r)) return sendJson(res, { error: '打开失败：' + (shellErr(r).slice(0, 200) || '未知错误') });
          return sendJson(res, { ok: true });
        }
        sendJson(res, { error: 'unknown op' });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // POST /dsh-ftree-write?path=  body: {"content": "..."} → save text file (md editor autosave)
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-write',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        const q = parseQs(req.url);
        const path = q.path;
        if (!path) return sendJson(res, { error: 'missing path' });
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(path, roots))) return sendJson(res, { error: '路径不在工作区内' });
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'invalid body' }); }
        if (!parsed.token || parsed.token !== token) return sendJson(res, { error: 'forbidden' });
        const content = parsed.content;
        if (typeof content !== 'string') return sendJson(res, { error: 'invalid content' });
        if (content.length > MAX_FILE) return sendJson(res, { error: '内容过大（超过 100MB）' });
        const target = await fs.resolve(path);
        // Keep rolling backups (.dshbak.1 newest, .3 oldest) before overwriting.
        // Backup failure must NEVER block the actual save.
        if (shell !== undefined) {
          try {
            const bscript = '$f = \'' + psq(path) + '\'; if (Test-Path -LiteralPath $f) { $n = [IO.Path]::GetFileName($f); $d = [IO.Path]::GetDirectoryName($f); $p3 = Join-Path $d ($n + \'.dshbak.3\'); $p2 = Join-Path $d ($n + \'.dshbak.2\'); $p1 = Join-Path $d ($n + \'.dshbak.1\'); if (Test-Path -LiteralPath $p3) { Remove-Item -LiteralPath $p3 -Force }; if (Test-Path -LiteralPath $p2) { Move-Item -LiteralPath $p2 -Destination $p3 -Force }; if (Test-Path -LiteralPath $p1) { Move-Item -LiteralPath $p1 -Destination $p2 -Force }; Copy-Item -LiteralPath $f -Destination $p1 -Force }';
            await runShell(bscript);
          } catch { /* backup is best-effort only */ }
        }
        await fs.writeText(target, content, undefined, undefined, FULL);
        // Invalidate the preview cache for this path so a re-open shows the
        // freshly saved content (stale-cache guard above re-stats anyway).
        cacheMap.delete(path);
        sendJson(res, { ok: true, size: content.length });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // LOCAL FORK (2026-09-02): POST /dsh-ftree-upload?dir=<target>&name=<file>&token= → raw body bytes
  // saved into `dir`. Admin may target any directory; every other role is
  // confined by the auth gate (mapped workspace) before this handler runs.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-upload',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
        if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' });
        const q = parseQs(req.url);
        const dir = q.dir;
        const name = (q.name || '').trim();
        if (!dir) return sendJson(res, { error: 'missing dir' });
        if (!name || name.length > 200 || /[\\/:*?"<>|]/.test(name)) return sendJson(res, { error: '无效的文件名' });
        if (!q.token || q.token !== token) return sendJson(res, { error: 'forbidden' });
        if (!adminRequest(req)) {
          const roots = await workspaceRoots();
          if (!(await pathAllowed(dir, roots))) return sendJson(res, { error: '路径不在工作区内' });
        }
        const body = await readBodyBuf(req);
        if (body.length > UPLOAD_MAX) return sendJson(res, { error: '文件过大（超过 50MB）' });
        const sep = dir.indexOf('/') !== -1 ? '/' : '\\';
        const base = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
        // LOCAL FORK (2026-09-03): create missing parent directories so a
        // folder upload (client walks webkitRelativePath and passes nested
        // `dir`) lands without a separate mkdir round-trip.
        mkdirSync(base, { recursive: true });
        const full = await uniquePath(base + sep + name);
        writeFileSync(full, body);
        cacheMap.delete(dir);
        sendJson(res, { ok: true, path: full, size: body.length });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // LOCAL FORK (2026-09-02): GET /dsh-ftree-download?path= → attachment download.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-download',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
        const q = parseQs(req.url);
        if (!q.path) { res.writeHead(400); res.end('missing path'); return; }
        if (!adminRequest(req)) {
          const roots = await workspaceRoots();
          if (!(await pathAllowed(q.path, roots))) { res.writeHead(403); res.end('forbidden'); return; }
        }
        const target = await fs.resolve(q.path);
        const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
        const leaf = q.path.slice(Math.max(q.path.lastIndexOf('/'), q.path.lastIndexOf('\\')) + 1);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(leaf),
          'Cache-Control': 'no-store'
        });
        res.end(bytes);
      } catch (e) {
        res.writeHead(500);
        res.end((e && e.message) ? String(e.message) : String(e));
      }
    }
  }));

  // LOCAL FORK (2026-09-02): POST /dsh-ftree-xlsx-save?path= body { token, edits }
  // applies cell edits to the cached workbook and rewrites the file in place
  // (SheetJS round-trip: values update, cell styles of touched cells kept).
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-xlsx-save',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' });
        const q = parseQs(req.url);
        const path = q.path;
        if (!path) return sendJson(res, { error: 'missing path' });
        if (!adminRequest(req)) {
          const roots = await workspaceRoots();
          if (!(await pathAllowed(path, roots))) return sendJson(res, { error: '路径不在工作区内' });
        }
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'invalid body' }); }
        if (!parsed.token || parsed.token !== token) return sendJson(res, { error: 'forbidden' });
        if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) return sendJson(res, { error: 'missing edits' });
        if (parsed.edits.length > 5000) return sendJson(res, { error: '编辑数量过多' });
        let entry = xlsxCache.get(path);
        if (!entry) {
          const target = await fs.resolve(path);
          const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
          try {
            entry = { mtime: Date.now(), wb: XLSX.read(bytes, { type: 'buffer', cellStyles: true }) };
          } catch (e) {
            return sendJson(res, { error: 'xlsx 解析失败：' + String((e && e.message) || e) });
          }
          xlsxCache.set(path, entry);
        }
        const wb = entry.wb;
        let count = 0;
        for (const e of parsed.edits) {
          const ws = typeof e.sheet === 'string' ? wb.Sheets[e.sheet] : undefined;
          if (!ws) continue;
          const r = Number(e.r);
          const c = Number(e.c);
          if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= XLSX_ROW_CAP || c >= XLSX_COL_CAP) continue;
          const addr = XLSX.utils.encode_cell({ r, c });
          const value = e.value === null || e.value === undefined ? '' : String(e.value).slice(0, 30000);
          const old = ws[addr];
          if (value === '') {
            if (old) { delete ws[addr]; count += 1; }
          } else if (old) {
            // Keep the existing cell style; replace the cached value/formula.
            ws[addr] = { ...old, t: 's', v: value };
            delete ws[addr].w;
            delete ws[addr].f;
            count += 1;
          } else {
            ws[addr] = { t: 's', v: value };
            count += 1;
          }
        }
        if (count > 0) {
          const lower = (path.match(/\.([a-zA-Z0-9]+)$/) || [])[1] ? '.' + (path.match(/\.([a-zA-Z0-9]+)$/) || [])[1] : '.xlsx';
          XLSX.writeFile(wb, path, { cellStyles: true, bookType: lower === '.xls' ? 'biff8' : undefined });
          cacheMap.delete(path);
        }
        sendJson(res, { ok: true, count });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // GET /dsh-ftree-pdf?path= → PDF bytes (browser-native viewer)
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-pdf',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
        const q = parseQs(req.url);
        if (!q.path) { res.writeHead(400); res.end('missing path'); return; }
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(q.path, roots))) { res.writeHead(403); res.end('forbidden'); return; }
        const target = await fs.resolve(q.path);
        const bytes = await fs.readBytes(target, undefined, MAX_FILE + 1);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Content-Disposition': 'inline', 'Cache-Control': 'no-cache' });
        res.end(bytes);
      } catch (e) {
        res.writeHead(500);
        res.end((e && e.message) ? String(e.message) : String(e));
      }
    }
  }));

  // GET /dsh-ftree-raw?path= → raw bytes for markdown image references
  // (workspace-relative paths), with a MIME guess and short private cache.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-raw',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) { res.writeHead(403); res.end('forbidden'); return; }
        const q = parseQs(req.url);
        if (!q.path) { res.writeHead(400); res.end('missing path'); return; }
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(q.path, roots))) { res.writeHead(403); res.end('forbidden'); return; }
        const target = await fs.resolve(q.path);
        const bytes = await fs.readBytes(target, undefined, 16 * 1024 * 1024 + 1);
        if (bytes.length > 16 * 1024 * 1024) { res.writeHead(413); res.end('too large'); return; }
        const m = q.path.match(/\.([a-zA-Z0-9]+)$/);
        const lower = (m ? '.' + m[1] : '').toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[lower] || 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=60'
        });
        res.end(bytes);
      } catch (e) {
        res.writeHead(500);
        res.end((e && e.message) ? String(e.message) : String(e));
      }
    }
  }));

  // GET /dsh-ftree-git?path=<dir> → { ok, git, branch, changes:[{path,x,y}] }
  // Parses `git status --porcelain=v1 --branch`. x = staged status char,
  // y = worktree status char (' ' = clean, '?' = untracked).
  const gitRun = async (dir, args, maxBytes) => {
    const script = "git -C '" + psq(dir) + "' " + args;
    return runShell(script, maxBytes || 4 * 1024 * 1024);
  };
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-git',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        const q = parseQs(req.url);
        const dir = q.path;
        if (!dir) return sendJson(res, { error: 'missing path' });
        const roots = await workspaceRoots();
        if (!adminRequest(req) && !(await pathAllowed(dir, roots))) return sendJson(res, { error: '路径不在工作区内' });
        if (shell === undefined) return sendJson(res, { error: '需要 shell 服务' });
        const rr = await gitRun(dir, 'status --porcelain=v1 --branch', 2 * 1024 * 1024);
        const out = (rr && rr.stdout && typeof rr.stdout.text === 'string' ? rr.stdout.text : '') || '';
        const err = shellErr(rr);
        if ((out.trim() === '' && /not a git repository/i.test(err)) || /not a git repository/i.test(err)) {
          return sendJson(res, { ok: true, git: false });
        }
        const lines = out.split(/\r?\n/).filter(Boolean);
        let branch = '';
        const changes = [];
        for (const line of lines) {
          if (line.startsWith('##')) {
            const m2 = line.match(/^##\s+([^\s.]+)/);
            branch = m2 ? m2[1] : '';
            continue;
          }
          if (line.length < 3) continue;
          const x = line[0];
          const y = line[1];
          let p = line.slice(3);
          const arrow = p.indexOf(' -> ');
          if (arrow !== -1) p = p.slice(arrow + 4); // renamed: keep the new path
          changes.push({ path: p, x, y });
        }
        sendJson(res, { ok: true, git: true, branch, changes });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // POST /dsh-ftree-git-op { token, path, op, target, staged }
  // op: stage | unstage | discard | diff. diff returns unified diff text.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-ftree-git-op',
    handler: async (req, res) => {
      try {
        if (!allowRequest(req)) return sendJson(res, { error: 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' });
        const body = await readBody(req);
        let q = {};
        try { q = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'invalid body' }); }
        if (!q.token || q.token !== token) return sendJson(res, { error: 'forbidden' });
        const dir = q.path;
        const target = q.target;
        const op = q.op;
        if (!dir || !target || !op) return sendJson(res, { error: 'missing args' });
        if (shell === undefined) return sendJson(res, { error: '需要 shell 服务' });
        const roots = await workspaceRoots();
        if (!adminRequest(req) && (!(await pathAllowed(dir, roots)) || !(await pathAllowed(target, roots)))) return sendJson(res, { error: '路径不在工作区内' });
        const tq = "'" + psq(target) + "'";
        let script;
        if (op === 'stage') script = "git -C '" + psq(dir) + "' add -- " + tq;
        else if (op === 'unstage') script = "git -C '" + psq(dir) + "' restore --staged -- " + tq;
        else if (op === 'discard') {
          if (q.untracked === true) {
            // Untracked files cannot be restored by git — remove to Recycle Bin.
            script = 'Add-Type -AssemblyName Microsoft.VisualBasic; $p = \'' + psq(target) + '\'; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, \'OnlyErrorDialogs\', \'SendToRecycleBin\', \'DoNothing\') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, \'OnlyErrorDialogs\', \'SendToRecycleBin\', \'DoNothing\') }';
          } else {
            script = "git -C '" + psq(dir) + "' checkout -- " + tq;
          }
        }
        else if (op === 'diff') {
          const cached = q.staged === true ? ' --cached' : '';
          const rr = await gitRun(dir, 'diff' + cached + ' -- ' + tq.replace(/^'|'$/g, ''), 1024 * 1024);
          const out = (rr && rr.stdout && typeof rr.stdout.text === 'string' ? rr.stdout.text : '') || '';
          return sendJson(res, { ok: true, diff: out.slice(0, 512 * 1024) });
        } else return sendJson(res, { error: 'unknown op' });
        const r = await runShell(script);
        if (!shellOk(r)) return sendJson(res, { error: 'git 操作失败：' + (shellErr(r).slice(0, 200) || '未知错误') });
        return sendJson(res, { ok: true });
      } catch (e) {
        sendJson(res, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  }));

  // ── AI office writers (LOCAL FORK, 2026-09-02) ────────────────────────────
  // Model-facing tools that create/update native Word and Excel documents
  // through the dsh-doc offline Python runtime (openpyxl / python-docx, fully
  // local). Confinement mirrors the session sandbox policy: writes must land
  // inside the session workspace root unless the session holds
  // danger-full-access.
  const OFFICE_PY = process.env.DSH_DOC_PYTHON ?? join(dshHomePath(), 'runtimes', 'dshdoc-runtime-linux-x64', 'python', 'python');
  const OFFICE_WORKER = fileURLToPath(new URL('../python/office_worker.py', import.meta.url));
  const runOfficeWorker = (req) => {
    const out = spawnSync(OFFICE_PY, [OFFICE_WORKER], {
      input: JSON.stringify(req),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180000,
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
    });
    if (out.error) return { ok: false, error: String((out.error && out.error.message) || out.error) };
    const text = (out.stdout || '').trim();
    if (!text) return { ok: false, error: '文档引擎无输出' };
    try { return JSON.parse(text); } catch { return { ok: false, error: '文档引擎输出无效' }; }
  };
  const confineToolPath = (exec, rawPath) => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return { ok: false, error: '缺少目标路径' };
    const policy = ctx.get('sandboxPolicy');
    if (!policy) return { ok: true };
    const session = exec && exec.agent ? exec.agent.session : undefined;
    const resolved = policy.resolve(session ? { session } : {});
    if (resolved.mode === 'danger-full-access') return { ok: true };
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const rootN = norm(resolved.workspaceRoot);
    if (!rootN) return { ok: false, error: '沙箱策略未配置工作区根' };
    let real = rawPath;
    try { real = realpathLenient(rawPath); } catch { /* keep raw */ }
    const check = norm(real);
    if (check === rootN || check.startsWith(rootN + '/')) return { ok: true };
    return { ok: false, error: '目标路径超出会话工作区范围：' + resolved.workspaceRoot };
  };
  const leafName = (p) => String(p || '').split(/[\\/]/).pop() || p;
  const officeOutput = (okText) => ({
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, sheets: { type: 'array', items: { type: 'string' } }, paragraphs: { type: 'number' }, tables: { type: 'number' }, error: { type: 'string' } }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: value && value.ok ? okText(value) : ('写入失败：' + (value && value.error ? value.error : '未知错误')) }]
  });
  const tools = ctx.get('tools');
  if (tools && defineTool) {
    try {
      const xlsxTool = defineTool({
        name: 'office_xlsx_write',
        description: 'Create or update a native Excel workbook (.xlsx) in the session workspace using openpyxl (fully local; untouched cells keep their styles). Pass `data` as a JSON string: an array of sheet specs [{"name":"Sheet1","rows":[["标题",123],["合计",456]]}]. mode "update" overwrites only the listed cells and leaves everything else intact.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path of the target .xlsx file, inside the session workspace.' },
          mode: { type: 'string', enum: ['create', 'update'], description: 'create = new workbook (default); update = modify an existing workbook.' },
          data: { type: 'string', required: true, description: 'JSON string: array of sheet specs {name: string, rows: (string|number)[][]}.' }
        },
        output: officeOutput((v) => '已写入 Excel：' + ((v.sheets && v.sheets.join(', ')) || '')),
        async execute(args, exec) {
          const confine = confineToolPath(exec, args.path);
          if (!confine.ok) return { ok: false, error: confine.error };
          if (!/\.xlsx$/i.test(args.path)) return { ok: false, error: '文件名必须以 .xlsx 结尾' };
          let sheets;
          try { sheets = JSON.parse(args.data); } catch { return { ok: false, error: 'data 不是合法 JSON' }; }
          if (!Array.isArray(sheets)) return { ok: false, error: 'data 必须是 sheet 规格数组' };
          return runOfficeWorker({ op: 'xlsx_write', path: args.path, mode: args.mode === 'update' ? 'update' : 'create', sheets });
        },
        presentCall: (args) => ({ card: 'generic', title: '写入 Excel ' + leafName(args.path), kind: 'write', rawInput: args.path })
      });
      const docxTool = defineTool({
        name: 'office_docx_write',
        description: 'Create or modify a native Word document (.docx) in the session workspace using python-docx (fully local). Pass `data` as a JSON string: for create/append use {"blocks":[{"type":"heading","level":1,"text":"标题"},{"type":"para","text":"段落"},{"type":"bullet","text":"要点"},{"type":"table","rows":[["a","b"]]}]}; for replace use {"pairs":[["旧文本","新文本"]]}.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute path of the target .docx file, inside the session workspace.' },
          mode: { type: 'string', enum: ['create', 'append', 'replace'], description: 'create = new document (default); append = add blocks to an existing one; replace = find/replace text.' },
          data: { type: 'string', required: true, description: 'JSON string: {"blocks":[...]} for create/append, {"pairs":[[old,new],...]} for replace.' }
        },
        output: officeOutput((v) => '已写入 Word：' + (typeof v.paragraphs === 'number' ? v.paragraphs + ' 段' : '') + (typeof v.tables === 'number' ? '，' + v.tables + ' 个表格' : '')),
        async execute(args, exec) {
          const confine = confineToolPath(exec, args.path);
          if (!confine.ok) return { ok: false, error: confine.error };
          if (!/\.docx$/i.test(args.path)) return { ok: false, error: '文件名必须以 .docx 结尾' };
          let parsed;
          try { parsed = JSON.parse(args.data); } catch { return { ok: false, error: 'data 不是合法 JSON' }; }
          const mode = args.mode === 'append' ? 'append' : args.mode === 'replace' ? 'replace' : 'create';
          const req = { op: 'docx_write', path: args.path, mode };
          if (mode === 'replace') req.pairs = Array.isArray(parsed.pairs) ? parsed.pairs.map((p) => [String(p && p[0]), String(p && p[1])]) : [];
          else req.blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
          return runOfficeWorker(req);
        },
        presentCall: (args) => ({ card: 'generic', title: '写入 Word ' + leafName(args.path), kind: 'write', rawInput: args.path })
      });
      ctx.effect(() => {
        const d1 = tools.register(xlsxTool);
        const d2 = tools.register(docxTool);
        return () => { if (d1) d1(); if (d2) d2(); };
      }, 'ftree: office writer tools');
    } catch (err) {
      if (ctx.logger) ctx.logger.warn('[ftree] office writer tools registration failed: ' + String((err && err.message) || err));
    }
  }

  return () => { for (const d of disposers) d(); };
  }
};
