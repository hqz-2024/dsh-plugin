/**
 * 给「persona 正文含字面 `{{…}}`」的角色预设换上一行自带的 persona 插件。
 *
 * 问题：引擎渲染 persona 段时**严格插值**（packages/core/system-prompt/src/index.ts
 * 的 interpolate()）—— 任何 `{{ x }}` 只要不是已注册变量（provider/model/cwd）就抛错、
 * 该轮请求失败。引擎自己的说法是「插值文本里没有转义语法；要保留字面花括号，就给整段设
 * `interpolate: false`」（packages/core/system-prompt/README.md）。但
 * `@deepseek-ai/dsh-persona` 的 config 没有暴露这个开关，所以只能换一行插件。
 *
 * 做法：在预设目录里放一份零依赖的 `persona-literal.mjs`，把 persona 行的 `name:` 从
 * 包名改成预设相对路径 `./persona-literal.mjs`。预设相对行是引擎一等公民
 * （packages/preset/agent-presets/src/specifier.ts 的 kind: 'preset'，
 * discovery.spec.ts 有同名用例），文件随预设走，不需要引擎侧改动。
 *
 * 换哪些预设是**算出来的**，不是写死的：用引擎的 `discoverPresets` + `@deepseek-ai/dsh-persona`
 * 的 schema + `renderPrompt` 逐份跑一遍，"真实渲染失败"的才换。所以这份脚本在以后新增
 * 预设、或上游放宽插值之后，结论会自动跟着变。
 *
 * 用法：node fix-preset-literal-persona.mjs [--dry-run]
 * 复核：node check-preset-roster.mjs
 *
 * **提交时 .mjs 与 .yml 必须一起提交**：组合文件现在按相对路径找它，
 * 只提交改过的 agent.cordis.yml、漏掉那 11 份 persona-literal.mjs，预设会在
 * discovery 阶段就报 "names a plugin that cannot be resolved"。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'))
const harnessRoot = positional[0] ?? 'C:\\Users\\bestarc\\Desktop\\deepseek-harness'
const root = join(homedir(), '.dsh', '.agent-presets')
const harnessBase = pathToFileURL(join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')).href

/** 预设自带的 persona 行文件名；行名与它是同一个事实，改一处即可。 */
const PLUGIN_FILE = 'persona-literal.mjs'
const ROW_NAME = `./${PLUGIN_FILE}`
const PACKAGE_NAME = '@deepseek-ai/dsh-persona'

/**
 * 随预设分发的 persona 插件源码。
 *
 * 刻意**零 import**：它住在 `~/.dsh/.agent-presets/<id>/`，其祖先目录里没有引擎的
 * node_modules；而且本部署被"同一个包加载出两份模块实例"坑过一次（见 ~/.dsh/AGENTS.md
 * §四），所以不引入第二份引擎包。两个段名是引擎公开的常量，引擎自己在
 * packages/subagent/subagent/src/child-agent.ts 里也照样字面写。
 */
const PLUGIN_SOURCE = `/**
 * 预设自带的 persona 行：正文按字面渲染，不做提示词变量插值。
 *
 * 为什么需要它：@deepseek-ai/dsh-persona 用默认插值把 prefix 交给
 * systemPrompt.section()，而引擎的插值是严格的（packages/core/system-prompt/src/index.ts
 * 的 interpolate()）：任何 {{ x }} 只要不是已注册变量（provider/model/cwd）就抛错、
 * 该轮请求失败。引擎的说法是"插值文本里没有转义语法；要保留字面花括号，就给整段设
 * interpolate: false"（packages/core/system-prompt/README.md），但
 * @deepseek-ai/dsh-persona 的 config 没有暴露这个开关，所以本预设自带一行。
 *
 * 本角色的 persona 正文里有 Twig / GitHub Actions / JSX / Vault 的代码示例，正好含
 * {{ … }}，因此 prefix 必须字面渲染。suffix 仍走插值：它是部署那行
 * Your working directory is {{cwd}}.，要解析出真实工作目录。
 *
 * 零 import 是刻意的：本文件随预设目录分发，祖先目录里没有引擎的 node_modules；两个段名
 * 是引擎公开的常量，packages/subagent/subagent/src/child-agent.ts 也照样字面写。
 */

/** Cordis plugin name. */
export const name = 'persona-literal'

/** 本行贡献给的提示词注册表。 */
export const inject = ['systemPrompt']

/** 与引擎共享的段名（packages/core/system-prompt/src/index.ts 导出的常量）。 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/**
 * 注册本 scope 的 persona 段。
 * @param ctx - 预设挂载所在的 agent scope 上下文。
 * @param config - prefix（字面渲染）与 suffix（插值渲染）。
 * @throws prefix 不是字符串，或 suffix 存在但不是字符串。config 没有 schema，
 * 这里是唯一的校验点 —— 配置写错要在挂载时炸，不能静默出一段空 persona。
 */
export function apply(ctx, config) {
	if (typeof config?.prefix !== 'string') {
		throw new TypeError(\`\${name}: config.prefix must be a string, received \${typeof config?.prefix}\`)
	}
	if (config.suffix !== undefined && typeof config.suffix !== 'string') {
		throw new TypeError(\`\${name}: config.suffix must be a string when present, received \${typeof config.suffix}\`)
	}
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_PREFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
		text: config.prefix,
		interpolate: false,
	}), 'persona-literal.prefix()')
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_SUFFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
		text: config.suffix ?? '',
	}), 'persona-literal.suffix()')
}
`

const harnessRequire = createRequire(harnessBase)
const { load } = harnessRequire('js-yaml')
const { entryListSchema } = harnessRequire('@deepseek-ai/cordis-plugin-include')
const { discoverPresets } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'preset', 'agent-presets', 'lib', 'index.js')).href)
const { Config: PersonaConfig } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'preset', 'persona', 'lib', 'index.js')).href)
const { renderPrompt } = await import(
	pathToFileURL(join(harnessRoot, 'packages', 'core', 'system-prompt', 'lib', 'index.js')).href)

/** agent-loop 注册的内建提示词变量。 */
const BUILTIN_VARIABLES = { provider: 'deepseek', model: 'deepseek-flash', cwd: 'C:\\workspace' }

/** persona 行在组合文件里的行区间（`end` 不含）。 */
function personaBlock(lines) {
	const start = lines.findIndex(line => /^-\s*id:\s*persona\s*$/.test(line))
	if (start < 0) return undefined
	const next = lines.findIndex((line, index) => index > start && /^-\s*id:/.test(line))
	return { start, end: next < 0 ? lines.length : next }
}

/**
 * 该预设的 persona 行是否需要换成自带的字面渲染行。
 * @param path 组合文件路径。
 * @returns needs 为 true 时 reason 是渲染失败的原因，否则是"不需要"的理由。
 */
async function needsLiteralRow(path) {
	const rows = load(await readFile(path, 'utf8'), { schema: entryListSchema })
	const row = rows.find(candidate => candidate?.id === 'persona')
	if (row === undefined) return { needs: false, reason: 'no persona row' }
	if (row.name === ROW_NAME) return { needs: false, reason: 'already literal' }
	if (row.name !== PACKAGE_NAME) return { needs: false, reason: `persona row names ${String(row.name)}` }
	let config
	try {
		config = new PersonaConfig(row.config)
	} catch (error) {
		return { needs: false, reason: `invalid config: ${String(error?.message ?? error)}` }
	}
	try {
		renderPrompt({
			sections: [
				{ name: 'deployment:persona-prefix', order: 0, text: config.prefix },
				{ name: 'deployment:persona-suffix', order: 10200, text: config.suffix ?? '' },
			],
			contexts: [],
			tools: [],
			variables: BUILTIN_VARIABLES,
		})
	} catch (error) {
		return { needs: true, reason: String(error?.message ?? error) }
	}
	return { needs: false, reason: 'renders fine' }
}

const report = { presets: 0, converted: 0, alreadyConverted: 0, pluginRewritten: 0, skipped: [], errors: [] }
for (const preset of await discoverPresets([{ path: root, trust: 'user' }], harnessBase)) {
	report.presets += 1
	if (preset.broken !== undefined) { report.skipped.push({ preset: preset.id, reason: preset.broken }); continue }
	const verdict = await needsLiteralRow(preset.path)
	if (!verdict.needs) {
		// 已经换过的预设不必再改组合文件，但插件源码要跟着模板走 —— 否则改一次模板
		// 就得手工同步 11 份副本，"随预设分发"的文件会和它的来源悄悄分叉。
		if (verdict.reason !== 'already literal' || dryRun) {
			if (verdict.reason === 'already literal') report.alreadyConverted += 1
			continue
		}
		const previous = await readFile(join(root, preset.id, PLUGIN_FILE), 'utf8').catch(() => undefined)
		if (previous !== PLUGIN_SOURCE) {
			writeFileSync(join(root, preset.id, PLUGIN_FILE), PLUGIN_SOURCE, 'utf8')
			report.pluginRewritten += 1
		}
		report.alreadyConverted += 1
		continue
	}
	const pluginPath = join(root, preset.id, PLUGIN_FILE)
	const lines = readFileSync(preset.path, 'utf8').split('\n')
	const block = personaBlock(lines)
	if (block === undefined) { report.skipped.push({ preset: preset.id, reason: 'no persona block' }); continue }
	const nameLine = lines.findIndex((line, index) => (
		index > block.start && index < block.end && /^\s*name:\s*'@deepseek-ai\/dsh-persona'\s*$/.test(line)
	))
	if (nameLine < 0) { report.skipped.push({ preset: preset.id, reason: 'no package name line in persona row' }); continue }
	lines[nameLine] = lines[nameLine].replace(/'@deepseek-ai\/dsh-persona'/, ROW_NAME)
	if (dryRun) { report.converted += 1; continue }
	try {
		const previous = await readFile(pluginPath, 'utf8').catch(() => undefined)
		if (previous !== PLUGIN_SOURCE) {
			writeFileSync(pluginPath, PLUGIN_SOURCE, 'utf8')
			if (previous !== undefined) report.pluginRewritten += 1
		}
		writeFileSync(preset.path, lines.join('\n'), 'utf8')
	} catch (error) {
		report.errors.push({ preset: preset.id, error: String(error?.message ?? error) })
		continue
	}
	report.converted += 1
}
console.log(JSON.stringify({ dryRun, reason: 'persona 正文含字面 {{…}}，严格插值会炸', ...report }, null, 2))
