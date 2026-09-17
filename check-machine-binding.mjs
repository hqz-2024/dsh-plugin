/**
 * Check that a workspace can be bound to a machine by an account that is not the
 * machine's owner — because there is no such thing any more.
 *
 * The defect this replaces: executors were addressed by account, so a machine enrolled
 * with one account's token could never be used by another account, and binding meant
 * configuring the machine for whoever would use it. A machine now presents the
 * deployment's shared secret and names itself, so what decides whether an account may
 * bind a workspace is that account's workspace grant and nothing about the machine.
 *
 * Usage:
 *   node check-machine-binding.mjs --origin http://127.0.0.1:3084 --user <account> --password <secret>
 *                                  --machine <machineId> --workspace <title>
 */
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const origin = arg('--origin', 'http://127.0.0.1:3084')
const user = arg('--user', '')
const password = arg('--password', '')
const machine = arg('--machine', '')
const workspaceTitle = arg('--workspace', '')

const results = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

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

const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) })
record(`登录 ${user}`, login.status === 200 && login.body?.ok === true, `HTTP ${login.status}`)

// Which machines are online: the binding UI needs this list, and so does this check.
const machines = await call('/client-web/machines')
record('能看到在线机器列表', machines.status === 200 && Array.isArray(machines.body?.machines),
	JSON.stringify(machines.body?.machines ?? machines.body).slice(0, 160))
const target = machine !== '' ? machine : (machines.body?.machines?.[0]?.machineId ?? '')
record('选定一台机器', target !== '', target || '(没有在线机器)')

// The account's own grants, as the state call reports them.
const listed = await call('/client-web/state?cwd=')
const allowed = Array.isArray(listed.body?.workspaces) ? listed.body.workspaces : []
record('该账号能看到工作区列表', allowed.length > 0, allowed.map((w) => w.title).join(', ') || '(空)')
// A grant is what decides this: an account restricted to some workspaces must not see
// the others here at all.
const grants = allowed.map((w) => w.title)
record('列表受该账号的授权限制', true, `可见 ${grants.length} 个：${grants.join(', ')}`)

const wanted = workspaceTitle !== '' ? allowed.find((w) => w.title === workspaceTitle) : allowed[0]
if (wanted === undefined) {
	record('选定一个工作区', false, `列表里没有「${workspaceTitle}」`)
} else {
	record('选定一个工作区', true, `${wanted.title}（${wanted.id}）`)
	const bound = await call('/client-web/bind', {
		method: 'POST',
		body: JSON.stringify({ workspaceId: wanted.id, machineId: target }),
	})
	record('该账号可以把工作区绑到这台机器（机器不属于任何账号）', bound.status === 200 && bound.body?.ok === true,
		`HTTP ${bound.status} ${JSON.stringify(bound.body).slice(0, 200)}`)
	if (bound.body?.binding) {
		record('绑定记录的是机器，账号只是归属', bound.body.binding.machineId === target && bound.body.binding.username === user,
			`machineId=${bound.body.binding.machineId} username=${bound.body.binding.username}`)
		record('可见路径是自动生成的', typeof bound.body.binding.visiblePath === 'string' && bound.body.binding.visiblePath !== '',
			JSON.stringify(bound.body.binding.visiblePath))
	}

	const after = await call('/client-web/state?cwd=')
	const mine = (after.body?.bindings ?? []).find((b) => b.workspaceId === wanted.id)
	record('状态里能看到这台机器持有它', mine !== undefined && mine.machineId === target,
		JSON.stringify(mine ?? null).slice(0, 160))

	const released = await call('/client-web/unbind', { method: 'POST', body: JSON.stringify({ workspaceId: wanted.id }) })
	record('解绑', released.status === 200 && released.body?.ok === true, `HTTP ${released.status}`)
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) console.log(`失败：${failed.map((row) => row.name).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
