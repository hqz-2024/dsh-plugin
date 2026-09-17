/**
 * Check the session header's execution-location control in a real browser.
 *
 * The control is the whole point of this surface: it has to appear in an open session,
 * describe where that session's commands actually run, and change that by itself. Reading
 * the endpoint is not the same check — the badge can fail to mount, read the wrong
 * session, or render nothing while the endpoint answers perfectly.
 *
 * Usage:
 *   node check-execution-badge.mjs --origin http://127.0.0.1:3084 --user <account> --password <secret>
 *                                  [--executor "http://127.0.0.1:38495"]
 */
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const origin = arg('--origin', 'http://127.0.0.1:3084')
const user = arg('--user', '')
const password = arg('--password', '')
const executor = arg('--executor', '')

const require = createRequire('file:///C:/nvm4w/nodejs/node_modules/@playwright/mcp/package.json')
const { chromium } = require('playwright')

const results = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * The control as rendered: its label, its tooltip, and whether it offers an action.
 *
 * Found by the chip's own tooltip rather than by its text: the chip reads 「服务器」 and
 * the button beside it reads 「本地模式」, so a text match with a title lands on the
 * button and reports the wrong thing.
 */
const readBadge = (tab) => tab.evaluate(() => {
	const chip = [...document.querySelectorAll('span[title]')]
		.find((n) => /(命令在服务器上执行|在本机执行|被别的账号占着|共享规则)/.test(n.getAttribute('title') ?? ''))
	if (chip === undefined) return null
	const action = chip.parentElement?.querySelector('button') ?? null
	return {
		text: (chip.textContent ?? '').trim(),
		title: chip.getAttribute('title') ?? '',
		action: action ? (action.textContent ?? '').trim() : null,
		disabled: action ? action.disabled : null,
	}
})

/** Click whatever action the control currently offers. */
const clickAction = (tab) => tab.evaluate(() => {
	const chip = [...document.querySelectorAll('span[title]')]
		.find((n) => /(命令在服务器上执行|在本机执行|被别的账号占着|共享规则)/.test(n.getAttribute('title') ?? ''))
	const action = chip?.parentElement?.querySelector('button')
	if (action === undefined || action === null || action.disabled) return false
	action.click()
	return true
})

const browser = await chromium.launch()
const context = await browser.newContext()
const tab = await context.newPage()
const errors = []
tab.on('pageerror', (error) => errors.push(String(error.message)))

try {
	await tab.goto(`${origin}/`, { waitUntil: 'networkidle' })
	await tab.fill('#username', user)
	await tab.fill('#password', password)
	await tab.click('#submit')
	const skip = tab.locator('#offer-skip')
	await skip.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
	if (await skip.isVisible().catch(() => false)) await skip.click()
	await tab.waitForFunction(() => !!window.__DSH_BOOT__, { timeout: 30000 }).catch(() => {})
	await tab.waitForLoadState('networkidle').catch(() => {})
	record('进入 Web UI', /__DSH_BOOT__/.test(await tab.content().catch(() => '')), tab.url())

	// The control lives in a live session's header, so the check has to open one: a
	// workspace row alone lands on the Hero, where a session-scoped slot has no site.
	// `--session` names a row to open, because which workspace a session belongs to
	// decides whether the badge can offer to bind at all (a workspace outside every
	// share rule has no visible path, and the button is correctly disabled there).
	const wanted = arg('--session', '')
	const target = await tab.evaluate((needle) => {
		const rows = [...document.querySelectorAll('div[class*="sessionRow"]')]
			.filter((r) => !/新会话/.test(r.textContent ?? ''))
		const row = needle === '' ? rows[0] : rows.find((r) => (r.textContent ?? '').includes(needle))
		if (row === undefined) return null
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		return (row.textContent ?? '').trim().slice(0, 40)
	}, wanted)
	if (target === null) {
		// No prior session in this account: start one, which also produces a session.
		await tab.evaluate(() => {
			const row = [...document.querySelectorAll('div[class*="sessionRow"]')]
				.find((r) => /新会话/.test(r.textContent ?? ''))
			row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		})
	}
	record('打开了一个会话', target !== null, target ?? '（没有历史会话，改为新建）')
	// The badge asks the server about this session's working directory, and that answer
	// arrives after the session switch renders. Waiting for it is the difference between
	// reading this session's state and reading the previous one's.
	await tab.waitForResponse((r) => /\/client-web\/state/.test(r.url()), { timeout: 15000 }).catch(() => {})
	await tab.waitForTimeout(2500)

	let badge = await readBadge(tab)
	record('会话标题栏出现了执行位置控件', badge !== null && badge.text !== '',
		badge === null ? '没有找到控件' : `${badge.text}｜提示：${badge.title}`)
	record('控件说明了当前执行位置', badge !== null && badge.title !== '', badge?.title ?? '')

	if (badge !== null && executor !== '') {
		// The disabled case is checked first: a workspace outside every share rule has no
		// visible path, so its button is disabled by design and is not a binding failure.
		if (badge.disabled === true && /共享规则/.test(badge.title ?? '')) {
			record('无共享规则时按钮被禁用且说明原因', true, badge.title.slice(0, 90))
			record('控件仍然如实报告执行位置', badge.text === '服务器', badge.text)
		} else if (badge.action === '本地模式') {
			// The executor is started by the caller; the button being enabled is what proves
			// the badge saw it online.
			record('未绑定时提供绑定按钮', badge.disabled === false, `按钮=${badge.action} disabled=${badge.disabled}`)
			await clickAction(tab)
			await tab.waitForTimeout(5000)
			const after = await readBadge(tab)
			record('点击后变成已绑定', after?.text === '本地模式', `${after?.text}｜${after?.title}`)
			record('已绑定后按钮变成解绑', after?.action === '解绑', `按钮=${after?.action}`)
			record('已绑定后提示里带上机器名', /（.+）/.test(after?.title ?? ''), after?.title ?? '')

			// Put it back, so the check leaves the deployment as it found it.
			await clickAction(tab)
			await tab.waitForTimeout(5000)
			const restored = await readBadge(tab)
			record('解绑后回到未绑定', restored?.text === '服务器', `${restored?.text}｜${restored?.title}`)
		} else {
			record('该工作区已被占用或已绑定，控件仍如实显示', badge.text !== '', `${badge.text}｜${badge.title}`)
		}
	}

	record('页面没有脚本报错', errors.length === 0, errors.slice(0, 2).join(' | ') || '无')
} catch (error) {
	record('检查过程本身出错', false, String(error?.message ?? error))
} finally {
	await browser.close()
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) console.log(`失败：${failed.map((row) => row.name).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
