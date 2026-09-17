/**
 * Client transport for the subprocess dispatcher (plan-client-world P2).
 *
 * Owns one WebSocket endpoint (`/executor`) that each bound machine dials out
 * to with a per-account token, and turns a spawn request into a real
 * `SubprocessHandle` whose bytes arrive over that socket.
 *
 * `spawn` is synchronous, so the handle exists before the executor has answered:
 * `pid` is `-1` until `proc.started` lands, which is the E2B precedent the plan
 * accepts. A missing executor is NOT one of those asynchronous outcomes — plan
 * §4.5 requires an unavailable local execution to fail loudly rather than fall
 * back to the server, and a synchronous throw is the loudest place to say so.
 *
 * Collected output keeps a bounded tail in memory with whole-stream byte
 * offsets, so independent readers never consume one another's text and a reader
 * that fell behind learns it lost the head. When the caller asked for a spill
 * file, every chunk is also appended there before any truncation, so the
 * complete stream stays recoverable.
 */
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'

/**
 * The staging directory a client machine uses when nobody named one.
 *
 * Written as a variable rather than resolved here: the directory belongs to the client
 * machine's own profile, which this process cannot read. The executor expands it, so the
 * binding record and the path a person would type by hand are the same string.
 */
const CLIENT_DEFAULT_STAGING = '%USERPROFILE%\\.dsh-staging'

/** Whether `path` is `root` itself or sits inside it, case-insensitively on Windows. */
function sameOrInside(path, root) {
	const a = path.toLowerCase()
	const b = root.replace(/[\\/]+$/, '').toLowerCase()
	return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)
}

/** Bounded tail of one output stream, addressed by whole-stream byte offsets. */
class TailBuffer {
	constructor(maxBytes) {
		this.maxBytes = maxBytes
		this.buffer = Buffer.alloc(0)
		this.total = 0
	}

	append(text) {
		const chunk = Buffer.from(text, 'utf8')
		this.total += chunk.length
		this.buffer = Buffer.concat([this.buffer, chunk])
		if (this.buffer.length > this.maxBytes) {
			this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes)
		}
	}

	readFrom(fromByte) {
		const tailStart = this.total - this.buffer.length
		const lossy = fromByte < tailStart
		const start = Math.max(0, Math.min(this.buffer.length, fromByte - tailStart))
		return { text: this.buffer.subarray(start).toString('utf8'), nextOffset: this.total, lossy }
	}
}

/**
 * One live process on a bound machine, viewed through the subprocess seam.
 *
 * `terminate` is the seam's only termination verb and escalates the same way the
 * local provider does: ask the executor to terminate the tree, then force it
 * after the spec's grace. Idempotent, and a no-op once exit has landed.
 */
class RemoteHandle {
	constructor({ transport, username, procId, stdio, graceMs, signal }) {
		this.transport = transport
		this.username = username
		this.procId = procId
		this.graceMs = graceMs
		/** -1 until the executor reports the real root pid. */
		this.pid = -1
		this.settled = false
		this.closed = false
		this.killTimer = undefined

		this.stdout = stdio.stdout === 'pipe' ? new Readable({ read() {} }) : undefined
		this.stderr = stdio.stderr === 'pipe' ? new Readable({ read() {} }) : undefined
		this.stdin = stdio.stdin === 'pipe' ? this.makeStdin() : undefined
		this.stdinLive = stdio.stdin === 'pipe'

		this.tails = {}
		this.readers = {}
		for (const name of ['stdout', 'stderr']) {
			const mode = stdio[name]
			if (typeof mode === 'object' && mode !== null) {
				this.tails[name] = new TailBuffer(mode.maxBytes)
				if (mode.spill) this.openSpill(name, mode.spill.maxBytes)
				this.readers[name] = { readFrom: (fromByte) => this.readCollected(name, fromByte) }
			}
		}
		this.collected = {
			...(this.readers.stdout ? { stdout: this.readers.stdout } : {}),
			...(this.readers.stderr ? { stderr: this.readers.stderr } : {}),
		}

		this.done = new Promise((resolve, reject) => {
			this.resolveDone = resolve
			this.rejectDone = reject
		})
		// A rejected `done` with no reader is an unhandled rejection; the seam
		// delivers spawn failures through it, so keep a no-op catch attached.
		this.done.catch(() => {})

		if (signal) {
			if (signal.aborted) this.terminate()
			else signal.addEventListener('abort', () => this.terminate(), { once: true })
		}
	}

	makeStdin() {
		const { Writable } = this.transport.streams
		return new Writable({
			write: (chunk, _encoding, callback) => {
				if (!this.stdinLive) {
					callback(new Error('remote stdin is closed'))
					return
				}
				this.transport.send(this.username, { type: 'proc.stdin', procId: this.procId, data: chunk.toString('utf8') })
				callback()
			},
		})
	}

	openSpill(name, maxBytes) {
		try {
			const dir = join(tmpdir(), 'dsh-remote-spill')
			mkdirSync(dir, { recursive: true })
			const path = join(dir, `${this.procId}-${name}.log`)
			const stream = createWriteStream(path)
			this.spills = this.spills ?? {}
			this.spills[name] = { stream, path, written: 0, maxBytes, intact: true }
			// A write failure leaves the file incomplete, so it must stop being offered:
			// its path would otherwise be handed to the caller as the whole stream.
			stream.on('error', () => { this.discardSpill(name) })
		} catch {
			// No spill file: the in-memory tail is still reported.
		}
	}

	/**
	 * Stop offering one spill and delete its file.
	 *
	 * The seam's contract is that a spill which cannot hold the complete stream is
	 * discarded rather than reported. That is not only about the path: a truncated
	 * file left in the spill directory is indistinguishable from a complete one to
	 * whoever reads the directory, which is exactly the way a partial capture gets
	 * mistaken for the whole output. The engine's own provider removes it for the
	 * same reason.
	 *
	 * The unlink waits for `close`: Windows refuses to delete a file that still has
	 * an open handle.
	 * @param name - Stream name (`stdout` or `stderr`).
	 */
	discardSpill(name) {
		const spill = this.spills?.[name]
		if (!spill || !spill.intact) return
		spill.intact = false
		spill.stream.once('close', () => {
			try { unlinkSync(spill.path) } catch { /* already removed */ }
		})
		spill.stream.destroy()
	}

	/** Bytes for one stream, spilled first and tailed second. */
	ingest(name, text) {
		const spill = this.spills?.[name]
		if (spill) {
			const bytes = Buffer.byteLength(text)
			if (spill.written + bytes > spill.maxBytes) {
				// A spill that cannot hold the whole stream is discarded rather than
				// reported as complete; the seam's contract requires exactly that.
				this.discardSpill(name)
			} else if (spill.intact) {
				spill.written += bytes
				spill.stream.write(text)
			}
		}
		this.tails[name]?.append(text)
		const target = name === 'stdout' ? this.stdout : this.stderr
		if (target) target.push(Buffer.from(text, 'utf8'))
	}

	readCollected(name, fromByte) {
		const read = this.tails[name].readFrom(fromByte)
		const spill = this.spills?.[name]
		if (spill && spill.intact) read.spillPath = spill.path
		// `lossy` means the requested offset slid out of the retained tail.
		return read
	}

	/** The executor reported the root pid. */
	started(pid) {
		if (Number.isInteger(pid)) this.pid = pid
	}

	/** The stream for this connection ended before the process did. */
	transportLost() {
		if (this.settled) return
		this.settled = true
		clearTimeout(this.killTimer)
		this.stdout?.push(null)
		this.stderr?.push(null)
		this.stdinLive = false
		for (const spill of Object.values(this.spills ?? {})) spill.stream.end()
		// Plan §4.6: a dropped executor settles the call as a failure and leaves
		// no process behind on this side to leak.
		this.rejectDone(new Error(`remote process ${this.procId} lost its executor connection before exit`))
	}

	exited(exitCode, signal) {
		if (this.settled) return
		this.settled = true
		clearTimeout(this.killTimer)
		this.stdout?.push(null)
		this.stderr?.push(null)
		this.stdinLive = false
		for (const spill of Object.values(this.spills ?? {})) spill.stream.end()
		this.resolveDone({ exitCode: exitCode === undefined ? null : exitCode, signal: signal ?? null })
	}

	failed(error) {
		if (this.settled) return
		this.settled = true
		clearTimeout(this.killTimer)
		this.stdout?.push(null)
		this.stderr?.push(null)
		this.stdinLive = false
		for (const spill of Object.values(this.spills ?? {})) spill.stream.end()
		this.rejectDone(new Error(String(error)))
	}

	terminate() {
		if (this.closed || this.settled) return
		this.closed = true
		this.transport.send(this.username, { type: 'proc.close', procId: this.procId })
		this.killTimer = setTimeout(() => {
			// The executor escalates on its own; this only guarantees the seam's
			// escalation promise is bounded when the executor has gone quiet.
			this.transport.send(this.username, { type: 'proc.close', procId: this.procId, force: true })
		}, this.graceMs)
		if (typeof this.killTimer.unref === 'function') this.killTimer.unref()
	}

	async waitForExit(signal) {
		if (this.settled) return true
		if (!signal) {
			await this.done.catch(() => {})
			return true
		}
		const aborted = new Promise((resolve) => {
			if (signal.aborted) resolve(false)
			else signal.addEventListener('abort', () => resolve(false), { once: true })
		})
		return await Promise.race([this.done.then(() => true, () => true), aborted])
	}
}

/**
 * One live terminal session on a bound machine, viewed through the subprocess seam.
 *
 * Substrate limits, all of them consequences of ConPTY across a socket:
 *
 * - `inspectForeground` reports `undefined`. ConPTY publishes no process-group
 *   view, and the engine's own inspector answers that question by enumerating the
 *   local process table — which is on the other machine and is not something this
 *   side can read. The seam's contract permits exactly this ("Providers document
 *   substrate-specific observability limits"), and the PTY consumer treats an
 *   absent foreground group as unknown rather than as an error.
 * - `signalForeground('SIGINT')` writes Ctrl-C into the terminal, which is how a
 *   console delivers an interrupt to whatever owns it. There is no group id to
 *   return, so the terminal root pid is reported as the target. SIGKILL and the
 *   POSIX-only signals are refused with the same wording the local Windows
 *   provider uses.
 */
class RemoteTerminalHandle {
	constructor({ transport, username, procId, graceMs, signal }) {
		this.transport = transport
		this.username = username
		this.procId = procId
		this.graceMs = graceMs
		/** -1 until the executor reports the allocated terminal's pid. */
		this.pid = -1
		this.settled = false
		this.terminating = false

		this.output = new Readable({ read() {} })
		this.done = new Promise((resolve, reject) => {
			this.resolveDone = resolve
			this.rejectDone = reject
		})
		this.done.catch(() => {})

		if (signal) {
			if (signal.aborted) void this.terminate()
			else signal.addEventListener('abort', () => { void this.terminate() }, { once: true })
		}
	}

	started(pid) {
		if (Number.isInteger(pid)) this.pid = pid
	}

	/** Terminal output is one stream; the seam's `stream` argument is always stdout. */
	ingest(_stream, text) {
		if (!this.settled) this.output.push(Buffer.from(text, 'utf8'))
	}

	exited(exitCode, signal) {
		if (this.settled) return
		this.settled = true
		this.output.push(null)
		this.resolveDone({ exitCode: exitCode === undefined ? null : exitCode, signal: signal ?? null })
	}

	failed(error) {
		if (this.settled) return
		this.settled = true
		this.output.push(null)
		this.rejectDone(new Error(String(error)))
	}

	/** The socket ended before the session did (plan §4.6: a defined outcome, not a hang). */
	transportLost() {
		if (this.settled) return
		this.settled = true
		this.output.push(null)
		this.rejectDone(new Error(`remote terminal ${this.procId} lost its executor connection before exit`))
	}

	async write(data) {
		if (this.settled) throw new Error('remote terminal is closed')
		this.transport.send(this.username, { type: 'proc.stdin', procId: this.procId, data: String(data) })
	}

	async inspectForeground() {
		if (this.settled) throw new Error('terminal is terminating')
		return undefined
	}

	async signalForeground(signal) {
		if (this.settled) throw new Error('terminal is terminating')
		if (signal === 'SIGKILL') throw new Error('refusing to SIGKILL; terminate the terminal session instead')
		if (signal !== 'SIGINT') throw new Error(`signal ${signal} is unsupported on Windows`)
		this.transport.send(this.username, { type: 'proc.signal', procId: this.procId, signal })
		return this.pid
	}

	/** Idempotent: ask the executor to end the session, then await quiescence. */
	async terminate() {
		if (this.terminating) return
		this.terminating = true
		this.transport.send(this.username, { type: 'proc.close', procId: this.procId })
		const bound = new Promise((resolve) => {
			const timer = setTimeout(resolve, this.graceMs + 5000)
			if (typeof timer.unref === 'function') timer.unref()
		})
		await Promise.race([this.done.then(() => {}, () => {}), bound])
	}

	async waitForExit(signal) {
		if (this.settled) return true
		if (!signal) {
			await this.done.catch(() => {})
			return true
		}
		const aborted = new Promise((resolve) => {
			if (signal.aborted) resolve(false)
			else signal.addEventListener('abort', () => resolve(false), { once: true })
		})
		return await Promise.race([this.done.then(() => true, () => true), aborted])
	}
}

/**
 * The oldest executor program that answers this server's keepalive.
 *
 * The two halves ship together — the client machine downloads the program from
 * this server — so the version is compared only to name the remedy for a machine
 * that still runs the previous copy.
 */
const KEEPALIVE_MIN_EXECUTOR = '0.3.0'

/**
 * Whether a dotted version string sorts below another.
 * @param version - Version reported by an executor at `hello`.
 * @param floor - Lowest version that satisfies the caller.
 * @returns true when `version` is older than `floor`.
 */
function olderThan(version, floor) {
	const parse = (text) => String(text).split('.').map((part) => Number.parseInt(part, 10) || 0)
	const [left, right] = [parse(version), parse(floor)]
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const [a, b] = [left[index] ?? 0, right[index] ?? 0]
		if (a !== b) return a < b
	}
	return false
}

/**
 * Server-side half of the client execution transport: the `/executor` endpoint,
 * the per-account connection registry, and remote spawn construction.
 */
export class ClientTransport {
	constructor(ctx, config) {
		this.ctx = ctx
		this.streams = { Readable, Writable }
		const tokens = config && typeof config.tokens === 'object' && config.tokens !== null ? config.tokens : {}
		this.byToken = new Map(Object.entries(tokens).map(([token, username]) => [token, String(username)]))
		this.connections = new Map()
		this.handles = new Map()
		/** In-flight relayed HTTP requests: requestId -> the response being written. */
		this.relays = new Map()
		/**
		 * Ports the relay may reach on a client's loopback. Empty disables the
		 * endpoint entirely, which is the safe default: without a list this would
		 * be an open proxy into every bound machine's local services.
		 */
		this.relayPorts = new Set(
			(Array.isArray(config?.relayPorts) ? config.relayPorts : []).filter((port) => Number.isInteger(port)),
		)
		/**
		 * Relay secret -> account. The relay URL goes into an MCP client's
		 * configuration, and such a client cannot present a `dsh_session` cookie,
		 * so the credential rides the path instead. An unknown secret is refused
		 * outright, which is what keeps this from being an open proxy into a bound
		 * machine's local services.
		 */
		this.relayTokens = new Map(
			Object.entries(config?.relayTokens && typeof config.relayTokens === 'object' ? config.relayTokens : {})
				.map(([secret, username]) => [String(secret), String(username)]),
		)
		/** Mount point for the relay; the path carries the account and target port. */
		this.relayPath = typeof config?.relayPath === 'string' ? config.relayPath : '/client-relay'
		/** Mount point for the executor authorization endpoint. */
		this.authPath = typeof config?.authPath === 'string' ? config.authPath : '/client-auth'
		/**
		 * Mount point for the admin surface. Unlike the other two, this one is NOT
		 * in `publicPrefixes`: it acts on behalf of a person in the web UI, so the
		 * session gate is exactly the right place to establish who that is.
		 */
		this.adminPath = typeof config?.adminPath === 'string' ? config.adminPath : '/client-admin'
		/**
		 * Web UI binding surface. Left inside the gate: its caller is a person in the
		 * app, so the session cookie is the evidence. A prefix because `state` carries
		 * the session's working directory as a query parameter.
		 */
		this.webPath = typeof config?.webPath === 'string' ? config.webPath : '/client-web'
		/**
		 * Deployment-level secret a machine presents to announce itself.
		 *
		 * A machine is hardware, not a person: it has no account to log into and no
		 * per-machine token to be issued, and asking for one was what made "give the agent
		 * hands on this computer" require a configuration ceremony. The secret lives in
		 * this deployment's configuration (like `relayTokens`) and is the same on every
		 * machine; the machine id it announces is what the server addresses it by. Empty
		 * disables the path, and per-account tokens keep working, so a machine enrolled
		 * before this existed is not cut off.
		 */
		this.machineSecret = typeof config?.machineSecret === 'string' ? config.machineSecret : ''
		/** Where the executor program is downloadable from; gated like the admin surface. */
		this.downloadPath = typeof config?.downloadPath === 'string' ? config.downloadPath : '/dsh-subprocess-dispatch/executor.mjs'
		/**
		 * Where the packaged client distribution is downloadable from. Same gate as
		 * the program above, and the same reasoning: the caller is a person on the
		 * settings page, not an anonymous machine.
		 */
		this.packPath = typeof config?.packPath === 'string' ? config.packPath : '/dsh-subprocess-dispatch/dsh-executor.zip'
		/**
		 * The client distribution: the executable plus the node-pty it needs, as one
		 * archive a Windows machine unpacks and runs. Built by `build-executor-exe.mjs`,
		 * so it is reproducible rather than committed — the route reports its absence
		 * instead of serving a stale copy.
		 */
		this.packEntry = fileURLToPath(new URL('../dist/dsh-executor.zip', import.meta.url))
		/**
		 * The executor program's own file, resolved from this module rather than from
		 * the process cwd: the plugin is loaded out of `~/.dsh/plugins/`, and a
		 * cwd-relative path would break the moment the server started elsewhere.
		 */
		this.executorEntry = fileURLToPath(new URL('../executor/executor.mjs', import.meta.url))
		/** Largest request body the relay will carry; MCP payloads are small JSON. */
		this.relayBodyLimit = Number.isInteger(config?.relayBodyLimit) ? config.relayBodyLimit : 8 * 1024 * 1024
		/**
		 * How often this side tells a connected executor it is still here. The
		 * gap that counts as a dead link is derived from it and from the binding
		 * grace, and is handed to the executor with every ping.
		 */
		this.keepaliveMs = Number.isInteger(config?.keepaliveMs) ? config.keepaliveMs : 3000
		/**
		 * Rules that turn a server directory into the share path a client sees, for
		 * pre-filling the bind form. Each entry: `{ serverRoot, uncPrefix }`, e.g.
		 * `{ serverRoot: 'C:\dsh-workspaces', uncPrefix: '\\192.168.28.239\ws-' }`.
		 */
		this.visiblePathHints = Array.isArray(config?.visiblePathHints) ? config.visiblePathHints : []
		/** Set by the dispatcher: replay live bindings onto a (re)connected account. */
		this.onConnect = undefined
		this.server = undefined
	}

	/** Start the endpoint with the resolved `ws` server class. */
	start(WebSocketServer) {
		const wss = new WebSocketServer({ noServer: true })
		wss.on('connection', (socket, request) => {
			let params
			try {
				params = new URL(request.url || '', 'http://localhost').searchParams
			} catch {
				params = new URLSearchParams()
			}
			// Two credentials open this endpoint, and they mean different things. A machine
			// that presents the deployment secret is announcing hardware, not a person: it
			// is `pending` until its `hello` names it, and only then is it acknowledged.
			// A per-account token still works — it names its account up front — so a machine
			// enrolled before the secret existed keeps running through its own upgrade.
			const presented = params.get('token') ?? ''
			const legacyAccount = this.usernameForToken(presented)
			const secretOk = this.machineSecret !== '' && presented === this.machineSecret
			if (!legacyAccount && !secretOk) {
				socket.close(4001, 'unauthorized')
				return
			}
			if (legacyAccount) {
				const previous = this.connections.get(legacyAccount)
				if (previous) this.dropConnection(legacyAccount, 'superseded by a newer connection')
			}
			const connection = {
				socket,
				username: legacyAccount ?? '',
				host: null,
				platform: null,
				lastMessageAt: Date.now(),
				lastPingAt: 0,
			}
			// Keyed by the socket until `hello` arrives: one connection per *machine*, and
			// nothing before `hello` knows which machine this is.
			const pendingKey = `pending:${randomUUID()}`
			this.connections.set(pendingKey, connection)
			connection.pendingKey = pendingKey
			this.ctx.logger?.info?.(legacyAccount
				? `[client-transport] executor connected for ${legacyAccount}`
				: '[client-transport] a machine connected with the deployment secret')
			if (legacyAccount) void this.onConnect?.(legacyAccount)
			socket.on('message', (raw) => {
				// Every frame counts as a sign of life, whatever it carries: the
				// keepalive deadline is only meaningful if ordinary traffic
				// refreshes it too.
				connection.lastMessageAt = Date.now()
				this.onMessage(connection, raw)
			})
			socket.on('close', () => {
				const key = connection.machineId ?? connection.pendingKey
				if (this.connections.get(key)?.socket === socket) {
					this.dropConnection(key, 'socket closed')
				}
			})
			socket.on('error', () => { /* the close event owns cleanup */ })
		})
		this.wss = wss
		// A short tick, not the ping period: the period follows the binding grace,
		// so a deployment that shortens its grace gets faster pings without a
		// restart, and one that lengthens it does not get a longer blind spot.
		this.keepaliveTimer = setInterval(() => this.keepalive(), 250)
		this.disposer = this.ctx.webServer.registerUpgrade({
			kind: 'exact',
			path: '/executor',
			handler: (request, socket, head) => {
				wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
			},
		})
	}

	/**
	 * Resolve a presented executor token.
	 *
	 * Configured tokens are checked first: they exist for tests and for a
	 * deployment that has not adopted the login flow. Everything else must be one
	 * the authorization endpoint issued, which is what makes revocation effective
	 * — a token is only as good as the store that can still refuse it.
	 * @param token - Token from the WebSocket query string.
	 * @returns the account it speaks for, or `undefined`.
	 */
	usernameForToken(token) {
		if (typeof token !== 'string' || token.length === 0) return undefined
		const configured = this.byToken.get(token)
		if (configured !== undefined) return configured
		const bindings = this.ctx.get('clientBindings')
		const issued = bindings?.resolveToken(token)
		if (!issued) return undefined
		void bindings.touchToken(token)
		return issued.username
	}

	/** Write one JSON response, unless the headers already went out. */
	respond(res, status, body) {
		if (res.headersSent) {
			res.end()
			return
		}
		const text = JSON.stringify(body)
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(text),
		})
		res.end(text)
	}

	/** The token from an `Authorization: Bearer …` header, or `''`. */
	bearer(req) {
		const header = req.headers?.authorization
		if (typeof header !== 'string') return ''
		const matched = /^Bearer\s+(.+)$/i.exec(header)
		return matched ? matched[1].trim() : ''
	}

	/** Read one bounded JSON body; rejects oversized input instead of buffering it. */
	async readJson(req, limit = 64 * 1024) {
		const chunks = []
		let size = 0
		for await (const chunk of req) {
			size += chunk.length
			if (size > limit) {
				req.destroy()
				throw new Error(`request body exceeds ${limit} bytes`)
			}
			chunks.push(chunk)
		}
		if (size === 0) return {}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	}

	/**
	 * Workspaces an account may bind.
	 *
	 * The authorization lives on the account record, which belongs to the
	 * authentication plugin (plan §2.5), so this reads it from there through the
	 * `clientAuthResolver` service. An admin with no explicit list sees every
	 * workspace; anything narrower must come from the account.
	 */
	claimableWorkspaces(username, granted) {
		const registry = this.ctx.get('workspaceRegistry')
		if (!registry) return []
		let all = []
		try {
			all = registry.list().map((workspace) => ({
				id: String(workspace.id),
				title: workspace.title,
				path: workspace.path,
				// What the client machine most likely sees this directory as. Nothing
				// depends on the guess — it is a pre-filled form value the user can
				// overwrite — but typing a UNC by hand is the step people get wrong, and
				// the server is the side that knows which directories are shared.
				suggestedVisiblePath: this.suggestVisiblePath(workspace.path),
			}))
		} catch {
			return []
		}
		if (!Array.isArray(granted) || granted.length === 0) return all
		const allowed = new Set(granted.map(String))
		return all.filter((workspace) => allowed.has(workspace.id) || allowed.has(workspace.title))
	}

	/**
	 * Translate one server directory into the share path a client likely sees.
	 *
	 * Configured rather than derived (`visiblePathHints` on this plugin), because
	 * the server cannot know how a share was named: `setup-smb.ps1` shares
	 * `C:\dsh-workspaces\smbtest` as `\\<host>\ws-smbtest`, and that convention
	 * lives in the deployment, not in the path. The first matching rule wins; the
	 * last path segment becomes the share name suffix.
	 * @param serverPath - Absolute directory on this server.
	 * @returns The suggested client-side path, or undefined when no rule matches.
	 */
	suggestVisiblePath(serverPath) {
		if (typeof serverPath !== 'string' || serverPath.length === 0) return undefined
		for (const hint of this.visiblePathHints) {
			const root = String(hint.serverRoot ?? '').replace(/[\\/]+$/, '')
			if (root.length === 0) continue
			if (serverPath.toLowerCase() === root.toLowerCase()) return undefined
			if (!serverPath.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) continue
			const rest = serverPath.slice(root.length + 1).replace(/\\/g, '/').replace(/\/+$/, '')
			if (rest.length === 0 || rest.includes('/')) return undefined
			// `uncPrefix` carries the partial share name too (`\\host\ws-`), so the
			// result is a concatenation, not a join: inserting a separator here turned
			// `\ws-` + `smbtest` into `\ws-\\smbtest`.
			return `${String(hint.uncPrefix ?? '')}${rest}`
		}
		return undefined
	}

	/** Current bindings an account holds, as the client page shows them. */
	bindingsFor(username) {
		const bindings = this.ctx.get('clientBindings')
		if (!bindings) return []
		return bindings.list()
			.filter((record) => record.username === username)
			.map((record) => ({
				workspaceId: record.workspaceId,
				workspaceTitle: record.workspaceTitle,
				visiblePath: record.visiblePath,
				stagingDir: record.stagingDir,
				state: bindings.isLive(record) ? 'active' : 'expired',
				machine: record.machine,
				machineHost: record.machineHost ?? null,
				boundAt: record.boundAt,
				lastHeartbeat: record.lastHeartbeat,
				endReason: record.endReason ?? null,
			}))
	}

	/**
	 * Serve the executor program for download (plan §6.2 item 5: "executor 的分发
	 * 与更新 —— 先复用 `/dsh-local-bridge/sidecar.mjs` 式端点").
	 *
	 * This is the same shape as the sidecar's endpoint on purpose: the two programs
	 * are installed the same way, from the same settings page, by the same people.
	 * It is deliberately NOT in `publicPrefixes` — the caller is a signed-in browser
	 * on the settings page, so the login gate is exactly the right check, and the
	 * gate is not weakened for a file that is not a secret anyway.
	 *
	 * No token is baked into the file. The executor enrolls itself: its page logs in
	 * against `/auth/login` and exchanges the session for a token per account
	 * (plan §2.5), so a downloaded copy carries no credential to leak.
	 */
	startDownload() {
		this.downloadDisposer = this.ctx.webServer.register({
			kind: 'exact',
			path: this.downloadPath,
			handler: (req, res) => {
				try {
					const content = readFileSync(this.executorEntry, 'utf8')
					res.writeHead(200, {
						'Content-Type': 'text/javascript; charset=utf-8',
						'Content-Disposition': 'attachment; filename="executor.mjs"',
						'Content-Length': Buffer.byteLength(content),
						'Cache-Control': 'no-store',
					})
					res.end(content)
				} catch {
					res.writeHead(404)
					res.end('executor.mjs not found')
				}
			},
		})
		this.ctx.logger?.info?.(`[client-transport] executor download at ${this.downloadPath}`)
		return this.downloadDisposer
	}

	/**
	 * Serve the packaged client distribution.
	 *
	 * One request answers the whole install on a Windows client: the archive holds
	 * `dsh-executor.exe` and a `node-pty` beside it, which is what makes interactive
	 * terminals work there. That is the point of the package — a client machine never
	 * runs npm, never builds a native addon, and never passes `--node-pty`.
	 *
	 * Streamed rather than read into memory: this is 32 MB, and the settings page may
	 * be open on several machines at once. Range requests are answered because a
	 * download this size over a LAN connection that drops is better resumed than
	 * restarted, and every major browser and download manager asks for one.
	 */
	startPackDownload() {
		this.packDisposer = this.ctx.webServer.register({
			kind: 'exact',
			path: this.packPath,
			handler: (req, res) => {
				let size
				try {
					size = statSync(this.packEntry).size
				} catch {
					res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
					res.end('客户端分发包还没有构建：在服务器上运行 node build-executor-exe.mjs，产物是 plugins/dsh-subprocess-dispatch/dist/dsh-executor.zip')
					return
				}
				const headers = {
					'Content-Type': 'application/zip',
					'Content-Disposition': 'attachment; filename="dsh-executor.zip"',
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-store',
				}
				const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
				let start = 0
				let end = size - 1
				if (range) {
					// An unsatisfiable range must be refused with 416: a client that asked
					// for bytes beyond the file and got the whole thing instead would treat
					// a complete response as the tail of its own resume.
					start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
					end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
					if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
						res.writeHead(416, { 'Content-Range': `bytes */${size}` })
						res.end()
						return
					}
					headers['Content-Range'] = `bytes ${start}-${end}/${size}`
				}
				headers['Content-Length'] = end - start + 1
				res.writeHead(range ? 206 : 200, headers)
				if (req.method === 'HEAD') {
					res.end()
					return
				}
				const stream = createReadStream(this.packEntry, { start, end })
				stream.on('error', () => { res.destroy() })
				// The response owns the file handle, so a client that walks away mid-download
				// must close the stream rather than leave it reading into a dead socket.
				res.on('close', () => { stream.destroy() })
				stream.pipe(res)
			},
		})
		this.ctx.logger?.info?.(`[client-transport] client distribution download at ${this.packPath}`)
		return this.packDisposer
	}

	/**
	 * Mount the Web UI surface: binding state and self-service bind/unbind.
	 *
	 * Left inside the gate on purpose — the caller is a person in the app, and a
	 * session cookie is exactly the right evidence for "who is this". A prefix rather
	 * than an exact path because `state` carries the session's working directory as a
	 * query parameter.
	 */
	startWeb() {
		this.webDisposer = this.ctx.webServer.register({
			kind: 'prefix',
			path: this.webPath,
			handler: (req, res) => { void this.serveWeb(req, res) },
		})
		this.ctx.logger?.info?.(`[client-transport] web binding surface at ${this.webPath}/…`)
		return this.webDisposer
	}

	/**
	 * Handle one Web UI request, for the signed-in account itself.
	 *
	 * Everything here is scoped to the caller's own account: the state it reads, the
	 * binding it may create, and the binding it may release. Admin actions stay on the
	 * admin surface, where the role check lives.
	 */
	async serveWeb(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const action = url.pathname.slice(this.webPath.length).replace(/^\//, '').split('/')[0]
		const bindings = this.ctx.get('clientBindings')
		if (!bindings) {
			this.respond(res, 503, { error: 'the binding store is unavailable' })
			return
		}
		const resolver = this.ctx.get('clientAuthResolver')
		if (!resolver || typeof resolver.resolveSession !== 'function') {
			this.respond(res, 503, { error: 'no authentication service is mounted' })
			return
		}
		const session = await resolver.resolveSession(req)
		if (!session) {
			this.respond(res, 401, { error: 'not signed in' })
			return
		}
		const username = session.username
		try {
			if (action === 'state') {
				const cwd = url.searchParams.get('cwd') ?? ''
				this.respond(res, 200, this.webState(username, cwd))
				return
			}
			if (action === 'bind' || action === 'unbind') {
				if (req.method !== 'POST') {
					this.respond(res, 405, { error: 'use POST' })
					return
				}
				const body = await this.readJson(req)
				const workspaceId = String(body?.workspaceId ?? '')
				if (!this.claimableWorkspaces(username, undefined).some((w) => w.id === workspaceId)) {
					this.respond(res, 404, { error: `workspace '${workspaceId}' is not available to this account` })
					return
				}
				if (action === 'unbind') {
					const released = await bindings.release({ workspaceId, username })
					if (released.ok) this.notifyBindDrop(username, workspaceId, 'released-by-user')
					this.respond(res, released.ok ? 200 : 409, released)
					return
				}
				// Two different refusals, and saying which one it is matters: a workspace
				// another account holds cannot be fixed by opening an executor, and a
				// workspace nobody holds cannot be claimed without one.
				const occupant = bindings.activeFor(workspaceId)
				if (occupant !== undefined && occupant.username !== username) {
					this.respond(res, 409, {
						error: `'${workspaceId}' is bound by ${occupant.username} on ${occupant.machine || 'another machine'}`,
						reason: 'occupied',
						occupiedBy: occupant.username,
					})
					return
				}
				const machine = this.describe(username)
				if (!this.connected(username)) {
					this.respond(res, 409, {
						error: 'no executor is connected for this account',
						reason: 'no-executor',
						remedy: 'open the client executor on the machine that should run this workspace, then try again',
					})
					return
				}
				const registry = this.ctx.get('workspaceRegistry')
				const workspace = this.claimableWorkspaces(username, undefined).find((w) => w.id === workspaceId)
				const generated = this.generatePaths(workspace?.path ?? '')
				const claimed = await bindings.claim({
					workspaceId,
					workspaceTitle: registry?.get?.(workspaceId)?.title ?? '',
					username,
					machine: body?.machine ?? machine?.host ?? '',
					visiblePath: String(body?.visiblePath ?? '') || generated.visiblePath,
					stagingDir: String(body?.stagingDir ?? '') || generated.stagingDir,
				})
				if (claimed.ok) this.notifyBindApply(username, claimed.binding, bindings.heartbeatMs)
				const refused = String(claimed.reason ?? '').startsWith('invalid-') ? 400 : 409
				this.respond(res, claimed.ok ? 200 : refused, { ...claimed, generated })
				return
			}
			this.respond(res, 404, { error: `unknown action '${action}'` })
		} catch (error) {
			this.ctx.logger?.warn?.(`[client-transport] web binding action failed: ${String(error?.message ?? error)}`)
			this.respond(res, 400, { error: String((error && error.message) || error) })
		}
	}

	/**
	 * The binding facts the session header needs, for one working directory.
	 *
	 * The workspace is resolved from the session's own `cwd` rather than from an id the
	 * caller supplies: that is the fact the dispatcher itself uses to decide where a
	 * command runs, so showing it is showing the routing rather than a parallel guess.
	 * @param username - The signed-in account.
	 * @param cwd - The session's working directory, or `''` for no session.
	 * @returns State payload for the client's header control.
	 */
	webState(username, cwd) {
		const bindings = this.ctx.get('clientBindings')
		const registry = this.ctx.get('workspaceRegistry')
		const workspaces = this.claimableWorkspaces(username, undefined)
		const base = {
			username,
			connected: this.connected(username),
			machine: this.describe(username) ?? null,
			workspaces,
		}
		if (cwd === '') return { ...base, workspace: null }
		// Longest matching prefix wins, so a workspace nested inside another still
		// resolves to the inner one — the same rule the routing index applies.
		let matched
		for (const workspace of registry?.list?.() ?? []) {
			const path = String(workspace.path ?? '')
			if (path === '' || !sameOrInside(cwd, path)) continue
			if (matched === undefined || path.length > String(matched.path).length) matched = workspace
		}
		if (matched === undefined) return { ...base, workspace: null }
		const id = String(matched.id)
		const record = bindings.get(id)
		const workspace = workspaces.find((w) => w.id === id) ?? null
		const live = record !== undefined && bindings.isLive(record)
		return {
			...base,
			workspace: {
				id,
				title: matched.title ?? '',
				path: String(matched.path ?? ''),
				// Same rule the account's own authorization applies: a workspace this
				// account may not use is not bindable from here either.
				allowed: workspace !== null,
				...this.generatePaths(String(matched.path ?? '')),
				binding: live
					? {
						machine: record.machine ?? '',
						machineHost: record.machineHost ?? null,
						visiblePath: record.visiblePath ?? '',
						stagingDir: record.stagingDir ?? '',
						mine: record.username === username,
						occupiedBy: record.username,
						boundAt: record.boundAt ?? null,
					}
					: null,
			},
		}
	}

	/**
	 * The two paths a binding needs, computed rather than typed.
	 *
	 * The visible path comes from the deployment's own share rules, so it matches what
	 * a person would otherwise have to type by hand. The staging directory is named as
	 * `%USERPROFILE%\.dsh-staging` rather than resolved: that directory is on the
	 * *client* machine, and no amount of server-side knowledge can name another
	 * machine's user profile. The executor expands the variable when it applies the
	 * binding, so the record and the directory a person would choose by hand agree.
	 * @param serverPath - The workspace's path on the server.
	 * @returns Suggested `visiblePath` (may be empty) and `stagingDir`.
	 */
	generatePaths(serverPath) {
		return {
			visiblePath: this.suggestVisiblePath(serverPath) ?? '',
			stagingDir: CLIENT_DEFAULT_STAGING,
		}
	}

	/**
	 * Mount the admin surface (plan §2.1's second manual exit).
	 *
	 * The occupant's own page covers the common case, but not the one this exists
	 * for: a machine that is still alive and still holding a workspace while its
	 * user has walked away. Nothing on that machine can be asked to let go, so
	 * somebody else has to be able to.
	 */
	startAdmin() {
		this.adminDisposer = this.ctx.webServer.register({
			kind: 'prefix',
			path: this.adminPath,
			handler: (req, res) => { void this.administer(req, res) },
		})
		this.ctx.logger?.info?.(`[client-transport] admin surface at ${this.adminPath}/…`)
		return this.adminDisposer
	}

	/** Handle one admin request, after establishing that the caller is an admin. */
	async administer(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const action = url.pathname.slice(this.adminPath.length).replace(/^\//, '').split('/')[0]
		const bindings = this.ctx.get('clientBindings')
		if (!bindings) {
			this.respond(res, 503, { error: 'the binding store is unavailable' })
			return
		}
		// The gate already proved a session; the role is the part it cannot decide
		// for this feature, so the answer comes from the same verified source.
		const resolver = this.ctx.get('clientAuthResolver')
		if (!resolver || typeof resolver.resolveSession !== 'function') {
			this.respond(res, 503, { error: 'no authentication service is mounted, so admin actions cannot be authorized' })
			return
		}
		const session = await resolver.resolveSession(req)
		if (!session) {
			this.respond(res, 401, { error: 'not signed in' })
			return
		}
		if (session.role !== 'admin') {
			this.respond(res, 403, { error: 'admin only' })
			return
		}

		try {
			if (action === 'bindings') {
				this.respond(res, 200, {
					actor: session.username,
					bindings: bindings.list().map((record) => ({
						workspaceId: record.workspaceId,
						workspaceTitle: record.workspaceTitle,
						username: record.username,
						machine: record.machine,
						machineHost: record.machineHost ?? null,
						visiblePath: record.visiblePath,
						stagingDir: record.stagingDir,
						state: bindings.isLive(record) ? 'active' : 'expired',
						connected: this.connected(record.username),
						boundAt: record.boundAt,
						lastHeartbeat: record.lastHeartbeat,
						endReason: record.endReason ?? null,
					})),
				})
				return
			}
			if (action === 'unbind') {
				if (req.method !== 'POST') {
					this.respond(res, 405, { error: 'use POST' })
					return
				}
				const body = await this.readJson(req)
				const workspaceId = String(body?.workspaceId ?? '')
				const record = bindings.get(workspaceId)
				if (!record) {
					this.respond(res, 404, { error: `workspace '${workspaceId}' has no binding record` })
					return
				}
				const occupant = record.username
				// `force` is the whole point: the occupant cannot be asked, and an
				// admin action must not be refused for the occupant's absence.
				const released = await bindings.release({
					workspaceId,
					username: session.username,
					force: true,
					reason: `forced-by-admin:${session.username}`,
				})
				if (released.ok) {
					// Tell the machine itself, so it stops heartbeating a workspace it
					// no longer holds instead of waiting for its grace clock.
					this.notifyBindDrop(occupant, workspaceId, 'forced-by-admin')
					this.ctx.logger?.info?.(`[client-transport] ${session.username} force-released ${workspaceId} from ${occupant}`)
				}
				this.respond(res, released.ok ? 200 : 409, released)
				return
			}
			this.respond(res, 404, { error: `unknown action '${action}'` })
		} catch (error) {
			this.respond(res, 400, { error: String((error && error.message) || error) })
		}
	}

	/**
	 * Mount the executor authorization endpoint (plan §2.5).
	 *
	 * The page that drives this runs on the user's machine, so the server must not
	 * trust anything it says about who the user is: the account comes from the
	 * authentication plugin's verified session, reached through the
	 * `clientAuthResolver` service. Without that service the endpoint refuses
	 * everything rather than falling back to a caller-supplied name.
	 */
	startAuth() {
		this.authDisposer = this.ctx.webServer.register({
			kind: 'prefix',
			path: this.authPath,
			handler: (req, res) => { void this.authorize(req, res) },
		})
		this.ctx.logger?.info?.(`[client-transport] executor authorization at ${this.authPath}/…`)
		return this.authDisposer
	}

	/** Handle one authorization request. */
	async authorize(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const action = url.pathname.slice(this.authPath.length).replace(/^\//, '').split('/')[0]
		const bindings = this.ctx.get('clientBindings')
		if (!bindings) {
			this.respond(res, 503, { error: 'the binding store is unavailable' })
			return
		}

		try {
			if (action === 'login') {
				if (req.method !== 'POST') {
					this.respond(res, 405, { error: 'use POST' })
					return
				}
				const resolver = this.ctx.get('clientAuthResolver')
				if (!resolver || typeof resolver.resolveSession !== 'function') {
					this.respond(res, 503, {
						error: 'executor login is unavailable: no authentication service is mounted,'
							+ ' so this endpoint cannot establish who is asking',
					})
					return
				}
				const session = await resolver.resolveSession(req)
				if (!session || typeof session.username !== 'string') {
					this.respond(res, 401, { error: 'not signed in' })
					return
				}
				const body = await this.readJson(req)
				const { token, record } = await bindings.issueToken({
					username: session.username,
					label: String(body?.label ?? ''),
				})
				this.ctx.logger?.info?.(`[client-transport] issued an executor token for ${session.username}`)
				this.respond(res, 200, {
					token,
					username: record.username,
					role: session.role ?? null,
					heartbeatMs: bindings.heartbeatMs,
					workspaces: this.claimableWorkspaces(session.username, session.workspaces),
					bindings: this.bindingsFor(session.username),
				})
				return
			}

			// Every other action speaks with the executor token the machine holds:
			// one this endpoint issued, or a configured one. Resolution goes through
			// the transport rather than the store alone, because the store only
			// knows the tokens it issued.
			const presented = this.bearer(req)
			const username = this.usernameForToken(presented)
			if (!username) {
				this.respond(res, 401, { error: 'a valid executor token is required' })
				return
			}
			const issuedRecord = bindings.resolveToken(presented)

			if (action === 'state') {
				this.respond(res, 200, {
					username,
					label: issuedRecord?.label ?? '',
					connected: this.connected(username),
					heartbeatMs: bindings.heartbeatMs,
					machine: this.describe(username) ?? null,
					bindings: this.bindingsFor(username),
					// A machine enrolled by a launcher script holds a token and never
					// signs in, so this is the only place its page can learn which
					// workspaces it may bind. Sending it here rather than requiring the
					// login round trip is what lets the whole bind step skip a password.
					workspaces: this.claimableWorkspaces(username, undefined),
				})
				return
			}

			if (action === 'bind' || action === 'unbind') {
				if (req.method !== 'POST') {
					this.respond(res, 405, { error: 'use POST' })
					return
				}
				const body = await this.readJson(req)
				const workspaceId = String(body?.workspaceId ?? '')
				if (!this.claimableWorkspaces(username, undefined).some((workspace) => workspace.id === workspaceId)) {
					this.respond(res, 404, { error: `workspace '${workspaceId}' is not available to this account` })
					return
				}
				if (action === 'unbind') {
					const released = await bindings.release({ workspaceId, username })
					if (released.ok) this.notifyBindDrop(username, workspaceId, 'released-by-occupant')
					this.respond(res, released.ok ? 200 : 409, released)
					return
				}
				const registry = this.ctx.get('workspaceRegistry')
				const workspaceTitle = registry?.get?.(workspaceId)?.title ?? ''
				const claimed = await bindings.claim({
					workspaceId,
					workspaceTitle,
					username,
					machine: String(body?.machine ?? issuedRecord?.label ?? ''),
					visiblePath: String(body?.visiblePath ?? ''),
					stagingDir: String(body?.stagingDir ?? ''),
				})
				if (claimed.ok) {
					// The executor must learn it now holds this, or it never starts
					// heartbeating and the binding lapses on its own grace clock.
					this.notifyBindApply(username, claimed.binding, bindings.heartbeatMs)
				}
				// A refused claim is the store's decision; an invalid path is the
				// caller's mistake, and 400 says so where 409 would imply a conflict
				// with another occupant.
				const refused = String(claimed.reason ?? '').startsWith('invalid-') ? 400 : 409
				this.respond(res, claimed.ok ? 200 : refused, {
					...claimed,
					bindings: this.bindingsFor(username),
				})
				return
			}

			// A URL that puts a browser inside the Web UI for this account. The shell's
			// own door wants the process launch token, which only the authentication
			// plugin can mint, so the answer comes from the service it publishes; without
			// that service the client page keeps its plain-server-address behaviour.
			if (action === 'web-entry') {
				const entry = this.ctx.get('clientBrowserEntry')
				if (!entry || typeof entry.entryUrl !== 'function') {
					this.respond(res, 503, { error: 'this deployment has no browser entry point' })
					return
				}
				this.respond(res, 200, { ok: true, url: entry.entryUrl(req) })
				return
			}

			this.respond(res, 404, { error: `unknown action '${action}'` })
		} catch (error) {
			this.ctx.logger?.warn?.(`[client-transport] authorization failed: ${String(error?.message ?? error)}`)
			this.respond(res, 400, { error: String((error && error.message) || error) })
		}
	}

	/**
	 * Mount the loopback relay, if a port allowlist exists.
	 *
	 * The route is `/…/<account>/<port>/<rest>` and the response is streamed as it
	 * arrives, so an MCP StreamableHTTP endpoint's `text/event-stream` reaches the
	 * caller event by event instead of after the stream closes.
	 * @returns the disposer, or `undefined` when no port is allowed.
	 */
	startRelay() {
		if (this.relayPorts.size === 0) {
			this.ctx.logger?.info?.('[client-transport] relay disabled (no relayPorts configured)')
			return undefined
		}
		this.relayDisposer = this.ctx.webServer.register({
			kind: 'prefix',
			path: this.relayPath,
			handler: (req, res) => { void this.relay(req, res) },
		})
		this.ctx.logger?.info?.(
			`[client-transport] relay at ${this.relayPath}/<account>/<port>/… allowing ${[...this.relayPorts].join(', ')}`,
		)
		return this.relayDisposer
	}

	/** Answer one relayed request locally when it never reaches a client. */
	relayFail(res, status, message) {
		if (res.headersSent) {
			res.end()
			return
		}
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify({ error: message }))
	}

	/**
	 * Carry one inbound request to a bound machine's loopback service.
	 *
	 * Three gates, all of them required: the port must be allowlisted, the account
	 * must have a connected executor, and that account must currently hold a live
	 * binding. The last one is the authorization signal — a connected executor
	 * with no binding is not a target anyone asked to reach.
	 * @param req - The inbound request.
	 * @param res - The response the handler owns until the stream ends.
	 */
	async relay(req, res) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const segments = url.pathname.slice(this.relayPath.length).split('/').filter((part) => part.length > 0)
		if (segments.length < 2) {
			this.relayFail(res, 404, `relay path must be ${this.relayPath}/<secret>/<port>/<path>`)
			return
		}
		let secret
		try {
			secret = decodeURIComponent(segments[0])
		} catch {
			this.relayFail(res, 400, 'relay secret segment is not valid percent-encoding')
			return
		}
		const username = this.relayTokens.get(secret)
		if (username === undefined) {
			this.relayFail(res, 403, 'unknown relay secret')
			return
		}
		const port = Number(segments[1])
		const target = `/${segments.slice(2).join('/')}${url.search}`

		if (!this.relayPorts.has(port)) {
			this.relayFail(res, 403, `port ${segments[1]} is not in the relay allowlist`)
			return
		}
		if (!this.connected(username)) {
			this.relayFail(res, 502, `no executor is connected for '${username}'`)
			return
		}
		const bindings = this.ctx.get('clientBindings')
		const live = bindings?.list().some((record) => record.username === username && bindings.isLive(record))
		if (!live) {
			this.relayFail(res, 403, `'${username}' holds no active workspace binding`)
			return
		}

		const body = []
		let size = 0
		for await (const chunk of req) {
			size += chunk.length
			if (size > this.relayBodyLimit) {
				this.relayFail(res, 413, `request body exceeds ${this.relayBodyLimit} bytes`)
				// Draining stops here; the socket is released with the response.
				req.destroy()
				return
			}
			body.push(chunk)
		}

		const requestId = `http-${randomUUID()}`
		const entry = { res, settled: false, username }
		this.relays.set(requestId, entry)
		const release = () => {
			if (entry.settled) return
			entry.settled = true
			this.relays.delete(requestId)
		}
		// A caller that walks away must not leave the client's upstream request
		// running, so the disconnect aborts it there.
		//
		// This listens on the RESPONSE, not on the request. Node emits `close` on an
		// IncomingMessage as soon as its body has been read to the end, and the body
		// loop above always reads it to the end — so a listener attached afterwards
		// never fires, and the abort was never sent at all (measured: with the body
		// consumed, a client that dies mid-stream produces `res` `close` and no `req`
		// `close`). `writableFinished` is what separates the two outcomes: a response
		// that finished normally closes after flushing, while one whose caller
		// vanished closes before it ever finished.
		res.on('close', () => {
			if (res.writableFinished) return
			if (entry.settled) return
			release()
			this.send(username, { type: 'http.abort', requestId })
		})

		this.send(username, {
			type: 'http.request',
			requestId,
			port,
			method: req.method ?? 'GET',
			path: target,
			headers: req.headers,
			bodyBase64: body.length > 0 ? Buffer.concat(body).toString('base64') : '',
		})
	}

	/** Apply one relayed response frame to the waiting HTTP response. */
	onRelayFrame(message) {
		const entry = this.relays.get(String(message.requestId))
		if (!entry || entry.settled) return
		const { res } = entry
		switch (message.type) {
			case 'http.response': {
				if (!res.headersSent) {
					const headers = { ...(message.headers ?? {}) }
					// The body is re-framed here, so the upstream framing must not survive.
					delete headers['transfer-encoding']
					delete headers['content-length']
					res.writeHead(Number(message.status) || 502, headers)
					// Without this an SSE response would sit in the header buffer.
					res.flushHeaders()
				}
				break
			}
			case 'http.chunk':
				res.write(Buffer.from(String(message.base64 ?? ''), 'base64'))
				break
			case 'http.end':
				entry.settled = true
				this.relays.delete(String(message.requestId))
				res.end()
				break
			case 'http.error':
				entry.settled = true
				this.relays.delete(String(message.requestId))
				this.relayFail(res, 502, String(message.error))
				break
			default:
				break
		}
	}

	/**
	 * One keepalive round: tell every connected executor this server is still
	 * here, and retire the ones that have stopped answering.
	 *
	 * `close` is not a liveness signal. A link that stops delivering — cable
	 * pulled, Wi-Fi dropped, VPN renegotiating — sends no FIN and no RST, so the
	 * socket stays open at both ends indefinitely. Without a message-level
	 * deadline the server keeps waiting on children it can no longer reach (plan
	 * §4.6 requires every call to reach a definite end), while the binding it has
	 * already expired is handed to another machine whose client is still running
	 * the previous commands against the same share.
	 *
	 * The deadline sits below the binding grace on purpose: the machine that
	 * would otherwise keep a workspace it no longer owns gives up first, so its
	 * processes stop before anyone else can be given that workspace.
	 */
	keepalive() {
		const now = Date.now()
		const graceMs = this.ctx.get('clientBindings')?.graceMs
		const budget = Number.isInteger(graceMs) && graceMs > 0 ? graceMs : this.keepaliveMs * 3
		const silenceMs = Math.max(1000, Math.min(this.keepaliveMs * 3, Math.floor(budget / 2)))
		const pingMs = Math.max(250, Math.min(this.keepaliveMs, Math.floor(silenceMs / 3)))
		for (const [username, connection] of [...this.connections]) {
			const silentFor = now - connection.lastMessageAt
			if (silentFor > silenceMs) {
				this.dropConnection(username, `executor went silent for ${silentFor}ms (budget ${silenceMs}ms)`)
				continue
			}
			if (now - connection.lastPingAt < pingMs) continue
			connection.lastPingAt = now
			try {
				connection.socket.send(JSON.stringify({ type: 'ping', at: now, silenceMs }))
			} catch { /* the close event owns cleanup */ }
		}
	}

	/** End one account's connection and settle every process it still owned. */
	dropConnection(username, reason) {
		const connection = this.connections.get(username)
		this.connections.delete(username)
		this.ctx.logger?.info?.(`[client-transport] executor for ${username} dropped: ${reason}`)
		for (const handle of this.handles.get(username) ?? []) handle.transportLost()
		this.handles.delete(username)
		// A relayed response has no other end to learn this from: the caller would
		// otherwise wait on a stream that can never continue.
		for (const [requestId, entry] of [...this.relays]) {
			if (entry.username !== username) continue
			entry.settled = true
			this.relays.delete(requestId)
			this.relayFail(entry.res, 502, `executor for '${username}' disconnected mid-request (${reason})`)
		}
		try { connection?.socket.close() } catch { /* already closing */ }
	}

	/** Whether one account currently has a live executor (legacy token connections). */
	connected(username) {
		return this.connections.has(String(username))
	}

	/** Whether one machine is currently connected. */
	machineConnected(machineId) {
		return this.connections.has(String(machineId))
	}

	/** The machine ids currently connected, in no particular order. */
	machineIds() {
		return [...this.connections.values()]
			.map((connection) => connection.machineId)
			.filter((id) => typeof id === 'string' && id !== '')
	}

	/** Facts the connected executor reported at `hello`, by machine id or account. */
	describe(username) {
		const connection = this.connections.get(String(username))
		if (!connection) return undefined
		return {
			machineId: connection.machineId ?? null,
			host: connection.host,
			platform: connection.platform,
			release: connection.release,
		}
	}

	/**
	 * Report a machine whose executor build is older than the one this server hands out.
	 *
	 * Both times come from the running file's own modification time (see the executor's
	 * `ownBuildTime`), so neither side has to publish a version number for the comparison
	 * to work. Nothing is enforced: a stale machine keeps working, and the log names it
	 * along with the remedy, which is the whole of plan §6.2 item 5 at LAN scale.
	 * @param username - Account the executor speaks for.
	 * @param message - The `hello` frame, for its `build`.
	 */
	noteStaleBuild(username, message) {
		if (!Number.isFinite(message?.build)) return
		let served
		try {
			served = statSync(this.packEntry).mtimeMs
		} catch {
			// No packaged distribution on this server, so there is nothing to be stale
			// against; a `.mjs` client has no build time of its own either.
			return
		}
		// A tolerance rather than an exact compare: the archive and the executable inside
		// it are written seconds apart, and a machine that unpacked the current one must
		// not be reported as stale.
		if (served - message.build < 24 * 60 * 60 * 1000) return
		const days = Math.round((served - message.build) / 86400000)
		this.ctx.logger?.warn?.(`[client-transport] ${username} runs an executor built ${days} day(s) before the one this server hands out: re-download ${this.packPath} on that machine and replace its folder`)
	}

	/** Send one frame to an account's executor; drops silently when it is gone. */
	send(username, message) {
		const connection = this.connections.get(String(username))
		if (!connection) return false
		try {
			connection.socket.send(JSON.stringify(message))
			return true
		} catch {
			return false
		}
	}

	/**
	 * Handle one frame from a machine.
	 *
	 * The first argument is the whole connection rather than a key, because `hello` is
	 * what *establishes* the key: a machine that presented the deployment secret is
	 * acknowledged here, and everything after this frame is addressed by its machine id.
	 * @param connection - The live connection record.
	 * @param raw - The frame payload.
	 */
	onMessage(connection, raw) {
		let message
		try {
			message = JSON.parse(String(raw))
		} catch {
			return
		}
		if (message?.type === 'hello') {
			connection.host = message.host ?? null
			connection.platform = message.platform ?? null
			connection.release = message.release ?? null
			// The machine names itself here, which is the moment a secret-authenticated
			// connection stops being anonymous and becomes addressable.
			const announced = typeof message.machineId === 'string' ? message.machineId.trim() : ''
			if (announced !== '' && connection.machineId !== announced) {
				const previousKey = connection.machineId ?? connection.pendingKey
				const previous = this.connections.get(announced)
				// One executor per machine: a second connection for the same machine
				// supersedes the first, and the superseded one's processes settle as failed.
				if (previous && previous !== connection) {
					this.dropConnection(announced, 'superseded by a newer connection')
				}
				this.connections.delete(previousKey)
				connection.machineId = announced
				this.connections.set(announced, connection)
				connection.pendingKey = undefined
			}
			// Facts land on the binding records that name this machine. The account is
			// recorded too when the connection carries one, which is all a legacy
			// token-authenticated machine has.
			const key = connection.machineId ?? connection.username
			const bindings = this.ctx.get('clientBindings')
			if (bindings && typeof bindings.noteMachine === 'function') {
				void bindings.noteMachine(key, {
					host: message.host ?? 'unknown',
					platform: message.platform ?? 'unknown',
					release: message.release ?? '',
				}).then((updated) => {
					if (updated.length > 0) {
						this.ctx.logger?.info?.(`[client-transport] ${key} machine facts recorded on ${updated.length} binding(s)`)
					}
				})
			}
			this.ctx.logger?.info?.(`[client-transport] ${key} executor: host=${message.host} platform=${message.platform}`)
			// A reconnecting machine must be told which bindings it still holds: the
			// binding outlives the socket, and without this it would sit idle while the
			// server kept routing work to it. Machines that only just named themselves
			// need this exactly as much as ones that reconnected.
			if (connection.machineId !== undefined) void this.onConnect?.(connection.machineId)
			// An executor older than the keepalive answers neither ping nor, when
			// it holds nothing, anything else — so this server would retire it for
			// silence every few seconds and the machine would look like it keeps
			// flapping. Naming the remedy here is the difference between that and
			// an hour of guessing; the program is downloadable from this server.
			if (typeof message.version === 'string' && olderThan(message.version, KEEPALIVE_MIN_EXECUTOR)) {
				this.ctx.logger?.warn?.(`[client-transport] ${key} runs executor ${message.version}, which predates the keepalive (needs ${KEEPALIVE_MIN_EXECUTOR}): re-download ${this.downloadPath} on that machine, or it will be dropped whenever it is idle`)
			}
			// Plan §6.2 item 5's update channel, in the form a LAN deployment can act on
			// without a version feed: the machine reports when its own program was built,
			// and the server knows when the copy it hands out was built. A machine running
			// an older one is named in the log, with the remedy, instead of being left to
			// discover the mismatch as a capability that quietly does not work.
			this.noteStaleBuild(key, message)
			return
		}
		// Every frame after `hello` is addressed to a machine, so the lookup key is the
		// machine id; a legacy token connection keeps its account as the key.
		const username = connection.machineId ?? connection.username
		// Relayed HTTP frames carry a requestId, not a procId, so they are routed
		// before the process-handle lookup below.
		if (typeof message?.type === 'string' && message.type.startsWith('http.')) {
			this.onRelayFrame(message)
			return
		}
		if (message?.type === 'bind.heartbeat') {
			// The store decides whether the binding is still this account's. A
			// refusal means this machine holds something it no longer owns, so it
			// is told to drop it instead of beating into the void.
			const bindings = this.ctx.get('clientBindings')
			if (bindings) {
				void bindings.heartbeat({ workspaceId: message.workspaceId, username }).then((result) => {
					if (!result?.ok) this.notifyBindDrop(username, message.workspaceId, result?.reason ?? 'not-held')
				})
			}
			return
		}
		const handle = this.handles.get(String(username))?.find((candidate) => candidate.procId === message?.procId)
		if (!handle) return
		switch (message.type) {
			case 'proc.started':
				handle.started(message.pid)
				break
			case 'proc.chunk':
				handle.ingest(message.stream === 'stderr' ? 'stderr' : 'stdout', String(message.text ?? ''))
				break
			case 'proc.exit':
				handle.exited(message.exitCode, message.signal)
				break
			case 'proc.error':
				handle.failed(message.error)
				break
			default:
				break
		}
	}

	/**
	 * Tell one account's executor it now holds a workspace, so it starts
	 * heartbeating it. Sent after the store approves a claim, and replayed on
	 * every (re)connect.
	 * @param username - Account that holds the binding.
	 * @param binding - The stored record, for its visible path and staging directory.
	 * @param heartbeatMs - Interval the executor should report in at.
	 * @returns whether a connected executor received it.
	 */
	notifyBindApply(username, binding, heartbeatMs) {
		const sent = this.send(username, {
			type: 'bind.apply',
			workspaceId: String(binding.workspaceId),
			visiblePath: binding.visiblePath,
			stagingDir: binding.stagingDir,
			heartbeatMs,
		})
		// This is the first moment the server knows both "this account holds that
		// workspace" and "this is what its machine reported at hello". A claim is
		// created after the executor connected, so the hello-time write found no
		// live binding to stamp; this one does.
		const facts = this.describe(username)
		const bindings = this.ctx.get('clientBindings')
		if (facts && bindings && typeof bindings.noteMachine === 'function') {
			void bindings.noteMachine(username, {
				host: facts.host ?? 'unknown',
				platform: facts.platform ?? 'unknown',
				release: facts.release ?? '',
			})
		}
		return sent
	}

	/**
	 * Tell one account's executor it no longer holds a workspace.
	 * @param username - Account to notify.
	 * @param workspaceId - Workspace to release.
	 * @param reason - Recorded in the executor's log.
	 * @returns whether a connected executor received it.
	 */
	notifyBindDrop(username, workspaceId, reason) {
		return this.send(username, { type: 'bind.drop', workspaceId: String(workspaceId), reason: String(reason) })
	}

	/** The connection for one account, or a loud failure — never a server fallback. */
	requireConnection(username, what) {
		if (this.connected(username)) return username
		throw new Error(
			`client-transport: no executor is connected for '${username}'; ${what} is unavailable`
			+ ' and the command was not run on the server instead',
		)
	}

	/** Keep one live handle until it settles, then release it. */
	track(username, handle) {
		const list = this.handles.get(username) ?? []
		list.push(handle)
		this.handles.set(username, list)
		handle.done.then(
			() => this.forget(username, handle),
			() => this.forget(username, handle),
		)
	}

	/**
	 * Start one process on a bound machine.
	 * @param request - Account, translated argv/cwd/env/stdio, grace, and cancellation.
	 * @returns the live handle.
	 * @throws when the account has no executor — never a silent server fallback.
	 */
	spawn(request) {
		const username = this.requireConnection(String(request.username), 'local execution')
		const procId = `proc-${randomUUID()}`
		const handle = new RemoteHandle({
			transport: this,
			username,
			procId,
			stdio: request.stdio,
			graceMs: request.graceMs,
			signal: request.signal,
		})
		this.track(username, handle)
		this.send(username, {
			type: 'proc.spawn',
			procId,
			argv: request.argv,
			cwd: request.cwd,
			env: request.env,
			// The initial stdin disposition must cross too: `{ data }` is a payload the
			// client writes and closes, and `'ignore'` is an immediate EOF. Omitting it
			// dropped the payload and left a pipe open, which hung every child that
			// reads stdin to end.
			stdin: request.stdio.stdin,
			graceMs: request.graceMs,
		})
		return handle
	}

	/**
	 * Allocate one terminal session on a bound machine.
	 * @param request - Account, translated argv/cwd/env, initial size, grace, and cancellation.
	 * @returns the live terminal handle.
	 * @throws when the account has no executor — never a silent server fallback.
	 */
	async spawnTerminal(request) {
		const username = this.requireConnection(String(request.username), 'local terminal execution')
		const procId = `term-${randomUUID()}`
		const handle = new RemoteTerminalHandle({
			transport: this,
			username,
			procId,
			graceMs: request.graceMs,
			signal: request.signal,
		})
		this.track(username, handle)
		this.send(username, {
			type: 'proc.terminal',
			procId,
			argv: request.argv,
			cwd: request.cwd,
			env: request.env,
			rows: request.rows,
			cols: request.cols,
			graceMs: request.graceMs,
		})
		return handle
	}

	forget(username, handle) {
		const list = this.handles.get(username)
		if (!list) return
		const next = list.filter((candidate) => candidate !== handle)
		if (next.length === 0) this.handles.delete(username)
		else this.handles.set(username, next)
	}

	/** Terminate every remote process, then release the endpoint. */
	async dispose() {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
		this.keepaliveTimer = undefined
		for (const username of [...this.connections.keys()]) this.dropConnection(username, 'transport disposing')
		try { this.relayDisposer?.() } catch { /* already released */ }
		try { this.adminDisposer?.() } catch { /* already released */ }
		try { this.webDisposer?.() } catch { /* already released */ }
		try { this.authDisposer?.() } catch { /* already released */ }
		try { this.downloadDisposer?.() } catch { /* already released */ }
		try { this.packDisposer?.() } catch { /* already released */ }
		try { this.disposer?.() } catch { /* already released */ }
		this.wss?.close()
	}
}
