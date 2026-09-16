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
import { createWriteStream, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'

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
			stream.on('error', () => { /* a spill failure only costs recovery of the full stream */ })
			this.spills = this.spills ?? {}
			this.spills[name] = { stream, path, written: 0, maxBytes, intact: true }
		} catch {
			// No spill file: the in-memory tail is still reported.
		}
	}

	/** Bytes for one stream, spilled first and tailed second. */
	ingest(name, text) {
		const spill = this.spills?.[name]
		if (spill) {
			const bytes = Buffer.byteLength(text)
			if (spill.written + bytes > spill.maxBytes) {
				// A spill that cannot hold the whole stream is discarded rather than
				// reported as complete; the seam's contract requires exactly that.
				spill.intact = false
				spill.stream.destroy()
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
		/** Largest request body the relay will carry; MCP payloads are small JSON. */
		this.relayBodyLimit = Number.isInteger(config?.relayBodyLimit) ? config.relayBodyLimit : 8 * 1024 * 1024
		/** Set by the dispatcher: replay live bindings onto a (re)connected account. */
		this.onConnect = undefined
		this.server = undefined
	}

	/** Start the endpoint with the resolved `ws` server class. */
	start(WebSocketServer) {
		const wss = new WebSocketServer({ noServer: true })
		wss.on('connection', (socket, request) => {
			let token = ''
			try {
				token = new URL(request.url || '', 'http://localhost').searchParams.get('token') || ''
			} catch {
				token = ''
			}
			const username = this.usernameForToken(token)
			if (!username) {
				socket.close(4001, 'unauthorized')
				return
			}
			const previous = this.connections.get(username)
			// One executor per account: a second connection supersedes the first,
			// and the superseded connection's processes are settled as failed.
			if (previous) this.dropConnection(username, 'superseded by a newer connection')
			this.connections.set(username, { socket, host: null, platform: null })
			this.ctx.logger?.info?.(`[client-transport] executor connected for ${username}`)
			// A reconnecting machine must be told which bindings it still holds:
			// the binding outlives the socket, and without this it would sit idle
			// while the server kept routing work to it.
			void this.onConnect?.(username)
			socket.on('message', (raw) => this.onMessage(username, raw))
			socket.on('close', () => {
				if (this.connections.get(username)?.socket === socket) this.dropConnection(username, 'socket closed')
			})
			socket.on('error', () => { /* the close event owns cleanup */ })
		})
		this.wss = wss
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
			}))
		} catch {
			return []
		}
		if (!Array.isArray(granted) || granted.length === 0) return all
		const allowed = new Set(granted.map(String))
		return all.filter((workspace) => allowed.has(workspace.id) || allowed.has(workspace.title))
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
				this.respond(res, claimed.ok ? 200 : 409, {
					...claimed,
					bindings: this.bindingsFor(username),
				})
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
		req.on('close', () => {
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

	/** Whether one account currently has a live executor. */
	connected(username) {
		return this.connections.has(String(username))
	}

	/** Facts the connected executor reported at `hello`. */
	describe(username) {
		const connection = this.connections.get(String(username))
		if (!connection) return undefined
		return { host: connection.host, platform: connection.platform, release: connection.release }
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

	onMessage(username, raw) {
		let message
		try {
			message = JSON.parse(String(raw))
		} catch {
			return
		}
		if (message?.type === 'hello') {
			const connection = this.connections.get(username)
			if (connection) {
				connection.host = message.host ?? null
				connection.platform = message.platform ?? null
				connection.release = message.release ?? null
			}
			// The prompt section names the target OS, and the plan keeps that fact in
			// the binding record rather than re-asking per assembly.
			const bindings = this.ctx.get('clientBindings')
			if (bindings && typeof bindings.noteMachine === 'function') {
				void bindings.noteMachine(username, {
					host: message.host ?? 'unknown',
					platform: message.platform ?? 'unknown',
					release: message.release ?? '',
				}).then((updated) => {
					if (updated.length > 0) {
						this.ctx.logger?.info?.(`[client-transport] ${username} machine facts recorded on ${updated.length} binding(s)`)
					}
				})
			}
			this.ctx.logger?.info?.(`[client-transport] ${username} executor: host=${message.host} platform=${message.platform}`)
			return
		}
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
		for (const username of [...this.connections.keys()]) this.dropConnection(username, 'transport disposing')
		try { this.relayDisposer?.() } catch { /* already released */ }
		try { this.adminDisposer?.() } catch { /* already released */ }
		try { this.authDisposer?.() } catch { /* already released */ }
		try { this.disposer?.() } catch { /* already released */ }
		this.wss?.close()
	}
}
