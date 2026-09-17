/**
 * node-pty 的 console-list 助手在打包成 exe 之后还能不能正常回答？
 *
 * `WindowsPtyAgent._getConsoleProcessList` 用 `child_process.fork()` 起这个助手，而 fork
 * 跑的是 `process.execPath`。打包之后的 execPath 就是执行器自己 —— 所以这个测试用
 * `fork(agentPath, [pid], { execPath: <exe> })` 精确复现那个调用，然后断言父进程收到了
 * `{ consoleProcessList }` 消息。
 *
 * 这同时是一条"没有第二个执行器"的证据：修复前，被 fork 出来的 exe 会当成执行器启动，
 * 连上服务器并顶掉原来那条连接；修复后它应当跑完助手就退出。
 *
 * 用法：node check-conpty-agent-fork.mjs <exe路径> <node-pty目录>
 */
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const exe = process.argv[2]
const nodePtyDir = process.argv[3]
// 和 node-pty 完全一致：不带 .js 后缀（windowsPtyAgent.js 里就是这么写的）。
const agent = process.argv[4] === '--with-extension'
	? join(nodePtyDir, 'lib', 'conpty_console_list_agent.js')
	: join(nodePtyDir, 'lib', 'conpty_console_list_agent')

if (!exe || !existsSync(exe)) {
	console.error(`缺少可用的 exe：${exe}`)
	process.exit(2)
}
if (!existsSync(`${agent}.js`) && !existsSync(agent)) {
	console.error(`缺少 console-list 助手：${agent}`)
	process.exit(2)
}

/** 一个自己起的假"终端进程"，助手对它调用 getConsoleProcessList。 */
const child = fork(agent, ['0'], { execPath: exe, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
let stdout = ''
let stderr = ''
child.stdout?.on('data', (chunk) => { stdout += chunk })
child.stderr?.on('data', (chunk) => { stderr += chunk })

const result = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ outcome: 'TIMEOUT' }), 10000)
	child.on('message', (message) => {
		clearTimeout(timer)
		resolve({ outcome: 'message', message })
	})
	child.on('exit', (code) => {
		clearTimeout(timer)
		resolve({ outcome: 'exited-without-message', code })
	})
})

const isBanner = /joining|configuration page|connected to/.test(stdout)
console.log(JSON.stringify({
	exe,
	agent,
	outcome: result.outcome,
	gotConsoleProcessList: Array.isArray(result.message?.consoleProcessList),
	consoleProcessList: result.message?.consoleProcessList ?? null,
	// 修复前这里会出现执行器的启动输出（"joining …"/"configuration page"）。
	startedAnExecutorInstead: isBanner,
	stdout: stdout.slice(0, 300),
	stderr: stderr.slice(0, 300),
}, null, 2))

process.exit(result.outcome === 'message' && Array.isArray(result.message.consoleProcessList) && !isBanner ? 0 : 1)
