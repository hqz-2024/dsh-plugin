/**
 * Report WHICH MACHINE each shell command in a session actually ran on, from the
 * durable records rather than from a glance at the GUI.
 *
 * Why the session log is the right source: the claim "commands in a bound
 * workspace run on the user's computer" is only proven by what the CHILD process
 * reported about itself. The child's stdout is exactly what the session log
 * stores as the tool result, so the log is where a real cross-machine run can be
 * re-checked months later -- and it is also where a same-machine run is exposed
 * as such (same hostname as the server proves the transport, not the world).
 *
 * Two sources are read, and they answer different halves:
 *   - the session log       -> what the command actually printed (the evidence)
 *   - the dispatch trace    -> what the dispatcher decided before the call
 *
 * Usage:
 *   node check-cross-machine.mjs                        # newest 3 sessions of ~/.dsh
 *   node check-cross-machine.mjs --home ~/.dsh-pilot-auth
 *   node check-cross-machine.mjs --session <path/to/session.v2.jsonl.zstd>
 *   node check-cross-machine.mjs --limit 10 --json
 *
 * Session logs are one zstd FRAME PER EVENT, not one stream: Node's
 * zstdDecompressSync stops after the first frame, so a single call reports one
 * event for a log that holds hundreds. Frames are split on the zstd magic.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const flag = (name) => argv.includes(name)

const home = arg('--home', join(homedir(), '.dsh'))
const limit = Number(arg('--limit', '5'))
const asJson = flag('--json')
const localHostname = hostname()

/** Decode every zstd frame in one session log into its events. */
function readSessionEvents(path) {
	const buf = readFileSync(path)
	const starts = []
	for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + 1)) starts.push(at)
	starts.push(buf.length)
	const events = []
	for (let i = 0; i < starts.length - 1; i++) {
		try {
			const text = zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8')
			for (const line of text.split('\n')) {
				if (!line.trim()) continue
				try { events.push(JSON.parse(line)) } catch { /* a split line, skip */ }
			}
		} catch {
			// Not a frame boundary; the next magic will resynchronise.
		}
	}
	return events
}

/** Every session log under a home, newest first. */
function findSessionLogs(root) {
	const found = []
	const walk = (dir, depth) => {
		if (depth > 3) return
		let entries
		try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full, depth + 1)
			else if (entry.name.endsWith('.jsonl.zstd')) found.push(full)
		}
	}
	walk(join(root, 'sessions'), 0)
	return found
		.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.map((entry) => entry.path)
}

const HOSTNAME_RE = /^[A-Za-z][A-Za-z0-9-]{1,30}$/
/** Lines that are a bare hostname (what `hostname`, `$env:COMPUTERNAME` print). */
function hostnamesIn(text) {
	return [...new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => HOSTNAME_RE.test(line) && !line.includes('\\') && !line.includes('/')))]
}

/** The text a tool result carried, whichever nesting this log version uses. */
function resultText(event) {
	const parts = []
	const walk = (node) => {
		if (node === null || node === undefined) return
		if (typeof node === 'string') return
		if (Array.isArray(node)) { for (const item of node) walk(item); return }
		if (typeof node !== 'object') return
		if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text)
		for (const value of Object.values(node)) walk(value)
	}
	walk(event?.data?.message?.content)
	return parts.join('')
}

const requested = arg('--session', '')
const logs = requested ? [requested] : findSessionLogs(home).slice(0, Number(arg('--sessions', '3')))

const findings = []
for (const log of logs) {
	let events
	try { events = readSessionEvents(log) } catch { continue }
	const session = events.find((event) => event?.type === 'session')
	const cwd = session?.cwd ?? session?.data?.cwd ?? null
	const results = new Map()
	for (const event of events) {
		if (event?.type !== 'tool/result') continue
		const callId = event?.data?.message?.source?.callId ?? event?.data?.message?.content?.[0]?.toolCallId
		if (callId) results.set(callId, event)
	}
	for (const event of events) {
		if (event?.type !== 'tool/call') continue
		const name = String(event?.data?.name ?? '')
		let args = {}
		try { args = JSON.parse(String(event?.data?.arguments ?? '{}')) } catch { args = {} }
		const command = typeof args.command === 'string' ? args.command : ''
		if (!command) continue
		const result = results.get(String(event?.data?.callId ?? ''))
		const text = resultText(result)
		const names = hostnamesIn(text)
		const onServer = names.includes(localHostname)
		const elsewhere = names.filter((candidate) => candidate !== localHostname)
		// Only a command that actually ASKED for the machine's name can settle where
		// it ran. A bare word on its own line is otherwise just as likely to be a
		// filename, and an evidence tool that calls that "another machine" is worse
		// than no tool at all.
		const asked = /hostname|computername|uname|host\.name/i.test(command)
		const verdict = names.length === 0
			? 'no hostname in this command\'s output — it does not say where it ran'
			: !asked
				? `output has machine-name-shaped lines (${names.join(', ')}) but the command never asked for one — not evidence of where it ran`
				: onServer
					? `ran on ${localHostname} (this machine) — transport exercise, NOT cross-machine`
					: `ran on ${elsewhere.join(', ')} — NOT this machine (${localHostname})`
		findings.push({
			sessionId: session?.id ?? session?.data?.id ?? null,
			log,
			at: new Date(Number(event.time ?? 0)).toISOString(),
			tool: name,
			command: command.replace(/\s+/g, ' ').slice(0, 160),
			reported: names,
			askedForHostname: asked,
			verdict,
			crossMachine: asked && names.length > 0 && !onServer,
			output: text.trim().slice(0, 400),
		})
	}
}

const tracePath = arg('--trace', '')
const traceCandidates = tracePath
	? [tracePath]
	: (() => {
		// A home may run several profiles; the trace that matters is the one the
		// dispatcher actually wrote most recently, so pick by mtime rather than by
		// guessing the profile name.
		try {
			return readdirSync(join(home, 'profiles'), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(home, 'profiles', entry.name, 'dispatch-trace.jsonl'))
				.map((path) => { try { return { path, mtime: statSync(path).mtimeMs } } catch { return null } })
				.filter((entry) => entry !== null)
				.sort((a, b) => b.mtime - a.mtime)
				.map((entry) => entry.path)
		} catch {
			return []
		}
	})()
const usedTrace = traceCandidates[0] ?? null
let decisions = []
let decisionCount = 0
try {
	const all = readFileSync(usedTrace, 'utf8')
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => { try { return JSON.parse(line) } catch { return null } })
		.filter((entry) => entry?.event === 'decision' || entry?.event === 'routing-index')
	decisionCount = all.filter((entry) => entry.event === 'decision').length
	// The per-spawn decision is the interesting record; the routing index only
	// frames it, so one recent index line is enough context.
	decisions = [...all.filter((entry) => entry.event === 'decision').slice(-5), ...all.filter((entry) => entry.event === 'routing-index').slice(-1)]
} catch { /* no trace yet: the profile may not have run with the dispatcher mounted */ }

const shown = limit > 0 ? findings.slice(-limit) : []

// The trace and the sessions only line up when they came from the same run, and a
// home used for several profiles holds traces from all of them.
const newestSession = logs
	.map((log) => { try { return statSync(log).mtimeMs } catch { return 0 } })
	.reduce((a, b) => Math.max(a, b), 0)
const traceMtime = usedTrace ? (() => { try { return statSync(usedTrace).mtimeMs } catch { return 0 } })() : 0
const stalenessNote = usedTrace && traceMtime > 0 && newestSession - traceMtime > 3600_000
	? `这个 trace 比最新的会话日志旧 ${Math.round((newestSession - traceMtime) / 3600_000)} 小时，两者很可能不是同一次运行；用 --trace 指定要看的那一份`
	: null

if (asJson) {
	console.log(JSON.stringify({ localHostname, home, trace: usedTrace, decisionCount, findings: shown, decisions }, null, 2))
} else {
	console.log(`本机（跑这个脚本的机器）hostname: ${localHostname}`)
	console.log(`home: ${home}`)
	console.log(`会话日志: ${logs.length} 个，其中有 shell 调用的记录 ${findings.length} 条`)
	console.log('')
	for (const finding of shown) {
		console.log(`── ${finding.at}  ${finding.tool}  [${finding.sessionId ?? '?'}]`)
		console.log(`   命令: ${finding.command}`)
		console.log(`   输出: ${finding.output.replace(/\r?\n/g, ' | ')}`)
		console.log(`   判定: ${finding.verdict}`)
		console.log('')
	}
	if (limit > 0 && shown.length === 0) console.log('（没有找到带 command 的工具调用）')
	console.log(`── 分派决策（${usedTrace ?? '没有 trace 文件'}，共 ${decisionCount} 条 spawn 决策）`)
	if (stalenessNote) console.log(`   ⚠️ ${stalenessNote}`)
	if (decisions.length === 0) console.log('   （还没有可用记录：这个 home 可能没用 dispatcher 跑过）')
	for (const entry of decisions) {
		if (entry.event === 'routing-index') {
			console.log(`   [routing-index] ${String(entry.at ?? '')} ${entry.status} routes=${(entry.routes ?? []).join(' ')}`)
		} else {
			console.log(`   [decision] ${String(entry.at ?? '')} ${entry.op} -> ${entry.target} (${entry.reason}) ws=${entry.workspaceTitle ?? '?'} cwd=${entry.cwd ?? '?'}`)
		}
	}
	console.log('')
	const cross = shown.filter((finding) => finding.crossMachine).length
	console.log(cross > 0
		? `结论：${cross} 条命令报告的主机名不是本机 —— 这就是跨机执行的证据。`
		: '结论：本次没有出现"报告的主机名不是本机"的命令，所以这里还证明不了跨机。')
}
