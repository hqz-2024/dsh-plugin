# plan-client-world · 实施进度（取代 plan-client-world-p0.md）

> 对应 `plan-client-world.md`。**P0 / P1 / P2 已完成并验证**；P3–P5 未做，SMB 验证因需管理员权限与第二台设备而阻塞。
>
> 全部改动在 `~/.dsh` 内，**引擎 checkout 零改动**。

---

## 0. 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0-1** | `cwd → 工作区 → 执行机` 分派链 | ✅ 已验证 |
| **P0-2 / P0-3** | SMB 双向可见 / 边界实测 | ⛔ 阻塞：需管理员提权 + 第二台设备 |
| **P1** | 绑定存储（占用人 / 心跳 / 失效 / 仲裁 / 撤销） | ✅ 已验证 |
| **P1** | executor 授权与登录链路 + **本地配置页**（§2.5 闭环） | ✅ 已验证（`pilot-auth`，真实门禁下） |
| **P1** | admin 强制解绑（接口层） | ✅ 已验证；Web UI 入口未做 |
| **P1 剩余** | 账号上的工作区授权字段、admin 强制解绑界面、executor 本地配置页 | ❌ 未做 |
| **P2** | 客户端真的执行：传输层 + executor + 路径翻译 + 终止阶梯 | ✅ 已验证（含心跳回路） |
| **P2 剩余** | `argv[0]` 跨机解析 **已修复**；stdin / spill 未验证 | 🟡 部分 |
| **P3** | ConPTY 交互式终端（含 Ctrl-C 中断） | ✅ 已验证 |
| **P5** | 暂存工作流：v1 提示词段 + 全局 skill | ✅ 机制已验证；三个真实软件端到端未做 |
| **P4** | 本机 localhost 转发（`/client-relay`） | ✅ 已验证（含 SSE 流式与端口白名单）；Figma 端到端待真实环境 |

---

## 1. P1 / P2 / P3 / P4 / P5 验收证据（最近一次运行）

harness：`profiles/pilot`，绑定 `宝单科技资料`，`visiblePath = C:\dsh-executor-root`（**故意与服务器路径不同**）。

| 步骤 | 观察值 |
|---|---|
| 未绑定基线 | `target=server`；子进程自报 `cwd=C:\Users\bestarc\Desktop\宝单科技资料` |
| claim + `bind.apply` | `ok:true`，`sent:true` |
| 路由 | `宝单科技资料=client`；`translated=C:\dsh-executor-root` |
| **客户端执行** | `target=client`；子进程自报 **`cwd=C:\dsh-executor-root`** |
| 判定 | `ranOnClient:true`、`cwdMatchesVisiblePath:true` |
| 真实 pid | `handlePid=13640`（**不是 -1**，`proc.started` 已回填） |
| 终止 | `settledWithin15s:true`，3850ms |
| release | **`ok:true`**（心跳保活成功） |
| 释放后 | `target=server`；子进程自报 cwd 回到服务器路径 |
| **`argv[0]` 指向服务器专有路径** | `ok:true`；executor 日志：`resolved C:\no-such-dir\node.exe -> C:\nvm4w\nodejs\node.exe (basename-on-client-path(…))` |
| **`argv[0]` 本机也无对应程序** | 明确失败：`program not found on this machine: … the server resolved that absolute path in its own world, and this machine has no equivalent` |

### P3 终端（同一次运行）

在**已绑定**工作区上分配 ConPTY，写入命令，读回答案：

| 观察 | 值 |
|---|---|
| 写入 | `Write-Output 'TERM-MARKER'; (Get-Location).Path` |
| 标记回读 | `sawMarker: true` |
| **工作目录** | **`C:\dsh-executor-root`**（翻译后的可见路径） |
| 服务器路径是否出现 | `sawServerPath: false` |
| 输出字节 / tail | 423 B；含 `\u001b[36m`、`\u001b[?25h`、`\u001b[1;26H` 等序列 |
| `inspectForeground()` | `undefined` |
| 终止 | `settled: true`，94 ms |

**tail 里的 ANSI 序列是"这是真 PTY"的证据** —— 管道不会有光标移动与着色。

> 注意：`(Get-Location).Path` 返回 `C:\dsh-executor-root` 而非服务器路径，同时证明了**终端在绑定机上**、**cwd 被翻译**、**输出走完 WebSocket 往返**。

### P5 执行世界提示词段（同一次运行）

工作区已绑定时，会话的 cwd 决定这段内容；未绑定时整段消失：

| 观察 | 值 |
|---|---|
| 已绑定（会话 cwd = 工作区） | 长度 **1463**；含可见路径 ✅、服务器路径 ✅、机器名 ✅、平台 ✅ |
| 绑定记录里的机器事实 | `machineHost=DESKTOP-LCLS51R`、`machinePlatform=win32`（由 executor 的 `hello` 写入） |
| 未绑定 cwd（工作区之外） | 长度 **0** |
| **段是否真在装配结果里** | `present=True`，`renderedLength=0`（无 agent 时空渲染，即 v1 契约） |
| 装配后的段列表 | `harness:identity, harness:source, app:web-surface, deployment:persona, **execution:world**, ui:deliverable-file-references` |

段落在 `deployment:persona`（order 0）之后、文件引用（9000）之前，即设定的 order 700 —— 在策略带内、**所有工具段之前**，所以 agent 在读工具说明前就知道自己在哪台机器上。

**为什么这条重要**：没有它 agent 会默认自己在服务器上，把服务器路径写进 shell 命令（那些路径在用户电脑上不存在）。它和路由本身一样是承重的。

### P4 本机 localhost 转发（同一次运行）

服务端 `/client-relay/<账号>/<端口>/<路径>` 把请求送到绑定机 127.0.0.1。fixture 服务监听 `127.0.0.1:38450`（`plugins/dsh-subprocess-probe/fixtures/local-service.mjs`）。

| 步骤 | 结果 |
|---|---|
| 普通 GET | 200；**请求头过去**（`sawHeader: "relay-test"`）、**响应头回来**（`x-fixture: local-service`） |
| POST body | 200；body 完整回显 `{"hello":"fixture"}` |
| **SSE 流式** | 200；`content-type: text/event-stream`；**`mcp-session-id` 头带过来了**；3 个事件；**到达时刻 `[408, 814, 1218]` ms** |
| 端口白名单 | **403** `port 1234 is not in the relay allowlist` |
| 未知账号 | **502** `no executor is connected for 'nobody'` |

**`[408, 814, 1218]` 是流式的决定性证据**：事件间隔约 406ms，与 fixture 的 400ms 发射间隔吻合。缓冲式代理会在 ~1218ms 一次性交付三个 —— 而 MCP StreamableHTTP 正是靠这个才能工作。

**同机测试的疑虑怎么排除**：服务器本来也能直连 `127.0.0.1:38450`。三重排除 —— ① 探针只请求 `/client-relay/...`，该路径只有转发端点会应答；② executor 侧日志逐条记录第二跳：`[executor] http -> 127.0.0.1:38450/ping (GET)`、`/echo (POST)`、`/sse (GET)`；③ 端口白名单与未知账号两条拒绝路径都由服务端产生，与 fixture 无关。

**顺带修的一个健壮性 bug**：executor 首次连接失败时会**静默退出** —— 握手未完成的场景下 `close` 事件不触发（实测只触发 `error`），于是没有安排重连，事件循环空转后进程结束。对一个"必须保持可达"的程序这是最糟的失败模式。改为 `error` 与 `close` 都调度重连，并加指数退避（1s→15s 封顶）。验收：先启动 executor（服务器未起）→ 连续重试 7 次仍存活 → 服务器起来后自动连上。

### P1 executor 授权端点（同一次运行）

`/client-auth/login | state | bind | unbind`。端点驱动页面跑在用户机器上，所以**账号必须来自认证插件校验过的会话，绝不能采信调用方自称的身份**。

| 步骤 | 结果 |
|---|---|
| `login`（无认证服务，且伪造 `x-dsh-user: nobody` + `x-dsh-role: admin`） | **503** `…cannot establish who is asking` —— **fail closed，伪造头被忽略** |
| `state`（配置 token） | 200，`username=probe-primary`，`connected=true` |
| `state`（错误 token） | 401 |
| `bind` | 200，`visiblePath` 正确，`bindings` 列表返回 1 条 |
| **`bind` 之后 spawn** | **`target=client`**，cwd = 翻译后的可见路径 |
| `unbind` | 200 |
| `bind`（不存在的 workspace） | 404 |

**最后那条绑定后 spawn 是决定性证据**：它证明端点 → 绑定存储 → `notifyBindApply` → executor 心跳 → 分派 这整条链是通的。

持久化的 `client_binding.json` 也从旁佐证：`lastHeartbeat`（02:55:58）晚于 `boundAt`（02:55:56），说明 executor 确实收到 `bind.apply` 并在心跳；`machineHost/machinePlatform/machineRelease` 来自 `hello`；释放后 `endedAt`/`endReason` 保留（失效不删记录）。

**验证中发现并修掉的一个 bug**：`authorize()` 一开始直接调 `bindings.resolveToken()`，而那是"只认已签发 token"的存储查询 —— **配置里写的 token 被 401 拒绝**。改为统一走 `usernameForToken()`（先查配置、再查存储）。这个 bug 只有把端点和 WebSocket 两条路径都跑一遍才会暴露。

### P4 追加：转发通道的凭据模型（本轮修正）

**发现的部署级问题**：读 `dsh-remote` 的门禁实现后发现 —— `wrapHttp`（`lib/index.js:1105`）对**所有**通过 `webServer.register` 注册的路由生效，且**没有 loopback 例外**；`isPublicPath`（`:80`）只放行 `/auth` 与 `/auth/*`。

后果：`/client-relay/...` 被门禁拦住，**连服务器自己的 loopback 也拿 403**。而 MCP 客户端的配置里放的就是一个 URL，它**没法带 `dsh_session` cookie** —— 也就是说上一轮"已验证"的转发，在真实 web profile 里**根本用不了**。

**修法（两处）**：

1. `dsh-remote` 新增 `publicPrefixes` 配置项：列入的前缀由处理器**自己验证调用方**，门禁放行而不是先答 403。注释里写明"只列真正校验凭据的前缀"。
2. 转发路径改为 `/client-relay/<secret>/<port>/<path>`：凭据走路径（`relayTokens`：secret → 账号），因为 MCP 客户端能粘贴 URL 但设不了 cookie。未知密钥 → **403 `unknown relay secret`**。

**复验**（改用密钥后同一次运行）：`relay-plain` 200（请求头过去 + 响应头回来）、`relay-post-body` 200、**`relay-sse` 3 事件 / arrivals `[420, 825, 1230]` / streamed=true**、`relay-port-denied` 403、**`relay-unknown-secret` 403**。其余全部步骤仍通过。

### P1 追加：`clientAuthResolver` 服务（本轮）

`dsh-remote` 现在提供 `clientAuthResolver`（`resolveSession(req) → {username, role, workspaces?}`），实现直接复用它的 `requireAuth`：**唯一能把签名会话 cookie 变成账号的组件就是它**，所以把这份知识留在原处，而不是在另一个插件里重新实现它的密码与会话格式。

`workspaces` 复用既有的 `roleMap`（映射到某工作区的账号只能绑定那一个；未映射的 admin 不限制）—— 计划 §2.5 要的是"账号记录上的字段"，用现成的 `roleMap` 比新造一个平行的账号字段更少漂移。

`dsh-remote` 自带测试：**45 通过 / 0 失败**。

**executor 侧独立日志**（同一回路的另一半）：

```
[executor] connected to ws://127.0.0.1:3082/executor
[executor] holding 92f8095e-… at C:\dsh-executor-root     ← 收到 bind.apply
[executor] heartbeating every 1000ms
[executor] dropped binding 92f8095e-…: not-held           ← 释放后心跳被拒 → 服务端令其 drop
```

清理后**无孤儿进程**；线上 `web` 实例（PID 16628 / 3080）全程未受影响。

### P1 登录链路 + 门禁豁免（pilot-auth，本轮）

`pilot` 不挂 `dsh-remote`，路由不受门禁保护 —— 它证明了客户端执行机制，但证明不了只在有门禁时才存在的两件事。`pilot-auth` = `pilot` + `dsh-remote`（门禁开启、启动即种一个 admin）。

| 步骤 | 结果 |
|---|---|
| `POST /auth/login` | **200**，拿到会话 cookie |
| `/client-auth/login`（带 cookie） | **200**，`username=probe-admin`，`workspaces=4`，`heartbeatMs=1000` |
| `/client-auth/state`（用**签发的** token） | **200**，`username=probe-admin`，`label=probe-executor` |
| executor 连接 `/executor` | **连上了** |
| `bind` 后 spawn | **`target=client`** |
| relay 全程无 cookie | 200 / 200 / SSE `[408, 814, 1217]` / 403 / 403 |

**门禁确实在拦**（无 cookie 直连）：
```
/api                  -> {"ok":false,"error":"unauthorized"}          ← 门禁
/client-auth/state    -> {"error":"a valid executor token is required"} ← 我的处理器
/client-relay/x/1/ping -> {"error":"unknown relay secret"}             ← 我的处理器
```
外加本轮同一路径的前后对照：豁免前 **403**（门禁），豁免后 **401**（我的处理器）。

### ⚠️ 本轮挖出的最重要问题：三道门禁，executor 根本连不上

`dsh-remote` 不只拦 HTTP 路由 —— 它连**已注册**的路由都重新包装，而且 **WebSocket upgrade 也拦**：

```js
for (const route of webServer.upgrades.values()) route.handler = wrapUpgrade(route.handler);  // :2386
```

`wrapUpgrade` 里只有一个**硬编码**的例外（`:1402`，给既有的 `/sidecar`）：`if (pathname !== "/sidecar" && !requireAuth(req).ok) socket.destroy()`。

后果：**`/executor` 的升级被 destroy**，executor 重试 16 次全部失败（`[executor] error: Received network error or non-101 status code.`）。也就是说，**在开了登录门禁的真实 web profile 里，客户端执行整个世界根本连不上** —— 上一轮我把它标记为"已验证"，那是在无门禁的 pilot 里验的。

**修法**：`publicPrefixes` 的检查**同时接入 HTTP 与 upgrade 两个包装器**（把 `isSelfAuthenticating` 提到两者共享的作用域），并把 `/sidecar` 那个硬编码例外保留为原有行为。配置从只列 `/client-relay` 扩到三个：

```
/executor      WebSocket upgrade，由 executor token 认证
/client-auth   Bearer executor token；只有 login 用会话
/client-relay  路径密钥
```

三者的处理器都自己校验凭据 —— 这正是 `publicPrefixes` 注释里写的前提（"只列真正校验凭据的前缀"）。`dsh-remote` 自带测试 45 通过 / 0 失败。

### P1 executor 本地配置页（§2.5 闭环，本轮）

executor 现在自带一个只绑 `127.0.0.1` 的配置页（默认端口 38460）。页面是 JSON 路由之上的薄壳，所以整条流程不用浏览器也能验。

| 步骤 | 结果 |
|---|---|
| `GET /` | 返回页面 HTML |
| 登录前 `/status` | `{"enrolled":false,"awaitingEnrollment":true,…}` |
| **`POST /login`** | `{"ok":true,"username":"probe-admin","role":"admin","heartbeatMs":1000,"workspaces":[4 条含 id/title/path]}` |
| 登录后 `/status` | `enrolled:true`、**`connected:true`**、`hello` 已填（`host/platform/release`） |
| **`POST /bind`** | `{"status":200,"ok":true,"binding":{…"username":"probe-admin"…}}` |
| 服务器侧存储 | `username=probe-admin`、`machineHost=DESKTOP-LCLS51R`、`machinePlatform=win32`、**心跳在推进** |

最后一行是承重的：它说明 executor 用**签发的** token 连上了 `/executor`，服务端因此能对它下发 `bind.apply`，它也在心跳 —— 凭据不仅能过 HTTP，也能过 WebSocket。

**验证时抓到的一个 bug**：配置页收集的是**基址**（`http://host:port`），而 `--token` 那条路径传的是**完整端点**（`ws://host:port/executor`）。`connect()` 直接把基址交给 `new WebSocket()`，URL 里**没有 `/executor`** —— 握手指向站点根，失败信息只有一句 `non-101`，完全没提路径。修法是 `executorEndpoint()`：只在 URL 没有路径时补 `/executor`，两种拼法都成立。

> 我早先单独用 `ws` 包测过一次并"通过"了 —— 因为那次我把 `/executor` 硬编码在测试脚本里。**复现真实调用路径才发现问题**，这也再次说明隔离测试会掩盖集成缺陷。

### P1 admin 强制解绑（§2.1 的第二条人工出口，本轮）

占用者自己的配置页覆盖不了这一种情况：**机器还活着、还占着工作区，但用户走开了** —— 那台机器上没人可以被请求放手，只能由别人来做。

管理面挂在 `/client-admin`，**故意不列入 `publicPrefixes`**：它代表 Web UI 里的人行动，会话门禁正是确定"是谁"的地方；处理器随后再要求 admin 角色。

| 步骤 | 结果 |
|---|---|
| 非 admin 账号（`probe-viewer`，`loginStatus:200` 说明它登录成功） | **403 `admin only`** |
| admin 列表 `GET /client-admin/bindings` | 200，`actor: probe-admin`，`count: 1`，`states: ["宝单科技资料=expired/probe-primary"]` |
| 先以占用者身份 `bind` | 200 |
| **admin `POST /client-admin/unbind`** | **200 `{ok:true}`** —— 强制释放了**别人**持有的活跃绑定 |
| 占用者随后自己 `unbind` | **409** —— 绑定确实已经没了 |

**验证时抓到的配置 bug（我自己的）**：我把 admin 交给 `bootstrap` 播种，同时用 `accounts` 播种 viewer —— 但 dsh-remote **先应用 `accounts` 再应用 `bootstrap`**，而 `bootstrap` 在"已有任何账号"时会被跳过。于是 viewer 的存在**抑制了 admin 的创建**，下一次登录报 `invalid credentials`，没有任何地方提到"账号不存在"。

修法：两个账号都在 `accounts` 里播种（`role: admin` / `role: user`），不再依赖 `bootstrap`。

### 为什么这条证据是有效的

子进程打印 `process.cwd()`。服务器路径与 `visiblePath` 不同，所以 cwd 等于 `C:\dsh-executor-root` 同时证明三件事：**进程跑在 executor 侧**、**cwd 被翻译过**、**stdout 走完了 WebSocket 往返**。三件事各自都有反例（服务器执行会打印服务器路径）。

> ⚠️ 本次 executor 与服务器**同机**，所以 `argv[0]` 用了服务器侧的 `node.exe` 绝对路径也能跑。跨机时这是个真问题，见 §3.1。

---

## 2. P1 绑定存储（已验证语义）

| 场景 | 结果 |
|---|---|
| 活跃占用时第二台机器 claim | `ok:false, reason:occupied, occupant:<用户名>` |
| release 后 | `ok:true`，路由回落 server |
| 心跳超时 | `state:expired, endReason:heartbeat-timeout`（**记录保留，不删**） |
| 失效机心跳 | `ok:false, reason:not-held`（**不自动夺回**） |
| 他人接管失效绑定 | `ok:true` |
| 撤销授权 | `dropped:[{workspaceId, machine}]` |
| 服务端重启 | 记录带 `serverBoot`，跨 boot 一律不活跃（§2.1） |

存储：部署侧 `client_binding` domain（version 1，`single` layout），键为 `workspaceId`。引擎的 `workspace` 域**不被写入**，两者只靠 id 关联。

---

## 3. 遗留问题（按优先级）

### 3.1 `argv[0]` 的跨机解析 —— ✅ 已修复

**问题**：executor 原样透传 `argv`，而 `argv[0]` 可能只有服务器上存在。典型来源是 `tool-fs-search`：它在服务器进程里解析 `@vscode/ripgrep` 的二进制路径（`search-core.ts:178`，且刻意绕开 `ctx.subprocess.resolveExecutable`，目的是"不需要系统 rg"），然后把绝对路径塞进 `argv[0]`。

**修法**（`executor.mjs` 的 `resolveProgram`，纯 executor 侧，不动引擎）：

1. `argv[0]` 是绝对路径且**本机存在** → 原样使用（说明两台机器布局一致）
2. 否则取 basename 在**本机 PATH** 上解析（Windows 走 `PATHEXT`）
3. 都解析不到 → **明确失败**，报出程序名与"服务器在自己的世界里解析了该路径，本机没有对应物"，而不是一个没有上下文的 ENOENT

**验收**：`C:\no-such-dir\node.exe` → 解析到 `C:\nvm4w\nodejs\node.exe` 并成功执行；`C:\no-such-dir\no-such-program-xyz.exe` → 明确报错。两条都在上面的证据表里。

**未采纳**：把 ripgrep/node 打进 executor 分发（更可靠，但要维护二进制分发通道）。若将来发现 PATH 解析不够稳，再补。

### 3.2 权限一致性（§2.1 的安全要求）

计划要求"执行机必须是该会话账号自己绑定的那台"。当前实现保证的是：**工作只会发到以自己的 token 认证、且持有该绑定的那台机器**（路由键是 `binding.username`，连接按 token 认证）。**缺口**：dispatcher 看不到会话身份，所以无法校验"会话归属人 == 占用者"。计划 §4.5 的处置（非占用人 → 视同未绑定）要靠会话身份，属 v2 或 P2 后续。

### 3.3 其他未验证 / 未做

- `proc.stdin`（已实现，未测）
- spill 文件（已实现，未测）
- **P5 的三个真实软件端到端未做**：Blender（`-b -P`）、Photoshop（COM/ExtendScript）、Figma（MCP）。前两个需要目标机装好对应软件，第三个依赖 P4
- **P4 的 Figma 端到端未做**：需要目标机开着 Figma 桌面 App 并在 Dev Mode 启用 MCP server。转发机制本身已验证，最后一段是配置与实测
- executor 授权：**端点与登录链路均已验证**（`pilot-auth` 里走通 `/auth/login` → cookie → `/client-auth/login` → 签发 token → 该 token 可用）。配置 token 仍可用
- **executor 本地配置页已完成并验证**（登录 → 签发 token → 选工作区 → 绑定 / 解绑；只绑 127.0.0.1，token 落盘以便重启免登录）
- **admin 强制解绑已完成并验证**（`/client-admin/bindings` + `/client-admin/unbind`，非 admin 403）。**界面未做** —— 上述是接口层，Web UI 上的入口还没有
- 账号上的工作区授权字段：未做（`workspaces` 目前复用 `roleMap`）
- 转发端点的鉴权边界：**路径密钥**（`relayTokens`：secret → 账号）+ 账号在线 + 持有活跃绑定 + 端口在白名单。未知密钥一律 403（见 §1 的 P4 追加）。**这不替代 DSH 会话门禁** —— 它是一条自带凭据的通道，所以必须同时把它的前缀列入 `publicPrefixes` 才能绕过门禁
- `local_binding` 只读工具未做 —— 计划 §2.6 把它与提示词段列为"或"关系，提示词段已覆盖

### 3.4 P3（终端）的 substrate 限制 —— 已知并接受

跨 socket 的 ConPTY 有两条硬限制，实现按"如实报告"处理：

| 限制 | 处理 | 依据 |
|---|---|---|
| **看不到前台进程组** | `inspectForeground()` 恒返回 `undefined` | ConPTY 不发布进程组视图；引擎自己的 inspector 读的是**本机**进程表（`process-inspector.ts`，537 行 Toolhelp32 代码），而那张表在另一台机器上。seam 契约明确允许（"Providers document substrate-specific observability limits"），且 PTY 消费者把"前台组未知"当未知处理，不报错（`session.ts:313`） |
| **只有 SIGINT 可投递** | 写 `\x03` 进终端（控制台就是这样把中断交给占用控制台的进程）；`SIGKILL` 与 POSIX 专有信号按引擎本地 Windows provider 的原话拒绝 | 与 `subprocess-local` 的 Windows 行为一致 |

**额外发现（node-pty 侧）**：本机 ConPTY 构建（`node-pty@1.2.0-beta.15`）的 `pty.pid` 返回 **0**。这不是本方案的 bug，是 substrate 的上限 —— 已直接验证：

```
typeof pid: number value: 0
```

后果：`signalForeground` 的返回值在 Windows 上可能是 `0` 而不是进程组 id。消费者只是把它透传进 `TerminalSignalResult`（`session.ts:377-381`），不做比较，因此功能无影响；但**返回值不满足"exact group id"的字面契约**，这是一个记录在案的偏离。

---

## 4. 计划需要修正的地方（累计）

| # | 位置 | 问题 |
|---|---|---|
| 1 | §2.3 | 行 id 写的是 `subprocess-local`，**实际是 `subprocess`**（`packages/bundle/base/cordis.patch.yml:205`）。按原文写会静默失效 |
| 2 | §2.1 | domain 名不能含连字符（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`），`client-binding` 会在模块加载时抛错，已用 `client_binding` |
| 3 | §2.3 | "**`fs` 不动** → 不走 ctx.fs 的模块风险清单直接消失" 已被证伪：`tool-fs-search`（glob/grep）走 `ctx.subprocess` 且 argv[0] 是服务器绝对路径（见 §3.1） |

### 四个实现级坑（对后续所有部署侧 provider 适用）

1. **服务里不能用 ES `#private` 字段** —— 服务被 Proxy 包装后 receiver 取不到私有字段
2. **`ctx.plugin()` 不同步发布服务** —— 返回 `Fiber & PromiseLike<Fiber>`，必须 `await` 后再 `get()`
3. **`spawn()` 同步 vs `resolveByPath()` 异步** —— 决策不能放在 spawn 里；本实现用一张同步路由索引 + 后台刷新。另：`resolveByPath` 对不存在的路径会 **reject**
4. **Windows 环境变量名大小写不敏感，但"复制出来的普通对象"不是** —— 介质里写的是 `Path` 不是 `PATH`；把 `process.env` 复制进普通对象后按 `.PATH` 读会得到 `undefined`，PATH 搜索**静默空转**。本次 `argv[0]` 解析第一版就栽在这里（引擎在 `packages/subprocess/subprocess/src/index.ts:53-55` 同样警告过这一点）。所有环境变量查找必须大小写不敏感。

### 一个时序事实

引擎的 workspace registry 启动后**约 3.2 秒**才可用（inject `storageDomain` + `sessionPersistence` + 异步 init）。任何读它的插件必须等待。

---

## 5. 交付物

| 路径 | 作用 |
|---|---|
| `plugins/dsh-subprocess-dispatch/` | 分派 provider + `/executor` 传输端点（`lib/index.js`、`lib/client-transport.js`） |
| `plugins/dsh-subprocess-dispatch/executor/executor.mjs` | 客户端 executor 程序 |
| `plugins/dsh-client-bindings/` | 绑定存储（`client_binding` domain + `clientBindings` 服务） |
| `plugins/dsh-subprocess-probe/` | pilot 验证 harness（**v1 签字后删除**） |
| `plugins/dsh-subprocess-probe/fixtures/local-service.mjs` | 本机服务 fixture（`/ping`、`/echo`、`/sse`），验证转发用 |
| `profiles/pilot/` | pilot profile（无门禁，验证客户端执行机制） |
| `profiles/pilot-auth/` | pilot + `dsh-remote`（门禁开启 + 种一个 admin），验证 §2.5 登录链路与门禁豁免 |
| `skills/local-staging/SKILL.md` | 暂存工作流全局 skill（判定 → 签出 → 处理 → 回写 → 清理） |
| `setup-smb.ps1` | SMB 共享安装脚本（需管理员运行） |
| `~/.dsh-pilot/` | pilot 的独立 home（junction 复用，不污染线上） |

## 6. 怎么重跑

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\pilot"
Remove-Item "$p\dispatch-trace.jsonl","$p\probe-result.jsonl" -ErrorAction SilentlyContinue

# 1) 起 pilot
$env:DSH_HOME = "$env:USERPROFILE\.dsh-pilot"
Set-Location C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile pilot --port 3082      # 后台

# 2) 起 executor（约 8 秒后）。终端需要 node-pty；本机试跑时用 --node-pty 指到引擎里的那一份
node "$env:USERPROFILE\.dsh\plugins\dsh-subprocess-dispatch\executor\executor.mjs" `
  --server ws://127.0.0.1:3082/executor `
  --token pilot-executor-token-0123456789 `
  --label probe-executor `
  --node-pty "C:\Users\bestarc\Desktop\deepseek-harness\node_modules\.pnpm\node-pty@1.2.0-beta.15_patc_04ea68a78398ae52b35b6f6b1ec3bdf9\node_modules\node-pty\lib\index.js"

# 3) 约 60 秒后读结果
Get-Content "$p\probe-result.jsonl"
Get-Content "$p\dispatch-trace.jsonl"
```

P4 转发还需要 fixture 服务（端口与 `relayPorts` 一致）：

```powershell
node "$env:USERPROFILE\.dsh\plugins\dsh-subprocess-probe\fixtures\local-service.mjs" 38450
```
