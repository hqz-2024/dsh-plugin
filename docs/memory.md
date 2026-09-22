# 记忆：当前状态、决策记录与下一步

> **这份文件是"现在是什么状态、下一步做什么"的唯一入口。** 每次重要变更后更新它（改完顺手把"最后更新"时间改掉）。
> 细节分流：实现与验收证据 → `docs/plan-client-world-progress.md`；两条路线的完整评估 → `docs/plan-two-paths.md`；用户手册 → `README.md`；铁律与实现级陷阱 → `AGENTS.md`。
>
> 最后更新：**2026-09-21 14:45（+08:00）**（线上已开通模型网关与会话归档；客户端安装包版本确定为 `0.1.6-alpha.2.20260921.1`）

---

## 0. 一分钟版

- 部署在 `~/.dsh`，公开仓库 `github.com/hqz-2024/dsh-plugin`。
- 工作分支是 **`client-world`**；`main` = `origin/main` = `73ad10f`（**不要再往 main 提交**）。
- 线上实例（3080，profile `web-client`）跑 `dsh-v0.1.6-alpha.2` 构建产物。
  **2026-09-21 已开通模型网关与会话归档端**（`enable-client-features.ps1 -Apply`），
  **没有重启**——两条链路实测 200 / 400（处理器原话），`/`、`/api`、`/client-auth` 原样。
  坑与判读见 `docs/plan-two-paths.md §3.3` 与 §3.3.1。
- **阶段 2、阶段 3 完成**（双模式客户端外壳 + 会话归档流水线，都已真机验证）；
  桌面端在独立工作树 `Desktop\dsh-desktop`（分支 `hqz-desktop-client`），引擎 checkout 零改动。
- **阶段 4**：客户端安装包版本已由用户确认为 **`0.1.6-alpha.2.20260921.1`**，
  `pnpm run package:desktop:win:x64:unsigned` 已启动。**自更新不做**（用户已定）——
  它需要 EV 代码签名证书，unsigned 构建构造上不带更新面（见 §4.2）。
- 客户端上机：`client\provision-client.ps1` 写模型端点、两个 token、归档地址；
  归档由桌面端定时自动跑（`plan-two-paths.md §3.4`）。

---

## 1. 仓库与分支

| 项 | 值 |
|---|---|
| 部署仓库 | `~/.dsh`（`%USERPROFILE%\.dsh`），远端 `https://github.com/hqz-2024/dsh-plugin.git`（**公开**） |
| 工作分支 | `client-world`，HEAD = `2546f28`，领先 `main` **103 个提交**，**2026-09-22 已推送到 `origin/client-world`** |
| `main` | `73ad10f`，与 `origin/main` 一致（**没有动过**；`client-world` 是独立分支） |
| 工作区 | 干净（运行时台账与一次性诊断产物已在 `.gitignore` 里：`profiles/*/llm-gateway-usage.jsonl`、`cutover-report.txt`、`module-identity-report.json`） |
| 引擎 checkout | `C:\Users\bestarc\Desktop\deepseek-harness`，分支 `hqz-dsh`，**零改动铁律**（只有 `README.zh.md` 一处早期未提交改动） |
| 客户端 worktree | `C:\Users\bestarc\Desktop\dsh-desktop`，分支 `hqz-desktop-client`（14 个提交，2.45 MB）—— **2026-09-22 已推送到 `hqz-2024/hqz-dsh`**（remote 名是 `mine`；引擎仓库现有 `master`/`hqz-dsh`/`hqz-dsh-0.1.6`/`hqz-desktop-client` 四条分支，前三条未被改动）。**没有**用 `hqz-2024/hqz-dsh-desktop`：那个仓库仍是空的 —— 客户端不是独立项目，单独开仓要复制整段引擎历史（约 194 MB）或丢历史，挂在引擎仓库只要 2.45 MB，且新机一次 clone 就同时拿到引擎与客户端 |

**分支纪律**：所有改动提交到 `client-world`；除非用户明确要求，不推送、不合并、不动 `main`。

**2026-09-22 首次推送（用户明确要求）**：推之前跑了 `check-secret-leak.mjs`，三项金丝雀（AI key / machineSecret / relay token）与 `sk-` 扫描在两边历史里都 0 命中；**但 `setup-smb.ps1` 的历史版本里有一个真 SMB 口令**（7 个待推送提交的树里都有它，一推就永久公开）—— 用 `git filter-branch --index-filter` 把历史里那一行的默认值清空（内容其余不变，`refs/original/` 留着可回退），清完 0 命中且远端分支同样为 0。**那个口令仍建议轮换**：它曾存在于本地历史，且对真实账号 `dshtest` 有效（脚本现在留空即随机生成）；轮换会打断正在用旧口令的共享挂载，所以听用户的时机。第一次 `git push` 报 `schannel: failed to receive handshake` 是代理节点瞬时抖动，重试即成功（git 走的是 `http://127.0.0.1:7897`，`verge-mihomo`）。

**从 GitHub 部署的齐全性体检（2026-09-22，用户问"资料齐不齐、能不能照步骤装"）**：仓库侧齐全 —— 全部部署脚本（`install/backup/migrate/verify` 各有 .ps1 与 .sh、`fix-firewall.cmd`、`build-client.ps1`、`electron-mirror-server.mjs`、`client\provision-client.ps1`、`client\export-session.mjs`、`build-executor-exe.mjs`、`enable-client-features.ps1`）、10 个插件、286 个预设（590 文件）、11 个 skill 目录、两套 profile（含各自的 `cordis.patch.example.yml` 脱敏模板）、`tools\manifest-tool`。按设计不在仓库里的是：机密（`.credentials.yaml`/`auth/`/`profiles/web*/cordis.patch.yml` → 走备份包或由脚本生成）、数据（sessions/storages/attachments → 备份包）、机器相关（Caddyfile、启动脚本 → `install.ps1` 生成）、大件（caddy、dsh-doc 运行时、FFmpeg、`client\dist` 的 293 MB 安装包、执行器 dist → 脚本下载/重建）。**查出并修掉三处会真挡住部署的问题**：① 6 个 `.ps1`（含 `install.ps1`/`backup.ps1`/`migrate.ps1`）带中文却没有 BOM → **Windows PowerShell 5.1 下直接 `Unexpected token` 解析失败**（实测），已补齐 BOM 并逐个复验；② `install.ps1` 的插件清单写死五个名字（含一个已删除的），漏掉 5 个新插件 → 改成按 `plugins\` 目录推导；③ 客户端世界的开通步骤原本没写进迁移文档 → `MIGRATION.md` 新增「第 4b 步」。**唯一未闭合的缺口**：客户端源码分支 `hqz-desktop-client` 只在本地，第 1 步仍需旧机的 bundle（推它只要 2.45 MB，且基座 `hqz-dsh-0.1.6` 已在远端）—— 已问用户是否要推。

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
| **桌面客户端本地模式真能干活（2026-09-22，用户实测确认）** | 装 15:45 那次构建（SHA-256 `1A710218…DEF40`）后，客户端机器上本地模式能正常连上模型 —— 用户原话"本地模式能正常连上模型了"。三个前置修复：路由写进 profile 补丁层、`agent-default-model` 钉住网关公布的 id、**部署根证书随包烘入并作为 `NODE_EXTRA_CA_CERTS` 交给本地 Host**（见 §5 客户端分发第 4/5 条、§7 第 5 条） |
| 文件树顶部工具行不再被裁（2026-09-22） | `plugins/folder-tree-sh-local/lib/client.js`：顶栏由一行十项改为两行自适应换行；顺带修掉右键菜单「刷新」只切视图的老毛病。同一 bundle 的 HMR 会重发，刷新页面即生效 |

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

#### 阶段 0 结论（2026-09-18，**已完成**：可行，走目录分发）

**三条判据全部通过**（证据在 `%TEMP%\dsh-client-spike\`，保留着给阶段 1 复用）：

| 判据 | 结果 |
|---|---|
| ① 打包树自己能起 web、界面可用 | `dsh web` **1.3 秒**起监听；带 token 的首页 **200 / 24.8 KB / 含 `window.__DSH_BOOT__`**；前端 JS（441 KB）也 200 |
| ② 本地工具真的在本地执行 | 一次性任务里 agent 调 `pwsh`，工具回执是 `SPIKE-TOOL-OK DESKTOP-LCLS51R C:\…\consumer`（**机器名 + 工作目录**，只有本机进程能报出来） |
| ③ 模型请求真的打到配置的网关 | 本地假网关（OpenAI 兼容 SSE）收到 **3 个请求**（models 探测 + 2 次 chat），并把工具回执读了出来 |

**做法（可复用）**：隔离副本里 `pnpm run build:official`（需要 `DSH_CLIENT_COMMIT_HASH`/`DSH_CLIENT_VERSION`）→ 逐包 `pnpm pack`（vendor 9 个 + dsh 248 个 = 7.7 MB tarball）→ 用 npm 装进消费者目录（`--legacy-peer-deps`）→ 用普通 Node 跑 `dsh web` / 一次性任务。**Electron 已定的前提下不需要单文件 SEA，目录分发就是答案。**

**体积（阶段 4 要处理的头号问题）**：

| 观察 | 数字 |
|---|---|
| 完整 npm 闭包 | **1059 MB** —— 其中 `@openai` **373 MB**、`@anthropic-ai` **330 MB**（外部 agent CLI，客户端根本用不到）、`@img` 27、node-pty 27、typescript 23、opentelemetry 20、rolldown 20 |
| tarball 本身 | 7.7 MB（JS 很轻，重的是外部依赖） |
| `pnpm deploy --prod --legacy` | 242 MB，但**缺 peer，CLI 起不来**（`@deepseek-ai/cordis-plugin-group` 是 `dsh-app-boot` 的 peer，住在 `vendor/group`）→ 这条路放弃 |
| 前端产物 | 12.3 MB，**随 `@deepseek-ai/dsh-web-frontend` 包分发**，不用另外拷 |
| 工作区 `node_modules` | 2.2 GB（开发 store，不可分发） |

→ **客户端必须裁剪依赖集**：先查清是谁把 `@openai`/`@anthropic-ai` 拉进来的（大概率是外接 CLI 的 subagent 后端），再看能不能从客户端装包里排除。**目标：引擎部分压到 300 MB 以内**，加上 Electron 与 ffmpeg 才是"全量包"。

**本轮踩到的坑（下次直接用）**：

1. 引擎自带的 `release:pack` **在 Windows 上跑不起来**：它内部 `spawn('pnpm', …)`，而 pnpm 是 `.cmd` 垫片，Node 不带 shell 解析不了 → `spawn pnpm ENOENT`。绕法：按同样语义逐包经 shell 打包（`pack-family.mjs`）。
2. `npm` / `pnpm` 都是 `.cmd`：Node 里要么 `shell: true`，要么直接 `node <node_modules\npm\bin\npm-cli.js>`。
3. npm 安装打包家族需要 `--legacy-peer-deps`（树里混着 `0.1.3-alpha.1` 与 `alpha.2`）。
4. 打包闸门要求产物是 **official profile** 构建的；构建要放在**副本**里做（`copy-tree.mjs`：源码复制 + `node_modules` 走 junction），否则会重写**线上正在服务**的 `apps/web/dist` 与各包 `client.js`。
5. 客户端 profile 只需要写 `bundles`（`@deepseek-ai/dsh-base` 等），bundle 从**安装树**解析 —— 这就是"装完即用"的形状。

### 阶段 1：模型网关 + 客户端 profile（1～1.5 天）

- 服务端新插件（host 行，和 `dsh-remote-local` 并列、挂同一个门禁后）：
  `POST /llm/v1/chat/completions`（SSE）+ `GET /llm/v1/models`；按**用户 token** 认证，转发到真 AI 接口；**密钥只在服务器**。
  必须做进去：流式取消贯穿（客户端断开 → 立刻 abort 上游）、用量入账、每用户额度与并发上限、模型白名单、上游错误映射。
- 客户端 profile：base + web-app + 本地工具 + `llm` 指向网关；**不带任何 key**，不给模型选择界面；**默认全权限**（用户已定）。
- 判据：一次真实对话走通（工具在本地执行 + 模型在服务器）；网关侧能看到用量；中途关掉页面时上游连接被 abort。

#### 阶段 1 结论（2026-09-18，**已完成**：网关可用，真实模型跑通）

新插件 **`plugins/dsh-llm-gateway-local/`**（host 行 `llm-gateway`，插进 profile 时默认 `disabled: true`）：`POST <path>/v1/chat/completions`（流式/非流式）+ `GET <path>/v1/models`，按 **Bearer 网关 token** 认证，带部署的凭据转发到真 AI 接口。已验证（全部在 `pilot-auth`，3084）：

| 项 | 证据 |
|---|---|
| 认证 | 无 token → **401**（网关自己的文本，不是门禁的 403）；带 token → 200 |
| 封闭模型清单 | `/v1/models` 只返回配置里的两个；请求白名单外的模型 → **404** |
| 真实上游 | 200 + 真模型回答；**流式** 27 个 SSE 事件字节级透传 |
| 用量入账 | `profiles/pilot-auth/llm-gateway-usage.jsonl`：账号 / 模型 / prompt+completion+total tokens / 耗时 / 结果 |
| 取消贯穿 | 客户端收到第一个 chunk 就断连 → 记录 **`outcome: client-cancelled`**，上游 fetch 被 abort |
| 日额度 | 把 `dailyTokenLimit` 压到 100：花到 108 之后下一请求 **429** |
| **客户端本地循环 + 服务器模型** | 打包树里跑一次性任务：真模型回答，**工具在本机执行**（输出里是 `DESKTOP-LCLS51R` 与本地工作目录），客户端**没有任何 API key** |

**尚未做（下一阶段或以后）**：① 网关 token 的**签发**（现在只有配置里写死的 token；真实客户端要"登录 → 拿 token"，并能在管理台吊销）；② 并发上限实现了但没实测；③ 客户端凭据存储（Electron `safeStorage`）属于阶段 2。

**两个数字值得记住**：一次客户端请求的 prompt 就有 **约 24k tokens**（引擎的完整系统提示词）；上游对 `deepseek-v4-flash` 的响应里 `model` 字段回的是 `deepseek-flash`。

### 阶段 2：Electron 外壳（双模式；用户已定用 Electron）

> **重大发现（2026-09-18）**：**上游 DSH 自带一个成品 Electron 桌面端** —— `apps/desktop`（`@deepseek-ai/dsh-desktop`，**MIT**）。阶段 2 因此不是"从零写壳"，而是"**在它上面加服务器模式**"。

**上游桌面端是什么**（读自 `origin/master`；src 19 个文件 2857 行）：

| 项 | 内容 |
|---|---|
| 形态 | Electron shell + **内置 Node 运行时** + 内置 pnpm + `extraResources/dsh` 里一整棵生产依赖树 |
| 传输 | **不开任何监听端口**：`dsh-app://` 提供 Web 资源；**带版本的字节管道**（fd 3/4 + Node IPC fd 5）把 Fetch 请求/响应送进子进程 Host |
| 安装归属 | Electron 独占 `$DSH_HOME/profiles/desktop`；shell 与 `@deepseek-ai/dsh` **版本严格一致**（升级＝发一次桌面版） |
| 已有 | 启动页（含错误与恢复动作）、插件管理窗口、单实例锁、中英双语、**electron-builder + electron-updater**（含 Windows 免签名打包 `package:win:x64:unsigned`、macOS 公证脚本） |
| **没有** | **连远程服务器的模式** —— 这正是我们要加的那一半 |

**版本现实**：`apps/desktop` **不在 0.1.3-alpha.1（本部署基线）里**；`dsh-v0.1.5-rc.2` 有 64 个文件、`master` 有 99 个。

**决定（按"能复用就最好"）**：客户端应用 = **在 0.1.5-rc.2 的上游桌面端上打补丁**，不从零写壳。我们只加三件：

1. **服务器模式**：一个窗口加载 `https://<服务器>:8443`（现有 Web UI 原样），与本地模式**一眼可分**地切换；自签证书走 Chromium 校验钩子或当前用户证书库。
2. **本地模式的模型走部署网关**：`profiles/desktop` 的 `llm` 指向 `/llm/v1`（无 key）；阶段 1 的网关已就绪。
3. 品牌/文案与默认权限（全权限，用户已定）。

**版本并存说明**：客户端 0.1.5-rc.2 + 服务器 0.1.3-alpha.1 可行 —— 服务器模式只是一个 URL；本地模式的模型走 HTTP+SSE；会话不耦合（已选"归档成文档"）。长期是否把服务器也升到 0.1.5 是**独立决定**，不在阶段 2 的关键路径上。

**下一步**：把 0.1.5-rc.2 开成 worktree（引擎 checkout 保持零改动）→ 装依赖 → 先跑起上游桌面端 → 再加服务器模式补丁。

#### 阶段 2 结论（2026-09-21，**已完成**：双模式外壳 + 打包客户端冒烟通过）

全部改动在 worktree `C:\Users\bestarc\Desktop\dsh-desktop`（分支 `hqz-desktop-client`），引擎 checkout 保持零改动。

| 能力 | 落在哪 | 一句话 |
|---|---|---|
| 双模式 | `apps/desktop/src/server-mode.ts` | 本地 `dsh-app://app/`（内置 Host）与服务器 `https://<部署>:8443` 是同一窗口的两份文档；模式记在 `desktop-mode.json`，切回本地只是一次页面加载 |
| 证书 | 同上 + `main.ts` 的 `certificate-error` | 默认接受该 origin 的自签证书并记录指纹（提示可钉）；配了 `certificateSha256` 则只认那一张 |
| 一眼可分 | `preload-mode.ts` | 只有服务器模式注入 shadow DOM 徽标（部署名 +「切回本地」），本地模式不出现 |
| 定时归档 | `session-archive.ts` | 启动 60 秒后第一次，之后每 6 小时；只认 `$DSH_HOME/client/export-session.mjs`，没有这个脚本就整条链路不启用 |
| 打包 | `apps/desktop/scripts/package-target.ts` | `package:desktop:win:x64:unsigned` → 免签名安装包 |

**真机冒烟（2026-09-21，隔离 home）**：装好的 `win-unpacked\DeepSeek Harness.exe` 以 `DSH_HOME=<隔离>` + `--user-data-dir=<隔离>` 启动后，窗口加载 `dsh-app://app/`、`globalThis.dshDesktopBoot` 是对象、**无模式徽标**（本地模式正确）、页面 `readyState=complete`、应用根 48 KB DOM、中文界面（新会话／工作区／设置…）、客户端插件经 `dsh-app://app/plugins/??@deepseek-ai/dsh-client-modules/client.js` 解析；隔离 home 里自动长出 `profiles/desktop/{cordis.yml,package.json,cordis.patch.yml}`、`settings.yaml`、`.credentials.yaml`、`storages`。**内置运行时是自洽的：客户端机器不需要预装 dsh、Node 或 pnpm。**

**安装包清单核对**：`app.asar` 里的 `package.json` 是 `version 0.1.6-alpha.2.20260921.1` 与 `dshDesktopAppId: "com.hqz.dsh-client"`，**没有** `dshMandatoryUpdatePolicy`；`resources/` 下**没有** `app-update.yml` —— 免签名构建确实不带更新面（对应 `electron-builder-config.mjs` 里 `update === undefined → publish: null`）。

**`DSH_DESKTOP_SERVER_MODE` 的语义（踩过一次，写下来）**：它**不是模式开关**，装的是**部署对象的 JSON**（`{"origin":"https://…:8443","certificateSha256":"…","label":"…"}`）；**不设它才落到本地模式**。把它当模式开关写成 `local` 时，主进程在 `JSON.parse` 上抛裸 `SyntaxError`，弹出「DeepSeek Harness 无法使用 / Unexpected token 'l'」的原生恢复框 —— 报错里既没有变量名，也没说它该装什么。已修（提交 `325b125e3e`）：现在报 `desktop server mode: DSH_DESKTOP_SERVER_MODE is not valid JSON (received "local"); it carries the deployment, … and an unset variable starts in local mode`，与设置文件那条 `desktop client state: <path> is not valid JSON` 对称。

**交付物（2026-09-21，最终）**：`apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\deepseek-harness-0.1.6-alpha.2.20260921.1-win-x64.exe`（293.07 MB）—— 打的是带 `DSH_DESKTOP_SERVER_MODE` 报错修复的源码（提交 `325b125e3e`），重打后又跑了一遍同样的隔离 home 冒烟，结果与上表逐项一致。

**交付物（2026-09-22 15:45，当前对外的那一个）**：同一个文件名（`deepseek-harness-0.1.6-alpha.2.20260921.1-win-x64.exe`，293.08 MB，桌面 worktree 提交 `3057c8df0f`）—— 带**根证书烘入 + 本地 Host 信任锚**这一修。**SHA-256 `1A710218443EEEC9B10A6987E17ED6D610E38D4DB77D9B14993216FE734DEF40`**，已发布到 `~\.dsh\client\dist\`（与 artifacts 目录里那份逐字节相同）。**文件名每次构建都一样**，所以客户端要重新下载、必要时用 `Get-FileHash` 对哈希确认。冒烟（真机跑打包产物）：隔离 home 起应用 → `desktop.log` 记 `trusting …\profiles\desktop\gateway-ca.crt; wrote …cordis.patch.yml, …credentials.yaml, …gateway-ca.crt`；用**打包运行时**（`resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`，`ELECTRON_RUN_AS_NODE=1`）跑一次性任务：**带根证书 → 模型真的回话（"可以"）；不带 → 复现原报错 `TRANSPORT: DeepSeek API request to https://192.168.28.239:8443/llm/v1 failed`**。

**打包流水线的一个环境事实**：`prepare:runtime` 从 GitHub release 拉 150 MB 的 `electron-v44.0.0-win32-x64.zip` 会稳定卡死在 0 字节（三次：两次超时、一次 `fetch failed`）。绕法是本机镜像 `electron-mirror-server.mjs` + `ELECTRON_MIRROR=http://127.0.0.1:8791/`，镜像里放 `%LOCALAPPDATA%\electron\Cache\<sha256(dirname(url))>\` 下那份**已核对过哈希**的 zip 和**上游原文**的 `SHASUMS256.txt`（目录布局必须是 `v44.0.0/`，因为 `customDir` 默认 `v<version>`）。

**打包期间不要动 git（踩过一次）**：客户端构建把 `DSH_CLIENT_COMMIT_HASH` 记进构件记录，`release:pack` 再读出来跟当时的环境比对。构建跑到一半我提交了桌面仓库，`release:pack` 于是报 `client build environment differs from the required artifact profile: DSH_CLIENT_COMMIT_HASH` 并中止。**打包前先提交完，打包中别碰仓库。**

#### 客户端分发（2026-09-21，三件事都做完）

1. **装完就自带服务器模式**：`apps/desktop/.env.windows` 里 `DSH_DESKTOP_SERVER_MODE=auto` 时，打包会把这个部署的地址烘进应用清单的 `dshDesktopServerMode`（桌面 worktree 提交 `fbb24781fc`，新增 `scripts/desktop-server-mode-environment.mjs`）。解析顺序：`DSH_DESKTOP_SERVER_ORIGIN` → `DSH_DESKTOP_SERVER_HOST`(+`_PORT`) → **`DSH_LAN_IP`（`start-dsh-lan.cmd` 自己就设这个变量）** → 本机网卡地址（私网段优先）。**自动探测会逐个候选地址问一次 `https://<地址>:8443/auth/me`，谁答就用谁**，并把赢家作为显式 host 交给构建器 —— 烘进去的就是验证过的那个地址；一个都不答就保留第一个候选并在打包日志里 WARNING，不因此让构建失败。应用侧的读取优先级仍是 `环境变量 → desktop-client.json → 清单默认值`。
2. **一条命令配两种模式**：`client/provision-client.ps1` 现在也写 `%APPDATA%\@deepseek-ai\dsh-desktop\desktop-client.json`（`-DesktopServerOrigin` / `-DesktopLabel` / `-DesktopUserDataDir` / `-SkipDesktopServer`），落盘前各自留 `.bak-<时间戳>`。
3. **设置页直接下载**：设置 →「本地插件」多一张「桌面客户端（可选）」卡片，下载走 `/auth/client-installer`（流式、要求登录），文件取 `$DSH_HOME/client/dist` 里最新的 `.exe`（`DSH_CLIENT_DIST` 可改）。**发新版本 = 把新 exe 丢进那个目录**，列表每次请求现读，不用改代码不用重启。该目录已加进 `.gitignore`。
4. **本地模式也能连上模型（2026-09-22 两轮才修对）**：只烘服务器地址时，装完的客户端切到本地模式会**让你填 API key**。第一轮我把路由写进 `$DSH_HOME/settings.yaml`，并且"文件已存在就跳过" —— 而客户端跑过一次之后，**运行时自己就创建了这个文件**（里面没有 `llm-deepseek` 段），于是路由根本没写进去，适配器回落到默认的凭据名 `DEEPSEEK_API_KEY`，报的就是 `no API key for provider route "deepseek-official"`。**正确做法（第二轮）**：路由写进 **profile 的补丁层** `$DSH_HOME\profiles\desktop\cordis.patch.yml`（补丁层要么配置这一行、要么什么都不说；那一轮失败的原因是**运行时自己先创建了 settings.yaml**、里面没有 `llm-deepseek` 段，而我"文件已存在就不写"）。**层序的实测结论（2026-09-22，用打包运行时跑的对照实验，别再凭感觉推）**：`settings.yaml` 里的 `llm-deepseek:` 段**覆盖**补丁层的行 config —— 补丁指真网关、settings.yaml 指 `https://127.0.0.1:1/llm/v1` 时，报的失败 URL 就是 `127.0.0.1:1`；原因是设置层解析顺序为「schema 默认值 → 组合基座（行 config）→ 用户层（settings 段）」。所以 provisioning 写的 settings.yaml 优先级**高于**安装包烘进补丁层的路由（这正是想要的：provisioning 就是用来把某台机器改指到别的部署的）。而基座里 `llm-deepseek` 这一行**本来就没有 config**（全靠 settings 段），所以补丁必须把整份 config 重述（`protocol`/`baseURL`/`apiKeyEnv`/`models`）。同一个块还得钉住 `agent-default-model` 那一行：基座出厂值是 **`deepseek-flash`**，而网关公布的是 `deepseek-v4-flash`/`deepseek-v4-pro` —— 于是**网关那边同时收下 `deepseek-flash`**（它本来就是上游真实 id，服务器自己的 settings.yaml 也用它）。凭据仍然只住在 `.credentials.yaml`：文件在、`refs:` 在，就把 `HQZ_GATEWAY_TOKEN` **插进那个列表**（运行时的 `records:` 段原样保留），已有的同名引用绝不覆盖。`.env.windows` 里 `DSH_DESKTOP_GATEWAY=auto` + token 即"装完零配置"；token 留空则凭据不进安装包；`none` 整体关闭。**注意 token 是凭据**：它随安装包走（安装包只从设置页下载、不出局域网）。验证链：组合后的那一行（`--dump-config`，用 profile 的副本，因为 CLI 拒绝 Electron 独占的 `desktop` profile）确实带 baseURL/apiKeyEnv/models；凭据能打网关 200；两个模型 id 都能真实调用 200。

5. **本地模式握手失败：Node 不读 Windows 证书库（2026-09-22，第三轮才修对）**。路由修对之后，客户端报的仍是 `DeepSeek API request to https://192.168.28.239:8443/llm/v1 failed / 本轮运行失败`。根因：**部署的 TLS 终结器（caddy）自签，而本地 Host 是独立于外壳的 Node 进程，Node 完全不读操作系统的证书库** —— 外壳 `certificate-error` 里"接受自签证书"只覆盖它自己的窗口与请求，管不到那个进程。同一台服务器上的证据链：普通 Node `fetch('https://192.168.28.239:8443/llm/v1/models')` → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`；同一个请求加上 `NODE_EXTRA_CA_CERTS=%APPDATA%\Caddy\pki\authorities\local\root.crt` → **HTTP 401**（假 token，说明 TLS 已过）；再用**打包的 Electron-as-Node**（`$env:ELECTRON_RUN_AS_NODE=1; & "…\win-unpacked\DeepSeek Harness.exe" probe.mjs` —— 本地 Host 真正用的运行时）复现，两种环境结论完全一致。修法：打包把根证书（新设置 `DSH_DESKTOP_GATEWAY_CA_FILE`，`.env.windows` 里指 caddy 的 `root.crt`）烘进 `dshDesktopGateway.certificateAuthority`；客户端首次启动写成 `$DSH_HOME\profiles\desktop\gateway-ca.crt`，外壳把它作为 `NODE_EXTRA_CA_CERTS` 交给本地 Host 与归档脚本（`node-environment.ts` 的 `withCertificateAuthority`）。**带根证书的构建覆盖旧文件；不带根证书的构建保留 provisioning 放的那份**（`provision-client.ps1` 新增 `-DesktopGatewayCa`）。要**根证书**不要叶子证书：终结器换叶子证书时根证书不变。

**PowerShell 5.1 的两个坑（客户端机器上就是它）**：`.ps1` 不带 BOM 时，Windows PowerShell 5.1 按**系统代码页**解码，中文注释变乱码 —— 而乱码会让 3 字节的汉字与后一个字节配对，**行结构跟着错位**，连 `publicPrefixes:` 这种纯 ASCII 行都可能被并进上一行（`enable-client-features.ps1` 就是这么报「没有 publicPrefixes」的）。所以：两个脚本都带 BOM 存盘，且脚本里读文件一律 `[System.IO.File]::ReadAllText(..., UTF8Encoding($false))`，不用 `Get-Content`；写文件也不用 5.1 没有的 `-Encoding utf8NoBOM`。**2026-09-22 又踩一次**：`edit`/`write` 工具重写文件同样**不留 BOM**，改完 `provision-client.ps1` 后 `git show HEAD:…` 对比才发现（HEAD 是 `EF BB BF`，工作区不是）—— 改 `.ps1` 必须补 BOM 并核对前 3 字节；顺带记一条可复用的检查办法：把工作区与 `git show HEAD:<path>` 的前 3 字节逐个比一遍，整个仓库 14 个 `.ps1` 一次过完。

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

- **桌面客户端（2026-09-22 一天内踩了五条，全部写进 `desktop.log` 或测试了）**：
  1. **证书判定必须按 host:port，不能按整个 origin。** 一个部署一个监听端口：文档走 `https://`、会话流走 `wss://`，同一张证书。按 origin 比会把**每一次 WSS 握手**判成"证书不属于这个部署"，Web UI 于是永远"重新连接"。**在服务器上永远测不出来** —— caddy 的根证书装在 `CurrentUser\Root` 里，Chromium 压根不报证书错误，那段判定一次都不执行；只有客户端机器（没装根证书）才会走到。要复现就用一张**真正不受信**的自签证书（`New-SelfSignedCertificate` + 本地 HTTPS/WSS 探针，用完从证书库删掉）。
  2. **合成的 `.click()` 不能当"能点"的证据。** 徽标画在原生 caption 带（`titleBarOverlay`，40 DIP）里，操作系统把那条带当**拖动把手**：不声明 `-webkit-app-region: no-drag` 的控件，真人按下去是拖窗口，而 CDP 里 `element.click()` 照样触发 DOM 事件、测试全绿。**可点击性的证据只能是计算样式**（`getComputedStyle(el).getPropertyValue('-webkit-app-region')`）或真人点击。
  3. **服务器模式没有"覆盖层座位"。** `preload-menu.ts` 的「应用 / 编辑」只等 `[data-shell-overlay]`（本外壳自己的文档才发布它）；部署页面没有 → 菜单整条不挂。而 `windowsMenu` 的准入写死 `assertDesktopSender(event, ['app'])`，所以就算挂上也会被拒。现在由外壳把模式报给菜单、服务器模式自己挂，并且这一条请求只按"主窗口顶层 frame"校验（它只带菜单名与两个坐标，不带页面授予的权限）。
  4. **打包前必须关掉从 `win-unpacked` 跑着的客户端**：它锁着 `dxcompiler.dll` 等文件，electron-builder 会一路跑到最后一步才以 `EPERM: operation not permitted, unlink …` 失败（十几分钟白跑）。`build-client.ps1` 现在开工前检查并拒绝（`-StopRunning` 可代关）。
  5. **Node 不读 Windows 证书库 —— "客户端连不上 AI"先查这一条**（2026-09-22 第三轮）：本地 Host 是普通 Node 进程，只认内置 CA 列表加 `NODE_EXTRA_CA_CERTS`；自签部署的根证书**装进 Windows 证书库对它一点用都没有**，而 Chromium（外壳窗口）因此不报错，看起来"证书没问题"。一条命令复现：`$env:ELECTRON_RUN_AS_NODE=1; & "…\win-unpacked\DeepSeek Harness.exe" probe.mjs`（probe 里 `fetch` 一次 `/llm/v1/models`）。**不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 掩盖** —— 根证书随包分发（`DSH_DESKTOP_GATEWAY_CA_FILE` → `dshDesktopGateway.certificateAuthority` → `profiles\desktop\gateway-ca.crt` → `NODE_EXTRA_CA_CERTS`）才是修法。
  另外：`desktop.log`（`%APPDATA%\@deepseek-ai\dsh-desktop\`，512 KB 上限）现在记启动模式、每次证书判定、每次模式切换、归档结果与致命错误 —— **客户端报障先要这个文件**，别再靠猜。

- **编辑 `.ps1` 会丢掉 BOM。** 我的编辑工具重写文件时不保留 BOM，而**没有 BOM 的中文注释在 Windows PowerShell 5.1 下会被按系统代码页解码**，乱码会让 3 字节汉字吞掉后一个字节、行结构错位（表现是莫名其妙的 `ParserError`）。改完 `.ps1` 必须补 BOM 并用两个 shell 各解析一遍。同理：**PowerShell 行尾是闭合字符串时不续行**（`+` 写在下一行开头会报"缺少右括号"）。
- **git**：`git grep` 无命中时退出码是 1（别当成错误）；以 `-` 开头的模式必须用 `-e` 传；`git stash pop` 会把文件写成 **CRLF**，提交前要转回 LF（`.gitattributes` 是 `eol=lf`）。**不要在有嵌套 `node_modules` 的仓库跑不带路径限制的 `git status --ignored`** —— 它会走几十万层目录、几分钟后超时，还会留下孤儿 git 进程和 `index.lock`（下一次 commit 直接失败，报 `index.lock: File exists`；确认没有 git 进程后删掉即可）。
- **`$home` / `$pid` / `$host` 这类 PowerShell 只读自动变量，绝不能当自己的变量名用。** 赋值会**静默失败**（`WriteError: 无法覆盖变量 HOME`），变量仍指向它原本的值 —— `$home` 就是 `C:\Users\<用户名>`。于是后面任何 `Remove-Item $home -Recurse -Force`、`Join-Path $home ...` 都**指向整个用户目录**。2026-09-22 又踩了一次：`Remove-Item` 在根目录上整体失败（.NET 递归删除遇到占用即中止，不做部分删除）所以什么都没丢，但那是运气 —— 同一个脚本的下一行 `Join-Path $home 'settings.yaml'` 已经把测试内容写进了 `C:\Users\bestarc\`。**规矩**：变量一律用 `$checkHome` / `$targetHome` 这类名字；**任何递归删除之前先把它要删的绝对路径打印出来**，看到路径不对就停。核查用户目录完整性的最小清单：三个仓库 `git status` 全干净、`.dsh\.agent-presets` 286、`.dsh\plugins` 10、`.dsh\sessions` 里 `.zstd` 数量、`auth\store.json`、`.credentials.yaml`、`client\dist`。
- **本机命令**：`Get-CimInstance Win32_Process | Where CommandLine -match 'executor'` 会**杀掉自己的 pwsh**（它的命令行里也含这个词）—— 过滤必须带 `Name=`；pwsh 里 .NET 文件 API 按**进程 cwd** 解析，必须用绝对路径；`Start-Process -RedirectStandard*` 在**受限沙箱**下会 `spawn EPERM`（打不开命名管道），在 `danger-full-access` 下正常 —— 抓 GUI 应用（Electron）的 stdout/stderr 就靠它，因为 GUI 子系统进程不继承控制台。
- **`Invoke-WebRequest` 的 `.Content` 可能是 `byte[]`**（内容类型是 `application/octet-stream` 时，如 GitHub release 的 `SHASUMS256.txt`）：直接 `Set-Content` 会把每个字节写成一行十进制数字。要落盘二进制/文本请走 `[System.IO.File]::WriteAllBytes/WriteAllText`。
- **junction 只看"在不在"会骗人**（`enable-client-features.ps1` 2026-09-21 已修）：断链的 junction（目标被删了）`Test-Path` 给 **true**、`Get-Item` 也能拿到，但 `mklink` 建不了；指向别处的 junction 同样"看着正常"。两种都会让 profile 的 `bundles` 那一行解析失败（或更糟：挂上另一个 home 里的插件），而且**只在组合重载时才炸**。修法是巡检时核对 `.Target`，且目标从 `package.json` 的 `link:` 解析 —— 不要按包名猜（`dsh-video-studio` 实际挂在 `plugins/dsh-video-studio-local`）。顺带一条脚本级教训：**别复用外层的 `$existing` / `$current`**，覆盖了会以 "Cannot compare … because it is not IComparable" 的形式在几十行之外炸出来。
- **客户端 shell**：`machine_run` 的 `command` 走 Windows 自带的 `powershell.exe` 5.1（不是 pwsh 7），已强制 UTF-8 控制台编码；客户端的 glob/grep 若要做，用执行器里的 Node 实现，**不要依赖 ripgrep**。
- 引擎与部署的实现级坑（SEA 会"fork 自己"、`hello` 事实只有那台机器知道、`DSH_` 前缀会被清洗、同机测试的证伪力）见 `AGENTS.md` §四。

---

## 8. 不做 / 已放弃（避免重复提议）

- **工作区共享与绑定的界面入口**：2026-09-17 撤除（恢复步骤写在 `README.md`）。
- **计划 A 的 P0（文件/stdin/后台任务）**：计划 B 落地前不做。
- **客户端里再走一遍"执行器 + 机器工具"**：本地模式不需要它；执行器只为"没装客户端的机器"和"服务器工作区 + 本机软件"保留。
