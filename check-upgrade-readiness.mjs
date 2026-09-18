/**
 * 升级体检：把"升到新版本会坏什么"变成一张可核对的表。
 *
 * 三条互相独立的证据：
 *  1. **会话格式**：新旧两版各自写哪个 `SESSION_FORMAT_VERSION`，以及新版有没有从旧版升上来的迁移包
 *     —— 直接回答"旧对话会不会读不出来"。
 *  2. **我们引用的引擎包**：本部署的插件 import 了哪些 `@deepseek-ai/*`，按**包名**在新版树里核对。
 *  3. **组合行 id**：我们的 profile patch 按 `id` 命中行；行被改名/删掉会**静默失效**，
 *     所以把两版的 bundle 行 id 拉出来做差集。
 *
 * 用法：node check-upgrade-readiness.mjs [引擎仓库路径] [当前 ref] [目标 ref]
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const repo = process.argv[2] ?? 'C:/Users/bestarc/Desktop/deepseek-harness'
const from = process.argv[3] ?? 'hqz-dsh'
const to = process.argv[4] ?? 'origin/master'
const pluginsDir = join(homedir(), '.dsh', 'plugins')

const git = (args) => {
	try {
		return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
	} catch (error) {
		if (error?.status === 1) return ''
		return `__ERROR__ ${String(error?.message ?? error)}`
	}
}
const show = (ref, path) => git(['show', `${ref}:${path}`])

/** 会话格式版本（两个 ref 各一次）。 */
const formatVersion = (ref) => {
	const hit = /SESSION_FORMAT_VERSION = (\d+)/.exec(show(ref, 'packages/core/session/src/types.ts'))
	return hit ? Number(hit[1]) : undefined
}

/** 某版里有没有把 vN 迁到 vM 的包。 */
const migrations = (ref) => git(['ls-tree', '-r', '--name-only', ref, '--', 'packages/session'])
	.split('\n')
	.map((line) => /packages\/session\/(session-format-v\d+-to-v\d+)\/package\.json$/.exec(line)?.[1])
	.filter(Boolean)

/** 一个 bundle patch 里的行 id。 */
const rowIds = (ref, path) => show(ref, path)
	.split('\n')
	.map((line) => /^\s*-?\s*id:\s*'?([A-Za-z0-9_.-]+)'?\s*$/.exec(line)?.[1])
	.filter(Boolean)

/** 本部署插件引用的引擎包（按名字去重）。 */
function pluginEngineImports() {
	const found = new Map()
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
			const path = join(dir, entry.name)
			if (entry.isDirectory()) { walk(path); continue }
			if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue
			if (statSync(path).size > 2 * 1024 * 1024) continue
			const text = readFileSync(path, 'utf8')
			for (const match of text.matchAll(/@deepseek-ai\/[a-z0-9-]+(?:\/[a-z0-9-]+)?/g)) {
				if (match[0] === '@deepseek-ai/cordis') { /* 也记，见下 */ }
				found.set(match[0], true)
			}
		}
	}
	for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
		if (plugin.isDirectory()) walk(join(pluginsDir, plugin.name))
	}
	return [...found.keys()].sort()
}

/** 新版里有没有这个名字的包（按 package.json 的 name 找，不靠目录名）。 */
const packageExists = (ref, name) => git(['grep', '-l', `"name": "${name}"`, ref, '--', '*/package.json']) !== ''

const report = {
	refs: { repo, from, to },
	sessionFormat: { [from]: formatVersion(from), [to]: formatVersion(to) },
	migrations: { [from]: migrations(from), [to]: migrations(to) },
	behindCommits: Number(git(['rev-list', '--count', `${from}..${to}`]).trim() || 0),
	enginePackages: [],
	bundles: [],
}

for (const name of pluginEngineImports()) {
	report.enginePackages.push({ name, present: packageExists(to, name) })
}

for (const path of ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml']) {
	const before = rowIds(from, path)
	const after = rowIds(to, path)
	report.bundles.push({
		path,
		rowsBefore: before.length,
		rowsAfter: after.length,
		removed: before.filter((id) => !after.includes(id)),
		added: after.filter((id) => !before.includes(id)).slice(0, 20),
	})
}

console.log(JSON.stringify(report, null, 2))
console.log(`\n判读：enginePackages 里 present=false 的包会让引用它的插件起不来；bundles[].removed 里的行 id 会让我们的 patch 静默失效。`)
