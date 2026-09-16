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

> **Linux / macOS**：用 `install.sh`（bash）替代：
>
> ```bash
> bash install.sh --lan-ip <局域网IP>
> ```
>
> 差异：dsh-doc 用 `engine: node`（无 win32 OCR 运行时）、启动脚本为 `start-dsh-lan.sh`、备份/恢复用 `backup.sh` / `migrate.sh`。

脚本按顺序完成：前置检查 → 拉取引擎（deepseek-harness）→ 安装 profile 依赖 → 安装 5 个插件各自依赖 → **校验角色预设（7 个自定义 + agency 角色库）与全局 skill（10 个）** → 渲染 `cordis.patch.yml`（生成 sidecar token）→ 生成 `.credentials.yaml` → **下载 dsh-doc OCR 运行时**（~178MB，含 SHA-256 校验）→ **下载 FFmpeg 二进制**（~185MB，含 SHA-256 校验）→ 生成启动脚本 → 自检 `verify.ps1`。幂等可重跑。

| 参数 | 默认 | 说明 |
|---|---|---|
| `-EngineDir` | `%USERPROFILE%\Desktop\deepseek-harness` | 引擎 checkout 路径 |
| `-EngineRepo` | `https://github.com/hqz-2024/hqz-dsh.git` | 引擎仓库（分支 `hqz-dsh`，会话隔离在插件层，引擎本身零改动） |
| `-EngineBranch` | `hqz-dsh` | 引擎分支 |
| `-LanIP` | `<局域网IP>`（必填） | 服务器局域网 IP |
| `-NodePath` | 自动取 PATH 里的 node | node.exe 绝对路径 |
| `-SkipEngine` | - | 引擎已就绪时跳过拉取 |

装完可随时跑 `verify.ps1` 自检（逐项断言 7 个自定义角色预设 + 预设总数 / 10 个全局 skill / 5 插件 / 配置 / 密钥 / 引擎 / 运行时）。

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
| 本机软件调用 | dsh-local-bridge sidecar + `local_run` 工具（**已降级为逃生口**，见 11.6） | `~\.dsh\plugins\dsh-local-bridge` |
| **客户端执行世界** | 工作区绑定决定命令跑在哪台机器：`dsh-client-bindings`（绑定存储）+ `dsh-subprocess-dispatch`（接管 `subprocess`）+ 客户端 executor | `~\.dsh\plugins\dsh-client-bindings`、`~\.dsh\plugins\dsh-subprocess-dispatch` |
| 视频批量剪辑 | dsh-video-studio（内嵌 FFmpeg：剪切/变速/转场/BGM/字幕/格式转换/滤镜，11 个工具） | `~\.dsh\plugins\dsh-video-studio-local` |
| manifest 校对工具 | Electron 桌面工具（本地预览视频 + 帧级进度条 + 人工校对/修正 manifest），设置页「本地插件」下载 | `~\.dsh\tools\manifest-tool`（源码）+ `~\.dsh\plugins\dsh-video-studio-local\assets`（打包 exe） |
| 角色预设 | 7 个自定义角色 + 279 个 agency 角色（agency-agents 导入，中文名） | `~\.dsh\.agent-presets\<id>\` |
| 全局 skill 库 | 10 个 skill：sidecar / dsh-development / dsh-video-studio / firecrawl / adobe-illustrator-scripting / defuddle / json-canvas / obsidian-cli / obsidian-markdown / obsidian-bases | `~\.dsh\skills\<name>\SKILL.md`（另镜像到 `~\.agents\skills\`） |
| 本地插件（设置页） | sidecar 下载 + 本账号 token + 连接状态 + 启动命令 | 设置 → 本地插件 |

### 11.2 权限模型

`cordis.patch.yml` 的 `roleMap` 用**登录账号名**作键（区分大小写），在会话创建时把 `preset` 与 `workspace` 钉进该账号的会话。账号本身由 `admin` 在设置页创建——名字和 roleMap 的键对上才生效，对不上就用 `settings.yaml` 的默认预设。

| roleMap 键（角色） | 预设 | 工作空间 | 沙箱 |
|---|---|---|---|
| （不映射，默认） | standard（全量） | 全部 | danger-full-access |
| `Finance-mgr` | finance-manager | finance-ws | finance-confined（workspace-write + never） |
| `Finance-staff` | finance-manager | finance-ws | finance-confined |
| 其他角色 | art-design / business-sales / procurement / production / hr-management / rd-development | 各自工作区（可多选） | finance-confined |

- finance-confined：写边界 = 账号工作区文件夹，禁止任何权限升级；角色预设无 shell/web/subagent/workflow 工具（"让 AI 重启服务器"已封死）。它是通用「工作区限定」权限预设，不限于财务场景。
- 文件树权限矩阵：admin=全量、user=映射工作区、guest=403"需要升级权限才能使用该功能"。
- sidecar 路由机制：`local_run` 永远在「当前会话归属账号」的本机上执行——服务器按 `会话 → 归属账号 → 独立 token → sidecar` 自动路由，绝不串到别的账号的机器。

### 11.3 改动记录（CHANGELOG）

- **认证/角色**：fork `dsh-remote-local`；静态 roleMap + 动态 roleMap（多工作区 + 预设）、会话归属隔离、隐藏工作区/会话、账号管理界面、`/auth/config-options`。
- **浏览器外壳 cookie 自动引导（2026-09-09）**：登录页 `next` 自动携带当前进程启动 token，登录成功后由连接层兑换 30 天签名 cookie；认证后页面加载若 cookie 缺失/过期自动 303 走 token 兑换续期——局域网用户直接打开 `https://<IP>:8443` 即可，无需手工下发 `?token=` 链接。
- **会话可见性**：会话列表过滤在 `dsh-remote-local` 内**服务层包装 `sessionController.list`**（无核心改动、无 HTTP/gzip 副作用）。
- **会话隔离加固（2026-09-07）**：封堵三个跨账号数据面泄漏口——`session.search`（全文搜索）与 `session.export`（导出）对非 admin 拒绝，`session.follow`（日志流）在 WebSocket mux 按 sessionId 归属校验；`session.control` 仍广播会话元数据（不含对话内容）为已知低风险残留。
- **文件树**：窗格不显示修复（inject=["slots"]）、分列布局、上传/下载/拖拽复制、shell 依赖移除、xlsx 网格 + office_xlsx_write/office_docx_write、新建文件夹崩溃修复、Origin 按 hostname 放行、请求体 for-await、上传 mkdir recursive、文件夹上传。
- **使用统计**：scan 模式 + 原始 sessionPersistence 读取（修复大日志卡死），非 admin 403。
- **角色预设**：7 个自定义角色预设（finance-manager / art-design / business-sales / procurement / production / hr-management / rd-development）。
- **agency 角色库**：从 [agency-agents](https://github.com/msitarzewski/agency-agents) 导入 279 个角色预设（中文名，基于 standard 全量工具集 + 各自 persona）；移除 `finance-staff` 与 `standard-terminal`，默认预设改为 `standard`，`Finance-staff` 改指 `finance-manager`。
- **全局 skill 库（2026-09-10）**：`~\.dsh\skills\` 收录 10 个 skill（sidecar / dsh-development / dsh-video-studio / firecrawl / adobe-illustrator-scripting / defuddle / json-canvas / obsidian-cli / obsidian-markdown / obsidian-bases），并镜像到 `~\.agents\skills\`；预设自带的 `skills\` 目录通过 `customSkillDirs`（`!!js` 拼 `baseUrl`）接入，见 11.5。
- **本机桥接**：sidecar + local_run，per-account token；设置页「本地插件」（下载 + token + 连接状态 + 一键启动脚本）；`local_run` 按会话归属自动路由（不串设备）；sidecar 使用规范做成全局 skill 供所有预设共用。
- **视频剪辑（2026-09-10）**：`dsh-video-studio` 插件内嵌 FFmpeg 完整版（BtbN win64-gpl，ffmpeg/ffprobe 各约 157MB），11 个模型工具（video_build / video_cut / video_concat / video_audio / video_subtitle / video_convert / video_filter / video_probe / video_list / video_thumbnail / ffmpeg_run），覆盖剪切、变速（不变调）、分辨率、xfade 转场、BGM、字幕、格式转换（容器互转/提取音频/转 GIF）、常用滤镜（亮度/对比度/饱和度/模糊/锐化/黑白/旋转/翻转等）；并发限流 + 工作区沙箱收容；全局 skill `dsh-video-studio` 承载「读标注选片出片」与「抽帧读图生成 manifest 标注」两条工作流。
- **manifest 校对工具（2026-09-10）**：Electron 桌面工具（`~\.dsh\tools\manifest-tool`），三栏布局（视频列表 / 帧级预览 / manifest 表单），本地预览视频 + 帧级进度条 + 快进 + 加速 + 人工校对/修正 manifest（动态字段 / 新增字段 / tags 逗号分隔 / 直接保存 + 另存为），UI 中英切换；打包成 portable exe（内嵌 FFmpeg，约 151MB）挂到设置页「本地插件」供局域网用户下载。
- **部署工具**：`install.ps1`（含 dsh-doc 运行时下载、FFmpeg 下载、manifest 校对工具打包）、`verify.ps1`、`backup.ps1`、`migrate.ps1`；插件 `link:` 相对路径。
- **客户端执行世界（2026-09-16）**：本机桥接之后的更进一步——不再需要 agent 显式选 `local_run`，而是**整个执行面跟着工作区走**。新增两个插件（`dsh-client-bindings` 绑定存储、`dsh-subprocess-dispatch` 按 cwd→工作区→绑定分派）与一个跑在用户机器上的 executor；文件仍是服务器上那一份，客户端通过 SMB 共享（`\\<服务器>\ws-<工作区>`）看到同一份字节。另加全局 skill `local-staging`（>10MB / 工程格式走本机暂存）。实施与验收记录见 `docs/plan-client-world-progress.md`，设计见 `docs/plan-client-world.md`。
- **executor 自带共享凭据（2026-09-16）**：计划 §2.0 把「绑定工作区（SMB 凭据）」划给 executor，此前靠用户手工 `cmdkey`。现在配置页有「工作区共享凭据」一节，`--smb-user/--smb-password` 供无值守装机；主机名从绑定带回的可见路径推出，改密码可对已绑定工作区重新应用，`/status` 只报账号不回显密码。
- **executor 分发（2026-09-16）**：新增 `/dsh-subprocess-dispatch/executor.mjs` 下载端点（与 `/dsh-local-bridge/sidecar.mjs` 同形），并加进**设置 → 本地插件**的列表 —— 用户从此有一个受支持的途径把执行器装到本机，而不是靠手工拷贝。端点**刻意不列入 `publicPrefixes`**：下载者是设置页里已登录的浏览器，登录门禁正是该做的检查。文件里**不含 token**，凭据由配置页登录时签发。

### 11.4 运维提示

- host 改动（插件 `lib\index.js`、cordis.patch.yml）需整进程重启；客户端 `lib\client.js` 经 HMR 自动重发，浏览器 Ctrl+F5 生效。
- 启动：`pnpm dsh --profile web --trusted-host <局域网IP>`（于引擎 checkout 根目录）。
- 状态文件：`~\.dsh\auth\{store,session-owners,hidden-items,role-map}.json`、`~\.dsh\upgrade-state.json`、`~\.dsh\plugins\dsh-remote-local\run-diag.log`。
- **客户端执行世界**：绑定记录存在部署侧存储域 `client_binding`（**不在**引擎的 `workspace` 域里，两者只靠 id 关联），所以引擎升级不会动它。**服务端重启后所有绑定一律失效**（心跳全部陈旧），重启后需要重新绑定——这是设计如此，不是故障。executor 必须跑在用户的**交互式登录会话**里（映射盘符是按登录会话的），并且优先直接把 UNC 路径交给软件。
- **回滚（executor 出问题时一键退回纯服务器形态）**：把 `profiles/<name>/cordis.patch.yml` 里的 `subprocess-dispatch` 行改回 `disabled: true`、并去掉 `subprocess` 那一行的 `disabled: true`，重启即恢复成"全部在服务器执行"。**未绑定的工作区本来就是这个行为**，所以回滚只影响已经绑定的工作区；绑定记录留在 `client_binding` 里不会丢，重新启用后仍在（但按上面的规则，跨重启一律不活跃，需要重新绑定）。**这是刻意的设计**：一个改动只碰一个组合文件，回滚不需要动数据。
- **删除账号 ≠ 撤销完它的执行权（要顺手改配置）**：在设置页删除账号会**同时吊销它的绑定与签发的 executor token**（撤销某个工作区只吊销对应绑定，token 保留）。但 `subprocess-dispatch` 的 `tokens:` 里**配置写死的 token 属于配置层**，不走账号库，删账号不会让它们失效 —— **删账号时记得把配置里对应那一行也删掉**，否则那台机器仍能认证（并且能重新绑定）。
- 完整迁移/备份：见 `MIGRATION.md`。
- **`setup-smb.ps1` 不再带默认密码。** 第一版把 `-SmbPassword` 的默认值写死在脚本里，而它对一个**真实存在的本机账号**有效，且该脚本已提交进 git —— 等于把可用凭据写进了仓库。现在留空即本次随机生成。**该密码仍在 git 历史里（提交 `bf92f35`）**，所以：① 仓库推送到公开远端前必须先改密；② 更稳妥的做法是直接把那个 SMB 账号的密码轮换掉（`Set-LocalUser -Name dshtest -Password ...`）或删掉重建。**已启用的 `dshtest` 账号若继续用旧密码对外提供共享，等于共享凭据是公开的。**

### 11.5 全局 skill 与加载顺序

`~\.dsh\skills\` 与 `~\.agents\skills\` 是 dsh 的**用户级 skill 根**，与本仓库的 roleMap / 预设无关——**任何预设的 agent 都能看到**。目录格式固定为 `<root>\<name>\SKILL.md`（**只扫一层**，不递归），frontmatter 必须有 `name` 与 `description`。

| 来源 | rank | 路径 |
|---|---|---|
| `project-dsh` | 100 | `<项目>\.dsh\skills\` |
| `project-agents` | 200 | `<项目>\.agents\skills\` |
| `custom` | 300 | `customSkillDirs`（**预设自带的 `skills\` 走这条**） |
| `user-dsh` | 400 | `~\.dsh\skills\` |
| `user-agents` | 500 | `~\.agents\skills\` |
| `bundled` | 600 | dsh 发行版内置 |

rank 小的优先；同名 skill 由 rank 小的胜出，rank 相同才按注册顺序。

> **两个坑**：
> 1. 预设目录里的 `skills\` **不会**被自动发现——必须在预设的 `agent.cordis.yml` 里用 `customSkillDirs` 指过去，本仓库的写法是 `!!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`（`baseUrl` 由加载器注入）。
> 2. 同一份 skill 放到 `~\.dsh\skills\` 与 `~\.agents\skills\` 两个根，是为了让 dsh 之外的 agent（Claude Code / Codex 等）也能读到；两边内容保持一致即可。

### 11.6 客户端执行世界（用户须知）

> 这一节是写给**使用者**的，不是写给运维的。运维侧另见 `docs/plan-client-world-progress.md`。

**它做什么**：某个工作区被你的电脑"绑定"之后，这个工作区里的命令就**在你的电脑上执行**，而不是在服务器上。文件没有搬家——还是服务器上那一份，你的电脑通过 SMB 共享看到同一份字节。没绑定的工作区照旧在服务器上跑，行为和现在完全一样。

**你需要做的**：

1. 在**设置 → 本地插件**里下载 `executor.mjs`（和 sidecar 放在同一个地方），在命令行运行 `node executor.mjs`，然后打开它给出的本机配置页（默认 `http://127.0.0.1:38460`）登录一次。凭据由登录自动签发，**下载到的文件里不含任何 token**。之后通常设成开机自启即可。
2. 在配置页里选择要绑定到这台电脑的工作区。**同一时刻一个工作区只能被一台电脑绑定**；被别人占着时页面会告诉你是谁占用的。
3. 在配置页的「工作区共享凭据」里填一次共享账号与密码（见下）。

**要知道的四件事**：

- **合上笔记本 / 关掉助手 / 网络抖动超过宽限期，都会让出工作区。** 回来时可能已经被别人绑走，需要重新绑定。宽限期就是这个体验的调节旋钮。
- **助手没在跑的时候，命令不会"改到服务器上跑"，而是直接报错。** 这是故意的：如果它悄悄改到服务器执行，你会以为命令作用在自己的文件上，实际上没有。
- **大文件（>10MB）和 PS/Blender 工程文件不要直接用共享路径打开。** Adobe 官方只支持在本地硬盘上使用 Photoshop，明确"不支持把网络或可移动驱动器作为暂存盘"；在网络上原地编辑可能报 `file is locked` / `disk error` / `unknown format`，而且**损坏可能延迟出现、当场看不出来**。请让 agent 走本机暂存流程（签出到本地 → 处理 → 回写）。最要紧的一条：**不要在资源管理器里双击共享上的大文件直接用 PS 打开。**
- **工作区被别的账号占用时，对你而言等同于没绑定**——你的命令会在服务器上执行，绝不会跑到别人的电脑上。
- **暂存目录里的残留会主动告诉你。** 如果上次任务的文件没回写完，执行器会在你**下次绑定这个工作区时**，在日志和本机配置页上把它们列出来（只列，**不会替你删**）。看到就确认一下还要不要 —— 那些可能是没写完的中间结果。

**和"本机软件调用"（`local_run`）的关系**：`local_run` 现在退居**逃生口**——跑一次不常用的 exe、应急排查用。处理工作区里的文件请用客户端执行世界，因为文件本来就在工作区里，不需要在模型上下文里来回搬运。

**每台客户端机器的一次性准备**（三件事，各做一次）：

1. **装三个程序**（一次性的，装完不用再管）：

   ```powershell
   winget install OpenJS.NodeJS.LTS          # 执行器本体需要 Node
   winget install Microsoft.PowerShell       # agent 的 shell 工具用它（系统自带的 5.1 不算）
   winget install BurntSushi.ripgrep.MSVC    # agent 的 glob / grep 用它
   ```

2. **下载两个文件，双击其中一个。** 在**这台客户端机器**的浏览器里打开 `https://<服务器>:8443` 登录 → **设置 → 本地插件 → 「客户端执行器（executor）」那张卡片** → 先点「下载 `executor.mjs`」，再点「**下载一键启动脚本**」。把两个文件放进**同一个文件夹**，双击 `启动执行器.cmd`。

   那个脚本里已经写好了一切，所以**不需要**：手工找证书、设 `NODE_EXTRA_CA_CERTS`、在配置页里输密码、手打服务器地址。它会自己写出 `caddy-root.crt`、带上服务器地址与一枚**新签发的执行器凭据**（可在「设置 → 工作区绑定」里看到并按机器撤销）。

   跑起来后打开它给出的本机配置页 `http://127.0.0.1:38460`。

3. **在配置页里做两件事**：填一次**工作区共享凭据**（共享账号与密码，执行器会存进本机凭据库，之后 `\\<服务器>\ws-<工作区>` 就像本地盘一样可用），然后**点「绑定」**——可见路径已经按服务器那边的共享规则**预填**好了（可改）。不需要登录。

   之后通常设成开机自启即可。无值守装机可以用 `--smb-user` / `--smb-password`。

> **手动路径仍然可用**（脚本生成不了时的退路）：下载 `executor.mjs`，自己设 `NODE_EXTRA_CA_CERTS` 指向 caddy 的根证书，然后 `node executor.mjs --server https://<服务器>:8443`，在配置页用 `admin` 登录一次再绑定。旧版执行器**不会**应答服务器的 ping，空闲时会被每约 9 秒判一次掉线并重连 —— 所以服务端升级后，客户端也要重新下载一次执行器（**症状**：那台机器的日志里反复出现 `disconnected — retrying in …`）。

> 主机名不用你填：执行器从**绑定带回的可见路径**里推出共享在哪台机器上，所以不会指错。改密码后重新保存即可，会对当前已绑定的工作区重新应用。凭据与 executor token 存在同一个 `state.json`（权限 0600），**不会回显、也不会发往服务器**。

> **本机暂存目录可以留空。** 绑定页里那个「本机暂存目录」是给大文件用的临时工作区（PSD/Blend 之类不能直接在网络共享上打开的文件，流程见全局 skill `local-staging`）。**留空就用默认值 `%USERPROFILE%\.dsh-staging`** —— 执行器会把默认值写进绑定记录，提示词里因此一定会给出一个确切路径。想放到别的盘（比如专门的数据盘）再自己填。

**如果要用 Figma（MCP）**：需要**先在你自己的电脑上打开 Figma 桌面 App，并在 Dev Mode 里手动启用 MCP server**（默认端口 3845）。这一步没有 API 可以代劳，必须人工做一次；启用后 agent 才能通过服务器转发访问它。服务端的转发白名单里已经包含 3845。

