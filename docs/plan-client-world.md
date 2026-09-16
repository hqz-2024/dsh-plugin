# 客户端执行世界实施计划（dsh-client-world：工作区留在服务器，执行面按需搬到用户电脑）

> **目标**：让服务器上的 agent 能驱动**用户电脑上安装的软件**（Photoshop / Blender / Figma 等），并把用户机 localhost 上的服务接进来（Figma Dev Mode MCP）。**v1**：工作区绑定后，该工作区的任务自动落到用户电脑上执行；**v2**：再加一个对话框下拉框，允许逐会话显式覆盖。
>
> **核心机制**：工作区文件**只有一份**，存在服务器上，通过 **SMB 共享**映射给用户电脑；agent 的文件工具始终跑在服务器本地盘上（路径不变、现有文件树不变、无需同步）；**进程执行**与**本机 localhost 访问**按会话模式决定落在哪台机器。

---

## 1. 可行性评估

### 1.1 结论

可行，且比"把整个执行世界搬过去"小得多。关键在于把三个执行面分开：

| 执行面 | 放在哪 | 为什么 |
|---|---|---|
| **文件**（read/write/edit/glob/grep） | **始终在服务器本地盘** | 工作区通过 SMB 让用户电脑看到同一份字节，**不存在第二份副本，也就不需要任何同步** |
| **进程**（spawn/terminal） | **v1 按绑定、v2 按会话覆盖**：已绑定 → 用户电脑；否则 → 服务器 | 只有用户电脑装了 PS/Blender；但纯服务器任务不该被拖到客户端 |
| **本机 localhost**（Figma MCP 等） | 用户电脑（仅本地执行时需要） | 服务器到不了客户端 loopback |

这直接消灭了原方案里最难的三块：同步/冲突、镜像元数据与按需拉取、fs 的远程协议。

### 1.2 引擎侧的依据（已核对源码与实时运行时）

| 依据 | 位置 | 说明 |
|---|---|---|
| `SubprocessRuntime` 是 abstract Service | `packages/subprocess/subprocess/src/index.ts:114` | 换 provider = 写一个 Service 子类；只有 3 个抽象成员：`resolveExecutable` / `spawn` / `spawnTerminal` |
| 架构文档明文 | `docs/architecture.md`（Capability seams） | 换 subprocess provider 会「把 Bash、PTY、LSP 一起带走，with no provider forks」 |
| 同形先例 | `packages/e2b/`（`subprocess-e2b`） | 其 README：「harness process, model calls, and session state never move — only the execution world is remote」 |
| **会话内可切换模式的先例** | `packages/plan/plan-mode` | log-only whole-value-replace 事件 + prompt 段 + session projection；「Mode transitions do not change the tool catalog」——正是本方案需要的性质 |
| **对话框内控件的现成插槽** | 实时 Slot 树（`cordis_inspect`） | `conversation.input.left`（list，`replaceRisk: none`）就是"对话框工具行左侧的紧凑控件"；同排已有 `conversation.input.model`（下拉框）与 `conversation.input.plan`（模式开关） |
| 部署侧可解析引擎包（实测） | 本机 | 从 `~/.dsh/profiles/web/package.json` 可 resolve 到 `dsh-subprocess`、`dsh-subprocess-local`、`dsh-fs`、`dsh-tool-fs`、`dsh-mcp-client`、`dsh-storage-domain`（均指向引擎 checkout 的 `lib/`） |

**引擎 checkout 保持零改动**，符合 `dsh-development` 规则 1。

### 1.3 必须明确的边界

1. **v1 不需要会话身份，v2 需要。** `SubprocessRuntime.spawn(spec)` 只拿到 `spec.cwd`，不拿到 agent/session。因为 **v1 的执行位置完全由工作区绑定决定**，`cwd → 工作区 → 执行机` 就足够了——**本方案 v1 没有这一层的技术风险**。风险只在 v2 的显式覆盖里出现：覆盖是会话级的，同一工作区在两个会话里可以一个走本地、一个走服务器，`cwd` 不足以区分。见 §2.8.4。
2. **SMB 是给"本机软件"用的，不是给 agent 用的。** agent 在服务器上直接读本地盘；SMB 的消费者是用户本机的 GUI 程序（PS/Blender/Office）和用户本人。
3. **重软件不能直接在 SMB 上干活**（Adobe 官方立场 + Blender 已知问题，见 §4.1）。应对规则见 §2.6：本地执行下 **> 10MB 一律本机暂存**。
4. **同一个会话里会出现两种路径形态**：`read`/`write` 用服务器路径，`bash` 的 cwd 是 UNC 路径，两者指向同一份字节。提示词必须解释清楚，否则模型会把它们当成两个文件（见 §2.8）。
5. **没有屏幕控制。** 这条不因本方案改变：GUI 软件只能走它自己的脚本 / COM / MCP 接口。
6. **服务器沙箱约束不到客户端进程。** `spawn` 落到客户端后，服务端的 argv 级沙箱不再适用。

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
- **浏览器**：仍是 `http://192.168.28.239:3080/`，左侧看到的就是服务器工作区，**和今天完全一样**。
- **执行位置默认由绑定决定**：工作区**未绑定 → 服务器**（＝今天的行为，一字不变）；工作区**已绑定 → 落在用户电脑上**。v2 会在对话框加一个下拉框，允许**逐会话显式覆盖**（见 §2.8）。
- 文件在左侧面板里的位置，和 PS 里 `\\server\ws-alice\a.psd` 是同一个文件。

### 2.1 工作区与绑定模型（核心）

复用引擎已有的 workspace 概念（`storages/workspace.json`，每条记录形如 `{path, title, sessionIds, createdAt, updatedAt}`，`path` 是宿主绝对路径）。新增三类事实：

| 新增 | 含义 |
|---|---|
| `授权` | 某账号可访问哪些工作区（由 admin 建账号时配置） |
| `绑定` | 某工作区当前绑定到哪台执行机（**同一时刻只允许一台**）、占用人、绑定时采用的可见路径（UNC 或盘符）、本机暂存目录 |
| `可见路径` | 该工作区对应的 SMB 共享名与客户端可见路径（UNC 优先） |

**这三类事实存在哪里（关键约束）**：引擎的 workspace 记录 schema 是固定的——`packages/workspace/workspace/src/spec.ts` 的 `workspaceRecord = {path, title, sessionIds, createdAt, updatedAt}`，domain `workspace` 版本 2，zod 校验在持久化边界执行。**往里加字段既会被 zod 丢掉、又属于引擎改动**，会破坏「引擎 checkout 零改动」。因此按主体拆开存：

| 事实 | 存放位置 | 理由 |
|---|---|---|
| `授权`（账号 → 可见工作区） | **dsh-remote 的账号记录** | 权限主体是账号，配置界面本来就在那儿（沿用现状，见 §2.5） |
| `绑定`（工作区 → 执行机 / 占用人 / 可见路径 / 暂存目录） | **部署侧自有存储域**（`@deepseek-ai/dsh-storage-domain` 的 `defineDomain` + `domainTable`；已实测可解析），键为 `workspaceId` | 生命周期属于工作区，与引擎的 workspace 域只靠 id 关联 |

工作区本身仍由引擎的 workspace 域拥有，部署侧不写它的记录。

规则（已拍板）：

- **工作区只能由服务端预先建立**，客户端不能新建。admin 在**账号配置界面**勾选该账号可访问的工作区。
- **绑定是可选的**。不绑定 = 浏览器里正常用，只是没有本机执行能力。
- **绑定冲突按占用是否活跃分两种处理**：
  - **活跃占用 → 直接拒绝，不抢占、不排队。** 第二台设备请求绑定一个正在被活跃占用的工作区时，拒绝，并在客户端配置页显示：**「该工作区正在被 <用户名> 访问」**。
  - **离线占用 → 直接允许绑定。** 占用机心跳超时后绑定自动失效（见下条），第二台设备无需等待、也无需 admin 介入。
- **心跳超时即自动失效（已拍板）**：
  - executor 按固定间隔心跳（建议 15s），服务端超过宽限期（建议 120s，可配）未收到心跳即把绑定标记为失效；
  - **失效 ≠ 删记录**：失效只意味着"可被他人绑定"，绑定记录与失效原因保留，便于排查；
  - **原机重连不自动夺回**——否则又变成抢占。原机必须重新走一遍绑定；
  - **服务端重启后所有绑定一并失效**（心跳全部陈旧），重启后需要重新绑定，属预期行为，写进运维说明；
  - 两台设备同时抢一个已失效的绑定，由服务端单点仲裁：先到者成功，另一个收到拒绝。
- **此外仍需强制解绑出口**（针对"占用机还活着但用户忘了"）：① 占用者在自己的配置页主动解绑；② admin 在界面强制解绑。绑定记录因此保存**占用人用户名 + 机器名 + 建立时间 + 最后心跳时间**。
- **模式与绑定的权限一致性（安全要求）**：本地执行时，执行机**必须是该会话账号自己绑定的那台机器**。若会话账号 ≠ 当前绑定的占用人（工作区被别人绑走了），**本地执行必须拒绝并提示占用者**，绝不能把 A 的命令发到 B 的电脑上。
- **路径翻译**：服务器看到的 `C:\dsh-workspaces\alice` 与客户端看到的 `\\192.168.28.239\ws-alice` 是同一份字节；executor 持有这条映射，`spawn` 前把 `spec.cwd` 翻译成客户端可见路径。

### 2.2 SMB 映射与路径翻译

- **优先用 UNC，不用盘符。** 映射盘符是**按登录会话**的（[Microsoft：服务和重定向的驱动器](https://learn.microsoft.com/zh-cn/windows/win32/Services/services-and-redirected-drives)）——如果 executor 以"不管用户是否登录都运行"的计划任务方式启动，它落在会话 0，映射的 `Z:` 在用户的交互式桌面里**根本看不到**。因此：**executor 必须跑在用户的交互式登录会话里**（登录后启动 / 用户级计划任务），并且优先直接把 UNC 路径交给软件。
- 凭据：用每账号的 SMB 凭据建立会话（`net use \\server\share /user:... ` 不带盘符，或 `cmdkey` 预存），ACL 与"账号可访问工作区"一致。
- 需要确认的前置条件：服务器已启用文件共享、客户端到服务器 **445 端口**可达、企业策略未禁用 SMB 出站或凭据保存。

### 2.3 组合归属（共享实例）

共享实例不变，host 平面新增三行、禁用一行：

```yaml
- id: subprocess-local
  disabled: true                    # 由下面这个「按绑定分派」的实现取代
- id: subprocess-dispatch
  name: dsh-local-bridge            # extends SubprocessRuntime：按 spec.cwd → 工作区 → 绑定分派
  config:
    serverRuntime: '@deepseek-ai/dsh-subprocess-local'   # 未绑定 / 不属于任何工作区时走它
- id: client-relay
  name: dsh-local-bridge            # 本机 localhost 转发（Figma Dev Mode MCP 等）
  config:
    ports: [3845]                   # 白名单，只允许显式登记的本机服务
```

**分派规则（v1，确定性，无隐式降级）**：`spec.cwd` → 该路径属于哪个工作区 → 该工作区是否已绑定 → 已绑定则转发给对应 executor（含路径翻译），否则在服务器本地执行。`cwd` 不属于任何工作区（如 `_no-cwd` 或临时目录）同样走服务器——这是**定义好的规则**，不是"静默降级"。

v2 的显式覆盖会再加一个 `exec-mode` 行与一个会话级判断（见 §2.8）。

**`fs` 不动。** 因此：现有文件树、工作区面板、diff 卡片、附件、skill 文件读取、`file-reference` 全部保持现状——原方案里"不走 `ctx.fs` 的模块"这份风险清单直接消失。

### 2.4 executor 协议

出站 WebSocket + token，复用 `dsh-local-bridge` 已有的连接/token 设施。**方向划分**：绑定与授权的判定在服务器侧（服务器是权威），executor 只上报状态并执行。

**服务器 → executor**

| op | 载荷 | 说明 |
|---|---|---|
| `proc.resolveExecutable` | `command, env?` | 客户端 PATH 解析 |
| `proc.spawn` | `argv, cwd, env, stdio, grace` | 立刻返回句柄；pid / stdout / stderr / exit 走事件帧 |
| `proc.terminal` | `argv, cwd, env, cols, rows` | ConPTY 分配 |
| `proc.stdin` / `proc.signal` / `proc.resize` / `proc.close` | `procId, …` | 交互与终止 |
| `http.request` | `port, method, path, headers, body` | **转发到客户端 127.0.0.1**，支持分块/SSE 回传 |
| `bind.apply` | `workspaceId, 可见路径, 暂存目录` | 服务端批准绑定后，令 executor 建立 SMB 凭据并进入占用态 |
| `bind.drop` | `reason` | 令 executor 放弃占用（被抢占/被解绑/被撤销授权） |

**executor → 服务器**

| 消息 | 载荷 | 说明 |
|---|---|---|
| `hello` | 版本、主机名、**操作系统版本**、绑定状态 | 首次连接与重连时上报；OS 信息进提示词（§2.8） |
| `bind.request` | `workspaceId, 暂存目录` | 用户在配置页点"绑定" |
| `bind.heartbeat` | `workspaceId` | 周期心跳（建议 15s） |
| `chunk` / `exit` / `result` / `error` | 带 `seq` 与 `procId` | 流式与一次性结果 |

设计要点：

- **同步 seam + 异步事实**：`spawn()` 立刻返回句柄，pid 与启动结果用事件帧回填（E2B 的 `pid: -1` 同款处理，可接受）。
- **背压与上限**：流带 `seq` 与窗口确认，避免 E2B 那条"宿主内存堆完整输出"的已知缺陷。
- **终止阶梯**：温和终止 → 宽限 → 强杀**整棵进程树**（修掉现有 sidecar「只杀直接子进程、Office/Blender 会残留」的毛病）。
- **环境**：客户端执行**需要**用户真实环境（PS/Blender 常只在用户 PATH 里），但必须剔除 `DSH_*` 与 token 形状的变量。
- **本机暂存**：本地执行下 > 10MB 的处理副本落在本机暂存目录（见 §2.6），完成后回写工作区。

### 2.5 executor 的登录与授权

现状短板是"管理员生成 token 复制给用户"。目标形态：

1. executor 首次启动打开本地配置页（`http://127.0.0.1:<本地端口>`）；
2. 页面上用现有 dsh-remote 的 `/auth/login`（含 TOTP）登录 → 服务器签发 **executor token**（绑定账号）；
3. 返回该账号**可绑定的工作区列表**（由 admin 建账号时配置）；
4. 用户选一个工作区 + 选本机暂存目录 → 建立 SMB 凭据 + 写入绑定记录；
5. 之后 executor 用该 token 常驻连接并心跳。

服务端需要新增的是一小块：**executor 授权端点**（登录 → token + 可绑定工作区列表 + 绑定/解绑 RPC，含"被占用"提示）。

**授权配置沿用现有账号配置界面（已拍板）**。`dsh-remote` 已有 `/auth/accounts` 的 `list / upsert / remove / disable-mfa` 与管理员界面，工作区授权作为**账号记录上的一个字段**（可见工作区 id 列表）加进那个表单即可，不新做一套管理页。三个必须一起处理的点：① 表单里的候选工作区要动态读引擎的 workspace 域（新增工作区后自动出现）；② 授权被撤销时该账号已建立的绑定要**强制解绑**（并给 executor 发 `bind.drop`）；③ 账号停用/删除时其绑定一并失效。授权只存这一处，不做第二份表。

建议分两步走，别一上来就打包 Electron/Tauri：先做「Node 进程 + 本地配置页」，稳定后再加 exe 外壳、托盘与自动更新。

### 2.6 本机暂存工作流（已拍板：本地执行下 > 10MB 一律本地暂存）

**仅在本地执行时生效**（在服务器执行时文件本就在服务器本地盘，没有暂存问题）。这条把"本机暂存"从例外变成本地执行的**主路径**：

- **服务器工作区仍是唯一权威与归档**；本机暂存目录是 agent 显式拉起、显式回写的**临时工作副本**，不是第二个同步副本，因此不引入任何同步引擎与冲突解决。
- **判定点**：agent 用 `stat` 读文件大小即可（fs 工具跑在服务器本地，`size` 直接可得）。`> 10MB`，或属于重软件工程格式（PSD / .blend / 大素材），走暂存。
- **不需要新增 fs 能力**：本地执行时 `bash` 已落在客户端，`Copy-Item` 就能在工作区（UNC 路径）与本机暂存目录之间搬运。**前提是 agent 知道暂存目录在哪**——由 §2.8.3 的 v1 提示词段与只读工具提供。
- **暂存副本的生命周期要定死**：任务结束即回写并清理；上次未回写的残留要在下次绑定时提示用户。
- **正向副作用（重要）**：这条决定把 §4.1 的重软件风险大幅降级——PS / Blender **永远不在 SMB 上干活**（Adobe 明确不支持网络位置作为暂存盘），SMB 只承担文本 / Office / PDF 这类轻量文件的直接读写。

### 2.7 与现有 `local_run` 的关系

- 过渡期并存：`local_run` 保留为逃生口（跑一次不常用 exe、应急排查）。
- token、账号映射、会话归属、`localBridge` 服务全部复用，不新建一套。
- executor 稳定后，`local_run` 的两处输入输出缺陷（`collect` 的文件字节模型看不到、`inputFiles` 的 base64 要走模型上下文）**在本方案下自然消失**——因为文件本来就在工作区里，不需要往返搬运。

### 2.8 执行位置的显式覆盖：本地处理 / 服务器处理（**v2**）

v1 的执行位置由绑定唯一决定（§2.3）。这一层是**逃生阀**，不是主开关：让用户能在**已绑定的工作区**里，把某一次任务显式切回服务器——例如用服务器上的 ripgrep / python 跑批处理，而不必先把工作区解绑。

没有它会怎样（这就是它存在的理由）：工作区一旦绑定，该工作区里**所有**命令都落到用户电脑上，包括本该在服务器跑的文本处理；服务器的工具链被绕开，客户端装了什么就成了整个工作区的天花板。

因为它只是覆盖层，所以可以推迟到 v2；但它的存在解释了 v1 的默认值为什么是「已绑定 → 本地」（见 §2.8.5）。

#### 2.8.1 状态与呈现

- **对话框下拉框**：注册到 `conversation.input.left`（list 插槽，`replaceRisk: none`，加法不改现有 UI）。同排已有模型选择器与 plan 开关可参照。
- **两个选项**：`服务器处理`（默认）/ `本地处理`。
- **不可用时禁用并说明原因**（而不是让用户切过去再报错）：本地处理要求 ① 该会话所属工作区已授权给本账号、② 该工作区已绑定且占用人是本账号、③ executor 在线。

#### 2.8.2 状态存储（照抄 plan-mode 的形状）

- **一个 log-only 的 whole-value-replace 事件** `exec/mode`（值 `local` | `server`），最后一次记录的值就是状态；恢复、fork、压缩都靠折叠日志还原。**这是引擎的硬要求**：Model-visible ⟺ logged，任何进入模型请求的东西都必须能从日志重建，模式变更不能只存在界面状态里。
- **一个 session projection unit**（plan 注册的是 `plan`，输出 `{active, pending}`），给下拉框读 `{mode, pending}`，保证多标签页一致、重启后仍在。
- 是否加 `/exec` 命令是可选的（纯 UI 驱动也能工作）；若要，走 `ctx.commands`，与 `/plan` 同款。

#### 2.8.3 提示词

注册一个 prompt 段（plan 用的是 order 500），内容包含：

1. **当前模式**（切换时作为会话事件让模型看见，plan-mode 有"switch notice"的现成做法）；
2. **executor 的实现形式**：它是什么、能做什么、命令在哪台机器上执行；
3. **客户端操作系统**（由 executor 在 `hello` 上报，写进绑定记录）；
4. **路径对照说明**（见 §1.3 第 4 条）：`read`/`write` 用服务器路径，`bash` 的 cwd 是 UNC 路径，**两者是同一个文件**——不写清楚模型会用两种路径描述同一个文件，甚至以为有两份。

**归属划分**：要素 **2、3、4 属于 v1**——工作区一旦绑定，执行位置就已确定，agent 必须立刻知道自己在用户电脑上、以及两种路径指的是同一个文件，否则会做出错误假设。只有要素 **1（当前模式）属于 v2**。

**两个约束**：① v2 切换模式会改系统提示词，从该段起的前缀缓存失效（plan-mode 同样付出这个代价）；② 因此 executor 信息（OS、主机名）要**稳定**，绑定后不再变化，避免每次请求渲染出不同文本——v1 的这段提示词在绑定存续期内是常量。

#### 2.8.4 路由（v2 前置，v1 不受影响）

`SubprocessRuntime.spawn(spec)` 不带会话身份，而**模式是会话级的**——同一工作区在两个会话里可以一个走本地、一个走服务器，所以 `cwd` 不足以当路由键。三条候选：

| 方案 | 做法 | 评价 |
|---|---|---|
| **a. 模式感知的消费者** | fork shell / terminal 工具：工具执行时能从 `ToolRunContext` 拿到 `exec.agent.session`，读投影得到模式，再决定调服务器还是客户端后端 | **最直接、依赖已文档化的扩展点**；代价是放弃「Bash/PTY/LSP 一起走」，且要 fork 两个工具包 |
| **b. agent 作用域的 provider** | 在会话 scope 上挂一个读模式的 `subprocess` 实现，零消费者改动 | 最优雅，但**会话中期换实现**是否被 Cordis scope 支持需要 P0 实测 |
| **c. `spec.env` 标记** | 模式插件给 agent 贡献一个环境项（如 `DSH_EXEC_TARGET`），分派 provider 读 `spec.env` | 若 shell 消费者会把插件贡献的环境项放进 `spec.env`，则零 fork；需实测消费者的 env 组装方式 |
| c'. `cwd` 作路由键 | 本地执行用客户端可见路径当 cwd | **与 `ctx.fs` 冲突**（服务器 fs 解析不了 UNC），不推荐 |

**v2 的 P6 前置 spike 依次验证 a → c → b**，任一条成立即可定型。v1 不依赖这一步。

#### 2.8.5 语义（要定清楚的几条）

- **中途切换是安全的**：文件是同一份（SMB）、工具表不变，只是后续命令落到另一个系统。这比"切预设"安全得多（引擎禁止会话中途换预设）。
- **切换不影响已在运行的进程**：它们在原系统上跑完；新启动的命令按新模式走。
- **模型可能会记错**：它可能"记得"自己在本地建了文件，切到服务器后按服务器路径去找。所以切换必须让模型看见（§2.8.3 第 1 条）。
- **默认值**：会话未显式选择时**按绑定推断**——**已绑定 → 本地，未绑定 → 服务器**。这个方向的失败模式更友好：用户忘记切换时，最坏结果是命令在自己电脑上跑完（慢一点但出结果），而不是在服务器上找不到 Photoshop 而失败。
- **断电/掉绑定的处理**：本地执行下 executor 掉线，后续 `spawn` 必须**明确失败**并提示"本地执行不可用"，不静默改到服务器执行。

---

## 3. 实施计划

### P0：v1 可行性 spike（不写业务代码，先证伪）

1. **`cwd → 工作区 → 执行机` 分派链**：起 `pilot` 实例（`dsh --profile pilot --port 3082`，从 `web` 改一份），把 `subprocess-local` 换成**假 provider**（只打印 `spec.cwd` 与 argv）。造两个工作区（一个已绑定、一个未绑定），验证：
   - `bash` 在已绑定工作区里跑 → 命中假 provider，`spec.cwd` 能反查到工作区与执行机；
   - `bash` 在未绑定工作区 / `_no-cwd` / 临时目录里跑 → 落到服务器本地，语义确定；
   - `spawnTerminal` 的 `spec.cwd` 同样可用作分派依据。

   这一步**不需要会话身份**（§1.3 第 1 条），是 v1 唯一要证的引擎侧假设。
2. **最小 SMB 验证**（最容易翻车，可与上面并行）：在服务器开一个共享，客户端用 UNC 访问同一文件，验证服务器改 → 客户端立刻看到、客户端改 → 服务器立刻看到、445 端口与凭据 ACL 都通。
3. **SMB 边界实测（判据已降级）**：按 §2.6 的规则，重软件不在 SMB 上干活，所以这一步不再决定方案形态，而是标定边界——测 **8–10MB 边界文件**与 **Office 在 SMB 上的锁文件行为**，为「阈值是否需要下调」和「用户注意事项」提供数据。

**验收**：分派链被证明可行 + 未绑定语义明确 + SMB 双向可见 + 边界与 Office 行为有数据。

### P1：executor 骨架 + 绑定

- executor：WS 连接、`hello`（含 **OS 版本**）、**心跳**、绑定状态上报、本地配置页（登录 / 选工作区 / 选暂存目录 / 主动解绑）。
- 服务端：executor 授权端点、绑定记录（含最后心跳时间）、**活跃/离线判定与自动失效**、单点仲裁、admin 强制解绑、`subprocess-dispatch` 骨架（`resolveExecutable` + 转发）。
- **验收**：用户自助登录并绑定；第二台设备绑同一工作区被拒绝且看到占用者用户名；占用机断网超过宽限期后第二台设备可直接绑定；解绑后能力立即消失。

### P2：subprocess 真正跑起来（先保住服务器回归，再打通本地）

- 分派实现按 v1 规则落地；`spawn`（流式 stdout/stderr + 收集 + 溢出落盘）、路径翻译（服务器路径 → UNC）、进程树终止阶梯、断线语义（在跑进程视为结束、不泄漏）。
- **同时注册 v1 提示词段**（§2.8.3 的要素 2–4：executor 实现形式、客户端 OS、路径对照）——执行位置一旦落到客户端，agent 必须立刻知道自己在哪，否则会写出错的命令。
- **验收**：未绑定工作区的行为与今天完全一致（回归）；已绑定工作区的 `bash` 在用户机上跑 PowerShell；超时终止不留孤儿进程（`tasklist` 可证）。

### P3：交互式终端（ConPTY）

- `spawnTerminal` + stdin/resize/signal，同样按模式分派。
- **验收**：vim / python REPL 可用；终端会话 crashtest（关 executor、断网）不挂死。

### P4：本机 localhost 转发 + MCP

- `http.request` op + 服务器侧本地代理端点（`webServer.register`）+ 端口白名单。
- 接 Figma Dev Mode MCP（`http://127.0.0.1:3845/mcp`，需在 Figma 桌面 App 里手动开启，[官方文档](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)）。
- 注意：MCP StreamableHTTP 用 SSE 分块，代理必须忠实转发分块与 MCP session 头；白名单是硬要求，否则等于给 agent 一个访问用户机任意本地服务的通道。
- **验收**：Figma MCP 工具出现在会话工具表并能取回节点数据。

### P5：本机暂存工作流（主路径）+ v1 端到端验收

按 §2.6 落地，注意这是**主路径而非例外**（本地执行下 >10MB 一律走暂存），所以它需要自己的 skill 与用户须知：

- 暂存工作流的全局 skill：判定（`stat` 大小 / 工程格式）→ `Copy-Item` 签出 → 调本机软件 → 回写 → 清理。
- 三个真实场景端到端：Blender（`-b -P`）、Photoshop（COM/ExtendScript）、Figma（MCP）。
- 补 `AGENTS.md` / `README.md` / 用户须知（含"不要在 SMB 上直接双击大文件用 PS 打开"）；`local_run` 降级为逃生口。

**v1 到此可用**：绑定即本地、未绑定即服务器，没有下拉框，不需要会话身份。

### P6（v2）：执行位置的显式覆盖

**前置：先做路由 spike**——用假 provider 验证 §2.8.4 的三条候选路径（模式感知消费者 / `spec.env` 标记 / agent 作用域 provider）哪条成立。不能跳过：它决定 v2 的实现形态，也决定要不要 fork shell / terminal 工具。

- `exec/mode` 事件、projection、prompt 段、`conversation.input.left` 下拉框、可用性判定与禁用提示。
- **验收**：切换后模型看到的新提示词包含模式、executor 实现形式与客户端 OS；切回服务器行为完全复原；刷新/重启/恢复会话后模式不丢；未绑定时下拉框禁用并说明原因。

---

## 4. 风险与开放问题

### 4.1 重软件在 SMB 上工作：已由「本地执行 + > 10MB 暂存」规则规避

**证据（保留，它解释了为什么必须有暂存规则）**：

- **Adobe 官方立场**：技术支持**只支持在本地硬盘上使用 Photoshop 和 Bridge**；「**Photoshop 不支持把网络或可移动驱动器作为暂存盘**」；官方推荐流程是"先在本地硬盘上工作，再拷贝到网络盘"（[Networks, removable media | Photoshop](https://helpx.adobe.com/photoshop/kb/networks-removable-media-photoshop.html)）。跨网络工作可能间歇性地报 `file is locked` / `disk error` / `unknown format`，且**损坏可能延迟出现且无法被察觉**。
- **Blender**：SMB 上的外部资源（Alembic、VDB 等）有已知的严重 I/O 性能问题（[#140266](https://projects.blender.org/blender/blender/issues/140266)、[#102990](https://projects.blender.org/blender/issues/102990)），社区甚至有专门"先存本地再搬到网络盘"的 addon 来绕过慢写入。

**残余风险（P0 实测判据为"标定边界 + 写用户须知"）**：① 用户可能自己绕过规则，直接在资源管理器里双击 SMB 上的大文件用 PS 打开；② 8–10MB 的边界文件仍走 SMB 直用，要确认没有实际痛感；③ **Office 仍可能踩坑**——大量临时文件与锁文件，SMB 上的行为需要实测。

### 4.2 工作区绑定的并发语义（已拍板）

**已定**：活跃占用 → 拒绝并提示占用者；心跳超时 → 自动失效，允许他人直接绑定；原机重连不自动夺回；服务端重启后绑定全部失效；同时抢一个失效绑定由服务端单点仲裁；另配占用者主动解绑与 admin 强制解绑两条出口。

**必须接受的代价（写进用户须知）**：用户合上笔记本 / 午休关掉 executor / 网络抖动超过宽限期，都会让出工作区；回来时可能已被别人绑走，需要重新绑定。宽限期就是这个体验的调节旋钮。

**心跳间隔与宽限期是部署可变的旋钮**，按仓库规范做成 Config 字段，不写死常量。

### 4.3 SMB 基础设施

- 服务器要开文件共享；客户端 445 可达；企业策略可能禁用 SMB 出站或凭据保存——**部署前必须确认**。
- 映射盘符按登录会话隔离，所以 **executor 必须在用户的交互式会话里运行**；优先用 UNC。
- UNC 不能作为进程工作目录（`cmd` 与部分程序会拒绝）。路径翻译时 `spawn` 的 `cwd` 要么用本地盘符，要么退到临时目录 + 绝对路径传参——P2 定死。
- **若服务端改为 Linux**：SMB 仍成立（Samba 是标准做法，Windows 客户端无感），但要额外处理 ① Samba 账号映射、② **大小写敏感性差异**（Linux 区分大小写而 Windows 客户端不区分，agent 可能建出 `A.txt` 与 `a.txt`）、③ Office 在 Samba 上的锁语义需重测、④ 服务器路径是 POSIX 形态，`local_binding` 那类只读能力从"便利"升级为"必需"（模型无法从 `/srv/...` 推断出 `\\server\share\...`）。此外四个 fork 插件、安装脚本与 FFmpeg 路径都要单独过一遍——**这是一条独立的工作线，不该混在本计划里**。

### 4.4 服务器沙箱在客户端进程上失效

`spawn` 落到客户端后，服务端的 argv 级沙箱不再适用（当前部署 `permission.defaultPreset: danger-full-access` 本就未拦）。若将来要管控，只能在 executor 侧做程序白名单/参数模板。**注意这条只在本地执行生效**，服务器执行仍受原有约束。

### 4.5 本地执行不可用时的语义

v1 下"本地执行可用"的判据 = 会话的 `cwd` 属于一个**已绑定、且占用人是本账号**的工作区 + executor 在线。不满足时行为必须确定：

- **`cwd` 不属于任何已绑定工作区** → 在服务器执行。这是 §2.3 定义好的规则，不是降级。
- **属于已绑定工作区、但 executor 掉线** → 后续 `spawn` **明确失败**并提示"本地执行不可用"，**绝不静默改到服务器执行**（那会让 agent 以为命令跑在用户机上，实际落在服务器）。
- **工作区被他人占用** → 对非占用人的会话，该工作区等同于"未绑定"，即回落服务器（§2.1 的权限一致性要求）；v2 下拉框则在此时禁用并说明原因。

### 4.6 断线语义

executor 掉线时：正在执行的 tool call 必须有确定结局（视为失败，不是挂起）；在跑的进程按"视为结束"处理且不泄漏。P2 定死。

### 4.7 Windows 特有

- 长路径（>260）、大小写不敏感、保留名（`CON`/`NUL`）、符号链接/junction。
- ConPTY 需 Windows 10 1809+；`node-pty` 是原生模块，优先选带预编译二进制版本。

### 4.8 性能基准（未测，需补）

SMB 往返延迟 vs 本机盘：轻量文件无感；大文件与随机读写差异明显。P0 记录一份基准，作为"哪些负载适合 SMB 直用"的判据。

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

**Web UI 插槽（`cordis_inspect` 实时读取）**

- `conversation.input.left` — list，`replaceRisk: none`，"对话框工具行左侧的紧凑控件" ← **执行模式下拉框放这里**
- `conversation.input.right` / `conversation.input.dock` / `conversation.composer.dock` — 备选位置
- `conversation.input.model`（模型选择器）与 `conversation.input.plan`（plan 开关）— 同排已有控件，可参照形态

**引擎可解析性**（从 `~/.dsh/profiles/web/package.json` 起，实测）

- 成功：`dsh-tools`、`dsh-fs`、`dsh-fs-local`、`dsh-subprocess`、`dsh-subprocess-local`、`dsh-tool-fs`、`dsh-mcp-client`、`dsh-agent-presets`、`dsh-terminal`、`dsh-terminal-bash`、`dsh-storage-domain`、`dsh-workspace`
- 失败：`dsh-e2b`、`dsh-fs-e2b`、`dsh-shell-bash`、`dsh-lsp`

**其他**

- `dsh --profile web --port 8080` 有效（`packages/boot/cmdline` 提供 `ctx.webStartup.port`，`packages/bundle/web-app/cordis.patch.yml` 写 `port: !!js ctx.webStartup.port ?? 3080`，flag 优先）。
- 工作区现状：`storages/workspace.json`（version 2），4 条记录，每条 `{path, title, sessionIds, createdAt, updatedAt}`，`path` 是宿主绝对路径。
- 会话可见性：`session.list` 的可选 `scopeUser` 由认证网关盖章并过滤（`.dsh/docs/agent-notes/2026-09-02-session-visibility-scope.md`）；服务器本机 loopback 走 DSH 原生 host-backed 路径、插件不介入，因此共享实例下 admin 在 `127.0.0.1:3080` 可见全部会话。
- 当前 Caddyfile 只有一条站点：`https://192.168.28.239:8443 → reverse_proxy 127.0.0.1:3080`（`tls internal`）。
- 现有 sidecar（`dsh-local-bridge`）的已知硬限制：一次性进程、无持久会话、无 stdin、超时只杀直接子进程、stdout/stderr 各 1MB、`collect` 的文件字节不进模型上下文、`inputFiles` 的 base64 要走模型上下文。本方案 churn 掉前四项，后两项因"文件本就在工作区"而自然消失。

### 5.2 参考

- 引擎架构与 capability seam：`docs/architecture.md`
- 执行世界外移的先例与理由：`packages/e2b/README.md`、`.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md`
- subprocess provider 接口：`packages/subprocess/subprocess/src/index.ts`
- **会话内可切换模式的模板**：`packages/plan/plan-mode/README.md`、`docs/subsystems/plan.md`
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
| 拓扑 | 共享实例（不用每用户一进程） | §2.3 |
| 文件模型 | 单副本走 SMB；`ctx.fs` 不动 | §1.1 §2.3 |
| 执行位置（v1） | **由工作区绑定唯一决定**：未绑定 → 服务器（＝今天），已绑定 → 本地 | §2.3 §4.5 |
| 执行位置（v2） | 增加会话级显式覆盖（下拉框），默认仍按绑定推断 | §2.8 |
| 下拉框位置 | `conversation.input.left`（list 插槽，加法，`replaceRisk: none`） | §2.8.1 |
| 模式状态 | log-only `exec/mode` 事件 + session projection（照抄 plan-mode） | §2.8.2 |
| 提示词内容 | 客户端 OS + executor 实现形式 + 路径对照属 **v1**；当前模式属 v2 | §2.8.3 |
| 默认值 | **已绑定 → 本地，未绑定 → 服务器** | §2.8.5 |
| 绑定冲突（活跃占用） | **直接拒绝**，提示「该工作区正在被 <用户名> 访问」 | §2.1 §4.2 |
| 绑定冲突（离线占用） | **心跳超时即自动失效**，允许他人直接绑定；原机重连不自动夺回 | §2.1 §4.2 |
| 绑定解绑 | 占用者主动解绑 + admin 强制解绑 | §2.1 §4.2 |
| 模式与绑定的权限一致性 | 本地执行时执行机必须是**该会话账号自己**绑定那台，否则拒绝 | §2.1 |
| 重软件阈值 | 本地执行下 **> 10MB 一律本机暂存** | §2.6 |
| 工作区授权 | **沿用现有账号配置界面**，授权作为账号记录上的字段 | §2.5 |
| 授权撤销 | 撤销授权即强制解绑；账号停用/删除，绑定一并失效 | §2.5 |
| 存储归属 | 授权存账号记录；绑定存部署侧自有存储域。**引擎零改动** | §2.1 |

### 6.2 待定项

| # | 问题 | 影响阶段 | 倾向 |
|---|---|---|---|
| 1 | **v2 路由方案定型**：模式感知消费者 / `spec.env` 标记 / agent 作用域 provider，三选一 | **P6（v2 前置）** | 依次试，优先零 fork 的方案 |
| 2 | 心跳间隔与宽限期的具体取值（建议 15s / 120s，做成 Config 字段） | P1 | 先按建议值上线，按反馈调 |
| 3 | 暂存副本的生命周期：何时回写、残留如何清理与提示 | P5 | 任务结束即回写并清理；残留下次绑定时提示 |
| 4 | 暂存工作流由谁发起：agent 自行判断，还是给 skill / 专用工具 | P5 | 全局 skill + 约定的暂存目录 |
| 5 | executor 的分发与更新（复用下载端点；exe 阶段还要自动更新通道） | P1 | 先复用 `/dsh-local-bridge/sidecar.mjs` 式端点 |
| 6 | 回滚路径：executor 出问题时一键退回纯服务器形态 | P1 | `disabled` 掉分派行 + 重启；写进运维手册 |
| 7 | 性能基准：SMB vs 本机盘的延迟/吞吐 | **P0** | 出基准表，作为"哪些负载适合 SMB 直用"的判据 |
| 8 | 是否加 `/exec` 命令（纯 UI 之外的第二入口） | P6 | 先只做 UI，需要再加 |
| 9 | Figma 的人工前置：用户须先打开桌面 App 并在 Dev Mode 启用 MCP server | P4 | 写进用户手册 |
| 10 | 工作量估算与排期 | 全部 | P0 完成后按实测回填 |

### 6.3 版本划分

- **v1**：P0–P5。绑定即本地、未绑定即服务器；不需要会话身份；注册 v1 提示词段（客户端 OS、executor 实现形式、路径对照）。
- **v2**：P6。执行位置的显式覆盖（下拉框 + `exec/mode` + projection + 当前模式写进提示词），前置是路由 spike。
