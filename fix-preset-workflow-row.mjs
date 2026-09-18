/**
 * 升级修复：把 279 个预设里挂载的 workflow provider 换成新版本里的那个。
 *
 * 背景：0.1.3 的 `@deepseek-ai/dsh-workflow-worker-thread` 在 0.1.6 里被
 * `@deepseek-ai/dsh-workflow-ptc`（行 id `workflow-ptc`，同样 `provider: spawn`）取代。
 * 预设按**包名**挂载行，包没了整份预设就起不来 —— 这就是用户上次升级后
 * "很多插件都失效"的直接原因。
 *
 * 只做精确替换：每个文件必须恰好命中一次，命中数不对就跳过并报错（免得改错地方）。
 * 幂等：已经是新名字的文件不动。
 *
 * 用法：node fix-preset-workflow-row.mjs [--dry-run]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dryRun = process.argv.includes('--dry-run')
const root = join(homedir(), '.dsh', '.agent-presets')
const FROM_ID = 'id: workflow-worker-thread'
const TO_ID = 'id: workflow-ptc'
const FROM_NAME = "name: '@deepseek-ai/dsh-workflow-worker-thread'"
const TO_NAME = "name: '@deepseek-ai/dsh-workflow-ptc'"
const LEGACY = '@deepseek-ai/dsh-workflow-worker-thread'

/** 所有 agent.cordis.yml（预设组合文件）。 */
function presets(dir) {
	const found = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue
		const path = join(dir, entry.name, 'agent.cordis.yml')
		try {
			if (statSync(path).isFile()) found.push(path)
		} catch { /* 没有组合文件的预设跳过 */ }
	}
	return found
}

const report = { files: 0, changed: 0, alreadyFixed: 0, skipped: [], errors: [] }
for (const path of presets(root)) {
	report.files += 1
	const text = readFileSync(path, 'utf8')
	if (!text.includes(LEGACY)) {
		if (text.includes(TO_NAME)) report.alreadyFixed += 1
		continue
	}
	const idHits = text.split(FROM_ID).length - 1
	const nameHits = text.split(FROM_NAME).length - 1
	if (nameHits !== 1 || idHits > 1) {
		report.skipped.push({ file: path.slice(root.length + 1), idHits, nameHits })
		continue
	}
	const next = text.split(FROM_NAME).join(TO_NAME).split(FROM_ID).join(TO_ID)
	if (!dryRun) {
		try {
			writeFileSync(path, next, 'utf8')
		} catch (error) {
			report.errors.push({ file: path, error: String(error?.message ?? error) })
			continue
		}
	}
	report.changed += 1
}
console.log(JSON.stringify({ dryRun, ...report }, null, 2))
