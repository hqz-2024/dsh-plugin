/**
 * dsh-llm-gateway-local — the deployment's model gateway.
 *
 * A client application runs the agent loop on the user's own machine, so it needs
 * a model but must not hold an API key: the key belongs to the deployment, and a
 * desktop application is a place keys leak from. This plugin exposes the same
 * OpenAI-compatible surface a client would otherwise call directly, authenticates
 * it with a per-user token, and forwards it to the real AI endpoint with the
 * deployment's credential.
 *
 * What the deployment keeps by owning this hop:
 *
 * - the key never leaves the server;
 * - the model list is closed — a client can only ask for a model named here;
 * - per-account concurrency and a daily token budget are enforced before the
 *   request costs anything;
 * - every completed request is recorded (account, model, tokens, outcome), so
 *   "who spent what" is answerable without asking the client;
 * - a client that goes away mid-stream cancels the upstream request instead of
 *   leaving it running on the deployment's bill.
 *
 * The response is passed through byte for byte: the client's provider parses the
 * exact stream the upstream produced, so no translation layer can drift from it.
 */
import { appendFileSync } from 'node:fs'

export const name = 'dsh-llm-gateway'
export const inject = ['webServer']

/** Refuse a body larger than the configured limit rather than buffering it. */
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
/** Bytes of the tail kept to recover `usage` from a streamed response. */
const USAGE_TAIL_BYTES = 64 * 1024

/** Reject config that cannot work, at load, with the field named. */
function checked(config) {
	const path = typeof config?.path === 'string' && config.path.startsWith('/') ? config.path.replace(/\/+$/, '') : ''
	if (path === '') throw new Error('llm-gateway: config.path must be an absolute path such as /llm')
	const upstream = typeof config?.upstream === 'string' ? config.upstream.replace(/\/+$/, '') : ''
	if (upstream === '') throw new Error('llm-gateway: config.upstream must name the real AI endpoint')
	const models = Array.isArray(config?.models) ? config.models.map(String).filter((id) => id !== '') : []
	if (models.length === 0) throw new Error('llm-gateway: config.models must list at least one model id')
	const tokens = new Map()
	for (const [token, account] of Object.entries(config?.tokens ?? {})) {
		if (String(token).length < 16) throw new Error(`llm-gateway: token for '${String(account)}' is too short to be a credential`)
		tokens.set(String(token), String(account))
	}
	return {
		path,
		upstream,
		apiKeyEnv: typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv !== '' ? config.apiKeyEnv : 'DEEPSEEK_API_KEY',
		models,
		tokens,
		maxConcurrent: Number.isInteger(config?.maxConcurrentPerAccount) ? config.maxConcurrentPerAccount : 4,
		dailyTokenLimit: Number.isFinite(config?.dailyTokenLimit) ? Number(config.dailyTokenLimit) : 0,
		maxRequestBytes: Number.isInteger(config?.maxRequestBytes) ? config.maxRequestBytes : DEFAULT_MAX_REQUEST_BYTES,
		usagePath: typeof config?.usagePath === 'string' ? config.usagePath : '',
	}
}

/** One JSON response, with the reason a client can act on. */
function fail(res, status, message, extra) {
	if (res.headersSent) {
		res.end()
		return
	}
	const body = JSON.stringify({ error: { message, type: 'gateway_error', ...(extra ?? {}) } })
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
	res.end(body)
}

/** Read one request body, refusing anything over the configured limit. */
async function readBody(req, limit) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) return { error: `request body exceeds ${limit} bytes` }
		chunks.push(chunk)
	}
	return { body: Buffer.concat(chunks).toString('utf8') }
}

/** Recovers `usage` from a streamed tail; the upstream sends it in the last chunk. */
function usageFromTail(tail) {
	const match = /"usage"\s*:\s*\{([^}]*)\}/.exec(tail)
	if (!match) return undefined
	const number = (name) => {
		const found = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(match[1])
		return found ? Number(found[1]) : undefined
	}
	const usage = {}
	const prompt = number('prompt_tokens')
	const completion = number('completion_tokens')
	const total = number('total_tokens')
	if (prompt !== undefined) usage.promptTokens = prompt
	if (completion !== undefined) usage.completionTokens = completion
	if (total !== undefined) usage.totalTokens = total
	if (usage.totalTokens === undefined && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)) {
		usage.totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
	}
	return Object.keys(usage).length === 0 ? undefined : usage
}

/** The key one request presents, or `undefined` when it presents none. */
function presentedToken(req) {
	const header = req.headers?.authorization
	if (typeof header !== 'string') return undefined
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? match[1].trim() : undefined
}

export function apply(ctx, config) {
	const settings = checked(config)
	/** In-flight requests per account, so the concurrency cap is enforced before the spend. */
	const inFlight = new Map()
	/** Tokens spent today per account; the day boundary clears it. */
	const spent = new Map()
	let spentDay = new Date().toISOString().slice(0, 10)

	/**
	 * Today's spend for one account, resetting at the date boundary.
	 * @param account - The account the token belongs to.
	 * @returns Tokens already spent today.
	 */
	const spentToday = (account) => {
		const today = new Date().toISOString().slice(0, 10)
		if (today !== spentDay) {
			spentDay = today
			spent.clear()
		}
		return spent.get(account) ?? 0
	}

	/** Append one usage record; the file is the deployment's own record of spend. */
	const record = (entry) => {
		ctx.logger?.info?.(`[llm-gateway] ${JSON.stringify(entry)}`)
		if (settings.usagePath === '') return
		try {
			appendFileSync(settings.usagePath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
		} catch {
			// The usage file is diagnostic and accounting evidence; a failed append must
			// not fail a request the deployment already paid for.
		}
	}

	/**
	 * The deployment's API key, from the credential store first and the process
	 * environment second. A gateway without a key refuses requests rather than
	 * forwarding an unauthenticated call upstream.
	 * @returns The key, or `undefined`.
	 */
	const apiKey = async () => {
		const credentials = ctx.get('credentials')
		if (credentials && typeof credentials.resolve === 'function') {
			try {
				const resolved = await credentials.resolve(settings.apiKeyEnv)
				const value = typeof resolved === 'string' ? resolved : resolved?.value ?? resolved?.secret
				if (typeof value === 'string' && value !== '') return value
			} catch {
				// Fall through to the environment: an unreadable store is not a refusal,
				// and the process may legitimately carry the key instead.
			}
		}
		const fromEnvironment = process.env[settings.apiKeyEnv]
		return typeof fromEnvironment === 'string' && fromEnvironment !== '' ? fromEnvironment : undefined
	}

	/** Resolve one request's token to an account, answering the request when it cannot. */
	const hasToken = (req, res) => {
		const token = presentedToken(req)
		const account = token === undefined ? undefined : settings.tokens.get(token)
		if (account === undefined) {
			fail(res, 401, 'a valid gateway token is required', { hint: 'send Authorization: Bearer <token>' })
			return undefined
		}
		return account
	}

	/** `GET <path>/v1/models` — the closed model list, in OpenAI's shape. */
	const onModels = async (req, res) => {
		if (req.method !== 'GET') return fail(res, 405, 'use GET for the model list')
		if (settings.tokens.size > 0 && !hasToken(req, res)) return
		const body = JSON.stringify({
			object: 'list',
			data: settings.models.map((id) => ({ id, object: 'model', owned_by: 'dsh' })),
		})
		res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
		res.end(body)
	}

	/** `POST <path>/v1/chat/completions` — authenticate, limit, forward, account. */
	const onChat = async (req, res) => {
		if (req.method !== 'POST') return fail(res, 405, 'use POST for chat completions')
		const account = hasToken(req, res)
		if (account === undefined) return

		const read = await readBody(req, settings.maxRequestBytes)
		if (read.error !== undefined) return fail(res, 413, read.error)
		let request
		try {
			request = JSON.parse(read.body)
		} catch {
			return fail(res, 400, 'request body is not valid JSON')
		}
		const model = typeof request?.model === 'string' ? request.model : ''
		if (!settings.models.includes(model)) {
			return fail(res, 404, `model '${model}' is not available from this gateway`, { available: settings.models })
		}
		if (settings.maxConcurrent > 0 && (inFlight.get(account) ?? 0) >= settings.maxConcurrent) {
			return fail(res, 429, `account '${account}' already has ${settings.maxConcurrent} requests in flight`)
		}
		if (settings.dailyTokenLimit > 0 && spentToday(account) >= settings.dailyTokenLimit) {
			return fail(res, 429, `account '${account}' reached its daily token budget (${settings.dailyTokenLimit})`)
		}

		const key = await apiKey()
		if (key === undefined) {
			return fail(res, 503, `this deployment has no ${settings.apiKeyEnv}; the gateway cannot reach the model`, { credential: settings.apiKeyEnv })
		}

		// Ask for the usage on the final chunk when the client streams: the spend is
		// the deployment's, and only the upstream can report it.
		if (request.stream === true && request.stream_options === undefined) request.stream_options = { include_usage: true }

		const controller = new AbortController()
		const started = Date.now()
		let closed = false
		// A client that goes away must cancel the upstream call: left running, it keeps
		// producing (and billing) tokens nobody will read.
		const onClose = () => { closed = true; controller.abort() }
		res.on('close', onClose)
		inFlight.set(account, (inFlight.get(account) ?? 0) + 1)
		/** Always release the slot, whatever the outcome. */
		const release = () => {
			res.off('close', onClose)
			const next = (inFlight.get(account) ?? 1) - 1
			if (next <= 0) inFlight.delete(account)
			else inFlight.set(account, next)
		}

		try {
			const upstream = await fetch(`${settings.upstream}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
				body: JSON.stringify(request),
				signal: controller.signal,
			})
			if (!upstream.ok || upstream.body === null) {
				const text = await upstream.text().catch(() => '')
				record({ account, model, outcome: `upstream-${upstream.status}`, ms: Date.now() - started })
				return fail(res, upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status, `upstream refused the request (${upstream.status}): ${text.slice(0, 400)}`)
			}
			res.writeHead(200, {
				'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			})
			let tail = ''
			for await (const chunk of upstream.body) {
				res.write(chunk)
				// `for await` over a fetch body yields Uint8Array, whose own `toString()`
				// ignores the encoding and returns comma-separated bytes — the first
				// version parsed that garbage, found no `usage`, and silently recorded
				// every request as zero tokens. Buffer.from is what actually decodes.
				tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-USAGE_TAIL_BYTES)
			}
			res.end()
			const usage = usageFromTail(tail)
			if (usage?.totalTokens !== undefined) spent.set(account, spentToday(account) + usage.totalTokens)
			record({ account, model, outcome: 'ok', ms: Date.now() - started, ...(usage ?? {}) })
		} catch (error) {
			const aborted = controller.signal.aborted
			record({ account, model, outcome: aborted ? (closed ? 'client-cancelled' : 'gateway-cancelled') : 'transport-failed', ms: Date.now() - started, error: String((error && error.message) || error).slice(0, 200) })
			// A client that already went away is owed no status code; a client that is
			// still there gets one it can act on.
			if (!res.headersSent && !closed) {
				fail(res, 502, aborted ? 'the upstream request was cancelled' : `upstream request failed: ${String((error && error.message) || error)}`)
			} else {
				try {
					res.end()
				} catch {
					// The socket is already gone; there is nothing left to end.
				}
			}
		} finally {
			release()
		}
	}

	const disposers = [
		ctx.webServer.register({ kind: 'exact', path: `${settings.path}/v1/chat/completions`, handler: onChat }),
		ctx.webServer.register({ kind: 'exact', path: `${settings.path}/v1/models`, handler: onModels }),
	]
	ctx.effect(() => () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				// A route already released by the server must not fail teardown.
			}
		}
	}, 'llm-gateway: routes')
	ctx.logger?.info?.(`[llm-gateway] ${settings.path}/v1 -> ${settings.upstream} (${settings.models.length} model(s), ${settings.tokens.size} token(s))`)
}

