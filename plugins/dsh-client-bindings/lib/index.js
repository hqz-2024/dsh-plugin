/**
 * dsh-client-bindings — the workspace-to-executor binding store (plan P1).
 *
 * `plan-client-world.md` §2.1 splits the new facts by owner: workspace
 * *authorization* belongs to the account record in `dsh-remote`, while the
 * *binding* belongs to the workspace and therefore to a deployment-side storage
 * domain. This package is that second half. The engine's own `workspace` domain
 * is never written here; the two are joined only by workspace id.
 *
 * Semantics this store owns (all of §2.1 and §4.2, settled there):
 *
 * - One binding per workspace at a time. An active occupant is refused, not
 *   preempted and not queued; the caller gets the occupant's name back so the
 *   client page can say who holds it.
 * - Silence past `graceMs` makes a binding inactive, so the next machine claims
 *   it without admin involvement.
 * - Expiry never deletes: `endedAt` and `endReason` stay on the record for
 *   diagnosis, and a later claim overwrites it.
 * - A machine that lost its binding does not get it back by resuming
 *   heartbeats; it must claim again. That is what keeps "reconnect" from
 *   becoming "preempt".
 * - Every binding carries the server's boot id, so a server restart invalidates
 *   all of them at once. The heartbeat clock alone would let a binding survive a
 *   fast restart, which §2.1 rules out.
 *
 * Read paths are synchronous because the subprocess dispatcher rebuilds its
 * routing index from `activeFor` and `spawn` cannot await. Mutations are
 * asynchronous and serialized on one chain, which is what makes "first claim
 * wins" true when two machines race for an expired binding.
 *
 * A Cordis service must not use ES `#private` fields: the service proxy's
 * receiver cannot read them.
 */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

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
	throw new Error(`client-bindings: cannot resolve ${specifier} from any profile under ${join(home, 'profiles')}`)
}

const load = async (specifier) => await import(pathToFileURL(resolveEnginePackage(specifier)).href)

const { Service } = await load('@deepseek-ai/cordis')
const zodModule = await load('zod')
const { z } = zodModule.z ? zodModule : (zodModule.default ?? zodModule)
const { defineDomain, domainTable } = await load('@deepseek-ai/dsh-storage-domain')

/** One durable binding record. `workspaceId` is the key, repeated for diagnostics. */
const bindingRecord = z.object({
	workspaceId: z.string(),
	workspaceTitle: z.string(),
	username: z.string(),
	machine: z.string(),
	visiblePath: z.string(),
	stagingDir: z.string(),
	serverBoot: z.string(),
	boundAt: z.string(),
	lastHeartbeat: z.string(),
	endedAt: z.string().optional(),
	endReason: z.string().optional(),
	// Reported by the executor's `hello` once it connects, so the prompt section
	// can name the real target OS without a round trip. Optional: a record
	// written before that report — or by an executor too old to send one —
	// still parses.
	machineHost: z.string().optional(),
	machinePlatform: z.string().optional(),
	machineRelease: z.string().optional(),
})

/**
 * One issued executor token. The token itself is the key, so a lookup is a
 * direct read and there is no scan of a secret.
 */
const executorTokenRecord = z.object({
	username: z.string(),
	label: z.string(),
	issuedAt: z.string(),
	lastSeenAt: z.string().optional(),
})

/**
 * The binding domain. `single` layout: bindings number one per workspace and
 * tokens number one per enrolled machine, so the whole unit is one small
 * document.
 *
 * The name must match `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`), which excludes
 * hyphens — `client-binding` would throw at module load.
 */
const bindingDomainSpec = defineDomain({
	name: 'client_binding',
	version: 1,
	tables: {
		bindings: domainTable(bindingRecord),
		tokens: domainTable(executorTokenRecord),
	},
})

/**
 * Whether a string can name a directory on the machine that is claiming.
 *
 * A drive path (`C:\work`) or a UNC share (`\\server\share`) — the two spellings a
 * Windows client can have. A relative path is refused as well as an empty one: it
 * would resolve against whatever directory the executor happens to run in, which is
 * not a decision either side can make on the user's behalf.
 *
 * A Windows environment reference followed by a path (`%USERPROFILE%\.dsh-staging`) is
 * accepted too, which is how the Web UI names the default. It is validated without
 * being resolved because this process runs on the server while the variable refers to
 * the *client's* profile; the executor expands it against its own environment, so the
 * accepted string can never name the wrong machine's directory.
 * @param value - The path as submitted.
 * @returns true when it is an absolute path on a Windows client.
 */
function isClientAbsolutePath(value) {
	return /^[A-Za-z]:[\\/]/.test(value)
		|| /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
		|| /^%[A-Za-z_][A-Za-z0-9_]*%[\\/]/.test(value)
}

/**
 * Workspace-to-executor binding store. Registered as `ctx.clientBindings`.
 */
export default class ClientBindings extends Service {
	static inject = ['storageDomain']

	constructor(ctx, config) {
		super(ctx, 'clientBindings')
		const heartbeatMs = Number.isInteger(config?.heartbeatMs) ? config.heartbeatMs : 15000
		const graceMs = Number.isInteger(config?.graceMs) ? config.graceMs : 120000
		const sweepMs = Number.isInteger(config?.sweepMs) ? config.sweepMs : 15000
		if (graceMs < heartbeatMs) {
			throw new Error(`client-bindings: graceMs (${graceMs}) must be at least heartbeatMs (${heartbeatMs})`)
		}
		/** Expected heartbeat interval, reported to the executor so both agree on the clock. */
		this.heartbeatMs = heartbeatMs
		/** Silence after which a binding stops counting as an active occupation. */
		this.graceMs = graceMs
		/** Sweep interval for expiring stale bindings. */
		this.sweepMs = sweepMs
		/** Identity of this server run; bindings from another run are inactive by construction. */
		this.bootId = randomUUID()
		/** Assigned in `[Service.init]`, before the service becomes injectable. */
		this.table = undefined
		/** Issued executor tokens, keyed by the token itself. */
		this.tokens = undefined
		/** Serializes mutations so racing claims resolve first-wins. */
		this.tail = Promise.resolve()

		// The v1 execution-world prompt section (plan §2.8.3 elements 2-4): what
		// runs where, the target OS, and the two path spellings for one file. v2's
		// current-mode element is deliberately absent — v1 has no override.
		//
		// Registered through a scoped context, the way sandbox-policy registers its
		// own policy context, because the text depends on the assembly's agent.
		// Returning '' for an unbound session is what keeps this section out of
		// every prompt that has no client execution.
		ctx.inject(['systemPrompt'], (scope) => {
			scope.systemPrompt.section({
				name: 'execution:world',
				order: 700,
				text: (context) => this.renderExecutionWorld(context.agent?.session.header.cwd),
			})
		})
	}

	/**
	 * The workspace owning one path, by the same longest-prefix rule the
	 * subprocess dispatcher routes on. Both read `workspaceRegistry.list()`; the
	 * dispatcher additionally caches the result because `spawn` cannot await.
	 * @param cwd - A session or request working directory.
	 * @returns the owning workspace's id, path, and title, or `undefined`.
	 */
	workspaceFor(cwd) {
		if (typeof cwd !== 'string' || cwd.length === 0) return undefined
		const registry = this.ctx.get('workspaceRegistry')
		if (!registry) return undefined
		const folded = cwd.toLowerCase()
		let best
		try {
			for (const workspace of registry.list()) {
				const path = workspace.path.toLowerCase()
				if (folded !== path && !folded.startsWith(path.endsWith('/') || path.endsWith('\\') ? path : path + '\\')) continue
				if (!best || path.length > best.path.toLowerCase().length) {
					best = { id: String(workspace.id), path: workspace.path, title: workspace.title }
				}
			}
		} catch {
			// An uninitialized registry reads as no workspace, exactly as an unbound
			// session does; both leave the prompt section empty.
			return undefined
		}
		return best
	}

	/**
	 * Render the v1 execution-world section for one session directory.
	 *
	 * Empty for a session whose directory belongs to no bound workspace, which is
	 * the "command runs on the server, exactly as before" case: saying nothing is
	 * correct there, and saying something would make the agent expect local tools
	 * it does not have.
	 * @param cwd - The session's working directory.
	 * @returns the section text, or `''` when this session has no local execution.
	 */
	renderExecutionWorld(cwd) {
		const workspace = this.workspaceFor(cwd)
		if (!workspace) return ''
		const binding = this.activeFor(workspace.id)
		if (!binding) return ''
		const machine = binding.machineHost ?? binding.machine
		const os = binding.machinePlatform
			? `${binding.machinePlatform}${binding.machineRelease ? ` ${binding.machineRelease}` : ''}`
			: 'unknown'
		const lines = [
			'# Where your commands run',
			'',
			`This session's workspace "${workspace.title}" is bound to the user's own computer (${machine}),`,
			`which runs ${os}. Shell commands you run execute ON THAT COMPUTER, not on the server hosting this`,
			'conversation. It is the machine that has the user\'s installed applications, so this is where their',
			'local software (Photoshop, Blender, Office, and similar) has to be driven from.',
			'',
			'## One file, two spellings',
			'',
			`- The file tools (\`read\`, \`write\`, \`edit\`, \`glob\`, \`grep\`) address this workspace as \`${workspace.path}\`.`,
			`- A shell command's working directory is the SAME directory seen from the user's computer: \`${binding.visiblePath}\`.`,
			'- These are one file reached two ways over a network share, never two copies. A change made through',
			'  either spelling is immediately visible through the other, and there is nothing to synchronize.',
			'- When you pass a path INSIDE a shell command, use the second spelling. A path in the first spelling',
			'  names a location that does not exist on the user\'s computer.',
		]
		// A UNC working directory is accepted by PowerShell and Node, but not by every
		// program, and PowerShell displays the location in provider form rather than as
		// the plain path. Both facts were measured on this deployment; neither is
		// guessable from the path itself, and both bite only when the agent reuses a
		// path it read from output or hands one to a native program.
		if (binding.visiblePath.startsWith('\\\\')) {
			lines.push(
				'- This location is a network share, and programs differ in how they take a share as a working',
				'  directory. PowerShell and Node accept it; `cmd.exe` refuses and silently falls back to',
				'  `C:\\Windows`, so a `cmd /c` command would operate on the wrong directory without failing.',
				'- PowerShell prints the share location in provider form',
				`  (\`Microsoft.PowerShell.Core\\FileSystem::${binding.visiblePath}\`), and \`Get-Location\`/\`$PWD\` return that`,
				'  form. PowerShell itself accepts it, but a native program will not: when you need the plain path,',
				'  use `(Get-Location).ProviderPath` or `(Get-Item .).FullName`, or write the path literally.',
			)
		}
		if (binding.stagingDir) {
			lines.push(
				'',
				'## Working on large files',
				'',
				`Applications like Photoshop and Blender must not open files over a network share; they corrupt or`,
				`stall on them. For a file larger than about 10MB, or any project format such as .psd or .blend, copy`,
				`it into \`${binding.stagingDir}\` on the user's computer first, work on that copy there, then copy it`,
				'back to the workspace and delete the copy. Anything small and ordinary (text, Office, PDF) can be',
				'opened in place.',
			)
		}
		return lines.join('\n')
	}

	/** Open the domain and start the sweep timer before consumers can inject this service. */
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(bindingDomainSpec)
		this.ctx.effect(() => () => domain.close(), 'client-bindings: domain close')
		this.table = domain.table('bindings')
		this.tokens = domain.table('tokens')
		await this.sweep()
		const timer = setInterval(() => { void this.sweep() }, this.sweepMs)
		if (typeof timer.unref === 'function') timer.unref()
		this.ctx.effect(() => () => clearInterval(timer), 'client-bindings: sweep timer')
	}

	/** Queue one mutation behind every earlier one; racing claims therefore resolve in order. */
	enqueue(job) {
		const run = this.tail.then(job, job)
		this.tail = run.then(() => undefined, () => undefined)
		return run
	}

	/**
	 * Read one record, synchronously.
	 * @param workspaceId - Workspace the binding belongs to.
	 * @returns the stored record including an ended one, or `undefined`.
	 */
	get(workspaceId) {
		return this.table?.get(String(workspaceId))
	}

	/**
	 * Snapshot every stored record, ended ones included.
	 * @returns the records in table order.
	 */
	list() {
		return this.table ? [...this.table.entries()].map(([, record]) => record) : []
	}

	/**
	 * Whether one record currently counts as an active occupation: not ended, from
	 * this server run, and heart-beaten within the grace window.
	 * @param record - Candidate record.
	 * @returns `true` while the binding is live.
	 */
	isLive(record) {
		if (!record || record.endedAt) return false
		if (record.serverBoot !== this.bootId) return false
		const beat = Date.parse(record.lastHeartbeat)
		return Number.isFinite(beat) && Date.now() - beat <= this.graceMs
	}

	/**
	 * Synchronous liveness lookup — the dispatcher reads this while rebuilding its
	 * routing index, so it must not await and must not throw before init.
	 * @param workspaceId - Workspace to test.
	 * @returns the live binding, or `undefined` when the workspace is unbound.
	 */
	activeFor(workspaceId) {
		const record = this.get(workspaceId)
		return this.isLive(record) ? record : undefined
	}

	/**
	 * What a client page should show for one workspace: who holds it, or that it is
	 * free, or that a previous holder lapsed.
	 * @param workspaceId - Workspace to describe.
	 * @returns the state plus whatever occupant facts exist.
	 */
	describe(workspaceId) {
		const record = this.get(workspaceId)
		if (!record) return { state: 'free' }
		if (this.isLive(record)) {
			return {
				state: 'active',
				username: record.username,
				machine: record.machine,
				since: record.boundAt,
				lastHeartbeat: record.lastHeartbeat,
			}
		}
		return { state: 'expired', username: record.username, machine: record.machine, endReason: record.endReason ?? 'stale' }
	}

	/**
	 * Mint one executor token for an account.
	 *
	 * The token is the authentication secret a machine holds, so it is persisted
	 * rather than held in memory: an executor that reconnects after a server
	 * restart must still be recognized, and only an explicit revocation should end
	 * that.
	 * @param request - Account the token speaks for, plus a human label for the machine.
	 * @returns the token and its stored record.
	 */
	async issueToken(request) {
		const username = String(request?.username ?? '')
		if (!username) throw new Error('client-bindings: a token needs a username')
		const token = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`
		const record = {
			username,
			label: String(request?.label ?? ''),
			issuedAt: new Date().toISOString(),
		}
		await this.tokens.put(token, record)
		return { token, record }
	}

	/**
	 * Resolve one presented token.
	 * @param token - The token an executor connected with.
	 * @returns `{ token, ...record }`, or `undefined` when it was never issued or was revoked.
	 */
	resolveToken(token) {
		if (typeof token !== 'string' || token.length === 0) return undefined
		const record = this.tokens?.get(token)
		return record ? { token, ...record } : undefined
	}

	/** Record that one token was used, so an operator can tell live enrollments from stale ones. */
	async touchToken(token) {
		const record = this.tokens?.get(token)
		if (!record) return
		await this.tokens.put(token, { ...record, lastSeenAt: new Date().toISOString() })
	}

	/**
	 * Revoke one token.
	 * @param token - Token to remove.
	 * @returns `true` when it existed.
	 */
	async revokeToken(token) {
		if (!this.tokens) return false
		return await this.tokens.delete(String(token))
	}

	/**
	 * Revoke every token an account holds, for account disable and offboarding.
	 * @param username - Account whose enrollments must end.
	 * @returns the revoked tokens, so the caller can drop their connections.
	 */
	async revokeTokensForUsername(username) {
		const revoked = []
		for (const [token, record] of [...(this.tokens?.entries() ?? [])]) {
			if (record.username !== String(username)) continue
			await this.tokens.delete(token)
			revoked.push(token)
		}
		return revoked
	}

	/** Every issued token record, for an admin listing. */
	listTokens() {
		return this.tokens ? [...this.tokens.entries()].map(([token, record]) => ({ token, ...record })) : []
	}

	/**
	 * Record one machine's reported facts on the bindings it holds.
	 *
	 * The prompt section names the target OS, so these facts live in the binding record
	 * rather than being re-asked per assembly: they are written when the machine says
	 * hello and rewritten on every reconnect, because a machine can be re-imaged between
	 * connections. Addressed by machine id, with the account as the fallback for a
	 * binding created before machines named themselves.
	 * @param machineOrUsername - Machine id from `hello`, or an account for a legacy enrollment.
	 * @param facts - Host, platform, and release as the machine reported them.
	 * @returns the workspace ids that changed.
	 */
	async noteMachine(machineOrUsername, facts) {
		return await this.enqueue(async () => {
			const identity = String(machineOrUsername)
			const updated = []
			for (const [workspaceId, record] of [...(this.table?.entries() ?? [])]) {
				if (!this.isLive(record)) continue
				const matches = record.machineId !== undefined
					? record.machineId === identity
					: record.username === identity
				if (!matches) continue
				if (record.machineHost === facts.host && record.machinePlatform === facts.platform
					&& record.machineRelease === facts.release) continue
				await this.table.put(workspaceId, {
					...record,
					machineHost: facts.host,
					machinePlatform: facts.platform,
					machineRelease: facts.release,
				})
				updated.push(workspaceId)
			}
			return updated
		})
	}

	/** Mark one record ended, preserving it for diagnosis (expiry never deletes). */
	async finish(workspaceId, reason, at = new Date().toISOString()) {
		const record = this.get(workspaceId)
		if (!record || record.endedAt) return record
		const next = { ...record, endedAt: at, endReason: reason }
		await this.table.put(String(workspaceId), next)
		return next
	}

	/**
	 * Expire every binding that lapsed. Stale records are marked ended rather than
	 * removed, and an already-ended record is left alone.
	 *
	 * This mutates the same table `claim` does, so it runs through the same queue.
	 * Without that it interleaved with a claim against the same workspace and lost
	 * the claim outright: the loop decides from a snapshot of the table, then awaits
	 * each `finish`, and a claim landing inside that await was overwritten by a
	 * `finish` that re-read the record it had already judged to be lapsed. The
	 * measured outcome was a claim reporting success while the store was left
	 * holding the previous, ended record.
	 * @returns the workspace ids that were expired by this sweep.
	 */
	async sweep() {
		if (!this.table) return []
		return await this.enqueue(async () => {
			const expired = []
			for (const [workspaceId, record] of [...this.table.entries()]) {
				if (record.endedAt) continue
				const reason = record.serverBoot !== this.bootId ? 'server-restart' : 'heartbeat-timeout'
				if (reason === 'server-restart' || !this.isLive(record)) {
					await this.finish(workspaceId, reason)
					expired.push(workspaceId)
				}
			}
			return expired
		})
	}

	/**
	 * Whether one binding is held by the identity making a request.
	 *
	 * A binding is a claim on a *machine*, so the machine id is the identity that counts.
	 * `username` stays on the record as attribution — who created the binding, for the
	 * admin list and for revocation when an account goes away — and it is also the
	 * fallback for a binding created before machines named themselves.
	 * @param record - The stored binding.
	 * @param request - A request carrying `machineId` and/or `username`.
	 * @returns true when the request speaks for this binding's occupant.
	 */
	isOccupant(record, request) {
		const machineId = String(request?.machineId ?? '')
		if (machineId !== '' && record.machineId !== undefined) return record.machineId === machineId
		return record.username === String(request?.username ?? '')
	}

	/**
	 * Claim a workspace for one machine. Refused while an active occupant holds it.
	 *
	 * The two paths are validated here rather than at the HTTP endpoint, because
	 * this is the operation that records them: a binding is a promise that commands
	 * can run in a real directory on a real machine, and a blank one breaks that
	 * promise twice over — the dispatcher would hand the client a working directory
	 * that does not exist, and the prompt section would tell the model its commands
	 * run in "`…: ``". Enforcing it at the endpoint would leave every other caller
	 * free to write the same broken record.
	 *
	 * Who may claim a workspace is NOT decided here: that is authorization, and it
	 * belongs to the caller that can check the account's grant. This store only decides
	 * whether the workspace is already taken, and by which machine.
	 * @param request - Workspace identity plus the claiming machine (and optionally the account that asked).
	 * @returns `{ ok: true, binding }`, or `{ ok: false, reason, occupant… }` when held.
	 */
	async claim(request) {
		return await this.enqueue(async () => {
			const workspaceId = String(request?.workspaceId ?? '')
			if (!workspaceId) return { ok: false, reason: 'missing-workspace' }
			const machineId = String(request?.machineId ?? '')
			const username = String(request?.username ?? '')
			// A binding needs an occupant to attribute it to and to check later, and a
			// machine is the identity that actually runs the work.
			if (!machineId && !username) return { ok: false, reason: 'missing-occupant' }
			const visiblePath = String(request?.visiblePath ?? '').trim()
			if (!isClientAbsolutePath(visiblePath)) {
				return {
					ok: false,
					reason: 'invalid-visible-path',
					error: `the workspace must be given as an absolute path on the client machine (C:\\work or \\\\server\\share); got ${JSON.stringify(String(request?.visiblePath ?? ''))}`,
				}
			}
			const stagingDir = String(request?.stagingDir ?? '').trim()
			if (!isClientAbsolutePath(stagingDir)) {
				return {
					ok: false,
					reason: 'invalid-staging-dir',
					error: `a staging directory is required and must be absolute on the client machine (C:\\work or \\\\server\\share); got ${JSON.stringify(String(request?.stagingDir ?? ''))}`,
				}
			}
			const existing = this.get(workspaceId)
			if (this.isLive(existing)) {
				return {
					ok: false,
					reason: 'occupied',
					occupant: existing.machineId ?? existing.username,
					occupiedBy: existing.username,
					machine: existing.machine,
					since: existing.boundAt,
				}
			}
			const now = new Date().toISOString()
			const binding = {
				workspaceId,
				workspaceTitle: String(request?.workspaceTitle ?? existing?.workspaceTitle ?? ''),
				machineId: machineId || existing?.machineId,
				// Attribution, not identity: recorded so an admin list can say who created the
				// binding, and so removing an account can end what it started.
				username: username || existing?.username || '',
				machine: String(request?.machine ?? ''),
				visiblePath,
				stagingDir,
				serverBoot: this.bootId,
				boundAt: now,
				lastHeartbeat: now,
			}
			await this.table.put(workspaceId, binding)
			return { ok: true, binding }
		})
	}

	/**
	 * Refresh the heartbeat of a binding this account still holds. A binding that
	 * already lapsed is refused rather than revived, so a returning machine has to
	 * claim again (plan §2.1: reconnect is not preemption).
	 * @param request - Workspace and the account reporting in.
	 * @returns `{ ok: true, binding }`, or `{ ok: false, reason }`.
	 */
	async heartbeat(request) {
		return await this.enqueue(async () => {
			const workspaceId = String(request?.workspaceId ?? '')
			const record = this.get(workspaceId)
			if (!this.isLive(record)) return { ok: false, reason: 'not-held' }
			if (!this.isOccupant(record, request)) {
				return { ok: false, reason: 'not-occupant', occupant: record.machineId ?? record.username }
			}
			const next = { ...record, lastHeartbeat: new Date().toISOString() }
			await this.table.put(workspaceId, next)
			return { ok: true, binding: next }
		})
	}

	/**
	 * Give up a binding. The occupant may always release its own; `force` is the
	 * admin path for a machine that is alive but whose user has walked away.
	 * @param request - Workspace, the requesting account, and `force` for the admin path.
	 * @returns `{ ok: true, workspaceId }`, or `{ ok: false, reason }`.
	 */
	async release(request) {
		return await this.enqueue(async () => {
			const workspaceId = String(request?.workspaceId ?? '')
			const record = this.get(workspaceId)
			if (!record || record.endedAt) return { ok: false, reason: 'not-bound' }
			const force = request?.force === true
			if (!force && !this.isOccupant(record, request)) {
				return { ok: false, reason: 'not-occupant', occupant: record.machineId ?? record.username }
			}
			await this.finish(workspaceId, String(request?.reason ?? (force ? 'forced-by-admin' : 'released-by-occupant')))
			return { ok: true, workspaceId }
		})
	}

	/**
	 * Drop live bindings held by one account. Authorization revocation, account
	 * disable, and account removal all land here (plan §2.5), so the caller can send
	 * `bind.drop` to the executors named in the result.
	 * @param username - Account whose bindings must end.
	 * @param options - `reason` is recorded on each ended record; `workspaceIds`
	 * narrows the drop to specific workspaces, which is what an authorization edit
	 * that only removes some workspaces needs.
	 * @returns the dropped bindings, so the caller can notify each machine.
	 */
	async revokeForUsername(username, options = {}) {
		const reason = typeof options.reason === 'string' ? options.reason : 'authorization-revoked'
		const only = Array.isArray(options.workspaceIds) ? new Set(options.workspaceIds.map(String)) : undefined
		return await this.enqueue(async () => {
			const dropped = []
			for (const [workspaceId, record] of [...(this.table?.entries() ?? [])]) {
				if (only !== undefined && !only.has(String(workspaceId))) continue
				if (!this.isLive(record) || record.username !== String(username)) continue
				await this.finish(workspaceId, reason)
				dropped.push({ workspaceId, machine: record.machine })
			}
			return { ok: true, dropped }
		})
	}
}
