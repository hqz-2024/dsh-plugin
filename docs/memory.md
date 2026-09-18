# 记忆：当前状态、决策记录与下一步

> **这份文件是"现在是什么状态、下一步做什么"的唯一入口。** 每次重要变更后更新它（改完顺手把"最后更新"时间改掉）。
> 细节分流：实现与验收证据 → `docs/plan-client-world-progress.md`；两条路线的完整评估 → `docs/plan-two-paths.md`；用户手册 → `README.md`；铁律与实现级陷阱 → `AGENTS.md`。
>
> 最后更新：**2026-09-18 11:05（+08:00）**（阶段 1 完成，结论见 §5）

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
