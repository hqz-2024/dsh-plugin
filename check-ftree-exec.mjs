/**
 * Check the file tree panel's execution-location control in a real browser.
 *
 * The control lives in a third-party plugin's panel header, so nothing short of opening
 * the app proves it rendered: the panel is built at runtime, and a mistake in the header
 * tree (a missing style, a null state read before the first fetch) shows up only there.
 *
 * Usage:
 *   node check-ftree-exec.mjs --origin https://192.168.28.239:8443 --user admin --password 123456
 */
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const origin = arg('--origin', 'https://192.168.28.239:8443')
const user = arg('--user', '')
const password = arg('--password', '')
/** A session whose workspace sits under a shared root, for the bindable case. */
const sessionTitle = arg('--session', '')

const require = createRequire('file:///C:/nvm4w/nodejs/node_modules/@playwright/mcp/package.json')
const { chromium } = require('playwright')

const results = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const tab = await context.newPage()
const errors = []
tab.on('pageerror', (error) => errors.push(String(error.message)))
tab.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
const execCalls = []
tab.on('response', (response) => {
	if (/client-web\//.test(response.url())) execCalls.push(`${response.status()} ${response.url().replace(origin, '').replace(/cwd=[^&]*/, 'cwd=…')}`)
})

try {
	await tab.goto(`${origin}/`, { waitUntil: 'networkidle' })
	if (await tab.locator('#username').count() > 0) {
		await tab.fill('#username', user)
		await tab.fill('#password', password)
		await tab.click('#submit')
		const skip = tab.locator('#offer-skip')
		await skip.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
		if (await skip.isVisible().catch(() => false)) await skip.click()
	}
	await tab.waitForFunction(() => !!window.__DSH_BOOT__, { timeout: 30000 }).catch(() => {})
	await tab.waitForLoadState('networkidle').catch(() => {})
	record('进入 Web UI', /__DSH_BOOT__/.test(await tab.content().catch(() => '')), tab.url())

	// The panel is already mounted (it is a fixed overlay the toggle shows and hides), so
	// this waits for it rather than clicking the toggle — a synthetic click on that handle
	// does not drive the plugin's own state, and the click that does is not the subject here.
	await tab.waitForSelector('.dsh-ftree-col', { timeout: 20000 }).catch(() => {})
	await tab.waitForTimeout(3000)

	/** Read the control for whichever workspace the panel currently shows. */
	const readPanel = () => tab.evaluate(() => {
		const col = document.querySelector('.dsh-ftree-col')
		if (!col) return { present: false }
		const chip = col.querySelector('.dsh-ftree-exec-chip')
		const action = [...col.querySelectorAll('.dsh-ftree-col-head .dsh-ftree-btn')]
			.find((b) => ['本地模式', '解绑'].includes((b.textContent || '').trim()))
		return {
			present: true,
			title: (col.querySelector('.dsh-ftree-title')?.textContent ?? '').trim(),
			path: (col.querySelector('.dsh-ftree-path')?.textContent ?? '').trim(),
			chip: chip ? (chip.textContent ?? '').trim() : null,
			chipTitle: chip ? chip.getAttribute('title') : null,
			chipOn: chip ? chip.className.includes('on') : null,
			action: action ? (action.textContent ?? '').trim() : null,
			actionDisabled: action ? action.className.includes('disabled') : null,
			actionTitle: action ? action.getAttribute('title') : null,
		}
	})

	let panel = await readPanel()
	record('文件树面板已挂载', panel.present === true, panel.present ? `标题=${panel.title} 路径=${panel.path}` : '没有 .dsh-ftree-col')
	record('面板头部出现执行位置控件', typeof panel.chip === 'string' && panel.chip !== '', `chip=${JSON.stringify(panel.chip)}`)
	record('控件说明了当前执行位置', typeof panel.chipTitle === 'string' && panel.chipTitle !== '', panel.chipTitle ?? '')
	record('面板确实问过 /client-web', execCalls.length > 0, execCalls.slice(0, 2).join(' | ') || '(没有请求)')
	record('头部有绑定/解绑按钮', panel.action === '本地模式' || panel.action === '解绑',
		`按钮=${JSON.stringify(panel.action)} disabled=${panel.actionDisabled}`)

	// A workspace that cannot be bound must say why rather than offering a request that is
	// certain to be refused; that is the case this landed on first.
	if (panel.actionDisabled === true) {
		record('不可绑时按钮禁用并说明原因', /共享|机器/.test(panel.actionTitle ?? ''), panel.actionTitle ?? '')
	}

	// Then the bindable case: the panel follows the open session's workspace, so switch to
	// one under the share root and read it again.
	if (sessionTitle !== '') {
		await tab.evaluate((needle) => {
			const row = [...document.querySelectorAll('div[class*="sessionRow"]')]
				.find((r) => (r.textContent ?? '').includes(needle))
			row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		}, sessionTitle)
		await tab.waitForResponse((r) => /\/client-web\/state/.test(r.url()), { timeout: 15000 }).catch(() => {})
		await tab.waitForTimeout(3000)
		panel = await readPanel()
		record('切到共享根下的工作区后，控件跟随会话', panel.present === true, `${panel.title}｜${panel.chip}｜按钮=${panel.action} disabled=${panel.actionDisabled}`)

		if (panel.action === '本地模式' && panel.actionDisabled !== true) {
			record('可绑时按钮可用', true, `提示：${panel.actionTitle}`)
			// Bind, then put it back: the check leaves the deployment as it found it.
			await tab.evaluate(() => {
				const col = document.querySelector('.dsh-ftree-col')
				const action = [...col.querySelectorAll('.dsh-ftree-col-head .dsh-ftree-btn')]
					.find((b) => (b.textContent || '').trim() === '本地模式')
				action?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			})
			await tab.waitForTimeout(6000)
			const after = await readPanel()
			record('点击后变成已绑定', after.chip === '本地模式' && after.action === '解绑',
				`chip=${after.chip} 按钮=${after.action} 提示=${after.chipTitle}`)
			await tab.evaluate(() => {
				const col = document.querySelector('.dsh-ftree-col')
				const action = [...col.querySelectorAll('.dsh-ftree-col-head .dsh-ftree-btn')]
					.find((b) => (b.textContent || '').trim() === '解绑')
				action?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			})
			await tab.waitForTimeout(6000)
			const restored = await readPanel()
			record('解绑后回到服务器', restored.chip === '服务器', `chip=${restored.chip} 按钮=${restored.action}`)
		}
	}

	record('页面没有脚本报错', errors.length === 0, errors.slice(0, 3).join(' | ') || '无')
} catch (error) {
	record('检查过程本身出错', false, String(error?.message ?? error))
} finally {
	await browser.close()
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) console.log(`失败：${failed.map((row) => row.name).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
