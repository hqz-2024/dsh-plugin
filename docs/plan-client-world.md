# 客户端执行世界实施计划（dsh-client-world：工作区留在服务器，执行面搬到用户电脑）

> **目标**：让服务器上的 agent 能驱动**用户电脑上安装的软件**（Photoshop / Blender / Figma 等），并把用户机 localhost 上的服务接进来（Figma Dev Mode MCP）。
>
> **核心机制**：工作区文件**只有一份**，存在服务器上，通过 **SMB 共享**映射给用户电脑；agent 的文件工具仍跑在服务器本地盘上（路径不变、现有文件树不变、无需同步）；只有**进程执行**与**本机 localhost 访问**搬到用户电脑。

---

## 1. 可行性评估

### 1.1 结论

可行，且比"把整个执行世界搬过去"小得多。关键在于区分两件事：

| 执行面 | 放在哪 | 为什么 |
|---|---|---|
| **文件**（read/write/edit/glob/grep） | **服务器本地盘**（不变） | 工作区通过 SMB 让用户电脑看到同一份字节，**不存在第二份副本，也就不需要任何同步** |
| **进程**（spawn/terminal） | **用户电脑**（新） | 只有本机装了 PS/Blender |
| **本机 localhost**（Figma MCP 等） | **用户电脑**（新） | 服务器到不了客户端 loopback |

这直接消灭了原方案里最难的三块：同步/冲突、镜像元数据与按需拉取、fs 的远程协议。

### 1.2 引擎侧的依据（已核对源码）

| 依据 | 位置 | 说明 |
|---|---|---|
| `SubprocessRuntime` 是 abstract Service | `packages/subprocess/subprocess/src/index.ts:114` | 换 provider = 写一个 Service 子类；只有 3 个抽象成员：`resolveExecutable` / `spawn` / `spawnTerminal` |
| 架构文档明文 | `docs/architecture.md`（Capability seams） | 换 subprocess provider 会「把 Bash、PTY、LSP 一起带走，with no provider forks」 |
| 同形先例 | `packages/e2b/`（`subprocess-e2b`） | 其 README：「harness process, model calls, and session state never move — only the execution world is remote」 |
| 部署侧可解析引擎包（实测） | 本机 | 从 `~/.dsh/profiles/web/package.json` 可 resolve 到 `dsh-subprocess`、`dsh-subprocess-local`、`dsh-fs`、`dsh-tool-fs`、`dsh-mcp-client`（均指向引擎 checkout 的 `lib/`） |

**引擎 checkout 保持零改动**，符合 `dsh-development` 规则 1。

### 1.3 必须明确的边界

1. **路由键是「工作区」，不是「会话」。** `SubprocessRuntime.spawn(spec)` 带 `spec.cwd`，不带 agent/session 身份。所以绑定关系必须是 **工作区 ↔ 执行机 一对一**，路由链为 `cwd → 工作区 → 执行机`。反过来说：**一个工作区同一时刻只能被一台机器绑定**（见 §2.1）。
2. **SMB 是给"本机软件"用的，不是给 agent 用的。** agent 在服务器上直接读本地盘；SMB 的唯一消费者是用户本机的 GUI 程序（PS/Blender/Office）和用户本人。
3. **重软件不能直接在 SMB 上干活**（Adobe 官方立场 + Blender 已知问题，见 §4.1）。应对规则见 §2.6：**> 10MB 一律本机暂存**。
4. **没有屏幕控制。** 这条不因本方案改变：GUI 软件只能走它自己的脚本 / COM / MCP 接口。
5. **服务器沙箱约束不到客户端进程。** `spawn` 走客户端后，服务端的 argv 级沙箱不再适用。

---

## 2. 系统设计

### 2.0 最终呈现形式

```
用户电脑                                          服务器（共享一个实例）
┌────────────────────────────┐                   ┌────────────────────────────────┐
│ dsh-client-executor        │  出站 WS          │ dsh web :3080                  │
│  · 登录（复用 dsh-remote） │ ────────────────► │  · agent / 会话 / 模型调用      │
│  · 绑定工作区（SMB 凭据）   │                   │  · 工作区文件（服务器本地盘）    │
│  · proc.* / http.* 执行     │                   │  · 现有文件树/工作区面板（不变） │
└───────────┬────────────────┘                   └───────────┬────────────────────┘
            │ SMB（UNC）                                     │ HTTP
            └──────────────► 服务器工作区目录 ◄──────────────┘
                              浏览器（用户电脑 / 任意机器）
```

- **用户电脑**：一个 executor（先做成"Node + 本地配置页 + 开机自启"，稳定后再打包 exe）。启动后打开本地配置页 → 登录 → 选/绑定工作区。
- **浏览器**：不变，仍是 `http://192.168.28.239:3080/`，登录后左侧看到的就是服务器工作区，**和今天完全一样**。
- **能力随绑定开启**：
  - **未绑定**：纯服务器 agent（＝现在的形态），文件工具正常，不能跑本机软件。
  - **已绑定**：agent 的 `bash` / `terminal` 落到他电脑上，并且能访问本机 localhost。
- 用户**不需要知道**执行世界在哪；文件在左侧面板里的位置，和 PS 里 `\\server\ws-alice\a.psd` 是同一个文件。

### 2.1 工作区与绑定模型（核心）

复用引擎已有的 workspace 概念（`storages/workspace.json`，每条记录形如 `{path, title, sessionIds, createdAt, updatedAt}`，`path` 是宿主绝对路径）。新增三类事实：

| 新增 | 含义 |
|---|---|
| `授权` | 某账号可访问哪些工作区（由 admin 建账号时配置） |
| `绑定` | 某工作区当前绑定到哪台执行机（**同一时刻只允许一台**）、绑定时采用的可见路径（UNC 或盘符）、本机暂存目录 |
| `可见路径` | 该工作区对应的 SMB 共享名与客户端可见路径（UNC 优先） |

**这三类事实存在哪里（关键约束）**：引擎的 workspace 记录 schema 是固定的——`packages/workspace/workspace/src/spec.ts` 的 `workspaceRecord = {path, title, sessionIds, createdAt, updatedAt}`，domain `workspace` 版本 2，zod 校验在持久化边界执行。**往里加字段既会被 zod 丢掉、又属于引擎改动**，会破坏「引擎 checkout 零改动」。因此按主体拆开存：

| 事实 | 存放位置 | 理由 |
|---|---|---|
| `授权`（账号 → 可见工作区） | **dsh-remote 的账号记录** | 权限主体是账号，配置界面本来就在那儿（沿用现状，见 §2.5） |
| `绑定`（工作区 → 执行机 / 占用人 / 可见路径 / 暂存目录） | **部署侧自有存储域**（`@deepseek-ai/dsh-storage-domain` 的 `defineDomain` + `domainTable`；该包从部署侧可正常解析，已实测），键为 `workspaceId` | 生命周期属于工作区，与引擎的 workspace 域只靠 id 关联 |

工作区本身仍由引擎的 workspace 域拥有，部署侧不写它的记录。

规则（已拍板）：

- **工作区只能由服务端预先建立**，客户端不能新建。admin 在**账号配置界面**勾选该账号可访问的工作区。
- **绑定是可选的**。不绑定 = 浏览器里正常用，只是没有本机执行能力。
- **绑定冲突按占用是否活跃分两种处理**：
  - **活跃占用 → 直接拒绝，不抢占、不排队。** 第二台设备请求绑定一个正在被活跃占用的工作区时，拒绝，并在客户端配置页显示：**「该工作区正在被 <用户名> 访问」**。
  - **离线占用 → 直接允许绑定。** 占用机心跳超时后绑定自动失效（见下条），第二台设备无需等待、也无需 admin 介入。
- **心跳超时即自动失效（已拍板）**，配套设计如下，缺一不可：
  - executor 按固定间隔心跳（建议 15s），服务端超过宽限期（建议 120s，可配）未收到心跳即把绑定标记为失效；
  - **失效 ≠ 删记录**：失效只意味着"可被他人绑定"，绑定记录与失效原因保留，便于排查；
  - **原机重连不自动夺回**——否则又变成抢占。原机必须重新走一遍绑定；
  - **服务端重启后所有绑定一并失效**（心跳全部陈旧），重启后需要重新绑定，属于预期行为，要写进运维说明；
  - 两台设备同时抢一个已失效的绑定，由服务端单点仲裁：先到者成功，另一个收到拒绝。
- **此外仍需强制解绑出口**（针对"占用机还活着但用户忘了"的情况）：① 占用者在自己的配置页主动解绑；② admin 在界面强制解绑。绑定记录因此保存**占用人用户名 + 机器名 + 建立时间 + 最后心跳时间**。
- **路径翻译**：服务器看到的 `C:\dsh-workspaces\alice` 与客户端看到的 `\\192.168.28.239\ws-alice` 是同一份字节；executor 持有这条映射，`spawn` 前把 `spec.cwd` 翻译成客户端可见路径。

### 2.2 SMB 映射与路径翻译

- **优先用 UNC，不用盘符。** 映射盘符是**按登录会话**的（[Microsoft：服务和重定向的驱动器](https://learn.microsoft.com/zh-cn/windows/win32/Services/services-and-redirected-drives)）——如果 executor 以"不管用户是否登录都运行"的计划任务方式启动，它落在会话 0，映射的 `Z:` 在用户的交互式桌面里**根本看不到**。因此：**executor 必须跑在用户的交互式登录会话里**（登录后启动 / 用户级计划任务），并且优先直接把 UNC 路径交给软件。
- 凭据：用每账号的 SMB 凭据建立会话（`net use \\server\share /user:... ` 不带盘符，或 `cmdkey` 预存），ACL 与"账号可访问工作区"一致。
- 需要确认的前置条件：服务器已启用文件共享、客户端到服务器 **445 端口**可达、企业策略未禁用 SMB 出站或凭据保存。

### 2.3 组合归属（共享实例：只换 subprocess）

共享实例不变，只在 host 平面覆盖两行：

```yaml
- id: subprocess-local
  disabled: true
- id: client-subprocess
  name: dsh-local-bridge          # 导出 ClientSubprocess extends SubprocessRuntime
  config:
    # 未绑定 / cwd 不在任何已绑定工作区 → 回落服务器本地执行
    fallback: local
# 本机 localhost 转发（Figma Dev Mode MCP 等）
- id: client-relay
  name: dsh-local-bridge
  config:
    ports: [3845]                 # 白名单，只允许显式登记的本机服务
```

**`fs` 不动。** 因此：现有文件树、工作区面板、diff 卡片、附件、skill 文件读取、`file-reference` 全部保持现状——原方案里"不走 `ctx.fs` 的模块"这份风险清单直接消失。

### 2.4 executor 协议（大幅缩水）

出站 WebSocket + token，复用 `dsh-local-bridge` 已有的连接/token/路由设施：

**服务器 → executor**

| op | 载荷 | 说明 |
|---|---|---|
| `proc.resolveExecutable` | `command, env?` | 客户端 PATH 解析 |
| `proc.spawn` | `argv, cwd, env, stdio, grace` | 立刻返回句柄；pid / stdout / stderr / exit 走事件帧 |
| `proc.terminal` | `argv, cwd, env, cols, rows` | ConPTY 分配 |
| `proc.stdin` / `proc.signal` / `proc.resize` / `proc.close` | `procId, …` | 交互与终止 |
| `http.request` | `port, method, path, headers, body` | **转发到客户端 127.0.0.1**，支持分块/SSE 回传 |
| `bind.claim` / `bind.release` | `workspaceId`, 可见路径, 暂存目录 | 绑定/解绑；活跃占用时返回占用者用户名供客户端提示 |
| `bind.heartbeat` | `workspaceId` | 周期心跳（建议 15s）；服务端据此判活，超宽限期即失效 |
| `bind.status` | — | 当前绑定的工作区、可见路径、暂存目录、失效原因 |

**executor → 服务器**：`result` / `chunk`（带 `seq`）/ `exit` / `error` / `hello`（版本 + 主机名 + 绑定状态）。

设计要点：

- **同步 seam + 异步事实**：`spawn()` 立刻返回句柄，pid 与启动结果用事件帧回填（E2B 的 `pid: -1` 同款处理，可接受）。
- **背压与上限**：流带 `seq` 与窗口确认，避免 E2B 那条"宿主内存堆完整输出"的已知缺陷。
- **终止阶梯**：温和终止 → 宽限 → 强杀**整棵进程树**（修掉现有 sidecar「只杀直接子进程、Office/Blender 会残留」的毛病）。
- **环境**：客户端世界**需要**用户真实环境（PS/Blender 常只在用户 PATH 里），但必须剔除 `DSH_*` 与 token 形状的变量。
- **本机暂存**：> 10MB 的处理副本落在本机暂存目录（见 §2.6），完成后回写工作区。

### 2.5 executor 的登录与授权

现状短板是"管理员生成 token 复制给用户"。目标形态：

1. executor 首次启动打开本地配置页（`http://127.0.0.1:<本地端口>`）；
2. 页面上用现有 dsh-remote 的 `/auth/login`（含 TOTP）登录 → 服务器签发 **executor token**（绑定账号）；
3. 返回该账号**可绑定的工作区列表**（由 admin 建账号时配置）；
4. 用户选一个工作区 + 选本机暂存目录 → 建立 SMB 凭据 + 写入绑定记录；
5. 之后 executor 用该 token 常驻连接。

服务端需要新增的是一小块：**executor 授权端点**（登录 → token + 可绑定工作区列表 + 绑定/解绑 RPC，含"被占用"提示）。

**授权配置沿用现有账号配置界面（已拍板）**。`dsh-remote` 已有 `/auth/accounts` 的 `list / upsert / remove / disable-mfa` 与管理员界面，工作区授权作为**账号记录上的一个字段**（可见工作区 id 列表）加进那个表单即可，不新做一套管理页。三个必须一起处理的点：① 表单里的候选工作区要动态读引擎的 workspace 域（新增工作区后自动出现）；② 授权被撤销时该账号已建立的绑定要**强制解绑**；③ 账号停用/删除时其绑定一并失效。授权只存这一处，不做第二份表，避免两套数据源漂移。

建议分两步走，别一上来就打包 Electron/Tauri：先做「Node 进程 + 本地配置页」，稳定后再加 exe 外壳、托盘与自动更新。

### 2.6 本机暂存工作流（已拍板：> 10MB 一律本地暂存）

这条把"本机暂存"从例外变成**主路径**：

- **服务器工作区仍是唯一权威与归档**；本机暂存目录是 agent 显式拉起、显式回写的**临时工作副本**，不是第二个同步副本，因此不引入任何同步引擎与冲突解决。
- **判定点**：agent 用 `stat` 读文件大小即可（工作区 fs 工具跑在服务器本地，`size` 直接可得）。`> 10MB`，或属于重软件工程格式（PSD / .blend / 大素材），走暂存。
- **不需要新增 fs 能力**：`bash` 本就在客户端执行，`Copy-Item` 就能在工作区（UNC 路径）与本机暂存目录之间搬运。**前提是 agent 知道暂存目录在哪**——为此新增一个极小的只读能力：一个工具（如 `local_binding`）或一段注册的 prompt 段，返回 `{机器名, 工作区 UNC 路径, 暂存目录, 绑定状态}`。
- **暂存副本的生命周期要定死**：任务结束即回写并清理；上次未回写的残留要在下次绑定时提示用户。
- **正向副作用（重要）**：这条决定把 §4.1 的重软件风险大幅降级——PS / Blender **永远不在 SMB 上干活**（Adobe 明确不支持把网络位置作为暂存盘），SMB 只承担文本 / Office / PDF 这类轻量文件的直接读写。

### 2.7 与现有 `local_run` 的关系

- 过渡期并存：`local_run` 保留为逃生口（跑一次不常用 exe、应急排查）。
- token、账号映射、会话归属、`localBridge` 服务全部复用，不新建一套。
- executor 稳定后，`local_run` 的两处输入输出缺陷（`collect` 的文件字节模型看不到、`inputFiles` 的 base64 要走模型上下文）**在本方案下自然消失**——因为文件本来就在工作区里，不需要往返搬运。

---

## 3. 实施计划

### P0：路由与组合可行性 spike（不写业务代码，先证伪）

1. 起一个 `pilot` 实例（`dsh --profile pilot --port 3082`，从 `web` 改一份），把 `subprocess-local` 换成**假 provider**（只打印 `spec.cwd` 与 argv）。
2. 造两个工作区（一个"已绑定"、一个"未绑定"），验证：
   - `bash` 在已绑定工作区里跑 → 命中假 provider，且 `spec.cwd` 能反查到工作区与执行机；
   - `bash` 在未绑定工作区 / `_no-cwd` 里跑 → 回落本地（或按设计报错），语义明确；
   - `spawnTerminal` 的 `spec.cwd` 与 `spawn` 一致可用作路由键。
3. **最小 SMB 验证**（这步最容易翻车，先做）：在服务器开一个共享，客户端用 UNC 访问同一文件，验证：
   - 服务器端用 `read`/`write` 改文件，客户端软件与资源管理器立刻看到；
   - 客户端写入，服务器端立刻看到；
   - 445 端口、凭据、ACL 都通。
4. **SMB 边界实测（判据已降级）**：按 §2.6 的规则，重软件不在 SMB 上干活，所以这一步不再决定方案形态，而是标定边界——测 **8–10MB 边界文件**与 **Office 在 SMB 上的锁文件行为**，为「阈值是否需要下调」和「用户注意事项」提供数据。

**验收**：pilot 起得来 + `cwd → 工作区 → 执行机` 路由链被证明可行 + SMB 双向可见 + 边界与 Office 行为有数据。

### P1：executor 骨架 + 绑定

- executor：WS 连接、`hello`、**心跳**、绑定状态上报、本地配置页（登录 / 选工作区 / 选暂存目录 / 主动解绑）。
- 服务端：executor 授权端点、绑定记录（含最后心跳时间）、**活跃/离线判定与自动失效**、单点仲裁、admin 强制解绑、`client-subprocess` 骨架（`resolveExecutable` + 转发）。
- **验收**：用户自助登录并绑定；第二台设备绑同一工作区被拒绝且看到占用者用户名；占用机断网超过宽限期后第二台设备可直接绑定；解绑后能力立即消失。

### P2：subprocess 真正跑起来

- `spawn`（流式 stdout/stderr + 收集 + 溢出落盘）、路径翻译（服务器路径 → UNC）、进程树终止阶梯、断线语义（在跑进程视为结束、不泄漏）。
- **验收**：`bash` 能跑 PowerShell；超时终止不留孤儿进程（`tasklist` 可证）；未绑定会话行为不变。

### P3：交互式终端（ConPTY）

- `spawnTerminal` + stdin/resize/signal。
- **验收**：vim / python REPL 可用；终端会话 crashtest（关 executor、断网）不挂死。

### P4：本机 localhost 转发 + MCP

- `http.request` op + 服务器侧本地代理端点（`webServer.register`）+ 端口白名单。
- 接 Figma Dev Mode MCP（`http://127.0.0.1:3845/mcp`，需在 Figma 桌面 App 里手动开启，[官方文档](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)）。
- 注意：MCP StreamableHTTP 用 SSE 分块，代理必须忠实转发分块与 MCP session 头；白名单是硬要求，否则等于给 agent 一个访问用户机任意本地服务的通道。
- **验收**：Figma MCP 工具出现在会话工具表并能取回节点数据。

### P5：本机暂存工作流（主路径）+ 端到端验收

按 §2.6 落地，注意这是**主路径而非例外**（>10MB 一律走暂存），所以它需要自己的 skill 与用户须知：

- 绑定信息只读能力（`local_binding` 工具或 prompt 段）：把工作区 UNC 路径与本机暂存目录交给 agent。
- 暂存工作流的全局 skill：判定（`stat` 大小 / 工程格式）→ `Copy-Item` 签出 → 调本机软件 → 回写 → 清理。
- 三个真实场景端到端：Blender（`-b -P`）、Photoshop（COM/ExtendScript）、Figma（MCP）。
- 补 `AGENTS.md` / `README.md` / 用户须知（含"不要在 SMB 上直接双击大文件用 PS 打开"）；`local_run` 降级为逃生口。

---

## 4. 风险与开放问题

### 4.1 重软件在 SMB 上工作：已由「> 10MB 本地暂存」规则规避

**证据（保留，它解释了为什么必须有暂存规则）**：

- **Adobe 官方立场**：技术支持**只支持在本地硬盘上使用 Photoshop 和 Bridge**；「**Photoshop 不支持把网络或可移动驱动器作为暂存盘**」；官方推荐流程是"先在本地硬盘上工作，再拷贝到网络盘"（[Networks, removable media | Photoshop](https://helpx.adobe.com/photoshop/kb/networks-removable-media-photoshop.html)）。跨网络工作可能间歇性地报 `file is locked` / `disk error` / `unknown format`，且**损坏可能延迟出现且无法被察觉**。
- **Blender**：SMB 上的外部资源（Alembic、VDB 等）有已知的严重 I/O 性能问题（[#140266](https://projects.blender.org/blender/blender/issues/140266)、[#102990](https://projects.blender.org/blender/issues/102990)），社区甚至有专门"先存本地再搬到网络盘"的 addon 来绕过慢写入。

**已拍板的处理见 §2.6**：超过 10MB 一律本机暂存，因此 PS / Blender **永远不在 SMB 上干活**，风险被挡在工作流之外。

**残余风险（P0 实测判据已相应降级为"标定边界 + 写用户须知"）**：

1. **用户可能自己绕过**——直接在资源管理器里双击 SMB 上的大文件用 PS 打开。agent 工作流管不到，只能写进用户须知。
2. **8–10MB 的边界文件**仍走 SMB 直用，要确认这个区间没有实际痛感（否则阈值下调）。
3. **Office 仍可能踩坑**——Office 会产生大量临时文件与锁文件，SMB 上的行为（尤其多进程同时打开）需要实测。

### 4.2 工作区绑定的并发语义（已拍板）

**已定**：

- **活跃占用 → 拒绝**，客户端显示「该工作区正在被 <用户名> 访问」。
- **心跳超时 → 自动失效**。心跳建议 15s、宽限期建议 120s（都可配）；失效只表示"可被他人绑定"，记录保留便于排查。
- **原机重连不自动夺回**，必须重新绑定（否则又变成抢占）。
- **服务端重启后绑定全部失效**，属预期行为，写进运维说明。
- **同时抢一个失效绑定 → 服务端单点仲裁，先到者成功。**
- 另配两条人工出口：占用者主动解绑、admin 强制解绑。

**必须接受的代价（要写进用户须知）**：用户合上笔记本 / 午休关掉 executor / 网络抖动超过宽限期，都会让出工作区；等他回来时可能已经被别人绑走，需要重新绑定。宽限期就是这个体验的调节旋钮——调大更宽容但换机器时要等更久。

**心跳间隔与宽限期是部署可变的旋钮**，按仓库规范应做成 Config 字段（可写进 `cordis.patch.yml`），不写死常量。

### 4.3 SMB 基础设施

- 服务器要开文件共享；客户端 445 可达；企业策略可能禁用 SMB 出站或凭据保存——**部署前必须确认**。
- 映射盘符按登录会话隔离，所以 **executor 必须在用户的交互式会话里运行**；用 UNC 更稳。
- 凭据生命周期：改密码/停用账号时，SMB 凭据要同步失效。

### 4.4 服务器沙箱在客户端进程上失效

`spawn` 走客户端后，服务端的 argv 级沙箱不再适用（当前部署 `permission.defaultPreset: danger-full-access` 本就未拦）。若将来要管控，只能在 executor 侧做程序白名单/参数模板。

### 4.5 未绑定会话的语义

未绑定 = 回落服务器本地执行。要明确：这是"静默降级"还是"明确提示"？建议 `fallback: local` 只是兜底，**用户在 UI 上要能看到"当前会话没有本机执行能力"**，否则 agent 会在服务器上跑用户的命令（例如 `pip install`），结果莫名其妙。

### 4.6 断线语义

executor 掉线时：正在执行的 tool call 必须有确定结局（视为失败，不是挂起）；在跑的进程按"视为结束"处理且不泄漏。P2 定死。

### 4.7 Windows 特有

- `spawn` 的 cwd 可能是 UNC 路径，而 **UNC 不能作为进程工作目录**（`cmd`/部分程序会拒绝）。路径翻译时要处理：优先把工作区映射到一个**本地盘符**用于 `cwd`，或退到临时目录 + 绝对路径传参。
- 长路径（>260）、大小写不敏感、保留名（`CON`/`NUL`）。
- ConPTY 需 Windows 10 1809+；`node-pty` 是原生模块，优先选带预编译二进制版本。

### 4.8 性能基准（未测，需补）

SMB 往返延迟 vs 本机盘：轻量文件无感；大文件与随机读写差异明显。P0 应记录一份基准，作为"哪些工作负载适合 SMB 直用"的判据。

### 4.9 共享实例的既有缺口（已知并接受）

dsh-remote README 明确：DSH 核心是单租户（`$DSH_HOME` 进程级共享），事件流、搜索、任务等全局泄漏无法在插件层隔离。本方案**维持现状**，不使它变差；「工作区即边界」在文件层面提供了额外约束。选共享实例换来的是：内存 1×、工作区集中定义、admin 一处可见全部会话。

---

## 5. 附录

### 5.1 已核实的环境事实

**服务器现状（实测）**

| 项 | 值 |
|---|---|
| dsh 进程 | `node --import tsx/esm apps/cli/src/bin.ts --profile web --trusted-host 192.168.28.239`（PID 16628），引擎源码启动 |
| 单实例常驻内存 | **591 MB** 工作集 / 751 MB 私有字节（跑了 5.7h、带多会话；冷启动更低，长会话会上涨） |
| 单实例 CPU | 平均 **2.5%**（12 核），agent 大部分时间在等模型 API |
| 服务器 | 32 GB RAM（空闲 17 GB）、12 核 |
| 句柄 / 线程 | 936 / 27 |

→ 共享实例与每用户一进程的差别是**线性常数倍**（约 +0.6 GB/实例），不是数量级；本部署规模下性能不是决定因素，隔离性与运维才是。

**引擎可解析性**（从 `~/.dsh/profiles/web/package.json` 起，实测）

- 成功：`dsh-tools`、`dsh-fs`、`dsh-fs-local`、`dsh-subprocess`、`dsh-subprocess-local`、`dsh-tool-fs`、`dsh-mcp-client`、`dsh-agent-presets`、`dsh-terminal`、`dsh-terminal-bash`
- 失败：`dsh-e2b`、`dsh-fs-e2b`、`dsh-shell-bash`、`dsh-lsp`

**其他**

- `dsh --profile web --port 8080` 有效（`packages/boot/cmdline` 提供 `ctx.webStartup.port`，`packages/bundle/web-app/cordis.patch.yml` 写 `port: !!js ctx.webStartup.port ?? 3080`，flag 优先）。
- 工作区现状：`storages/workspace.json`（version 2），4 条记录，每条 `{path, title, sessionIds, createdAt, updatedAt}`，`path` 是宿主绝对路径。
- 会话可见性：`session.list` 的可选 `scopeUser` 由认证网关盖章并过滤（`.dsh/docs/agent-notes/2026-09-02-session-visibility-scope.md`）；服务器本机 loopback 走 DSH 原生 host-backed 路径、插件不介入，因此共享实例下 admin 在 `127.0.0.1:3080` 可见全部会话。
- 当前 Caddyfile 只有一条站点：`https://192.168.28.239:8443 → reverse_proxy 127.0.0.1:3080`（`tls internal`）。
- 现有 sidecar（`dsh-local-bridge`）的已知硬限制：一次性进程、无持久会话、无 stdin、超时只杀直接子进程、stdout/stderr 各 1MB、`collect` 的文件字节不进模型上下文、`inputFiles` 的 base64 要走模型上下文。本方案下 churn 掉前四项，后两项因"文件本就在工作区"而自然消失。

### 5.2 参考

- 引擎架构与 capability seam：`docs/architecture.md`
- 执行世界外移的先例与理由：`packages/e2b/README.md`、`.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md`
- subprocess provider 接口：`packages/subprocess/subprocess/src/index.ts`
- 组合与 realm 规则：`packages/preset/agent-presets/README.md`、`.dsh/skills/dsh-development/SKILL.md`
- Photoshop 网络位置限制：https://helpx.adobe.com/photoshop/kb/networks-removable-media-photoshop.html
- Windows 映射盘符的会话隔离：https://learn.microsoft.com/zh-cn/windows/win32/Services/services-and-redirected-drives
- Blender SMB 性能问题：https://projects.blender.org/blender/blender/issues/140266
- Figma Dev Mode MCP 本机端点：https://developers.figma.com/docs/figma-mcp-server/local-server-installation/

---

## 6. 决策记录与待定项

### 6.1 已拍板

| 决策 | 结论 | 落点 |
|---|---|---|
| 拓扑 | 共享实例 + 工作区路由（不用每用户一进程） | §2.1 §2.3 |
| 文件模型 | 单副本走 SMB；`ctx.fs` 不动，只换 subprocess | §1.1 §2.3 |
| 绑定冲突（活跃占用） | **直接拒绝**，提示「该工作区正在被 <用户名> 访问」 | §2.1 §4.2 |
| 绑定冲突（离线占用） | **心跳超时即自动失效**，允许他人直接绑定；原机重连不自动夺回 | §2.1 §4.2 |
| 绑定解绑 | 占用者主动解绑 + admin 强制解绑（针对"占用机还活着但用户忘了"） | §2.1 §4.2 |
| 重软件阈值 | **> 10MB 一律本机暂存** | §2.6 |
| 工作区授权 | **沿用现有账号配置界面**，授权作为账号记录上的字段 | §2.5 |
| 授权撤销 | 撤销授权即强制解绑；账号停用/删除，绑定一并失效 | §2.5 |
| 存储归属 | 授权存账号记录；绑定存部署侧自有存储域。**引擎零改动** | §2.1 |

### 6.2 待定项

| # | 问题 | 影响阶段 | 倾向 |
|---|---|---|---|
| 1 | 心跳间隔与宽限期的具体取值（建议 15s / 120s，做成 Config 字段） | P1 | 先按建议值上线，用户反馈后调 |
| 2 | 未绑定会话是静默降级还是明确提示 | P2 | 明确提示，会话头部显示当前执行能力 |
| 3 | 暂存副本的生命周期：何时回写、残留如何清理与提示 | P3 | 任务结束即回写并清理；残留下次绑定时提示 |
| 4 | 暂存工作流由谁发起：agent 自行判断，还是给 skill / 专用工具 | P3 | 全局 skill + 约定的暂存目录 |
| 5 | executor 的分发与更新（复用下载端点；exe 阶段还要自动更新通道） | P1 | 先复用 `/dsh-local-bridge/sidecar.mjs` 式端点 |
| 6 | 回滚路径：executor 出问题时一键退回纯服务器形态 | P1 | `disabled` 掉 `client-subprocess` 重启；写进运维手册 |
| 7 | 性能基准：SMB vs 本机盘的延迟/吞吐 | P0 | 出基准表，作为"哪些负载适合 SMB 直用"的判据 |
| 8 | Figma 的人工前置：用户须先打开桌面 App 并在 Dev Mode 启用 MCP server | P4 | 写进用户手册 |
| 9 | 工作量估算与排期 | 全部 | P0 完成后按实测回填 |
