# plan-client-world · 实施进度（取代 plan-client-world-p0.md）

> 对应 `plan-client-world.md`。**v1 范围 P0–P5 均已完成并验证**。仍未完成的是：P0-2/P0-3（SMB 双向可见，需管理员提权 + 第二台设备）、P4/P5 的三个真实软件端到端。
>
> ⚠️ 验证载体是 `pilot` / `pilot-auth` profile。**线上 `web` profile 尚未挂载**对应的两条 bundle，见 §3.5 —— 这是有意的上线前状态，不是遗漏。
>
> 全部改动在 `~/.dsh` 内，**引擎 checkout 零改动**（checkout 里唯一未提交的改动是 `README.zh.md` 加了一行局域网启动命令，与本方案无关，也不是本次所加）。

---

## 0. 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0-1** | `cwd → 工作区 → 执行机` 分派链 | ✅ 已验证 |
| **P0-2** | SMB 双向可见（服务器↔客户端，同一份字节） | ✅ 已验证（本轮，第二台机器 `SUNDA`） |
| **P0-3** | SMB 边界实测（8–10MB 边界 / Office 锁文件） | ⛔ 未做：需在客户端侧测量 |
| **P1** | 绑定存储（占用人 / 心跳 / 失效 / 仲裁 / 撤销） | ✅ 已验证 |
| **P1** | executor 授权与登录链路 + **本地配置页**（§2.5 闭环） | ✅ 已验证（`pilot-auth`，真实门禁下） |
| **P1** | admin 强制解绑（接口层） | ✅ 已验证；Web UI 入口未做 |
| **P1 剩余** | 账号上的工作区授权字段、admin 强制解绑界面 | ❌ 未做 |
| **P2** | 客户端真的执行：传输层 + executor + 路径翻译 + 终止阶梯 | ✅ 已验证（含心跳回路） |
| **P2** | **权限一致性**（§2.1：执行机必须是会话账号自己绑定的那台） | ✅ 已验证（本轮，`DSH_SESSION_ID` 归属比对） |
| **P2** | 终止按进程树、不留孤儿（`tasklist` 可证） | ✅ 已验证（本轮，孙进程用例 + 独立复核） |
| **P2** | 断线语义（§4.6：在跑的调用有确定结局、不挂起） | ✅ 已验证（本轮，1964 ms 失败收场） |
| **P2** | §4.5 executor 掉线时后续 spawn **明确失败**、绝不静默回落服务器 | ✅ 已验证（本轮，错误文本自己声明未回落） |
| **P2 剩余** | `argv[0]` 跨机解析 **已修复**；初始 stdin 与 spill **本轮已验证**（stdin 曾是真 bug，见 §1） | ✅ 该组已清 |
| **P3** | ConPTY 交互式终端（含 Ctrl-C 中断） | ✅ 已验证 |
| **P3** | crashtest：关 executor 时终端不挂死 | ✅ 已验证（本轮） |
| **P3** | python REPL 可用（计划 P3 验收原文） | ✅ 已验证（本轮） |
| **P5** | 暂存工作流：v1 提示词段 + 全局 skill + 文档（AGENTS/README/用户须知） | ✅ 机制与文档已完成；三个真实软件端到端未做（本机无那些软件，见 §1） |
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

### P2 权限一致性（§2.1 / §4.5，本轮）

计划 §2.1 要求"本地执行时必须拒绝并提示占用者"。原先的缺口是：**`spawn(spec)` 里没有会话身份**，所以工作区被 A 绑定时，B 的会话照样能用 A 的机器。

**突破口**：`spawn` 确实没有会话身份，但 shell 工具**每次都把会话身份塞进了 `spec.env`**。`DSH_SESSION_ID` 是 `@deepseek-ai/dsh-shell-env` 的**内建**键（`shell-env/src/index.ts:155-157`，值就是 `execution.agent.session.header.id`），不需要写任何 contributor。三个环节都已按行核对：

```
tool-pwsh/src/index.ts:361      dshEnv: ctx.shellEnv.collect(exec)
pwsh-local/src/index.ts:242     env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
subprocess/src/index.ts:114     SubprocessSpawnSpec.env
```

`dsh-remote` 本来就为 `isVisible` 读 `auth/session-owners.json`（`lib/index.js:635` 的 `ownerOf`），只是没发布。本轮把它加进 `sessionOwnership`（一行），dispatcher 新增 `admit()`：取 `spec.env` 里的 `DSH_SESSION_ID`（大小写不敏感）→ 查归属账号 → 与绑定的占用者比对 → 不一致则**按 §4.5 视同未绑定、回落服务器**，并写一条 `foreign-session-fallback` 轨迹。

四次 spawn 全部发往**同一个已绑定**的工作区（`bound=client` 是这组证据的对照项，说明绑定当时是活的）：

| 步骤 | `spec.env.DSH_SESSION_ID` | 绑定 | **实际执行机** | 子进程自报 cwd |
|---|---|---|---|---|
| 占用者自己的会话 | `sess-occupant-fixture` → `probe-primary` | client | **client** | `C:\dsh-executor-root` |
| **他人会话** | `sess-foreign-fixture` → `probe-admin` | client | **server** | `C:\Users\bestarc\Desktop\宝单科技资料` |
| owners 文件里没有的 id | `sess-absent-from-owners` | client | client | `C:\dsh-executor-root` |
| 不带会话身份 | —（undefined） | client | client | `C:\dsh-executor-root` |

轨迹文件独立佐证（`dispatch-trace.jsonl`）：

```
{"event":"foreign-session-fallback","op":"spawn","boundTo":"probe-primary","sessionOwner":"probe-admin","sessionId":"sess-foreign-fixture"}
{"event":"decision","op":"spawn","target":"server","reason":"foreign-session-fallback", ...}
```

**为什么这组证据成立**：第 2 行是唯一与其余三行不同的输入（只有会话归属变了），输出却是唯一不同的（执行机变了），而"绑定仍然是 client"排除了"绑定刚好失效"这个解释 —— 回落只可能来自新增的准入判定。裁决用的 `bound=client` 读的是路由索引（绑定本身），`executedOn` 读的是**子进程自己报的 cwd**，两者来源不同。

**如实说明的边界**：不带 `DSH_SESSION_ID` 的 spawn（LSP、subagent CLI、`fs` 搜索）仍然只按绑定路由 —— 那些路径上没有任何东西标识会话。上表第 3、4 行就是这两种情况的实测值。所以本轮关闭的是"shell 调用"这条主路径上的缺口，不是全部 spawn。

### 上线组合 dry run：客户端世界挂到**真实 web 组合**上（本轮）

此前所有验证都在 `pilot` / `pilot-auth` 这种最小组合上，而线上是有 `agent-presets`、`permission`、`dsh-doc`、`local-bridge`、`llm-deepseek` 的真实组合。上线前必须证明它能挂上去 —— 于是做了这一轮 dry run。

做法：新增 `profiles/web-client/`，内容是 `profiles/web/cordis.patch.yml` 的**逐行副本** + 客户端世界那四行；跑在隔离 home `~/.dsh-web-client`（`plugins`/`profiles`/`.agent-presets`/`skills` 用 junction 复用，`auth`/`sessions`/`storages` 独立，工作区注册表从线上复制）。线上 3080 实例全程未重启、未受影响。

结果（同一次运行）：

| 观察点 | 结果 |
|---|---|
| 启动 | 无组合错误；`delegate-mounted: @deepseek-ai/dsh-subprocess-local`、`client-transport-started` |
| 路由索引 | **4 个真实工作区**（deepseek-harness / 宝单科技资料 / 微众诉讼 / .dsh），未绑定基线全为 server |
| `local-bridge` 并存 | 服务正常挂载。它走自己的出站 WebSocket，**完全不碰 `ctx.subprocess`**（已核对源码），两者不抢路由 |
| 绑定→路由 | `POST /client-auth/bind` 200；索引由 `宝单科技资料=server` 翻为 **`=client`**；`unbind` 后翻回 `=server` |
| P2 客户端执行 | 已绑定 → `executedOn=client`，子进程自报 `cwd=C:\dsh-executor-root` |
| P2 权限一致性 | 四例行为与 `pilot-auth` **完全一致**（占用者→client、他人→server、未知/无身份→client） |
| P3 终端 | 看到 marker 与翻译后路径，**无服务器路径**，含 ANSI 序列，终止 91 ms |
| P4 转发 | 200 / 200 / **SSE `streamed=true` `[415, 822, 1235]`** / 403 白名单 / 403 未知密钥 |
| P5 提示词段 | 已绑定 1463 字符、未绑定 0；段仍排在 `deployment:persona` 与文件引用之间 |

**门禁在真实 `remote` 配置下（`trustProxy:false` + `enforceRoles:true` + `roleMap`）确实在拦**，且三个前缀确实放行：

| 请求 | 结果 | 谁答的 |
|---|---|---|
| `/api` 无 cookie | **403** `{"ok":false,"error":"unauthorized"}` | 门禁 |
| `/client-auth/state` 无 token | **401** `a valid executor token is required` | **我的处理器** |
| `/client-relay/<错密钥>/3845/ping` | **403** `unknown relay secret` | **我的处理器** |
| `/executor` 无 token / 错 token | WebSocket **close 4001 `unauthorized`** | 我的处理器 |
| `/executor` 正确 token | 保持连接 | 我的处理器 |

**怎么区分"被门禁拦"和"被处理器拒绝"**：两者都是 403，但**处理器会带上错误文本**（`unknown relay secret`、`a valid executor token is required`）。没有文本的 403 = 门禁。这条判据在本轮救了一次误判（见下）。

**`/executor` 的握手先于认证**：无 token 时 upgrade **会成功**，随后服务端以 4001 关闭 —— 所以"连接上了"什么都证明不了，只有 close code 能证明。我第一次只连不发就得出"未授权也能连上"的结论，是错的；补测 close code 才看清。

**本轮抓到的一个配置错（我自己的）**：第一次跑时 relay 五步全是 403。因为我在 `relayPorts` 里只写了 Figma 的 3845，而冒烟 fixture 在 38450 —— 三行 403 全是白名单在正常工作。凭错误文本（`port 38450 is not in the relay allowlist`）与门禁 403 区分开，才没有误判成"新组合下转发坏了"。

**交付形态与冒烟形态的差别（如实说明）**：冒烟用的临时组合额外带了 ① `subprocess-probe` harness、② 一个已知密码的 `admin` 账号播种、③ fixture 端口 38450。**这三样都没有进入交付的 `web-client`**（账号播种尤其不能上线）。交付形态是**单独验证**的：启动无错、索引 4 个工作区、绑定→路由翻转、以及上表五条门禁/认证判据全部复测通过。完整冒烟的可重跑载体仍是 `pilot-auth`。

### 断线语义与终止树（§4.5 / §4.6，P2 与 P3 的验收项，本轮）

复核计划时发现有三条**写明了的验收判据一直没有对应的实测**：P2 的"超时终止不留孤儿进程（`tasklist` 可证）"、P3 的"终端会话 crashtest（关 executor、断网）不挂死"、以及 §4.6 的断线语义。机制在代码里（executor 的 socket `close` 会杀掉本连接拥有的全部子进程与终端），但没验过。

**终止树（P2）**：旧的终止用例只杀**直接子进程**，那区分不了"杀了子进程"和"杀了整棵树"。改成本身会再 spawn 一个**孙进程**并把自己的 pid 打到 stdout 的载荷，断言落在孙进程 pid 上：

| 观察 | 值 |
|---|---|
| 载荷 | 子进程 spawn 孙进程（`setTimeout 600000`）并打印孙进程 pid |
| 终止后 | `settledWithin15s: true`，**6179 ms** |
| 孙进程 pid | 27904 |
| 探针自查 | `grandchildAlive: false` |
| **独立复核（`tasklist`）** | pid 27904 **不存在** |

两处独立取值一致，才说明终止是**按进程树**做的（executor 用 `taskkill /PID /T /F`）。只杀直接子进程的话，孙进程会活着而"settled"照样为真。

**断线（§4.5 / §4.6）**：harness 在一个子进程与一个 ConPTY 终端都活着时杀掉 executor。

| 观察 | 值 |
|---|---|
| 武装时刻的路径 | `宝单科技资料=client` |
| 在跑的 spawn | `rejected: remote process proc-… lost its executor connection before exit`，**1964 ms** |
| 开着的终端 `terminate()` | `terminated`，**0 ms** |
| 后续 spawn 时的绑定状态 | **`active: true`** |
| 后续 spawn | **`ok:false`** — `client-transport: no executor is connected for 'probe-primary'; local execution is unavailable and the command was not run on the server instead` |

在跑的调用以**确定结局**收场（失败，不是挂起），终端不挂死 —— 这两条各自对应 §4.6 与 P3 的 crashtest。

**`crash-binding-active: true` 是让最后两行成立的对照项**：绑定当时仍然活着，所以"改到服务器执行"是一个真实存在的诱惑，而代码拒绝了它。错误文本自己把拒绝说出来了（`was not run on the server instead`）—— 这正是 §4.5 要的：如果静默回落到服务器，agent 会以为命令跑在用户电脑上。

**方法上的一个坑（值得记）**：我起初想证"executor 死了也不留孤儿"，两次都得到**假通过** —— 第一次 `job_kill` 把整个后台作业树一起收了；第二次只按 pid 杀 executor，母进程（pwsh 包装）退出时又把树带走了。两次都不是 executor 自己的清理在起作用。回头重读判据才发现：P2 说的是**超时终止**（executor 还活着时的终止阶梯），不是 executor 之死。改按孙进程测，才既打中真正的判据、又能被独立复核。

### SMB 双向可见（P0-2）—— ✅ 已验证（本轮，用户操作第二台设备）

用户在一台**独立的 Windows 机器 `SUNDA`** 上访问共享并完成了双向读写。服务器侧核对：

| 观察点 | 值 |
|---|---|
| 共享 | `\\192.168.28.239\ws-smbtest` → `C:\dsh-workspaces\smbtest`（`setup-smb.ps1` 建） |
| 共享 ACL | `DESKTOP-LCLS51R\dshtest` = Change |
| 445 | 正在监听 |
| **客户端写 → 服务器可见** | `client-wrote.txt` = `written by client (SUNDA) at 2026-09-16T11:36:45` |
| 客户端上传 | `flash_download_tool_3.9.7/`（内含 20.7 MB 的 exe） |
| **服务器写 → 客户端可见** | `server-wrote.txt` = `written by server (DESKTOP-LCLS51R) at 2026-09-16T10:31:56`，用户在客户端能拉取 |

**主机名是这份证据的承重处**：`client-wrote.txt` 的内容里写着 `SUNDA`，而服务器是 `DESKTOP-LCLS51R` —— 两台上写着各自名字的文件出现在同一个目录里，这既证明了双向可见，也证明了**是两台机器**而不是同机的错觉。

**"同一份字节"（§2.1 的原文判据）单独证过一次**：服务器用 `net use` 以 `dshtest` 身份连上 UNC，写 `\\192.168.28.239\ws-smbtest\unc-proof.txt`，然后立刻用**本地路径** `C:\dsh-workspaces\smbtest\unc-proof.txt` 读回来 —— 内容完全一致。服务器路径与 UNC 路径指向同一份字节，不是两份副本。（验证后已删除该文件并断开 `net use` 会话。）

**次生事实**：客户端上传来的是一个 20.7 MB 的目录，说明 >10MB 的文件经 SMB 传输本身没有问题 —— 这与 P0-3 的边界判据相关（那条针对的是"在网络上原地编辑"，不是传输）。

### 跨机执行：三条本轮才暴露出来的约束（还没验，但决定了怎么验）

P0-2 通了之后，下一步理所当然是**真正跨机跑一次命令**（executor 跑在 SUNDA 上）。本轮准备时撞到三件事，都不是代码问题，但都会挡住那次验证：

**① dsh 按设计拒绝绑定局域网地址。** `--host 0.0.0.0` 被硬拒绝：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network; use 127.0.0.1 instead
```

后果：executor **永远无法直连 dsh 的端口**，只能走反向代理。线上已有 caddy（`https://192.168.28.239:8443 → 127.0.0.1:3080`），且 `reverse_proxy` 自动转发 WebSocket 升级 —— 所以 `/executor` 走 caddy 是通的，**前提是客户端世界挂在 3080 那个实例上**。这意味着跨机验证没法用一个旁路服务器做，只能落在真实拓扑上（即上线）。

**② executor 不建立 SMB 凭据。** 计划 §2.2 写的是"用每账号的 SMB 凭据建立会话（`net use` 或 `cmdkey`）"，但 `executor.mjs` 里没有任何 `net use` / `cmdkey`（全文搜过），绑定记录里也没有存凭据的地方。所以客户端机器必须**先自己具备**该共享的凭据。v1 的可接受做法是每台客户端机器上存一次：

```powershell
cmdkey /add:192.168.28.239 /user:dshtest /pass:<密码>
```

`cmdkey` 的凭据跨重启保留，之后 `\\192.168.28.239\ws-*` 对用户会话透明可用（executor 跑在用户的交互式会话里，所以继承得到 —— 这正是计划 §2.2 强调"executor 必须跑在交互式登录会话"的原因之一）。

> 顺带一个生产差距：`setup-smb.ps1` 只建**一个** SMB 账号，而计划 §2.1 要求 ACL 与"账号可访问工作区"一致。要让共享层面的 ACL 真正按 DSH 账号区分，需要**一个 DSH 账号一个 SMB 账号**。v1 测试用一个共享账号可以，生产要补。

**③ 手工改 `storages/workspace.json` 会破坏域不变量。** 我为了让 `smbtest` 成为可绑定工作区，直接往 `tables.workspaces` 加了一条记录，启动即报：

```
workspace domain is inconsistent: workspace '<id>' is absent from registry order
```

原因是 `global.workspaceIds` 是**另一份顺序表**，每个工作区都必须同时出现在两处。补上之后启动正常。**结论：工作区应当通过注册表（Web UI）创建，不要手改存储文件** —— 手改会绕过 zod 之外的这层一致性校验。

### P3 python REPL（计划 P3 验收的原文判据，本轮）

计划的 P3 验收写的是"**vim / python REPL 可用**"。此前只验过 `powershell.exe`，本轮补上 REPL。

REPL 比 `powershell -Command` 是**更严的**测试：它逐行从终端读输入、逐条求值并打印结果，所以一次成功的往返证明的是**交互式 stdin 真的到达了对端程序**，而不只是"进程起来了、输出回来了"。

| 观察 | 值 |
|---|---|
| 解释器 | `C:\Users\bestarc\AppData\Local\Programs\Python\Python313\python.exe -i`（**服务器绝对路径**，与真实 shell 调用一致，因此同时走了 executor 的 `argv[0]` 规则） |
| 横幅 | `sawBanner: true`（`Python 3.13`） |
| 写入 | `import os; print("REPL-MARKER", os.getcwd())` |
| 读回 | `REPL-MARKER C:\dsh-executor-root` —— `sawMarker: true`、`sawTranslatedPath: true`、**`sawServerPath: false`** |
| 终止 | `settled: true` |

**`os.getcwd()` 由 Python 自己向操作系统读取**，所以它报的是子进程真实的 cwd，而不是链路上任何一方转述的路径。回读的尾巴里还有 readline 的转义序列（`\u001b[?2004h` 括号粘贴、`\u001b[?25h` 光标显隐、`\u001b[16X` 擦除）—— 那是**行编辑器在真 PTY 上工作**的证据，管道喂 stdin 不会有这些。

### P5 真实软件端到端：本机没有那些软件（本轮核实）

计划 P5 要三个真实场景（Blender `-b -P`、Photoshop COM/ExtendScript、Figma MCP）。本轮先核实执行机上到底有什么：

| 软件 | 本机（服务器） |
|---|---|
| Photoshop | ❌ 未安装（`Adobe` 目录下只有 Illustrator 2021 与 Adobe Utilities CS6） |
| Blender | ❌ 未安装 |
| 现代 Office | ❌ 未安装 |
| Python | ✅ 3.13.13 —— 上面那条 REPL 就是用它验的 |

**结论**：这三个场景本来就应该在**用户机器**上跑（软件装在那边，也正是"执行世界搬过去"的意义），所以在服务器上找不到它们是正常的，不是配置问题。它们与跨机验证（§3.7）绑定在同一件事上：需要 SUNDA 或用户的工作机。注意 `~/.dsh/skills` 里有 `photoshop-cs6` skill，但**本机并没有 Photoshop** —— 那个 skill 是给有 PS 的机器用的。

**顺带**：`local-staging` 的机制（判定 → 签出 → 处理 → 回写 → 清理）本身不依赖具体软件，可以用任意"重"程序演练；但计划要的是真实软件，所以仍记为未做而不是降级替代。

### stdin 与 spill：两条一直挂着"已实现未测"的路径 —— 其中一条是坏的（本轮）

§3.3 从第一轮起就挂着"`proc.stdin` 与 spill 文件已实现未测"。这轮补测，**测出一个真 bug**。

**stdin 在客户端路径上根本不工作，而且失败形态是挂死。**

| 层次 | 问题 |
|---|---|
| `lib/client-transport.js` | 发往 executor 的 `proc.spawn` 消息里**根本没有 `stdin` 字段** —— 而 executor 自己的协议注释（`executor.mjs:14`）把它写成了消息的一部分。载荷在传输层就被丢了 |
| `executor/executor.mjs` | `startProcess` 无条件 `stdio: ['pipe','pipe','pipe']`，既不写也不关 stdin。于是读 stdin 到 EOF 的子进程**永远等不到 EOF** |

第二个层次才是要命的：症状不是"少了数据"，而是**子进程和 `handle.done` 一起挂住**。§4.6 要求"正在执行的 tool call 必须有确定结局"，而这条路径给的结局是"没有结局"。**这个 bug 只有在真的去喂一次 stdin 才会现形** —— 这正是它挂了这么多轮"未测"的原因。

**修法（两层）**：

1. 传输层把 `request.stdio.stdin` 一并送过去。
2. executor 按**引擎自己的本地 provider** 的规则映射（`subprocess-local/src/spawn.ts:380`：只有 `'ignore'` 映射成 `'ignore'`，其余都是 pipe），对 `{ data }` 写入并 `end()`；同时**注册 stdin 的 `error` 处理器** —— EPIPE 是以**事件**形式到达的，`try/catch` 捕获不到，少了它一个已经退出的子进程就能把 executor 整个带崩（引擎在原处也做了这件事，`spawn.ts:493`）。

写不成 `'pipe'`、也不是 `{ data }` 的形态按 `'ignore'` 处理：这是**线上边界**，确定性的 EOF 远好过挂死。

修完的实测（同一次运行）：

| 步骤 | 观察 |
|---|---|
| **stdin 往返** | 发送 `STDIN-PAYLOAD-1789531235302` → 子进程 stdout 回 `GOT:STDIN-PAYLOAD-1789531235302`，`sawPayload: true`，`exitCode: 0` |
| **stdout 溢出落盘** | `inMemoryBytes: 4096`（被 `maxBytes` 截住）、**`lossy: true`**、`spillPath` 有值、**`spillBytes: 300000`**、**`complete: true`** |

载荷能出现在子进程的 stdout 里，说明字节真的过了 socket 并且 stdin 被关闭（否则子进程不会看到 EOF、不会退出、也就不会有 `exitCode: 0`）。spill 那行则是：内存里只留 4 KB、读取标记为有损，而**完整的 300 KB 落在文件里** —— 落盘文件在 `%TEMP%\dsh-remote-spill\`（在服务器侧，因为流是在服务器侧从 socket 拼起来的），磁盘上实测 300000 字节。

### executor 自带 SMB 凭据（计划 §2.0 划给 executor 的职责，本轮）

计划 §2.0 的图把 executor 的活写成三件：**登录（复用 dsh-remote）**、**绑定工作区（SMB 凭据）**、**`proc.*` / `http.*` 执行**。本轮之前，第二件实际上没人做：executor 里没有任何 `net use` / `cmdkey`（全文搜过），我上一轮把它记成"客户端先手工 `cmdkey` 存一次"。那等于把"跨机可用"押在用户知道一个诀窍上 —— 而计划把这件事划给了 executor。

**现在的做法**：

| 入口 | 行为 |
|---|---|
| 配置页新增「3. 工作区共享凭据」 | 共享账号 + 共享密码，保存即应用 |
| `--smb-user` / `--smb-password` | 无值守等价物（装机脚本用） |
| 存放 | 与 executor token 同一个 `state.json`（`0600`） |
| 应用时机 | 每次 `bind.apply` |
| **主机从哪来** | **从绑定带回的 `visiblePath` 推出** —— 用户既不填主机名，也不可能指错共享 |
| 改密码后 | `POST /smb` 会**对当前已持有的共享**重新应用，不必先解绑 |
| `/status` | 只报"是否配置 + 账号名"，**从不回显密码** |

两个实现细节是承重的：

1. **`cmdkey` 的成败不能看退出码。** 它有失败情形是往 stdout 打一行字、退出码仍然 0。所以判定改成"加完之后再 `cmdkey /list:<host>` 看账号在不在" —— 这样也和系统语言无关（匹配本地化的"已成功"文案必然出错）。
2. **密码必然出现在 `cmdkey` 的 argv 里** —— 该命令没有 stdin 形式，所以那条命令存活期间密码在进程列表里可见。这是这条路径的固有代价，已写进注释。

**验证**（用**不存在的宿主** `dsh-smb-probe-test`，所以全程没有碰真实共享的任何已存凭据；验完已删除）：

| 步骤 | 观察 |
|---|---|
| `bind` 时 `visiblePath = \\dsh-smb-probe-test\ws-x` | executor 日志：`holding … at \\dsh-smb-probe-test\ws-x` → `SMB credential for dsh-smb-probe-test as dshprobe: stored` |
| 凭据库 | `cmdkey /list:dsh-smb-probe-test` → `Target: dsh-smb-probe-test` / `Type: Domain Password` / `User: dshprobe` |
| `GET /status` | `enrolled:true`、`connected:true`、`smb.configured:false`（种下的 state 里为空，符合预期）、`heldShares: \\dsh-smb-probe-test\ws-x`、**body 里搜不到密码** |
| `POST /smb`（对已持有共享重放） | `{"ok":true,"applied":{"dsh-smb-probe-test":"stored"},"hosts":["dsh-smb-probe-test"]}` |
| 配置页 | 三个新元素都在（fieldset / 两个 input / `saveSmb()`） |
| 重连 | executor 重连后服务端重放 `bind.apply`，凭据**自动重新应用**（日志里第二次出现 `stored`） |

**这条只关掉了 §2.0 的客户端那一半，如实说明**：生产侧还差"一个 DSH 账号一个 SMB 账号" —— `setup-smb.ps1` 目前只建**一个**共享账号，所以计划 §2.1 要求的"ACL 与账号可访问工作区一致"在共享层面**还不成立**（所有账号用同一个 SMB 身份）。本轮让凭据的**建立**自动化了，但**按账号区分**还没做。

### P0-3 边界实测：量具已就绪，并已有两个初值（本轮）

P0-3 要的是"8–10MB 边界文件"与"Office 在 SMB 上的锁文件行为"的数据，用来回答**10MB 阈值要不要下调**。本轮把量具做出来了：`~/.dsh/measure-smb-boundary.ps1`。

**为什么必须在客户端跑**：要测的是"用户在他的电脑上通过共享访问"，在服务器上跑本地路径只能得到磁盘速度。脚本也能对着本地目录跑 —— 那正是计划 §4.8 要的对照基线（"SMB 往返延迟 vs 本机盘"）。

测什么、以及为什么这么测：

| 项 | 为什么是它 |
|---|---|
| 顺序吞吐 1/5/8/10/12/25 MB | 写入时强制 `Flush`，否则量到的是本机缓存而不是网络 |
| **小文件 200 × 4KB 建+删** | Office 打开一个文档会做几十次小操作，**这才是它卡不卡的原因**，不是大文件带宽 |
| **改名替换（temp → 覆盖目标）** | Office/PS 保存就是这个动作。脚本测**两种机制**：`File.Replace`（Win32 `ReplaceFile`）与改名覆盖（`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`） |
| 共享冲突语义 | 独占打开时第二个句柄必须被拒 —— 这条不成立就意味着两个进程能同时改同一个文件 |
| SMB 方言/签名/加密 | 只在 UNC 路径上有意义 |

**两个初值（服务器对自己共享的环回，`net use` 以 `dshtest` 身份）** —— 注意**这不是 P0-3 的答案**，环回没有真正的网络跳：

| 项 | 本地盘（基线） | 经 UNC（环回） |
|---|---|---|
| 小文件单次建+删 | 0.5 ms（1,924 次/秒） | **3.0 ms（331 次/秒）** —— 慢 6 倍 |
| 10MB 写 | 0.01 s | 0.01 s（环回无网络跳，参考价值有限） |
| `File.Replace` | 20/20 成功 | **0/20 失败：`Access to the path is denied.`** |
| 改名覆盖 | 20/20 成功 | 20/20 成功 |
| 独占锁 | 第二个句柄被拒 | 第二个句柄被拒 |

**`File.Replace` 在共享上失败、改名覆盖却成功**，是这轮最值得记的一条。它意味着"能不能在共享上原地保存"**没有统一答案** —— 取决于程序内部用哪一个 Win32 调用，而这一点你没法从一个文件扩展名上看出来。它恰好从实证上支持 §2.6 的做法：不要逐个去试，重软件一律走本机暂存。

**如实说明**：这两个初值来自服务器访问自己的共享（环回），真实客户端还要多一跳网络，小文件延迟只会更差。**真正要拿去调整阈值的是 SUNDA 上那一份**：

```powershell
# 在客户端机器上跑（把 UNC 换成该机器能访问的共享）
\\192.168.28.239\ws-smbtest   # 若尚未连过，先 net use 或让 executor 存凭据
& "$env:USERPROFILE\.dsh\measure-smb-boundary.ps1" -Path '\\192.168.28.239\ws-smbtest'
```

脚本只在自己的子目录里建文件，跑完自动删除（`-Keep` 可保留复核）。跑到哪一步失败都会打印**具体是哪个机制、什么错误**，而不是只报一个成败。

**顺带记一个写脚本时踩的坑**：`[System.IO.File]::Replace($src,$dst,$null)` 从 PowerShell 调用**永远失败** —— `$null` 被编组成空字符串，.NET 报 `The path is empty`。那看起来和文件系统故障一模一样，只数异常次数就会把"我自己传错了参数"误判成"共享不支持原子替换"。第一版脚本就是这么误报的，本地盘上也 20/20 失败才暴露出来。

### 全量回归：最近三个提交没有引入回归（本轮）

在准备上线之前重跑一遍完整回归，因为最近三个提交里有一个改的是 `startProcess` —— 那是**每一次 spawn 都要过**的路径，还有一个改了 `bind.apply`。切换前不确认这两处，出问题只能靠猜。

`pilot-auth`（53 条记录）与 `web-client`（上线组合）两段跑完：

| 段 | 结果 |
|---|---|
| `pilot-auth` 完整功能 | 失败项**恰好两条**，都是刻意构造的负例（`argv0-unresolvable`、`crash-offline-spawn`）；**没有任何 `HUNG`** |
| 关键值逐项对齐 | `cwd=C:\dsh-executor-root`、perm 占用者→client/他人→server、python REPL `sawServerPath=false`、stdin `sawPayload=true exitCode=0`、spill `4096/lossy/300000/complete`、终止 `grandchildAlive=false`、断线 `rejected … 2335ms`、提示词段 `1463/0`、SSE `streamed arrivals=409,814,1220` —— **全部与既有记录一致** |
| `web-client` 上线组合 | 索引 5 个工作区全 `server`；门禁 403、三个前缀放行（`/client-auth` 401 与 `/client-relay` 403 都带**处理器自己的文本**）；`/executor` 无/错 token **close 4001**；bind → `smbtest=client`，unbind → 翻回 |

**顺带确认了两件事**（不是刻意测的，是跑出来的）：

1. **重连 + 绑定重放是通的**：测试连接把真 executor 顶掉后，它 1 秒后自动重连，并立刻重新持有原绑定（`holding 92328440-… at \\192.168.28.239\ws-smbtest`），心跳按生产的 30 秒节奏走。
2. **一个坑，已写进 §7**：用**同一个 token** 再连一个 executor 会两个连接互相顶（每账号只保留一条连接），测试连接会以 `1005` 关闭，看起来像认证失败。要测 `/executor` 认证只能用**错 token**那两条。

清单已固化为 §7「上线前的回归清单」—— 三段（完整功能 / 上线组合 / 最后三件事），带期望值，目的是让切换这件事**可机械执行**，而不是每次靠回忆。

### executor 的分发端点 + §6.2 的三个待定项（本轮）

复核计划的 **§6.2 待定项**时发现一条 P1 的活没人做：第 5 条"**executor 的分发与更新**（复用下载端点）—— 先复用 `/dsh-local-bridge/sidecar.mjs` 式端点"。在此之前，用户**没有任何受支持的途径**把 executor 装到本机 —— 只能靠手工拷贝文件，而 sidecar 早就有下载按钮了。

**已补上**（与 sidecar 端点同形）：

| 项 | 实现 |
|---|---|
| 下载端点 | `GET /dsh-subprocess-dispatch/executor.mjs`（在 dispatcher 的传输层注册，与 `/client-admin` 同级） |
| 设置页 | `/auth/local-plugins` 列表新增 `executor` 条目 → **设置 → 本地插件**里多一张卡片，按钮与 sidecar 一致 |
| 门禁 | **刻意不列入 `publicPrefixes`**：下载者是设置页里已登录的浏览器，登录门禁正是该做的检查。不为一个本来就公开的文件放松门禁 |
| 凭据 | **文件里不含 token**。executor 自己完成登记：配置页登录 → `/client-auth/login` 按账号签发 token（§2.5）。这正是它不需要"预填 token 的启动脚本"的原因 |

**验证**（`pilot-auth`，真实门禁下）：

| 检查 | 结果 |
|---|---|
| 无会话访问下载 URL | **403** `{"ok":false,"error":"unauthorized"}`（门禁拦下，说明它确实没被列进 `publicPrefixes`） |
| 登录后访问 | **200**，`Content-Disposition: attachment; filename="executor.mjs"` |
| **字节是否与源文件一致** | 源 45595 B、发出 45595 B、**内容逐字节相同** |
| `/auth/local-plugins` | 三条：`sidecar` / **`executor`** / `manifest-tool`，各带 `downloadUrl` |
| 无会话访问列表 | **401**（不泄露列表） |
| 每条 `downloadUrl` 是否真的能下 | `sidecar` 200（24888 B）、**`executor` 200（45595 B）**、`manifest-tool` 404 —— **404 是因为 `pilot-auth` 没挂 `dsh-video-studio`**，不是缺陷（线上 `web` 与 `web-client` 都挂了它） |

**顺手闭掉的另外两条 §6.2 待定项**（都是"写进手册"类）：

- 第 6 条 **回滚路径** —— 已写进 README 运维提示：改回 `subprocess-dispatch: disabled` + 恢复 `subprocess` 行 + 重启。要点是**未绑定的工作区本来就是这个行为**，所以回滚只影响已绑定的工作区，且绑定记录不丢（跨重启一律不活跃是既定规则）。一个改动只碰一个组合文件，回滚不需要动数据。
- 第 9 条 **Figma 的人工前置** —— 已写进 README 用户须知：必须**先在自己电脑上打开 Figma 桌面 App 并在 Dev Mode 手动启用 MCP server**（默认 3845），这一步没有 API 可代劳。转发白名单里已含 3845。

第 7 条（性能基准）上一轮已给了量具与初值。

### 暂存残留的提示（§2.6 明确要求、此前没做，本轮）

计划 §2.6 写着："**暂存副本的生命周期要定死**：任务结束即回写并清理；**上次未回写的残留要在下次绑定时提示用户**。"

后半句此前没人做。`local-staging` skill 里有"残留处理"，但那是**agent 侧**的：只有 agent 碰巧要开始一个用暂存的活儿时才会发现。而**用户早上绑定机器时不会被告知任何东西** —— 偏偏残留就在他自己的机器上，只有 executor 看得见。

**现在的做法**：executor 在**每次 `bind.apply`** 时扫一遍该绑定带来的暂存目录，有残留就：

| 出口 | 表现 |
|---|---|
| executor 日志 | `注意：暂存目录 <dir> 里有 N 项上次未回写的残留：` + 逐项 `名称 (大小, 修改时间)`，目录标 `[目录]` |
| 本机配置页 | 顶部出现一个醒目块，列出同样内容，并写明**执行器不会替你删** |
| `/status` | 每个已持有绑定带 `staging: [{workspaceId, stagingDir, leftovers[]}]`（**按需计算**，所以页面反映的是当下目录，不是绑定那一刻的快照） |

**只报不删**是刻意的：那些文件是用户的，skill 的规矩也是"先问"。上限 20 项，避免一个塞满的目录把日志刷爆。

**验证**（`web-client` + executor，配置页在 38462）：

| 用例 | 结果 |
|---|---|
| 暂存目录里放 2 个文件 + 1 个子目录后绑定 | `/status` 报 **3** 项，名称/大小/类型都对；日志打印同样 3 项 |
| 配置页 | 四个标记全在（容器、读 `s.staging`、警告块文案、"不会替你删"） |
| **空目录**（对照） | `leftovers=0`，日志**不打印**警告 |
| **不存在的目录**（对照） | `leftovers=0`，不报错、bind 仍 200 |

**测试时踩的一个坑**：第一版对照实验直接在占用中重新绑定，服务端按规则回了 **409**，于是 `/status` 显示的还是上一次的 stagingDir —— 看起来像"空目录也报了 3 项残留"。**必须先解绑再绑定**才能换 stagingDir。这不是代码问题，但如果不追下去就会得出完全相反的结论。

**顺带把两边对齐**：`local-staging` skill 的"残留处理"补了一句 —— 用户那边也会被告知，所以 agent 看到残留时用户很可能已经看过同样的提示，两处是同一个判断，不该当成两件事。

### 为什么这条证据是有效的

子进程打印 `process.cwd()`。服务器路径与 `visiblePath` 不同，所以 cwd 等于 `C:\dsh-executor-root` 同时证明三件事：**进程跑在 executor 侧**、**cwd 被翻译过**、**stdout 走完了 WebSocket 往返**。三件事各自都有反例（服务器执行会打印服务器路径）。
服务器路径与 `visiblePath` 不同，所以 cwd 等于 `C:\dsh-executor-root` 同时证明三件事：**进程跑在 executor 侧**、**cwd 被翻译过**、**stdout 走完了 WebSocket 往返**。三件事各自都有反例（服务器执行会打印服务器路径）。
服务器路径与 `visiblePath` 不同，所以 cwd 等于 `C:\dsh-executor-root` 同时证明三件事：**进程跑在 executor 侧**、**cwd 被翻译过**、**stdout 走完了 WebSocket 往返**。三件事各自都有反例（服务器执行会打印服务器路径）。

> ⚠️ 本次 executor 与服务器**同机**，所以 `argv[0]` 用了服务器侧的 `node.exe` 绝对路径也能跑。跨机时这是个真问题，见 §3.1。**跨机验证至今仍未做**（见 §3.7）。

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

### 3.2 权限一致性（§2.1 的安全要求）—— ✅ 已修复

计划要求"执行机必须是该会话账号自己绑定的那台"。原缺口：dispatcher 看不到会话身份，所以**工作区被 A 绑定时 B 的会话照用不误**。

**已按 §4.5 实现并验证**（证据见 §1「P2 权限一致性」）：`DSH_SESSION_ID` 是 shell 工具每次都会注入的内建环境变量，所以 shell 调用这条路径上会话身份本来就是可得的 —— 只是没人用。dispatcher 现在拿它与绑定的占用者比对，不一致则视同未绑定、回落服务器。

**仍未覆盖的输入**：不带 `DSH_SESSION_ID` 的 spawn（LSP、subagent CLI、`fs` 搜索的 ripgrep）仍只按绑定路由。这些路径上没有任何东西标识会话，要覆盖它们需要另一条身份通道（或让这些消费者也走 shell-env），属 v2。

### 3.3 其他未验证 / 未做

- ~~`proc.stdin`（已实现，未测）~~ → **本轮测了，而且是坏的**：初始 stdin 在客户端路径上既不送达也不关闭，读 EOF 的子进程会挂死。已修并验证，见 §1
- ~~spill 文件（已实现，未测）~~ → **本轮已验证**（300 KB 完整落盘），见 §1
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

### 3.5 上线路径：`web-client` profile 已就绪并验证（本轮更新）

三个新插件都是**独立 bundle**（各自带 `cordis.patch.yml`，把行插进去时 `disabled: true`），只有把它们列进 profile 的 `dsh.profile.bundles` 才会挂载：

| profile | bundles 里的客户端世界部分 | 用途 |
|---|---|---|
| `pilot` | `dsh-client-bindings`, `dsh-subprocess-dispatch`, `dsh-subprocess-probe` | 最小组合冒烟 |
| `pilot-auth` | 同上 + `@xgone/dsh-remote` | 门禁下的完整冒烟（含权限一致性） |
| **`web-client`** | `dsh-client-bindings`, `dsh-subprocess-dispatch`（**无 probe**） | **上线 profile** |
| `web`（线上） | 无 | 现状，未动 |

**上线 = 把启动命令的 `--profile web` 换成 `--profile web-client`**（`~/.dsh/start-dsh-lan.cmd` 里那处）。线上 `web` 与其运行中的实例一行不动，随时可退。`web-client` 已按真实组合跑过完整冒烟与单独复测，见 §1「上线组合 dry run」。

**为什么仍然没上线**：前置条件 P0-2（SMB 共享）还没建 —— 没有 SMB，翻译后的可见路径在用户机器上不存在，客户端执行会立刻失败。**先建共享，再切 profile。**

**上线时要改的两处占位值**：`subprocess-dispatch.config.tokens` 与 `relayTokens` 里现在是测试值，需换成真实签发的 token（按账号，泄露即等于该账号在自己机器上的执行权限）。

**这个 profile 的唯一长期维护负担**：它的 patch 是 `profiles/web/cordis.patch.yml` 的副本，web 改了它必须同步（文件头已写明）。若不想承担，改为把文件末尾「客户端执行世界」那四行直接并入 web 的 patch —— 线上 `patchReload: live`，合并后无需重启即生效，代价是没有独立的回退档。

顺带发现：`install.sh` 的 `PLUGINS` 数组（第 37 行）没有这三个新插件，所以它的完整性检查不覆盖它们。要么补进去，要么明确它们不随仓库分发。

### 3.6 按计划的验收判据逐条核对后，仍缺的项（本轮复核）

拿 `plan-client-world.md` 里**写明的验收判据**逐条对账，而不是凭印象。已补掉的：§4.5 / §4.6、P2 的终止树、P3 的 crashtest 与 python REPL、P0-2、以及 P5 的三份文档（证据见 §1）。仍然缺的：

| 判据出处 | 判据 | 状态 |
|---|---|---|
| P0 验收 | SMB 双向可见 | ✅ **已验证**（见 §1） |
| P0-3 | 8–10MB 边界文件与 **Office 在 SMB 上的锁文件行为**有数据 | 🟡 **量具已就绪**（`measure-smb-boundary.ps1`），已有环回初值；**待客户端那一份**（见 §1） |
| P3 验收 | **python REPL** 可用 | ✅ **已验证**（见 §1） |
| P3 验收 | "断网"（不只是关 executor） | 🟡 未做（已验的是进程消失，不是链路中断） |
| P4 验收 | Figma MCP 工具出现在会话工具表并能取回节点数据 | ⛔ 需 Figma 桌面 App + Dev Mode MCP |
| P5 | 三个真实软件端到端（Blender `-b -P`、Photoshop COM/ExtendScript、Figma MCP） | ⛔ 需在**用户机器**上跑（本机三者都没装，见 §1） |
| **P5** | 补 `AGENTS.md` / `README.md` / 用户须知；`local_run` 降级为逃生口 | ✅ **已完成** |
| **跨机** | 命令真的在**另一台机器**上执行 | ⛔ 见 §3.7 —— 唯一还缺的那类证据 |
| §4.8 | 性能基准 | ❌ 未做（计划自己标了"未测，需补"） |
| §3.3 | `proc.stdin`、spill 文件 | ✅ **已验证**（stdin 曾因传输层丢字段 + executor 不关管道而挂死，已修；见 §1） |

**剩下的缺口有一个共同前提**：P0-3、真实软件、跨机三项都需要**另一台机器上的动作**（SUNDA 或用户的工作机）。它们不是实现没做完，而是实现只能在目标环境里才验得动。见 §3.7。

---

### 3.7 跨机验证（唯一还缺的那类证据）

**这是本项目至今最大的证据缺口**：所有运行时证据都是**服务器与 executor 同机**（环回）。计划自己警告过这一点 —— "本次 executor 与服务器同机，所以 `argv[0]` 用了服务器侧的 `node.exe` 绝对路径也能跑。跨机时这是个真问题"。同机跑通**不等于**跨机跑通。

P0-2 通了之后，跨机验证具备条件了（第二台机器 `SUNDA` / 192.168.28.57 存在、可达、能读写共享）。本轮把路铺到了"只差用户按一次启动"，并撞出三条约束（详见 §1「跨机执行」）：

| # | 约束 | 后果 |
|---|---|---|
| ① | dsh **按设计拒绝** `--host 0.0.0.0` | executor 无法直连 dsh 端口，只能走 caddy。而 caddy 指向 3080，所以跨机验证必须落在**真实拓扑**上（= 上线），没法用旁路服务器糊过去 |
| ② | ~~executor **不建立 SMB 凭据**~~ | ✅ **已修**（见 §1「executor 自带 SMB 凭据」）：凭据由 executor 在 `bind.apply` 时自动应用，主机名从绑定的 `visiblePath` 推出，不再需要用户手工 `cmdkey` |
| ③ | 手改 `storages/workspace.json` 破坏域不变量 | 工作区要通过 Web UI 建，别手改存储 |

**因此跨机验证的形态是**：把 3080 切到 `web-client`（`patchReload: live` 之外的那一步需要重启），在真实 GUI 里建一个会话、cwd 指向 `\\192.168.28.239\ws-smbtest` 对应的工作区，由 agent 跑一条 `hostname` —— **子进程自报 `SUNDA` 就是跨机证明**。这也顺带把 `argv[0]` 跨机解析、UNC 路径翻译、真实 shell 工具链（而不是探针直调 `spawn`）一次性验掉。

**为什么这可以接受**：挂载客户端世界对**未绑定的工作区是行为中性的** —— 所有未绑定工作区照旧在服务器执行，与今天完全一致（真实组合的 dry run 已证）。所以切换本身不改变任何现状，改变只发生在有人主动绑定之后。

**上线前还差的准备**：① 在 3080 那个 home 里建好 `smbtest` 工作区；② 把 `web-client` 的 executor token / relay 密钥换成真实签发的；③ SUNDA 上装 Node、启动 executor（并在配置页填一次共享凭据 —— 本轮起 executor 会自己应用，不必手工 `cmdkey`）。**防火墙不需要新规则** —— 走的是已经在开的 8443。


### 3.8 `plan.md` 里关于引擎源码改动的说法已过期（本轮核对）

`plan.md` §"会话归属"与 §"git pull 评估"写着：本部署有**源码级本地修改** `packages/api/session-controller` 的 `scopeUser` / `sessionOwnership`。本轮核对：**该修改当前不存在**。

- `grep sessionOwnership` 覆盖整个 checkout，只在 `plan.md` 命中；`grep scopeUser` 在 `packages/api/session-controller` 无命中。
- checkout 的 `git status` 只有一个与认证无关的 `README.zh.md` 一行。
- 原因也在代码里写着：`dsh-remote-local/lib/index.js:722-741` 的 `armSessionFilter` 直接在服务边界包装 `sessionController.list` 并按 `request.scopeUser` 过滤，注释明说"so the core checkout stays untouched" —— 引擎那处改动是**被这个 fork 侧包装取代并撤掉的**。

**对本次改动的意义**：`sessionOwnership` 目前是"有提供方、无引擎消费者"的服务，所以把 `ownerOf` 加到它上面是纯增量、不改变线上任何行为（线上也没挂 dispatcher）。但 `plan.md` 应当更新，否则下一个人会去找一处并不存在的引擎改动。

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
| `plugins/dsh-remote-local/` | 部署侧 dsh-remote fork 上的三处增量：`publicPrefixes` 门禁豁免（HTTP 与 upgrade 共用）、`clientAuthResolver` 服务、`sessionOwnership.ownerOf`（权限一致性用） |
| `plugins/dsh-subprocess-probe/` | pilot 验证 harness（**v1 签字后删除**） |
| `plugins/dsh-subprocess-probe/fixtures/local-service.mjs` | 本机服务 fixture（`/ping`、`/echo`、`/sse`），验证转发用 |
| `profiles/pilot/` | pilot profile（无门禁，验证客户端执行机制） |
| `profiles/pilot-auth/` | pilot + `dsh-remote`（门禁开启 + 种一个 admin），验证 §2.5 登录链路与门禁豁免 |
| **`profiles/web-client/`** | **上线 profile**：`profiles/web` 组合的逐行副本 + 客户端世界四行。已按真实组合验证 |
| `~/.dsh-web-client/` | web-client 的隔离 home（junction 复用 plugins/profiles/.agent-presets/skills，独立 auth/sessions/storages） |
| `skills/local-staging/SKILL.md` | 暂存工作流全局 skill（判定 → 签出 → 处理 → 回写 → 清理） |
| `setup-smb.ps1` | SMB 共享安装脚本（需管理员运行） |
| `measure-smb-boundary.ps1` | P0-3 的边界/性能量具（在**客户端**上跑，也支持对本地盘跑基线） |
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

### P0-3 边界基准（在客户端上跑，量具自动清理）

```powershell
# 客户端：经共享访问（这才是 P0-3 要的数据）
& "$env:USERPROFILE\.dsh\measure-smb-boundary.ps1" -Path '\\192.168.28.239\ws-smbtest'

# 服务器：本地盘基线，用来做对照（§4.8 要的"SMB 往返延迟 vs 本机盘"）
& "$env:USERPROFILE\.dsh\measure-smb-boundary.ps1" -Path 'C:\dsh-workspaces\smbtest'
```

看四件事：10MB 写读耗时、**小文件单次建+删**、**两种改名替换机制各自成败**、独占锁是否被拒。前两项决定 10MB 阈值，后两项决定用户须知怎么写。

### 跑 `pilot-auth`（含权限一致性用例）

把 `pilot` 换成 `pilot-auth`（`DSH_HOME` 用 `~/.dsh-pilot-auth`、端口 3084、token 用 `pilot-auth-executor-token-0123456789`）。权限一致性用例还需要一个会话归属映射，**必须在启动前写好** —— 归属表只在首次读取时加载：

```powershell
'{"sess-occupant-fixture":"probe-primary","sess-foreign-fixture":"probe-admin"}' |
  Set-Content "$env:USERPROFILE\.dsh-pilot-auth\auth\session-owners.json" -Encoding utf8 -NoNewline
```

读结果时看 `perm-*` 四步的 `executedOn`（client/server）与 `parsed.cwd`，以及 `dispatch-trace.jsonl` 里的 `foreign-session-fallback`。

### 断线 / 终止树用例（同一 profile，需要外部在正确的时刻动手）

`pilot-auth` 的 probe 末尾有一段由 `crashMarker` 打开的断线场景：它先武装一个客户端长子进程 + 一个 ConPTY 终端，然后**写出 marker 文件**，等外部把 executor 杀掉。marker 文件是必需的 —— 这一刀必须从进程外砍。

```powershell
# 起 pilot-auth + executor 之后，轮询 marker，一出现就杀 executor
$m = "$env:USERPROFILE\.dsh\profiles\pilot-auth\crash-armed.marker"
while (-not (Test-Path $m)) { Start-Sleep -Milliseconds 400 }
# 此时杀 executor（job_kill，或按 pid Stop-Process），然后等同一次运行跑完
```

看 `crash-inflight-spawn`（应为 `rejected: … lost its executor connection`，毫秒级）、`crash-terminal-terminate`（应为 `terminated`）、**`crash-binding-active`（必须为 `true`，否则下面那条不成立）**、`crash-offline-spawn`（应为 `ok:false` 且错误里含 `was not run on the server instead`）。

终止树用例在**第 4 步**（不需要杀 executor）：看 `termination` 的 `grandchildPid` 与 `grandchildAlive`，再用 `Get-CimInstance Win32_Process -Filter "ProcessId = <pid>"` 独立复核一次。

### 跑 `web-client`（上线组合复测，不需要 probe）

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh-web-client"     # 隔离 home，不要用线上 home
Set-Location C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile web-client --port 3086               # 后台

# 起 executor，然后直接用它验绑定→路由翻转（无 probe 也能验）
node "$env:USERPROFILE\.dsh\plugins\dsh-subprocess-dispatch\executor\executor.mjs" `
  --server ws://127.0.0.1:3086/executor `
  --token <该 profile 配置里的 executor token> --label go-live-check
```

绑定后隔 2–3 秒读 `profiles/web-client/dispatch-trace.jsonl` 里最后一条 `routing-index`：应从 `宝单科技资料=server` 翻为 `=client`，`unbind` 后翻回。

三条门禁判据（**看错误文本判断是谁答的**：有处理器文本 = 已放行）：

```powershell
$h = @{ authorization = "Bearer <该 profile 配置里的 executor token>" }
Invoke-WebRequest http://127.0.0.1:3086/api -SkipHttpErrorCheck                                   # 403 门禁
Invoke-WebRequest http://127.0.0.1:3086/client-auth/state -SkipHttpErrorCheck                     # 401 我的处理器
Invoke-WebRequest http://127.0.0.1:3086/client-auth/state -Headers $h -SkipHttpErrorCheck         # 200
```

---

## 7. 上线前的回归清单

**为什么要有这一节**：客户端执行世界改的是 `ctx.subprocess` 这个**所有 shell 调用都要过**的服务，还有一个跑在用户机器上的独立程序。切换前必须能一次性确认"没坏"，否则线上出问题只能靠猜。

清单分三段。**只要碰过 `plugins/dsh-subprocess-dispatch/` 或 `plugins/dsh-client-bindings/`，就必须重跑 A 和 B。**

### A. 完整功能（`pilot-auth`，最全的一段）

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\pilot-auth"
Remove-Item "$p\dispatch-trace.jsonl","$p\probe-result.jsonl","$p\crash-armed.marker" -ErrorAction SilentlyContinue
$env:DSH_HOME = "$env:USERPROFILE\.dsh-pilot-auth"
Set-Location C:\Users\bestarc\Desktop\deepseek-harness
pnpm dsh --profile pilot-auth --port 3084          # 后台
# 起 fixture（38450）与 executor（token 见 profile），然后：
#   轮询 crash-armed.marker 出现 → 杀掉 executor（这是用例要求的动作，不是干扰）
```

**判据**：出现 `probe-complete`，且**失败项恰好只有两条**，且**没有任何 `HUNG`**：

| 允许失败的两条 | 为什么它们是"对的" |
|---|---|
| `argv0-unresolvable` | 刻意构造的负例：程序名在本机找不到时**必须明确报错** |
| `crash-offline-spawn` | §4.5 要求"已绑定但 executor 掉线 → 明确失败、绝不静默回落"，所以它**本来就该失败** |

关键值（与已验证行为逐项对齐，任一不符即为回归）：

| 步骤 | 期望 |
|---|---|
| `client-execution` | `parsed.cwd` = `C:\dsh-executor-root`（翻译后的路径，不是服务器路径） |
| `perm-occupant-session` / `perm-foreign-session` | `executedOn` 分别为 `client` / `server` |
| `terminal-python-repl` | `sawBanner`、`sawMarker`、`sawTranslatedPath` 皆 true，`sawServerPath` **false** |
| `stdin-roundtrip` | `sawPayload` true、`exitCode` 0 |
| `stdout-spill` | `inMemoryBytes`=4096、`lossy` true、`spillBytes`=300000、`complete` true |
| `termination` | `settledWithin15s` true、`grandchildAlive` **false** |
| `crash-inflight-spawn` | `outcome` 以 `rejected:` 开头，`ms` 在几千以内 |
| `crash-binding-active` | **true**（否则它下面那条不成立） |
| `prompt-section-bound` / `unbound` | 长度 1463 / 0 |
| `relay-sse` | `streamed` true，三个 `arrivals` 间隔约 400ms |

### B. 上线组合（`web-client`）

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh-web-client"
pnpm dsh --profile web-client --port 3086
```

| 检查 | 期望 |
|---|---|
| 路由索引 | 每个工作区都是 `server`（未绑定基线） |
| `/api` 无 cookie | **403**（门禁答的，body 里没有我的处理器文本） |
| `/client-auth/state` 无 token | **401** `a valid executor token is required`（**我的处理器**答的 → 前缀确实放行了） |
| `/client-auth/state` 带 token | 200 |
| `/client-relay/<错密钥>/3845/x` | **403** `unknown relay secret`（同上，是处理器答的） |
| `/executor` 无/错 token | WebSocket **close code 4001** |
| `/executor` 正确 token | 保持连接 |
| bind → 索引 | 该工作区由 `server` 翻为 `client` |
| unbind → 索引 | 翻回 `server` |

> **测试时别用同一个 token 再连一个 executor。** 设计上每个账号只保留一条连接，第二个连接会把真 executor 顶掉，然后真 executor 自动重连又把测试连接顶掉 —— 两边来回抢，测试连接会以 `1005` 关闭，看起来像"认证失败"。要单独测 `/executor` 的认证，就用**错 token**那两条；正确 token 那条看到 `1005` 属于预期。

### C. 上线前的最后三件事

1. `profiles/web-client/cordis.patch.yml` 里的 `tokens` / `relayTokens` 换成**真实签发**的值（现在是测试值）。
2. 确认待提交文件里搜不到任何真实凭据：
   ```powershell
   git grep -n --fixed-strings '<真实 token 的前 12 位>' --
   ```
3. 客户端机器：装了 Node、executor 在跑、配置页里填过一次共享凭据。


