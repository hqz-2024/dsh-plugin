/**
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
		throw new TypeError(`${name}: config.prefix must be a string, received ${typeof config?.prefix}`)
	}
	if (config.suffix !== undefined && typeof config.suffix !== 'string') {
		throw new TypeError(`${name}: config.suffix must be a string when present, received ${typeof config.suffix}`)
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
