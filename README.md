# DeepSeek Harness 局域网部署说明

> **当前部署状态、插件清单、故障处置与回滚方法：见 `STATE.md`。**（接手/排障先读它）


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
| 页内文件树（分列窗格） | fork `folder-tree-sh`（预览/编辑/上传/下载/拖拽/文件夹上传/xlsx 网格；**顶部工具行已改两行自适应换行**、窄面板下按钮不再被裁；**右键菜单的「刷新」已真正重列目录**） | `~\.dsh\plugins\folder-tree-sh-local` |
| Token 用量统计 | fork `dsh-usage-panel`（全站聚合，admin 专属） | `~\.dsh\plugins\dsh-usage-panel-local` |
| 本机软件调用 | dsh-local-bridge sidecar + `local_run` 工具（**已降级为逃生口**，见 11.6） | `~\.dsh\plugins\dsh-local-bridge` |
| **客户端执行世界** | 工作区绑定决定命令跑在哪台机器：`dsh-client-bindings`（绑定存储）+ `dsh-subprocess-dispatch`（接管 `subprocess`）+ 客户端 executor | `~\.dsh\plugins\dsh-client-bindings`、`~\.dsh\plugins\dsh-subprocess-dispatch` |
| 视频批量剪辑 | dsh-video-studio（内嵌 FFmpeg：剪切/变速/转场/BGM/字幕/格式转换/滤镜，11 个工具） | `~\.dsh\plugins\dsh-video-studio-local` |
| manifest 校对工具 | Electron 桌面工具（本地预览视频 + 帧级进度条 + 人工校对/修正 manifest），设置页「本地插件」下载 | `~\.dsh\tools\manifest-tool`（源码）+ `~\.dsh\plugins\dsh-video-studio-local\assets`（打包 exe） |
| 角色预设 | 7 个自定义角色 + 279 个 agency 角色（agency-agents 导入，中文名） | `~\.dsh\.agent-presets\<id>\` |
| 全局 skill 库 | 10 个 skill：sidecar / dsh-development / dsh-video-studio / firecrawl / adobe-illustrator-scripting / defuddle / json-canvas / obsidian-cli / obsidian-markdown / obsidian-bases | `~\.dsh\skills\<name>\SKILL.md`（另镜像到 `~\.agents\skills\`） |
| 本地插件（设置页） | sidecar 下载 + 本账号 token + 连接状态 + 启动命令 | 设置 → 本地插件 |
| **模型网关** | 客户端本地模式的模型入口：`/llm/v1`（OpenAI 兼容面），按 token 认账号、限额、入账，用部署自己的 key 转发 | `~\.dsh\plugins\dsh-llm-gateway-local` |
| **桌面客户端** | 复用上游 `apps/desktop` 加服务器模式 + 定时归档；**装完自带部署地址**，两种模式一个窗口 | 源码 worktree `C:\Users\bestarc\Desktop\dsh-desktop`（分支 `hqz-desktop-client`） |
| **会话归档 → Obsidian** | 客户端定时导出本机会话 → 上传部署 → 部署用自己的模型精简 → 写进 `obsidian笔记\会话记录\` | `~\.dsh\client\export-session.mjs` + `~\.dsh\plugins\dsh-archive-local` |
| **客户端安装包分发** | 设置 →「本地插件」一张卡片，`/auth/client-installer` 流式送 `~\.dsh\client\dist` 里最新的 exe | `plugins\dsh-remote-local\lib\index.js` |

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
- **executor 打包成单文件 exe（2026-09-16）**：装机成本从「三个 winget + 命令行 + 参数」降到「解压 + 双击」。`build-executor-exe.mjs` 把执行器打成 Node SEA 单文件 `dsh-executor.exe`（约 83 MB），再和**裁剪过的 `node-pty`**（1.6 MB，去掉 `.pdb` 与其它平台预编译）一起压成 `dsh-executor.zip`（约 32 MB），由 `/dsh-subprocess-dispatch/dsh-executor.zip` 分发（流式 + 支持 Range 续传，卡片上是 `/auth/executor-pack`）。exe **不需要客户端装 Node**；原生模块进不了 exe，就解包在它旁边，执行器自己会找（`siblingNodePty`）。**这一条修掉的是一个真 bug**：SEA 下入口按 CommonJS 跑，`import.meta.url` 是 `undefined`，于是 `createRequire` 建不出来 —— 连显式 `--node-pty` 都到不了，症状是终端一开就关（`remote terminal is closed`），而进程执行一切正常。现在 `resolveRequireBase()` 会回退到程序自身目录，并新增 `dsh-executor.exe --self-test` 让客户端机器自己能回答「我能不能开终端」。构建产物在 `plugins/dsh-subprocess-dispatch/dist/`（已 gitignore，可重建）。
- **机器工具：agent 直接操作客户端电脑（2026-09-17）**：新增两个模型工具（由 `dsh-subprocess-dispatch` 注册）——`machine_list` 列出**执行器在线**的机器（machineId / 主机名 / 平台 / 登录用户 / 主目录），`machine_run` 在指名的那台机器上跑命令并返回 stdout / stderr / 退出码。**不需要绑定、不需要共享**：绑定原本只是「让不指名机器的 shell 工具也能落到那台机器上」的路由，工具直接指名机器，所以既不需要映射也不需要路径翻译。执行器 `hello` 增加 `home` / `user`，`cwd` 缺省时用**那台机器的用户主目录**。没有执行器在线时**明确失败**（列出在线机器），绝不静默改在服务器上跑。取证插件 `plugins/dsh-machine-probe`（挂 `pilot-auth`）与用法见 `docs/plan-client-world-progress.md` §7-D-10，用户操作见 11.6。
- **修掉 exe 的「第二个自己」（2026-09-17）**：打包形态下**每结束一个终端**都会冒出一个重复的执行器 —— node-pty 用 `child_process.fork()` 起它的 console-list 助手，而 fork 跑的是 `process.execPath`，打包后那就是执行器自己；那个进程忽略未知参数正常启动、连上服务器、报同一个 machineId，服务器把「同一台机器的第二条连接」判为重连并 retire 掉第一条，于是**所有在飞的进程与终端句柄一起失效**（日志指纹：同一份日志出现第二次启动横幅 + `EADDRINUSE` 抢不到 38460）。现在执行器发现自己是那个助手就只跑助手然后退出。修复前后用进程监视器差分：修前 `n=2/3` 且父进程是执行器，修后整轮 `n=1`，`terminal-python-repl` 由 ❌ 转 ✅。细节见 §7-D-11。
- **模型网关（2026-09-18，客户端世界阶段 1）**：`dsh-llm-gateway-local` 在部署上开一个 OpenAI 兼容的模型面 `/llm/v1`（`/models` 与 `/chat/completions`），**按 token 认账号**，再用部署自己的 DeepSeek key 转发，并把用量记进 `profiles/web-client/llm-gateway-usage.jsonl`。客户端因此**一个 AI key 都不需要**：`settings.yaml` 把 `llm-deepseek` 的 `baseURL` 指到 `<origin>/llm/v1`、`apiKeyEnv` 指到 `HQZ_GATEWAY_TOKEN`。门禁要放行 `/llm` 前缀（token 不是会话 cookie），见 `enable-client-features.ps1`。
- **会话归档（2026-09-18，阶段 3）**：`~\.dsh\client\export-session.mjs` 把本机会话导成转录（只收 `user/message` 里 **source.kind === 'user'** 的部分——插件注入的上下文动辄几万字，收进来只会把"这次做了什么"淹掉），按账号上传到 `/archive/v1/sessions`；服务端 `plugins\dsh-archive-local` 先落原始转录，再用部署的模型精简成一篇笔记写进 `obsidian笔记\会话记录\`（frontmatter + 中文序号章节 + 索引一行，格式照库里已有的样本做）。同一会话重复归档是**替换**：主题变了连旧笔记一起删，不会留孤儿。台账 `$DSH_HOME\client\archive-state.json` 保证 `--pending` 只传变化过的会话——否则每 6 小时把同一个会话重传一遍，模型精简是真金白银。
- **桌面客户端（2026-09-21，阶段 2/4）**：在**上游自带的 Electron 桌面端**（`apps/desktop`，MIT）上打补丁，而不是从零写壳——只加三样：**服务器模式**（同一窗口加载部署的 Web UI，带只能由外壳绘制、页面改不掉的模式徽标，菜单里可切换）、**证书信任**（配置了 `certificateSha256` 就只认那一张，否则接受该 origin 的自签证书并报出指纹供钉）、**定时归档**（启动 60 秒后第一次，之后每 6 小时；只认 `$DSH_HOME\client\export-session.mjs`，没这个脚本就整条链路不启用）。客户端**自带 Node 与 dsh**，装机机器不需要任何其他依赖；本地模式全权限无审批（刻意如此，装机时要向用户说明）。真机冒烟：隔离 home 里窗口加载 `dsh-app://app/`、无徽标、中文界面、客户端插件正常挂载；只写"上次选的是服务器模式"、机器上任何地方都没有地址文件时，窗口自己连上 `https://192.168.28.239:8443` 并显示徽标「服务器模式 · HQZ 局域网」。
- **本地模式的模型与证书（2026-09-22）**：把"装完就能用本地模式"真正做完，两个坑各踩了一轮。**模型路由**烘进应用清单的 `dshDesktopGateway`（origin / models / 网关 token），首次启动写进 `$DSH_HOME\profiles\desktop\cordis.patch.yml` 与 `.credentials.yaml`；**根证书**由 `.env.windows` 的 `DSH_DESKTOP_GATEWAY_CA_FILE`（指 caddy 的 `root.crt`）烘进同一个清单值，首次启动写成 `profiles\desktop\gateway-ca.crt`，外壳把它作为 `NODE_EXTRA_CA_CERTS` 交给本地 Host 与归档脚本 —— **因为 Node 不读 Windows 证书库**，光有路由会在握手就断（`Transport: DeepSeek API request to https://…/llm/v1 failed`），而外壳窗口自己那套"接受自签证书"管不到那个独立进程。实测对照（用**打包运行时**跑一次性任务）：带根证书 → 模型回话；不带 → 复现原报错。客户端机器上要改指别处仍用 `client\provision-client.ps1`（新增 `-DesktopGatewayCa`）。
- **文件树顶部工具行分两行（2026-09-22）**：`folder-tree-sh` fork 的顶栏原来是**一行十项**（图标/标题/路径 + 7 个按钮）而容器是 `overflow:hidden`，面板一窄就把「刷新 / 上传 / 传文件夹」整块裁掉、点不到。现在改成两段：第一行是图标 + 标题 + 路径，第二行是全部按钮且 `flex-wrap:wrap`，任何宽度下都完整可见。顺手修掉一个老毛病：右键菜单的「🔄 刷新」和上传/粘贴后的自动刷新，代码点的是"头部第一个按钮"（其实是「文件」视图切换），所以只是切了视图、并没有重列目录（平时被 5 秒自动刷新盖住了）；现在刷新按钮有独立 class，那个入口真的会重列目录。改动只在 `~\.dsh\plugins\folder-tree-sh-local\lib\client.js`。
- **打包与分发（2026-09-21）**：**装完就自带服务器模式** —— 打包时把部署地址烘进应用清单的 `dshDesktopServerMode`。地址是"当时的部署事实"，所以是**问出来的**：`DSH_DESKTOP_SERVER_ORIGIN` → `…_HOST`(+`_PORT`) → `DSH_LAN_IP`（`start-dsh-lan.cmd` 自己就设这个变量）→ 本机网卡（私网段优先），走到最后一步时逐个候选地址请求 `https://<地址>:8443/auth/me`，**谁答用谁**，都不答就保留第一个候选并在日志里 WARNING（不因此让构建失败）。安装包上线后由设置 →「本地插件」的「桌面客户端（可选）」卡片直接分发（`$DSH_HOME\client\dist` 里最新的 `.exe`，列表每次请求现读，**发新版 = 把新 exe 丢进目录**）。服务端一条命令：`~\.dsh\build-client.ps1`（备镜像 → 构建 → 发布 → 核对哈希）。

### 11.4 运维提示

- host 改动（插件 `lib\index.js`、cordis.patch.yml）需整进程重启；客户端 `lib\client.js` 经 HMR 自动重发，浏览器 Ctrl+F5 生效。
- 启动：`pnpm dsh --profile web --trusted-host <局域网IP>`（于引擎 checkout 根目录）。
- 状态文件：`~\.dsh\auth\{store,session-owners,hidden-items,role-map}.json`、`~\.dsh\upgrade-state.json`、`~\.dsh\plugins\dsh-remote-local\run-diag.log`。
- **操作用户电脑（机器工具）**：agent 通过 `machine_list` / `machine_run` 在**执行器在线**的机器上跑命令，不需要绑定。一台机器能被寻址的前提是有人在那台机器上把执行器打开；**任何已登录账号都能寻址任何在线机器**（当前口径）。执行器必须跑在用户的**交互式登录会话**里。绑定存储（部署侧存储域 `client_binding`）与 `/client-admin/bindings` 仍保留，但 Web UI 已不再创建绑定。
- **回滚（executor 出问题时一键退回纯服务器形态）**：把 `profiles/<name>/cordis.patch.yml` 里的 `subprocess-dispatch` 行改回 `disabled: true`、并去掉 `subprocess` 那一行的 `disabled: true`，重启即恢复成"全部在服务器执行"，同时机器工具也随之消失（它们由这个插件注册）。数据不动，重新启用后一切照旧。**这是刻意的设计**：一个改动只碰一个组合文件，回滚不需要动数据。
- **删除账号时留意 `tokens:`**：删账号会同时吊销它的绑定与签发的 executor token，但 `subprocess-dispatch` 配置里**写死的 token 属于配置层**，不走账号库 —— 删账号时记得把配置里对应那一行也删掉，否则那台机器仍能认证。
- 完整迁移/备份：见 `MIGRATION.md`。
- **`setup-smb.ps1` 不再带默认密码。** 第一版把 `-SmbPassword` 的默认值写死在脚本里，而它对一个**真实存在的本机账号**有效，且该脚本已提交进 git —— 等于把可用凭据写进了仓库。现在留空即本次随机生成。**该密码仍在 git 历史里（提交 `bf92f35`）**，所以：① 仓库推送到公开远端前必须先改密；② 更稳妥的做法是直接把那个 SMB 账号的密码轮换掉（`Set-LocalUser -Name dshtest -Password ...`）或删掉重建。**已启用的 `dshtest` 账号若继续用旧密码对外提供共享，等于共享凭据是公开的。** 另外：脚本**第 21 行的用法示例**里还留着一个 22 位的真口令（`-SmbPassword '<22 字符>'`），它出现在 7 个未推送的提交里 —— push 之前一并换成占位符。
- **客户端构建与发布（2026-09-21，2026-09-22 补根证书）**：服务端一条命令 `~\.dsh\build-client.ps1` —— 备好本机 Electron 镜像 → 跑 `pnpm run package:desktop:win:x64:unsigned` → 把新产物复制进 `~\.dsh\client\dist` 并核对哈希。**打包期间不要动 git 仓库**：客户端构建把 `DSH_CLIENT_COMMIT_HASH` 记进构件记录，`release:pack` 会再比一次，中途提交会让打包以 `client build environment differs from the required artifact profile: DSH_CLIENT_COMMIT_HASH` 中止（构建约 15 分钟，先提交完再开跑）。
- **换服务器时客户端要改什么（只看一处）**：`Desktop\dsh-desktop\apps\desktop\.env.windows`（gitignored，每台构建机一份）—— 服务器地址 `DSH_DESKTOP_SERVER_MODE/ORIGIN/LABEL`、本地模式的网关 `DSH_DESKTOP_GATEWAY(_ORIGIN/_MODELS/_TOKEN)`、**部署的根证书 `DSH_DESKTOP_GATEWAY_CA_FILE`**（指 `%APPDATA%\Caddy\pki\authorities\local\root.crt`）。这些值都是**打包时烘进应用清单**的，改完必须重新打包发布；**客户端源码与 `apps/desktop` 的代码一行都不用改**。逐步清单见 `MIGRATION.md` §三 第 5 步。
- **从零装一台新服务器时**：照 `MIGRATION.md` §三 的六步走（第 4b 步是"开通客户端世界"：`-RunProfile web-client`、给 `subprocess-dispatch` 加 `machineSecret`、`enable-client-features.ps1 -Apply`、`node build-executor-exe.mjs` 重建执行器分发包）。仓库里的 `.ps1` **一律带 UTF-8 BOM**：无 BOM 的中文在 Windows PowerShell 5.1（新机默认的 `powershell.exe`）下会被按 ANSI 解码，**脚本直接解析失败**（`install.ps1`/`backup.ps1`/`migrate.ps1` 都踩过，已于 2026-09-22 补齐并逐个用 5.1 复验）；用 `edit`/`write` 之类的工具改完 `.ps1` 必须补回 BOM。
- **客户端相关的三处目录**：`~\.dsh\client\`（provisioning 脚本 + 导会话脚本 + 镜像服务器 + `dist\` 安装包，`dist` 已 gitignore）、桌面 worktree `C:\Users\bestarc\Desktop\dsh-desktop`（客户端源码与构建现场，**引擎 checkout 仍是零改动**）、`~\.dsh\plugins\dsh-remote-local`（设置页「本地插件」那张下载卡片与 `/auth/client-installer` 路由所在）。客户端机器上的数据不在这里：`%USERPROFILE%\.dsh` 与 `%APPDATA%\@deepseek-ai\dsh-desktop` 各自独立，**服务器迁移不会带上它们**。
- **桌面 profile 由桌面应用独占**：`$DSH_HOME\profiles\desktop`（bundle 列表 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，自包含、无 `link:` 依赖），应用启动时只创建缺失文件、**不覆盖已存在的**，CLI 也 boot 不了这个 profile。所以先放 provisioning 的文件是安全的。**例外**：`gateway-ca.crt` 与 `cordis.patch.yml` 里的路由是"构建的事实" —— 带根证书的构建会覆盖前者，补丁层那一行只在没配置过时才写；而 `settings.yaml` 的 `llm-deepseek:` 段（provisioning 写的）**优先级高于**补丁层，即 provisioning 可以整体改指到别的部署。

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

### 11.6 让 agent 操作你自己的电脑

**一句话**：在你要被操作的电脑上**双击执行器**，然后直接跟 agent 说"在我的电脑上……"。agent 用两个工具在那台机器上干活：`machine_list`（看哪些机器在线）和 `machine_run`（在一台机器上跑命令，拿回 stdout / stderr / 退出码）。

**不需要绑定、不需要共享、不需要选工作区。** 执行器连上服务器，那台机器就能被 agent 寻址。

**每台电脑的一次性准备**（三步，之后开机自启即可）：

1. **拿包。** 在这台机器的浏览器里打开 `https://<服务器>:8443` 登录 → **设置 → 本地插件 → 「客户端执行器（executor）」那张卡片** → 点「**下载**」拿到 `dsh-executor.zip`（约 32 MB），再点「**下载一键启动脚本**」。

2. **解压，把 `启动执行器.cmd` 放进解压出来的文件夹，双击它。** exe 里已经内置了服务器地址、TLS 根证书与**部署密钥**，不需要装 Node、不需要命令行参数、不需要填任何东西。

   起来后会打开一个本机状态页 `http://127.0.0.1:38460`，那里**只显示状态**：连上哪台服务器、本机标识、证书与共享凭据的状态。**没有工作区列表**（这是刻意的：该页面在本机环回上应答，同机任何进程和任何用户会话都能访问）。

3. **完事。** 不需要再装别的程序：agent 在你电脑上跑命令用的是系统自带的 `powershell.exe`（Windows 5.1）+ 你自己装的软件。

**agent 用起来要注意的三件事**（它会自己知道，这里只是让你能看懂它的行为）：

- **命令里的路径是"你电脑上"的路径**，不是服务器上的。不指定目录时，就在你的用户主目录（如 `C:\Users\你`）下执行。
- **执行器没开 = 命令不会跑。** agent 会明确报"没有名为 X 的在线机器"并列出在线的机器，**绝不会悄悄改成在服务器上跑**。看到这个提示就是让你去把那台电脑上的执行器打开。
- **服务器上的工作区文件不会自动出现在你电脑上。** 共享那套自动挂载已经停用，所以 agent 在你电脑上只能操作那台机器本地已有的文件。

**授权**：机器能被寻址的前提是有人在那台机器上**把执行器打开**（本地动作）。任何**已登录本部署的账号**都能寻址任何在线机器 —— 这是当前的口径；要按账号限制需要另行开发。工作区授权（哪个账号能看到哪个工作区）与机器工具无关。

**大文件仍然走本机暂存**：在你电脑上处理 **>10MB 或 PS/Blender 工程文件**时，让 agent 先把文件签到本机目录再处理，别在网络盘上原地打开。Adobe 官方只支持在本地硬盘上使用 Photoshop，明确"不支持把网络或可移动驱动器作为暂存盘"；在网络上原地编辑可能报 `file is locked` / `disk error` / `unknown format`，而且**损坏可能延迟出现、当场看不出来**。

**和"本机软件调用"（`local_run`）的关系**：`local_run` 是**逃生口** —— 跑一次不常用的 exe、应急排查用；它需要你本机装了 sidecar，没装就失败（正常状态，不是故障）。日常操作用执行器 + 机器工具。

**工作区共享／绑定已停用（2026-09-17）**：原先在「Web UI 文件树面板」里把工作区绑到某台电脑的那套操作**已经全部撤掉** —— 文件树面板与会话标题栏里的控件、`/client-web` 接口、新建工作区时的共享步骤都已删除。**所有工作区的命令都在服务器上执行**（`read`/`write`/`grep` 与 shell 看到的是同一份文件），工作区内容照常可读可写，工作区授权不受影响。要让 agent 操作用户电脑，改用上面的机器工具（执行器照旧）。

> **恢复步骤**（想重新启用「工作区里的命令在你的电脑上执行」时）：`profiles/web-client/cordis.patch.yml` 里已留好 `visiblePathHints` / `noShareRoots` 两个配置项（**当前没有任何消费者读它们**，文件内有注释标注）。恢复需要 ① 把 `/client-web` 接口与两处界面控件加回来（见 git 历史）；② 给要绑定的工作区在服务器上建 SMB 共享（`new-workspace.ps1` 或 `setup-smb.ps1 -SharePaths`）；③ 重启线上。**这套机制故障不少，恢复前先看 `docs/plan-client-world-progress.md` §7-D-9。**

> **一定要解压，不要直接在压缩包里双击。** 包里有两样东西：`dsh-executor.exe` 和它旁边的 `node-pty\`。**终端（ConPTY）需要 `node-pty`**，原生模块没法打进 exe，所以它随包解压在那里，执行器启动时自己会找（用 `--self-test` 可确认）。只把 exe 单独拷走会**只丢交互式终端**，命令执行、HTTP 转发照常，并且终端第一次被请求时会报出确切原因 —— **「终端不能用」的第一个分诊动作永远是 `dsh-executor.exe --self-test`**。

> **证书是自动的，但可以显式指定。** 服务器走 caddy 自签证书，exe 会依次尝试 `--ca <路径>`、环境变量 `NODE_EXTRA_CA_CERTS`、以及**它自己旁边**的 `caddy-root.crt` 和 caddy 的默认安装位置。都找不到时，连不上会**明说这可能是证书问题**并给出补救命令（而不是只报一个 `non-101`）。
>
> **症状对照**：日志里反复 `Received network error or non-101 status code` + `disconnected — retrying in …`，而服务器地址是 `wss://…`，**先怀疑证书**，不是网络。

> **`启动执行器.cmd`（一键启动脚本）现在只是"给 exe 带一个桌面快捷方式"的方便入口**：脚本里写好了证书路径与凭据，放进和 exe 同一个文件夹双击即可。**它不是必需的**，直接双击 `dsh-executor.exe` 也一样。

> **换新包之前先关掉旧的。** 正在运行的 exe 会占住文件（Windows 不允许删改运行中的 exe），要替换那个文件夹请先结束任务管理器里的 `dsh-executor`，再覆盖。**构建时同理**：`build-executor-exe.mjs` 写不出 exe 就是因为它正在运行。

> **自检**：`dsh-executor.exe --self-test` 会在本机回答「这台机器到底能不能开终端」，成功时输出 `"loaded":true,"spawned":true,"sawMarker":true`，失败时给出确切原因（找不到 `node-pty`、程序在 PATH 上找不到、终端分配失败）。排查装机问题时先跑它。

> **手动路径仍然可用**（想自己管一个 Node 环境，或把机器接到另一套部署）：下载 `/dsh-subprocess-dispatch/executor.mjs`，自己设 `NODE_EXTRA_CA_CERTS` 指向 caddy 的根证书，然后 `node executor.mjs --server https://<服务器>:8443 --secret <部署密钥>`；`npm i node-pty` 到它旁边就能得到终端，或用 `--node-pty <路径>` 指明。命令行参数**优先于** exe 里内置的部署值，所以一台机器可以随时改指向。旧版执行器**不会**应答服务器的 ping，空闲时会被判掉线并重连 —— 服务端升级后客户端也要重新下载一次（**症状**：那台机器的日志里反复出现 `disconnected — retrying in …`）。

> **这台机器叫什么，不用你填。** 机器标识（`desktop-xxxx-1a2b3c4d`）在首次运行时生成、与 `state.json` 同目录落盘，**重新注册也不换**；服务器按它寻址，`machine_list` 显示的就是它。同一个 `state.json` 里存的共享凭据（权限 0600）**不会回显、也不会发往服务器**。


**如果要用 Figma（MCP）**：需要**先在你自己的电脑上打开 Figma 桌面 App，并在 Dev Mode 里手动启用 MCP server**（默认端口 3845）。这一步没有 API 可以代劳，必须人工做一次；启用后 agent 才能通过服务器转发访问它。服务端的转发白名单里已经包含 3845。

### 11.7 桌面客户端：局域网里那台电脑上的应用

**一句话**：在那台电脑上装一个应用，它要么**当本机 agent 用**（工具直接操作那台机器上的文件和软件，模型请求打到本部署的网关），要么**当本部署的窗口用**（加载 `https://<服务器>:8443`，一切在服务器上）。两种模式是同一个窗口、同一份文档位置，菜单里切换。

**怎么拿到**：在那台机器的浏览器里打开 `https://<服务器>:8443` 登录 → **设置 → 本地插件 → 「桌面客户端（可选）」那张卡片** → 点「**下载**」拿到 `deepseek-harness-<版本>-win-x64.exe`（约 293 MB）。**文件名不带构建时间**（每次构建都是同一个名字），所以**换包之后必须重新下载**；想确认拿到的是哪一次构建，在下载目录里比对哈希：`Get-FileHash .\deepseek-harness-*.exe -Algorithm SHA256`，与 `docs\memory.md` 里"交付物"一节记的那一行对。

**怎么装**：双击。安装器**只装当前用户**（不需要管理员），安装目录可改，装完默认勾选"立即启动"。**装机机器不需要预装任何东西** —— Node、dsh、生产依赖全在安装包里；归档脚本也是用应用自带的 Node 跑的。

**装完怎么用**：

| 模式 | 跑在哪 | 模型从哪来 | 怎么认 |
|---|---|---|---|
| **服务器模式**（安装后第一次启动） | 服务器：客户端只是一个窗口 | 服务器上的循环 | 窗口顶部黄色徽标「服务器模式 · 部署名」 |
| **本地模式**（菜单切换） | **这台机器**：agent 循环在本机，工具直接操作本机文件与软件 | 本部署的模型网关（`<origin>/llm/v1`），装完就有 | 没有徽标 |

- **切到服务器模式**：菜单 **模式 → 服务器模式**（或在服务器模式里点徽标上的「切回本地」）。选中的模式记在 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop-mode.json`，重启后保持。
- **服务器模式要登录**：窗口加载的是部署自己的 Web UI，第一次会让你输账号密码 —— 跟浏览器打开 `https://<服务器>:8443` 是同一件事。
- **装完自带部署地址**：打包时地址已经烘进应用清单，所以**不需要任何配置**就能用服务器模式。要让某一台机器连**别的**部署，在它的 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop-client.json` 里写 `{ "server": { "origin": "https://…:8443", "label": "…" } }`（或设 `DSH_DESKTOP_SERVER_MODE`）。
- **本地模式装完就有模型**：模型路由（网关地址 + 模型清单 + 网关 token）在打包时**烘进应用清单**，第一次启动写进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 与 `.credentials.yaml`，**不需要 provisioning**。**客户端没有任何 AI key**：模型请求带网关 token，网关按 token 认账号、限额、入账，再用部署自己的 key 转发。本地模式默认**全权限、无审批**（`danger-full-access`）—— 这是刻意的：agent 以该 Windows 用户身份直接操作这台机器，装机时要向用户说明。
- **证书也是烘进去的**：部署的 TLS 终结器（caddy）自签，而**本地 Host 是个普通 Node 进程、不读 Windows 证书库**，所以光有模型路由还会卡在握手上（报 `DeepSeek API request to https://…/llm/v1 failed`）。安装包把**根证书**一并烘进去，首次启动写成 `%USERPROFILE%\.dsh\profiles\desktop\gateway-ca.crt`，外壳把它作为 `NODE_EXTRA_CA_CERTS` 交给本地 Host 与归档脚本。要根证书而不是叶子证书：终结器换叶子证书时根证书不变。
- **要改指到别的部署才用 provisioning**：在那台机器上跑一次 `~\.dsh\client\provision-client.ps1`（把 `client\` 整个目录拷过去），它写 `settings.yaml`（网关端点与模型清单）、`.credentials.yaml`（网关 token 与归档 token）、`archive.json`、`profiles\desktop\cordis.patch.yml`，`-DesktopGatewayCa <根证书.pem>` 再写 `profiles\desktop\gateway-ca.crt`，外加把服务器模式也一并配好的 `desktop-client.json`。`-WhatIfOnly` 先看一遍。**优先级（实测）**：`settings.yaml` 里的 `llm-deepseek:` 段**覆盖**安装包烘进补丁层的那一行（设置层是"组合基座 + 用户层"，用户层在上），所以 provisioning 确实能把某台机器改指到另一个部署；想回到安装包的默认路由，就把 `settings.yaml` 里那一段删掉。
- **会话会自动归档**：应用启动约 60 秒后跑第一次，之后每 6 小时一次（菜单里也有「立即归档会话」）。启用条件是**两件事同时成立**：`%USERPROFILE%\.dsh\client\export-session.mjs` 存在（provisioning 放进去的）**且**归档地址已配 —— 只装了应用、没配归档的机器不会自己去连任何地方。归档 → 部署用模型精简 → 写进服务器的 `obsidian笔记\会话记录\`。
- **出错了会弹一个原生框**：上面是「应用无法启动或已意外停止」与**有界的**错误末尾，按钮是 退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启。看到它就照按钮做；括号里的原始错误通常已经说明是哪一行配置不对。

> **客户端不连服务器也能用**（本地模式与服务器模式是两件事）：不 provisioning 就只有界面没有模型；不想让这台机器上传会话，就别给 `-ArchiveToken`。
