/**
 * dsh-client-executor — the client half of plan-client-world P2.
 *
 * Runs on the machine a workspace is bound to. It dials OUT to the server's
 * `/executor` WebSocket endpoint with a per-account token, and executes process
 * spawns for that account only; it never listens on a port.
 *
 * Usage:
 *   node executor.mjs --server ws://<host>:3080/executor --token <token> [--label <name>]
 *
 * Protocol (plan §2.4, the subset the dispatcher needs today):
 *
 *   server -> executor
 *     proc.spawn  { procId, argv, cwd, env, stdin, graceMs }
 *     proc.stdin  { procId, data }
 *     proc.close  { procId }                     terminate the whole process tree
 *   executor -> server
 *     hello       { version, host, platform, release }
 *     proc.started{ procId, pid }
 *     proc.chunk  { procId, stream, seq, text }
 *     proc.exit   { procId, exitCode, signal }
 *     proc.error  { procId, error }
 *
 * Environment rule. The whole point of running here is that this machine has the
 * user's tools, so the child gets THIS machine's environment, scrubbed of the
 * harness's own names. `spec.env` from the server is a merge of the SERVER's
 * ambient environment with the caller's deliberate entries, and the executor
 * cannot tell them apart, so an entry is applied only when this machine does not
 * already define that name. The client's PATH therefore always wins, while a
 * caller-chosen variable the client has never heard of still arrives.
 *
 * Termination is tree-scoped: a detached POSIX group or `taskkill /T` on
 * Windows, so Office- and Blender-style helper processes cannot outlive the
 * command that started them.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { homedir, hostname, platform, release } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = '0.2.0'
const DSH_ENV_PREFIX = 'DSH_'
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Reject credential-shaped and harness-owned names. */
function isScrubbed(name) {
	return SENSITIVE_ENV_PATTERN.test(name) || name.toUpperCase().startsWith(DSH_ENV_PREFIX)
}

const IS_WINDOWS = platform() === 'win32'

/**
 * Read one environment entry.
 *
 * Node's `process.env` proxy is case-insensitive on Windows, but a plain object
 * copied out of it is not: the medium spells the key `Path`, so a literal
 * `.PATH` read returns `undefined` and a PATH search silently finds nothing.
 * Windows environment names are case-insensitive, so every lookup here has to
 * be too.
 * @param env - The copied environment.
 * @param name - Entry name in any spelling.
 * @returns the value, or `undefined`.
 */
function envValue(env, name) {
	if (name in env) return env[name]
	if (!IS_WINDOWS) return undefined
	const lower = name.toLowerCase()
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === lower) return env[key]
	}
	return undefined
}

/**
 * The child environment for one spawn: this machine's own, plus the request's
 * entries for names this machine does not define. See the module note.
 * @param requested - Environment entries from the server.
 * @returns the environment to hand to the child.
 */
function childEnvironment(requested) {
	const env = {}
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !isScrubbed(name)) env[name] = value
	}
	for (const [name, value] of Object.entries(requested ?? {})) {
		if (typeof value !== 'string' || isScrubbed(name) || envValue(env, name) !== undefined) continue
		env[name] = value
	}
	return env
}

/**
 * Terminate one process tree, escalating from the caller's request to force.
 * @param procId - Server-side handle identity, for the log line.
 * @param pid - Root process id.
 * @param force - When true, skip the graceful stage.
 */
function killTree(procId, pid, force) {
	if (!pid) return
	try {
		if (platform() === 'win32') {
			spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
		} else {
			// The child is detached, so its group id equals its pid.
			process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
		}
	} catch (error) {
		console.error(`[executor] kill ${force ? 'force ' : ''}failed for ${procId} pid=${pid}: ${String(error?.message ?? error)}`)
	}
}

/**
 * Find one bare program name on this machine's PATH.
 * @param name - Program name without directory components.
 * @param env - The child environment supplying PATH and PATHEXT.
 * @returns the first existing regular file, or `undefined`.
 */
function findOnPath(name, env) {
	const extensions = IS_WINDOWS && extname(name) === ''
		? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
		: ['']
	for (const directory of (envValue(env, 'PATH') ?? '').split(delimiter)) {
		if (!directory) continue
		for (const extension of extensions) {
			const candidate = join(directory, name + extension)
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
			} catch {
				// An unreadable candidate is skipped like a missing one.
			}
		}
	}
	return undefined
}

/**
 * Resolve the program in THIS machine's execution world.
 *
 * The request's `argv[0]` can name a path that only exists on the server: the
 * engine resolves some binaries in-process and hands the absolute path straight
 * to the seam (`dsh-tool-fs-search` resolves its packaged ripgrep that way, to
 * avoid requiring a system `rg`). Passing that through unchanged fails with a
 * bare ENOENT on a machine that has the program installed somewhere else.
 *
 * Order: an absolute path that exists here is used as-is, since it means the two
 * machines lay the program out identically; otherwise the basename is resolved
 * on this machine's PATH. A program that resolves nowhere fails with a message
 * naming it, so the caller learns which dependency the target machine lacks
 * rather than reading an ENOENT with no context.
 *
 * @param program - `argv[0]` as the server spelled it.
 * @param env - The child environment to search.
 * @returns the path to spawn, plus how it was found, for the log.
 * @throws when the program exists in neither world.
 */
function resolveProgram(program, env) {
	if (isAbsolute(program)) {
		try {
			if (existsSync(program) && statSync(program).isFile()) return { path: program, via: 'server-path-exists-here' }
		} catch {
			// Fall through to the PATH lookup.
		}
		const basename = program.split(/[\\/]/).pop() ?? program
		const found = findOnPath(basename, env)
		if (found) return { path: found, via: `basename-on-client-path(from ${program})` }
		throw new Error(
			`program not found on this machine: ${program} (tried '${basename}' on PATH);`
			+ ' the server resolved that absolute path in its own world, and this machine has no equivalent',
		)
	}
	const found = findOnPath(program, env)
	if (found) return { path: found, via: 'name-on-client-path' }
	throw new Error(`program not found on this machine: ${program}`)
}

function parseArgs(argv) {
	const out = { server: '', token: '', label: '', nodePty: '', configPort: 38460, state: '' }
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i]
		else if (argv[i] === '--token' && argv[i + 1]) out.token = argv[++i]
		else if (argv[i] === '--label' && argv[i + 1]) out.label = argv[++i]
		else if (argv[i] === '--node-pty' && argv[i + 1]) out.nodePty = argv[++i]
		else if (argv[i] === '--config-port' && argv[i + 1]) out.configPort = Number(argv[++i])
		else if (argv[i] === '--state' && argv[i + 1]) out.state = argv[++i]
	}
	return out
}

// ── local configuration page (plan §2.5) ─────────────────────────────────────
//
// A machine has to be told which server to trust and which account it speaks
// for, and the plan puts that in a page served from the user's own loopback
// rather than on the command line: the login is a real `/auth/login` against the
// server, and the resulting session is exchanged for an executor token. The page
// is a thin shell over the JSON routes below, so the flow is exercisable without
// a browser.
//
// The token is persisted because the whole point of an executor is to be running
// when nobody is looking; a restart after a reboot must reconnect without
// anyone signing in again.

/** Where the enrolled server and token live between restarts. */
let statePath = ''
/** The enrollment this process is using. */
let enrollment = { server: '', token: '', username: '', label: '' }
/** The most recent answer from `hello`, for the status view. */
let lastHello = null
/** Set when the config page is what started this process, so `/status` can say so. */
let awaitingEnrollment = false
/** The local config server, once started. */
let configServer = null

function loadState() {
	try {
		const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
		return typeof parsed?.server === 'string' && typeof parsed?.token === 'string' ? parsed : undefined
	} catch {
		return undefined
	}
}

function saveState() {
	try {
		mkdirSync(dirname(statePath), { recursive: true })
		writeFileSync(statePath, JSON.stringify(enrollment, null, 2), { mode: 0o600 })
	} catch (error) {
		console.error(`[executor] could not persist state to ${statePath}: ${String(error?.message ?? error)}`)
	}
}

/**
 * Sign in and exchange the session for an executor token (plan §2.5 steps 2-3).
 *
 * The server issues the token; this side only carries the cookie between the two
 * calls. Returning the workspace list is what lets the page offer a choice
 * instead of asking the user to type a workspace id.
 * @param server - Base URL of the DSH server.
 * @param username - Account to sign in as.
 * @param password - Account password.
 * @returns `{ ok: true, token, username, workspaces, heartbeatMs }` or `{ ok: false, error }`.
 */
async function signIn(server, username, password) {
	const base = server.replace(/\/+$/, '')
	let response
	try {
		response = await fetch(`${base}/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username, password }),
		})
	} catch (error) {
		return { ok: false, error: `无法连接服务器：${String(error?.message ?? error)}` }
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => '')
		return { ok: false, error: `登录失败 (${response.status}) ${detail.slice(0, 200)}` }
	}
	const cookies = typeof response.headers.getSetCookie === 'function'
		? response.headers.getSetCookie()
		: [response.headers.get('set-cookie') ?? '']
	const cookie = (cookies[0] ?? '').split(';')[0]

	let minted
	try {
		minted = await fetch(`${base}/client-auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ label: hostname() }),
		})
	} catch (error) {
		return { ok: false, error: `签发失败：${String(error?.message ?? error)}` }
	}
	const payload = await minted.json().catch(() => ({}))
	if (!minted.ok || typeof payload.token !== 'string') {
		return { ok: false, error: payload.error ?? `签发失败 (${minted.status})` }
	}
	enrollment = { server: base, token: payload.token, username: payload.username, label: hostname() }
	saveState()
	awaitingEnrollment = false
	console.log(`[executor] enrolled as ${enrollment.username}; connecting to ${base}`)
	connect(base, payload.token, hostname())
	return { ok: true, ...payload }
}

/** Call one authenticated endpoint with the enrolled executor token. */
async function callEnrolled(action, body) {
	if (!enrollment.token) return { ok: false, error: 'not enrolled yet' }
	try {
		const response = await fetch(`${enrollment.server}/client-auth/${action}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				authorization: `Bearer ${enrollment.token}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		const payload = await response.json().catch(() => ({}))
		return { status: response.status, ...payload }
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) }
	}
}

/** The page itself; a thin form over the JSON routes. */
function configPage() {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 本机执行器</title>
<style>
body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem}fieldset{border:1px solid #ddd;border-radius:6px;margin:0 0 1rem;padding:.8rem 1rem}
legend{font-weight:600;padding:0 .4rem}label{display:block;margin:.4rem 0 .1rem}
input,button{font:inherit;padding:.35rem .5rem}input{width:100%;box-sizing:border-box}
button{margin-top:.7rem;cursor:pointer}pre{background:#f6f6f6;padding:.6rem;border-radius:6px;overflow:auto;font-size:12px}
.err{color:#b00}.ok{color:#070}
</style></head><body>
<h1>DSH 本机执行器</h1>
<p>这台机器可以替服务器执行命令。先登录，服务器会签发一个只属于本机的凭据。</p>
<div id="msg"></div>
<fieldset><legend>1. 登录</legend>
<label>服务器地址</label><input id="server" placeholder="http://192.168.28.239:3080">
<label>账号</label><input id="username" autocomplete="username">
<label>密码</label><input id="password" type="password" autocomplete="current-password">
<button onclick="signIn()">登录</button>
</fieldset>
<fieldset><legend>2. 绑定工作区</legend>
<div id="workspaces">登录后显示可绑定的工作区。</div>
</fieldset>
<fieldset><legend>当前状态</legend><pre id="status">…</pre>
<button onclick="refresh()">刷新</button></fieldset>
<script>
const $ = (id) => document.getElementById(id);
function show(text, cls){ $('msg').innerHTML = '<p class="'+(cls||'')+'">'+text+'</p>'; }
async function api(path, body){
  const r = await fetch(path, body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return await r.json();
}
async function signIn(){
  show('登录中…');
  const r = await api('/login',{server:$('server').value,username:$('username').value,password:$('password').value});
  if(!r.ok){ show(r.error||'登录失败','err'); return; }
  show('已登录为 '+r.username,'ok'); renderWorkspaces(r.workspaces); refresh();
}
function renderWorkspaces(list){
  if(!Array.isArray(list)||list.length===0){ $('workspaces').textContent='这个账号没有可绑定的工作区。'; return; }
  $('workspaces').innerHTML = list.map((w)=>
    '<div style="margin:.4rem 0"><b>'+w.title+'</b><br><code>'+w.path+'</code><br>'+
    '<label>本机可见路径（UNC 或盘符）</label><input id="vp-'+w.id+'" value="">'+
    '<label>本机暂存目录</label><input id="sd-'+w.id+'" value="">'+
    '<button onclick="bind(\\''+w.id+'\\')">绑定</button></div>').join('');
}
async function bind(id){
  const r = await api('/bind',{workspaceId:id,visiblePath:$('vp-'+id).value,stagingDir:$('sd-'+id).value});
  show(r.ok?'绑定成功':(r.error||'绑定失败'), r.ok?'ok':'err'); refresh();
}
async function unbind(id){ await api('/unbind',{workspaceId:id}); refresh(); }
async function refresh(){ $('status').textContent = JSON.stringify(await api('/status'), null, 2); }
refresh();
</script></body></html>`
}

/** One bounded JSON body from the local page. */
async function readJson(req, limit = 64 * 1024) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) {
			req.destroy()
			return {}
		}
		chunks.push(chunk)
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		return {}
	}
}

/**
 * Serve the enrollment page on this machine's loopback.
 *
 * Bound to 127.0.0.1 only: the page handles a password, so nothing else on the
 * network may reach it.
 * @param port - Local port, or 0 for an OS-assigned one.
 * @returns the listening port.
 */
function startConfigServer(port) {
	configServer = createServer((req, res) => {
		const send = (status, body, type = 'application/json; charset=utf-8') => {
			const text = typeof body === 'string' ? body : JSON.stringify(body)
			res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) })
			res.end(text)
		}
		void (async () => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1')
			try {
				if (req.method === 'GET' && url.pathname === '/') return send(200, configPage(), 'text/html; charset=utf-8')
				if (req.method === 'GET' && url.pathname === '/status') {
					return send(200, {
						enrolled: enrollment.token.length > 0,
						awaitingEnrollment,
						server: enrollment.server,
						username: enrollment.username,
						label: enrollment.label,
						connected: !!enrollment.token && connectionsAlive(),
						hello: lastHello,
						statePath,
					})
				}
				if (req.method === 'POST' && url.pathname === '/login') {
					const body = await readJson(req)
					if (!body.server || !body.username || !body.password) {
						return send(400, { ok: false, error: '服务器地址、账号、密码都不能为空' })
					}
					return send(200, await signIn(String(body.server), String(body.username), String(body.password)))
				}
				if (req.method === 'POST' && url.pathname === '/bind') {
					const body = await readJson(req)
					const result = await callEnrolled('bind', {
						workspaceId: String(body.workspaceId ?? ''),
						visiblePath: String(body.visiblePath ?? ''),
						stagingDir: String(body.stagingDir ?? ''),
						machine: hostname(),
					})
					return send(result.ok ? 200 : 400, result)
				}
				if (req.method === 'POST' && url.pathname === '/unbind') {
					const body = await readJson(req)
					const result = await callEnrolled('unbind', { workspaceId: String(body.workspaceId ?? '') })
					return send(result.ok ? 200 : 400, result)
				}
				return send(404, { error: 'no such route' })
			} catch (error) {
				return send(500, { error: String(error?.message ?? error) })
			}
		})()
	})
	configServer.listen(port, '127.0.0.1', () => {
		const actual = configServer.address()?.port
		console.log(`[executor] configuration page: http://127.0.0.1:${actual}/`)
	})
	return configServer
}

/**
 * Load node-pty for interactive terminals.
 *
 * Terminal support is the one part of this executor that is not dependency-free:
 * a ConPTY needs a native module. `--node-pty` points at one explicitly, which is
 * how a machine whose layout differs from the server's finds it; otherwise the
 * plain name is tried, which is what `npm i node-pty` next to this file gives.
 * A machine without it still serves process spawns and reports the gap only when
 * an interactive terminal is actually requested.
 */
let nodePtyPromise
/** Explicit node-pty entry point from `--node-pty`, when the machine needs one. */
let nodePtyPath = ''

function loadNodePty() {
	nodePtyPromise ??= (async () => {
		// A Windows absolute path is not a valid ESM specifier; it has to be a URL.
		const specifier = nodePtyPath ? pathToFileURL(nodePtyPath).href : 'node-pty'
		const module = await import(specifier)
		// node-pty is CommonJS: the named exports Node detects vary by build, so
		// read through the interop default when the namespace itself has no spawn.
		const pty = typeof module.spawn === 'function' ? module : (module.default ?? module)
		if (typeof pty.spawn !== 'function') {
			throw new Error('the resolved node-pty module exposes no spawn()')
		}
		return pty
	})().catch((error) => {
		nodePtyPromise = undefined
		throw new Error(
			`node-pty is unavailable on this machine (${String(error?.message ?? error)});`
			+ ' interactive terminals need it, process spawns do not',
		)
	})
	return nodePtyPromise
}

/** Live children by server-side handle identity. */
const running = new Map()

/** Live ConPTY sessions by server-side handle identity. */
const terminals = new Map()

/** Live outbound HTTP requests by server-side request identity. */
const httpRequests = new Map()

/**
 * Headers that describe one hop rather than the message.
 *
 * Forwarding these breaks the second hop: `transfer-encoding` would have the
 * server re-chunk an already-chunked body, and a copied `connection` invites the
 * proxy to manage a socket it does not own.
 */
const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

/**
 * Filter one header bag down to end-to-end headers.
 * @param headers - Source headers.
 * @returns a fresh object holding only end-to-end entries.
 */
function endToEndHeaders(headers) {
	const out = {}
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
		out[name] = value
	}
	return out
}

/**
 * Forward one request to a service listening on THIS machine's loopback.
 *
 * The response is relayed as it arrives rather than collected first: an MCP
 * StreamableHTTP endpoint answers with a long-lived `text/event-stream`, so
 * buffering would hold every event until the stream closed, which is exactly the
 * case this relay exists to serve.
 */
function startHttpRequest(socket, request) {
	const requestId = String(request.requestId)
	const port = Number(request.port)
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		send(socket, { type: 'http.error', requestId, error: `invalid port ${String(request.port)}` })
		return
	}
	const path = typeof request.path === 'string' && request.path.startsWith('/') ? request.path : '/'
	let upstream
	try {
		upstream = httpRequest({
			host: '127.0.0.1',
			port,
			method: typeof request.method === 'string' ? request.method : 'GET',
			path,
			headers: endToEndHeaders(request.headers),
		})
	} catch (error) {
		send(socket, { type: 'http.error', requestId, error: String(error?.message ?? error) })
		return
	}
	httpRequests.set(requestId, upstream)
	console.log(`[executor] http -> 127.0.0.1:${port}${path} (${String(request.method ?? 'GET')})`)

	upstream.on('response', (response) => {
		send(socket, {
			type: 'http.response',
			requestId,
			status: response.statusCode ?? 502,
			statusText: response.statusMessage ?? '',
			headers: endToEndHeaders(response.headers),
		})
		response.on('data', (chunk) => {
			send(socket, { type: 'http.chunk', requestId, base64: chunk.toString('base64') })
		})
		response.on('end', () => {
			httpRequests.delete(requestId)
			send(socket, { type: 'http.end', requestId })
		})
		response.on('error', (error) => {
			httpRequests.delete(requestId)
			send(socket, { type: 'http.error', requestId, error: String(error?.message ?? error) })
		})
	})
	upstream.on('error', (error) => {
		httpRequests.delete(requestId)
		send(socket, { type: 'http.error', requestId, error: String(error?.message ?? error) })
	})
	if (typeof request.bodyBase64 === 'string' && request.bodyBase64.length > 0) {
		upstream.write(Buffer.from(request.bodyBase64, 'base64'))
	}
	upstream.end()
}

/**
 * Workspaces this machine currently holds, as the server told it.
 *
 * The server owns the decision (`bind.apply` follows an approved claim) and this
 * side only reports liveness, which is why a heartbeat carries no credentials:
 * the token already identifies the account, and the server re-checks that the
 * binding is still that account's.
 */
const held = new Map()

let heartbeatTimer

function sendHeartbeats(socket) {
	for (const workspaceId of held.keys()) {
		send(socket, { type: 'bind.heartbeat', workspaceId })
	}
}

/** Start the shared heartbeat clock once the first binding lands. */
function ensureHeartbeatClock(socket, intervalMs) {
	if (heartbeatTimer) return
	heartbeatTimer = setInterval(() => sendHeartbeats(socket), intervalMs)
	console.log(`[executor] heartbeating every ${intervalMs}ms`)
}

/** Stop holding one workspace: the server revoked or reassigned it. */
function dropBinding(workspaceId, reason) {
	if (!held.delete(workspaceId)) return
	console.log(`[executor] dropped binding ${workspaceId}: ${reason}`)
	if (held.size === 0 && heartbeatTimer) {
		clearInterval(heartbeatTimer)
		heartbeatTimer = undefined
	}
}

function startProcess(socket, request) {
	const procId = String(request.procId)
	// `argv` is a plain vector: the seam never shell-interprets it.
	const argv = Array.isArray(request.argv) ? request.argv.map(String) : []
	if (argv.length === 0 || argv[0] === '') {
		send(socket, { type: 'proc.error', procId, error: 'argv must contain a program' })
		return
	}
	const graceMs = Number.isInteger(request.graceMs) ? request.graceMs : 3000
	const env = childEnvironment(request.env)
	let program
	try {
		program = resolveProgram(argv[0], env)
	} catch (error) {
		console.log(`[executor] ${procId} unresolved program: ${String(error?.message ?? error)}`)
		send(socket, { type: 'proc.error', procId, error: String(error?.message ?? error) })
		return
	}
	if (program.via !== 'server-path-exists-here') {
		console.log(`[executor] ${procId} resolved ${argv[0]} -> ${program.path} (${program.via})`)
	}
	let child
	try {
		child = spawn(program.path, argv.slice(1), {
			cwd: typeof request.cwd === 'string' && request.cwd ? request.cwd : undefined,
			env,
			detached: platform() !== 'win32',
			windowsHide: true,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
	} catch (error) {
		send(socket, { type: 'proc.error', procId, error: `spawn failed: ${String(error?.message ?? error)}` })
		return
	}

	const entry = { child, procId, seq: 0, killTimer: undefined, forceTimer: undefined }
	running.set(procId, entry)

	child.on('spawn', () => {
		send(socket, { type: 'proc.started', procId, pid: child.pid, program: program.path, via: program.via })
	})
	child.on('error', (error) => {
		running.delete(procId)
		send(socket, { type: 'proc.error', procId, error: String(error?.message ?? error) })
	})
	for (const stream of ['stdout', 'stderr']) {
		child[stream]?.on('data', (chunk) => {
			entry.seq += 1
			send(socket, { type: 'proc.chunk', procId, stream, seq: entry.seq, text: chunk.toString('utf8') })
		})
	}
	child.on('close', (exitCode, signal) => {
		running.delete(procId)
		clearTimeout(entry.killTimer)
		clearTimeout(entry.forceTimer)
		send(socket, { type: 'proc.exit', procId, exitCode, signal: signal ?? null, graceMs })
	})
}

/** Ask one process to stop: terminate, then force-kill the tree after its grace. */
function closeProcess(procId) {
	const entry = running.get(procId)
	if (!entry) return
	killTree(procId, entry.child.pid, false)
	const graceMs = 3000
	entry.killTimer = setTimeout(() => { killTree(procId, entry.child.pid, true) }, graceMs)
}

/**
 * Allocate a ConPTY and start one owned process session.
 *
 * ConPTY has no process-group view, so this side reports no foreground group and
 * answers an interrupt by writing Ctrl-C into the terminal — which is how a
 * console delivers it to whatever currently owns the console. See the module
 * note for the observability limits this leaves.
 */
async function startTerminal(socket, request) {
	const procId = String(request.procId)
	const argv = Array.isArray(request.argv) ? request.argv.map(String) : []
	if (argv.length === 0 || argv[0] === '') {
		send(socket, { type: 'proc.error', procId, error: 'terminal argv must contain a program' })
		return
	}
	const env = childEnvironment(request.env)
	let program
	try {
		program = resolveProgram(argv[0], env)
	} catch (error) {
		send(socket, { type: 'proc.error', procId, error: String(error?.message ?? error) })
		return
	}
	let pty
	try {
		pty = await loadNodePty()
	} catch (error) {
		send(socket, { type: 'proc.error', procId, error: String(error?.message ?? error) })
		return
	}
	let term
	try {
		term = pty.spawn(program.path, argv.slice(1), {
			name: 'xterm-256color',
			cols: Number.isInteger(request.cols) ? request.cols : 80,
			rows: Number.isInteger(request.rows) ? request.rows : 24,
			cwd: typeof request.cwd === 'string' && request.cwd ? request.cwd : undefined,
			env,
		})
	} catch (error) {
		send(socket, { type: 'proc.error', procId, error: `terminal allocation failed: ${String(error?.message ?? error)}` })
		return
	}
	const entry = { term, procId, seq: 0 }
	terminals.set(procId, entry)
	send(socket, { type: 'proc.started', procId, pid: term.pid, program: program.path, via: program.via })
	term.onData((text) => {
		entry.seq += 1
		send(socket, { type: 'proc.chunk', procId, stream: 'stdout', seq: entry.seq, text })
	})
	term.onExit(({ exitCode, signal }) => {
		terminals.delete(procId)
		send(socket, { type: 'proc.exit', procId, exitCode: exitCode ?? null, signal: signal ?? null })
	})
}

/** End one terminal session, killing the whole tree so no helper survives it. */
function closeTerminal(procId, force) {
	const entry = terminals.get(procId)
	if (!entry) return
	try {
		entry.term.kill(force ? undefined : undefined)
	} catch (error) {
		console.error(`[executor] terminal kill failed for ${procId}: ${String(error?.message ?? error)}`)
	}
}

/**
 * Deliver one signal to a terminal's foreground work.
 *
 * Only SIGINT maps onto a console: writing Ctrl-C is exactly how a user
 * interrupts whatever owns the console. The rest have no ConPTY equivalent, and
 * the errors match what the local Windows provider answers.
 */
function signalTerminal(procId, signal) {
	const entry = terminals.get(procId)
	if (!entry) return { ok: false, error: 'terminal is not running' }
	if (signal === 'SIGINT') {
		entry.term.write('\x03')
		return { ok: true, processGroupId: entry.term.pid }
	}
	if (signal === 'SIGKILL') return { ok: false, error: 'refusing to SIGKILL; terminate the terminal session instead' }
	return { ok: false, error: `signal ${signal} is unsupported on Windows` }
}

function send(socket, message) {
	try {
		socket.send(JSON.stringify(message))
	} catch (error) {
		console.error('[executor] send failed:', String(error?.message ?? error))
	}
}

/**
 * Reconnect scheduling.
 *
 * Both `error` and `close` route here, because a handshake that never completed
 * does not reliably deliver `close`: relying on that event alone left the
 * process with an empty event loop and it exited silently, which for a program
 * whose whole job is to stay reachable is the worst failure mode. The single
 * pending timer is what keeps that loop alive while disconnected.
 */
let reconnectTimer
let reconnectAttempt = 0
/** The socket in use, so the status view can report liveness. */
let activeSocket = null

/** Whether the executor currently holds a live connection to its server. */
function connectionsAlive() {
	return activeSocket !== null && activeSocket.readyState === 1
}

function scheduleReconnect(server, token, label) {
	if (reconnectTimer) return
	reconnectAttempt += 1
	const delay = Math.min(1000 * reconnectAttempt, 15000)
	console.log(`[executor] disconnected — retrying in ${delay}ms (attempt ${reconnectAttempt})`)
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined
		connect(server, token, label)
	}, delay)
}

/**
 * The WebSocket URL for one server base URL.
 *
 * The config page collects — and the enrollment stores — an HTTP base, because
 * every other call this process makes (login, token exchange, bind) is HTTP.
 * Only the connection needs the WS scheme, and a `http://` string handed to
 * `new WebSocket()` fails the handshake instead of being upgraded.
 * @param server - An `http:`, `https:`, `ws:`, or `wss:` URL.
 * @returns the same URL with a WebSocket scheme.
 */
function socketUrl(server) {
	const base = String(server ?? '').trim().replace(/\/+$/, '')
	if (/^wss?:/i.test(base)) return base
	return base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
}

/**
 * The executor endpoint URL for one server spelling.
 *
 * Two spellings reach this function: `--server` on the command line normally
 * names the endpoint (`ws://host:port/executor`), while the config page collects
 * a plain base (`http://host:port`). Appending the path only when there is none
 * keeps both working — a base URL left without it resolves to the site root,
 * which has no upgrade route, and the handshake fails with a bare "non-101"
 * rather than anything naming the missing path.
 * @param server - Server base URL or endpoint URL, HTTP or WS scheme.
 * @returns the WebSocket URL of the executor endpoint.
 */
function executorEndpoint(server) {
	const socket = socketUrl(server)
	try {
		const url = new URL(socket)
		if (url.pathname === '' || url.pathname === '/') url.pathname = '/executor'
		return url.toString()
	} catch {
		return socket
	}
}

function connect(server, token, label) {
	const endpoint = executorEndpoint(server)
	const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
	const socket = new WebSocket(url)
	activeSocket = socket
	socket.addEventListener('open', () => {
		reconnectAttempt = 0
		console.log('[executor] connected to', server)
		lastHello = { version: VERSION, label, host: hostname(), platform: platform(), release: release() }
		send(socket, { type: 'hello', ...lastHello })
	})
	socket.addEventListener('message', (event) => {
		let message
		try { message = JSON.parse(String(event.data)) } catch { return }
		switch (message?.type) {
			case 'bind.apply': {
				const intervalMs = Number.isInteger(message.heartbeatMs) ? message.heartbeatMs : 15000
				held.set(String(message.workspaceId), { visiblePath: message.visiblePath, stagingDir: message.stagingDir })
				console.log(`[executor] holding ${message.workspaceId} at ${message.visiblePath}`)
				send(socket, { type: 'bind.heartbeat', workspaceId: String(message.workspaceId) })
				ensureHeartbeatClock(socket, intervalMs)
				break
			}
			case 'bind.drop':
				dropBinding(String(message.workspaceId), String(message.reason ?? 'server requested'))
				break
			case 'proc.spawn':
				startProcess(socket, message)
				break
			case 'proc.terminal':
				void startTerminal(socket, message)
				break
			case 'proc.stdin': {
				const procId = String(message.procId)
				const terminal = terminals.get(procId)
				if (terminal) terminal.term.write(String(message.data ?? ''))
				else running.get(procId)?.child.stdin?.write(String(message.data ?? ''))
				break
			}
			case 'proc.resize': {
				const terminal = terminals.get(String(message.procId))
				if (terminal && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
					try { terminal.term.resize(message.cols, message.rows) } catch { /* exited mid-resize */ }
				}
				break
			}
			case 'proc.signal': {
				const procId = String(message.procId)
				const result = signalTerminal(procId, String(message.signal))
				if (!result.ok) send(socket, { type: 'proc.error', procId, error: result.error })
				break
			}
			case 'proc.close':
				closeProcess(String(message.procId))
				closeTerminal(String(message.procId), message.force === true)
				break
			case 'http.request':
				startHttpRequest(socket, message)
				break
			case 'http.abort': {
				const requestId = String(message.requestId)
				const upstream = httpRequests.get(requestId)
				if (upstream) {
					httpRequests.delete(requestId)
					try { upstream.destroy() } catch { /* already settled */ }
				}
				break
			}
			default:
				break
		}
	})
	socket.addEventListener('close', () => {
		// Every child this connection owned is now unreachable; end them so no
		// orphan survives a disconnect (plan §4.6). Bindings go with it: the
		// server expires them on the heartbeat clock, and this side stops
		// claiming to hold what it can no longer serve.
		for (const [procId, entry] of running) killTree(procId, entry.child.pid, true)
		running.clear()
		for (const [procId, entry] of terminals) {
			try { entry.term.kill() } catch { /* already gone */ }
		}
		terminals.clear()
		for (const [requestId, upstream] of httpRequests) {
			try { upstream.destroy() } catch { /* already settled */ }
			void requestId
		}
		httpRequests.clear()
		held.clear()
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer)
			heartbeatTimer = undefined
		}
		console.log('[executor] disconnected')
		scheduleReconnect(server, token, label)
	})
	socket.addEventListener('error', (error) => {
		console.error('[executor] error:', String(error?.message ?? error))
		// A failed handshake may deliver only this event, so it schedules too.
		scheduleReconnect(server, token, label)
	})
}

const config = parseArgs(process.argv.slice(2))
nodePtyPath = config.nodePty
statePath = config.state || join(homedir(), '.dsh-executor', 'state.json')

if (config.token) {
	// Explicit enrollment on the command line: the shape the verification
	// harnesses use, and still the way to run without a browser.
	if (!config.server) {
		console.error('Usage: node executor.mjs --server <url> --token <token> [--label <name>] [--node-pty <path>]')
		process.exit(2)
	}
	enrollment = { server: config.server, token: config.token, username: '', label: config.label || hostname() }
	connect(config.server, config.token, enrollment.label)
} else {
	const saved = loadState()
	if (saved) {
		// A machine that has already enrolled reconnects on its own: nobody is
		// watching a service that starts at boot.
		enrollment = { ...saved, label: saved.label || hostname() }
		console.log(`[executor] resuming enrollment as ${saved.username || '(unknown)'} from ${statePath}`)
		connect(enrollment.server, enrollment.token, enrollment.label)
	} else {
		awaitingEnrollment = true
		console.log('[executor] not enrolled yet — open the configuration page to sign in')
	}

	// The page stays available after enrollment so a user can bind another
	// workspace, or see why nothing is connected. A taken port must not stop the
	// executor: the page is a convenience, the connection is the job.
	try {
		const server = startConfigServer(config.configPort)
		server.on('error', (error) => {
			console.error(`[executor] configuration page unavailable on port ${config.configPort}: ${String(error?.message ?? error)}`)
		})
	} catch (error) {
		console.error(`[executor] configuration page failed to start: ${String(error?.message ?? error)}`)
	}
}
