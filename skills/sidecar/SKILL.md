---
name: sidecar
description: 用 local_run 工具操作用户本机的 Windows（PowerShell / Office / PDF / Photoshop / Blender 脚本），前提是用户本机已安装并启动 sidecar。
---

# sidecar 本机助手使用规范

## 什么情况下用

用户要求「打开/编辑我电脑上的文件」「跑我本机的脚本」「用 Photoshop/Blender 处理」「执行本地 PowerShell」时——这些都发生在**用户自己的 Windows 电脑**上，而你运行在服务器上，默认够不到本机。此时用 `local_run` 工具，通过用户本机安装的 sidecar 执行。

## 前提：sidecar 已连接

- 若 `local_run` 返回「本地助手未连接」或类似错误，说明该账号的本机还没启动 sidecar。
- 引导用户：**设置 → 本地插件** → 下载 `sidecar.mjs` → 复制启动命令（已含该账号 token）→ 在本机运行。
- 启动后再次调用 `local_run` 即可。

## 路由规则（重要：不会串设备）

- `local_run` **永远在「当前会话归属账号」的本机上执行**——由服务器按会话归属自动路由，你不能指定、也不需要知道是哪台设备。
- 每个账号有自己独立的 token，sidecar 用它连上来；服务器只把命令发给「本会话账号」连的那台 sidecar，**绝不会串到别的账号的机器**。
- 因此不要在回复里臆测自己在操作哪台设备。需要确认时，先跑一条 `pwsh` 读 `$env:COMPUTERNAME` / `$env:USERNAME`，把结果告诉用户。

## 参数要点

| 参数 | 说明 |
|---|---|
| `command` | `"pwsh"` 表示 PowerShell（整段脚本放 `args[0]`）；也可填可执行文件路径（如 `python`、`C:\...\Photoshop.exe`） |
| `args` | 命令参数；`pwsh` 时 `args[0]` = 整段脚本 |
| `inputFiles` | 下发到本机临时 workdir 的文件（base64，`path` 相对 workdir），如把工作区的 xlsx 发给本机 Office 处理 |
| `collect` | 相对 glob 回传产物，如 `["out/*.xlsx", "*.txt"]` |
| `workdir` | 本机工作目录，留空用临时目录 |
| `timeoutMs` | 默认 120000，最大 900000 |

## 安全铁律

1. 有副作用的命令（删除文件、改系统、装软件、跑未知脚本）**先向用户确认再执行**。
2. 优先用 PowerShell / 脚本 API，不要用破坏性命令。
3. 单文件 ≤50MB；stdout/stderr 各 ≤1MB；超时会自动终止。
4. sidecar 的能力等于用户本机自己的权限，只在用户明确要求时使用。
