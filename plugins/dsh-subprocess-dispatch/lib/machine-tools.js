/**
 * Machine tools — the model's direct way to work on a named machine.
 *
 * The dispatcher every session gets through `ctx.subprocess` decides where a
 * process runs from `spec.cwd` alone, which is why that path needs a workspace
 * binding to say which machine owns a directory. A model tool has no such
 * problem: it names the machine it wants, so nothing has to be inferred and no
 * binding, share, or path translation is involved. `machine_list` reports the
 * machines whose executor is connected right now; `machine_run` starts one
 * process on one of them and returns its output.
 *
 * Every path here is a path ON THE TARGET MACHINE. The server's own filesystem
 * is never a valid argument, which is why an omitted `cwd` becomes the machine's
 * reported home directory rather than anything derived from the session.
 *
 * Only a machine whose executor is connected can be addressed, and a machine
 * with no executor fails loudly: a command that quietly ran on the server
 * instead would tell the agent a Photoshop job succeeded somewhere Photoshop
 * does not exist.
 */
import { pathToFileURL } from 'node:url'

/** Bytes of stdout and stderr the tool keeps for the model; older output is dropped. */
const STDOUT_MAX_BYTES = 65536
const STDERR_MAX_BYTES = 16384
/** Default and maximum wall-clock budget for one command. */
const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
/** How long the executor may take to end a process tree before it is forced. */
const GRACE_MS = 3000
/** How long this side waits for an exit after that, before reporting what it has. */
const SETTLE_MS = 8000

/**
 * The engine's `defineTool`, resolved from the running profile's dependency
 * surface. Returned as `null` rather than throwing when the tools registry is
 * not installed, because this plugin's real job is the subprocess provider and
 * a profile without tools must still get it.
 * @param resolve - Resolver for one engine package specifier.
 * @returns the `defineTool` helper, or `null`.
 */
export async function loadDefineTool(resolve) {
	try {
		const entry = resolve('@deepseek-ai/dsh-tools')
		const mod = await import(pathToFileURL(entry).href)
		return typeof mod.defineTool === 'function' ? mod.defineTool : null
	} catch {
		return null
	}
}

/** One line naming the machine, for an error or a list entry. */
function labelOf(machine) {
	const host = machine.host ? ` host=${machine.host}` : ''
	return `${machine.machineId}${host}`
}

/**
 * The machine a call named.
 *
 * Accepts the machine id or, as a convenience, a host name that matches exactly
 * one connected machine: the person reading `machine_list` sees host names, and
 * a unique one is unambiguous. Anything ambiguous is refused with the candidates
 * rather than guessed, because running a command on the wrong machine is not a
 * mistake the caller can undo.
 * @param transport - The client transport holding the connections.
 * @param wanted - The `machine` argument.
 * @returns the matching machine record.
 * @throws when nothing matches, or more than one machine does.
 */
function resolveMachine(transport, wanted) {
	const machines = transport.machines()
	if (typeof wanted !== 'string' || wanted.trim() === '') {
		throw new Error(`没有指定机器。当前在线的机器：${machines.length === 0 ? '（一台都没有，需要在那台机器上打开 executor）' : machines.map(labelOf).join('、')}`)
	}
	const text = wanted.trim()
	const exact = machines.find((machine) => machine.machineId === text)
	if (exact) return exact
	const folded = text.toLowerCase()
	const byId = machines.filter((machine) => machine.machineId.toLowerCase() === folded)
	if (byId.length === 1) return byId[0]
	const byHost = machines.filter((machine) => (machine.host ?? '').toLowerCase() === folded)
	if (byHost.length === 1) return byHost[0]
	if (byHost.length > 1) {
		throw new Error(`'${text}' 匹配到多台机器，请用机器 ID：${byHost.map((machine) => machine.machineId).join('、')}`)
	}
	throw new Error(`没有名为 '${text}' 的在线机器。当前在线：${machines.length === 0 ? '（一台都没有，需要在那台机器上打开 executor）' : machines.map(labelOf).join('、')}`)
}

/**
 * The argv one call runs.
 *
 * A literal `argv` is passed through untouched: the seam never shell-interprets
 * it, so it is the form that works when the caller knows the exact program. A
 * `command` string is interpreted by the target machine's own shell, which is
 * what a caller writing shell syntax expects. The Windows branch also forces
 * UTF-8 console output: the executor decodes output as UTF-8, while Windows
 * PowerShell writes its redirected stdout in the machine's OEM code page, which
 * turns every Chinese result into mojibake.
 * @param machine - Target machine, for its platform.
 * @param args - The call's arguments.
 * @returns the argv to send.
 * @throws when neither form is usable.
 */
function argvFor(machine, args) {
	if (Array.isArray(args.argv) && args.argv.length > 0) {
		const argv = args.argv.map((item) => String(item))
		if (argv[0] === '') throw new Error('argv[0] 不能为空')
		return argv
	}
	const command = typeof args.command === 'string' ? args.command : ''
	if (command.trim() === '') throw new Error('command 和 argv 至少要给一个')
	const platform = String(machine.platform ?? '').toLowerCase()
	if (platform.startsWith('win')) {
		return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]
	}
	if (platform === '') {
		throw new Error(`机器 ${machine.machineId} 没有报告平台，无法确定用哪个 shell 解释 command；请改用 argv`)
	}
	return ['/bin/sh', '-c', command]
}

/** Wall-clock budget for one call, clamped to the documented maximum. */
function timeoutFor(args) {
	const asked = Number(args.timeoutMs)
	if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_TIMEOUT_MS
	return Math.min(Math.floor(asked), MAX_TIMEOUT_MS)
}

/** Read what one stream retained; `lossy` means earlier output was dropped. */
function readStream(handle, name) {
	const reader = handle.collected?.[name]
	if (!reader) return { text: '', lossy: false }
	const read = reader.readFrom(0)
	return { text: typeof read?.text === 'string' ? read.text : '', lossy: read?.lossy === true }
}

/**
 * Drop entries with no value.
 *
 * The tool's declared output schema types every property it names, and the
 * registry validates the result against it, so an absent fact has to be an
 * absent KEY rather than a `null` — an exit code the executor never reported
 * would otherwise fail the whole call as invalid output.
 * @param source - Candidate result entries.
 * @returns the entries that carry a value.
 */
function compact(source) {
	const out = {}
	for (const [key, value] of Object.entries(source)) {
		if (value === null || value === undefined) continue
		out[key] = value
	}
	return out
}

/**
 * Run one command on one machine and collect its result.
 *
 * Cancellation is the caller's `exec.signal` fused with the call's own timeout:
 * the spawn handle terminates the remote process tree on abort, so neither a
 * model-side cancel nor an expired budget leaves work running on the machine.
 * @param options - Transport, arguments, caller signal, and an optional trace hook.
 * @returns the complete result value, including any failure text.
 */
export async function runOnMachine({ transport, args, signal, trace }) {
	const machine = resolveMachine(transport, args.machine)
	const argv = argvFor(machine, args)
	const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
	const timeoutMs = timeoutFor(args)

	const controller = new AbortController()
	let timedOut = false
	const onCallerAbort = () => controller.abort()
	if (signal) {
		if (signal.aborted) {
			return compact({ machine: machine.machineId, host: machine.host, argv, error: '调用已被取消，命令没有执行' })
		}
		signal.addEventListener('abort', onCallerAbort, { once: true })
	}
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	if (typeof timer.unref === 'function') timer.unref()

	const started = Date.now()
	let handle
	try {
		handle = transport.spawn({
			username: machine.machineId,
			argv,
			cwd,
			stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
			graceMs: GRACE_MS,
			signal: controller.signal,
		})
	} catch (error) {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onCallerAbort)
		return compact({
			machine: machine.machineId,
			host: machine.host,
			argv,
			cwd: cwd ?? machine.home,
			error: String((error && error.message) || error),
		})
	}

	let exit = { exitCode: null, signal: null }
	let failure
	let settleTimer
	try {
		await Promise.race([
			handle.done.then((outcome) => { exit = outcome }),
			new Promise((resolve) => { settleTimer = setTimeout(resolve, timeoutMs + GRACE_MS + SETTLE_MS) }),
		]).catch((error) => { failure = error })
	} finally {
		clearTimeout(timer)
		clearTimeout(settleTimer)
		signal?.removeEventListener('abort', onCallerAbort)
	}

	const stdout = readStream(handle, 'stdout')
	const stderr = readStream(handle, 'stderr')
	const result = compact({
		machine: machine.machineId,
		host: machine.host,
		user: machine.user,
		platform: machine.platform,
		cwd: cwd ?? machine.home,
		argv,
		exitCode: exit.exitCode,
		signal: exit.signal,
		timedOut,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.lossy || stderr.lossy,
		durationMs: Date.now() - started,
	})
	if (failure !== undefined) result.error = String((failure && failure.message) || failure)
	else if (timedOut && exit.exitCode === null && exit.signal === null) {
		// The abort reached the executor but no exit came back: the machine may still
		// be running the tree, and saying so is the difference between "it stopped"
		// and a process nobody knows about.
		result.error = `超过 ${timeoutMs}ms 仍未收到退出通知，已请求终止；该机器上可能仍有进程在运行`
	}
	if (trace) trace({ machine: machine.machineId, host: machine.host, argv, cwd: result.cwd, exitCode: exit.exitCode, timedOut, durationMs: result.durationMs })
	return result
}

/**
 * Render one `machine_run` result as the model sees it.
 *
 * The exit marker is the same `[exit code: N]` / `[killed by signal: X]` contract
 * the shell tools use, so the Web terminal card can turn it back into an exit
 * pill (`parseExitStatus`) without knowing this tool exists. It is appended on
 * its own final line for exactly that reason.
 * @param value - The canonical result.
 * @returns model-facing content blocks.
 */
function renderRun(value) {
	if (typeof value?.error === 'string' && value.stdout === undefined) return [{ type: 'text', text: `执行失败：${value.error}` }]
	const where = value.host ? `${value.machine}（${value.host}）` : value.machine
	const lines = [`在 ${where} 上执行：${value.cwd ?? ''}> ${Array.isArray(value.argv) ? value.argv.join(' ') : ''}`]
	if (value.stdout) lines.push(value.stdout.replace(/\n+$/, ''))
	if (value.stderr) lines.push(`[stderr]\n${value.stderr.replace(/\n+$/, '')}`)
	if (value.truncated) lines.push('[输出过长，只保留了最后部分]')
	// Stated before the exit status: a killed command's exit code is this side's
	// termination, not a result the command produced, and a caller that read it as
	// the command's own failure would retry the wrong thing.
	if (value.timedOut === true) lines.push(`[timed out after ${value.durationMs ?? 0}ms; the process tree on that machine was terminated]`)
	if (typeof value.error === 'string') lines.push(`[${value.error}]`)
	if (typeof value.signal === 'string' && value.signal !== '') lines.push(`[killed by signal: ${value.signal}]`)
	else if (typeof value.exitCode === 'number' && value.exitCode !== 0) lines.push(`[exit code: ${value.exitCode}]`)
	return [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
}

/**
 * Recover the exit status the renderer appended, mirroring
 * `@deepseek-ai/dsh-shell/render`'s contract (that subpath is not exported, so
 * the two regexes are repeated here rather than imported).
 * @param text - Rendered result text.
 * @returns the marker-free body plus the exit code or signal.
 */
function parseExitMarker(text) {
	const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
	if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
	const exit = /\n\[exit code: (\d+)\]$/.exec(text)
	if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
	return { body: text, exitCode: 0 }
}

/**
 * Register the machine tools on a profile's tool registry.
 *
 * Registration is an effect of the calling fiber, so stopping or updating the
 * dispatcher removes both tools with it.
 * @param options - Context, engine-package resolver, transport, and logger.
 * @returns the registered tool names, or an empty list when tools are unavailable.
 */
export async function registerMachineTools({ ctx, resolve, transport, logger }) {
	const tools = ctx.get('tools')
	if (!tools || typeof tools.register !== 'function') {
		logger?.warn?.('[subprocess-dispatch] no tools registry here; the machine tools are not registered')
		return []
	}
	const defineTool = await loadDefineTool(resolve)
	if (!defineTool) {
		logger?.warn?.('[subprocess-dispatch] @deepseek-ai/dsh-tools is not resolvable; the machine tools are not registered')
		return []
	}

	const trace = (record) => logger?.info?.(`[machine-tools] ${JSON.stringify(record)}`)

	const listTool = defineTool({
		name: 'machine_list',
		description: '列出当前连着执行器（executor）的机器：机器 ID、主机名、系统、登录用户、用户主目录。要在某台用户的电脑上执行命令前先调用它拿到 machine 参数。没有执行器在运行的机器不会出现在这里。',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'number' },
					machines: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								machine: { type: 'string' },
								host: { type: 'string' },
								platform: { type: 'string' },
								user: { type: 'string' },
								home: { type: 'string' },
							},
							additionalProperties: true,
						},
					},
					error: { type: 'string' },
				},
				additionalProperties: true,
			},
			render: (_args, value) => {
				if (!value || value.count === 0) {
					return [{ type: 'text', text: '当前没有任何机器连着执行器。需要在目标电脑上打开 dsh-executor，它连上服务器后这里才会出现。' }]
				}
				const lines = value.machines.map((machine) => `${machine.machine}｜主机 ${machine.host ?? '未知'}｜${machine.platform ?? '未知'}｜用户 ${machine.user ?? '未知'}｜主目录 ${machine.home ?? '未知'}`)
				return [{ type: 'text', text: `在线机器 ${value.count} 台：\n${lines.join('\n')}` }]
			},
		},
		async execute() {
			try {
				const machines = transport.machines().map((machine) => ({
					machine: machine.machineId,
					host: machine.host,
					platform: machine.platform,
					user: machine.user,
					home: machine.home,
				}))
				return { count: machines.length, machines }
			} catch (error) {
				return { count: 0, machines: [], error: String((error && error.message) || error) }
			}
		},
		presentCall: () => ({ card: 'generic', title: '在线机器列表', kind: 'read' }),
	})

	const runTool = defineTool({
		name: 'machine_run',
		description: '在一台指定机器（用户的电脑）上执行一条命令，返回它的 stdout / stderr / 退出码。用 machine_list 拿到机器 ID。cwd、argv 里的路径都必须是那台机器上的路径，服务器上的路径在那台机器上不存在。省略 cwd 时在该机器的用户主目录下执行。给 command 会用那台机器自己的 shell 解释（Windows 上是 powershell）；需要精确控制时给 argv 数组。默认超时 120 秒，超时会终止那台机器上的进程树。',
		parameters: {
			machine: { type: 'string', required: true, description: '机器 ID（或唯一的主机名），来自 machine_list。' },
			command: { type: 'string', description: '要执行的命令行，由目标机器自己的 shell 解释。与 argv 二选一。' },
			argv: { type: 'array', items: { type: 'string' }, description: '精确的程序与参数数组（不做 shell 解释）。与 command 二选一。' },
			cwd: { type: 'string', description: '在目标机器上的工作目录（绝对路径）。省略时用该机器的用户主目录。' },
			timeoutMs: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}。` },
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					machine: { type: 'string' },
					host: { type: 'string' },
					user: { type: 'string' },
					platform: { type: 'string' },
					cwd: { type: 'string' },
					argv: { type: 'array', items: { type: 'string' } },
					exitCode: { type: 'number' },
					signal: { type: 'string' },
					timedOut: { type: 'boolean' },
					stdout: { type: 'string' },
					stderr: { type: 'string' },
					truncated: { type: 'boolean' },
					durationMs: { type: 'number' },
					error: { type: 'string' },
				},
				additionalProperties: true,
			},
			render: (_args, value) => renderRun(value),
		},
		async execute(args, exec) {
			return await runOnMachine({ transport, args, signal: exec?.signal, trace })
		},
		presentCall: (args) => {
			const command = typeof args?.command === 'string' && args.command !== ''
				? args.command
				: (Array.isArray(args?.argv) ? args.argv.map(String).join(' ') : '')
			const view = { card: 'terminal', title: command, description: `在 ${String(args?.machine ?? '')} 上执行` }
			if (typeof args?.cwd === 'string' && args.cwd !== '') view.cwd = args.cwd
			return view
		},
		presentResult: (_args, result) => {
			const block = result.content.length === 1 ? result.content[0] : undefined
			if (block === undefined || block.type !== 'text') return undefined
			const raw = block.text
			if (result.isError) return { card: 'generic', content: [{ type: 'text', text: raw }] }
			const { body, ...exit } = parseExitMarker(raw)
			return { card: 'terminal', output: body, ...exit }
		},
	})

	const disposers = [tools.register(listTool), tools.register(runTool)]
	ctx.effect(() => () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				// A registry that already dropped the tool must not fail teardown.
			}
		}
	}, 'subprocess-dispatch: machine tools')
	return ['machine_list', 'machine_run']
}
