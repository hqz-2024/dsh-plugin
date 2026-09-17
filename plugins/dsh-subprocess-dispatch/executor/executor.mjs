/**
 * dsh-client-executor — the client half of plan-client-world P2.
 *
 * Runs on the machine a workspace is bound to. It dials OUT to the server's
 * `/executor` WebSocket endpoint with a per-account token, and executes process
 * spawns for that account only; it never listens on a port.
 *
 * Usage:
 *   node executor.mjs --server ws://<host>:3080/executor --token <token> [--label <name>]
 *                     [--smb-user <account> --smb-password <password>]
 *
 * `--smb-*` are optional unattended equivalents of the configuration page's
 * "工作区共享凭据" fields; without them the executor applies whatever the page
 * stored, and applies nothing at all when neither is set.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { homedir, hostname, platform, release } from 'node:os'
import { delimiter, dirname, basename, extname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { pathToFileURL } from 'node:url'

const VERSION = '0.3.0'

/**
 * The deployment this copy belongs to, or `''` when it was built without one.
 *
 * Injected by `build-executor-exe.mjs` from the profile's own (gitignore) configuration,
 * which is what makes the distributed executable double-click-ready: the machine knows
 * which server to join and presents the deployment's secret, so nobody types a URL or a
 * credential. The build script defines these as globals, so the references below are
 * replaced with literals and the values end up inside the executable.
 *
 * Read as global properties rather than as bare identifiers: a plain `node executor.mjs`
 * run has no build step, so a bare reference would be a ReferenceError at load, while a
 * missing global property is simply `undefined`. (Evaluating the name in a string, e.g.
 * through `new Function`, does not work either — that code runs in the global scope and
 * never sees a module-level definition, which silently produced empty values.)
 */
const DEPLOYMENT_SERVER = globalThis.DEPLOYMENT_SERVER ?? ''
const DEPLOYMENT_SECRET = globalThis.DEPLOYMENT_SECRET ?? ''

/**
 * How long a WebSocket handshake may stay unanswered before this side retries.
 *
 * This is a recovery mechanism, not just a backstop. The socket that stalls is
 * usually the one opened *during* the outage: the peer's TCP stack accepted it
 * while the handshake request was lost, so nothing will ever answer and only a
 * fresh attempt can succeed. The deadline therefore bounds how long a blip costs
 * after the link is usable again, which is why it is seconds rather than the tens
 * of seconds a conservative backstop would use — a LAN handshake completes in
 * tens of milliseconds, or a few hundred through the reverse proxy.
 */
const HANDSHAKE_MS = 5000
const DSH_ENV_PREFIX = 'DSH_'
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Reject credential-shaped and harness-owned names. */
function isScrubbed(name) {
	return SENSITIVE_ENV_PATTERN.test(name) || name.toUpperCase().startsWith(DSH_ENV_PREFIX)
}

const IS_WINDOWS = platform() === 'win32'

/**
 * Trust this deployment's own certificate authority.
 *
 * The server is reached through a reverse proxy holding a self-signed certificate, so a
 * client that trusts only the public roots fails the TLS handshake — and the WebSocket
 * library reports every such failure as the same opaque "Received network error or
 * non-101 status code", which says nothing about a certificate. For the script form of
 * the client the launcher set `NODE_EXTRA_CA_CERTS`; a downloaded executable has no
 * launcher, so the same fact has to be expressible as an argument.
 *
 * The bundled roots are kept and this certificate is appended: replacing them would make
 * the program trust less than a plain Node install does, which is the opposite of the
 * point.
 * @param certificate - PEM text of the authority to trust.
 * @returns whether it was added.
 */
function trustCertificate(certificate) {
	if (typeof certificate !== 'string' || !certificate.includes('BEGIN CERTIFICATE')) return false
	try {
		setDefaultCACertificates([...new Set([...getCACertificates('default'), certificate])])
		return true
	} catch (error) {
		console.error(`[executor] could not add the supplied certificate to the trust store: ${String(error?.message ?? error)}`)
		return false
	}
}

/** The certificate to trust: `--ca`, else `NODE_EXTRA_CA_CERTS`, else a known location. */
function loadTrustedCertificate(explicitPath) {
	const given = String(explicitPath ?? '').trim() || String(envValue(process.env, 'NODE_EXTRA_CA_CERTS') ?? '').trim()
	// A downloaded executable has no launcher to set an environment variable and no
	// default it could inherit, so the deployment's own certificate is looked for where
	// this client actually ships it: beside the program (the launcher writes it there)
	// and in the reverse proxy's own storage on a machine that runs both halves.
	const candidates = given !== '' ? [given] : [
		join(dirname(process.execPath), 'caddy-root.crt'),
		process.env.APPDATA ? join(process.env.APPDATA, 'Caddy', 'pki', 'authorities', 'local', 'root.crt') : '',
	].filter((candidate) => candidate !== '')
	if (candidates.length === 0) return { path: '', loaded: false }
	let lastPath = candidates[0]
	for (const path of candidates) {
		lastPath = path
		let pem
		try {
			pem = readFileSync(path, 'utf8')
		} catch {
			// Simply not there, which is the normal case for every candidate but one.
			continue
		}
		if (trustCertificate(pem)) return { path, loaded: true }
	}
	return { path: given === '' ? '' : lastPath, loaded: false }
}

/**
 * When the program this machine is running was built.
 *
 * Read from the running file's own modification time rather than from a version
 * constant, because the question the server has to answer is "is this machine running
 * the build I am currently handing out?" — and a version string only answers it when a
 * human remembers to bump one. A downloaded copy carries the time it was written, so
 * the two sides can be compared without either one publishing a new number.
 * @returns Epoch milliseconds, or null when the file's time cannot be read.
 */
function ownBuildTime() {
	// The two launch modes differ in which file *is* this program: packaged, it is the
	// executable; run as a script, `process.execPath` is the Node runtime, whose own
	// modification time would be reported as a build time that means nothing.
	const packaged = !/^node(\.exe)?$/i.test(basename(process.execPath))
	try {
		return statSync(packaged ? process.execPath : fileURLToPath(import.meta.url)).mtimeMs
	} catch {
		return null
	}
}

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
	const out = { server: '', token: '', secret: '', label: '', nodePty: '', configPort: 38460, state: '', ca: '' }
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i]
		else if (argv[i] === '--token' && argv[i + 1]) out.token = argv[++i]
		else if (argv[i] === '--secret' && argv[i + 1]) out.secret = argv[++i]
		else if (argv[i] === '--label' && argv[i + 1]) out.label = argv[++i]
		else if (argv[i] === '--node-pty' && argv[i + 1]) out.nodePty = argv[++i]
		else if (argv[i] === '--config-port' && argv[i + 1]) out.configPort = Number(argv[++i])
		else if (argv[i] === '--state' && argv[i + 1]) out.state = argv[++i]
		else if (argv[i] === '--smb-user' && argv[i + 1]) out.smbUser = argv[++i]
		else if (argv[i] === '--smb-password' && argv[i + 1]) out.smbPassword = argv[++i]
		else if (argv[i] === '--self-test') out.selfTest = true
		else if (argv[i] === '--no-open') out.noOpen = true
		else if (argv[i] === '--ca' && argv[i + 1]) out.ca = argv[++i]
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
let enrollment = { server: '', token: '', secret: '', username: '', label: '', smb: { username: '', password: '' } }
/** This computer's stable identity, created on first run. */
let machineId = ''
/** The most recent answer from `hello`, for the status view. */
let lastHello = null
/** Set when the config page is what started this process, so `/status` can say so. */
let awaitingEnrollment = false
/** The local config server, once started. */
let configServer = null

/**
 * This computer's stable name, kept beside the state rather than inside it.
 *
 * A machine is addressed by this id: bindings name it, and the server routes to it. It
 * survives re-enrollment on purpose — pointing the program at a different server must
 * not turn this computer into a stranger, and an id regenerated on every start would
 * make the binding store accumulate entries for machines that are all this one.
 * @returns The persisted id, creating it on first use.
 */
function loadMachineId() {
	const path = join(dirname(statePath), 'machine-id')
	try {
		const existing = readFileSync(path, 'utf8').trim()
		if (/^[a-z0-9-]{8,}$/i.test(existing)) return existing
	} catch {
		// First run, or the file was removed: create one below.
	}
	const created = `${hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${randomUUID().slice(0, 8)}`
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, `${created}\n`, { mode: 0o600 })
	} catch (error) {
		console.error(`[executor] could not persist a machine id to ${path}: ${String(error?.message ?? error)}`)
	}
	return created
}

function loadState() {
	try {
		const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
		// A machine enrolled with the deployment secret has no account and no issued
		// token, so a server is all that is required to reconnect.
		if (typeof parsed?.server === 'string' && (typeof parsed?.token === 'string' || typeof parsed?.secret === 'string')) return parsed
		return undefined
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
 * What is sitting in a staging directory, i.e. copies an earlier task did not
 * write back (plan §2.6: "上次未回写的残留要在下次绑定时提示用户").
 *
 * Only this side can answer that: the staging directory is on the user's machine,
 * and the agent only notices leftovers when it happens to start a task that uses
 * staging. A user binding a machine in the morning would never be told. This is
 * reported, never deleted — the files are the user's, and the skill's rule is to
 * ask before touching them.
 *
 * @param dir - The staging directory a binding named.
 * @returns Up to 20 top-level entries, or an empty list when there is nothing to report.
 */
function stagingLeftovers(dir) {
	if (typeof dir !== 'string' || dir.length === 0) return []
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		// A staging directory that does not exist yet is the normal state before the
		// first checkout, and a permission error is not worth failing a bind over.
		return []
	}
	return entries.slice(0, 20).map((entry) => {
		const full = join(dir, entry.name)
		let size
		let modifiedAt
		try {
			const stats = statSync(full)
			size = stats.size
			modifiedAt = stats.mtime.toISOString()
		} catch {
			// The entry vanished between listing and stat; report it without facts.
		}
		return { name: entry.name, directory: entry.isDirectory(), size, modifiedAt }
	})
}

/**
 * The server host a UNC path names, or `undefined` when the path is not UNC.
 * @param visiblePath - The path this machine sees for a bound workspace.
 * @returns The host portion of `\\host\share\...`.
 */
function uncHost(visiblePath) {
	const match = /^\\\\([^\\/]+)/.exec(String(visiblePath ?? ''))
	return match ? match[1] : undefined
}

/**
 * Make a workspace share reachable by storing this account's SMB credential.
 *
 * Plan §2.0 puts "绑定工作区（SMB 凭据）" in the executor's own job, and §2.2
 * names `net use` and `cmdkey` as the ways to do it. `cmdkey` is used because it
 * persists in the user's credential store, so a machine that starts at boot can
 * still reach the share with nobody signed in to the page.
 *
 * Two details are load-bearing. `cmdkey` reports some failures on stdout while
 * still exiting 0, so the outcome is decided by a follow-up `/list` rather than by
 * the exit status or by matching localized success text. And the password has to
 * appear in `cmdkey`'s argv — the command offers no stdin form — so it is visible
 * in the process list for the moment that process lives.
 *
 * @param host - Server host holding the share.
 * @returns a short outcome for the log, or `undefined` when nothing is configured.
 */
function applySmbCredential(host) {
	const smb = enrollment.smb
	if (!host || !smb?.username || !smb?.password) return undefined
	if (platform() !== 'win32') {
		console.log(`[executor] SMB credential not applied on ${platform()}; make \\\\${host} reachable yourself`)
		return 'unsupported-platform'
	}
	const run = (args) => new Promise((resolve) => {
		const child = spawn('cmdkey', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
		child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8') })
		child.on('error', () => resolve({ code: -1, out }))
		child.on('close', (code) => resolve({ code, out }))
	})
	return (async () => {
		await run(['/add:' + host, '/user:' + smb.username, '/pass:' + smb.password])
		// Verification is separate on purpose: a rejected credential still exits 0.
		const listed = await run(['/list:' + host])
		const stored = listed.out.includes(smb.username)
		console.log(`[executor] SMB credential for ${host} as ${smb.username}: ${stored ? 'stored' : 'NOT stored'}`)
		return stored ? 'stored' : 'refused'
	})()
}

/**
 * Explain a failed spawn in terms of the thing that is actually wrong.
 *
 * Node reports a missing program and an unreachable working directory with the very
 * same message — `spawn <program> ENOENT` — and the program is the only name in it.
 * On a bound machine the working directory is usually a network share, so the
 * obvious reading ("that program is not installed here") is exactly the wrong one
 * when the share is offline or its credential has lapsed. Left as it is, the agent
 * goes hunting for a missing program while every command keeps failing for a reason
 * neither it nor the user can see. Measured: a binding whose share does not exist
 * produced `spawn C:\nvm4w\nodejs\node.exe ENOENT` for every spawn.
 *
 * The program's own resolution happens before the spawn (`resolveProgram`) and
 * reports its own, accurate error, so an ENOENT arriving here points at the working
 * directory first.
 * @param error - The `error` event from the child process.
 * @param cwd - The working directory that child was given.
 * @returns A message naming the cause, keeping the original text for detail.
 */
function describeSpawnFailure(error, cwd) {
	const message = String(error?.message ?? error)
	if (error?.code !== 'ENOENT' || typeof cwd !== 'string' || cwd.length === 0) return message
	let reachable = true
	try {
		reachable = existsSync(cwd)
	} catch {
		// An unreadable path is not a usable working directory either.
		reachable = false
	}
	if (reachable) return message
	return `${message} — the working directory ${cwd} is not reachable from this machine`
		+ ' (a network share may be offline, or its credential may have lapsed;'
		+ ' re-save the share credential in this machine\'s executor page)'
}

/**
 * Turn a failed request into something the user can act on.
 *
 * The supported LAN topology reaches the server through a reverse proxy with a
 * self-signed certificate, so the first thing a new machine hits is a trust
 * error whose text names nothing fixable. Node does not read the Windows
 * certificate store, so trusting the certificate in a browser changes nothing
 * here — the remedy has to be said out loud, and this is the page the user is
 * looking at when it fails.
 * @param error - The rejection from `fetch`.
 * @returns A message for the configuration page.
 */
function explainRequestFailure(error) {
	const text = String(error?.cause?.message ?? error?.message ?? error)
	if (/self.signed|unable to (get|verify)|certificate/i.test(text)) {
		return `无法验证服务器证书（${text}）。Node 不读 Windows 证书库，在浏览器里信任过也没用：`
			+ '把服务器上 caddy 的根证书 %APPDATA%\\Caddy\\pki\\authorities\\local\\root.crt 复制到本机，'
			+ '然后在启动执行器前设置环境变量 NODE_EXTRA_CA_CERTS 指向那个文件（例如 '
			+ '`$env:NODE_EXTRA_CA_CERTS="$env:USERPROFILE\\caddy-root.crt"`）。'
	}
	return `无法连接服务器：${text}`
}

/**
 * Sign in and exchange the session for an executor token (plan §2.5 steps 2-3).
 *
 * The server issues the token; this side only carries the cookie between the two
 * calls. Returning the workspace list is what lets the page offer a choice
 * instead of asking the user to type a workspace id.
 * @param server - Base or endpoint URL of the DSH server, HTTP or WS scheme.
 * @param username - Account to sign in as.
 * @param password - Account password.
 * @returns `{ ok: true, token, username, workspaces, heartbeatMs }` or `{ ok: false, error }`.
 */
async function signIn(server, username, password) {
	const base = httpBase(server)
	let response
	try {
		response = await fetch(`${base}/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username, password }),
		})
	} catch (error) {
		return { ok: false, error: explainRequestFailure(error) }
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
/**
 * The HTTP base URL for one server spelling.
 *
 * `--server` on the command line normally names the executor endpoint
 * (`ws://host:port/executor`) and the saved enrollment keeps whatever it was
 * given, while every other call this process makes is plain HTTP mounted at the
 * root. Converting here rather than at each call site is what makes both
 * spellings work end to end: with only the connection normalizing, a page opened
 * from endpoint-spelled enrollment answered `/status` and then failed every bind
 * with a bare "fetch failed", because `fetch` refuses a `ws:` URL.
 * @param server - An `http:`, `https:`, `ws:`, or `wss:` URL, with or without the endpoint path.
 * @returns the base URL that `/auth/login` and `/client-auth/...` append to.
 */
function httpBase(server) {
	const base = String(server ?? '').trim().replace(/\/+$/, '')
	return base
		.replace(/^wss:/i, 'https:')
		.replace(/^ws:/i, 'http:')
		.replace(/\/executor$/, '')
}

/**
 * Whether this machine has been pointed at a server.
 *
 * Two credentials are possible and either one is enough: the deployment secret (the
 * intended shape, which involves no account) or a per-account token issued to an older
 * enrollment.
 * @returns true when a connection can be attempted.
 */
function isEnrolled() {
	return enrollment.secret !== '' || enrollment.token !== ''
}

/**
 * Per-account calls this program can still make.
 *
 * The executor's own token-authenticated calls — the ones that ask the server which
 * workspaces an *account* may bind — only exist for a token enrollment. A machine that
 * announced itself with the deployment secret has no account and no business asking, so
 * `webEntryUrl` simply falls back to the server address.
 */
async function callEnrolled(action, body) {
	if (enrollment.token === '') return { ok: false, error: 'this machine has no account token' }
	try {
		const response = await fetch(`${httpBase(enrollment.server)}/client-auth/${action}`, {
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
		return { ok: false, error: explainRequestFailure(error) }
	}
}

/**
 * The URL that gets a browser into the Web UI, or the plain server address.
 *
 * The shell serves its index only to a browser holding the server process's launch
 * token, so opening the bare address lands on "dsh web authentication required; reopen
 * the URL printed by dsh web" — which is exactly what a person sees if this page hands
 * them the address it was enrolled with. The server knows how to mint that entry and
 * says so through `/client-auth/web-entry`; the plain address stays as the fallback for
 * a deployment that does not answer, since a browser with an existing cookie works there
 * and a wrong-looking button is worse than a plain one.
 * @returns A URL to open, or `''` when this machine is not enrolled.
 */
let webEntryResolved = false

async function webEntryUrl() {
	webEntryResolved = false
	if (!isEnrolled()) return ''
	// Bounded, because the status page asks for this on every refresh: an unreachable
	// server must leave the page responsive with the plain address rather than hanging
	// the whole panel on a fetch that will never answer.
	const answer = await Promise.race([
		callEnrolled('web-entry', {}),
		new Promise((resolve) => { const timer = setTimeout(() => resolve(undefined), 5000); if (typeof timer.unref === 'function') timer.unref() }),
	])
	if (answer?.ok === true && typeof answer.url === 'string' && answer.url !== '') {
		webEntryResolved = true
		return answer.url
	}
	if (answer?.error) console.error(`[executor] could not resolve a browser entry URL: ${String(answer.error)}`)
	return httpBase(enrollment.server)
}

/**
 * Escape one value for an HTML attribute in the generated page.
 *
 * The page is built by string concatenation, so a path with `&` or a quote would
 * otherwise end the attribute and corrupt everything after it.
 * @param value - Raw text, or anything falsy for an empty attribute.
 * @returns Text safe to place inside double quotes.
 */
function attr(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/** The page itself; a thin form over the JSON routes. */
function configPage() {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 客户端执行器</title>
<style>
body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem;margin:0 0 .2rem}.sub{color:#666;margin:0 0 1.2rem}
fieldset{border:1px solid #ddd;border-radius:6px;margin:0 0 1rem;padding:.8rem 1rem}
legend{font-weight:600;padding:0 .4rem}label{display:block;margin:.4rem 0 .1rem}
input,button{font:inherit;padding:.35rem .5rem}input{width:100%;box-sizing:border-box}
button{margin-top:.7rem;cursor:pointer}
button.primary{background:#1f6feb;color:#fff;border:1px solid #1a5fd0;border-radius:6px;padding:.5rem 1rem;font-weight:600}
button.primary:disabled{background:#bbb;border-color:#aaa;cursor:default}
pre{background:#f6f6f6;padding:.6rem;border-radius:6px;overflow:auto;font-size:12px}
.err{color:#b00}.ok{color:#070}.muted{color:#666;font-size:13px}
.state{display:flex;align-items:center;gap:.5rem;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:#bbb;display:inline-block}
.dot.on{background:#1a7f37}.dot.off{background:#b00}
details{margin:.4rem 0}summary{cursor:pointer;color:#444}
</style></head><body>
<h1>DSH 本机执行器</h1>
<p class="sub">这台电脑已经交给 agent 使用：哪个工作区在它上面执行，由 Web UI 决定。这个页面只报告状态，不需要在这里配置任何东西。</p>
<div id="msg"></div>

<fieldset><legend>状态</legend>
<div class="state"><span id="dot" class="dot"></span><span id="stateText">读取中…</span></div>
<p class="muted" id="stateDetail"></p>
<p class="muted" id="identity"></p>
<button class="primary" id="openWeb" onclick="openWeb()" disabled>打开 Web UI</button>
<p class="muted" id="webHint"></p>
</fieldset>

<fieldset><legend>工作区共享凭据</legend>
<p class="muted">工作区文件在服务器上，本机通过共享访问它。填一次共享账号与密码，执行器会在工作区绑到本机时把它存进本机凭据库，之后 \\\\服务器\\共享 就像本地盘一样可用。<strong>只在本机保存，不会发往服务器。</strong></p>
<label>共享账号</label><input id="smbuser" autocomplete="username">
<label>共享密码</label><input id="smbpass" type="password" autocomplete="current-password">
<button onclick="saveSmb()">保存并应用</button>
</fieldset>

<fieldset><legend>诊断</legend>
<pre id="status">…</pre>
<button onclick="refresh()">刷新</button></fieldset>
<script>
const $ = (id) => document.getElementById(id);
// Interpolated so the page shows the directory this machine will actually use.
const DEFAULT_STAGING = ${JSON.stringify(defaultStagingDir())};
// Escapes a value for an HTML attribute. This is the PAGE's own copy: the server has a
// function of the same purpose, and calling that one from here is a runtime
// ReferenceError that a syntax check cannot see (it shipped once). No backticks in this
// script: they would end the template literal that generates the page.
function esc(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function show(text, cls){ $('msg').innerHTML = '<p class="'+(cls||'')+'">'+text+'</p>'; }
async function api(path, body){
  const r = await fetch(path, body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return await r.json();
}
async function saveSmb(){
  show('保存中…');
  const r = await api('/smb',{username:$('smbuser').value,password:$('smbpass').value});
  if(!r.ok){ show(r.error||'保存失败','err'); return; }
  const hosts = Object.keys(r.applied||{});
  const detail = hosts.length ? hosts.map((h)=>h+'：'+(r.applied[h]||'未配置')).join('；') : '还没有工作区绑到本机，绑定时会自动应用';
  show('已保存。'+detail,'ok'); refresh();
}
// The address is the one this machine enrolled against, so nobody types it twice.
async function openWeb(){
  const s = await api('/status');
  if(!s || !s.webUrl){ show('这台机器还没有连上服务器','err'); return; }
  window.open(s.webUrl, '_blank');
}
async function refresh(){
  const s = await api('/status');
  $('status').textContent = JSON.stringify(s, null, 2);
  const on = !!s.connected;
  $('dot').className = 'dot ' + (on ? 'on' : 'off');
  $('stateText').textContent = on ? '已连接服务器' : (s.enrolled ? '未连接 —— 正在重试' : '尚未配置');
  // Deliberately says nothing about which workspaces this machine holds: the page is
  // served to whoever can reach this computer's loopback, and that list is not theirs
  // to read. The count is enough to answer "is it doing anything".
  const heldCount = (s.heldShares||[]).length;
  $('stateDetail').textContent = on
    ? (heldCount > 0 ? ('正在为 '+heldCount+' 个工作区提供本地执行') : '已连接。还没有工作区绑到本机 —— 在 Web UI 的文件树里绑定。')
    : '连不上服务器时，命令不会静默改到服务器上执行，而是明确报错。';
  $('identity').textContent = '本机标识：' + (s.machineId || '(未生成)') + '（服务器用它把工作区绑到这台电脑）';
  $('openWeb').disabled = !s.webUrl;
  // The button carries a long one-shot URL (it includes the shell's launch token), so the
  // hint shows the plain server origin a person recognises instead of that whole string.
  let origin = s.webUrl || '';
  try { origin = new URL(s.webUrl).origin; } catch (e) { /* keep whatever it was */ }
  $('webHint').textContent = s.webUrl ? ('将在浏览器打开：' + origin) : '这台机器还没有连上服务器。';
}
refresh();
setInterval(refresh, 5000);
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
 * Where large files are checked out to when the user does not name a directory.
 *
 * The staging directory is load-bearing rather than optional: the system prompt
 * tells the agent to stage big files and names the directory to use, and it can
 * only do that when the binding carries one. A blank field therefore must not
 * mean "no staging" — it means "use the default", and this is the side that knows
 * the user's own filesystem. `%USERPROFILE%` is the right base: it is the user's
 * own space, on their own disk, and it survives the workspace being unbound.
 * @returns The default staging directory on this machine.
 */
function defaultStagingDir() {
	return join(homedir(), '.dsh-staging')
}

/**
 * Expand `%NAME%` references in one path.
 *
 * The server names the client's default staging directory as `%USERPROFILE%\.dsh-staging`
 * because it cannot read another machine's profile; expanding it here is what makes the
 * stored value and the directory this machine actually uses the same path. An unknown
 * name is left as written, so a path that genuinely contains percent signs survives.
 * @param value - Raw path text.
 * @returns The path with every known variable replaced.
 */
function expandEnvVars(value) {
	return value.replace(/%([^%]+)%/g, (whole, name) => envValue(process.env, name) ?? whole)
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
					// Deliberately no paths and no per-workspace detail. This endpoint answers
					// on this computer's loopback, which is shared with every process and every
					// user session on it, so it reports what the machine is doing and nothing
					// about where anything lives. "Which workspaces does this machine hold" is
					// answered by the server, to whoever is signed in there.
					return send(200, {
						enrolled: isEnrolled(),
						awaitingEnrollment,
						server: httpBase(enrollment.server),
						machineId,
						label: enrollment.label,
						connected: isEnrolled() && connectionsAlive(),
						hello: lastHello,
						// The password is never echoed back, only whether one is set.
						smb: {
							configured: !!enrollment.smb?.username && !!enrollment.smb?.password,
							username: enrollment.smb?.username ?? '',
						},
						heldWorkspaces: held.size,
						// The page's "open the web UI" action needs a URL that gets a browser
						// *in*, not just the server address: the shell refuses to serve its own
						// index without the process launch token. Resolved per request, because
						// that token belongs to one server process and a cached one goes stale
						// the moment the server restarts.
						webUrl: await webEntryUrl(),
						// Whether that URL carries the shell's launch token. The page says so
						// outright, because the difference is invisible in the address itself and
						// otherwise shows up only as a refusal in the browser.
						webEntryResolved,
					})
				}
				// `/workspaces`, `/login`, `/bind` and `/unbind` are gone with the picker they
				// served. Binding is decided in the Web UI, where the person is already signed
				// in and the server can check what they are allowed to use; a machine that
				// could bind on its own would be deciding something it cannot authorize.
				if (req.method === 'POST' && url.pathname === '/smb') {
					const body = await readJson(req)
					enrollment.smb = { username: String(body.username ?? ''), password: String(body.password ?? '') }
					saveState()
					// Apply to every share already held, so a corrected password takes
					// effect without the user unbinding and binding again.
					const hosts = [...new Set([...held.values()].map((entry) => uncHost(entry.visiblePath)).filter(Boolean))]
					const applied = {}
					for (const host of hosts) applied[host] = await applySmbCredential(host)
					return send(200, { ok: true, applied, hosts })
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
 * The base `createRequire` needs to resolve modules for this program.
 *
 * The two launch modes disagree about what is available, and only one of them works
 * in each: a plain `.mjs` file has `import.meta.url`; a bundled single executable runs
 * the entry as CommonJS, where that is undefined and `__filename` holds the real path
 * of the executable instead. Reading the wrong one raises "The argument 'filename'
 * must be a file URL object, file URL string, or absolute path string. Received
 * undefined" — and it does so even when `--node-pty` names an exact path, because
 * building the `require` fails before the path is ever used.
 *
 * This module is ESM, so Node defines `import.meta` everywhere it can run. The
 * `globalThis` member is what a bundle that renames the object leaves behind: esbuild
 * emits `var import_meta = {}` for CommonJS, so the member is absent and the path of a
 * program sitting next to node-pty is the useful fallback.
 * @returns A file URL string to resolve modules from.
 */
function resolveRequireBase() {
	const url = import.meta?.url
	if (typeof url === 'string' && url) return url
	// A packaged program is a file, so its own location is the right base for a
	// node-pty installed beside it.
	return pathToFileURL(join(dirname(process.execPath), 'executor.cjs')).href
}

/**
 * Load node-pty for interactive terminals.
 *
 * Terminal support is the one part of this executor that is not dependency-free:
 * a ConPTY needs a native module. `--node-pty` points at one explicitly, which is
 * how a machine whose layout differs from the server's finds it; otherwise the
 * plain name is tried, which is what `npm i node-pty` next to this file gives, and
 * failing that a copy unpacked beside the program (see `siblingNodePty`).
 * A machine without it still serves process spawns and reports the gap only when
 * an interactive terminal is actually requested.
 */
let nodePtyPromise
/** Explicit node-pty entry point from `--node-pty`, when the machine needs one. */
let nodePtyPath = ''

function loadNodePty() {
	nodePtyPromise ??= (async () => {
		// Loaded with `require`, not dynamic `import`, so this program can also run as a
		// single executable (Node SEA): a packaged binary resolves builtins fine but
		// refuses to dynamically import a file from disk, and node-pty is exactly that —
		// a native addon next to the program. `createRequire` accepts both a bare package
		// name and a Windows absolute path, which the old URL dance was working around.
		const requireFromHere = createRequire(resolveRequireBase())
		const module = requireFromHere(nodePtyPath || 'node-pty')
		// node-pty is CommonJS: the named exports Node detects vary by build, so read
		// through the interop default when the namespace itself has no spawn.
		const pty = module && typeof module.spawn === 'function' ? module : (module?.default ?? module)
		if (typeof pty?.spawn !== 'function') {
			throw new Error('the resolved node-pty module exposes no spawn()')
		}
		return pty
	})().catch(async (error) => {
		nodePtyPromise = undefined
		// A packaged copy cannot `require('node-pty')` by name: nothing is installed
		// next to a downloaded executable, and the client has no npm. The distribution
		// therefore unpacks node-pty in a folder beside the program, which is found
		// here — the whole reason a client can install this by unzipping one archive.
		const beside = nodePtyPath ? undefined : siblingNodePty()
		if (beside !== undefined) return loadFrom(beside)
		throw new Error(
			`node-pty is unavailable on this machine (${String(error?.message ?? error)});`
			+ ' interactive terminals need it, process spawns do not',
		)
	})
	return nodePtyPromise
}

/**
 * node-pty unpacked next to this program, as the client distribution ships it.
 *
 * Two layouts are accepted because both are what a person produces by hand: the
 * package directory itself, or the `node_modules/node-pty` an `npm i` would leave.
 * @returns Path to a loadable entry point, or undefined when the file is absent.
 */
function siblingNodePty() {
	const here = dirname(process.execPath)
	for (const candidate of [
		join(here, 'node-pty', 'lib', 'index.js'),
		join(here, 'node_modules', 'node-pty', 'lib', 'index.js'),
	]) {
		if (existsSync(candidate)) return candidate
	}
	return undefined
}

/** Require one explicit node-pty entry point and check it can spawn. */
function loadFrom(entry) {
	const loaded = createRequire(resolveRequireBase())(entry)
	const module = loaded && typeof loaded.spawn === 'function' ? loaded : (loaded?.default ?? loaded)
	if (typeof module?.spawn !== 'function') {
		throw new Error(`the node-pty at ${entry} exposes no spawn()`)
	}
	return module
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

/**
 * When the server last said anything on the current connection, and how long it
 * may stay quiet before this side gives up.
 *
 * A link that stops delivering — cable pulled, Wi-Fi dropped, VPN renegotiating
 * — sends no FIN and no RST, so `close` never fires and an open socket proves
 * nothing. The only liveness signal that survives that is message-level: the
 * server pings, and this side treats a gap longer than the budget it was told
 * as a dead link. The budget comes from the server (`ping.silenceMs`), which
 * derives it from its own binding grace, so the machine that would otherwise
 * keep a workspace it no longer owns stops first.
 */
let lastContactAt = 0
let silenceBudgetMs = 30000
let silenceTimer

/**
 * End everything the current connection owned.
 *
 * Two paths reach here: the socket closed, or the server stopped answering.
 * Plan §4.6 — every process this connection owned is unreachable once the link
 * is gone, so no orphan may outlive it. Bindings go too: this machine must stop
 * claiming to hold what it can no longer serve, because the server may already
 * have handed that workspace to another machine, and two writers on one share
 * is the failure the whole client world exists to avoid.
 */
function teardownConnection() {
	for (const [procId, entry] of running) killTree(procId, entry.child.pid, true)
	running.clear()
	for (const [, entry] of terminals) {
		try { entry.term.kill() } catch { /* already gone */ }
	}
	terminals.clear()
	for (const upstream of httpRequests.values()) {
		try { upstream.destroy() } catch { /* already settled */ }
	}
	httpRequests.clear()
	held.clear()
	if (heartbeatTimer) clearInterval(heartbeatTimer)
	heartbeatTimer = undefined
	if (silenceTimer) clearInterval(silenceTimer)
	silenceTimer = undefined
}

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
	// stdin disposition mirrors the engine's own local provider
	// (`subprocess-local/src/spawn.ts:380`): only `'ignore'` becomes `'ignore'`,
	// everything else is a pipe. Spawning `'pipe'` unconditionally was wrong twice
	// over -- it dropped the `{ data }` payload and left every EOF-reading child
	// waiting forever. A shape that is neither `'pipe'` nor a payload is treated as
	// `'ignore'`: this is a wire boundary, and a definite EOF is a far better
	// failure mode than a hang.
	const stdinSpec = request.stdin
	const stdinIsPipe = stdinSpec === 'pipe'
	const stdinPayload = stdinSpec !== null && typeof stdinSpec === 'object' && typeof stdinSpec.data === 'string'
		? stdinSpec.data
		: undefined
	/** `'pipe'` only for the two shapes that need a writable stdin; everything else gets an EOF. */
	const stdinDisposition = stdinIsPipe || stdinPayload !== undefined ? 'pipe' : 'ignore'
	try {
		child = spawn(program.path, argv.slice(1), {
			cwd: typeof request.cwd === 'string' && request.cwd ? request.cwd : undefined,
			env,
			detached: platform() !== 'win32',
			windowsHide: true,
			shell: false,
			stdio: [stdinDisposition, 'pipe', 'pipe'],
		})
	} catch (error) {
		send(socket, { type: 'proc.error', procId, error: `spawn failed: ${String(error?.message ?? error)}` })
		return
	}
	if (stdinPayload !== undefined && child.stdin) {
		// Batch stdin is written and closed up front. The error handler matters: an
		// EPIPE from a child that already exited arrives as an 'error' EVENT, which a
		// try/catch cannot catch and which would otherwise take the executor down.
		child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
		child.stdin.end(stdinPayload)
	}

	const entry = { child, procId, seq: 0, killTimer: undefined, forceTimer: undefined }
	running.set(procId, entry)

	child.on('spawn', () => {
		send(socket, { type: 'proc.started', procId, pid: child.pid, program: program.path, via: program.via })
	})
	child.on('error', (error) => {
		running.delete(procId)
		send(socket, { type: 'proc.error', procId, error: describeSpawnFailure(error, request.cwd) })
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

function scheduleReconnect(server, credential, label) {
	if (reconnectTimer) return
	reconnectAttempt += 1
	const delay = Math.min(1000 * reconnectAttempt, 15000)
	console.log(`[executor] disconnected — retrying in ${delay}ms (attempt ${reconnectAttempt})`)
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined
		connect(server, credential, label)
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

/**
 * Credential this process presents on the endpoint.
 *
 * A machine that knows the deployment secret sends that; a machine enrolled the older
 * way sends the per-account token it was issued. Only one is ever present, and the
 * server accepts either, so this single accessor is the whole of the difference.
 * @returns The credential string.
 */
function presentedCredential() {
	return enrollment.secret || enrollment.token || ''
}

function connect(server, credential, label) {
	const endpoint = executorEndpoint(server)
	const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(credential)
	const socket = new WebSocket(url)
	activeSocket = socket

	/**
	 * Sever this link and reconnect, without waiting for a `close` that a silent
	 * link never delivers. Everything it owned stops first, so nothing this
	 * machine was running outlives its connection to the server.
	 */
	const abandon = (reason) => {
		if (activeSocket !== socket) return
		activeSocket = null
		clearTimeout(handshakeTimer)
		teardownConnection()
		console.log(`[executor] ${reason}`)
		try { socket.close() } catch { /* already closing */ }
		scheduleReconnect(server, credential, label)
	}

	/**
	 * A handshake the peer accepts but never answers — a proxy holding the
	 * connection open, a captive portal, a NAT that swallows the upgrade —
	 * delivers neither `open` nor `error`, so the retry loop would stall on a
	 * socket that is neither working nor failing, and nothing would be logged.
	 * The platform does eventually give up, but the bound is its own and opaque;
	 * this deadline is one this program states.
	 */
	const handshakeTimer = setTimeout(() => {
		if (activeSocket !== socket || socket.readyState === 1) return
		abandon(`handshake with ${server} did not complete within ${HANDSHAKE_MS}ms`)
	}, HANDSHAKE_MS)

	socket.addEventListener('open', () => {
		if (activeSocket !== socket) {
			// A socket this side already gave up on must not register itself: the
			// server treats a new connection as this account's current one and
			// would retire the link that is actually working.
			try { socket.close() } catch { /* already closing */ }
			return
		}
		clearTimeout(handshakeTimer)
		reconnectAttempt = 0
		lastContactAt = Date.now()
		console.log('[executor] connected to', server)
		lastHello = {
			version: VERSION,
			build: ownBuildTime(),
			// The machine naming itself. The server addresses it by this from here on, so a
			// binding survives a reconnect no matter which credential opened the socket or
			// whether an account was involved at all.
			machineId,
			label,
			host: hostname(),
			platform: platform(),
			release: release(),
		}
		send(socket, { type: 'hello', ...lastHello })
		// One second is finer than any budget the server hands out (its pings are
		// seconds apart), so a gap this observes is never the timer's granularity.
		if (!silenceTimer) {
			silenceTimer = setInterval(() => {
				if (activeSocket !== socket) return
				const silentFor = Date.now() - lastContactAt
				if (silentFor <= silenceBudgetMs) return
				abandon(`no word from ${server} for ${silentFor}ms (budget ${silenceBudgetMs}ms) — the link is dead; stopped everything it owned`)
			}, 1000)
		}
	})
	socket.addEventListener('message', (event) => {
		lastContactAt = Date.now()
		let message
		try { message = JSON.parse(String(event.data)) } catch { return }
		switch (message?.type) {
			case 'ping': {
				// The server's keepalive, and the only place this side learns how
				// long it may stay quiet before the machine counts as gone.
				if (Number.isInteger(message.silenceMs) && message.silenceMs > 0) silenceBudgetMs = message.silenceMs
				send(socket, { type: 'pong', at: message.at ?? null })
				break
			}
			case 'bind.apply': {
				const intervalMs = Number.isInteger(message.heartbeatMs) ? message.heartbeatMs : 15000
				// A binding created from the Web UI names the staging directory as
				// `%USERPROFILE%\.dsh-staging`: that directory is on *this* machine, so the
				// variable is expanded here rather than guessed by the server. An empty
				// value still means the same thing, for callers that send one.
				const stagingDir = expandEnvVars(String(message.stagingDir ?? '').trim()) || defaultStagingDir()
				held.set(String(message.workspaceId), { visiblePath: message.visiblePath, stagingDir })
				console.log(`[executor] holding ${message.workspaceId} at ${message.visiblePath}`)
				// Plan §2.0 puts the SMB credential in the executor's own job. The
				// host is read from the binding the server just sent, so the user
				// never types it and cannot point it at the wrong share.
				const host = uncHost(message.visiblePath)
				if (host) {
					const applying = applySmbCredential(host)
					if (applying) {
						void applying.catch((error) => {
							console.log(`[executor] SMB credential error: ${String(error?.message ?? error)}`)
						})
					}
				}
				// Plan §2.6: leftovers from a task that never wrote back are surfaced
				// when the machine next binds, because this is the only side that can
				// see the staging directory.
				const leftovers = stagingLeftovers(stagingDir)
				if (leftovers.length > 0) {
					console.log(`[executor] 注意：暂存目录 ${stagingDir} 里有 ${leftovers.length} 项上次未回写的残留：`)
					for (const item of leftovers) {
						console.log(`[executor]   ${item.directory ? '[目录]' : ''}${item.name}${item.size === undefined ? '' : ` (${item.size} B, ${item.modifiedAt})`}`)
					}
					console.log('[executor] 这些可能是上次任务没写完的中间结果，请先确认再决定保留、回写还是删除。')
				}
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
					// Logged because this is the one relay outcome with no answer frame
					// of its own: without a line here, "the caller walked away" and "the
					// abort never arrived" look identical from this side.
					console.log(`[executor] http.abort ${requestId} — dropped the upstream`)
				} else {
					console.log(`[executor] http.abort ${requestId} — nothing in flight`)
				}
				break
			}
			default:
				break
		}
	})
	socket.addEventListener('close', () => {
		// A socket that a newer connection already replaced must not tear the
		// live one down: after a link loss this side reconnects while the old
		// socket is still open, and its `close` arrives later — if at all.
		if (activeSocket !== socket) return
		activeSocket = null
		teardownConnection()
		console.log('[executor] disconnected')
		scheduleReconnect(server, credential, label)
	})
	socket.addEventListener('error', (error) => {
		console.error('[executor] error:', String(error?.message ?? error))
		// A TLS handshake refused for want of a trusted certificate reaches this handler
		// as a bare network error, so the one thing that would let a person fix it has to
		// be said here. `wss:` is the trigger: a plain `ws:` link has no certificate to
		// refuse, so this message cannot fire for a failure that is not about trust.
		if (/^wss:/i.test(socketUrl(server)) && !tlsTrust.loaded) {
			console.error(tlsTrust.path === ''
				? '[executor] if this server uses its own certificate, point --ca at it '
					+ '(for example --ca caddy-root.crt) or set NODE_EXTRA_CA_CERTS; '
					+ 'the 启动执行器.cmd launcher does this for you'
				: `[executor] the certificate from ${tlsTrust.path} did not load, so this handshake may still be refused for want of trust`)
		}
		// A failed handshake may deliver only this event, so it schedules too.
		if (activeSocket !== socket) return
		clearTimeout(handshakeTimer)
		scheduleReconnect(server, credential, label)
	})
}

/** Whether a certificate for this deployment's proxy was trusted, and from where. */
let tlsTrust = { path: '', loaded: false }

const config = parseArgs(process.argv.slice(2))
nodePtyPath = config.nodePty
statePath = config.state || join(homedir(), '.dsh-executor', 'state.json')
machineId = loadMachineId()
tlsTrust = loadTrustedCertificate(config.ca)
if (tlsTrust.path !== '') {
	console.log(`[executor] trusted certificate ${tlsTrust.loaded ? 'loaded' : 'NOT loaded'} from ${tlsTrust.path}`)
}

if (config.selfTest) {
	// Terminal support is the one capability that depends on a native addon shipped
	// separately, and a machine that cannot allocate a ConPTY otherwise shows it only
	// as a terminal that closes at once. This mode answers the question locally, with
	// the same loader and the same spawn call the socket path uses.
	//
	// Written as a self-invoking async function rather than top-level `await`: SEA runs
	// the entry as CommonJS, where esbuild rejects top-level await outright.
	const runSelfTest = async () => {
		const report = { version: VERSION, nodePtyPath: nodePtyPath || '(bare name node-pty)', loaded: false, spawned: false }
		try {
			const pty = await loadNodePty()
			report.loaded = true
			const shell = resolveProgram(process.env.ComSpec || 'cmd.exe', process.env)
			report.shell = shell.path
			const term = pty.spawn(shell.path, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
			report.pid = term.pid
			report.spawned = true
			let text = ''
			term.onData((chunk) => { text += chunk })
			await new Promise((resolve) => setTimeout(resolve, 1200))
			term.write('echo SELF-TEST-MARKER\r')
			await new Promise((resolve) => setTimeout(resolve, 1200))
			report.sawMarker = text.includes('SELF-TEST-MARKER')
			report.bytes = text.length
			term.kill()
		} catch (error) {
			report.error = String(error?.message ?? error)
		}
		console.log(`[self-test] ${JSON.stringify(report)}`)
		process.exit(report.spawned && report.sawMarker ? 0 : 1)
	}
	void runSelfTest()
}

// Where to connect and what to present, in precedence order: an explicit flag, then this
// machine's saved enrollment, then the deployment the executable was built for. The last
// one is what makes a double-click work — no flags, no page, nothing to type.
const savedEnrollment = loadState()
const server = config.server || savedEnrollment?.server || DEPLOYMENT_SERVER
const secret = config.secret || savedEnrollment?.secret || DEPLOYMENT_SECRET
const token = config.token || savedEnrollment?.token || ''

if (server === '' || (secret === '' && token === '')) {
	// Nothing to join and nothing to present. Say exactly what is missing rather than
	// starting a program that will retry forever against nowhere.
	awaitingEnrollment = true
	console.error(server === ''
		? '[executor] no server to join: this copy was built without a deployment and no --server was given'
		: '[executor] no credential: this copy was built without a deployment secret and no --secret was given')
} else {
	enrollment = {
		server,
		secret,
		token,
		username: savedEnrollment?.username ?? '',
		label: config.label || savedEnrollment?.label || hostname(),
		smb: {
			username: config.smbUser ?? savedEnrollment?.smb?.username ?? '',
			password: config.smbPassword ?? savedEnrollment?.smb?.password ?? '',
		},
	}
	// Persisted so a restart reconnects without needing the flags again, and so a machine
	// that switches deployment keeps the new one.
	if (config.server !== undefined || config.secret !== undefined) saveState()
	console.log(`[executor] ${machineId} joining ${enrollment.server}${DEPLOYMENT_SECRET !== '' && secret === DEPLOYMENT_SECRET ? ' (built-in deployment)' : ''}`)
	connect(enrollment.server, presentedCredential(), enrollment.label)
}

// The page stays available after enrollment so a user can bind another workspace,
// or see why nothing is connected. A taken port must not stop the executor: the
// page is a convenience, the connection is the job.
try {
	const server = startConfigServer(config.configPort)
	server.on('listening', () => {
		// Opened by default, so double-clicking the executable behaves like a client
		// program rather than like a service with a page nobody is told about. The window
		// it opens is the whole user interface: sign in, pick a workspace, open the web UI.
		if (!config.noOpen) openConfigPage(config.configPort)
	})
	server.on('error', (error) => {
		console.error(`[executor] configuration page unavailable on port ${config.configPort}: ${String(error?.message ?? error)}`)
	})
} catch (error) {
	console.error(`[executor] configuration page failed to start: ${String(error?.message ?? error)}`)
}

/**
 * Open this machine's default browser at the configuration page.
 *
 * Spawned detached and unref'd: the browser is the user's program, not a child of this
 * one, and a browser that outlives the executor must not keep it alive or take it down.
 * A failure here is reported and nothing else — a machine whose default browser cannot
 * be launched can still be configured by typing the printed address.
 * @param port - The port the local configuration page listens on.
 */
function openConfigPage(port) {
	const url = `http://127.0.0.1:${port}/`
	console.log(`[executor] opening ${url} in the default browser`)
	try {
		// `explorer.exe <url>` hands the address to whatever the user chose as their
		// browser and returns immediately. Chosen over the usual `cmd /c start`, which
		// needs a shell to interpret it: a plain spawn of `cmd` resolves against the
		// system directory rather than the search path, so the command would be neither
		// predictable nor testable.
		const child = IS_WINDOWS
			? spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' })
			: spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' })
		child.on('error', (error) => {
			console.error(`[executor] could not open a browser automatically: ${String(error?.message ?? error)}`)
		})
		child.unref()
	} catch (error) {
		console.error(`[executor] could not open a browser automatically: ${String(error?.message ?? error)}`)
	}
}
