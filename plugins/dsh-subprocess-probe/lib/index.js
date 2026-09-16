/**
 * dsh-subprocess-probe — the pilot profile's verification harness.
 *
 * It drives the real stores and the real dispatcher and writes every result to
 * one file, so a claim's effect and the routing decision it produced are read
 * together rather than inferred.
 *
 * What it proves, and how:
 *
 *   client execution  A workspace is claimed with a `visiblePath` that differs
 *                     from the server path. The child prints its own cwd, so the
 *                     result distinguishes three things at once: the process ran
 *                     on the executor, the cwd was translated, and the output
 *                     made the full round trip over the socket. A server-side run
 *                     would print the server path instead.
 *   termination       A long-running child is terminated and the handle settles
 *                     instead of hanging.
 *   loud failure      The executor is dropped and the next spawn throws, rather
 *                     than quietly running the user's command on the server.
 *   binding semantics Occupancy, release, and the routing each implies.
 *
 * Delete this package with its pilot bundle entry once v1 is signed off.
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs'

export const name = 'dsh-subprocess-probe'
export const inject = ['subprocess', 'clientBindings', 'systemPrompt']

/** Prints facts only the executing machine can know, so the host is provable. */
const IDENTITY_SCRIPT = 'process.stdout.write(JSON.stringify({cwd:process.cwd(),host:require("node:os").hostname(),pid:process.pid}))'

export function apply(ctx, config) {
	const workspaceTitle = String(config?.workspaceTitle ?? '')
	const username = String(config?.username ?? 'probe-primary')
	const visiblePath = String(config?.visiblePath ?? '')
	const reindexMs = Number.isInteger(config?.reindexMs) ? config.reindexMs : 2500
	const executorWaitMs = Number.isInteger(config?.executorWaitMs) ? config.executorWaitMs : 30000
	/** Port this DSH server listens on, so the relay can be reached over real HTTP. */
	const serverPort = Number.isInteger(config?.serverPort) ? config.serverPort : 3082
	/** Port the fixture service listens on, standing in for a client-localhost service. */
	const fixturePort = Number.isInteger(config?.fixturePort) ? config.fixturePort : 38450
	/** Relay path secret, standing in for the credential an MCP client would carry. */
	const relaySecret = String(config?.relaySecret ?? '')
	/** The configured executor token this profile's transport accepts. */
	const configuredToken = String(config?.executorToken ?? '')
	/**
	 * When set, the profile mounts a login gate, so the probe runs the plan §2.5
	 * flow: sign in, then turn that verified session into an executor token. Only
	 * a gated profile can show that `publicPrefixes` really bypasses the gate.
	 */
	const loginUser = String(config?.loginUser ?? '')
	const loginPassword = String(config?.loginPassword ?? '')
	/** A non-admin account, used to prove the admin surface refuses it. */
	const viewerUser = String(config?.viewerUser ?? '')
	const viewerPassword = String(config?.viewerPassword ?? '')
	/**
	 * Two session ids the deployment's owners file maps to different accounts.
	 * The shell tools stamp a built-in `DSH_SESSION_ID` into every shell spawn, so
	 * these stand in for the session identity a real shell call carries. When both
	 * are set the probe also runs the plan §2.1 permission-consistency checks.
	 */
	const ownSession = String(config?.ownSession ?? '')
	const foreignSession = String(config?.foreignSession ?? '')
	/**
	 * When set, the probe ends with the plan §4.5 / §4.6 disconnect scenario: it
	 * arms an in-flight child and an open terminal, writes this marker file, and
	 * then waits for an external harness to kill the executor. A marker file is
	 * used because the kill must come from outside this process.
	 */
	const crashMarker = typeof config?.crashMarker === 'string' ? config.crashMarker : ''
	/**
	 * Interpreter the P3 acceptance REPL step starts. A server-absolute path is
	 * what a real shell call produces (the shell tool resolves the command on the
	 * server), so it also exercises the executor's cross-machine `argv[0]` rule.
	 */
	const pythonPath = String(config?.pythonPath ?? 'python')
	const resultPath = typeof config?.resultPath === 'string' ? config.resultPath : undefined

	const record = (entry) => {
		if (!resultPath) return
		try {
			appendFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
		} catch { /* the probe's own result file is diagnostic only */ }
	}
	const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

	/** Spawn through the real dispatcher and report what came back. */
	const attemptSpawn = async (label, cwd, argv, env) => {
		const started = Date.now()
		try {
			const handle = ctx.subprocess.spawn({
				argv,
				cwd,
				stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
				graceMs: 3000,
				...env === undefined ? {} : { env },
			})
			const outcome = await handle.done
			const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
			const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
			const route = ctx.subprocess.routes?.find((candidate) => cwd.toLowerCase().startsWith(candidate.folded))
			let parsed
			try { parsed = JSON.parse(stdout.trim()) } catch { parsed = undefined }
			record({
				step: label,
				ok: true,
				// The routing index reports the BINDING; permission consistency can
				// still refuse that binding, so the executed machine is read from what
				// the child itself reported rather than from the index.
				boundTarget: route?.target ?? 'server',
				executedOn: parsed?.cwd === undefined ? null : (parsed.cwd === visiblePath ? 'client' : 'server'),
				handlePid: handle.pid,
				exitCode: outcome.exitCode,
				parsed,
				stderr: stderr.slice(0, 300),
				ms: Date.now() - started,
			})
			return { handle, stdout, parsed }
		} catch (error) {
			record({ step: label, ok: false, error: String((error && error.message) || error), ms: Date.now() - started })
			return { error }
		}
	}

	const run = async () => {
		const bindings = ctx.clientBindings
		const dispatcher = ctx.subprocess

		// The workspace registry initializes seconds after boot, so the id lookup waits.
		const registryDeadline = Date.now() + 20000
		let workspace
		while (!workspace && Date.now() < registryDeadline) {
			const registry = ctx.get('workspaceRegistry')
			try {
				workspace = registry?.list().find((candidate) => candidate.title === workspaceTitle)
			} catch { /* registry not initialized yet */ }
			if (!workspace) await sleep(200)
		}
		if (!workspace) {
			record({ event: 'aborted', reason: 'workspace-not-found', workspaceTitle })
			return
		}
		const workspaceId = String(workspace.id)
		const serverCwd = workspace.path
		record({ event: 'target-workspace', workspaceTitle, workspaceId, serverCwd, visiblePath, username })

		// ── 1. Baseline: unbound runs on the server ────────────────────────────
		await sleep(reindexMs)
		await attemptSpawn('baseline-server-execution', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])

		// ── 2. Wait for the executor, then claim with a distinct visible path ──
		const executorDeadline = Date.now() + executorWaitMs
		while (!dispatcher.transport?.connected(username) && Date.now() < executorDeadline) await sleep(250)
		record({ event: 'executor-connected', username, connected: !!dispatcher.transport?.connected(username) })

		const claim = await bindings.claim({
			workspaceId,
			workspaceTitle,
			username,
			machine: 'probe-executor',
			visiblePath,
			stagingDir: 'C:\\dsh-staging',
		})
		record({ step: 'claim-with-visible-path', result: claim })
		// The claim -> bind.apply step belongs to the P1 authorization endpoint,
		// which does not exist yet, so the harness sends it. Without it the
		// executor never heartbeats and the binding lapses mid-test.
		if (claim.ok) {
			const sent = dispatcher.transport.notifyBindApply(username, claim.binding, bindings.heartbeatMs)
			record({ step: 'notify-bind-apply', sent })
		}
		await sleep(reindexMs)
		record({
			step: 'route-after-claim',
			routes: (dispatcher.routes ?? []).map((route) => `${route.title}=${route.target}`),
			translated: dispatcher.translateCwd(dispatcher.routes.find((route) => route.id === workspaceId), serverCwd),
		})

		// ── 2b. The v1 execution-world prompt section (plan §2.8.3) ────────────
		// Without this the agent assumes it is on the server and writes server paths
		// into shell commands, so the section's content is as load-bearing as the
		// routing itself.
		const record2 = bindings.get(workspaceId)
		const boundText = bindings.renderExecutionWorld(serverCwd)
		record({
			step: 'prompt-section-bound',
			length: boundText.length,
			hasVisiblePath: boundText.includes(visiblePath),
			hasServerPath: boundText.includes(serverCwd),
			hasMachineHost: !!record2?.machineHost && boundText.includes(record2.machineHost),
			hasPlatform: !!record2?.machinePlatform && boundText.includes(record2.machinePlatform),
			machineHost: record2?.machineHost ?? null,
			machinePlatform: record2?.machinePlatform ?? null,
			// The share guidance is asserted rather than assumed: it decides whether the
			// agent reuses a path PowerShell printed in provider form, or hands a UNC to a
			// program that silently ignores it. Only UNC bindings carry it.
			hasShareGuidance: boundText.includes('ProviderPath'),
			hasCmdFallbackWarning: boundText.includes('falls back to'),
			head: boundText.slice(0, 180),
		})
		record({
			step: 'prompt-section-unbound',
			length: bindings.renderExecutionWorld('C:\\Users\\bestarc\\AppData\\Local\\Temp').length,
		})
		// Registration proof, without faking a Session: a real assembly needs a real
		// one (`session.snapshotEvents`), so assemble with no agent. The section is
		// then registered but renders empty — which is itself the v1 contract for a
		// session that has no local execution.
		try {
			const anonymous = await ctx.systemPrompt.assemble({})
			const entry = anonymous.sections.find((candidate) => candidate.name === 'execution:world')
			record({
				step: 'prompt-section-registered',
				present: !!entry,
				renderedLength: entry?.text.length ?? null,
				allSections: anonymous.sections.map((candidate) => candidate.name),
			})
		} catch (error) {
			record({ step: 'prompt-section-registered', error: String((error && error.message) || error) })
		}

		// ── 2c. Client-loopback relay (plan P4) ───────────────────────────────
		// The relay is the only way the server can reach a service on the bound
		// machine's 127.0.0.1, which is where an MCP endpoint like Figma's lives.
		// The relay URL carries its own secret: an MCP client's configuration cannot
		// present a session cookie, and the login gate has no loopback exemption.
		const relayBase = `http://127.0.0.1:${serverPort}/client-relay/${encodeURIComponent(relaySecret)}`
		try {
			const ping = await fetch(`${relayBase}/${fixturePort}/ping`, { headers: { 'x-probe': 'relay-test' } })
			record({
				step: 'relay-plain',
				status: ping.status,
				body: await ping.json(),
				responseHeader: ping.headers.get('x-fixture'),
			})
		} catch (error) {
			record({ step: 'relay-plain', error: String((error && error.message) || error) })
		}
		try {
			const echo = await fetch(`${relayBase}/${fixturePort}/echo`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hello: 'fixture' }),
			})
			record({ step: 'relay-post-body', status: echo.status, body: await echo.json() })
		} catch (error) {
			record({ step: 'relay-post-body', error: String((error && error.message) || error) })
		}
		try {
			// Arrival times are the point: a relay that buffered the body would
			// deliver every event in one read at the end.
			const started = Date.now()
			const sse = await fetch(`${relayBase}/${fixturePort}/sse`)
			const sessionHeader = sse.headers.get('mcp-session-id')
			const contentType = sse.headers.get('content-type')
			const reader = sse.body.getReader()
			const decoder = new TextDecoder()
			const arrivals = []
			let text = ''
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				arrivals.push(Date.now() - started)
				text += decoder.decode(value, { stream: true })
			}
			record({
				step: 'relay-sse',
				status: sse.status,
				contentType,
				sessionHeader,
				events: (text.match(/^event: tick$/gm) ?? []).length,
				arrivals,
				elapsed: Date.now() - started,
				streamed: arrivals.length > 1 && arrivals[arrivals.length - 1] - arrivals[0] > 400,
			})
		} catch (error) {
			record({ step: 'relay-sse', error: String((error && error.message) || error) })
		}
		for (const [label, url] of [
			['relay-port-denied', `http://127.0.0.1:${serverPort}/client-relay/${relaySecret}/1234/ping`],
			['relay-unknown-secret', `http://127.0.0.1:${serverPort}/client-relay/not-a-real-secret/${fixturePort}/ping`],
		]) {
			try {
				const denied = await fetch(url)
				record({ step: label, status: denied.status, body: await denied.json() })
			} catch (error) {
				record({ step: label, error: String((error && error.message) || error) })
			}
		}

		// ── 3. Client execution: cwd must be the translated visible path ───────
		const bound = await attemptSpawn('client-execution', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])
		record({
			step: 'client-execution-verdict',
			ranOnClient: !!bound.parsed && bound.parsed.cwd === visiblePath,
			cwdMatchesVisiblePath: bound.parsed?.cwd === visiblePath,
			serverPathWouldBe: serverCwd,
		})

		// ── 3b. argv[0] naming a path that only exists on the server ───────────
		// The engine resolves some binaries in its own world and hands the absolute
		// path straight to the seam. A machine holding the program elsewhere must
		// still run it; a machine with no equivalent must say which program is
		// missing rather than surfacing a bare ENOENT.
		await attemptSpawn('argv0-server-only-path', serverCwd, ['C:\\no-such-dir\\node.exe', '-e', IDENTITY_SCRIPT])
		await attemptSpawn('argv0-unresolvable', serverCwd, ['C:\\no-such-dir\\no-such-program-xyz.exe'])

		// ── 3c. Interactive terminal on the bound machine (plan P3) ────────────
		// A PTY is interactive, so the proof is a command typed in and its answer
		// read back: the reported location must be the translated visible path, and
		// the answer can only arrive over the socket.
		let terminalText = ''
		try {
			const terminal = await ctx.subprocess.spawnTerminal({
				argv: ['powershell.exe', '-NoLogo', '-NoProfile'],
				cwd: serverCwd,
				env: {},
				rows: 24,
				cols: 100,
				graceMs: 3000,
			})
			terminal.output.on('data', (chunk) => { terminalText += chunk.toString('utf8') })
			await sleep(2500)
			await terminal.write("Write-Output 'TERM-MARKER'; (Get-Location).Path\r")
			await sleep(2500)
			record({
				step: 'terminal-interactive',
				ok: true,
				pid: terminal.pid,
				sawMarker: terminalText.includes('TERM-MARKER'),
				sawTranslatedPath: terminalText.includes(visiblePath),
				sawServerPath: terminalText.includes(serverCwd),
				bytes: terminalText.length,
				tail: terminalText.slice(-220),
			})
			record({ step: 'terminal-inspect-foreground', value: (await terminal.inspectForeground()) ?? null })
			const startedAtTerm = Date.now()
			await terminal.terminate()
			record({ step: 'terminal-terminated', ms: Date.now() - startedAtTerm, settled: await terminal.waitForExit() })
		} catch (error) {
			record({ step: 'terminal-interactive', ok: false, error: String((error && error.message) || error) })
		}

		// ── 3d. python REPL in the ConPTY (plan P3 acceptance names it) ───────
		// A REPL is a stricter test than `powershell -Command`: it reads from the
		// terminal line by line and prints each result, so a successful round trip
		// proves interactive stdin really reaches the remote program. `os.getcwd()`
		// is read by Python itself from the OS, so it reports the cwd the child was
		// actually started with rather than anything the harness passed along.
		try {
			const repl = await ctx.subprocess.spawnTerminal({
				argv: [pythonPath, '-i'],
				cwd: serverCwd,
				rows: 24,
				cols: 100,
				graceMs: 3000,
			})
			let replText = ''
			repl.output.on('data', (chunk) => { replText += chunk.toString('utf8') })
			await sleep(3500)
			await repl.write('import os; print("REPL-MARKER", os.getcwd())\r')
			await sleep(3500)
			record({
				step: 'terminal-python-repl',
				ok: true,
				sawBanner: /Python 3\./.test(replText),
				sawMarker: replText.includes('REPL-MARKER'),
				sawTranslatedPath: replText.includes(visiblePath),
				sawServerPath: replText.includes(serverCwd),
				bytes: replText.length,
				tail: replText.slice(-260),
			})
			await repl.terminate()
			record({ step: 'terminal-python-terminated', settled: await repl.waitForExit() })
		} catch (error) {
			record({ step: 'terminal-python-repl', ok: false, error: String((error && error.message) || error) })
		}

		// ── 3e. stdin reaches the remote child ────────────────────────────────
		// `stdio.stdin = { data }` is written to the child's stdin on the far side
		// of the socket, so the payload surviving into the child's stdout proves the
		// bytes crossed, not merely that a stream was configured.
		try {
			const payload = 'STDIN-PAYLOAD-' + Date.now()
			const echo = ctx.subprocess.spawn({
				argv: [process.execPath, '-e',
					'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("GOT:"+d))'],
				cwd: serverCwd,
				stdio: { stdin: { data: payload }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
				graceMs: 5000,
			})
			const outcome = await echo.done
			const text = echo.collected.stdout?.readFrom(0).text ?? ''
			record({
				step: 'stdin-roundtrip',
				ok: true,
				sent: payload,
				sawPayload: text.includes(payload),
				exitCode: outcome.exitCode,
				stdout: text.slice(0, 120),
			})
		} catch (error) {
			record({ step: 'stdin-roundtrip', ok: false, error: String((error && error.message) || error) })
		}

		// ── 3f. stdout beyond the in-memory cap spills to a whole-stream file ──
		// The spill file is the only complete copy once the retained tail has slid
		// past the reader's offset, so its SIZE is the assertion: a 300 KB stream
		// must land complete even though only `maxBytes` stays in memory.
		try {
			const total = 300000
			const spill = ctx.subprocess.spawn({
				argv: [process.execPath, '-e', `process.stdout.write("S".repeat(${total}))`],
				cwd: serverCwd,
				stdio: {
					stdin: 'ignore',
					stdout: { maxBytes: 4096, spill: { maxBytes: 2000000 } },
					stderr: { maxBytes: 4096 },
				},
				graceMs: 10000,
			})
			const outcome = await spill.done
			const read = spill.collected.stdout.readFrom(0)
			let spillBytes = null
			if (typeof read.spillPath === 'string') {
				try { spillBytes = statSync(read.spillPath).size } catch { spillBytes = null }
			}
			record({
				step: 'stdout-spill',
				ok: true,
				exitCode: outcome.exitCode,
				inMemoryBytes: read.text.length,
				lossy: read.lossy,
				spillPath: read.spillPath ?? null,
				spillBytes,
				complete: spillBytes === total,
			})
		} catch (error) {
			record({ step: 'stdout-spill', ok: false, error: String((error && error.message) || error) })
		}

		// ── 4. Termination settles instead of hanging (plan P2 acceptance) ────
		// P2 requires that timeout termination leave no orphan processes, provable
		// with `tasklist`. Killing only the direct child would leave the child's own
		// child running and still look "settled", so the payload spawns a GRANDCHILD
		// and prints its pid: the pid is what the assertion actually tests.
		const startedAt = Date.now()
		try {
			const payload = 'const {spawn}=require("node:child_process");'
				+ 'const g=spawn(process.execPath,["-e","setTimeout(()=>{},600000)"],{stdio:"ignore"});'
				+ 'process.stdout.write(String(g.pid));'
				+ 'setTimeout(()=>{},600000)'
			const long = ctx.subprocess.spawn({
				argv: [process.execPath, '-e', payload],
				cwd: serverCwd,
				stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
				graceMs: 3000,
			})
			await sleep(1500)
			const grandchildPid = Number((long.collected.stdout?.readFrom(0).text ?? '').trim())
			long.terminate()
			const settled = await Promise.race([
				long.done.then(() => true, () => true),
				sleep(15000).then(() => false),
			])
			await sleep(1500)
			let grandchildAlive = null
			if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
				try { process.kill(grandchildPid, 0); grandchildAlive = true } catch { grandchildAlive = false }
			}
			record({
				step: 'termination',
				settledWithin15s: settled,
				ms: Date.now() - startedAt,
				grandchildPid: Number.isInteger(grandchildPid) ? grandchildPid : null,
				grandchildAlive,
			})
		} catch (error) {
			record({ step: 'termination', error: String((error && error.message) || error) })
		}

		// ── 5. Release restores server execution ──────────────────────────────
		record({ step: 'release', result: await bindings.release({ workspaceId, username }) })
		await sleep(reindexMs)
		await attemptSpawn('after-release-server-execution', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])

		// ── 6. Executor authorization endpoint (plan §2.5) ────────────────────
		// The page driving this runs on the user's machine, so the endpoint must
		// take the account from the authentication plugin's verified session. With
		// no such service mounted it must refuse — and must NOT believe the
		// `x-dsh-user` header this sends, which is what a naive implementation
		// would trust.
		const authBase = `http://127.0.0.1:${serverPort}/client-auth`
		const jsonHeaders = { 'content-type': 'application/json' }
		if (loginUser) {
			// ── Gated flow: the profile mounts dsh-remote's login gate ──────────
			const serverBase = `http://127.0.0.1:${serverPort}`
			let cookie = ''
			try {
				const signedIn = await fetch(`${serverBase}/auth/login`, {
					method: 'POST',
					headers: jsonHeaders,
					body: JSON.stringify({ username: loginUser, password: loginPassword }),
				})
				cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]
				record({ step: 'gate-login', status: signedIn.status, gotCookie: cookie.length > 0 })
			} catch (error) {
				record({ step: 'gate-login', error: String((error && error.message) || error) })
			}
			try {
				// A gated route with no cookie must be refused: without this the
				// relay's own 200 below would prove nothing about a bypass.
				const refused = await fetch(`${authBase}/state`)
				record({ step: 'gate-active-without-cookie', status: refused.status })
			} catch (error) {
				record({ step: 'gate-active-without-cookie', error: String((error && error.message) || error) })
			}
			let issued = ''
			try {
				const minted = await fetch(`${authBase}/login`, {
					method: 'POST',
					headers: { ...jsonHeaders, cookie },
					body: JSON.stringify({ label: 'probe-executor' }),
				})
				const payload = await minted.json()
				issued = typeof payload.token === 'string' ? payload.token : ''
				record({
					step: 'gate-mint-executor-token',
					status: minted.status,
					gotToken: issued.length > 0,
					username: payload.username ?? null,
					workspaces: Array.isArray(payload.workspaces) ? payload.workspaces.length : null,
					heartbeatMs: payload.heartbeatMs ?? null,
				})
			} catch (error) {
				record({ step: 'gate-mint-executor-token', error: String((error && error.message) || error) })
			}
			if (issued) {
				try {
					// The token the login flow minted must work where the configured
					// one does: same resolution path, different provenance.
					const state = await fetch(`${authBase}/state`, { headers: { authorization: `Bearer ${issued}` } })
					const payload = await state.json()
					record({ step: 'gate-issued-token-state', status: state.status, username: payload.username, label: payload.label })
				} catch (error) {
					record({ step: 'gate-issued-token-state', error: String((error && error.message) || error) })
				}
			}

			// ── Admin surface: the second manual exit (plan §2.1) ──────────────
			// It exists for a machine that is alive and holding a workspace while
			// its user has walked away, so it must act on somebody else's binding
			// and must not be available to a non-admin.
			const adminBase = `${serverBase}/client-admin`
			if (viewerUser) {
				try {
					const viewerLogin = await fetch(`${serverBase}/auth/login`, {
						method: 'POST',
						headers: jsonHeaders,
						body: JSON.stringify({ username: viewerUser, password: viewerPassword }),
					})
					const viewerCookie = (viewerLogin.headers.get('set-cookie') ?? '').split(';')[0]
					const refused = await fetch(`${adminBase}/bindings`, { headers: { cookie: viewerCookie } })
					record({
						step: 'admin-viewer-refused',
						loginStatus: viewerLogin.status,
						status: refused.status,
						body: await refused.json(),
					})
				} catch (error) {
					record({ step: 'admin-viewer-refused', error: String((error && error.message) || error) })
				}
			}
			try {
				const listed = await fetch(`${adminBase}/bindings`, { headers: { cookie } })
				const payload = await listed.json()
				record({
					step: 'admin-bindings',
					status: listed.status,
					actor: payload.actor ?? null,
					count: Array.isArray(payload.bindings) ? payload.bindings.length : null,
					states: Array.isArray(payload.bindings) ? payload.bindings.map((b) => `${b.workspaceTitle}=${b.state}/${b.username}`) : null,
				})
			} catch (error) {
				record({ step: 'admin-bindings', error: String((error && error.message) || error) })
			}
			// Re-bind as the executor account, then have the admin force it loose:
			// releasing an ACTIVE binding is the case the occupant's own page
			// cannot cover.
			try {
				const reBound = await fetch(`${authBase}/bind`, {
					method: 'POST',
					headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
					body: JSON.stringify({ workspaceId, machine: 'probe-executor', visiblePath, stagingDir: 'C:\\dsh-staging' }),
				})
				record({ step: 'admin-prebind', status: reBound.status })
			} catch (error) {
				record({ step: 'admin-prebind', error: String((error && error.message) || error) })
			}
			try {
				const forced = await fetch(`${adminBase}/unbind`, {
					method: 'POST',
					headers: { ...jsonHeaders, cookie },
					body: JSON.stringify({ workspaceId }),
				})
				record({ step: 'admin-force-unbind', status: forced.status, body: await forced.json() })
			} catch (error) {
				record({ step: 'admin-force-unbind', error: String((error && error.message) || error) })
			}
			// The occupant's own release must now be refused: the binding is gone.
			try {
				const late = await fetch(`${authBase}/unbind`, {
					method: 'POST',
					headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
					body: JSON.stringify({ workspaceId }),
				})
				record({ step: 'occupant-release-after-force', status: late.status })
			} catch (error) {
				record({ step: 'occupant-release-after-force', error: String((error && error.message) || error) })
			}
		} else {
			// Ungated profile: the endpoint must refuse rather than believe the
			// `x-dsh-user` header this sends, which is what a naive implementation
			// would trust.
			try {
				const refused = await fetch(`${authBase}/login`, {
					method: 'POST',
					headers: { ...jsonHeaders, 'x-dsh-user': 'nobody', 'x-dsh-role': 'admin' },
					body: JSON.stringify({ label: 'probe' }),
				})
				record({ step: 'auth-login-fail-closed', status: refused.status, body: await refused.json() })
			} catch (error) {
				record({ step: 'auth-login-fail-closed', error: String((error && error.message) || error) })
			}
		}
		try {
			const state = await fetch(`${authBase}/state`, { headers: { authorization: `Bearer ${configuredToken}` } })
			const payload = await state.json()
			record({ step: 'auth-state', status: state.status, username: payload.username, connected: payload.connected })
		} catch (error) {
			record({ step: 'auth-state', error: String((error && error.message) || error) })
		}
		try {
			const bad = await fetch(`${authBase}/state`, { headers: { authorization: 'Bearer not-a-real-token' } })
			record({ step: 'auth-bad-token', status: bad.status, body: await bad.json() })
		} catch (error) {
			record({ step: 'auth-bad-token', error: String((error && error.message) || error) })
		}
		try {
			const bound = await fetch(`${authBase}/bind`, {
				method: 'POST',
				headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
				body: JSON.stringify({
					workspaceId,
					machine: 'probe-executor',
					visiblePath,
					stagingDir: 'C:\\dsh-staging',
				}),
			})
			const payload = await bound.json()
			record({
				step: 'auth-bind',
				status: bound.status,
				ok: payload.ok,
				visiblePath: payload.binding?.visiblePath ?? null,
				bindingCount: Array.isArray(payload.bindings) ? payload.bindings.length : null,
			})
		} catch (error) {
			record({ step: 'auth-bind', error: String((error && error.message) || error) })
		}
		// The endpoint must have told the executor, or the binding would lapse on
		// its grace clock and the spawn below would land on the server.
		await sleep(reindexMs)
		await attemptSpawn('after-auth-bind-client-execution', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])

		// ── permission consistency (plan §2.1, §4.5) ─────────────────────────
		// The binding made above belongs to the token's account. The owners file
		// maps one fixture session to that same account and another to a different
		// one, so these four spawns are what a shell call from each account would
		// produce. Only the occupant's session may reach the bound machine; every
		// other session treats the workspace as unbound and runs on the server.
		if (ownSession && foreignSession) {
			await attemptSpawn('perm-occupant-session', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT], { DSH_SESSION_ID: ownSession })
			await attemptSpawn('perm-foreign-session', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT], { DSH_SESSION_ID: foreignSession })
			await attemptSpawn('perm-unknown-session', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT], { DSH_SESSION_ID: 'sess-absent-from-owners' })
			await attemptSpawn('perm-no-session-identity', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])
		}
		try {
			const released = await fetch(`${authBase}/unbind`, {
				method: 'POST',
				headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
				body: JSON.stringify({ workspaceId }),
			})
			record({ step: 'auth-unbind', status: released.status, body: await released.json() })
		} catch (error) {
			record({ step: 'auth-unbind', error: String((error && error.message) || error) })
		}
		try {
			const bogus = await fetch(`${authBase}/bind`, {
				method: 'POST',
				headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
				body: JSON.stringify({ workspaceId: 'no-such-workspace', visiblePath, stagingDir: '' }),
			})
			record({ step: 'auth-bind-unknown-workspace', status: bogus.status, body: await bogus.json() })
		} catch (error) {
			record({ step: 'auth-bind-unknown-workspace', error: String((error && error.message) || error) })
		}

		// ── 7. Disconnect semantics (plan §4.5 / §4.6, and the P3 crashtest) ──
		// The executor is killed from outside while a child and a terminal are live.
		// §4.6 requires the in-flight call to reach a definite end (failure, not a
		// hang) and §4.5 requires a later call on a still-bound workspace to FAIL
		// LOUDLY rather than quietly run on the server -- a silent fallback would
		// tell the agent its command ran on the user's machine when it did not.
		if (crashMarker) {
			const crashClaim = await bindings.claim({
				workspaceId,
				workspaceTitle,
				username,
				machine: 'probe-executor',
				visiblePath,
				stagingDir: 'C:\\dsh-staging',
			})
			if (crashClaim.ok) {
				dispatcher.transport.notifyBindApply(username, crashClaim.binding, bindings.heartbeatMs)
			}
			await sleep(reindexMs)

			let long
			try {
				long = ctx.subprocess.spawn({
					argv: [process.execPath, '-e', 'setTimeout(() => {}, 120000)'],
					cwd: serverCwd,
					stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
					graceMs: 3000,
				})
			} catch (error) {
				record({ step: 'crash-long-spawn', error: String((error && error.message) || error) })
			}

			let terminal
			try {
				terminal = await ctx.subprocess.spawnTerminal({
					argv: ['powershell.exe', '-NoLogo', '-NoProfile'],
					cwd: serverCwd,
					rows: 30,
					cols: 100,
					graceMs: 5000,
				})
			} catch (error) {
				record({ step: 'crash-terminal-spawn', error: String((error && error.message) || error) })
			}

			record({
				step: 'crash-armed',
				hasChild: long !== undefined,
				hasTerminal: terminal !== undefined,
				routes: (dispatcher.routes ?? []).map((route) => `${route.title}=${route.target}`),
			})
			try { writeFileSync(crashMarker, String(Date.now())) } catch { /* harness may poll it */ }

			if (long) {
				const startedAt = Date.now()
				const outcome = await Promise.race([
					long.done.then(() => 'settled', (error) => 'rejected: ' + String(error?.message ?? error)),
					sleep(30000).then(() => 'HUNG'),
				])
				record({ step: 'crash-inflight-spawn', outcome, ms: Date.now() - startedAt })
			}

			if (terminal) {
				const startedAt = Date.now()
				const outcome = await Promise.race([
					terminal.terminate().then(() => 'terminated', (error) => 'rejected: ' + String(error?.message ?? error)),
					sleep(15000).then(() => 'HUNG'),
				])
				record({ step: 'crash-terminal-terminate', outcome, ms: Date.now() - startedAt })
			}

			// The binding must still be live here, or the next spawn would legitimately
			// run on the server and the check below would prove nothing.
			record({ step: 'crash-binding-active', active: !!bindings.activeFor(workspaceId) })
			await attemptSpawn('crash-offline-spawn', serverCwd, [process.execPath, '-e', IDENTITY_SCRIPT])
		}

		record({ event: 'probe-complete' })
	}

	const timer = setTimeout(() => { void run() }, 500)
	if (typeof timer.unref === 'function') timer.unref()
	ctx.effect(() => () => clearTimeout(timer), 'subprocess-probe: scenario run')
}
