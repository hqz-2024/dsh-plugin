/**
 * 角色预设体检：一次回答"选择器里的每个角色都挂得上、能开口吗？"
 *
 * 为什么需要它：`mountPreset` 是「一行不可用即整份预设拒绝」
 * （packages/preset/agent-presets/src/mount.ts），用户在 Web 上看到的只是
 *    无法切换到 [角色]:N row(s) did not activate: …
 * —— 一次只暴露一个预设。而 roster 的 `broken` 字段**故意**只做文件形状与包解析检查，
 * 不 import 任何插件（见 discovery.ts 的模块注释），所以 schema 类错误在选择器上
 * 看不出来，只有真去开会话才炸。
 *
 * 三道检查，各自用**引擎自己的**实现，所以结论和挂载/渲染时是同一个：
 *  1. **roster**：引擎的 `discoverPresets()` —— loader 的 YAML 方言 + 它自己的解析规则。
 *     这一项只回答"行能不能被找到"，回答不了"config 合不合法"。
 *  2. **persona schema**：引擎 `@deepseek-ai/dsh-persona` 的 `Config`，喂进每份预设的
 *     persona config。`text:` → `prefix:` 那次升级就死在这里：`$.prefix missing required value`。
 *  3. **渲染**：把 persona 的 prefix/suffix 喂进引擎的 `renderPrompt()`，变量用 agent-loop
 *     注册的内建三个（provider/model/cwd）。persona 段是**严格插值**的：任何 `{{ x }}`
 *     只要不是已注册变量名就抛错、该轮请求失败。persona 正文里抄的 Twig / GitHub Actions /
 *     JSX / Vault 代码示例正好长这样 —— 第 1、2 项都查不出来，因为它挂得上、配置也合法。
 *
 * 用法：node check-preset-roster.mjs [引擎 checkout 路径] [预设根目录]
 */
import { exit } from 'node:process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const harnessRoot = process.argv[2] ?? 'C:\\Users\\bestarc\\Desktop\\deepseek-harness'
const presetRoot = process.argv[3] ?? join(homedir(), '.dsh', '.agent-presets')
const harnessBase = pathToFileURL(join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')).href

const harnessRequire = createRequire(harnessBase)
const { load } = harnessRequire('js-yaml')
const { entryListSchema } = harnessRequire('@deepseek-ai/cordis-plugin-include')
const { discoverPresets } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'preset', 'agent-presets', 'lib', 'index.js')).href)
const { Config: PersonaConfig } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'preset', 'persona', 'lib', 'index.js')).href)
const { renderPrompt } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'core', 'system-prompt', 'lib', 'index.js')).href)

/** agent-loop 注册的内建提示词变量（packages/core/agent-loop/src/index.ts）。 */
const BUILTIN_VARIABLES = { provider: 'deepseek', model: 'deepseek-flash', cwd: 'C:\\workspace' }

const report = {
	root: presetRoot,
	roster: { presets: 0, broken: [] },
	persona: {
		rows: 0,
		missing: [],
		unreadable: [],
		invalidConfig: [],
		rowFailure: [],
		renderFailure: [],
		literalRows: [],
	},
}

const presets = await discoverPresets([{ path: presetRoot, trust: 'user' }], harnessBase)
report.roster.presets = presets.length
for (const preset of presets) {
	if (preset.broken !== undefined) report.roster.broken.push({ preset: preset.id, reason: preset.broken })
}

for (const preset of presets) {
	let source
	try {
		source = await readFile(preset.path, 'utf8')
	} catch (error) {
		report.persona.unreadable.push({ preset: preset.id, error: String(error?.message ?? error) })
		continue
	}
	let rows
	try {
		rows = load(source, { schema: entryListSchema })
	} catch (error) {
		report.persona.unreadable.push({ preset: preset.id, error: String(error?.message ?? error).split('\n')[0] })
		continue
	}
	const row = rows.find(candidate => candidate?.id === 'persona')
	if (row === undefined) { report.persona.missing.push(preset.id); continue }
	report.persona.rows += 1

	let sections
	if (typeof row.name === 'string' && row.name.startsWith('.')) {
		// 预设自带的 persona 行（见 fix-preset-literal-persona.mjs）：把它的 apply() 真跑一遍，
		// 断言落在它**实际注册的段**上，而不是文件长得对不对。
		report.persona.literalRows.push(preset.id)
		try {
			const module = await import(new URL(row.name, pathToFileURL(preset.path)).href)
			const recorded = []
			module.apply({
				effect: callback => callback(),
				systemPrompt: {
					getSectionOrder: name => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200),
					section: spec => recorded.push(spec),
				},
			}, row.config)
			sections = recorded
		} catch (error) {
			report.persona.rowFailure.push({ preset: preset.id, error: String(error?.message ?? error) })
			continue
		}
	} else {
		let config
		try {
			config = new PersonaConfig(row.config)
		} catch (error) {
			report.persona.invalidConfig.push({ preset: preset.id, error: String(error?.message ?? error) })
			continue
		}
		sections = [
			{ name: 'deployment:persona-prefix', order: 0, text: config.prefix },
			{ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' },
		]
	}
	try {
		renderPrompt({ sections, contexts: [], tools: [], variables: BUILTIN_VARIABLES })
	} catch (error) {
		report.persona.renderFailure.push({ preset: preset.id, error: String(error?.message ?? error) })
	}
}

report.verdict = {
	rosterBroken: report.roster.broken.length,
	invalidPersonaConfig: report.persona.invalidConfig.length,
	personaRowFailure: report.persona.rowFailure.length,
	renderFailure: report.persona.renderFailure.length,
	literalRows: report.persona.literalRows.length,
}
console.log(JSON.stringify(report, null, 2))

const mountable = report.verdict.rosterBroken + report.verdict.invalidPersonaConfig + report.verdict.personaRowFailure
console.log(mountable === 0
	? `\n挂载面干净：${String(report.roster.presets)} 个角色都能挂上（其中 ${String(report.verdict.literalRows)} 个用预设自带的字面 persona 行）。`
	: `\n有 ${String(mountable)} 个预设会挂载失败 —— 见 roster.broken / persona.invalidConfig / persona.rowFailure。`)
console.log(report.verdict.renderFailure === 0
	? '渲染面干净：每个 persona 都能通过引擎的真实渲染。'
	: `\n有 ${String(report.verdict.renderFailure)} 个预设挂得上、但第一次开口会因严格插值失败（见 persona.renderFailure）。`)
exit(mountable + report.verdict.renderFailure === 0 ? 0 : 1)
