# DSH 局域网部署迁移说明

本文件描述如何把整套 DeepSeek Harness 局域网部署（多账号登录 + 角色权限 + 文件树 + 文档解析 + 本机桥接）手动迁移到另一台 Windows 服务器，并**完整保留所有数据**（会话历史、账号、工作区文件、配置、插件改动）。

适用基线（本文所有路径以此为准）：

| 项 | 值 |
|---|---|
| 用户名 | `bestarc` |
| DSH 代码 checkout | `C:\Users\bestarc\Desktop\deepseek-harness` |
| DSH 数据/配置主目录 | `C:\Users\bestarc\.dsh` |
| 财务工作区 | `C:\Users\bestarc\Desktop\finance-ws` |
| 反代端口 | `https://<LAN-IP>:8443` → 本机 `127.0.0.1:3080` |
| 反代 | caddy（`tls internal` 自签证书） |

---

## 一、架构总览

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

- dsh 只监听本机 loopback，caddy 是唯一对外入口。
- 多账号认证、角色门禁、会话隔离、工作区限制全部由本地 fork 插件实现（见清单）。
- `dsh-local-bridge` 的 sidecar 跑在**每台用户自己的电脑**上，出站连接服务器的 `/sidecar`。

---

## 二、迁移清单

### 1. 数据（丢失不可恢复，最高优先级）

| 源路径（旧机） | 内容 | 是否必须 |
|---|---|---|
| `.dsh\sessions\` | 所有会话历史（按工作区路径分目录） | 必须 |
| `.dsh\sessions-archived\` | 归档会话 | 必须 |
| `.dsh\attachments\` | 会话附件 | 必须 |
| `.dsh\auth\store.json` | 账号（密码哈希 + TOTP + cookie 签名密钥） | 必须 |
| `.dsh\auth\session-owners.json` | 会话归属账号映射（账号隔离依据） | 必须 |
| `.dsh\storages\workspace.json` | 工作区注册表（路径 + 会话列表） | 必须 |
| `.dsh\storages\session_projcache.json` + `session_projcache\` | 会话投影缓存（可重建） | 建议 |
| `.dsh\llm-deepseek\` | DeepSeek provider 状态 | 建议 |
| `.dsh\dsh-remote-files.json` | /auth/file 额外允许目录（当前为空） | 建议 |
| `.dsh\.anonymous-user-id` | 匿名 ID | 建议 |
| `C:\Users\bestarc\Desktop\finance-ws\` | 财务工作区实际文件（业务数据） | 必须 |

### 2. 配置 + 插件 + 运行时

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `.dsh\profiles\web\`（不含 node_modules） | profile 组合：`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 必须 |
| `.dsh\plugins\` | 4 个本地 fork：`dsh-remote-local`、`folder-tree-sh-local`、`dsh-local-bridge`、`dsh-usage-panel-local` | 必须 |
| `.dsh\.agent-presets\` | `finance-manager`、`finance-staff`、`standard-terminal`（含 skills） | 必须 |
| `.dsh\runtimes\dshdoc-runtime-win32-x64\` | dsh-doc 离线 Python 运行时（openpyxl/python-docx） | 必须 |
| `.dsh\settings.yaml` | 默认权限 danger-full-access、模型等 | 必须 |
| `.dsh\.credentials.yaml` | API Key（**机密**） | 必须 |
| `.dsh\Caddyfile` | 反代配置 | 必须 |
| `.dsh\bin\caddy.exe` | caddy 可执行文件（或用 winget 重装后复制） | 必须 |
| `.dsh\start-dsh-lan.cmd` | 一键启动脚本 | 必须 |
| `.dsh\upgrade-state.json` | 升级状态 | 建议 |

### 3. 程序本体

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `C:\Users\bestarc\Desktop\deepseek-harness\`（不含 node_modules） | DSH 源码 checkout（含本地改动，见「坑 1」） | 必须 |

---

## 三、迁移步骤（推荐：新机同名用户 `bestarc`、同目录结构）

保持同名同路径可以让所有写死的绝对路径原样生效，是最省事的路线。

### 第 0 步：两边停服务
旧机关掉 `start-dsh-lan.cmd` 拉起的 caddy 和 dsh 窗口，确认进程退出后再拷贝。

### 第 1 步：新机装运行时
- Node.js **22.19+ 或 24+**（旧机为 nvm4w，路径 `C:\nvm4w\nodejs\node.exe`）。
- pnpm：`corepack enable`（项目锁定 `pnpm@11.7.0`）。
- caddy：直接复制 `bin\caddy.exe`，或 `winget install --id CaddyServer.Caddy -e` 后复制到固定路径 `~\.dsh\bin\caddy.exe`。

### 第 2 步：拷代码 checkout（排除 node_modules）
```powershell
robocopy C:\Users\bestarc\Desktop\deepseek-harness D:\deepseek-harness /E /XD node_modules /R:1 /W:1 /NFL /NDL
```
> 若新机不放 `C:\Users\bestarc\Desktop\deepseek-harness`，见「坑 2」的路径替换清单。

### 第 3 步：拷 `.dsh`（排除 profiles\web\node_modules）
```powershell
robocopy C:\Users\bestarc\.dsh C:\Users\bestarc\.dsh /E /XD profiles\web\node_modules /R:1 /W:1 /NFL /NDL
```
> 必须带上所有点开头/隐藏文件（`.credentials.yaml`、`.agent-presets`、`.anonymous-user-id`、`.dsh-module-fallback` 等）。robocopy 用 `/E` 会带上隐藏与系统文件；拷完抽查确认 `.credentials.yaml`、`.agent-presets\`、`.git`（在 checkout 里）都到位。

### 第 4 步：拷财务工作区
```powershell
robocopy C:\Users\bestarc\Desktop\finance-ws C:\Users\bestarc\Desktop\finance-ws /E /R:1 /W:1
```

### 第 5 步：重新装依赖（node_modules 不拷，重装更稳）
```powershell
cd D:\deepseek-harness        # 第 2 步的实际路径
pnpm install

cd C:\Users\bestarc\.dsh\profiles\web
pnpm install                  # 重建 node_modules，并按 package.json 的 link: 重连 4 个插件 fork
```
> 只要 `~\.dsh\plugins\*`、`profiles\web\package.json`、`profiles\web\pnpm-lock.yaml` 都拷到位，`pnpm install` 会自动把 4 个 `link:` 依赖连回插件 fork。

### 第 6 步：改 IP（新机 LAN IP 变了，改 3 处）
- `Caddyfile`：`https://192.168.28.239:8443` → 新 IP。
- `start-dsh-lan.cmd`：`set "LAN_IP=..."` → 新 IP（脚本已用 `%LAN_IP%` 拼 `--trusted-host`）。
- 若手工启动，`--trusted-host <新IP>` 同步改。

### 第 7 步：防火墙 + 证书
- 放行 8443 入站：
  ```powershell
  New-NetFirewallRule -DisplayName "dsh-lan-8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
  ```
- caddy 首次运行自签根证书并装入本机信任库；其他局域网设备需手动信任：
  `C:\Users\bestarc\AppData\Roaming\Caddy\pki\authorities\local\root.crt`

### 第 8 步：启动 + 验证
双击 `start-dsh-lan.cmd`（或按「常见问题」手工启动），按「验证清单」逐项核对。

### 第 9 步：更新每台用户机的 sidecar
`dsh-local-bridge` 的 sidecar 跑在**每台用户电脑**上（不是服务器）。迁移后把它们的服务器地址改成新机 IP，否则 `local_run` 工具会连不上。

---

## 四、坑（必读）

### 坑 1：checkout 有本地改动，不能 `git clone` 干净版替代
`packages/api/session-controller`（src 和 lib 均已改）加入了 `scopeUser` + `sessionOwnership` 过滤——这是「每个账号只看到自己会话」的关键。

**必须整目录拷贝原 checkout。** 若重新 clone，要手动把这处改动重新打上，否则账号隔离失效。

### 坑 2：绝对路径被写死在很多地方
用户名 `bestarc` 和 `C:\Users\bestarc\...` 出现在：

| 位置 | 字段 |
|---|---|
| `storages\workspace.json` | 各工作区的 `path` |
| `sessions\` 目录名 | `--C-Users-bestarc-Desktop-finance-ws--` 等（按工作区路径变形） |
| `profiles\web\cordis.patch.yml` | dsh-doc 的 `runtimeDir` |
| `profiles\web\package.json` | `link:C://Users//bestarc//...` |
| `start-dsh-lan.cmd` | `NODE`、`CADDY`、`DSH_DIR` |

**换用户名/换盘符时**，需要：全局替换上述路径 + 重命名 `sessions\` 里的对应目录 + 改 `runtimeDir` + 重新 `pnpm install` 重连 link。想省事就**保持 `bestarc` + 原目录结构**。

### 坑 3：机密文件要原样、安全地拷
- `.credentials.yaml`（API Key）
- `auth\store.json`（密码哈希 + 签名密钥；session cookie 的密钥也在这里）
- `profiles\web\cordis.patch.yml` 里的 local-bridge sidecar token

丢了或改了会导致账号无法登录 / 本机桥接失效。请走可信通道拷贝，不要提交进 git。

---

## 五、验证清单

1. 三个账号都能登录：`admin` / `Finance-mgr` / `Finance-staff`。
2. Finance-mgr、Finance-staff **只看到自己的会话**，看不到别人的。
3. 文件树全操作正常：新建文件、新建文件夹、重命名、复制、粘贴（剪切）、删除、上传、编辑保存、Excel 保存。
4. 上传 docx / xlsx 能正常预览（验证 dsh-doc 运行时）。
5. admin 能打开用量面板（admin-only）。
6. 每台用户机 sidecar 能连上，`local_run` 能驱动用户本机。

---

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | 防火墙未放行 8443；或 IP 变了没改 `Caddyfile`/脚本 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 `root.crt` |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| 登录后看不到自己的历史会话 | `auth\session-owners.json` 或 `storages\workspace.json` 没拷全；或会话目录与 workspace.json 路径不一致（坑 2） |
| 文件树写操作 `forbidden` / `signal time out` | 插件 fork 没拷全，或 `profiles\web` 的 `pnpm install` 没重建 link 依赖 |
| 文档预览失败 | `runtimes\dshdoc-runtime-win32-x64` 没拷，或 `cordis.patch.yml` 的 `runtimeDir` 路径不对 |

### 手工启动命令（不用脚本时）
```powershell
# 终端 1：caddy
C:\Users\bestarc\.dsh\bin\caddy.exe run --config C:\Users\bestarc\.dsh\Caddyfile

# 终端 2：dsh（在 checkout 目录）
cd C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host <新IP>
```
