/**
 * Check the executor's OWN configuration page: does its JavaScript actually parse?
 *
 * Why this needs its own tool: that page is built as a template literal inside
 * `executor.mjs`, so the page's JavaScript is *generated* text. An escape that the
 * template literal consumes — `'\n'` written inside it becomes a real newline in the
 * page — produces valid executor source and INVALID page script. The executor loads
 * fine, the HTTP routes answer fine from PowerShell, and the page renders; only the
 * buttons do nothing, because the whole `<script>` failed to parse and `signIn` is
 * simply undefined. That is exactly how this shipped once: every route was tested
 * over HTTP, and nobody clicked.
 *
 * Usage:
 *   node check-executor-page.mjs                 # start one on a scratch port, check it, stop it
 *   node check-executor-page.mjs --port 38460    # use this port (still starts its own by default)
 *   node check-executor-page.mjs --external      # do not start one: check what is already running
 *   node check-executor-page.mjs --entry <file>  # check a specific copy (e.g. a downloaded one)
 *
 * Exit code is the number of failed checks.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
	const at = argv.indexOf(name)
	return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const port = Number(arg('--port', '0')) || 38463
// `--port` says WHICH port; it must not also mean "something is already there". Conflating
// the two made this checker report "页面能打开: FAIL" against a copy it never started.
const external = argv.includes('--external')
const entryOption = arg('--entry', '')
const entry = entryOption !== ''
	? entryOption
	: fileURLToPath(new URL('./plugins/dsh-subprocess-dispatch/executor/executor.mjs', import.meta.url))
const statePath = fileURLToPath(new URL('./plugins/dsh-subprocess-dispatch/executor/.page-check-state.json', import.meta.url))

let child
let failures = 0
const check = (name, ok, detail) => {
	console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${name}`)
	if (!ok) {
		failures += 1
		console.log(`         ${detail}`)
	}
}

/** Wait until the page answers, or give up. */
async function waitForPage(deadlineMs = 15000) {
	const until = Date.now() + deadlineMs
	while (Date.now() < until) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`)
			if (response.ok) return await response.text()
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	return undefined
}

if (!external) {
	// A state file that does not exist leaves the process unenrolled, which is exactly
	// the state that serves the page — and it keeps this check off the network.
	child = spawn(process.execPath, [entry, '--config-port', String(port), '--state', statePath], {
		stdio: ['ignore', 'ignore', 'inherit'],
		windowsHide: true,
	})
}

try {
	const page = await waitForPage()
	if (page === undefined) {
		check('页面能打开', false, `http://127.0.0.1:${port}/ 在 15 秒内没有响应`)
	} else {
		check('页面能打开', true)
		const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
		check('页面里有内联脚本', script.length > 100, `只取到 ${script.length} 个字符`)
		// `new Function` compiles without running: a syntax check of the generated text.
		let syntaxError
		try {
			// eslint-disable-next-line no-new-func -- compiling IS the check
			new Function(script)
		} catch (error) {
			syntaxError = String(error?.message ?? error)
		}
		check('内联脚本语法有效（这是"按钮没反应"的那个坑）', syntaxError === undefined, syntaxError ?? '')
		// The handlers the buttons name must exist, or clicking does nothing again.
		for (const handler of ['signIn', 'saveSmb', 'bind', 'unbind', 'refresh']) {
			check(`处理函数存在：${handler}`, new RegExp(`function ${handler}\\s*\\(`).test(script), `脚本里找不到 ${handler}`)
		}
		// The elements the handlers read must exist too.
		for (const id of ['server', 'username', 'password', 'smbuser', 'smbpass', 'workspaces', 'status', 'msg', 'leftovers']) {
			check(`元素存在：#${id}`, page.includes(`id="${id}"`), `页面里找不到 id="${id}"`)
		}
	}
} finally {
	if (child) child.kill()
}

console.log(failures === 0
	? '\n执行器配置页自检通过：脚本能解析、处理函数与元素齐全。'
	: `\n有 ${failures} 项不通过 —— 页面按钮很可能点了没反应。`)
process.exit(failures)
