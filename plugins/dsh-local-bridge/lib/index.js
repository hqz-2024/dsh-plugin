/**
 * dsh-local-bridge host half: a per-user local-machine bridge.
 *
 * A small "sidecar" process runs on each user's Windows machine and dials OUT
 * to this server's `/sidecar` WebSocket endpoint carrying a per-account token.
 * The model-facing `local_run` tool routes a command to the CURRENT session
 * owner's sidecar only (never another account's machine), so the agent can
 * drive local programs — PowerShell, Office, Photoshop/Blender scripting —
 * while the workspace remains the file-exchange surface.
 *
 * Security model (MVP, one trusted LAN deployment):
 *  - sidecar connections authenticate by a per-account token from the
 *    composition config (config.tokens: token -> username).
 *  - `local_run` is routed to the session owner resolved from the auth
 *    ownership map; a session without an owner maps to `admin`.
 *  - the agent is instructed (tool description + README/AGENTS) to confirm
 *    with the user before running arbitrary commands; every command and its
 *    result are logged.
 */
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

const { createRequire } = await import('module');
const require = createRequire(import.meta.url);

const OWNERS_PATH = join(dshHomePath(), 'auth', 'session-owners.json');

let defineTool = null;
try {
	const profileRequire = createRequire(join(dshHomePath(), 'profiles/web/package.json'));
	const toolsEntry = profileRequire.resolve('@deepseek-ai/dsh-tools');
	const toolsModule = await import(pathToFileURL(toolsEntry).href);
	defineTool = typeof toolsModule.defineTool === 'function' ? toolsModule.defineTool : null;
} catch { defineTool = null; }

export const name = 'dsh-local-bridge';
export const inject = ['webServer'];

export function apply(ctx, config) {
	const tokens = (config && config.tokens && typeof config.tokens === 'object') ? config.tokens : {};
	const byToken = new Map(Object.entries(tokens).map(([t, u]) => [t, String(u)]));
	const clients = new Map(); // username -> Set<WebSocket>
	const log = (msg) => { if (ctx.logger) ctx.logger.info('[local-bridge] ' + msg); };
	// LOCAL FORK (2026-09-07): expose token/connection state to the settings UI
	// via a cordis service, so dsh-remote-local can render a "本地插件" section
	// without reaching into this plugin's internals.
	const tokenFor = (username) => {
		for (const [t, u] of Object.entries(tokens)) {
			if (String(u) === String(username)) return t;
		}
		return null;
	};
	const isConnected = (username) => {
		const set = clients.get(username);
		return !!(set && set.size > 0);
	};
	const disposeBridge = ctx.provide('localBridge', { tokenFor, isConnected });
	ctx.effect(() => () => { disposeBridge(); }, 'local-bridge: service');

	/** Resolve the session owner from the shared ownership map (fail-open to admin). */
	const ownerOfSession = (sessionId) => {
		if (!sessionId) return 'admin';
		try {
			const owners = JSON.parse(readFileSync(OWNERS_PATH, 'utf8'));
			return typeof owners[sessionId] === 'string' ? owners[sessionId] : 'admin';
		} catch {
			return 'admin';
		}
	};

	const attachReceiver = (socket) => {
		socket.on('message', (raw) => {
			let msg;
			try { msg = JSON.parse(String(raw)); } catch { return; }
			if (!msg || msg.type !== 'run-result') return;
			const entry = pending.get(msg.id);
			if (!entry) return;
			clearTimeout(entry.timer);
			pending.delete(msg.id);
			entry.resolve(msg);
		});
	};

	const wss = new WebSocketServer({ noServer: true });
	wss.on('connection', (socket, req) => {
		let token = '';
		try {
			const url = new URL(req.url || '', 'http://localhost');
			token = url.searchParams.get('token') || '';
		} catch { token = ''; }
		const username = byToken.get(token);
		if (!username) {
			socket.close(4001, 'unauthorized');
			return;
		}
		let set = clients.get(username);
		if (!set) { set = new Set(); clients.set(username, set); }
		set.add(socket);
		attachReceiver(socket);
		log('sidecar connected for ' + username + ' (' + set.size + ' open socket(s))');
		socket.on('close', () => {
			set.delete(socket);
			if (set.size === 0) clients.delete(username);
			log('sidecar disconnected for ' + username);
		});
		socket.on('error', () => { /* handled by close */ });
	});

	const webServer = ctx.webServer;
	const disposers = [];
	disposers.push(webServer.registerUpgrade({
		kind: 'exact',
		path: '/sidecar',
		handler: (req, socket, head) => {
			wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
		}
	}));

	// LOCAL FORK (2026-09-07): serve sidecar.mjs for download from the settings UI.
	const sidecarDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sidecar');
	disposers.push(webServer.register({
		kind: 'exact',
		path: '/dsh-local-bridge/sidecar.mjs',
		handler: (req, res) => {
			try {
				const content = readFileSync(join(sidecarDir, 'sidecar.mjs'), 'utf8');
				res.writeHead(200, {
					'Content-Type': 'text/javascript; charset=utf-8',
					'Content-Disposition': 'attachment; filename="sidecar.mjs"',
					'Content-Length': Buffer.byteLength(content),
					'Cache-Control': 'no-store'
				});
				res.end(content);
			} catch (e) {
				res.writeHead(404);
				res.end('sidecar.mjs not found');
			}
		}
	}));

	let seq = 0;
	const pending = new Map(); // id -> {resolve, timer}

	const sendRun = (socket, request) => new Promise((resolve) => {
		const id = 'run-' + (++seq) + '-' + Date.now().toString(36);
		const timeoutMs = typeof request.timeoutMs === 'number' ? Math.min(Math.max(request.timeoutMs, 1000), 900000) : 120000;
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ ok: false, error: '本地助手执行超时（' + timeoutMs + 'ms）' });
		}, timeoutMs + 15000);
		pending.set(id, { resolve, timer });
		socket.send(JSON.stringify({ type: 'run', id, exe: request.exe, args: request.args || [], workdir: request.workdir || '', timeoutMs, files: request.files || [], collect: request.collect || [] }), (err) => {
			if (!err) return;
			clearTimeout(timer);
			pending.delete(id);
			resolve({ ok: false, error: '发送到本地助手失败：' + String((err && err.message) || err) });
		});
	});

	if (defineTool) {
		const tool = defineTool({
			name: 'local_run',
			description: 'Run a command or open/edit a file on the CURRENT user\'s OWN Windows machine through their local sidecar (a small helper that must be installed and running on that machine). The machine is ALWAYS the one belonging to the account that owns THIS conversation/session — routing is automatic server-side by session ownership, so you never choose a device and must never assume you are targeting any other machine (when unsure which machine you reached, read $env:COMPUTERNAME / $env:USERNAME via pwsh and report them). Use it when the user asks the agent to operate their local software: PowerShell, Office/PDF, Photoshop/Blender scripting, or any local script. command can be "pwsh" (PowerShell script passed as the single element of args) or an executable path/name. inputFiles are written to a temp workdir before the command runs (e.g. send a workspace .xlsx for the local app to edit); collect returns output files by relative glob. IMPORTANT: this executes on the USER\'s computer — confirm with the user before running commands with side effects, and prefer PowerShell or script APIs over destructive commands.',
			parameters: {
				command: { type: 'string', required: true, description: '"pwsh" for PowerShell, or an executable name/path (e.g. "python", "C:\\\\Program Files\\\\...\\\\Photoshop.exe").' },
				args: { type: 'array', items: { type: 'string' }, description: 'Arguments. For "pwsh" put the whole PowerShell script as args[0].' },
				workdir: { type: 'string', description: 'Working directory on the user machine; defaults to a fresh temp directory.' },
				timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 900000).' },
				inputFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, base64: { type: 'string' } }, additionalProperties: false }, description: 'Files to stage in the workdir before running (path is relative to workdir).' },
				collect: { type: 'array', items: { type: 'string' }, description: 'Relative glob patterns of output files to return (base64) after the run.' }
			},
			output: {
				schema: { type: 'object', properties: { ok: { type: 'boolean' }, stdout: { type: 'string' }, stderr: { type: 'string' }, exitCode: { type: 'number' }, files: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' } }, additionalProperties: false },
				render: (_args, value) => {
					if (!value || value.ok !== true) return [{ type: 'text', text: '本地执行失败：' + (value && value.error ? value.error : '未知错误') }];
					const parts = [];
					if (value.stdout) parts.push('stdout:\n' + String(value.stdout).slice(0, 4000));
					if (value.stderr) parts.push('stderr:\n' + String(value.stderr).slice(0, 4000));
					parts.push('exitCode: ' + value.exitCode);
					if (Array.isArray(value.files) && value.files.length) parts.push('返回文件: ' + value.files.map((f) => f.path).join(', '));
					return [{ type: 'text', text: parts.join('\n') }];
				}
			},
			async execute(args, exec) {
				const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined;
				const username = ownerOfSession(sessionId);
				const set = clients.get(username);
				if (!set || set.size === 0) {
					return { ok: false, error: '账号「' + username + '」的本地助手未连接。请在该用户的 Windows 机器上启动 sidecar（见 local-bridge/sidecar/README.md）。' };
				}
				const socket = [...set][set.size - 1];
				const request = {
					exe: args.command,
					args: Array.isArray(args.args) ? args.args.map(String) : [],
					workdir: typeof args.workdir === 'string' ? args.workdir : '',
					timeoutMs: args.timeoutMs,
					files: Array.isArray(args.inputFiles) ? args.inputFiles : [],
					collect: Array.isArray(args.collect) ? args.collect : []
				};
				log('run for ' + username + ': ' + args.command + ' ' + request.args.slice(0, 4).join(' '));
				const raw = await sendRun(socket, request);
				// Strip the wire envelope (`type`/`id`) so the returned value matches
				// the declared output schema exactly (additionalProperties: false).
				const out = { ok: !!(raw && raw.ok === true) };
				if (raw) {
					if (typeof raw.stdout === 'string') out.stdout = raw.stdout;
					if (typeof raw.stderr === 'string') out.stderr = raw.stderr;
					if (typeof raw.exitCode === 'number') out.exitCode = raw.exitCode;
					if (Array.isArray(raw.files)) out.files = raw.files;
					if (typeof raw.error === 'string') out.error = raw.error;
				}
				return out;
			},
			presentCall: (args) => ({ card: 'generic', title: '本地执行 ' + String(args.command || ''), kind: 'run', rawInput: String(args.command || '') })
		});
		ctx.effect(() => {
			const dispose = ctx.get('tools')?.register(tool);
			return () => { if (dispose) dispose(); };
		}, 'local-bridge: local_run tool');
	} else {
		log('tool definition factory unavailable; local_run tool not registered');
	}

	return () => { for (const d of disposers) d(); };
}
