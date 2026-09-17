/**
 * dsh-machine-probe — evidence that the machine tools really reach a machine.
 *
 * The tools are called through the REAL tools registry (`ctx.tools.execute`), by
 * name, exactly as the model reaches them; nothing here calls the transport
 * directly. What each step asserts is read from the process the machine itself
 * started:
 *
 * - the environment marker the executor was launched with reaches the child, and
 *   a server-side spawn cannot produce it;
 * - the working directory a call gets with no `cwd` is the home directory the
 *   executor reported at `hello`, not anything derived from the session;
 * - an expired budget leaves no process behind, proven by asking the machine
 *   afterwards whether the file that command would have written exists.
 *
 * The negative step is part of the check: an unknown machine must fail, and the
 * message must name the machines that are online.
 */
import { appendFileSync } from 'node:fs'

export const name = 'dsh-machine-probe'
export const inject = ['tools']

export function apply(ctx, config) {
	const resultPath = typeof config?.resultPath === 'string' ? config.resultPath : ''
	const waitMs = Number.isInteger(config?.waitMs) ? config.waitMs : 45000
	/** The marker value the executor under test was launched with. */
	const marker = String(config?.marker ?? '')

	const record = (entry) => {
		if (resultPath === '') return
		try {
			appendFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
		} catch {
			// The probe's result file is diagnostic only.
		}
	}
	const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

	/** Call one tool by name through the registry, the way the model does. */
	const call = async (name, args) => {
		const controller = new AbortController()
		try {
			const result = await ctx.tools.execute({
				callId: `machine-probe-${name}-${Date.now()}`,
				name,
				arguments: args,
				signal: controller.signal,
			})
			return {
				isError: result.isError === true,
				value: result.value,
				text: (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
				error: result.isError === true ? String(result.error?.message ?? JSON.stringify(result.error)) : undefined,
			}
		} catch (error) {
			return { isError: true, error: String((error && error.message) || error) }
		}
	}

	/** `node -e` script printing one JSON object about the process that runs it. */
	const identityScript = 'process.stdout.write(JSON.stringify({'
		+ 'cwd:process.cwd(),host:require("node:os").hostname(),user:require("node:os").userInfo().username,'
		+ 'marker:process.env.CLIENT_MACHINE_PROBE_MARKER??null,pid:process.pid}))'

	const run = async () => {
		// The dispatcher registers the tools when the tools registry it depends on
		// appears, which settles after this plugin's own apply. Waiting for them is
		// what a session does too: it starts later than both.
		const registrationDeadline = Date.now() + 20000
		let registered = []
		for (;;) {
			registered = ['machine_list', 'machine_run'].filter((name) => ctx.tools.get(name) !== undefined)
			if (registered.length === 2 || Date.now() >= registrationDeadline) break
			await sleep(500)
		}
		record({ step: 'tools-registered', registered, ok: registered.length === 2 })
		if (registered.length !== 2) {
			record({ event: 'machine-probe-complete' })
			return
		}

		// 1) Wait for a machine. Polling the real tool also shows the empty answer a
		//    session gets before anyone opens the executor.
		const deadline = Date.now() + waitMs
		let listed
		let sleptOnce = false
		for (;;) {
			listed = await call('machine_list', {})
			if (listed.isError || (listed.value?.count ?? 0) > 0) break
			if (Date.now() >= deadline) break
			if (!sleptOnce) {
				record({ step: 'machine-list-empty', value: listed.value, text: listed.text })
				sleptOnce = true
			}
			await sleep(2000)
		}
		const machine = listed?.value?.machines?.[0]
		record({ step: 'machine-list', ok: !!machine, count: listed?.value?.count ?? 0, machine, error: listed?.error })

		if (!machine) {
			record({ event: 'machine-probe-complete', reason: 'no machine connected' })
			return
		}

		// 2) Run with no cwd: the working directory must be the one the executor
		//    reported at hello, and the child must see the executor's environment.
		const identity = await call('machine_run', { machine: machine.machine, argv: ['node', '-e', identityScript] })
		let parsed
		try { parsed = JSON.parse(String(identity.value?.stdout ?? '').trim()) } catch { parsed = undefined }
		record({
			step: 'machine-run-identity',
			ok: !identity.isError && parsed !== undefined
				&& parsed.marker === marker
				&& typeof machine.home === 'string' && machine.home !== ''
				&& parsed.cwd.toLowerCase() === machine.home.toLowerCase(),
			isError: identity.isError,
			exitCode: identity.value?.exitCode,
			cwd: identity.value?.cwd,
			reportedHome: machine.home,
			parsed,
			expectedMarker: marker,
			text: identity.text,
			error: identity.error,
		})

		// 3) An explicit cwd on that machine is honoured.
		const dir = machine.home
		const inDir = await call('machine_run', { machine: machine.machine, argv: ['node', '-e', identityScript], cwd: dir })
		let parsedInDir
		try { parsedInDir = JSON.parse(String(inDir.value?.stdout ?? '').trim()) } catch { parsedInDir = undefined }
		record({
			step: 'machine-run-cwd',
			ok: parsedInDir !== undefined && typeof parsedInDir.cwd === 'string'
				&& parsedInDir.cwd.toLowerCase() === String(dir).toLowerCase(),
			cwd: inDir.value?.cwd,
			parsed: parsedInDir,
			error: inDir.error,
		})

		// 4) A command string is interpreted by the machine's own shell.
		const shell = await call('machine_run', { machine: machine.machine, command: 'Write-Output ("shell-ok " + $PSVersionTable.PSVersion.Major)' })
		record({
			step: 'machine-run-command',
			ok: !shell.isError && /shell-ok \d/.test(String(shell.value?.stdout ?? '')),
			exitCode: shell.value?.exitCode,
			stdout: shell.value?.stdout,
			stderr: shell.value?.stderr,
			error: shell.error,
		})

		// 5) An expired budget must leave nothing behind on the machine. The command
		//    would write this file 6s in; the probe asks the machine 8s later.
		const lateFile = `${String(machine.home).replace(/[\\/]+$/, '')}\\.dsh-machine-probe-timeout.txt`
		const writeLate = 'setTimeout(() => { require("fs").writeFileSync(process.argv[1], "late") }, 6000)'
		const timed = await call('machine_run', {
			machine: machine.machine,
			argv: ['node', '-e', writeLate, lateFile],
			timeoutMs: 1500,
		})
		await sleep(8000)
		const exists = await call('machine_run', {
			machine: machine.machine,
			argv: ['node', '-e', 'process.stdout.write(String(require("fs").existsSync(process.argv[1])))', lateFile],
		})
		record({
			step: 'machine-run-timeout',
			ok: timed.value?.timedOut === true && String(exists.value?.stdout ?? '').trim() === 'false',
			timedOut: timed.value?.timedOut,
			durationMs: timed.value?.durationMs,
			lateFile,
			fileExistsAfter: String(exists.value?.stdout ?? '').trim(),
			error: timed.error,
		})

		// 6) An unknown machine must fail, and the failure must be usable.
		const unknown = await call('machine_run', { machine: 'no-such-machine', command: 'echo hi' })
		record({
			step: 'machine-run-unknown',
			ok: unknown.isError === true
				&& typeof unknown.error === 'string' && unknown.error.includes(machine.machine),
			isError: unknown.isError,
			error: unknown.error,
			text: unknown.text,
		})

		record({ event: 'machine-probe-complete' })
	}

	const timer = setTimeout(() => { void run() }, 1500)
	if (typeof timer.unref === 'function') timer.unref()
	ctx.effect(() => () => clearTimeout(timer), 'machine-probe: scenario run')
}
