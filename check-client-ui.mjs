/**
 * Drives a real browser against a running dsh profile to check the admin
 * workspace-bindings section (plan §2.1's second manual exit).
 *
 * Why a browser rather than a static check: both bugs this found were invisible
 * to reading. The bundle first failed to load entirely (`cannot get property
 * "slots" without inject`), and once it loaded its label rendered in English
 * beside correctly translated neighbours because the locale was guessed from
 * `document.documentElement.lang` instead of the app's locale service.
 *
 * Usage:
 *   node check-client-ui.mjs [baseUrl] [username] [password]
 * Defaults target the pilot-auth profile, whose seeded admin has a known password.
 *
 * Requires a browser engine. Playwright is resolved from the @playwright/mcp
 * install if it is not a direct dependency of the current project.
 */
import { createRequire } from 'node:module'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3084'
const USER = process.argv[3] ?? 'probe-admin'
const PASS = process.argv[4] ?? 'probe-admin-password'

/** Resolve playwright from wherever it happens to live on this machine. */
function loadPlaywright() {
	const anchors = [
		import.meta.url,
		'C:\\nvm4w\\nodejs\\node_modules\\@playwright\\mcp\\package.json',
	]
	for (const anchor of anchors) {
		try {
			return createRequire(anchor)('playwright')
		} catch {
			// Try the next anchor.
		}
	}
	try {
		return createRequire(process.cwd() + '/package.json')('playwright-core')
	} catch {
		console.error('playwright is not resolvable; install it or run where @playwright/mcp is present')
		process.exit(2)
	}
}

const { chromium } = loadPlaywright()
const record = (step, detail) => console.log(JSON.stringify({ step, ...detail }))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error.message)))

try {
	const login = await context.request.post(`${BASE}/auth/login`, { data: { username: USER, password: PASS } })
	record('login', { status: login.status() })
	if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`)

	await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
	await page.waitForTimeout(3500)

	// A failed client bundle shows up here as a page-level error banner.
	const body = await page.locator('body').innerText()
	record('bundle-loaded', { failedToLoadPlugins: body.includes('Failed to load plugins') })

	await page.getByText('设置', { exact: true }).first().click()
	await page.waitForTimeout(1500)

	const section = page.getByText('工作区绑定', { exact: true }).first()
	if ((await section.count()) === 0) {
		record('section', { found: false, tail: (await page.locator('body').innerText()).slice(-400) })
		throw new Error('the bindings section is not in the settings list')
	}
	await section.click()
	await page.waitForTimeout(2000)

	const panel = await page.locator('body').innerText()
	record('section', {
		found: true,
		hasTableHeader: panel.includes('占用人') && panel.includes('机器'),
		hasNoneMessage: panel.includes('当前没有任何绑定'),
		hasDeniedMessage: panel.includes('需要管理员权限'),
	})

	const rows = await page.locator('table tbody tr').count()
	record('rows', {
		count: rows,
		active: await page.getByText('占用中', { exact: false }).count(),
		first: rows > 0 ? (await page.locator('table tbody tr').first().innerText()).replace(/\n/g, ' | ') : null,
	})

	const unbind = page.getByRole('button', { name: '强制解绑' }).first()
	if ((await unbind.count()) === 0) {
		record('unbind', { present: false, note: 'no active binding to release' })
	} else {
		await unbind.click()
		await page.waitForTimeout(2500)
		const after = await page.locator('body').innerText()
		record('unbind', {
			present: true,
			saidReleased: after.includes('已释放'),
			saidFailed: after.includes('释放失败'),
			anyActiveRowLeft: after.includes('占用中'),
		})
	}

	record('page-errors', { count: pageErrors.length, errors: pageErrors.slice(0, 5) })
} finally {
	await browser.close()
}
