# DeepSeek Harness 局域网部署说明

本目录（`~/.dsh`，即 `%USERPROFILE%\.dsh`）存放局域网部署所需的配置和脚本。核心架构：**dsh 只监听本机 127.0.0.1，caddy 作为 HTTPS 反代对外**，这样 agent 的远程代码执行能力仍被圈在本机，不直接暴露到网络。

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

> **占位符说明**：本文所有路径都不含真实用户名/IP。
> - `<用户名>` = 你的 Windows 用户名（等价于 `%USERNAME%`）
> - `%USERPROFILE%` = 你的用户主目录（如 `C:\Users\<用户名>`）
> - `<局域网IP>` = 服务器的局域网 IP（如 `192.168.x.x`）

---

## 一、前置要求

- **Node.js**：22.19+ 或 24+（nvm 或官方安装均可）
- **pnpm**：通过 corepack 启用（`corepack enable`，项目锁定 `pnpm@11.7.0`）
- **git**：拉取引擎仓库用

---

## 二、快速部署（推荐：install.ps1）

克隆本仓库后，在仓库根目录运行一条命令即可铺好整套部署：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -LanIP <局域网IP>
```

脚本按顺序完成：前置检查 → 拉取引擎（deepseek-harness）→ 安装 profile 依赖 → 安装 4 个插件各自依赖 → 校验 8 个角色预设 → 渲染 `cordis.patch.yml`（生成 sidecar token）→ 生成 `.credentials.yaml` → **下载 dsh-doc OCR 运行时**（~178MB，含 SHA-256 校验）→ 生成启动脚本 → 自检 `verify.ps1`。幂等可重跑。

| 参数 | 默认 | 说明 |
|---|---|---|
| `-EngineDir` | `%USERPROFILE%\Desktop\deepseek-harness` | 引擎 checkout 路径 |
| `-EngineRepo` | `https://github.com/hqz-2024/hqz-dsh.git` | 引擎仓库（分支 `hqz-dsh`，会话隔离在插件层，引擎本身零改动） |
| `-EngineBranch` | `hqz-dsh` | 引擎分支 |
| `-LanIP` | `<局域网IP>`（必填） | 服务器局域网 IP |
| `-NodePath` | 自动取 PATH 里的 node | node.exe 绝对路径 |
| `-SkipEngine` | - | 引擎已就绪时跳过拉取 |

装完可随时跑 `verify.ps1` 自检（逐项断言 8 预设 / 4 插件 / 配置 / 密钥 / 引擎 / 运行时）。

---

## 三、caddy 下载与安装

caddy 是泛用反向代理，用 winget 安装：

```powershell
winget install --id CaddyServer.Caddy -e --silent --accept-package-agreements --accept-source-agreements
```

> 安装后 caddy 可执行文件在 winget 的带哈希路径下（升级后会变），把它复制到固定路径 `%USERPROFILE%\.dsh\bin\caddy.exe`，脚本统一用这个路径：
>
> ```powershell
> mkdir -p $env:USERPROFILE\.dsh\bin
> copy "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_*\caddy.exe" "$env:USERPROFILE\.dsh\bin\caddy.exe"
> ```

---

## 四、caddy 配置（Caddyfile）

文件：`%USERPROFILE%\.dsh\Caddyfile`

```
https://<局域网IP>:8443 {
	tls internal
	reverse_proxy 127.0.0.1:3080
}
```

- `tls internal`：用 caddy 本地 CA 签发自签证书（首次运行会把根证书装进本机 Windows 信任库）。
- `reverse_proxy 127.0.0.1:3080`：反代到 dsh，caddy 自动转发 WebSocket 升级，无需额外配置。
- 端口 8443 可改（改成 443 需要管理员权限）。

---

## 五、dsh 启动命令

dsh 必须**只监听本机 127.0.0.1**，但用 `--trusted-host` 放行从 caddy 转发来的请求：

```powershell
cd %USERPROFILE%\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host <局域网IP>
```

> dsh 的 CLI 故意禁止 `--host 0.0.0.0`（会暴露远程代码执行），所以局域网开放必须走 caddy 反代。`--trusted-host <局域网IP>` 让 browser-trust 栅栏放行 Host 为 `<局域网IP>` 的请求。

---

## 六、一键启动脚本

文件：`%USERPROFILE%\.dsh\start-dsh-lan.cmd`（由 `install.ps1` 自动生成）

双击运行，会同时拉起 caddy 和 dsh（各开一个最小化窗口）。脚本里只有三处需按机改：`NODE`（node.exe 路径）、`DSH_DIR`（引擎 checkout 路径）、`LAN_IP`（局域网 IP）；其余路径自动用 `%USERPROFILE%` 定位 `~\.dsh`。

---

## 七、开机自启

把启动脚本放到 Windows 启动文件夹，登录后自动运行：

1. `Win + R` 打开运行框，输入 `shell:startup` 回车。
2. 把 `%USERPROFILE%\.dsh\start-dsh-lan.cmd` 的**快捷方式**放进去（右键脚本 → 创建快捷方式，再把快捷方式移入启动文件夹）。

或用任务计划程序：

```powershell
schtasks /Create /TN "dsh-lan" /TR "%USERPROFILE%\.dsh\start-dsh-lan.cmd" /SC ONLOGON /RL LIMITED /F
```

---

## 八、局域网设备访问与证书信任

- 访问地址：`https://<局域网IP>:8443`
- caddy 的自签根证书只装在本机。**其他设备首次访问会提示证书不受信**，需在每台设备手动信任根证书，位置：`%APPDATA%\Caddy\pki\authorities\local\root.crt`
- 若 Windows 防火墙拦了 8443，需放行入站：
  ```powershell
  New-NetFirewallRule -DisplayName "dsh-lan-8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
  ```

---

## 九、备份与迁移（backup.ps1 / migrate.ps1）

**备份（旧机）**：`backup.ps1` 把 `~\.dsh` 的「状态 + 机密」打包成 zip（会话 / 附件 / 账号 / 工作区注册表 / API key / sidecar token），排除 node_modules、运行时、caddy、日志。

```powershell
powershell -ExecutionPolicy Bypass -File .\backup.ps1            # 默认含机密
powershell -ExecutionPolicy Bypass -File .\backup.ps1 -SkipSecrets
```

**恢复（新机）**：先跑 `install.ps1` 铺好代码，再跑 `migrate.ps1` 恢复数据并自动把旧用户名路径映射成新机的：

```powershell
powershell -ExecutionPolicy Bypass -File .\migrate.ps1 -Backup <备份zip> -OldUser <旧用户名> -NewUser <新用户名>
```

> 跨用户名迁移时，会话日志是 zstd 压缩二进制，脚本只重映射文本配置 + 重命名会话目录；建议优先「同名用户」迁移。完整清单见 `MIGRATION.md`。

---

## 十、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | Windows 防火墙未放行 8443；或 IP 变了 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 `root.crt` |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| dsh 启动报 schema 错误 | 某个插件 tool 的 JSON Schema 不合法（`required` 在 items 里、object 缺 `additionalProperties` 等），按 dsh 的 value-schema DSL 规则修 |
| 登录后看不到历史会话 | `auth\session-owners.json` / `storages\workspace.json` 没恢复，或会话目录与工作区路径不一致 |
| 文档预览失败 | dsh-doc 运行时缺失，或 `cordis.patch.yml` 的 `runtimeDir` 路径不对 |

---

## 十一、功能清单与改动记录（CHANGELOG）

本部署在官方 DSH 之上叠加了多账号 + 角色权限 + 会话隔离 + 办公文档 + 文件树 + 本机桥接。**全部定制集中在本地插件与 `~\.dsh` 数据目录，核心 checkout 零改动**（可干净 pull 官方上游）。

### 11.1 已实现功能

| 功能 | 实现 | 位置 |
|---|---|---|
| 账号密码登录 + MFA | fork `dsh-remote` | `~\.dsh\plugins\dsh-remote-local` |
| 角色 → 预设/工作空间 | 静态 roleMap + 动态 `auth\role-map.json`（多工作区） | 同上 + `profiles\web\cordis.patch.yml` |
| 会话按账号隔离 | 服务层包装 `sessionController.list` + `auth\session-owners.json` | 同上 |
| 隐藏工作区/会话（admin） | `/auth/hide` + `auth\hidden-items.json` | 同上 |
| 账号管理界面 | 账号卡片可编辑 + 工作区多选下拉 + 预设选择 | 同上（client.js） |
| 办公文档解析 | dsh-doc（PDF/DOCX/XLSX/PPTX/MD/CSV + OCR） | `profiles\web\cordis.patch.yml` |
| 页内文件树（分列窗格） | fork `folder-tree-sh`（预览/编辑/上传/下载/拖拽/文件夹上传/xlsx 网格） | `~\.dsh\plugins\folder-tree-sh-local` |
| Token 用量统计 | fork `dsh-usage-panel`（全站聚合，admin 专属） | `~\.dsh\plugins\dsh-usage-panel-local` |
| 本机软件调用 | dsh-local-bridge sidecar + `local_run` 工具 | `~\.dsh\plugins\dsh-local-bridge` |
| 角色预设（8 + 默认） | 财务 2 + 扩展 6 + standard-terminal | `~\.dsh\.agent-presets\<id>\` |
| 本地插件（设置页） | sidecar 下载 + 本账号 token + 连接状态 + 启动命令 | 设置 → 本地插件 |
| sidecar 全局 skill | 各预设 agent 共用（路由规则 + 使用规范） | `~\.dsh\skills\sidecar\SKILL.md` |

### 11.2 权限模型

| 账号 | 预设 | 工作空间 | 沙箱 |
|---|---|---|---|
| `admin` | standard-terminal（全量） | 全部 | danger-full-access |
| `Finance-mgr` | finance-manager | finance-ws | finance-confined（workspace-write + never） |
| `Finance-staff` | finance-staff | finance-ws | finance-confined |
| 其他角色 | art-design / business-sales / procurement / production / hr-management / rd-development | 各自工作区（可多选） | finance-confined |

- finance-confined：写边界 = 账号工作区文件夹，禁止任何权限升级；角色预设无 shell/web/subagent/workflow 工具（"让 AI 重启服务器"已封死）。
- 文件树权限矩阵：admin=全量、user=映射工作区、guest=403"需要升级权限才能使用该功能"。
- sidecar 路由机制：`local_run` 永远在「当前会话归属账号」的本机上执行——服务器按 `会话 → 归属账号 → 独立 token → sidecar` 自动路由，绝不串到别的账号的机器。

### 11.3 改动记录（CHANGELOG）

- **认证/角色**：fork `dsh-remote-local`；静态 roleMap + 动态 roleMap（多工作区 + 预设）、会话归属隔离、隐藏工作区/会话、账号管理界面、`/auth/config-options`。
- **会话可见性**：会话列表过滤在 `dsh-remote-local` 内**服务层包装 `sessionController.list`**（无核心改动、无 HTTP/gzip 副作用）。
- **文件树**：窗格不显示修复（inject=["slots"]）、分列布局、上传/下载/拖拽复制、shell 依赖移除、xlsx 网格 + office_xlsx_write/office_docx_write、新建文件夹崩溃修复、Origin 按 hostname 放行、请求体 for-await、上传 mkdir recursive、文件夹上传。
- **使用统计**：scan 模式 + 原始 sessionPersistence 读取（修复大日志卡死），非 admin 403。
- **角色预设**：8 个角色预设 + standard-terminal 落地。
- **本机桥接**：sidecar + local_run，per-account token；设置页「本地插件」（下载 + token + 连接状态 + 一键启动脚本）；`local_run` 按会话归属自动路由（不串设备）；全局 sidecar skill + 8 预设部署逻辑说明。
- **部署工具**：`install.ps1`（含 dsh-doc 运行时下载）、`verify.ps1`、`backup.ps1`、`migrate.ps1`；插件 `link:` 相对路径。

### 11.4 运维提示

- host 改动（插件 `lib\index.js`、cordis.patch.yml）需整进程重启；客户端 `lib\client.js` 经 HMR 自动重发，浏览器 Ctrl+F5 生效。
- 启动：`pnpm dsh --profile web --trusted-host <局域网IP>`（于引擎 checkout 根目录）。
- 状态文件：`~\.dsh\auth\{store,session-owners,hidden-items,role-map}.json`、`~\.dsh\upgrade-state.json`、`~\.dsh\plugins\dsh-remote-local\run-diag.log`。
- 完整迁移/备份：见 `MIGRATION.md`。
