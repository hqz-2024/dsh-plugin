/**
 * dsh-subprocess-dispatch — one `ctx.subprocess`, routed per workspace binding.
 *
 * Implements P0/P2 of `~/.dsh/docs/plan-client-world.md`: the deployment keeps a
 * single `subprocess` service registration whose implementation decides, per
 * spawn, whether the process runs on the server or is forwarded to the executor
 * bound to the workspace owning `spec.cwd`.
 *
 * Routing input is `spec.cwd` alone. `SubprocessRuntime.spawn(spec)` carries no
 * session or agent identity, so `cwd -> workspace -> binding` is the only key
 * the seam offers; that is sufficient for plan v1, where the workspace binding
 * alone decides execution location. Plan v2's per-session override needs a
 * second input and is not implemented here.
 *
 * `spawn` must return a handle synchronously while `resolveByPath` awaits a
 * realpath, so the decision is a synchronous prefix match against a routing
 * index that is rebuilt out of band. Only workspaces matter (not every
 * directory), so the index stays small.
 *
 * The engine checkout stays untouched: the base class and the server-side
 * delegate are both resolved from the running profile's dependency surface.
 */
import { createRequire } from 'node:module'
import { appendFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ClientTransport } from './client-transport.js'

/** Resolve one engine package from the running profile's dependency surface. */
function resolveEnginePackage(specifier) {
	const home = dshHomePath()
	const anchors = []
	try {
		for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name !== 'node_modules') {
				anchors.push(join(home, 'profiles', entry.name, 'package.json'))
			}
		}
	} catch {
		// A home without a profiles directory still gets the shared fallback below.
	}
	anchors.push(join(home, 'profiles', 'node_modules', 'package.json'))
	for (const anchor of anchors) {
		try {
			return createRequire(anchor).resolve(specifier)
		} catch {
			// Try the next anchor; the final miss raises one stable error.
		}
	}
	throw new Error(`subprocess-dispatch: cannot resolve ${specifier} from any profile under ${join(home, 'profiles')}`)
}

const { SubprocessRuntime } = await import(pathToFileURL(resolveEnginePackage('@deepseek-ai/dsh-subprocess')).href)

/** Lowercase a path for the case-insensitive comparison Windows uses. */
const fold = (value) => value.toLowerCase()

/**
 * Subprocess provider that owns `ctx.subprocess` and forwards each call to a
 * per-workspace target. A cwd inside a bound workspace routes to that
 * workspace's executor; every other cwd routes to the server delegate, which is
 * a defined rule rather than a silent fallback.
 *
 * Internal members are plain properties, not `#private` fields: Cordis wraps a
 * service so method calls see the caller's active context, and that proxy
 * receiver cannot read ES private fields ("Cannot read private member #routes
 * from an object whose class did not declare it").
 */
export default class DispatchSubprocess extends SubprocessRuntime {
	/** The `/executor` endpoint is registered on the web server, so it must exist first. */
	static inject = ['webServer']

	constructor(ctx, config) {
		super(ctx)
		const serverRuntime = (config && config.serverRuntime) || '@deepseek-ai/dsh-subprocess-local'
		const refreshMs = Number.isInteger(config && config.refreshMs) ? config.refreshMs : 5000
		this.tracePath = config && typeof config.tracePath === 'string' ? config.tracePath : undefined

		/** Synchronous routing index, longest path first. Rebuilt by {@link refresh}. */
		this.routes = []
		/** Signature of the last traced index, so the trace records changes only. */
		this.routesSignature = null
		/** Server-side delegate, mounted in an isolated scope so both providers coexist. */
		this.delegateCtx = null
		/** Resolved server provider; set once the isolated mount has initialized. */
		this.delegateRuntime = null

		// The delegate is a second SubprocessRuntime, and a service name may be
		// provided once per scope, so it mounts behind an isolated `subprocess`.
		// `plugin()` returns a thenable fiber: the service is published only once
		// that fiber settles, so the mount must be awaited before reading it.
		this.delegateCtx = ctx.isolate('subprocess')
		const localEntry = resolveEnginePackage(serverRuntime)
		const mounting = import(pathToFileURL(localEntry).href).then(async (mod) => {
			const LocalRuntime = mod.default || mod.LocalSubprocessRuntime
			if (typeof LocalRuntime !== 'function') {
				throw new Error(`subprocess-dispatch: ${serverRuntime} exports no provider class`)
			}
			await this.delegateCtx.plugin(LocalRuntime)
			const mounted = this.delegateCtx.get('subprocess')
			if (!mounted) throw new Error(`subprocess-dispatch: ${serverRuntime} mounted without publishing 'subprocess'`)
			this.delegateRuntime = mounted
			this.traceEvent({ event: 'delegate-mounted', serverRuntime, entry: localEntry })
			return mounted
		})
		mounting.catch((error) => {
			this.traceEvent({ event: 'delegate-mount-failed', error: String((error && error.message) || error) })
		})
		ctx.effect(() => () => { void mounting.catch(() => undefined) }, 'subprocess-dispatch: delegate mount')

		// The executor endpoint. `ws` is resolved from the same profile surface as
		// the engine packages; the endpoint only starts once that import lands.
		this.transport = new ClientTransport(ctx, config)
		const wsEntry = resolveEnginePackage('ws')
		const wsMounting = import(pathToFileURL(wsEntry).href).then((mod) => {
			const WebSocketServer = mod.WebSocketServer ?? mod.default?.WebSocketServer ?? mod.default
			if (typeof WebSocketServer !== 'function') {
				throw new Error('subprocess-dispatch: the ws package exports no WebSocketServer')
			}
			this.transport.start(WebSocketServer)
			this.transport.startAuth()
			this.transport.startRelay()
			this.traceEvent({ event: 'client-transport-started', entry: wsEntry })
		})
		wsMounting.catch((error) => {
			this.traceEvent({ event: 'client-transport-failed', error: String((error && error.message) || error) })
		})
		ctx.effect(() => () => { void this.transport.dispose() }, 'subprocess-dispatch: client transport')

		// A binding outlives the socket, so a machine that (re)connects must be
		// told what it still holds; without this replay it would sit idle while
		// the server kept routing its workspace's work to it.
		this.transport.onConnect = (username) => {
			const bindings = this.ctx.get('clientBindings')
			if (!bindings) return
			for (const record of bindings.list()) {
				if (!bindings.isLive(record) || record.username !== username) continue
				this.transport.notifyBindApply(username, record, bindings.heartbeatMs)
			}
		}

		void this.refresh()
		const timer = setInterval(() => { void this.refresh() }, refreshMs)
		if (typeof timer.unref === 'function') timer.unref()
		ctx.effect(() => () => clearInterval(timer), 'subprocess-dispatch: routing index refresh')
	}

	/**
	 * Rebuild the synchronous routing index from the engine's workspace registry
	 * and the deployment's binding store. A failure leaves the previous index in
	 * place: a transient storage fault must not silently reroute live traffic.
	 */
	async refresh() {
		const registry = this.ctx.get('workspaceRegistry')
		if (!registry) {
			this.traceIndexOnce('registry-unavailable', { available: false })
			return
		}
		try {
			const bindings = this.ctx.get('clientBindings')
			const next = []
			for (const workspace of registry.list()) {
				const id = String(workspace.id)
				const binding = bindings && typeof bindings.activeFor === 'function'
					? bindings.activeFor(id)
					: undefined
				next.push({
					path: workspace.path,
					folded: fold(workspace.path),
					id,
					title: workspace.title,
					target: binding ? 'client' : 'server',
					reason: binding ? 'workspace-bound' : 'workspace-unbound',
					username: binding ? binding.username : null,
					visiblePath: binding ? binding.visiblePath : null,
				})
			}
			// Longest path first so a nested workspace wins over its parent.
			next.sort((a, b) => b.folded.length - a.folded.length)
			this.routes = next
			this.traceIndexOnce('ok', {
				count: next.length,
				hasBindings: !!bindings,
				routes: next.map((r) => `${r.title}=${r.target}`),
			})
		} catch (error) {
			this.traceIndexOnce('failed', { error: String((error && error.message) || error) })
		}
	}

	/** Record an index rebuild only when its outcome changes, so the trace stays readable. */
	traceIndexOnce(status, detail) {
		const signature = status + '|' + JSON.stringify(detail)
		if (signature === this.routesSignature) return
		this.routesSignature = signature
		this.traceEvent({ event: 'routing-index', status, ...detail })
	}

	/** Synchronous routing decision for one cwd; `undefined` means outside every workspace. */
	decide(cwd) {
		if (typeof cwd !== 'string' || cwd.length === 0) return undefined
		const folded = fold(cwd)
		for (const route of this.routes) {
			if (folded === route.folded) return route
			if (folded.startsWith(route.folded.endsWith(sep) ? route.folded : route.folded + sep)) return route
		}
		return undefined
	}

	/** Append one structured record to the trace file, when one is configured. */
	traceEvent(record) {
		if (!this.tracePath) return
		try {
			appendFileSync(this.tracePath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
		} catch {
			// The trace file is diagnostic only; losing it must not affect routing.
		}
	}

	/** Record one routing decision for observability and for the P0 spike's assertions. */
	trace(op, cwd, route, detail) {
		this.traceEvent({
			event: 'decision',
			op,
			target: route ? route.target : 'server',
			reason: route ? route.reason : 'cwd-outside-workspaces',
			workspaceId: route ? route.id : null,
			workspaceTitle: route ? route.title : null,
			cwd,
			detail: detail === undefined ? null : detail,
		})
	}

	/** The resolved server delegate, or a loud failure when its mount has not settled. */
	delegate() {
		if (!this.delegateRuntime) {
			throw new Error('subprocess-dispatch: server delegate is not ready yet (its isolated mount has not initialized)')
		}
		return this.delegateRuntime
	}

	/**
	 * Resolve one executable. `resolveExecutable` carries no cwd, so it cannot be
	 * routed per workspace; it resolves against the server, which is the same
	 * world `ctx.fs` serves.
	 */
	async resolveExecutable(command, env, signal) {
		return await this.delegate().resolveExecutable(command, env, signal)
	}

	/**
	 * Rewrite one server path into the path the bound machine sees for that
	 * workspace. The two spellings name the same bytes over SMB (plan §2.2), so
	 * only the prefix differs and the remainder carries over unchanged.
	 */
	translateCwd(route, cwd) {
		if (!route?.visiblePath) return cwd
		return route.visiblePath + cwd.slice(route.path.length)
	}

	/**
	 * Start one process on the account bound to `route`'s workspace.
	 *
	 * A missing executor throws: plan §4.5 requires local execution to fail
	 * loudly rather than quietly run the user's command on the server, which
	 * would make the agent believe a Photoshop command succeeded somewhere it
	 * could not have run at all.
	 */
	spawnOnClient(route, spec) {
		const cwd = this.translateCwd(route, spec.cwd)
		const handle = this.transport.spawn({
			username: route.username,
			argv: spec.argv,
			cwd,
			env: spec.env,
			stdio: spec.stdio,
			graceMs: spec.graceMs,
			signal: spec.signal,
		})
		this.traceEvent({ event: 'client-spawn', workspaceId: route.id, username: route.username, cwd, translatedFrom: spec.cwd })
		return handle
	}

	/** Route and start one managed child process. */
	spawn(spec) {
		const route = this.decide(spec.cwd)
		this.trace('spawn', spec.cwd, route, Array.isArray(spec.argv) ? spec.argv.slice(0, 3).join(' ') : null)
		if (route?.target === 'client') return this.spawnOnClient(route, spec)
		return this.delegate().spawn(spec)
	}

	/**
	 * Route and allocate one terminal session on the machine owning `spec.cwd`.
	 *
	 * Substrate limits the client half reports: `inspectForeground` is always
	 * `undefined` (ConPTY publishes no process-group view, and the engine's
	 * inspector reads the local process table), and only SIGINT is deliverable,
	 * as Ctrl-C written into the terminal.
	 */
	async spawnTerminal(spec) {
		const route = this.decide(spec.cwd)
		this.trace('spawnTerminal', spec.cwd, route, Array.isArray(spec.argv) ? spec.argv.slice(0, 3).join(' ') : null)
		if (route?.target === 'client') {
			const cwd = this.translateCwd(route, spec.cwd)
			const handle = await this.transport.spawnTerminal({
				username: route.username,
				argv: spec.argv,
				cwd,
				env: spec.env,
				rows: spec.rows,
				cols: spec.cols,
				graceMs: spec.graceMs,
				signal: spec.signal,
			})
			this.traceEvent({ event: 'client-terminal', workspaceId: route.id, username: route.username, cwd, translatedFrom: spec.cwd })
			return handle
		}
		return await this.delegate().spawnTerminal(spec)
	}
}
