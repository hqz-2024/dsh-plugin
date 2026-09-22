# DSH 局域网部署迁移说明

本文件描述如何把整套 DeepSeek Harness 局域网部署（多账号登录 + 角色权限 + 会话隔离 + 文件树 + 文档解析 + 本机桥接 + 视频剪辑）迁移到另一台 Windows 服务器，并**完整保留所有数据**（会话历史、账号、工作区文件、配置、插件改动）。

> **占位符说明**：本文所有路径都不含真实用户名/IP。
> - `<用户名>` = 你的 Windows 用户名（等价于 `%USERNAME%`）
> - `%USERPROFILE%` = 你的用户主目录（如 `C:\Users\<用户名>`）
> - `<局域网IP>` = 服务器的局域网 IP

适用基线（本文所有路径以此为准）：

| 项 | 值 |
|---|---|
| 用户名 | `<用户名>` |
| DSH 代码 checkout | `C:\Users\<用户名>\Desktop\deepseek-harness` |
| DSH 数据/配置主目录 | `%USERPROFILE%\.dsh` |
| 财务工作区 | `C:\Users\<用户名>\Desktop\finance-ws` |
| 反代端口 | `https://<局域网IP>:8443` → 本机 `127.0.0.1:3080` |
| 反代 | caddy（`tls internal` 自签证书） |

---

## 一、架构总览

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

- dsh 只监听本机 loopback，caddy 是唯一对外入口。
- 多账号认证、角色门禁、会话隔离、工作区限制全部由本地 fork 插件实现；**核心 checkout 零改动**（可干净 `git clone`）。
- `dsh-local-bridge` 的 sidecar 跑在**每台用户自己的电脑**上，出站连接服务器的 `/sidecar`。

---

## 二、推荐：自动化迁移（backup.ps1 + migrate.ps1）

### 旧机：打包
```powershell
cd %USERPROFILE%\.dsh
powershell -ExecutionPolicy Bypass -File .\backup.ps1
# 产出 %USERPROFILE%\.dsh\backup\dsh-backup-<时间戳>.zip
```
> 备份含机密（`.credentials.yaml`、`auth\store.json`、`cordis.patch.yml` 的 sidecar token），请走可信通道，勿提交 git。

### 新机：先铺代码，再恢复数据
```powershell
# 1) 克隆本仓库到 %USERPROFILE%\.dsh，然后
cd %USERPROFILE%\.dsh
powershell -ExecutionPolicy Bypass -File .\install.ps1 -LanIP <局域网IP>

# 2) 恢复数据（把旧用户名路径自动映射成新机）
powershell -ExecutionPolicy Bypass -File .\migrate.ps1 -Backup <备份zip> -OldUser <旧用户名> -NewUser <新用户名>
```

> **Linux / macOS**：用 `install.sh`（bash）替代 `install.ps1`：
>
> ```bash
> cd ~/.dsh
> bash install.sh --lan-ip <局域网IP>
> ```
>
> 差异：Linux/macOS 的 dsh-doc 用 `engine: node`（无 win32 离线 OCR 运行时）；启动脚本为 `start-dsh-lan.sh`（`bash start-dsh-lan.sh` 启动）。备份/恢复用 `backup.sh` / `migrate.sh`（bash）：`bash backup.sh` 打 tar.gz，`bash migrate.sh --backup <备份> --old-user <旧用户名>` 恢复并重映射路径（`/home`、`/Users`、`C:\Users` 三种老 home 都能映射到新 home）。

`migrate.ps1` 会自动：解压 → 把 `workspace.json` / `cordis.patch.yml` / `settings.yaml` 等文本里的绝对路径从 `C:\Users\<旧用户名>\` 映射成 `C:\Users\<新用户名>\` → 重命名 `sessions\` / `sessions-archived\` 下的变形目录名 → 合并进 `~\.dsh`。

> ⚠ **跨用户名限制**：会话日志 `session.jsonl.zstd` 是 zstd 压缩二进制，其内部 cwd 脚本不重写；跨用户名恢复旧会话可能被拒（"session outside your workspace"）。**建议新机保持同名用户**，或由维护者做 zstd 级重映射。

> **备份里没有客户端源码，也没有客户端机器上的东西。** `backup.ps1` 打的是 `~\.dsh` 的状态与机密；客户端源码是**引擎仓库的一个 worktree**（见坑 5），两条分支都在 GitHub 上（`hqz-2024/hqz-dsh` 的 `hqz-dsh-0.1.6` 与 `hqz-desktop-client`），新机 clone 一次即可；`~\.dsh\client\dist` 里的安装包是可重建的构建产物（新机跑一次 `build-client.ps1` 就有了）。**每台客户端机器上的 `%USERPROFILE%\.dsh` 与 `%APPDATA%\@deepseek-ai\dsh-desktop` 完全不在迁移范围内** —— 服务器换了地址，就要在那些机器上重跑 `provision-client.ps1`，或者依赖安装包里烘进去的地址（这正是换地址后要重新打包的理由，见坑 7）。

---

## 三、新服务器部署：一步一步

> 从零装一台新服务器，照顺序做即可。每步都写了「做完应该看到什么」。原理与例外见 §五 的坑，最后照 §六 验收。

### 第 0 步：准备

1. Windows 10/11 x64 一台。**登录用户名最好与旧机相同** —— 跨用户名时旧会话日志内的路径没法重写，打开会被拒（见 §二 末尾）。
2. 装好三样：**Node 22 或更高**、**pnpm**、**Git**。
3. 从旧机带来两样东西：`backup.ps1` 产出的 `dsh-backup-<时间戳>.zip`，和两条分支的 `dsh-branches.bundle`（做法见 §五 坑 5）。
4. 定下这台服务器的**局域网 IP**（下文写作 `<IP>`），并放行防火墙 **8443** 端口（仓库里的 `fix-firewall.cmd` 会做）。

### 第 1 步：铺代码（约 15 分钟）

三个工程两个仓库，位置是**固定**的（脚本与文档都按这个布局写）：

| 工程 | 从哪来 | 分支 | 放到哪 | 怎么拿 |
|---|---|---|---|---|
| **部署仓库**（配置/插件/脚本，就是 `~\.dsh`） | `hqz-2024/dsh-plugin` | **`client-world`** | `%USERPROFILE%\.dsh` | `git clone` |
| **引擎**（deepseek-harness） | `hqz-2024/hqz-dsh` | **`hqz-dsh-0.1.6`** | `桌面\deepseek-harness` | `git clone` |
| **客户端**（dsh-desktop） | 同上那个仓库 | **`hqz-desktop-client`** | `桌面\dsh-desktop` | **`git worktree add`** —— 它不是独立仓库，是引擎仓库的第二个工作树，`.git` 是个文件，**不能单独 clone** |

```powershell
# 1) 部署仓库（配置、插件、脚本）→ %USERPROFILE%\.dsh
#    分支必须是 client-world：远端 main 是三个月前的旧状态（36 个提交）。
git clone -b client-world https://github.com/hqz-2024/dsh-plugin.git %USERPROFILE%\.dsh

# 2) 引擎本体（本部署对引擎零改动，可直接 clone）
#    分支必须是 hqz-dsh-0.1.6（= 现网跑的 0.1.6-alpha.2）；仓库里的 hqz-dsh 是 0.1.3 时代的老分支。
git clone https://github.com/hqz-2024/hqz-dsh.git -b hqz-dsh-0.1.6 C:\Users\<用户名>\Desktop\deepseek-harness

# 3) 客户端源码 = 同一个仓库的另一个分支（hqz-desktop-client），挂成第二个 worktree。
#    它的历史在引擎的 .git 里，所以不能只拷目录；clone 之后远端已有这个分支，
#    worktree add 会自动建一个跟踪它的本地分支。
cd C:\Users\<用户名>\Desktop\deepseek-harness
git worktree add ..\dsh-desktop hqz-desktop-client
```

**以后各自更新**（三个工程互不干扰，worktree 也是普通工作树，能直接 pull）：

```powershell
git -C %USERPROFILE%\.dsh pull                      # 部署仓库（client-world）
git -C C:\Users\<用户名>\Desktop\deepseek-harness pull    # 引擎
git -C C:\Users\<用户名>\Desktop\dsh-desktop pull         # 客户端（同一个 .git，worktree 分支）
```

> 旧机上若有**还没推送**的客户端提交（比如你在旧机上又改了客户端），才需要走 bundle：在旧机 `git bundle create dsh-branches.bundle hqz-desktop-client`，把 bundle 拷过来后 `git fetch <bundle 路径> 'refs/heads/*:refs/heads/*'` 再 `git worktree add`（详见 §五 坑 5）。

**做完应该看到**：`%USERPROFILE%\.dsh` 里有 `install.ps1`、`plugins\`、`profiles\`；`Desktop\` 下同时有 `deepseek-harness` 与 `dsh-desktop` 两个目录。

### 第 2 步：装运行时依赖（不含数据）

```powershell
cd %USERPROFILE%\.dsh
powershell -ExecutionPolicy Bypass -File .\install.ps1 -LanIP <IP>
```

它负责：装 `profiles\web` 的 pnpm 依赖（插件是 `link:` 依赖，这一步等于把插件挂上）、生成 `start-dsh-lan.cmd` 与 `Caddyfile`、下载 dsh-doc 运行时与 FFmpeg、必要时装 caddy 到 `bin\caddy.exe`。

**做完应该看到**：`verify.ps1` 跑完除"数据类"检查外全绿。

> **引擎要 build 一次，否则 `engine-patches` 不生效。** 部署侧的运行时补丁（`~\.dsh\engine-patches\`，现在只有一个：让"有被打断轮次"的老会话在 v2→v3 迁移时不被拒）按 `…/session-format-v1-to-v2/lib/index.js` 这个后缀命中模块 —— **只对构建产物生效**，源码启动（`tsx` 跑 `src/*.ts`）时它整段静默不生效。所以在引擎目录跑一次 `pnpm run build`（约十几分钟）；`install.ps1` 生成的启动脚本会自动优先用 `apps\cli\lib\bin.js` 并带上 `--import engine-patches\register.mjs`，没有 lib 才退回源码启动（那时会打印警告）。判据：启动后 `~\.dsh\live-0.1.6.err.log` 里应有一行 `[dsh-lan] engine patch: legacy-turn-restart applied`。

### 第 3 步：恢复数据（顺序不能反：先代码后数据）

```powershell
powershell -ExecutionPolicy Bypass -File .\migrate.ps1 -Backup <备份zip> -OldUser <旧用户名> -NewUser <新用户名>
```

它会解压备份、把文本里的绝对路径从旧用户名映射到新用户名、重命名 `sessions\` 下的变形目录名，再合并进 `~\.dsh`。

**做完应该看到**：`auth\store.json`、`auth\session-owners.json`、`storages\workspace.json`、`sessions\`、`sessions-archived\`、`.credentials.yaml`、`profiles\web\cordis.patch.yml` 全部在位。不想用脚本就照 §四 的清单手动拷。

### 第 4 步：起服务，确认门是通的

```powershell
.\start-dsh-lan.cmd
```

**做完应该看到**：服务器本机 `http://127.0.0.1:3080` 是登录页；局域网里 `https://<IP>:8443` 是同一个页面（自签证书，浏览器要确认一次例外）。

### 第 4b 步：开通「客户端世界」（要用执行器 / 机器工具 / 客户端安装包才需要）

不做这一步，服务器只有服务器模式：一切命令都在服务器上跑，客户端机器连不进来、也没有安装包可下。

1. **让启动脚本跑对 profile**：`install.ps1` 默认生成 `--profile web`（全部在服务器执行）。要用客户端世界就重跑一次并带上 `-RunProfile web-client` —— **不带这个参数会把启动脚本改回 `web`**。
2. **让这个 profile 起得来**（`profiles\web\` 与 `profiles\web-client\` 各自有自己的 `link:` 依赖）：
   - **从旧机恢复**：第 3 步的备份里已经带了 `profiles\web-client\cordis.patch.yml`（含 sidecar token 等机密），恢复后只要在 `profiles\web-client` 目录里跑一次 `pnpm install`。
   - **全新部署**：`copy profiles\web\cordis.patch.yml profiles\web-client\cordis.patch.yml`（同一批 sidecar token —— `.gitignore` 里就是这么写两者关系的），在 `profiles\web-client` 里 `pnpm install`，然后给 `- id: subprocess-dispatch` 那一行的 `config` 加一行 `machineSecret: '<随机 32 字节 hex>'`。这就是执行器的部署级密钥：它被编进分发的 exe，**轮换 = 改这一行 + 重建分发包**。
3. **开通模型网关与会话归档**（客户端本地模式要模型、要回传会话就要）：

   ```powershell
   node enable-client-features.ps1 -Profile web-client -Apply
   ```

   它按「三处齐全」一次做完：profile 的 `package.json`（`link:` 依赖 + `bundles`）、`cordis.patch.yml`（用完整 config 打开 `llm-gateway` / `archive` 两行）、门禁行的 `publicPrefixes`（客户端拿的是 token 不是会话 cookie，不放行就永远 403）。默认只打印，`-Apply` 才写，幂等。**它会打印生成的网关 token 与归档 token —— 记下来，客户端机器与桌面安装包都要用。** 线上 profile 是 `patchReload: live`，写完立刻生效。
4. **重建执行器分发包**（`plugins\dsh-subprocess-dispatch\dist\` 不进 git，含 80+ MB 的 exe）：

   ```powershell
   node build-executor-exe.mjs
   ```

   客户端机器就是从服务器的下载端点拿这个产物。构建脚本读第 2 步那个 `machineSecret` 与服务器地址并编进 exe；缺了会警告"构建出的 exe 将需要 `--secret` 才能注册"。
5. （可选）**桌面客户端安装包**：见第 5 步。

**验收**：设置 →「本地插件」里出现「桌面客户端（可选）」卡片（`$DSH_HOME\client\dist` 里真有 exe 才出现）；`GET https://<IP>:8443/auth/client-installer` 返回 **401**（处理器接管）而不是 SPA 的 HTML。

### 第 5 步：客户端（dsh-desktop）在新服务器上要改什么

**只需要改一台机器** —— 跑 `build-client.ps1` 的那台**构建机**。改的文件只有一个：`Desktop\dsh-desktop\apps\desktop\.env.windows`（**已被 git 忽略，每台机器一份**，模板是同目录的 `.env.windows.example`）。

| 设置 | 新服务器上填什么 | 为什么 |
|---|---|---|
| `DSH_DESKTOP_APP_ID` | 沿用（除非"与官方桌面端并存"的策略变了） | 安装目录、单实例锁、更新身份都按它算 |
| `DSH_DESKTOP_SERVER_MODE` | `auto` | 装完自带服务器模式；写 `none` 则不带部署 |
| `DSH_DESKTOP_SERVER_LABEL` | 想在窗口标题/徽标上显示的名字，如 `HQZ 局域网` | 纯显示 |
| `DSH_DESKTOP_SERVER_ORIGIN` | 想钉死就写 `https://<IP>:8443`；留空则打包时自动探测 | 自动探测 = 逐个候选地址问 `https://<地址>:8443/auth/me`，谁答烘谁 |
| `DSH_DESKTOP_GATEWAY` | `auto`（本地模式要模型就留着） | `none` = 完全不烘模型路由 |
| `DSH_DESKTOP_GATEWAY_TOKEN` | **新服务器的网关 token** | 客户端不带 AI key，靠这个 token 认账号/限额/入账 |
| `DSH_DESKTOP_GATEWAY_CA_FILE` | **新服务器的 caddy 根证书**：`%APPDATA%\Caddy\pki\authorities\local\root.crt` | Node 不读 Windows 证书库，缺了本地模式握手就断（坑 8） |
| `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` | `none` | 本部署没有强更策略服务 |
| `DOWNLOAD_TEST_ORIGIN` | `https://<IP>:8443` | 只为过打包校验；unsigned 构建不写进产物 |
| `DSH_DESKTOP_WINDOWS_*` | 全部留空 | 不签名 |

改完**必须重新打包并发布**（`~\.dsh\build-client.ps1`，约 15 分钟）：上面这些值都是**打包时烘进应用清单**的，换了服务器地址（坑 7）、换了网关 token、换了根证书（坑 8），旧安装包就都指向旧服务器了。发布 = 把新 exe 放进 `~\.dsh\client\dist`，设置页那张卡片立刻可用（每次请求现读目录）。

**每台客户端机器**不用改代码，二选一：

- 直接用安装包（上面烘好的一切都在里面）：设置 →「本地插件」→「桌面客户端（可选）」→ 下载 → 安装。
- 想在某一台上改指到别处，再跑一次 provisioning（`-WhatIfOnly` 先看，再去掉它执行）：

```powershell
%USERPROFILE%\.dsh\client\provision-client.ps1 -GatewayOrigin https://<IP>:8443 -GatewayToken <网关token> `
  -DesktopServerOrigin https://<IP>:8443 -DesktopLabel '<名字>' -DesktopGatewayCa <根证书.pem>
```

> **不需要改的**：客户端源码、`apps/desktop` 里的任何代码、版本号。新服务器上 `dsh-desktop` 唯一随部署变化的文件就是那份 git 忽略的 `.env.windows`。

### 第 6 步：验收

照 §六 逐条过。最容易漏的是最后两条：设置页的**客户端下载卡片**，以及客户端机器上**本地模式真跑一次任务**。

---


## 四、手动迁移清单（自动化不可用时）

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
| `.dsh\dsh-remote-files.json` | /auth/file 额外允许目录 | 建议 |
| `.dsh\.anonymous-user-id` | 匿名 ID | 建议 |
| `C:\Users\<用户名>\Desktop\finance-ws\` | 财务工作区实际文件（业务数据） | 必须 |

### 2. 配置 + 插件 + 运行时

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `.dsh\profiles\web\`（不含 node_modules） | profile 组合：`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 必须 |
| `.dsh\plugins\` | 本部署的本地插件（认证与角色 `dsh-remote-local`、文件树 `folder-tree-sh-local`、sidecar `dsh-local-bridge`、视频 `dsh-video-studio-local`、远程 `dsh-remote-local`、以及客户端世界的 `dsh-client-bindings` / `dsh-subprocess-dispatch` / `dsh-llm-gateway-local` / `dsh-archive-local`——清单见 `README.md` §11.1） | 必须 |
| `.dsh\.agent-presets\` | 7 个自定义角色预设（各自带 `skills\`，通过 `customSkillDirs` 接入）+ 279 个 agency 角色预设，共 286 个目录 | 必须 |
| `.dsh\skills\` | 全局 skill 10 个：sidecar / dsh-development / dsh-video-studio / firecrawl / adobe-illustrator-scripting / defuddle / json-canvas / obsidian-cli / obsidian-markdown / obsidian-bases（rank 400，所有预设 agent 共用） | 必须（本仓库已收录，clone 即得） |
| `%USERPROFILE%\.agents\skills\` | 同一批 skill 的第二份用户根（rank 500），让 dsh 之外的 agent（Claude Code 等）也能读到 | 建议（缺了不影响 dsh；把它当成 `.dsh\skills\` 的副本整目录拷过去即可） |
| `.dsh\runtimes\dshdoc-runtime-win32-x64\` | dsh-doc 离线 Python 运行时（openpyxl/python-docx + OCR） | 必须（或由 install.ps1 重新下载） |
| `.dsh\plugins\dsh-video-studio-local\bin\` | 内嵌 FFmpeg（ffmpeg.exe + ffprobe.exe，各约 157MB） | 建议（原样拷贝最快；install.ps1 会自动下载 + SHA256 校验） |
| `.dsh\tools\manifest-tool\` | manifest 校对工具源码（Electron 工程，不含 node_modules/dist/ffmpeg） | 必须（clone 即得） |
| `.dsh\plugins\dsh-video-studio-local\assets\` | 打包的 manifest-tool.exe（供局域网下载） | 建议（或由 install.ps1 从 GitHub Release 下载） |
| `.dsh\settings.yaml` | 默认权限 danger-full-access、模型等 | 必须 |
| `.dsh\.credentials.yaml` | API Key（**机密**） | 必须 |
| `.dsh\Caddyfile` | 反代配置 | 必须 |
| `.dsh\bin\caddy.exe` | caddy 可执行文件（或用 winget 重装后复制） | 必须 |
| `.dsh\start-dsh-lan.cmd` | 一键启动脚本 | 必须（或由 install.ps1 重新生成） |
| `.dsh\client\` | 客户端 provisioning（`provision-client.ps1`）、会话导出（`export-session.mjs`）、说明 | 必须（本仓库已收录，clone 即得） |
| `.dsh\client\dist\` | 分发给局域网用户的安装包 —— 设置页「本地插件」那张卡片送的就是这里**最新的** `.exe` | 建议（约 293 MB 且可重建：跑 `build-client.ps1`） |
| `.dsh\build-client.ps1`、`.dsh\electron-mirror-server.mjs` | 一条命令构建+发布客户端；打包用的本机 Electron 镜像服务 | 必须（本仓库已收录） |
| `.dsh\patch-client-download.mjs` | 把「桌面客户端」那张下载卡片加进设置页的幂等补丁脚本（已应用过就跳过） | 建议（留作记录） |

### 3. 程序本体

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `C:\Users\<用户名>\Desktop\deepseek-harness\`（不含 node_modules） | DSH 源码 checkout（分支 `hqz-dsh-0.1.6`，与上游 `master` 逐字一致） | 必须（或 `git clone https://github.com/hqz-2024/hqz-dsh.git -b hqz-dsh`） |
| `C:\Users\<用户名>\Desktop\dsh-desktop\` | **客户端源码 —— 同一个仓库的第二个 worktree**（分支 `hqz-desktop-client`，领先上游 `hqz-dsh-0.1.6` **14 个提交**：服务器模式与证书信任、模式徽标与切换、本地模式的模型路由、根证书信任、定时归档、发布版本号、打包默认地址与策略声明；**已在 GitHub 上**）。目录里的 `.git` 是一个**文件**，内容是 `gitdir: <引擎>\.git\worktrees\dsh-desktop` | 必须（不能只拷目录，见坑 5；新机 `git worktree add` 即可） |

---

## 五、坑（必读）

### 坑 1：引擎 checkout 是零改动的，可以干净 clone
会话隔离已从核心 `session-controller` 源码移到 `dsh-remote-local` 插件（服务层包装 `sessionController.list`），所以引擎仓库 `hqz-2024/hqz-dsh` 可以直接 `git clone -b hqz-dsh`，**无需再手工打任何源码补丁**。

### 坑 2：绝对路径被写死在很多地方
用户名 `<用户名>` 和 `C:\Users\<用户名>\...` 出现在：

| 位置 | 字段 |
|---|---|
| `storages\workspace.json` | 各工作区的 `path` |
| `sessions\` 目录名 | `--C-Users-<用户名>-Desktop-finance-ws--` 等（按工作区路径变形） |
| `profiles\web\cordis.patch.yml` | dsh-doc 的 `runtimeDir` |
| `start-dsh-lan.cmd` | `NODE`、`DSH_DIR` |

**换用户名/换盘符时**：`migrate.ps1` 会自动重映射文本路径 + 重命名会话目录；手动迁移则需全局替换 + 重命名 + 改 `runtimeDir`。想省事就**保持同名用户 + 原目录结构**。

### 坑 3：机密文件要原样、安全地拷
- `.credentials.yaml`（API Key）
- `auth\store.json`（密码哈希 + 签名密钥；session cookie 的密钥也在这里）
- `profiles\web\cordis.patch.yml` 里的 local-bridge sidecar token

丢了或改了会导致账号无法登录 / 本机桥接失效。请走可信通道拷贝，不要提交进 git。

### 坑 4：sidecar 按「账号 token」路由，迁移必须保住 token
- 每个账号一个独立 sidecar token（`profiles\web\cordis.patch.yml` 的 `local-bridge.tokens`）。
- `local_run` 按「当前会话归属账号」自动路由到该账号的 sidecar，绝不串到别的账号的机器；「本地插件」设置页只显示当前登录账号自己的 token，属正常。
- 迁移时**原样保留 token**——改了 token 会让已装好的 sidecar 全部失联，需重新给每台机器下发新 token。

### 坑 5：客户端源码是「引擎仓库的第二个 worktree」，不是一个独立仓库

本机有两个工作树共用同一个 `.git`（`C:\Users\<用户名>\Desktop\deepseek-harness\.git`）：

| 工作树 | 分支 | 是什么 |
|---|---|---|
| `Desktop\deepseek-harness` | `hqz-dsh-0.1.6` | 引擎本体（与上游 `master` 逐字一致，零改动 —— 这是铁律 1） |
| `Desktop\dsh-desktop` | `hqz-desktop-client` | 客户端：在那份引擎上加了 **14 个提交**（服务器模式与证书、模式徽标与切换、本地模式的模型路由与根证书信任、定时归档、发布版本号、打包默认地址与策略声明） |

所以 `Desktop\dsh-desktop` 里的 `.git` **是一个文件**（内容是 `gitdir: <引擎>\.git\worktrees\dsh-desktop`），只拷目录带不走历史。**两条分支都在 GitHub 上**（引擎仓库 `hqz-2024/hqz-dsh`：`hqz-dsh-0.1.6` 与 `hqz-desktop-client`），所以新机上重建就是"clone + worktree add"：

```powershell
git clone https://github.com/hqz-2024/hqz-dsh.git C:\Users\<用户名>\Desktop\deepseek-harness
cd C:\Users\<用户名>\Desktop\deepseek-harness
git worktree add ..\dsh-desktop hqz-desktop-client
```

**以后各自更新**（三个工程互不干扰，worktree 也是普通工作树，能直接 pull）：

```powershell
git -C %USERPROFILE%\.dsh pull                      # 部署仓库（client-world）
git -C C:\Users\<用户名>\Desktop\deepseek-harness pull    # 引擎
git -C C:\Users\<用户名>\Desktop\dsh-desktop pull         # 客户端（同一个 .git，worktree 分支）
```

旧机上如果有**还没推送**的提交（例如你刚在旧机改了客户端），在那台机器上补一次推送就行；确实要离线搬时用 bundle：`git bundle create dsh-branches.bundle hqz-dsh-0.1.6 hqz-desktop-client`，到新机 `git fetch <bundle 路径> 'refs/heads/*:refs/heads/*'` 再 `git worktree add`。

**为什么客户端不单独开一个仓库**：它不是独立项目，而是引擎仓库在某个基线上加的 14 个提交 —— 单独开仓要么把整段引擎历史（本地对象库约 194 MB）复制一份，要么丢掉历史变成不可合并的快照；而挂在引擎仓库里只要 **2.45 MB**（基座 `hqz-dsh-0.1.6` 已在远端），新机器一次 clone 就同时拿到引擎与客户端。

`dsh-desktop` 第一次使用要先 `pnpm install`（`node_modules` 不在 git 里），完整构建约 15 分钟。

### 坑 6：打包要本机 Electron 镜像，而且**打包期间不要动 git**

1. `prepare:runtime` 从 GitHub release 拉 150 MB 的 `electron-v44.0.0-win32-x64.zip`，在这条线路上**稳定卡死在 0 字节**（多次复现：两次超时、一次 `fetch failed`）。绕法是本机镜像：`electron-mirror-server.mjs` + `ELECTRON_MIRROR=http://127.0.0.1:8791/`，镜像目录布局必须是 `<root>\v44.0.0\{electron-v44.0.0-win32-x64.zip, SHASUMS256.txt}`（`@electron/get` 的 `customDir` 默认是 `v<版本>`），其中 `SHASUMS256.txt` 用**上游原文**、zip 用 `%LOCALAPPDATA%\electron\Cache\` 里那份已核对过哈希的。`build-client.ps1` 已把这一整套包好，正常不用手做。
2. 客户端构建把 `DSH_CLIENT_COMMIT_HASH` 记进构件记录，`release:pack` 再读出来比对 —— **跑到一半提交 git 会让打包中止**（`client build environment differs from the required artifact profile: DSH_CLIENT_COMMIT_HASH`）。先提交完，再开跑。

### 坑 7：安装包里的部署地址是**打包时**烘进去的

`DSH_DESKTOP_SERVER_MODE=auto`（`apps/desktop/.env.windows`）时，打包会探测本机哪个地址真的在跑 dsh —— 逐个候选请求 `https://<地址>:8443/auth/me`，谁答就把谁写进应用清单的 `dshDesktopServerMode`。客户端装完就自带服务器模式、不需要任何配置。**所以换了服务器地址或网段，必须重新打包（`build-client.ps1`）并重新发布**，否则老安装包的服务器模式还指着旧地址。单台机器可以不改包：在它的 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop-client.json` 写 `{ "server": { "origin": "https://新地址:8443", "label": "…" } }`（用户文件优先于清单默认值），或设环境变量 `DSH_DESKTOP_SERVER_MODE`。

### 坑 8：根证书也是**打包时**烘进去的（Node 不读 Windows 证书库）

部署的 TLS 终结器（caddy）自签，而客户端**本地模式下的模型请求由一个独立的 Node 进程发出**（`Host`），外壳窗口里那套"接受自签证书"管不到它；Node 又完全不读 Windows 证书库，所以没有根证书时请求在握手就断，界面上的表现是 `失败原因：DeepSeek API request to https://<地址>:8443/llm/v1 failed`。因此打包时把**根证书**（`apps/desktop/.env.windows` 里的 `DSH_DESKTOP_GATEWAY_CA_FILE`，指 `%APPDATA%\Caddy\pki\authorities\local\root.crt`）一并烘进应用清单的 `dshDesktopGateway.certificateAuthority`，客户端首次启动写成 `%USERPROFILE%\.dsh\profiles\desktop\gateway-ca.crt`，外壳把它作为 `NODE_EXTRA_CA_CERTS` 交给本地 Host 与归档脚本。**后果与坑 7 相同**：换了终结器/重建了 caddy 的 PKI（根证书变了）就要**重新打包并重新发布**；单台机器可以不改包，用 `client\provision-client.ps1 -DesktopGatewayCa <新根证书.pem>` 把新根证书放进同一个位置。要**根证书**不要叶子证书 —— 叶子证书每次续期都换，根证书不变。

**发布即覆盖**：安装包文件名每次构建都一样（`deepseek-harness-<版本>-win-x64.exe`），新构建直接覆盖 `$DSH_HOME\client\dist` 里的旧文件，设置页那张卡片显示的名字与大小几乎不变 —— **客户端必须重新下载**，要确认拿到的是哪一次构建就用 `Get-FileHash … -Algorithm SHA256` 对 `docs\memory.md`"交付物"里记的哈希。

---

## 六、验证清单

1. 能登录 `admin`（迁移后 `auth\store.json` 原样生效，账号/密码/TOTP 都跟着走）。
2. 角色账号（如 `Finance-mgr`）能登录，且**只看到自己工作区的会话**，看不到别人的。账号由 admin 在设置页创建，名字必须与 `cordis.patch.yml` 的 roleMap 键**完全一致**（区分大小写）才生效。
3. 文件树全操作正常：新建文件、新建文件夹、重命名、复制、粘贴（剪切）、删除、上传、编辑保存、Excel 保存。
4. 上传 docx / xlsx 能正常预览（验证 dsh-doc 运行时）。
5. admin 能打开用量面板（admin-only）。
6. 每台用户机 sidecar 能连上，`local_run` 能驱动用户本机。
7. 安全门禁：非 admin 调 `session.search` / `session.export` 返回 403；`session.follow` 拉取他人会话被断连。
8. 预设与 skill 就位：`.agent-presets\` 286 个目录、`skills\` 10 个 skill——直接跑 `verify.ps1`，全绿即可。
9. **客户端下载卡片在**：设置 →「本地插件」里应当有「桌面客户端（可选）」一张卡，点「下载」能拿到 `deepseek-harness-<版本>-win-x64.exe`。**不用登录的判据**：`GET https://<服务器>:8443/auth/client-installer` 返回 **401**（处理器接管）而不是 200 + SPA 的 HTML；若是后者，说明插件还是旧代码，**整进程重启**即可。
10. **模型网关通**：`GET https://<服务器>:8443/llm/v1/models`，带 `Authorization: Bearer <网关 token>` → 200 且列出模型；不带 token → 403。
11. **归档端通**：`POST https://<服务器>:8443/archive/v1/sessions` 带归档 token 与空 body → **400 且错误文本是 `archive body must carry sessionId`**（处理器自己的文本 = 已过门禁；没有文本的 403 才是被门禁拦）。
12. **客户端装机**：在客户端机器上跑 `provision-client.ps1`（`-WhatIfOnly` 先看）→ 启动应用 → 本地模式能跑一次真实任务（说明网关与 token 都对）。

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | 防火墙未放行 8443；或 IP 变了没改 `Caddyfile`/脚本 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 `root.crt` |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| 登录后看不到自己的历史会话 | `auth\session-owners.json` 或 `storages\workspace.json` 没恢复；或会话目录与 workspace.json 路径不一致（坑 2） |
| 文件树写操作 `forbidden` / `signal time out` | 插件 fork 没装全，或 `profiles\web` 的 `pnpm install` 没重建 link 依赖 |
| 文档预览失败 | `runtimes\dshdoc-runtime-win32-x64` 缺失，或 `cordis.patch.yml` 的 `runtimeDir` 路径不对 |
| 打开旧会话被拒 "session outside your workspace" | 跨用户名迁移导致会话日志 cwd 与新工作区路径不一致（见「二」的跨用户名限制） |
| 设置页「本地插件」里没有「桌面客户端」那张卡 | `$DSH_HOME\client\dist` 里没有 `.exe`（目录里没有文件时这张卡整个不出现，这是刻意的），或插件还是旧代码（判据见验证清单第 9 条） |
| 客户端服务器模式连的是旧地址 | 安装包里的地址是打包时烘的（坑 7）：重新打包发布，或在单台机器的 `desktop-client.json` 里改指 |
| 客户端本地模式没有模型可选 | 那台机器既没有安装包烘的模型路由、也没跑 provisioning（`profiles\desktop\cordis.patch.yml` 与 `.credentials.yaml` 都没有），或网关 token 已吊销 |
| 客户端本地模式报 `失败原因：DeepSeek API request to https://…/llm/v1 failed` | 十有八九是**根证书没到位**（坑 8）：Node 不读 Windows 证书库。先看 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop.log` 里有没有 `trusting …\profiles\desktop\gateway-ca.crt`，再看那个文件在不在；缺了就重新打包（把 `DSH_DESKTOP_GATEWAY_CA_FILE` 指对）或在单台机器上 `provision-client.ps1 -DesktopGatewayCa <根证书.pem>` |
| 客户端文件树顶部按钮被裁（老版本） | 插件 fork 的顶部工具行原先是一行十项、容器又 `overflow:hidden`：面板窄时「刷新/上传/传文件夹」会被裁掉。本仓库的 `folder-tree-sh-local` 已改成两行自适应换行（2026-09-22），迁移时确认 `plugins\folder-tree-sh-local\lib\client.js` 是最新的 |
| 打包在 `prepare:runtime` 卡住不动（0 字节） | GitHub 上那份 150 MB 的 electron zip 拉不动（坑 6）：用 `build-client.ps1`，或手工起 `electron-mirror-server.mjs` 并设 `ELECTRON_MIRROR` |
| 打包报 `client build environment differs … DSH_CLIENT_COMMIT_HASH` | 打包期间仓库被改动了（坑 6）：提交完再重跑 |

### 手工启动命令（不用脚本时）
```powershell
# 终端 1：caddy
%USERPROFILE%\.dsh\bin\caddy.exe run --config %USERPROFILE%\.dsh\Caddyfile

# 终端 2：dsh（在 checkout 目录）
cd C:\Users\<用户名>\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host <局域网IP>
```
