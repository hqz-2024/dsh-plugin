/**
 * 把岗位 preset 里那段"操作用户本机"的说明从 local_run 改成机器工具优先。
 *
 * 这一段在 7 个 preset 里逐字相同，所以用精确匹配替换，命中数不等于预期就报错退出 ——
 * 免得改到别的段落。编码保持 UTF-8（无 BOM），换行不变。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const presets = ['art-design', 'business-sales', 'finance-manager', 'hr-management', 'procurement', 'production', 'rd-development']
const root = join(homedir(), '.dsh', '.agent-presets')
const from = '6. 部署逻辑：你运行在服务器上，默认只能访问本账号工作区，无法直接操作用户本机的文件或软件。要操作用户本机（打开/编辑 Office、PDF，跑 PowerShell，运行 Photoshop/Blender 等本地脚本），必须用 local_run 工具，前提是用户本机已安装并启动 sidecar（本机助手）。若 local_run 返回「本地助手未连接」，引导用户到 设置 → 本地插件 下载并启动 sidecar，再重试。执行有副作用的命令前必须先向用户确认，并遵守 local-bridge/AGENTS.md 的规范。'
const to = '6. 部署逻辑：你运行在服务器上，默认只能访问本账号工作区，无法直接操作用户本机的文件或软件。要操作用户自己的电脑（打开/编辑 Office、PDF，跑 PowerShell，运行 Photoshop/Blender 等本地脚本），先用 machine_list 看哪些机器在线，再用 machine_run 在那台机器上执行命令 —— 那台机器只要有人双击启动过 dsh-executor 即可，不需要绑定、不需要共享。命令里的路径必须是那台机器上的路径；省略 cwd 时在该机器的用户主目录下执行。若 machine_list 报告没有机器在线，引导用户在那台电脑上打开执行器后重试。local_run（sidecar）只是备用逃生口，仅当用户本机装了 sidecar 时可用。执行有副作用的命令前必须先向用户确认，并遵守 local-bridge/AGENTS.md 的规范。'

let changed = 0
for (const preset of presets) {
	const file = join(root, preset, 'agent.cordis.yml')
	const text = readFileSync(file, 'utf8')
	const hits = text.split(from).length - 1
	if (hits !== 1) {
		console.error(`FAIL ${preset}: 命中 ${hits} 次，预期 1 次 — 未改动`)
		process.exitCode = 1
		continue
	}
	writeFileSync(file, text.replace(from, to), 'utf8')
	console.log(`ok   ${preset}`)
	changed += 1
}
console.log(`changed=${changed}/${presets.length}`)
