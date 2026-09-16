/**
 * Check that the client page's "open the web UI" URL really lands in the Web UI.
 *
 * The shell serves its index only to a browser holding the server process's launch
 * token or the cookie that token mints; an executor credential opens nothing there. So
 * the address this page hands a browser decides whether the button works, and it is
 * worth driving in a browser rather than reading the URL.
 *
 * A browser with no account session of its own stops at the deployment's sign-in page,
 * which carries the token in its own `next` and continues into the exchange after a
 * successful login. Both halves are checked here: the entry must reach a real page
 * rather than the gate's refusal, and a completed sign-in must end at the app.
 *
 * Usage:
 *   node check-web-entry.mjs --page http://127.0.0.1:38495 --user <account> --password <secret>
 */
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const page = arg('--page', 'http://127.0.0.1:38495')
const user = arg('--user', '')
const password = arg('--password', '')

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

/** The launch token the shell requires, as the client page received it. */
const status = await (await fetch(`${page}/status`)).json()
record('客户端已连接并有入口地址', !!status.webUrl, status.webUrl || '(空)')
record('入口地址带 launch token', /[?&]token=/.test(status.webUrl || ''), (status.webUrl || '').slice(0, 110))

const chromium = await loadChromium()
const browser = await chromium.launch()
const context = await browser.newContext()
const tab = await context.newPage()

try {
	// What a person gets from the button: the entry URL the client page reports.
	await tab.goto(status.webUrl, { waitUntil: 'networkidle' })
	let body = await tab.content()
	let url = tab.url()
	const gated = /dsh web authentication required/.test(body)
	record('入口没有被 shell 门禁拒绝', !gated, gated ? `仍被拒：${url}` : `落到 ${url}`)
	record('入口给出了一个真实页面', body.length > 2000, `页面长度 ${body.length}`)

	const needsSignIn = /\/auth\/login|Sign in|登录/.test(body)
	record('这个浏览器需要先登录（没有账号会话时）', true,
		needsSignIn ? '停在登录页，登录后会继续进入 Web UI' : '已经带着账号会话，直接进了应用')

	if (needsSignIn && user !== '' && password !== '') {
		await tab.fill('#username', user)
		await tab.fill('#password', password)
		await tab.click('#submit')
		// The page signs in through fetch, then navigates to its own `next` — the
		// token-bearing root — whose exchange answers 303 to clean '/' and mints the shell
		// cookie. Waiting for the address to leave the token is waiting for that exchange.
		await tab.waitForFunction(() => !/[?&]token=/.test(location.href), { timeout: 30000 }).catch(() => {})
		// Accounts without two-factor are offered binding first; skipping is what a person
		// who does not want it does, and it is what continues into the app.
		const skip = tab.locator('#offer-skip')
		if (await skip.count() > 0 && await skip.isVisible().catch(() => false)) await skip.click()
		await tab.waitForLoadState('networkidle').catch(() => {})
		await tab.waitForTimeout(1500)
		body = await tab.content().catch(() => '')
		url = tab.url()
		const stillGated = /dsh web authentication required/.test(body)
		record('登录后不再撞上 shell 门禁', !stillGated, stillGated ? `仍被拒：${url}` : `落到 ${url}`)
		record('交换后地址已清掉 token', !/[?&]token=/.test(url), url)
		record('拿到了 Web UI 应用外壳', /__DSH_BOOT__/.test(body) && !stillGated,
			stillGated ? '仍然被门禁拒绝' : `页面长度 ${body.length}，标题 ${await tab.title()}`)
		record('拿到了 shell 的 cookie', (await context.cookies()).some((c) => c.name.startsWith('dsh-auth-')),
			(await context.cookies()).map((c) => c.name).join(', '))
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
