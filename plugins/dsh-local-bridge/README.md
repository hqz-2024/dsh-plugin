# dsh-local-bridge — 本机桥接

让 DSH（跑在服务器上）的 agent 通过每个用户本机安装的 **sidecar**，操作用户自己的
Windows 机器：打开/编辑本地 Office/PDF、运行 PowerShell、执行任意本地脚本
（Photoshop / Blender 等软件脚本自动化）。

## 架构

```
┌───────────────────────────── 用户电脑 ─────────────────────────────┐
│  sidecar.mjs（Node 常驻）                                          │
│    - 出站 WebSocket 连到服务器 /sidecar（带 token）                  │
│    - 收到 run 命令 → 本机 spawn 执行 → 回传 stdout/stderr/文件       │
└──────────────────────────┬────────────────────────────────────────┘
                           │ 出站（无防火墙/NAT 问题）
┌──────────────────────────▼────────────────────────────────────────┐
│  DSH 服务器（dsh-local-bridge 宿主插件）                            │
│    - /sidecar WebSocket 端点，token → 账号 认证                     │
│    - local_run 工具：按「会话归属账号」路由到对应 sidecar            │
│    - 文件 in/out 走 base64，工作区是文件交换面                       │
└───────────────────────────────────────────────────────────────────┘
```

## 目录

- `lib/index.js` — 服务器宿主插件（/sidecar 端点 + `local_run` 工具）
- `sidecar/sidecar.mjs` — 用户本机 sidecar
- `sidecar/README.md` — 用户安装与启动说明
- `AGENTS.md` — 给 agent 的能力说明与操作规范
- `cordis.patch.yml` — bundle 行（token 配置）

## 服务器部署

1. 安装 bundle：`dsh plugin --profile web add <本目录路径>`
2. 在 `profiles/web/cordis.patch.yml` 配置 `local-bridge` 行的 `tokens`
   （`token: 账号名`，每账号一个随机 token；token 泄露等于该账号本机权限）。
3. 重启 `dsh web`。

## 安全模型（MVP，单一可信局域网部署）

- **连接认证**：sidecar 用每账号 token 连入；无 token / 错误 token 一律拒绝。
- **会话隔离**：`local_run` 只路由到「当前会话归属账号」的 sidecar（账号归属取自
  `~/.dsh/auth/session-owners.json`；无归属的会话按 admin 处理）。
- **执行面在用户本机**：agent 只在用户自己注册的那台机器上执行，不碰服务器文件系统。
- **agent 行为约束**：工具描述 + AGENTS.md 要求 agent 在执行有副作用的命令前向用户
  确认；每次命令与结果都写日志。更严格的逐动作审批可作为后续增强（当前财务会话的
  approval 策略为 never，故未接入审批链）。
- **已知边界**：MVP 未做「可执行程序白名单」——任意命令以当前登录用户身份在本机执行，
  能力等价于该用户自己敲命令；请只在可信用户中启用，并妥善保管 token。

## 协议（JSON over WebSocket）

sidecar → 服务器（连接）：`ws://server:3080/sidecar?token=<token>`

服务器 → sidecar：

```json
{ "type": "run", "id": "run-…", "exe": "pwsh|exe", "args": ["…"],
  "workdir": "", "timeoutMs": 120000,
  "files": [{ "path": "in.xlsx", "base64": "…" }],
  "collect": ["out/**/*.xlsx", "*.txt"] }
```

sidecar → 服务器：

```json
{ "type": "run-result", "id": "run-…", "ok": true,
  "stdout": "…", "stderr": "…", "exitCode": 0,
  "files": [{ "path": "out/a.xlsx", "base64": "…" }],
  "error": null }
```

- `exe === "pwsh"` 特指 PowerShell：`args[0]` 作为整段脚本执行。
- `files` 写入临时 workdir 后才执行；`collect` 用相对 glob 回传输出文件。
- 上限：stdout/stderr 各 1MB；单个文件 50MB；默认超时 120s（可到 900s）。
