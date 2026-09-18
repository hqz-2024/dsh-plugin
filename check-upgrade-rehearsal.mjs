/**
 * 升级演练验收：**旧对话在新版本里还在不在、能不能打开**，以及界面是否可用。
 *
 * 这是"上次升级对话全丢"那个问题的直接判据：不是问中间变量，而是问浏览器里
 * 到底看得见几条会话、点开一条能不能渲染出内容。
 *
 * 用法：node check-upgrade-rehearsal.mjs [baseUrl] [username] [password] [截图目录]
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3090'
const USER = process.argv[3] ?? 'admin'
const PASS = process.argv[4] ?? '123456'
const SHOTS = process.argv[5] ?? `${process.env.TEMP ?? '.'}\\dsh-upgrade-shots`

async function loadChromium() {
	const require = createRequire('file:///C:/nvm4w/nodejs/node_modules/@playwright/mcp/package.json')
	return require('playwright').chromium
}

const results = []
const record = (name, detail) => {
	results.push({ name, ...detail })
	console.log(`• ${name}: ${JSON.stringify(detail)}`)
}

mkdirSync(SHOTS, { recursive: true })
const chromium = await loadChromium()
const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)) })

// 1) 登录（与部署里 check-client-ui.mjs 同一套流程）
const login = await context.request.post(`${BASE}/auth/login`, { data: { username: USER, password: PASS } })
record('login', { status: login.status() })
if (login.status() !== 200) {
	console.log(JSON.stringify({ results, fatal: 'login failed' }, null, 2))
	process.exit(1)
}

// 2) 打开界面，等会话列表出现
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
await page.screenshot({ path: `${SHOTS}/01-after-login.png` })

// 会话行：部署里的会话列表挂在工作区侧栏下（div.x8saxG_projectRow 是工作区行）。
// 这里按"可点开的历史条目"来数，避免绑定到会被上游改掉的 class 名。
const counts = await page.evaluate(() => {
	const text = document.body.innerText
	const parse = (pattern) => (text.match(pattern) ?? []).length
	return {
		bodyChars: text.length,
		projectRows: document.querySelectorAll('div[class*="projectRow"]').length,
		chatLinks: document.querySelectorAll('a[href*="/session"], [data-session-id]').length,
		mentionsDeepseek: parse(/deepseek-harness/g),
		mentionsBaodan: parse(/宝单科技资料/g),
		mentionsWeizhong: parse(/微众诉讼/g),
		hasEmptyHint: /没有|暂无|No sessions|empty/i.test(text),
	}
})
record('session-list', counts)
writeFileSync(`${SHOTS}/after-login.txt`, await page.evaluate(() => document.body.innerText.slice(0, 4000)))

// 3) 逐个工作区点开，数出现的会话条目
const workspaceNames = ['宝单科技资料', 'deepseek-harness', '微众诉讼']
const perWorkspace = {}
for (const name of workspaceNames) {
	try {
		const node = page.getByText(name, { exact: true }).first()
		await node.click({ timeout: 8000 })
		await page.waitForTimeout(2500)
		perWorkspace[name] = await page.evaluate(() => {
			// 侧栏里的历史条目：能点到、带标题文本的行
			const rows = [...document.querySelectorAll('div,li,button')]
				.filter((el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 3)
			return { visibleRows: rows.length }
		})
		await page.screenshot({ path: `${SHOTS}/02-${encodeURIComponent(name)}.png` })
	} catch (error) {
		perWorkspace[name] = { error: String(error?.message ?? error).slice(0, 160) }
	}
}
record('per-workspace', perWorkspace)

// 4) 打开第一条会话，看有没有渲染出对话内容。
//    会话行在上游是**文本行**而不是 <a href="/session">，所以按标题文本点。
const sessionTitles = ['查询主机名', 'Session 111', 'Untitled coding session', 'AAA', '宝单科技资料']
let opened = { opened: false }
for (const title of sessionTitles) {
	try {
		const node = page.getByText(title, { exact: true }).first()
		if (await node.count() === 0) continue
		const before = await page.evaluate(() => document.body.innerText.length)
		await node.click({ timeout: 8000 })
		await page.waitForTimeout(3500)
		const after = await page.evaluate(() => document.body.innerText.length)
		await page.screenshot({ path: `${SHOTS}/03-session-open.png` })
		writeFileSync(`${SHOTS}/session-open.txt`, await page.evaluate(() => document.body.innerText.slice(0, 4000)))
		opened = { opened: true, title, charsBefore: before, charsAfter: after, rendered: after > before + 200 }
		break
	} catch (error) {
		opened = { opened: false, title, error: String(error?.message ?? error).slice(0, 160) }
	}
}
record('open-session', opened)

record('console-errors', { count: consoleErrors.length, sample: consoleErrors.slice(0, 5) })
writeFileSync(`${SHOTS}/rehearsal-report.json`, JSON.stringify({ base: BASE, results }, null, 2))
console.log(`\n截图与报告：${SHOTS}`)
await browser.close()
