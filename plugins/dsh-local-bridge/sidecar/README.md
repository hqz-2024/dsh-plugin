# sidecar 安装与启动（用户本机，Windows）

这个小组件让你的 DSH agent 能在**你这台电脑**上执行命令、打开/编辑本机文件。
它只做一件事：连到 DSH 服务器，接收并执行 agent 发来的指令。

## 前置

- 安装 Node.js 22+（https://nodejs.org，LTS 即可）
- 从管理员处拿到 **服务器地址** 和 **你的专属 token**（每账号一个，务必保密）

## 安装

1. 把本目录（`sidecar/`）复制到本机任意位置，例如 `C:\dsh-sidecar\`
2. 确认 `sidecar.mjs` 在目录里

## 启动

```powershell
node C:\dsh-sidecar\sidecar.mjs --server ws://<服务器地址>:3080/sidecar --token <你的token>
```

看到 `[sidecar] connected` 即成功。

## 开机自启（可选）

Windows「任务计划程序」→ 创建任务：
- 触发器：登录时
- 操作：程序 `node`，参数 `C:\dsh-sidecar\sidecar.mjs --server ws://… --token …`
- 勾选「不管用户是否登录都要运行」+「使用最高权限」（仅当你希望后台静默运行）

## 安全须知

- sidecar 以**你当前登录的用户身份**执行命令，能做任何你手动能做/不能做的事。
- 任何拿到 token 的人都能让 agent 在你的机器上执行命令——**不要**外传 token、
  不要截图、不要写进聊天/邮件。
- 不用时直接关掉 node 进程即断开。

## 常见问题

- **连不上**：确认服务器地址可达、`/sidecar` 端口（默认 3080）未被防火墙拦截
  （sidecar 是出站连接，一般无需放行入站）。
- **agent 提示"本地助手未连接"**：说明你的 sidecar 没在运行或 token 不对。
- **重连**：断线后每 3 秒自动重连。
