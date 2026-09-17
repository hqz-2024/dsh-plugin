/**
 * Ask the live deployment what visible path each workspace gets.
 *
 * The rules that derive a client-side path from a server directory are the difference
 * between a workspace whose bind button works and one whose button is correctly disabled,
 * so this reports the answer for every workspace the account can see rather than trusting
 * the configuration file to mean what it says.
 *
 * Usage: node check-visible-paths.mjs --origin https://192.168.28.239:8443 --user admin --password 123456
 */
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const origin = arg('--origin', 'https://192.168.28.239:8443')
const user = arg('--user', '')
const password = arg('--password', '')

const jar = new Map()
async function call(path, options = {}) {
	const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
	const response = await fetch(origin + path, {
		...options,
		headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(options.headers ?? {}) },
	})
	for (const raw of response.headers.getSetCookie?.() ?? []) {
		const [pair] = raw.split(';')
		const at = pair.indexOf('=')
		jar.set(pair.slice(0, at), pair.slice(at + 1))
	}
	const text = await response.text()
	try { return { status: response.status, body: JSON.parse(text) } } catch { return { status: response.status, body: text } }
}

const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) })
if (login.status !== 200 || login.body?.ok !== true) {
	console.error(`登录失败: HTTP ${login.status} ${JSON.stringify(login.body)}`)
	process.exit(1)
}

const state = await call('/client-web/state?cwd=')
const machines = state.body?.machines ?? []
console.log(`在线机器 (${machines.length}): ${machines.map((m) => `${m.machineId}${m.host ? ` (${m.host})` : ''}`).join(', ') || '(无)'}`)
console.log(`账号 ${user} 可见工作区 ${(state.body?.workspaces ?? []).length} 个：`)
for (const w of state.body?.workspaces ?? []) {
	const one = await call(`/client-web/state?cwd=${encodeURIComponent(w.path)}`)
	const ws = one.body?.workspace
	const visible = ws?.visiblePath ?? ''
	const binding = ws?.binding
	console.log(`  ${w.title}`)
	console.log(`    路径      : ${w.path}`)
	console.log(`    可见路径  : ${visible === '' ? '(无 —— 按钮会禁用)' : visible}`)
	console.log(`    绑定      : ${binding === null || binding === undefined ? '未绑定' : `已绑定到 ${binding.machineId ?? binding.machine ?? '?'}（归属 ${binding.occupiedBy ?? '?'}）`}`)
}
