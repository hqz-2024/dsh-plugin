# 计划：客户端应用（双模式）——执行进度与设计

写于 2026-09-17；2026-09-18 按用户要求**删除原"计划 A"**（在服务器架构上把机器工具补全），只保留客户端应用这条路线，并记上执行进度。

> 面向使用者的手册：`README.md`｜**当前状态与交接：`STATE.md`**｜决策与记忆：`docs/memory.md`｜实施与验收证据：`docs/plan-client-world-progress.md`｜铁律与陷阱：`AGENTS.md`

难度单位：**小**（半天内）／**中**（1–2 天）／**大**（3 天以上，含未验证的关键假设）。估计只含"写代码"，不含取证与回归（按本部署的经验，取证常常和实现一样贵）。

---

## 0. 执行进度（截至 2026-09-18）

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| **阶段 0** | 打包可行性 spike：客户端能不能自带一份 dsh | ✅ **完成**：目录分发可行，`dsh web` **1.3 秒**起监听；前端**随包分发**；本地工具确实本机执行；模型请求确实到达假网关 | `docs/memory.md §5 阶段 0`；产物 `%TEMP%\dsh-client-spike\`（隔离构建、257 个 tarball、消费者树） |
| **阶段 1** | 模型网关 + 客户端 profile | ✅ **完成**：真模型经网关跑通（流式 27 个 SSE、用量入账、取消贯穿、额度 429）；打包树里跑一次性任务，**工具在本机执行、客户端无 key** | 插件 `plugins/dsh-llm-gateway-local/`；`docs/memory.md §5 阶段 1`；提交 `aebf843` |
| **升级前置** | 把 dsh 升到 `dsh-v0.1.6-alpha.2`（客户端桌面端只在新版里） | ✅ **完成**（2026-09-21）：线上已跑构建产物；升级打断的 286 个预设 persona 行、11 个预设的字面 `{{…}}` 已修 | `fix-preset-persona-row.mjs`、`fix-preset-literal-persona.mjs`、`check-preset-roster.mjs` |
| **阶段 2** | Electron 双模式外壳 | 🟡 **主体完成**：双模式外壳已实现并在真机跑通（见 §2.1）；本地 profile 接网关（B8）已验证；打包/安装器未做 | 分支 `hqz-desktop-client` 提交 `64e46ac86a`；`client/provision-client.ps1` |
| **阶段 3** | 会话归档 → AI 精简 → Obsidian | ✅ **完成**（服务端 + 客户端两端都已真机跑通，见 §3.2） | 插件 `plugins/dsh-archive-local/`；客户端 `client/export-session.mjs`；探针 `check-archive-compose.mjs`（56 断言） |
| **阶段 4** | 安装器 + 自更新（全量包） | 🟡 **安装器配置就绪**（`.env.windows` 已写、unsigned 校验通过，等版本号）；**自更新做不了** —— 需要 EV 代码签名证书（见 §4.2） | 见 §4.1 / §4.2 |

---

## 0.1 本轮（2026-09-21）做完的事与证据

### 双模式外壳（B9）

实现在**独立工作树** `C:\Users\bestarc\Desktop\dsh-desktop`（分支 `hqz-desktop-client`，基于
`ddefc45fbc`）——引擎 checkout `deepseek-harness` 保持零改动（`git status` 干净）。

| 改了什么 | 文件 |
|---|---|
| 部署解析（override → 本机设置文件 → 打包清单，坏值一律大声失败）、模式持久化、证书信任判定、导航规则 | `apps/desktop/src/server-mode.ts`（新） |
| 窗口接线：模式切换、模式标题与 Windows 标题栏配色、`certificate-error`、失败分类（服务器不可达给"重试/切回本地"而不是插件修复对话框）、模式菜单、`Ctrl+Alt+1/2` | `apps/desktop/src/main.ts` |
| 模式横幅（shadow root，页面样式改不动它） | `apps/desktop/src/preload-mode.ts`（新） |
| 恢复 `dsh-app://shell/*`（上游 `4b6474133a` 删了处理器、调用方还在 → 更新对话框与强制更新窗口一直 404） | `apps/desktop/src/shell-document.ts`（新） |
| 文案（中英） | `apps/desktop/src/locale.ts` |
| 测试 | `apps/desktop/tests/server-mode.spec.ts`（新，18 例）+ 两个既有 spec 的期望更新 |

**判据落在"只有那个窗口才能报出来的事实"上**（用渲染进程的 DevTools 协议从外面读，
工具 `check-desktop-window.mjs`）：

| 观察 | 服务器模式 | 本地模式 |
|---|---|---|
| 文档 URL / origin | `https://192.168.28.239:8443/`（自签证书被接受） | `dsh-app://app/` |
| 模式横幅 | 在，"服务器模式 · hqz-dsh"，带"切回本地" | 不在 |
| `globalThis.dshDesktopBoot` | **`undefined`**（远程文档拿不到特权桥） | `object` |
| 切换路径 | 点横幅按钮 → preload IPC → 主进程换文档 → 本机 Host 起在 19387 | 同一条路反过来 |

单测 `94 passed`；`main-startup.spec.ts` 63 例、`preload-app.spec.ts` 全绿。

### 客户端接网关（B8）

新目录 `client/`（`README.md` + `provision-client.ps1`）：往目标 `$DSH_HOME` 写三样东西 ——
`settings.yaml`（`llm-deepseek` 指到 `<origin>/llm/v1` + 网关开放的模型 id）、
`.credentials.yaml`（`version: 1` + 网关 token）、`profiles/desktop/cordis.patch.yml`。

**验证**：一个只有网关 token、**没有任何 AI key** 的 home（`C:\Users\bestarc\.dsh-client-check`）
跑一次性任务，真模型回了"客户端通"；网关用量日志同步多出
`{"account":"probe-admin","model":"deepseek-v4-flash","outcome":"ok",...}`；
该 home 里 `sk-` 命中数为 **0**。

### 顺带修掉的两个真缺陷

1. **`dsh-app://shell/*` 404**（上游回归）：更新对话框与强制更新窗口的文档一直加载不出来。
2. **服务器模式下窗口标题会被远程页面顶掉**：`<title>` 覆盖 `setTitle`，任务栏/Alt-Tab 上看不出在哪个部署；
   已按 `page-title-updated` 拦下（本地模式仍让页面自己定标题）。

### 已知未做 / 待确认

- **本地模式下模型网关还没上线**：`llm-gateway` 行目前只在 `pilot-auth`；要在线上开，
  改 `profiles/web-client/cordis.patch.yml`（该 profile 是 `patchReload: live`，等于直接改生产）。
- **网关 token 的签发与吊销**（B2）仍是手工：token 写在网关行的 `config.tokens` 里。
- **服务器模式下无法安装本地更新**：更新安装闸门要求 `backend.host` 与任务排空
  （`main.ts` 的 `DesktopUpdatePreparationError('tasks-unavailable', …)`），服务器模式没有本机 Host。
  这是有意的现状，需要产品决定而不是代码推断。


---

## 1. 形态：一个窗口，两种模式

```
                       客户端应用（一个窗口，两种模式）
      ┌───────────────────────────────────────────────────────────┐
      │ [服务器模式]  现有 Web UI（对话/文件/权限/文件树上传下载） │
      │                          ⇅ 模式切换                       │
      │ [本地模式]    本地跑 dsh：文件/shell/终端/截图/长任务原生 │
      └───────────────────────────────────────────────────────────┘
             │ 本地模式：模型请求（不带密钥）        │ 归档同步（定时）
             ▼                                      ▼
      ┌────────────────────────────────────────────────────────────┐
      │ 服务器：门禁/账号（dsh-remote-local，不变）                 │
      │         模型网关（✅ 已实现）→ 真 AI 接口（密钥不出服务器） │
      │         工作区 / 文件树 / 会话 / 权限 / 管理台（全部不变）   │
      │         浏览器直接用服务端 agent（原样保留）                 │
      └────────────────────────────────────────────────────────────┘
```

**一句话**：服务端只新增一个模型网关（已做完）；客户端把"本地模式"这一半带在身上。

---

## 2. 计划 B：客户端应用（类豆包，双模式）

### B.1 四条链路的评估（已核实）

| 链路 | 能不能 | 靠什么 |
|---|---|---|
| ① 服务器模式：客户端里呈现现有 Web UI | ✅ **服务端零改动** | 一个 WebView 指向 `https://<服务器>:8443`；自签证书装当前用户证书库或走校验钩子 |
| ② 本地模式：本地 agent + 本地工具 | ✅ 已由阶段 0 证明可行 | 本地一份 dsh（目录分发）；工具全原生 |
| ③ 对话本地缓存 + 定时归档到服务器 | ✅ 能（**已选：归档成文档、按账号上传**） | 无会话格式耦合 |
| ④ 文件资料手动上传到工作空间 | ✅ 今天就能做 | 服务器侧文件树的上传（已存在） |

### B.2 服务端要做的事

| # | 功能 | 难度 | 状态 |
|---|---|---|---|
| B1 | **模型网关** | 小～中 | ✅ **已完成**（`dsh-llm-gateway-local`） |
| B2 | 网关 token 的**签发与吊销**（登录 → 拿 token） | 小～中 | ⬜ 待做（现在只有配置里写死的 token） |
| B3 | 客户端版本与更新清单服务（复用分发的 Range 续传） | 小～中 | ⬜ 待做 |
| B4 | 用量与额度视图（管理台） | 小 | ⬜ 待做（网关已按账号入账） |
| B5 | **（可选）** 本地会话归档的接收端点（按账号落盘） | 中 | ⬜ 待做（形式 2 的落地） |
| B6 | 保留 web 形态（浏览器直接用服务端 agent） | 小 | ✅ 原样保留，不动 |

### B.3 客户端要做的事

> **2026-09-18 变更**：不再从零写 Electron 壳 —— **上游 DSH 自带成品桌面端** `apps/desktop`（MIT，0.1.6 里 291 个文件：Electron shell + 内置 Node + 内置 pnpm + 完整生产依赖树 + `dsh-app://` 协议 + 字节管道 + 启动页 + 插件管理窗 + 单实例锁 + 中英双语 + electron-builder/updater）。我们只加"服务器模式"。

| # | 功能 | 难度 | 状态 |
|---|---|---|---|
| B7 | 打包可行性 spike | 小 | ✅ 完成（阶段 0） |
| B8 | 客户端 profile（本地循环 + 本地工具 + `llm` 指向网关） | 小 | ✅ **完成**（`client/provision-client.ps1`；无 key 的 home 跑通真模型） |
| B9 | **服务器模式**（在桌面端里加第二模式 + 模式切换 + 证书 + 视觉区分） | 中 | ✅ **完成**（§0.1；真机两模式与切换均已验） |
| B10 | 安装器（electron-builder + NSIS，全量包） | 中 | 🟡 配置就绪（`.env.windows` + `--check` 通过）；**等用户确认版本号**才能构建 |
| B11 | 更新通道（electron-updater + 自建更新源） | 中 | ⛔ **做不了**：unsigned 构建构造上就没有更新面，需要 EV 代码签名证书，见 §4.2 |
| B12 | presets / skills 的来源（打包一份 vs 登录后从服务器拉） | 小～中 | ⬜ 待定 |
| B13 | 本机回环 API 的访问控制 | 小 | 上游桌面端**不开监听端口**，此风险天然消失 |
| B14 | 本地会话的归档导出器 | 小 | ✅ **完成**（`client/export-session.mjs`；自动触发见 §3.4，提交 `162017c70c`） |
| B15 | **（可选）** "推送到工作区"按钮 | 小 | ⬜ 待做 |
| B16 | 归档上传 + AI 精简 + 落进 Obsidian（用户 2026-09-18 新增） | 中 | ✅ **完成**（`plugins/dsh-archive-local/`，见 §3.2） |

### B.4 决策（2026-09-18 用户拍板）

| 项 | 决定 |
|---|---|
| 本地会话同步 | **归档成文档、按账号上传**；服务器随后用 AI 精简并写进 Obsidian（无版本锁） |
| 安装包 | **全量包**（ffmpeg 等一次装完；引擎依赖集需要裁剪，见阶段 0 的 1059 MB 实测） |
| 外壳 | **Electron**（改为复用上游桌面端） |
| 本地模式默认权限 | **全权限**（`danger-full-access`，无审批）；安装引导里必须说清 |
| 目标版本 | **`dsh-v0.1.6-alpha.2`**（客户端桌面端只在新版里；服务器同版本升级） |

### B.5 固有限制

1. **服务端治理盲区**：本地模式里 agent 在客户端做了什么，服务器看不到（只看到 token 消耗）。
2. **数据不集中（本地模式）**：本地工作区在各自电脑上；靠归档/上传手工回传。
3. **服务器模式的能力回退**：服务器模式里 agent 的工具在服务器上跑，要驱动用户本机软件仍需**执行器 + `machine_run`**（已上线）。
4. **体积与更新**：全量包 300–600MB 量级，每次改工具都要逐台更新。
5. **模式误认**：两个模式必须一眼可分，否则用户以为自己在服务器上操作。
6. **全权限的后果**：agent 以该 Windows 用户身份无阻拦操作，是用户的选择，但要在安装引导里明示。

---

## 3. 阶段 3：归档流水线（用户 2026-09-18 新增）

`本地会话 → 归档成文档 → 按账号上传到服务器 → 服务器用 AI 精简 → 写进 Obsidian`

- 客户端侧：定时/退出时导出会话（Markdown/JSON），带账号与机器标识上传。
- 服务端侧：按账号落盘 → 触发一次精简（LLM）→ 生成结构化笔记写进 vault（frontmatter + 标签，遵循全局 skill `obsidian-markdown`）。
- **待查**：服务器上 Obsidian vault 的位置与是否存在；精简用哪条模型路由与触发方式（上传即触发 / 定时批量）。

### 3.1 现场勘查结论（2026-09-21）

**vault 存在，而且目标格式已经有人手工定好了** —— 这消掉了 §3 里最大的一条"待查"。

| 项 | 事实 |
|---|---|
| vault | `C:\Users\bestarc\obsidian笔记`（有 `.obsidian`，是 git 仓库，`.gitignore` 齐备） |
| 目标目录 | `会话记录\`，已有 **3 篇样本 + 1 个索引**：`2026-09-09 FFmpeg转码会话总结.md`、`2026-09-10 dsh会话总结.md`、`2026-09-14 dsh会话总结.md`、`会话记录索引.md` |
| frontmatter | `title` / `date` / `tags`（至少含 `会话记录`，其余是主题标签）/ `category: 会话记录` |
| 正文 | `# 标题` → 工作区（含 dsh 工作区名）→ 会话 id → 时间（起–止）→ 分节总结（表格为主） |
| 索引 | `会话记录索引.md`，按日期倒序列条目 |
| 命名 | `YYYY-MM-DD <主题>.md` |

**因此流水线要做到的是"产出与现有样本同形"，不是"发明一种格式"**：

1. 客户端：导出会话（引擎已有 `session-log-export` 包与 `dsh-session-log-export` 客户端插件，先看能不能直接用），
   带上账号、机器标识、工作区、起止时间，POST 到服务器。
2. 服务端（部署插件，形态照 `dsh-llm-gateway-local`：`ctx.webServer.register` + Bearer 认证）：
   按账号落盘原文 → 用**部署自己的模型路由**精简 → 写成上面的形状 → 追加索引。
3. 触发方式仍待定：上传即触发最省事；定时批量便于批量重跑。

**注意**：vault 是 git 仓库，写入相当于改用户的工作树 —— 落盘位置、命名冲突与索引追加都要可回退。

### 3.2 做完的样子（2026-09-21）

链路两端都实现了，并且**用本机一个真实会话跑通**：

```
本机会话 ──export-session.mjs──▶ 转录 Markdown ──POST /archive/v1/sessions──▶
  落原文（按账号）──▶ 部署自己的模型路由精简成 JSON ──▶ 笔记 + 索引行写进 vault
```

| 端 | 东西 | 说明 |
|---|---|---|
| 服务端 | `plugins/dsh-archive-local/`（行 `archive`，默认 `disabled: true`） | `lib/compose.js` 全是纯函数（提示词、解析、笔记渲染、索引幂等），`lib/index.js` 负责认证、落盘、调 `ctx.llm.stream()`、写 vault |
| 客户端 | `client/export-session.mjs` | 读 `$DSH_HOME/sessions`，按 zstd 帧扫出事件（多帧拼接坑见 vault 索引笔记），渲染成可读转录再上传 |

**判据**（都在隔离环境 `.dsh-archive-check` / 3088 / 测试 token 上做，不碰线上 home）：

| 检查 | 结果 |
|---|---|
| 无 token / 错 token | **401**，且错误文本是插件自己的（证明是处理器拒的，不是门禁拦的） |
| 首次归档 | 200：原文落盘 + 笔记 + 索引行同时产出 |
| 同一会话再次归档且主题变了 | 200 且带 `removedNote`；vault 里**恰好 1 篇笔记 + 1 行索引**（旧笔记被删，不留孤儿） |
| 在陌生工作区名上筛选 | 报"找不到匹配的会话"，不会乱选一个会话 |
| 真实会话端到端 | 本机 24 MB / 24441 事件的会话 → 转录 → 上传 → 模型产出笔记 `2026-09-21 预设修复与会话归档.md`，形状与 vault 里 3 篇手写样本一致 |
| 格式体检 | `check-archive-compose.mjs`：**56 条断言全过**，含"frontmatter 的键与真实样本一致" |

**两条设计选择**（都写进了代码注释）：

1. **先落原文再精简**。模型调用可能失败或超时，转录一到手就先写进 `storeDir`，
   所以精简失败不会丢掉这次归档，响应里带 `summaryFailure` 如实说明。
2. **索引是"哪个文件代表这个会话"的唯一记录**。同一会话换了主题就换了文件名，
   所以写新行之前先从索引里问出旧名字，写完再删旧文件 —— 否则 vault 会攒出孤儿笔记。

**客户端凭据**：`provision-client.ps1` 现在可带 `-ArchiveToken`，写进 `.credentials.yaml` 的
`HQZ_ARCHIVE_TOKEN`；归档地址写进 `$DSH_HOME/archive.json`（省略 `-ArchiveOrigin` 时与网关同源）。

**还没做的**：归档的**触发方式**已经做了（见 §3.4），但归档端与网关一样，
**还没接到线上 profile**（现在只在隔离环境验证过）。

### 3.3 与门禁的关系（已实测）

`pilot-auth` 是带真门禁的验证环境，归档端已经挂在那里（顺便把 `/archive` 加进了
`publicPrefixes`）。这一步单列出来，是因为**只测过没有门禁的 profile 等于没测线上形态**：

| 状态 | 请求 `/archive/v1/sessions` 带合法 token | 读法 |
|---|---|---|
| `/archive` **不在** `publicPrefixes` | **403** + `{"ok":false,"error":"unauthorized"}` | 门禁拒的：没有处理器文本 |
| `/archive` **在** `publicPrefixes` | **400** + `{"error":"archive body must carry sessionId"}` | 处理器拒的：请求已经到达插件，token 也认了 |
| 对照：`/api` 未登录 | 403 | 加了前缀没有顺带放开别的东西 |

`pilot-auth` 的 profile 是 `patchReload: live`，所以改完 `publicPrefixes` **不用重启**即可复测 ——
第一次 403、第二次 400，两次都在同一个进程里发生。随后用完整请求跑通了整条链：

```
POST http://127.0.0.1:3084/archive/v1/sessions  (Bearer pilot-archive-token-…)
→ 200 {"account":"probe-admin","summarized":true,
       "note":"…\\archive-vault\\会话记录\\2026-09-21 归档端门禁通过确认.md"}
```

**线上开通要改三处**（不是两处）：① profile 的 `package.json` —— 依赖加 `link:`、
`dsh.profile.bundles` 里列出来；② `cordis.patch.yml` —— 用完整 config 打开那一行
（补丁是**整体替换** config，不是合并）；③ `remote` 行的 `publicPrefixes` 加前缀。
少任何一处都**不一定报错**，只是静默不挂载或被门禁 403。

**这一步已经脚本化了**：`enable-client-features.ps1`。默认只预览，`-Apply` 才写；
幂等（重复跑不写盘、**不重新生成 token** —— 换了 token 已发出去的客户端就 401 了）；
写前备份；并顺手建好 `link:` 依赖需要的 junction（不让一次配置改动去碰包管理器/网络）。

```powershell
# 先看要改什么（不写）
.\enable-client-features.ps1 -Profile web-client
# 确认后落盘；它会打印两个 token，交给客户端 provision-client.ps1
.\enable-client-features.ps1 -Profile web-client -Apply
```

**已开通（2026-09-21，用户确认后执行）**。线上 `web-client` 用
`enable-client-features.ps1 -Apply` 打开，**没有重启 3080**：

| 探针（对 3080 与 8443） | 结果 |
|---|---|
| `GET /llm/v1/models` 带网关 token | **200** + 封闭模型清单 |
| `POST /llm/v1/chat/completions` 带网关 token | **200**，用量入账 `account: admin, model: deepseek-v4-flash, ok` |
| `POST /archive/v1/sessions` 带归档 token | **400** + `archive body must carry sessionId`（处理器原话 = 已到达插件且 token 已认） |
| `/`、`/api` 未登录、`/client-auth/state` 未登录 | 200 / 403 / 401（原样） |

### 3.3.1 一个值得记住的坑：解析不了的新 bundle 会让**整次重载静默作废**

第一次开通后两条链路都不生效（`/llm` 返回登录页、`/archive` 403）。原因不是 HMR 不工作，
而是新 bundle 的 `node_modules` junction 指向了一个已被删掉的目录：

- HMR 的 `refresh()` 先读 manifest + patch 文本，再 `reconcileProfilePatches(...)`，**只有成功之后才更新
  `lastInputs`**。bundle 解析失败时这一步抛错，于是**连 patch 里的改动也一起没应用**——
  表现是"改了 `publicPrefixes` 却没生效"，很容易误判成"live reload 是假的"。
- 而且重载只在**文件变化事件**上触发一次：把 junction 修好不会重试，得再动一次被监视的文件。
  实测：修好 junction 后追加一行注释 → 两条链路同时生效。

所以判断"是不是没重载"之前，先确认**这一层的所有 bundle 都能解析**（`node_modules/<pkg>`
的 junction 目标存在）。`enable-client-features.ps1` 现在会自己建这个 junction；
但它**不会**去修一个已经存在却指向别处的链接——那种情况在 profile 里是别人放的，脚本不猜。

**另一条经验**：`patchReload: live` 这个键在引擎里**没有任何消费者**（`packages/`、`apps/` 全无命中）。
真正让它生效的是 base bundle 里默认挂载的 `@deepseek-ai/dsh-hmr`（`disabled: !!js "!ctx.get('profileContext')"`），
它监视 profile 的 patch 文件与 `package.json`。AGENTS.md 铁律 #5 的结论（"改这个文件等于直接改生产"）
是对的，但**理由不是那个键**——所以今后不要用"有没有写 patchReload"来判断某个 profile 会不会热载。


> **启用前请确认一件事**：归档会写进 `C:\Users\bestarc\obsidian笔记\会话记录\` ——
> 那是你的 Obsidian 库（git 仓库）。每个上传的会话产生一篇笔记并追加索引行，
> 同一会话重复归档是替换（旧笔记会被删）。脚本会把这句话再打印一遍。

### 3.4 自动归档（阶段 3 触发侧，2026-09-21 补完）

原来只能人工跑脚本，所以一台没人管的机器会攒下一堆没人看的会话。现在桌面端自己会跑：

| 项 | 决定 |
|---|---|
| 跑什么 | `$DSH_HOME/client/export-session.mjs --pending`（**不重新实现导出**：转录长什么样、发去哪，只有那一份实现） |
| 何时跑 | 启动后约 1 分钟第一次，之后每 6 小时（`DSH_DESKTOP_ARCHIVE_INTERVAL_MS` 可调，最小 10 秒；`0` 只关定时） |
| 手动 | 应用菜单"立即归档会话"，与定时共用一个在飞锁 |
| 启用的条件 | 脚本存在（provisioning 放的）**且**归档地址已配置（`archive.json` 或 `HQZ_ARCHIVE_ORIGIN`） |
| 失败怎么办 | 记日志、不上抛：一次只跑一个、超过期限就杀、会话是持久的，漏一次下次补上 |

**为什么要"且"**：部署仓库里本来就有这个脚本，只按"脚本存在"判断会让一台**没配归档**的
桌面机自己去连一个它没被告知的地方。两个事实都成立才算配置过。

**为什么要台账**（`$DSH_HOME/client/archive-state.json`）：没有它，定时任务每个周期都会
把同一个会话再传一次，而归档端每次上传都要跑一次模型精简 —— 那是真金白银。
台账按"大小或修改时间变了才算待归档"，每成功一个记一笔。

**判据**（隔离 home `.dsh-archive-check` + 本机归档端，全程没碰线上）：

| 观察 | 结果 |
|---|---|
| 脚本侧 `--pending` | 首次 `{"pending":1,"archived":1}`，紧接着再跑 `{"pending":0,"archived":0}` |
| 桌面端自己跑 | 台账 4 条**由应用调度写出的**记录；raw 落 5 份转录 |
| 落到 vault | 3 篇笔记 + 索引，全由应用的定时任务产生（`2026-09-21 dsh 升级与插件化梳理.md` 等） |
| 内容太薄的会话 | 原文照存、笔记不生成、响应带 `summaryFailure` —— 这是设计好的退化路径 |

**这一步又逼出两个真缺陷**：

1. **`FinishReason` 是对象不是字符串**（`{ kind: 'error', failure }`）。原来写
   `chunk.reason === 'error'` 永远不成立，于是"没有模型凭据""上游 401"这类失败被吞成
   `summary is not a JSON object`，把排查方向指错了。已改为按 `kind` 判断并把提供方的原话带出来；
   流里一个文本都没吐时也单独报"模型没有返回任何文本"。
2. **调度器原来不带参数调脚本**，而脚本要求 `--latest`/`--session`/`--pending` 之一 ——
   定时任务会直接报"需要 --latest 或 --session"。`--pending` 就是为这个场景加的。





---

## 4. 升级到 0.1.6-alpha.2（阶段 2 的前置）

| 阶段 | 内容 | 判据 |
|---|---|---|
| A 备份与基线 | `backup.ps1` 全量备份；记录基线；引擎分支打 `hqz-dsh-pre-upgrade` | 备份可解、回滚点明确 |
| B 无风险演练（不碰线上） | 新版本检出构建 → 复制线上数据到 `.dsh-upgrade-check` → 另起端口 | 19 个旧会话能列出/打开/继续；10 个插件逐个挂载；286 个预设能起会话；网关仍工作；迁移可回滚 |
| C 修 | 脚本化替换 279 个预设的 `dsh-workflow-worker-thread` → `dsh-workflow-ptc`；修演练暴露的插件 API | 演练判据全绿 |
| D 切线上 | 停 3080 → 切版本 → 起 → 体检全绿 → 观察 | 出问题切回 `hqz-dsh-pre-upgrade` |

详见 `STATE.md §7`。

---

## 4.1 阶段 4：安装器（配置已就绪，等版本号）

**能开工的判据已经拿到**：`apps/desktop/.env.windows` 写好，unsigned 配置校验通过：

```
pnpm --dir apps/desktop exec tsx scripts/package-target.ts win-x64 --unsigned --check
→ desktop package: win-x64 local configuration valid; signing and notarization were not attempted
```

`.env.windows` 里三个决定（都是"本部署没有这个东西"的明确说法，而不是填个假值）：

| 配置 | 值 | 为什么 |
|---|---|---|
| `DSH_DESKTOP_APP_ID` | `com.hqz.dsh-client` | 自己的应用标识：安装目录、单实例锁、更新身份都按它算，可以和官方桌面端并存 |
| `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` | `none` | 本部署没有强制更新策略服务。填假 origin 会让客户端每 10 分钟轮询一个 404；填 `none` 则应用清单里**不带**这个字段，客户端根本不轮询（上游原来没有这条路径，是本轮加的一个小扩展，见提交 `395efadd02`） |
| `DOWNLOAD_TEST_ORIGIN` | `https://192.168.28.239:8443` | 打包校验要求一个合法 HTTPS 源；**unsigned 构建不会把它写进产物**（`update = unsigned ? undefined : …`），所以不会给客户端一个要去轮询的 feed |

**还差的只有版本号**：`apps/desktop/README.md` 明确要求每次打包前由用户确认完整版本串
（基线是 `0.1.6-alpha.2`，测试版按 `0.1.6-alpha.2.<YYYYMMDD>.<n>`）。确认后：

```powershell
cd C:\Users\bestarc\Desktop\dsh-desktop
pnpm run package:desktop:win:x64:unsigned
```

产物落在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，
预计 30–90 分钟、0.6–0.9 GB（首次还要下 7-Zip 工具集；NSIS 已缓存；
本机已有 VS 2022 BuildTools + Windows SDK + Python）。

## 4.2 阶段 4 的另一半：更新通道在本部署下**做不了**（已查实）

计划里的 B11「更新通道（electron-updater + 自建更新源）」在当前条件下无法交付，
原因不是没做，而是**上游的 unsigned 构建在构造上就没有更新面**：

```js
// apps/desktop/scripts/electron-builder-config.mjs
const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, …)
publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }],
publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(…),
```

于是：`publish: null` → **不生成 `app-update.yml`**，electron-updater 没有可对话的对象；
`publisherName` 为空 → 没有发布者身份。反过来，任何**非 unsigned** 的 Windows 构建，
`validateDesktopPackageEnvironment` 都会强制要求 EV 证书 + SignTool + 密钥容器 + PIN
（`DSH_DESKTOP_WINDOWS_*` 四项齐全），而本部署没有 EV 证书。

**结论**：想要客户端自更新，前提是**一张代码签名证书**（上游走的是 SafeNet EV token）。
在那之前，发新客户端 = 重新发一次安装包。这不是代码问题，是采购/流程决定。

**若以后拿到证书**，要补的是：① 一个能返回 `nightly.yml` 与安装包的静态源
（dsh 服务器已在分发执行器 zip，同一套 Range 续传能力可复用）；
② `.env.windows` 里的 `DOWNLOAD_TEST_ORIGIN` 指向它；③ 一次非 unsigned 的
`package:win:x64` + `upload:win:x64`。届时 `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`
仍可保持 `none`（强制更新策略与更新源是两件事）。


