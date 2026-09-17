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
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
	/**
	 * When set, the probe drives the sweep-vs-claim interleaving (§4.2 arbitration).
	 * It needs binding records that lapse quickly and are not swept on their own,
	 * which is a property of the profile's `client-bindings` config, not of the probe.
	 */
	const sweepRaceTest = config?.sweepRaceTest === true
	/** How long to wait for the seeded records to lapse before racing the sweep. */
	const sweepRaceLapseMs = Number.isInteger(config?.sweepRaceLapseMs) ? config.sweepRaceLapseMs : 1200
	const resultPath = typeof config?.resultPath === 'string' ? config.resultPath : undefined

	const record = (entry) => {
		if (!resultPath) return
		try {
			appendFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
		} catch { /* the probe's own result file is diagnostic only */ }
	}
	const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

	/** Spawn through the real dispatcher and report what came back. */
	const attemptSpawn = async (label, cwd, argv, env, expectation = {}) => {
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
			// Which machine ran it is read from what the CHILD reported about itself, not
			// from the routing index: permission consistency can still refuse a binding,
			// so the index can say `client` while the child ran on the server.
			//
			// The comparison is boundary-aware rather than an equality test. A cwd below
			// the workspace (a session opened in a subfolder, a `cd`-shaped workflow)
			// reports `<visible>\sub`, which is on the client too -- an equality test
			// labelled exactly those rows `server`, which reads as a routing failure.
			const underVisible = typeof parsed?.cwd === 'string' && visiblePath.length > 0
				&& (parsed.cwd.toLowerCase() === visiblePath.toLowerCase()
					|| parsed.cwd.toLowerCase().startsWith(`${visiblePath.toLowerCase()}\\`)
					|| parsed.cwd.toLowerCase().startsWith(`${visiblePath.toLowerCase()}/`))
			record({
				step: label,
				ok: true,
				// The routing index reports the BINDING; permission consistency can
				// still refuse that binding, so the executed machine is read from what
				// the child itself reported rather than from the index.
				boundTarget: route?.target ?? 'server',
				executedOn: parsed?.cwd === undefined ? null : (underVisible ? 'client' : 'server'),
				handlePid: handle.pid,
				exitCode: outcome.exitCode,
				parsed,
				stderr: stderr.slice(0, 300),
				ms: Date.now() - started,
			})
			return { handle, stdout, parsed }
		} catch (error) {
			// A caller that knows this spawn must fail records it as a satisfied
			// expectation: a deliberate negative that counted as an unexpected failure
			// would drown the checklist's "which rows failed" signal. The message comes
			// back as a STRING — returning the Error object made every caller's
			// `typeof result.error === 'string'` assertion silently false.
			const message = String((error && error.message) || error)
			const expectedFailure = expectation.expectFailure === true
			record({ step: label, ok: expectedFailure, expectedFailure, error: message, ms: Date.now() - started })
			return { error: message }
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

		// A binding names a machine. The probe claims on behalf of whichever machine is
		// connected, which is how the production path works: the Web UI asks the server
		// which machines are online and binds one of them.
		const machineId = dispatcher.transport?.machineIds?.()[0] ?? ''
		record({ step: 'bound-machine', machineId })
		const claim = await bindings.claim({
			workspaceId,
			workspaceTitle,
			username,
			machineId,
			machine: 'probe-executor',
			visiblePath,
			stagingDir: 'C:\\dsh-staging',
		})
		record({ step: 'claim-with-visible-path', result: claim })
		// The claim -> bind.apply step belongs to the P1 authorization endpoint,
		// which does not exist yet, so the harness sends it. Without it the
		// executor never heartbeats and the binding lapses mid-test.
		if (claim.ok) {
			const sent = dispatcher.transport.notifyBindApply(machineId || username, claim.binding, bindings.heartbeatMs)
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
			// Staging is the section's other load-bearing claim, and it is conditional
			// on the binding naming a directory: the skill tells the agent to use "the
			// staging directory the prompt gives you", so a binding without one leaves
			// the agent holding instructions it cannot carry out.
			stagingDir: record2?.stagingDir ?? null,
			hasStagingGuidance: boundText.includes('## Working on large files'),
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
			// 3845 is in the allowlist but nothing listens on it. That is the real-world
			// case for Figma MCP: the desktop app is not running. The requirement is a
			// definite, explained failure — not a hang and not a bare 502 with no reason.
			['relay-upstream-dead', `http://127.0.0.1:${serverPort}/client-relay/${relaySecret}/3845/mcp`],
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

		// ── 3a. A cwd BELOW the workspace root ────────────────────────────────
		// The root case above is the easy one. Any cwd deeper than the workspace goes
		// through the prefix arithmetic instead (`visiblePath + cwd.slice(workspace
		// path length)`), and that is where an off-by-one at the boundary shows up as
		// a child running in the wrong directory -- which is exactly what a session
		// opened in a subfolder, or a `cd`-shaped workflow, would hit. The
		// subdirectory is created and removed by the client itself, so nothing
		// outside the workspace is touched even when the workspace is a real folder.
		const subName = 'probe-subdir'
		const subCwd = `${serverCwd}\\${subName}`
		const expectedSubCwd = `${visiblePath}\\${subName}`
		await attemptSpawn('subdir-setup', serverCwd, [process.execPath, '-e', `require('fs').mkdirSync(${JSON.stringify(subName)},{recursive:true})`])
		const subdir = await attemptSpawn('client-execution-subdir', subCwd, [process.execPath, '-e', IDENTITY_SCRIPT])
		record({
			step: 'client-execution-subdir-verdict',
			expected: expectedSubCwd,
			actual: subdir.parsed?.cwd ?? null,
			translatedSubdir: subdir.parsed?.cwd === expectedSubCwd,
		})
		await attemptSpawn('subdir-teardown', serverCwd, [process.execPath, '-e', `require('fs').rmSync(${JSON.stringify(subName)},{recursive:true,force:true})`])

		// ── 3a2. A working directory that does not exist on the client ─────────
		// Node reports a missing program and an unreachable working directory with the
		// same text — `spawn <program> ENOENT` — and names only the program, so the
		// obvious reading ("that program is not installed here") is the wrong one when
		// the share behind the cwd is gone. This drives that failure on purpose: the
		// path is real enough to route to the client (it is under the workspace) but
		// its last components do not exist, which is exactly the shape of a share that
		// is offline or has lost its credential.
		const missing = await attemptSpawn('client-cwd-missing', `${serverCwd}\\no-such-subdir\\deeper`, [process.execPath, '-e', IDENTITY_SCRIPT], undefined, { expectFailure: true })
		record({
			step: 'client-cwd-missing-verdict',
			// Named `message`, not `error`: a row carrying `error` reads as a FAILURE to
			// anyone scanning the result file, and this one is the assertion.
			message: missing.error ?? null,
			namesTheWorkingDirectory: typeof missing.error === 'string' && missing.error.includes('is not reachable from this machine'),
		})

		// ── 3b. What routing a command to the client costs per call (plan §4.8) ─
		// Both paths run the same child on the same machine here, so CPU and disk
		// cancel out: the difference between the two medians is the dispatcher plus
		// WebSocket round trip **alone**. A real client machine adds its own LAN
		// round trip (well under a millisecond on a wired LAN), so this is a lower
		// bound, and it is the number to quote for "does the client world make my
		// commands slower".
		const timeSpawn = async (cwd) => {
			const started = Date.now()
			await ctx.subprocess.spawn({
				argv: [process.execPath, '-e', IDENTITY_SCRIPT],
				cwd,
				stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
				graceMs: 3000,
			}).done
			return Date.now() - started
		}
		const stats = (runs) => {
			const sorted = [...runs].sort((a, b) => a - b)
			return { samples: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] }
		}
		try {
			const unbound = ctx.get('workspaceRegistry')?.list().find((candidate) => candidate.title !== workspaceTitle)
			const clientRuns = []
			for (let index = 0; index < 8; index += 1) clientRuns.push(await timeSpawn(serverCwd))
			const serverRuns = []
			for (let index = 0; unbound !== undefined && index < 8; index += 1) serverRuns.push(await timeSpawn(unbound.path))
			record({
				step: 'spawn-latency',
				note: 'same machine on both paths, so the gap is the client transport itself',
				clientPath: serverCwd,
				serverPath: unbound?.path ?? null,
				client: stats(clientRuns),
				server: serverRuns.length > 0 ? stats(serverRuns) : null,
			})
		} catch (error) {
			record({ step: 'spawn-latency', error: String((error && error.message) || error) })
		}

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

		// ── 3g. A stream that outgrows the spill cap must not be offered as complete ──
		// The seam says a spill holding a whole-stream byte cap is discarded once the
		// stream passes it. Two things have to hold: the reader must NOT be handed a
		// path to a partial file (a caller would take it as the complete output), and
		// the partial file must not be left on disk. The second is the one the engine's
		// own provider handles explicitly, so it is worth checking rather than assuming.
		try {
			const spillDir = join(tmpdir(), 'dsh-remote-spill')
			const listSpills = () => {
				try { return readdirSync(spillDir) } catch { return [] }
			}
			const before = new Set(listSpills())
			const total = 200000
			const overflow = ctx.subprocess.spawn({
				argv: [process.execPath, '-e', `process.stdout.write("T".repeat(${total}))`],
				cwd: serverCwd,
				stdio: {
					stdin: 'ignore',
					// The stream is 4x the cap, so the spill can never be complete.
					stdout: { maxBytes: 4096, spill: { maxBytes: 50000 } },
					stderr: { maxBytes: 4096 },
				},
				graceMs: 10000,
			})
			const outcome = await overflow.done
			const read = overflow.collected.stdout.readFrom(0)
			await sleep(300)
			const leaked = listSpills().filter((name) => !before.has(name))
			record({
				step: 'stdout-spill-overflow',
				ok: true,
				exitCode: outcome.exitCode,
				inMemoryBytes: read.text.length,
				lossy: read.lossy,
				spillPath: read.spillPath ?? null,
				advertisesNoSpill: read.spillPath === undefined,
				partialFilesLeftOnDisk: leaked,
				leakedAPartialSpill: leaked.length > 0,
			})
		} catch (error) {
			record({ step: 'stdout-spill-overflow', ok: false, error: String((error && error.message) || error) })
		}

		// ── 3h. Signals on a client terminal (§3.4's claims, never driven) ────
		// The status table has claimed "ConPTY 交互式终端（含 Ctrl-C 中断）" for many
		// rounds, but nothing ever called `signalForeground`. Two things are asserted
		// there and both are checkable: the refusals (SIGKILL, and anything Windows has
		// no console equivalent for) and the one signal that must genuinely work.
		// Ctrl-C counts as working only if the command it interrupted never finished
		// AND the session stayed usable afterwards -- a signal that kills the terminal
		// would satisfy the first half alone.
		try {
			const term = await ctx.subprocess.spawnTerminal({
				argv: ['powershell.exe', '-NoLogo', '-NoProfile'],
				cwd: serverCwd,
				rows: 24,
				cols: 100,
				graceMs: 5000,
			})
			let termText = ''
			term.output.on('data', (chunk) => { termText += chunk.toString('utf8') })
			await sleep(2500)

			const attempt = async (signal) => {
				try { return { signal, ok: true, pid: await term.signalForeground(signal) } }
				catch (error) { return { signal, ok: false, error: String((error && error.message) || error) } }
			}
			const refusedKill = await attempt('SIGKILL')
			const refusedHup = await attempt('SIGHUP')

			// Echo-proof markers: the command prints a RANDOM GUID, so that value can
			// only exist in the output if the command actually executed. Matching a
			// literal was unreliable -- a PTY echoes what is typed and re-renders string
			// literals with colour escapes, so the same text appeared in one run and not
			// in the next, which is how a broken assertion looks like a passing one.
			const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
			const printGuid = 'Write-Output ([guid]::NewGuid().ToString())\r'

			await term.write(`Start-Sleep -Seconds 120; ${printGuid}`)
			await sleep(1500)
			const sentInt = await attempt('SIGINT')
			await sleep(3000)
			const guidAfterInterrupt = GUID.test(termText)
			// A separate command: it prints only if the session is still alive.
			await term.write(printGuid)
			await sleep(3000)

			record({
				step: 'terminal-signals',
				refusedKill,
				refusedHup,
				sentInt,
				interruptedTheCommand: !guidAfterInterrupt,
				sessionSurvivedAndUsable: GUID.test(termText),
				bytes: termText.length,
			})

			await term.terminate()
			const afterTerminate = await attempt('SIGINT')
			record({ step: 'terminal-signal-after-terminate', afterTerminate })
		} catch (error) {
			record({ step: 'terminal-signals', ok: false, error: String((error && error.message) || error) })
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

		// ── 5b. Concurrent claims resolve to exactly one winner (§4.2) ────────
		// The plan requires the server to arbitrate: "两台设备同时抢一个已失效的绑定，
		// 先到者成功，另一个收到拒绝". A race is exactly the claim that passes by luck,
		// so it is driven deliberately: five claims are enqueued in the same tick, and
		// the assertion is that ONE wins and the rest are told who took it.
		try {
			await bindings.release({ workspaceId, username })
			const attempts = 5
			const results = await Promise.all(Array.from({ length: attempts }, (_, index) => bindings.claim({
				workspaceId,
				workspaceTitle,
				username: `racer-${index}`,
				machine: `machine-${index}`,
				visiblePath: `\\\\probe-host\\share-${index}`,
				stagingDir: `C:\\probe-staging-${index}`,
			})))
			const winners = results.filter((result) => result.ok)
			const loserReasons = results.filter((result) => !result.ok).map((result) => `${result.reason}${result.occupant ? `:${result.occupant}` : ''}`)
			record({
				step: 'concurrent-claim-race',
				attempts,
				winners: winners.length,
				exactlyOne: winners.length === 1,
				winner: winners[0]?.binding?.username ?? null,
				losersAllNameTheWinner: loserReasons.length === attempts - 1
					&& loserReasons.every((reason) => reason === `occupied:${winners[0]?.binding?.username}`),
				loserReasons,
			})
			// Leave the store as it was found.
			if (winners[0]) await bindings.release({ workspaceId, username: winners[0].binding.username })
		} catch (error) {
			record({ step: 'concurrent-claim-race', error: String((error && error.message) || error) })
		}

		// ── 5c. Does a sweep expire a binding claimed while it was running? ───
		// `sweep()` reads the table once, then finishes each lapsed record with an
		// `await` between them. Unlike `claim`/`heartbeat`/`release`, it does NOT run
		// through the mutation queue, so a claim can land inside that await -- and the
		// loop then finishes the SECOND workspace from its stale snapshot, re-reading
		// (in `finish`) the binding that was just written. This drives exactly that
		// interleaving and reports the end state, so the answer is measured rather
		// than argued. It needs a profile whose binding records lapse quickly and are
		// not swept on their own (see the pilot profile's client-bindings config).
		if (sweepRaceTest) {
			const w1 = 'sweep-race-1'
			const w2 = 'sweep-race-2'
			const seed = { workspaceTitle: 'sweep-race', username: 'sweep-stale', machine: 'm1', visiblePath: 'C:\\probe-stale', stagingDir: 'C:\\probe-staging' }
			try {
				await bindings.claim({ workspaceId: w1, ...seed })
				await bindings.claim({ workspaceId: w2, ...seed })
				await sleep(sweepRaceLapseMs)
				record({
					step: 'sweep-race-seeded',
					w1Lapsed: !bindings.isLive(bindings.get(w1)),
					w2Lapsed: !bindings.isLive(bindings.get(w2)),
				})
				// One tick: start the sweep, then claim into the window it opens.
				const sweeping = bindings.sweep()
				const claiming = bindings.claim({
					workspaceId: w2, workspaceTitle: 'sweep-race', username: 'fresh-claimer',
					machine: 'm2', visiblePath: 'C:\\probe-fresh', stagingDir: 'C:\\probe-staging',
				})
				const claimed = await claiming
				const expiredByThisSweep = await sweeping
				const after = bindings.get(w2)
				record({
					step: 'sweep-race-result',
					claimOk: claimed.ok,
					finalUsername: after?.username ?? null,
					freshBindingEnded: !!after?.endedAt,
					endReason: after?.endReason ?? null,
					raceReproduced: claimed.ok === true && !!after?.endedAt,
					// The fix routes `sweep` through the mutation queue; this proves it still
					// expires what it is supposed to, rather than only that it stopped racing.
					sweepExpired: expiredByThisSweep,
					sweepStillExpires: Array.isArray(expiredByThisSweep) && expiredByThisSweep.includes(w1),
				})
				await bindings.release({ workspaceId: w1, username: 'sweep-stale' })
				await bindings.release({ workspaceId: w2, username: 'fresh-claimer' })
			} catch (error) {
				record({ step: 'sweep-race-result', error: String((error && error.message) || error) })
			}
		}

		// ── 5d. The binding-store semantics §2's table claims (§2.1's rules) ──
		// These were verified once, by hand, in an early round and then only asserted
		// in the table -- no step re-checked them, so a later change could break them
		// silently. They are the rules that decide what happens when a user walks away
		// with a machine still holding a workspace, so they belong in every run.
		//
		// This drives them on the profile's REAL grace window rather than a shortened
		// test one, so the wait below is as long as the grace period. That is worth the
		// seconds: a shortened window would test a configuration nothing runs.
		try {
			const sid = 'semantics-probe'
			const fresh = (username, machine) => ({
				workspaceId: sid, workspaceTitle: 'semantics-probe',
				username, machine, visiblePath: `\\\\probe-host\\${machine}`, stagingDir: 'C:\\probe-staging',
			})
			await bindings.claim(fresh('machine-a', 'A'))
			// Let it lapse without heart-beating it.
			await sleep(bindings.graceMs + 2000)

			// Plan §2.1: expiry is not deletion -- the record and the reason stay for
			// diagnosis, and only the "can be taken by someone else" part changes.
			const lapsedNotLive = !bindings.isLive(bindings.get(sid))
			const beforeMySweep = bindings.get(sid)
			const expiredIds = await bindings.sweep()
			const afterSweep = bindings.get(sid)
			record({
				step: 'binding-expiry-keeps-record',
				lapsedNotLive,
				// The profile sweeps on a timer, so the periodic sweep normally ends the
				// record long before this explicit call runs. `alreadyEndedBeforeMySweep`
				// is what tells the two apart; either way the assertions that matter are
				// the ones below.
				alreadyEndedBeforeMySweep: !!beforeMySweep?.endedAt,
				expiredByThisSweep: Array.isArray(expiredIds) && expiredIds.includes(sid),
				recordStillPresent: !!afterSweep,
				endedAtSet: !!afterSweep?.endedAt,
				endReason: afterSweep?.endReason ?? null,
			})

			// A machine that lapsed must not get its binding back by heart-beating:
			// reconnect is not preemption (§2.1).
			const revived = await bindings.heartbeat({ workspaceId: sid, username: 'machine-a' })
			// Another machine may take a lapsed binding directly, with no admin involved.
			const takeover = await bindings.claim(fresh('machine-b', 'B'))
			// Revoking an account's authorization drops what it holds (§2.5② ).
			const revoked = await bindings.revokeForUsername('machine-b')

			record({
				step: 'binding-semantics',
				graceMs: bindings.graceMs,
				revivalRefused: revived.ok === false && revived.reason === 'not-held',
				revivalReason: revived.reason ?? null,
				takeoverAllowed: takeover.ok === true,
				takeoverBy: takeover.binding?.username ?? null,
				revocationDropped: Array.isArray(revoked?.dropped) ? revoked.dropped.length : null,
				revokedMachines: (revoked?.dropped ?? []).map((entry) => entry.machine),
			})
			await bindings.release({ workspaceId: sid, username: 'machine-b' })
		} catch (error) {
			record({ step: 'binding-semantics', error: String((error && error.message) || error) })
		}

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

			// ── §2.5② : taking a workspace away from an account must stop execution ──
			// The binding store exposed `revokeForUsername` from the start and nothing
			// ever called it, so an account that lost a workspace kept executing on its
			// machine. This drives the real admin endpoint, because the gap was in the
			// wiring rather than in the store.
			try {
				const registry = ctx.get('workspaceRegistry')
				const other = (registry?.list?.() ?? []).find((workspace) => workspace.title !== workspaceTitle)
				if (other) {
					const otherId = String(other.id)
					const otherTitle = String(other.title)
					// A second account holds it, so this cannot disturb the probe's own binding.
					await bindings.claim({
						workspaceId: otherId, workspaceTitle: otherTitle,
						username: viewerUser, machine: 'probe-viewer-machine',
						visiblePath: 'C:\\probe-viewer', stagingDir: 'C:\\probe-staging',
					})
					const held = bindings.isLive(bindings.get(otherId))
					const grant = await fetch(`${serverBase}/auth/accounts`, {
						method: 'POST',
						headers: { ...jsonHeaders, cookie },
						body: JSON.stringify({ action: 'upsert', username: viewerUser, workspaces: [otherTitle] }),
					})
					// Now take it away by leaving the account with no workspaces at all.
					const revoke = await fetch(`${serverBase}/auth/accounts`, {
						method: 'POST',
						headers: { ...jsonHeaders, cookie },
						body: JSON.stringify({ action: 'upsert', username: viewerUser, workspaces: [] }),
					})
					await sleep(1500)
					const after = bindings.get(otherId)
					record({
						step: 'account-authorization-revokes-binding',
						workspace: otherTitle,
						heldBefore: held,
						grantStatus: grant.status,
						revokeStatus: revoke.status,
						stillLiveAfterRevoke: bindings.isLive(after),
						endedReason: after?.endReason ?? null,
					})
					await bindings.release({ workspaceId: otherId, username: viewerUser, force: true })
				} else {
					record({ step: 'account-authorization-revokes-binding', skipped: 'no second workspace in the registry' })
				}
			} catch (error) {
				record({ step: 'account-authorization-revokes-binding', error: String((error && error.message) || error) })
			}

			// ── §2.5③ : does deleting an account also kill its executor token? ──
			// The store exposes `revokeTokensForUsername` for exactly this, and like
			// `revokeForUsername` it had no caller. A binding that stops routing is one
			// thing; a token that still authenticates is another, because that machine
			// can simply bind again.
			try {
				const doomed = 'probe-doomed-token'
				const created = await fetch(`${serverBase}/auth/accounts`, {
					method: 'POST',
					headers: { ...jsonHeaders, cookie },
					body: JSON.stringify({ action: 'upsert', username: doomed, password: 'probe-doomed-pass-2026', role: 'user' }),
				})
				const issued = await bindings.issueToken({ username: doomed, label: 'doomed-machine' })
				const resolvesWhileAccountExists = dispatcher.transport.usernameForToken(issued.token) ?? null
				const removed = await fetch(`${serverBase}/auth/accounts`, {
					method: 'POST',
					headers: { ...jsonHeaders, cookie },
					body: JSON.stringify({ action: 'remove', username: doomed }),
				})
				await sleep(500)
				const resolvesAfterAccountRemoved = dispatcher.transport.usernameForToken(issued.token) ?? null
				record({
					step: 'account-removal-revokes-token',
					createStatus: created.status,
					removeStatus: removed.status,
					resolvesWhileAccountExists,
					resolvesAfterAccountRemoved,
					// The gap this checks for: a deleted account's machine still authenticating.
					tokenSurvivesAccountRemoval: resolvesAfterAccountRemoved !== null,
				})
				await bindings.revokeToken(issued.token)
			} catch (error) {
				record({ step: 'account-removal-revokes-token', error: String((error && error.message) || error) })
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
		// A binding is a promise that commands run in a real directory on a real
		// machine, and the two paths are what make that promise. Both spellings of
		// "not a path" must be refused where the record is written, not silently
		// accepted and then discovered by a child process that cannot start.
		for (const [label, submitted] of [['blank', ''], ['relative', 'some\\dir']]) {
			try {
				const rejected = await fetch(`${authBase}/bind`, {
					method: 'POST',
					headers: { ...jsonHeaders, authorization: `Bearer ${configuredToken}` },
					body: JSON.stringify({ workspaceId, visiblePath: submitted, stagingDir: 'C:\\dsh-staging' }),
				})
				record({ step: `auth-bind-rejects-${label}-visible-path`, status: rejected.status, body: await rejected.json() })
			} catch (error) {
				record({ step: `auth-bind-rejects-${label}-visible-path`, error: String((error && error.message) || error) })
			}
		}

		// ── 7. Disconnect semantics (plan §4.5 / §4.6, and the P3 crashtest) ──
		// The executor is killed from outside while a child and a terminal are live.
		// §4.6 requires the in-flight call to reach a definite end (failure, not a
		// hang) and §4.5 requires a later call on a still-bound workspace to FAIL
		// LOUDLY rather than quietly run on the server -- a silent fallback would
		// tell the agent its command ran on the user's machine when it did not.
		if (crashMarker) {
			const crashMachine = dispatcher.transport?.machineIds?.()[0] ?? ''
			const crashClaim = await bindings.claim({
				workspaceId,
				workspaceTitle,
				username,
				machineId: crashMachine,
				machine: 'probe-executor',
				visiblePath,
				stagingDir: 'C:\\dsh-staging',
			})
			if (crashClaim.ok) {
				dispatcher.transport.notifyBindApply(crashMachine || username, crashClaim.binding, bindings.heartbeatMs)
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
