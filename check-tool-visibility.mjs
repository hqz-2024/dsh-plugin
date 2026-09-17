/**
 * 一个 host 行注册的工具，在"受限 preset"的会话里到底看不看得见？
 *
 * 这是 `machine_list` / `machine_run`（由 profile 的 host 行 subprocess-dispatch 注册）
 * 能否被岗位 preset 用到的前提。结构上的同类是 `local_run`（同样是 host 行 local-bridge
 * 注册的工具），而它被写进了那些 preset 的人设里 —— 所以先拿真实会话日志对一次：
 * `request/header` 事件里带着当次请求的工具清单（header.tools）。
 *
 * 用法：node check-tool-visibility.mjs [会话文件...]
 *   不带参数时扫描 ~/.dsh/sessions 下最近的若干会话。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { gunzipSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志每事件一个 zstd 帧，所以按 magic 切帧；gzip 的老日志整体解一次。 */
function readEvents(path) {
	const buf = readFileSync(path)
	if (buf[0] === 0x1f && buf[1] === 0x8b) {
		return parseLines(gunzipSync(buf).toString('utf8'))
	}
	const starts = []
	for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + 1)) starts.push(at)
	starts.push(buf.length)
	const events = []
	for (let i = 0; i < starts.length - 1; i++) {
		try {
			events.push(...parseLines(zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8')))
		} catch {
			// 不是帧边界，下一个 magic 会重新对齐。
		}
	}
	return events
}

function parseLines(text) {
	const out = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		try { out.push(JSON.parse(line)) } catch { /* 被切断的行 */ }
	}
	return out
}

const wanted = process.argv.slice(2)
let files = wanted
if (files.length === 0) {
	const dir = join(homedir(), '.dsh', 'sessions')
	files = readdirSync(dir)
		.filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl.gz'))
		.map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at)
		.slice(0, 60)
		.map((entry) => entry.path)
}

for (const file of files) {
	let events
	try {
		events = readEvents(file)
	} catch (error) {
		console.log(`SKIP ${file}: ${String(error?.message ?? error)}`)
		continue
	}
	const header = events.find((event) => event?.type === 'request/header')
	const tools = header?.data?.header?.tools
	const system = header?.data?.header?.system
	if (!Array.isArray(tools)) continue
	const names = tools.map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean)
	// 人设里的岗位名，用来认这个会话用的是哪个 preset。
	const persona = /你是「([^」]+)」岗位的 AI 助理/.exec(String(system ?? ''))?.[1] ?? '(默认 preset)'
	console.log(JSON.stringify({
		file: file.split(/[\\/]/).pop(),
		persona,
		tools: names.length,
		hasLocalRun: names.includes('local_run'),
		hasMachineTools: names.includes('machine_run') || names.includes('machine_list'),
		hasShell: names.includes('pwsh') || names.includes('bash'),
	}, null, 0))
}
