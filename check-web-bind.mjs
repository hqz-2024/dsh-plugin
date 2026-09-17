/**
 * Check the Web UI binding surface: state, unbind, and bind with generated paths.
 *
 * This is the surface the session header talks to, so it is worth checking on its own
 * rather than only through the browser: the refusals carry remedies, and the two paths a
 * binding needs are supposed to be computed rather than typed.
 *
 * The run needs an executor already connected for the account, which is what makes a
 * bind possible at all — the check reports that precondition instead of assuming it.
 *
 * Usage:
 *   node check-web-bind.mjs --origin http://127.0.0.1:3084 --user <account> --password <secret>
 *                           [--cwd <a workspace directory on the server>]
 */
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const origin = arg('--origin', 'http://127.0.0.1:3084')
const user = arg('--user', '')
const password = arg('--password', '')

const results = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** One signed-in request, sharing the cookie jar across calls. */
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
	let body
	try { body = JSON.parse(text) } catch { body = text }
	return { status: response.status, body }
}

const signedIn = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) })
record('登录', signedIn.status === 200 && signedIn.body?.ok === true, `HTTP ${signedIn.status}`)

record('无会话时被拒', (await fetch(`${origin}/client-web/state`)).status === 403, '门禁答的 403')

// The workspace is discovered from the state call itself, so the check does not need a
// second source of truth for what exists.
const anyWorkspace = arg('--cwd', '')
if (anyWorkspace === '') {
	record('给了 cwd（这个检查需要它来定位工作区）', false, '用 --cwd 指定一个服务器上的工作区目录')
} else {
	const state = await call(`/client-web/state?cwd=${encodeURIComponent(anyWorkspace)}`)
	const workspace = state.body?.workspace
	record('从 cwd 解析出工作区', workspace != null, workspace ? `${workspace.title} (${workspace.id})` : String(state.body?.error ?? state.status))
	record('可见路径是自动生成的', typeof workspace?.visiblePath === 'string' && workspace.visiblePath !== '',
		`visiblePath=${JSON.stringify(workspace?.visiblePath)}`)
	record('暂存目录按客户端默认给出（执行器再展开变量）', workspace?.stagingDir === '%USERPROFILE%\\.dsh-staging',
		`stagingDir=${JSON.stringify(workspace?.stagingDir)}`)
	record('state 报告执行器是否在线', typeof state.body?.connected === 'boolean', `connected=${state.body?.connected}`)

	if (workspace != null) {
		if (workspace.binding !== null) {
			record('该工作区已被占用，绑定应被拒并点名占用者', true,
				`占用者 ${workspace.binding.occupiedBy}（属于本账号=${workspace.binding.mine}）`)
			const refused = await call('/client-web/bind', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id }) })
			if (workspace.binding.mine) {
				record('先解绑（自己的绑定）', (await call('/client-web/unbind', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id }) })).status === 200, '')
			} else {
				record('他人占用时给出原因', refused.status === 409 && refused.body?.reason === 'occupied',
					`HTTP ${refused.status} ${JSON.stringify(refused.body).slice(0, 140)}`)
			}
		}

		// Bind with no paths at all: everything must come from the server's rules.
		const bound = await call('/client-web/bind', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id }) })
		const boundOk = bound.status === 200 && bound.body?.ok === true
		record('绑定（不传任何路径）', boundOk || bound.body?.reason === 'no-executor',
			`HTTP ${bound.status} ${JSON.stringify(bound.body).slice(0, 180)}`)
		if (boundOk) {
			record('绑定记录用的是自动生成的可见路径',
				bound.body.binding?.visiblePath === workspace.visiblePath,
				`记录=${JSON.stringify(bound.body.binding?.visiblePath)} 建议=${JSON.stringify(workspace.visiblePath)}`)
			record('绑定记录带上了机器的名字', typeof bound.body.binding?.machine === 'string' && bound.body.binding.machine !== '',
				`machine=${JSON.stringify(bound.body.binding?.machine)}`)

			const after = await call(`/client-web/state?cwd=${encodeURIComponent(anyWorkspace)}`)
			record('绑定后 state 显示为已绑定', after.body?.workspace?.binding !== null,
				`mine=${after.body?.workspace?.binding?.mine} machine=${after.body?.workspace?.binding?.machine}`)

			const released = await call('/client-web/unbind', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id }) })
			record('解绑', released.status === 200 && released.body?.ok === true, `HTTP ${released.status}`)
			const final = await call(`/client-web/state?cwd=${encodeURIComponent(anyWorkspace)}`)
			record('解绑后 state 回到未绑定', final.body?.workspace?.binding === null, '')
		} else {
			record('绑定（需要一个在线的执行器）', false,
				`HTTP ${bound.status}：${JSON.stringify(bound.body)} —— 先在这台机器上启动执行器再跑`)
		}
	}
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) console.log(`失败：${failed.map((row) => row.name).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
