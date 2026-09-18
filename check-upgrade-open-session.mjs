/**
 * 升级演练：**打开一条历史会话，看内容是否真的渲染出来**。
 * 这是"旧对话还在不在"的最终判据 —— 列表出现不算，点开能看到当时的对话才算。
 *
 * 用法：node check-upgrade-open-session.mjs [baseUrl] [用户名] [口令] [会话标题]
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3090'
const USER = process.argv[3] ?? 'admin'
const PASS = process.argv[4] ?? '123456'
const TITLE = process.argv[5] ?? '查询主机名'
const out = `${process.env.TEMP ?? '.'}\\dsh-upgrade-open.txt`

const require = createRequire('file:///C:/nvm4w/nodejs/node_modules/@playwright/mcp/package.json')
const { chromium } = require('playwright')
const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

await context.request.post(`${BASE}/auth/login`, { data: { username: USER, password: PASS } })
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)

const before = await page.evaluate(() => document.body.innerText)
const node = page.getByText(TITLE, { exact: true }).first()
console.log('找到会话标题:', await node.count())
await node.click({ timeout: 10000 })
await page.waitForTimeout(4000)
const after = await page.evaluate(() => document.body.innerText)
await page.screenshot({ path: `${process.env.TEMP}\\dsh-upgrade-open.png` })
writeFileSync(out, after.slice(0, 6000))

const added = after.length - before.length
console.log(JSON.stringify({ title: TITLE, charsBefore: before.length, charsAfter: after.length, added }, null, 2))
console.log('--- 打开后的正文（前 700 字）---')
console.log(after.slice(0, 700))
await browser.close()
