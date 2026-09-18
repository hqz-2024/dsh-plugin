/**
 * 升级体检之二：**预设与组合引用的插件包，在目标版本里还存不存在**。
 *
 * 为什么单独查这个：本部署有 286 个角色预设，每个预设按**包名**挂载插件行。
 * 上游删掉/改名一个包（例如 `dsh-tool-str-replace-editor`、`dsh-workflow-worker-thread`），
 * 引用它的预设就整个挂不起来 —— 表现出来就是"升级后插件全失效"。
 *
 * 用法：node check-upgrade-references.mjs [引擎仓库] [目标 ref]
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const repo = process.argv[2] ?? 'C:/Users/bestarc/Desktop/deepseek-harness'
const target = process.argv[3] ?? 'dsh-v0.1.6-alpha.2'
const home = join(homedir(), '.dsh')

const git = (args) => {
	try {
		return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
	} catch (error) {
		if (error?.status === 1) return ''
		return `__ERROR__ ${String(error?.message ?? error)}`
	}
}

/** 目标版本里所有 `@deepseek-ai/*` 包名。 */
const names = new Set()
for (const line of git(['grep', '-h', '-o', '"name": "@deepseek-ai/[a-z0-9-]*"', target, '--', '*/package.json']).split('\n')) {
	const hit = /"name": "(@deepseek-ai\/[a-z0-9-]+)"/.exec(line)
	if (hit) names.add(hit[1])
}
console.log(`目标 ${target} 有 ${names.size} 个 @deepseek-ai 包`)

/** 收集某个目录树下所有文件里的 specifier 及其出处。 */
function collect(root, exts) {
	const found = new Map()
	const walk = (dir) => {
		let entries
		try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
			const path = join(dir, entry.name)
			if (entry.isDirectory()) { walk(path); continue }
			if (!exts.test(entry.name)) continue
			if (statSync(path).size > 1024 * 1024) continue
			const text = readFileSync(path, 'utf8')
			for (const match of text.matchAll(/@deepseek-ai\/[a-z0-9-]+/g)) {
				const spec = match[0]
				if (!found.has(spec)) found.set(spec, new Set())
				found.get(spec).add(path.slice(home.length + 1))
			}
		}
	}
	walk(root)
	return found
}

const areas = [
	{ label: '预设（.agent-presets）', files: collect(join(home, '.agent-presets'), /\.(yml|yaml)$/) },
	{ label: '组合（profiles/*.patch.yml）', files: collect(join(home, 'profiles'), /\.(yml|yaml|json)$/) },
	{ label: '插件（plugins）', files: collect(join(home, 'plugins'), /\.(js|mjs|cjs|yml|json)$/) },
]

const report = {}
for (const area of areas) {
	const missing = []
	for (const [spec, where] of [...area.files].sort()) {
		if (names.has(spec)) continue
		// `@deepseek-ai/dsh-shell/render` 这类子路径按包名判断
		const base = spec.split('/').slice(0, 2).join('/')
		if (names.has(base)) continue
		missing.push({ spec, examples: [...where].slice(0, 3) })
	}
	report[area.label] = { referenced: area.files.size, missing }
}

console.log(JSON.stringify(report, null, 2))
