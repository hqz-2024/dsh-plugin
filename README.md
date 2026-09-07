# DeepSeek Harness 局域网部署说明

本目录（`~/.dsh/`）存放局域网部署所需的配置和脚本。核心架构：**dsh 只监听本机 127.0.0.1，caddy 作为 HTTPS 反代对外**，这样 agent 的远程代码执行能力仍被圈在本机，不直接暴露到网络。

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

---

## 一、前置要求

- **Node.js**：22.19+ 或 24+（本机为 `C:\nvm4w\nodejs\node.exe`）
- **pnpm**：通过 corepack 启用（`corepack enable`，项目锁定 `pnpm@11.7.0`）
- **dsh 源码**：`C:\Users\bestarc\Desktop\deepseek-harness`（已 `pnpm install`）

---

## 二、caddy 下载与安装

caddy 是成熟的泛用反向代理，用 winget 安装：

```powershell
winget install --id CaddyServer.Caddy -e --silent --accept-package-agreements --accept-source-agreements
```

> 安装后 caddy 的可执行文件在 winget 的带哈希路径下（升级后会变），所以已把它复制到固定路径 `C:\Users\bestarc\.dsh\bin\caddy.exe`，脚本统一用这个路径。若重装 caddy，重新执行一次复制即可：
>
> ```powershell
> mkdir -p $env:USERPROFILE\.dsh\bin
> copy "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_*\caddy.exe" "$env:USERPROFILE\.dsh\bin\caddy.exe"
> ```

---

## 三、caddy 配置（Caddyfile）

文件：`C:\Users\bestarc\.dsh\Caddyfile`

```
https://192.168.28.239:8443 {
	tls internal
	reverse_proxy 127.0.0.1:3080
}
```

- `tls internal`：用 caddy 本地 CA 签发自签证书（首次运行会把根证书装进本机 Windows 信任库）。
- `reverse_proxy 127.0.0.1:3080`：反代到 dsh，caddy 自动转发 WebSocket 升级，无需额外配置。
- 端口 8443 可改（改成 443 需要管理员权限）。

---

## 四、dsh 启动命令

dsh 必须**只监听本机 127.0.0.1**，但用 `--trusted-host` 放行从 caddy 转发来的请求：

```powershell
cd C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host 192.168.28.239
```

> 说明：dsh 的 CLI 故意禁止 `--host 0.0.0.0`（会暴露远程代码执行），所以局域网开放必须走 caddy 反代。`--trusted-host 192.168.28.239` 让 browser-trust 栅栏放行 Host 为 `192.168.28.239` 的请求。

---

## 五、一键启动脚本

文件：`C:\Users\bestarc\.dsh\start-dsh-lan.cmd`

双击运行，会同时拉起 caddy 和 dsh（各开一个最小化窗口）。脚本里的关键路径：

| 变量 | 值 |
|---|---|
| `NODE` | `C:\nvm4w\nodejs\node.exe` |
| `CADDY` | `C:\Users\bestarc\.dsh\bin\caddy.exe` |
| `CADDYFILE` | `C:\Users\bestarc\.dsh\Caddyfile` |
| `DSH_DIR` | `C:\Users\bestarc\Desktop\deepseek-harness` |
| `LAN_IP` | `192.168.28.239` |

若机器 IP 变了，改脚本里的 `LAN_IP` 和 `Caddyfile` 里的地址即可。

---

## 六、开机自启

把启动脚本放到 Windows 启动文件夹，登录后自动运行：

1. `Win + R` 打开运行框，输入 `shell:startup` 回车。
2. 把 `C:\Users\bestarc\.dsh\start-dsh-lan.cmd` 的**快捷方式**放进去（右键脚本 → 创建快捷方式，再把快捷方式移入启动文件夹）。

或者用任务计划程序（可设隐藏窗口、延迟启动）：

```powershell
schtasks /Create /TN "dsh-lan" /TR "C:\Users\bestarc\.dsh\start-dsh-lan.cmd" /SC ONLOGON /RL LIMITED /F
```

---

## 七、局域网设备访问与证书信任

- 访问地址：`https://192.168.28.239:8443`
- caddy 的自签根证书只装在本机。**其他设备首次访问会提示证书不受信**，需要在每台设备上手动信任根证书，证书位置：
  `C:\Users\bestarc\AppData\Roaming\Caddy\pki\authorities\local\root.crt`
- 若 Windows 防火墙拦了 8443，需加一条入站规则放行。

---

## 八、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | Windows 防火墙未放行 8443；或 IP 变了 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 root.crt |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| dsh 启动报 schema 错误 | 某个插件 tool 的 JSON Schema 不合法（`required` 在 items 里、object 缺 `additionalProperties` 等），按 dsh 的 value-schema DSL 规则修 |

---

## 九、功能清单与改动记录（CHANGELOG）

> 本部署在官方 DSH 之上叠加了多账号 + 角色权限 + 会话隔离 + 办公文档 + 文件树 + 本机桥接。全部定制集中在本地 fork 与 `~/.dsh/` 数据目录；核心 checkout 保持只读（git pull 已评估为冲突风险，未执行）。

### 9.1 已实现功能

| 功能 | 实现 | 位置 |
|---|---|---|
| 账号密码登录 + MFA | fork `dsh-remote` | `~/.dsh/plugins/dsh-remote-local` |
| 角色 → 预设/工作空间 | 静态 roleMap + 动态 `auth/role-map.json`（多工作区） | 同上 + `profiles/web/cordis.patch.yml` |
| 会话按账号隔离 | sessionOwnership + `auth/session-owners.json` | 同上 + session-controller 本地改 |
| 隐藏工作区/会话（admin） | `/auth/hide` + `auth/hidden-items.json` | 同上 |
| 账号管理界面 | 账号卡片可编辑 + 工作区多选下拉 + 预设选择 | 同上（client.js） |
| 办公文档解析 | dsh-doc（PDF/DOCX/XLSX/PPTX/MD/CSV + OCR） | `profiles/web/cordis.patch.yml` |
| 页内文件树（分列窗格） | fork `folder-tree-sh`（预览/编辑/上传/下载/拖拽/文件夹上传/xlsx 网格） | `~/.dsh/plugins/folder-tree-sh-local` |
| Token 用量统计 | fork `dsh-usage-panel`（全站聚合，admin 专属） | `~/.dsh/plugins/dsh-usage-panel-local` |
| 本机软件调用 | dsh-local-bridge sidecar + `local_run` 工具 | `~/.dsh/plugins/dsh-local-bridge` |
| 角色预设（8 + 默认） | 财务 2 + 扩展 6 + standard-terminal | `~/.dsh/.agent-presets/<id>/` |

### 9.2 权限模型

| 账号 | 预设 | 工作空间 | 沙箱 |
|---|---|---|---|
| `admin` | standard-terminal（全量） | 全部 | danger-full-access |
| `Finance-mgr` | finance-manager | finance-ws | finance-confined（workspace-write + never） |
| `Finance-staff` | finance-staff | finance-ws | finance-confined |
| 其他角色 | art-design / business-sales / procurement / production / hr-management / rd-development | 各自工作区（可多选） | finance-confined |

- finance-confined：写边界 = 账号工作区文件夹，禁止任何权限升级；角色预设无 shell/web/subagent/workflow 工具（"Finance-mgr 让 AI 重启服务器"已封死）。
- 文件树权限矩阵：admin=全量、user=映射工作区、guest=403"需要升级权限才能使用该功能"。

### 9.3 改动记录（CHANGELOG）

- **认证/角色**：fork `dsh-remote-local`；静态 roleMap + 动态 roleMap（多工作区 + 预设）、会话归属隔离、隐藏工作区/会话、账号管理界面、`/auth/config-options`。
- **会话可见性**：session-controller 本地 `scopeUser`/`sessionOwnership` 过滤（上游已重写该包，本部署暂不 pull，避免冲突）。
- **文件树**：窗格不显示修复（inject=["slots"]）、分列布局、上传/下载/拖拽复制、shell 依赖移除、xlsx 网格 + office_xlsx_write/office_docx_write、新建文件夹崩溃修复、Origin 按 hostname 放行、请求体 for-await、上传 mkdir recursive、文件夹上传。
- **使用统计**：scan 模式 + 原始 sessionPersistence 读取（修复大日志卡死），非 admin 403。
- **角色预设**：8 个角色预设 + standard-terminal 落地。
- **本机桥接**：sidecar + local_run，per-account token。
- **文档**：`MIGRATION.md` 迁移指南 + 本 README + `plan.md`。

### 9.4 运维提示

- host 改动（插件 `lib/index.js`、cordis.patch.yml）需整进程重启；客户端 `lib/client.js` 经 HMR 自动重发，浏览器 Ctrl+F5 生效。
- 启动：`pnpm dsh --profile web --trusted-host 192.168.28.239`（于 checkout 根目录）。
- 状态文件：`~/.dsh/auth/{store,session-owners,hidden-items,role-map}.json`、`~/.dsh/upgrade-state.json`、`~/.dsh/plugins/dsh-remote-local/run-diag.log`。
- 完整迁移/备份：见 `~/.dsh/MIGRATION.md`。
