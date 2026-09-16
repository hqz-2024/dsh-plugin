/**
 * Drive the executor's own configuration page through the enrollment flow.
 *
 * The page is the only user interface the packaged client has, and it is generated
 * from a template literal inside `executor.mjs` — a class of bug (`\n` consumed by the
 * template, a server-side helper called from the browser, a comment backtick ending the
 * template) that `node --check` cannot see and that has shipped twice. So this runs the
 * real page in a real browser and reports what a person would have seen.
 *
 * What it proves, in order: the page loads with no console error; signing in against
 * the server exchanges the password for an executor credential; a launcher-installed
 * machine (token, no password) still gets the workspace picker; the visible path is
 * pre-filled from the server's share rules; and binding reports success.
 *
 * Usage:
 *   node check-executor-enroll.mjs [--port 38475] [--server https://host:8443]
 *                                  [--user <account>] [--password <secret>]
 *                                  [--workspace <title>]
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const page = `http://127.0.0.1:${arg('--port', '38475')}/`
const server = arg('--server', '')
const user = arg('--user', '')
const password = arg('--password', '')
const wantWorkspace = arg('--workspace', '')
/** Credentials are required only when the machine is not already enrolled by a launcher. */
const signsIn = user !== '' && password !== ''

/** Playwright is resolved the same way the other checkers resolve it. */
async function loadChromium() {
	const require = createRequire('file:///C:/nvm4w/nodejs/node_modules/@playwright/mcp/package.json')
	return require('playwright').chromium
}

const results = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const chromium = await loadChromium()
const browser = await chromium.launch()
const context = await browser.newContext()
// `window.open` is captured rather than allowed to open a real tab: the check is that
// the page asks for the right address, and a stray window would outlive the run.
await context.addInitScript(() => {
	window.__opened = []
	window.open = (url) => { window.__opened.push(String(url)); return null }
})
const tab = await context.newPage()
const consoleErrors = []
tab.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
tab.on('pageerror', (error) => { consoleErrors.push(String(error.message)) })

try {
	const response = await tab.goto(page, { waitUntil: 'domcontentloaded' })
	record('页面加载', response?.status() === 200, `HTTP ${response?.status()}`)
	record('页面脚本无报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无')

	// The rendered state, read once the page has finished its own first refresh. Every
	// later step compares against this rather than against a fixed string, so a step
	// waits for a change instead of for a duration.
	const stateText = await tab.textContent('#stateText')
	record('状态区有内容', (stateText ?? '').trim() !== '', (stateText ?? '').trim())

	if (signsIn) {
		record('未配置时登录表单是展开的', await tab.isVisible('#username'), '新机器打开页面就能直接填')
		await tab.fill('#server', server)
		await tab.fill('#username', user)
		await tab.fill('#password', password)
		await tab.click('button:has-text("登录并连接")')
		// The outcome is read from the status panel, which is what the page itself uses
		// to report the result — the message line is a transient banner and may already
		// have been replaced by the time this looks.
		let message = ''
		try {
			await tab.waitForFunction(
				(previous) => (document.getElementById('stateText')?.textContent ?? '') !== previous,
				stateText,
				{ timeout: 25000 },
			)
			message = (await tab.textContent('#msg'))?.trim() ?? ''
		} catch {
			message = `状态没有变化（仍是「${(await tab.textContent('#stateText'))?.trim()}」）`
		}
		const nowState = (await tab.textContent('#stateText'))?.trim() ?? ''
		record('登录并换取凭据', /已连接服务器/.test(nowState), `${nowState}${message === '' ? '' : ` / ${message}`}`)
	} else {
		// Launcher path: no password, but the picker must still appear from the token.
		await tab.waitForFunction(
			() => !/正在读取/.test(document.getElementById('workspaces')?.textContent ?? ''),
			{ timeout: 20000 },
		)
		record('无需登录即列出工作区', true, '启动脚本形态')
	}

	const rendered = await tab.evaluate(() => {
		const box = document.getElementById('workspaces')
		return {
			text: box?.textContent?.trim() ?? '',
			titles: [...box.querySelectorAll('b')].map((node) => node.textContent),
			paths: [...box.querySelectorAll('code')].map((node) => node.textContent),
			visibleInputs: [...box.querySelectorAll('input[id^="vp-"]')].map((node) => node.value),
			bindButtons: box.querySelectorAll('button').length,
		}
	})
	record('工作区列表已渲染', rendered.titles.length > 0, `${rendered.titles.length} 个：${rendered.titles.join(', ')}`)

	// The pre-filled path is what makes binding one click: the operator should not have
	// to know the share layout the server defined.
	const anyPrefilled = rendered.visibleInputs.some((value) => value.trim() !== '')
	record('可见路径已按服务器共享规则预填', anyPrefilled || rendered.titles.length === 0, rendered.visibleInputs.join(' | ') || '(没有工作区)')

	record('页面脚本始终无报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无')

	const index = wantWorkspace === '' ? 0 : rendered.titles.indexOf(wantWorkspace)
	if (rendered.titles.length === 0) {
		record('绑定工作区', false, '没有可绑定的工作区，无法验证绑定')
	} else if (index < 0) {
		record('绑定工作区', false, `没有找到工作区「${wantWorkspace}」`)
	} else {
		// Scoped to the workspace's own block: every row carries its own buttons.
		const block = tab.locator('#workspaces > div').nth(index)
		const labels = await block.locator('button').allTextContents()
		record('这一行有绑定按钮', labels.some((label) => label.includes('绑定')), `按钮：${labels.join('/')}`)
		const bindButton = block.locator('button', { hasText: '绑定' }).first()
		await bindButton.click()
		let outcome = ''
		try {
			await tab.waitForFunction(
				() => /绑定成功|绑定失败|失败|错误/.test(document.getElementById('msg')?.textContent ?? ''),
				{ timeout: 15000 },
			)
			outcome = (await tab.textContent('#msg'))?.trim() ?? ''
		} catch {
			// The click started the handler (no page error) yet nothing was reported, or the
			// handler threw a rejection `show()` never sees. Report both so the reason is in
			// the output rather than inferred from a timeout.
			outcome = '(无结果：页面没有任何回应)'
		}
		// The message is the whole point when binding is refused: the server rejects a
		// workspace with no share suggestion, one another machine already holds, and one
		// the account may not use. A refusal the page swallowed would look like a dead
		// button, so the page's own text is the evidence — printed, not reinterpreted.
		record('绑定工作区', outcome.startsWith('绑定成功'), `${rendered.titles[index]} → ${outcome}`)
		try {
			const status = await (await fetch(`http://127.0.0.1:${arg('--port', '38475')}/status`)).json()
			const held = status.heldShares ?? []
			record('绑定已落到状态里', held.length > 0, `heldShares=${held.length} connected=${status.connected}`)
			record('状态区显示已连接且已绑定', /已连接服务器/.test(await tab.textContent('#stateText') ?? '') && /正在执行/.test(await tab.textContent('#stateDetail') ?? ''),
				`${(await tab.textContent('#stateText'))?.trim()} / ${(await tab.textContent('#stateDetail'))?.trim()}`)
		} catch (error) {
			record('绑定已落到状态里', false, String(error?.message ?? error))
		}
		// The button that replaces "now go find the web UI yourself".
		record('「打开 Web UI」已启用', await tab.isEnabled('#openWeb'), `提示：${(await tab.textContent('#webHint'))?.trim()}`)
		if (await tab.isEnabled('#openWeb')) {
			await tab.click('#openWeb')
			await tab.waitForFunction(() => (window.__opened ?? []).length > 0, { timeout: 10000 }).catch(() => {})
			const opened = await tab.evaluate(() => window.__opened ?? [])
			const status = await (await fetch(`http://127.0.0.1:${arg('--port', '38475')}/status`)).json()
			record('「打开 Web UI」打开的是这台机器注册的服务器', opened.length > 0 && opened[0] === status.webUrl,
				`打开了 ${opened.join(', ') || '(没有)'}，服务器注册值是 ${status.webUrl}`)
		}
	}
} catch (error) {
	record('检查过程本身出错', false, String(error?.message ?? error))
} finally {
	await browser.close()
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) console.log(`失败：${failed.map((row) => row.name).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
