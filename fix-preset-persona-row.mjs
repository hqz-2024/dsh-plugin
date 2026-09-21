/**
 * 升级修复：把 286 个预设里的 persona 行从旧 schema 迁到新 schema。
 *
 * 背景：0.1.6-alpha.2（commit 40792330c0 "keep model persona prefix and place
 * cwd in suffix"）把 `@deepseek-ai/dsh-persona` 的 config 从
 *     { text }
 * 改成
 *     { prefix, suffix?, complete?, includeRuntimeContext? }
 * 其中 `prefix` 是**必填**。预设还写着 `text:`，于是挂载时 schema 校验失败：
 *     persona (@deepseek-ai/dsh-persona): invalidconfig: $.prefix missing required value
 * `mountPreset` 是「一行不可用即整份预设拒绝」（packages/preset/agent-presets/
 * src/mount.ts），所以用户看到的是"无法切换到 [角色]"—— 选择器里 286 个角色**全部**
 * 中招，不是某一个预设的问题。
 *
 * 两个改动，分别对应新 schema 的两半：
 *  1. `text:` → `prefix:`（同一段文字，只是换了键名）。
 *  2. 补上 `suffix:`。新插件的 suffix 段是**无条件注册**的，`suffix` 缺省为空串
 *     ——也就是「不写就等于把部署的这行抹掉」。部署的 web-app bundle 里那行是
 *     `Your working directory is {{cwd}}.`；上游自带的 standard/ptc/cordis 预设
 *     都原样重述了它。角色预设把 persona 整段替换掉，所以这行必须一起写回来，
 *     否则会话的 shell/文件工具在提示词里看不到自己的工作目录。
 *
 * 定位按缩进而不是按 `text:` 文本：persona 正文里的代码示例本身就有 `text:` 开头的行
 * （Lark 消息体、Python 类型标注），文本匹配会改错地方。认准 `config:` 的子键缩进，
 * 只改那一行；找不到就跳过并报出来。幂等：已经有 `prefix:` 的文件不动。
 *
 * 幂等的前提是只跑一次；跑完用 check-preset-roster.mjs 复核（它用引擎自己的 schema
 * 与渲染器，能证明结论和挂载时一致）。
 *
 * 用法：node fix-preset-persona-row.mjs [--dry-run]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dryRun = process.argv.includes('--dry-run')
const root = join(homedir(), '.dsh', '.agent-presets')

/** 部署 web-app bundle 里的 persona suffix（packages/bundle/web-app/cordis.patch.yml）。 */
const SUFFIX_LINE = 'suffix: Your working directory is {{cwd}}.'

/**
 * persona 行在文件里的行区间。
 * @param lines 组合文件按行拆开。
 * @returns { start, end }（end 不含），找不到返回 undefined。
 */
function personaBlock(lines) {
	const start = lines.findIndex(line => /^-\s*id:\s*persona\s*$/.test(line))
	if (start < 0) return undefined
	const next = lines.findIndex((line, index) => index > start && /^-\s*id:/.test(line))
	return { start, end: next < 0 ? lines.length : next }
}

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

/**
 * persona 行 `config:` 的键在文件里的行号。
 *
 * 不能只按 `text:` 文本找：persona 正文里有代码示例，示例里就有 `text:` 开头的行
 * （Lark 消息体、Python 类型标注……）。所以先定位 `config:` 自己的缩进，再只认
 * 缩进恰好等于"config 子键"的那一行。
 * @param lines 全文按行拆开。
 * @param block {@link personaBlock} 给出的行区间。
 * @returns { configLine, keyLine, indent }，键不存在时 keyLine 为 -1。
 */
function personaConfigKey(lines, block) {
	const configOffset = lines
		.slice(block.start, block.end)
		.findIndex(line => /^\s+config:\s*$/.test(line))
	if (configOffset < 0) return { keyLine: -1 }
	const configLine = block.start + configOffset
	const configIndent = /^(\s*)/.exec(lines[configLine])[1].length
	const indent = configIndent + 2
	for (let index = configLine + 1; index < block.end; index += 1) {
		const line = lines[index]
		if (line.trim().length === 0) continue
		const own = /^(\s*)/.exec(line)[1].length
		if (own < indent) break
		if (own !== indent) continue
		if (/^(text|prefix):/.test(line.trim())) return { keyLine: index, indent }
	}
	return { keyLine: -1 }
}

/**
 * 迁移一份文件。
 * @param text 原文。
 * @returns { status, next? }，status 为 changed / alreadyFixed / skipped。
 */
function migrate(text) {
	const lines = text.split('\n')
	const block = personaBlock(lines)
	if (block === undefined) return { status: 'noPersona' }
	const found = personaConfigKey(lines, block)
	if (found.keyLine < 0) return { status: 'skipped', reason: 'no text/prefix key under config' }
	if (lines[found.keyLine].trim().startsWith('prefix:')) return { status: 'alreadyFixed' }
	lines[found.keyLine] = lines[found.keyLine].replace(/^(\s*)text:/, '$1prefix:')
	lines.splice(found.keyLine, 0, `${' '.repeat(found.indent)}${SUFFIX_LINE}`)
	return { status: 'changed', next: lines.join('\n') }
}

const report = { files: 0, changed: 0, alreadyFixed: 0, noPersona: 0, skipped: [], errors: [] }
for (const path of presets(root)) {
	report.files += 1
	const text = readFileSync(path, 'utf8')
	const result = migrate(text)
	if (result.status === 'noPersona') { report.noPersona += 1; continue }
	if (result.status === 'alreadyFixed') { report.alreadyFixed += 1; continue }
	if (result.status === 'skipped') {
		report.skipped.push({ file: path.slice(root.length + 1), reason: result.reason })
		continue
	}
	if (!dryRun) {
		try {
			writeFileSync(path, result.next, 'utf8')
		} catch (error) {
			report.errors.push({ file: path, error: String(error?.message ?? error) })
			continue
		}
	}
	report.changed += 1
}
console.log(JSON.stringify({ dryRun, ...report }, null, 2))
