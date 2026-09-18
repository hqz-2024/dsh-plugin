# 记忆：当前状态、决策记录与下一步

> **这份文件是"现在是什么状态、下一步做什么"的唯一入口。** 每次重要变更后更新它（改完顺手把"最后更新"时间改掉）。
> 细节分流：实现与验收证据 → `docs/plan-client-world-progress.md`；两条路线的完整评估 → `docs/plan-two-paths.md`；用户手册 → `README.md`；铁律与实现级陷阱 → `AGENTS.md`。
>
> 最后更新：**2026-09-18 10:40（+08:00）**（用户拍板了计划 B 的四项配置，见 §6）

---

## 0. 一分钟版

- 部署在 `~/.dsh`，公开仓库 `github.com/hqz-2024/dsh-plugin`。
- 工作分支是 **`client-world`**；`main` = `origin/main` = `73ad10f`（**不要再往 main 提交**）。
- 线上实例（3080，profile `web-client`）**已于 2026-09-17 17:45 重启**，`machine_list` / `machine_run` 已注册可用（`profiles/web-client/dispatch-trace.jsonl` 里有 `machine-tools-registered`）。
- 服务端工作区、文件树上传下载、权限、管理台、浏览器直接用服务端 agent —— **全部照旧可用**。
- **下一步：执行 `docs/plan-two-paths.md` 的计划 B（双模式客户端应用），先做阶段 0（打包 spike）与阶段 1（模型网关 + 客户端 profile）。**
- 执行器分发包已按最新源码重建：`plugins/dsh-subprocess-dispatch/dist/{dsh-executor.exe,dsh-executor.zip}`（gitignored，可重建）。

---

## 1. 仓库与分支

| 项 | 值 |
|---|---|
| 部署仓库 | `~/.dsh`（`%USERPROFILE%\.dsh`），远端 `https://github.com/hqz-2024/dsh-plugin.git`（**公开**） |
| 工作分支 | `client-world`，HEAD = `910dca5`，领先 `main` **76 个提交** |
| `main` | `73ad10f`，与 `origin/main` 一致（那 76 个提交**从未推送**） |
| 工作区 | 只有两处历史遗留改动：`backup.ps1` / `migrate.ps1` 的 BOM |
| 引擎 checkout | `C:\Users\bestarc\Desktop\deepseek-harness`，分支 `hqz-dsh`，**零改动铁律**（只有 `README.zh.md` 一处早期未提交改动） |

**分支纪律**：所有改动提交到 `client-world`；除非用户明确要求，不推送、不合并、不动 `main`。

---

## 2. 线上与验证环境

| 环境 | 位置 | 用途 |
|---|---|---|
| 线上 | 3080（`node --import tsx/esm apps/cli/src/bin.ts --profile web-client --trusted-host 192.168.28.239`）+ caddy 8443 | 用户正在用；**重启 3080 会切断用户当前对话**（这个会话本身跑在它上面）→ 要重启先征得同意 |
| `pilot-auth` | home `.dsh-pilot-auth`，端口 3084 | 主验证环境：挂了 `dsh-subprocess-probe`（分派冒烟）与 `dsh-machine-probe`（机器工具） |
| `pilot` / `web-client` | `.dsh-pilot`(3082) / `.dsh-web-client`(3086) | 最小组合 / 真实 web 组合 |
| 诊断产物 | `profiles/<name>/{dispatch-trace.jsonl,probe-result.jsonl,machine-probe.jsonl}` | 分派决策 / 冒烟步骤 / 机器工具步骤 |

验证心法（详见 `AGENTS.md` §五）：**断言要落在"只有那台机器/那个进程才能产生的事实"上**；同机跑通不等于跨机跑通。

---

## 3. 已完成且已验证

| 能力 | 证据 |
|---|---|
| `machine_list` / `machine_run`（指名机器执行、超时杀进程树、执行器自报主目录/登录用户） | `plugins/dsh-machine-probe` 六步全过；含"超时后那台机器上不留残进程"与"环境变量标记只有执行器进程才有"两条硬判据 |
| 执行器（SEA 单文件 exe + 旁挂 node-pty、部署密钥注册、machineId 寻址、状态页、`--self-test`、分发端点） | `build-executor-exe.mjs`；本轮新增 `hello` 带 `home`/`user`，`cwd` 缺省＝该机器用户主目录 |
| 打包 exe「每结束一个终端就多出一个执行器」缺陷的修复 | `check-conpty-agent-fork.mjs`（精确复刻 node-pty 的 fork）+ 进程监视器：修前 `n=2/3`、修后整轮 `n=1`；`terminal-python-repl` 由 ❌ 转 ✅ |
| 工作区共享／绑定的 Web UI 入口撤除 | `7fa2e08`；路由层代码仍在、绑定存储仍在（恢复步骤见 `README.md`） |
| 机密体检 | `check-secret-leak.mjs`：AI key、machineSecret、relay token、Figma token 在**已推送历史**与本地历史里均 0 命中 |

---

## 4. 这次对话定下来的事（决策记录）

| 决定 | 内容 |
|---|---|
| 退休共享与绑定 | 只保留 executor；路由/绑定代码留着但不再有入口（用户："这个功能不行，问题太多了"） |
| 用机器工具替代绑定 | agent 直接指名机器执行命令；**不绑定、不共享**（用户："agent 直接通过 executor 插件控制不可以吗？"） |
| 「完全操作客户端电脑」缺什么 | 五类：文件双向搬运、长任务/后台、交互式终端、看屏幕、本机服务；另有权限/审计/提示词层 |
| 客户端安装成本 | 用户接受"装一个包、工具一次装完"的路线；但**新能力必须只用 Node 内置能力 + Windows 自带组件，不引入新原生模块、不要求客户端装 node/npm/winget/pip** |
| 计划 B 的形态 | **一个窗口两种模式**：服务器模式＝现有 Web UI 搬进来（数据留在服务器工作区）；本地模式＝本地 agent + 本地工具（对话本地缓存并定时同步到服务器；文件由用户经文件树手动上传） |
| 计划 B 的重心 | 服务端**只新增模型网关**；工作区/文件/权限/上传下载/会话浏览全部复用现有能力 |
| 计划 A 的处置 | **暂缓**：本地模式天然覆盖它的大部分动机；只有"给没装客户端的机器操作用户电脑"或"服务器模式要驱动本机软件"时才回头做 |
| SMB 密码遗留 | 本地历史里有（`bf92f35`…`8ca9a4a`），**未上 GitHub**；用户已决定**暂不处理** |

---

## 5. 计划 B 的第一批任务（准备开工）

### 阶段 0：打包可行性 spike（半天～1 天）

**问题**：`dsh web` 能不能打成一份可分发的东西，体积和启动时间是多少？

- 要带的东西：dsh CLI + 引擎包（lib）+ 前端资源 + Node 运行时 + node-pty。
  **前端外壳不是独立应用** —— 只有 `dsh web` 会注入 `window.__DSH_BOOT__`，所以客户端必须跑自己的 `dsh web`。
- 两条路都要量：① 单文件（SEA，像执行器那样）；② 目录分发（安装器只负责摆放）。**SEA 对动态 import/资源加载的限制未验证**，这是本阶段要回答的核心风险。
- **可证伪的判据**（三条都要）：
  1. 本地起 `dsh web`（回环 + 一次性 token），浏览器能开会话、能聊一句；
  2. 让 agent 跑一条 `pwsh` 命令，**子进程自报的 hostname/cwd 证明命令真的在本机执行**；
  3. 把 `llm` 指向一个**假网关端点**，确认请求真的打过去（假端点打印请求体）。

#### 阶段 0 进展（2026-09-18，已测到的数字与坑）

| 观察 | 数字 / 结论 |
|---|---|
| `apps/web/dist`（前端产物） | 12.3 MB，`index.html` + `assets/` |
| 工作区 `node_modules` | **2.2 GB**（开发用的 pnpm store，不能直接分发） |
| `packages/`（源码 + lib） | 94.6 MB |
| `pnpm --filter @deepseek-ai/dsh deploy --prod --legacy <dir>` | 产出 **242 MB**，但 **CLI 起不来**：`Cannot find package '@deepseek-ai/cordis-plugin-group'` —— 该包是 `dsh-app-boot` 的 **peerDependency**，住在 `vendor/group`，`--prod` 部署不带 peer |
| 前端产物在部署树里的位置 | `node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@…/dist/` —— **跟着 web-frontend 包走，不用另外拷** |
| 引擎自带的发布流水线 | `pnpm run release:pack --family <dsh\|vendor> --out <dir>` + `release:verify-packed-install --from <dir>…`：把整个家族打成 tarball，再在临时消费者目录里**用普通 Node** 装起来跑 —— 这正是客户端分发要的形状 |
| 打包闸门 | `release:pack` 会校验客户端产物的**构建环境**：必须是用 official profile 构建的（`DSH_CLIENT_BUILD_PROFILE=official` + `DSH_CLIENT_TITLE='DeepSeek Harness'`），否则报 "client build environment differs"。支持的命令：`pnpm run build:official` |
| 构建产物是否弄脏引擎 checkout | 不会：`apps/web/dist/`、`lib/`、`.dsh-build/` 都在 `.gitignore` 里 |

**当前结论**：**放弃 `pnpm deploy` 这条捷径**，走引擎自己的 `release:pack`（vendor + dsh 两个家族）+ 消费者安装。下一步：`pnpm run build:official` → 两个家族各 pack 一次 → 装进临时消费者 → 量体积/启动时间 → 跑那三条判据。**估计全量包最终落在 500–600MB 档**（引擎 242MB+ + Electron ~150–200MB + ffmpeg 157MB）。

### 阶段 1：模型网关 + 客户端 profile（1～1.5 天）

- 服务端新插件（host 行，和 `dsh-remote-local` 并列、挂同一个门禁后）：
  `POST /llm/v1/chat/completions`（SSE）+ `GET /llm/v1/models`；按**用户 token** 认证，转发到真 AI 接口；**密钥只在服务器**。
  必须做进去：流式取消贯穿（客户端断开 → 立刻 abort 上游）、用量入账、每用户额度与并发上限、模型白名单、上游错误映射。
- 客户端 profile：base + web-app + 本地工具 + `llm` 指向网关；**不带任何 key**，不给模型选择界面；**默认全权限**（用户已定）。
- 判据：一次真实对话走通（工具在本地执行 + 模型在服务器）；网关侧能看到用量；中途关掉页面时上游连接被 abort。

### 阶段 2：Electron 外壳（双模式；用户已定用 Electron）

- 主进程拉起本地 `dsh web`（随机回环端口 + 一次性 token），BrowserWindow 承载两个 URL：服务器模式 `https://<服务器>:8443`、本地模式 `http://127.0.0.1:<port>/?token=…`；模式切换＝换 URL。
- 证书：Chromium 的证书校验钩子只信任这一张，或把根证书装进当前用户证书库（不需要管理员）。凭据走 Electron `safeStorage`（DPAPI）；单实例锁；**两个模式必须一眼可分**。

### 阶段 3：归档流水线（用户 2026-09-18 新增要求）

`本地会话 → 归档成文档 → 按账号上传到服务器 → 服务器用 AI 精简 → 写进 Obsidian`

- 客户端侧：定时/退出时导出会话（Markdown/JSON），带账号与机器标识上传（复用服务器已有的上传通道或新开一个小端点）。
- 服务端侧：按账号落盘 → 触发一次精简（LLM）→ 生成结构化笔记写进 vault（frontmatter + 标签，遵循全局 skill `obsidian-markdown` 的写法）。
- **待查**：服务器上 Obsidian vault 的位置与是否存在；精简是用哪条模型路由（应当就是本部署的 `deepseek-flash`）与触发方式（上传即触发 / 定时批量）。

---

## 6. 已定（2026-09-18 用户拍板）

| 项 | 决定 | 由此产生的后果 |
|---|---|---|
| 本地会话同步 | **归档成文档**，**按账号**上传到服务器 | 无会话格式版本耦合（不选"服务器上可读的只读会话"）。上传目的地在服务器上是"按账号一个目录" |
| 归档之后的处理 | **服务器用 AI 精简内容，写进 Obsidian** | 新增一条服务端流水线（上传 → 精简 → 落进 vault）。需要先确认 vault 在哪、是否存在 |
| 安装包 | **全量包** | 安装器把 ffmpeg 等重家伙一并装进去；安装包与每次更新的体积按 300–600MB 档准备，spike 要量的是**全量**后的数字 |
| 外壳 | **Electron** | 阶段 2 的外壳工作固定：主进程拉起本地 `dsh web`，BrowserWindow 承载两个模式的 URL；证书用 Chromium 的校验钩子或装根证书；凭据走 Electron `safeStorage`（DPAPI） |
| 本地模式默认权限 | **全权限**（`danger-full-access`） | 本地 profile 直接设全权限、无审批；代价是 agent 在客户端以该 Windows 用户身份无阻拦操作 —— 要在安装时向用户说明 |

---

## 7. 已知陷阱（`AGENTS.md` §四之外的补充）

- **git**：`git grep` 无命中时退出码是 1（别当成错误）；以 `-` 开头的模式必须用 `-e` 传；`git stash pop` 会把文件写成 **CRLF**，提交前要转回 LF（`.gitattributes` 是 `eol=lf`）。
- **本机命令**：`Get-CimInstance Win32_Process | Where CommandLine -match 'executor'` 会**杀掉自己的 pwsh**（它的命令行里也含这个词）—— 过滤必须带 `Name=`；pwsh 里 .NET 文件 API 按**进程 cwd** 解析，必须用绝对路径；`Start-Process -RedirectStandard*` 在本 harness 下会 `spawn EPERM`。
- **客户端 shell**：`machine_run` 的 `command` 走 Windows 自带的 `powershell.exe` 5.1（不是 pwsh 7），已强制 UTF-8 控制台编码；客户端的 glob/grep 若要做，用执行器里的 Node 实现，**不要依赖 ripgrep**。
- 引擎与部署的实现级坑（SEA 会"fork 自己"、`hello` 事实只有那台机器知道、`DSH_` 前缀会被清洗、同机测试的证伪力）见 `AGENTS.md` §四。

---

## 8. 不做 / 已放弃（避免重复提议）

- **工作区共享与绑定的界面入口**：2026-09-17 撤除（恢复步骤写在 `README.md`）。
- **计划 A 的 P0（文件/stdin/后台任务）**：计划 B 落地前不做。
- **客户端里再走一遍"执行器 + 机器工具"**：本地模式不需要它；执行器只为"没装客户端的机器"和"服务器工作区 + 本机软件"保留。
