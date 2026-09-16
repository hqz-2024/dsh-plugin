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
| **P1** | admin 强制解绑（接口层 + **界面**） | ✅ 已验证（界面用真实浏览器验过，见 §1） |
| **P1 剩余** | 账号上的工作区授权字段 | ❌ 未做（`workspaces` 复用 roleMap，计划 §2.1 明确允许） |
| **P2** | 客户端真的执行：传输层 + executor + 路径翻译 + 终止阶梯 | ✅ 已验证（含心跳回路） |
| **P2** | **权限一致性**（§2.1：执行机必须是会话账号自己绑定的那台） | ✅ 已验证（本轮，`DSH_SESSION_ID` 归属比对） |
| **P2** | 终止按进程树、不留孤儿（`tasklist` 可证） | ✅ 已验证（本轮，孙进程用例 + 独立复核） |
| **P2** | 断线语义（§4.6：在跑的调用有确定结局、不挂起） | ✅ 已验证（本轮，1964 ms 失败收场） |
| **P2** | §4.5 executor 掉线时后续 spawn **明确失败**、绝不静默回落服务器 | ✅ 已验证（本轮，错误文本自己声明未回落） |
| **P2 剩余** | `argv[0]` 跨机解析 **已修复**；初始 stdin 与 spill **本轮已验证**（stdin 曾是真 bug，见 §1） | ✅ 该组已清 |
| **P3** | ConPTY 交互式终端（含 Ctrl-C 中断） | ✅ 已验证（**Ctrl-C 与信号拒绝是后来才真测的**，见 §1） |
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

### UNC 当工作目录：计划担心的那条，实测**不适用于我们用到的程序**（本轮）

计划 §4.3 写着："**UNC 不能作为进程工作目录**（`cmd` 与部分程序会拒绝）。路径翻译时 `spawn` 的 `cwd` 要么用本地盘符，要么退到临时目录 + 绝对路径传参 —— **P2 定死**。"

**这条一直没被测到，而且原因很隐蔽**：此前所有 spawn 用例的 `visiblePath` 都是**本地路径** `C:\dsh-executor-root`（当初是刻意跟服务器路径不同，好让"路径被翻译过"可证）。而生产的可见路径**就是 UNC** —— 也就是说，最贴近生产的那种形态，恰恰是唯一没跑过的那种。

**分两步测。**

第一步，直接问操作系统（同一台机器，UNC 可达）：

| 程序 | 结果是 |
|---|---|
| `node.exe` | exit 0，`process.cwd()` = `\\192.168.28.239\ws-smbtest` ✅ |
| `powershell.exe` | exit 0 ✅，但 `(Get-Location).Path` 给出的是 **provider 形式** |
| **`cmd.exe`** | exit 0 —— 但**静默把工作目录退回了 `C:\Windows`**，并提示"UNC 路径不受支持" |

第二步，端到端（pilot 的 `visiblePath` 改成真实 UNC，`workspaceTitle: smbtest`）：

| 观察 | 值 |
|---|---|
| `client-execution` | `ok`，子进程自报 cwd = **`\\192.168.28.239\ws-smbtest`**（就是那个 UNC） |
| 路线翻译 | `translated = \\192.168.28.239\ws-smbtest` |
| 交互式终端 | 可用；PowerShell 提示符显示 `PS Microsoft.PowerShell.Core\FileSystem::\\192.168.28.239\ws-smbtest>` |
| 其余全部步骤 | 与本地路径那次一致，唯一的 FAIL 仍是刻意构造的 `argv0-unresolvable` |

**结论**：计划那条要防的问题**对 dsh 实际使用的程序不存在** —— PowerShell 与 Node 都接受 UNC 当 cwd，所以"退到临时目录 + 绝对路径传参"这套兜底**不需要做**。`cmd.exe` 是唯一拒绝的，而 dsh 的 shell 工具跑的是 pwsh/bash，不是 cmd。

**但比"拒绝"更值得记的是 `cmd.exe` 的失败方式**：它**不报错、退出码 0，只是把目录换成了 `C:\Windows`**。也就是说任何经 `cmd /c` 出去的活都会在错误的目录上默默执行 —— 这类"成功了的失败"比直接报错危险得多。

**实测出来的第二个坑（PowerShell 的 provider 形式）**：cwd 是 UNC 时，`(Get-Location).Path` 与 `$PWD` 返回的是

```
Microsoft.PowerShell.Core\FileSystem::\\192.168.28.239\ws-smbtest
```

PowerShell 自己认这个形式（`Test-Path` 为 True），但**别的程序不认**。而 `(Get-Location).ProviderPath` 与 `(Get-Item .).FullName` 给的是干净的 UNC。这个形式从路径本身看不出来，只有真跑一次才会遇到 —— 所以**写进了 v1 提示词段**（仅当可见路径是 UNC 时追加）：告诉模型 PowerShell 会用 provider 形式显示位置、`cmd /c` 会静默换目录、以及要取干净路径该用哪个属性。

**验证这个新增段落确实生效**：probe 增加了两个直接断言（`hasShareGuidance`、`hasCmdFallbackWarning`），实测都为 `true`；段落长度 1465 → 2099；未绑定时仍为 **0**（这段只在 UNC 绑定时出现）。

**回归安排**：`pilot` 固定成 UNC（生产形态），`pilot-auth` 保留本地路径 —— 两个 profile 合起来把两种形态都覆盖。pilot 因此多了一个前置：跑之前要 `net use` 建一次 `dshtest` 凭据（已写进 profile 注释与 §7），跑完收掉。

### §4.2 的并发仲裁：**真的跑了一次race**，并因此发现 `sweep()` 会把刚拿到的绑定抹掉（本轮）

计划 §4.2 写着"两台设备同时抢一个已失效的绑定，**由服务端单点仲裁：先到者成功，另一个收到拒绝**"。这是一条**并发**断言 —— 而并发断言恰恰是最容易"碰巧通过"的那种，所以这轮不是读代码，而是真发了一次竞争。

**（一）竞态本身：设计成立。** 五个 claim 在同一个 tick 里入队，结果：

| 观察 | 值 |
|---|---|
| 同时尝试 | 5 |
| 成功 | **1**（`racer-0`） |
| 失败者 | 4 个，**全部**回报 `occupied:racer-0` —— 不只是拒绝，还说清了是谁拿走的 |
| `exactlyOne` | **true** |

机制也对得上：`claim` 整个跑在 `enqueue` 里，`isLive(existing)` 的判定与 `table.put` 在**同一个临界区**内，中间没有 await 能让别人插进来。

**（二）但顺着这条线读下去，发现了另一个真的竞态。** `enqueue` 的注释写着"Queue one mutation behind every earlier one; racing claims therefore resolve in order" —— 而 `claim` / `heartbeat` / `release` 都走了队列，**`sweep` 与它调用的 `finish` 没有**。`sweep` 同样在改这张表。

交错是这样的：`sweep` 先用快照 `[...this.table.entries()]` 判定"W1、W2 都已失效"，然后逐个 `await this.finish(...)`。**在 W1 那个 await 期间**，一个 `claim(W2)` 可以完整跑完并写入新记录；`sweep` 恢复后处理 W2 时用的还是**旧快照**，于是 `finish(W2)` 重新读到的是**刚写进去的那条新记录**，把它标成了 ended。

**不是推理，是复现出来的**（给 pilot 临时配 `graceMs: 800 / sweepMs: 600000`，好让"已失效但还没被扫到"这个状态稳定存在；否则 1 秒一次的扫描会抢在测试之前把窗口关掉）：

| | 修复前 | 修复后 |
|---|---|---|
| `claim` 返回 | `ok:true` | `ok:true` |
| 表里剩下的记录属于 | **`sweep-stale`**（上一条） | `fresh-claimer` |
| 新绑定是否已被标 ended | **是**（`heartbeat-timeout`） | 否 |
| `raceReproduced` | **true** | **false** |

**修复前的结局比"绑定被立刻作废"更糟**：`claim` 报成功，而存储里留下的是**上一条已结束的记录** —— 客户端以为自己拿到了工作区，服务端那边却是死的。

**修法**：让 `sweep` 走同一条队列。这不是防御性代码，而是**恢复模块自己声明的那条不变量**（所有对这张表的改动都串行化）。`sweep` 只调用未入队的 `finish`，所以不会自锁。

**验证修复没有把扫描本身弄坏**：同一个用例里同时断言 `sweepExpired = sweep-race-1, sweep-race-2` 且 `sweepStillExpires = true` —— 扫描**照样会把失效记录标结束**，只是不再抢掉别人的 claim。恢复成正常配置（心跳 1s / 宽限 20s / 扫描 1s）再跑一遍完整用例，仍然全绿。

**如实说明**：要在测试台上稳定复现，需要一组刻意敌对的配置（宽限 800ms、周期扫描推到 10 分钟）。生产配置是宽限 120s、扫描 15s，窗口真实存在但很窄 —— 触发条件是"一次扫描遇到 ≥2 条失效记录，且期间有人认领其中靠后的一条"。所以这是一个**低概率但真实的正确性缺陷**，不是日常可复现的故障。

### spill 超过上限时留下的半截文件，以及一条更糟的错误路径（本轮，已复现并修复）

接上一轮的思路：继续找**被断言但没被验过**的性质。这次是 spill 的失败路径。

seam 的契约写着：整条流的上限 `spill.maxBytes` 被超过时，"a larger stream discards its now-incomplete spill"。这句话有两个可以分别成立、也可以分别失败的部分：

1. **不能把半截文件的路径交给调用方**（否则调用方会把它当成完整输出）
2. **那半截文件不该留在磁盘上**

**第 1 条是成立的**：超限用例里 `advertisesNoSpill = True`，`readFrom` 不返回 `spillPath`。安全的那一半没问题。

**第 2 条不成立**：`leakedAPartialSpill = True`，目录里多出一个截断的 `proc-…-stdout.log`。而引擎自己的 provider 是**显式删掉**它的（`discardSpill()`，注释就写着 "the file may be incomplete"）。留下的危害不是占空间，而是**它和一份完整的 spill 在目录里长得一模一样** —— 谁去读那个目录，都可能把截断的捕获当成完整输出。这与上一轮那个 bug 是同一类：**没有报错，但结果是错的**。

**读代码时又发现第二条通往同一后果的路，而且更糟**：`stream.on('error')` 的回调只是空注释，**没有清掉 `intact`**。也就是说 spill 写入失败（磁盘满、句柄失效）之后，`intact` 仍为 true，`readCollected` **照样把那个截断文件的路径报给调用方** —— 这一条正好违反上面第 1 条。

**修法**：把两条路径收进一个 `discardSpill(name)`（标记 `intact = false` + 删文件）。删除要等 `close` 之后再 `unlink` —— Windows 不允许删一个还有打开句柄的文件。

**验证**（同一次运行，两半都断言）：

| | 修复前 | 修复后 |
|---|---|---|
| 超限：`advertisesNoSpill` | true | true |
| 超限：`leakedAPartialSpill` | **true** | **false** |
| 超限：磁盘上多出的文件 | 截断的 50KB | 无 |
| **未超限（对照）**：`spillBytes` / `complete` | 300000 / true | **300000 / true**（没有把好路径也一起弄坏） |
| 跑完后目录里的文件 | 2 个（1 完整 + 1 半截） | **1 个**（只有那份完整的） |

唯一的 FAIL 仍是刻意构造的 `argv0-unresolvable`。

**顺带一个运维观察**：完整 spill 是**按设计保留**的（调用方负责读走并清理），所以我前面十几轮跑下来，`%TEMP%\dsh-remote-spill\` 里积了 15 个 300KB 文件。这不是缺陷，但值得知道 —— 长期跑大量长输出的会话，这个目录会涨。

### P4 的错误路径：上游服务没在跑（本轮补齐）

计划 P4 的验收是"Figma MCP 工具出现在会话工具表并能取回节点数据"，那需要真的开着 Figma。但**更常见的日常情形是它没开** —— 而这条错误路径此前从没测过。`relayPorts` 里的 3845 是 Figma 的端口，测试机上正好没有任何东西在听，就是"用户没开 Figma"那个情形。

判据是"确定且说明原因"的失败（§4.5 的一贯要求）：**不能挂起，也不能是一个不说理由的 502**。

| 步骤 | 结果 |
|---|---|
| `relay-plain` / `relay-post-body`（上游活着） | 200 |
| `relay-sse` | 200，3 个事件，到达 `411, 813, 1221`，`streamed=true` |
| `relay-port-denied` | 403 `port 1234 is not in the relay allowlist` |
| `relay-unknown-secret` | 403 `unknown relay secret` |
| **`relay-upstream-dead`** | **502 `connect ECONNREFUSED 127.0.0.1:3845`** |

**关键在这条与上面三条 200 出现在同一次运行里** —— 所以它不是"整体都 502"，而是针对那一个上游的、指名道姓的失败：错误文本里带着**确切的端口号**，用户一眼能看出是哪个服务没开。

**跑第一次时我忘了起 fixture**，于是四条 relay 用例全变成 `502 ECONNREFUSED 127.0.0.1:38450`。这反而顺带证明了同一件事的另一半：上游是谁没开，错误里就写谁。但那次运行不能算数（P4 的正常路径没被验），所以起了 fixture 重跑了一遍 —— 上面那张表是重跑的结果。



### P3 的 Ctrl-C 与信号拒绝：状态表里那个 ✅ 此前**没有依据**（本轮补齐）

§0 的状态表从很早开始就写着「P3 | ConPTY 交互式终端（**含 Ctrl-C 中断**）| ✅ 已验证」。本轮去核对时发现：**没有任何用例调用过 `signalForeground`** —— 那个 ✅ 是当时顺手写下的，不是测出来的。这比缺一个功能更糟，因为读表的人会以为它已经被验过。

补齐后的结果（两次独立运行，完全一致）：

| 调用 | 结果 |
|---|---|
| `signalForeground('SIGKILL')` | **拒绝**，`refusing to SIGKILL; terminate the terminal session instead` |
| `signalForeground('SIGHUP')` | **拒绝**，`signal SIGHUP is unsupported on Windows` |
| `signalForeground('SIGINT')` | 接受 |
| **那条 120 秒的 `Start-Sleep` 是否真被打断** | **是** |
| **打断之后会话还能不能用** | **能**（再跑一条命令仍出结果） |
| 终止之后再发信号 | `terminal is terminating` |

§3.4 那张表里关于信号的叙述，现在都有实测支撑。

**这一轮真正的教训在测试方法上。** 第一版用字面标记（`Write-Output 'SHOULD-NOT-APPEAR'`）判断"命令有没有跑完"，结果**同一份代码在连续两次运行里给出 True 和 False**。原因是 PTY **会回显敲进去的内容**，而且 PSReadLine 会把字符串字面量按语法重新渲染（中间插入颜色转义）。我第二次试着把标记拆成 `'SHOULD'+'-NOT'+'-APPEAR'` 来绕开回显，**仍然不可靠** —— 因为我在猜回显的确切形态，而不是消除这个变量。

最后改成让命令打印一个**随机 GUID**：那个值只可能在命令真的执行过之后出现，回显里永远不会有。两次运行结果一致。**结论：能靠"构造不可能出现的证据"就不要靠"猜测呈现形式"。** 这与前面几轮的教训是同一个：断言落在**只有目标行为发生时才可能出现**的观测上。



### §2 表里那几条"已验证"，此前没有任何用例在复查（本轮补齐）

接上一轮"状态表里有个 ✅ 没有依据"的思路，这轮去核对的是 §2 那张「绑定存储（已验证语义）」表。这几条**当初确实测过**（早期手工核对），但**没有任何用例在复查它们** —— 也就是说，后来任何一次改动都能悄悄弄坏它们而没人知道。对一个决定"用户揣着机器走了以后会发生什么"的规则来说，只测一次是不够的。

现在已经进了常规回归，而且**跑在 profile 真实的宽限期（20 秒）上**，不是缩短的测试值 —— 缩短的窗口测的是一个没人会用的配置。

| 判据（§2.1） | 观察 |
|---|---|
| 失效 ≠ 删记录 | `recordStillPresent=true`、`endedAtSet=true`、**`endReason=heartbeat-timeout`** |
| 原机重连**不自动夺回** | `revivalRefused=true`，`reason=not-held` |
| 他人可直接接管失效绑定 | `takeoverAllowed=true`，占用者为 `machine-b` |
| 撤销授权 → 强制解绑 | `revocationDropped=1`，被解绑的机器为 `B` |

**过程里我自己写错了一条断言，值得记下来。** 我先显式调了一次 `sweep()`，期望它返回这条记录的 id，结果 `expiredByThisSweep=false` —— 而记录本身**确实**已经被标结束了（`endedAtSet=true`、`endReason=heartbeat-timeout`）。原因不是缺陷：profile 每秒扫一次，**周期扫描在等待的那 22 秒里早就把它标结束了**，于是显式那次看到 `endedAt` 已有值就跳过了它。

我没有停在"应该是周期扫描干的"这个解释上，而是加了一条 `alreadyEndedBeforeMySweep` 把它**测出来**：值为 `true`，与解释一致。

**教训**：一条断言如果可以被"另一个同样正确的机制"满足，就要把**是哪个机制**也记下来。否则一个完全正常的系统会显示成失败 —— 反过来更危险：把断言放宽到"只要结果是好的就行"，就会掩盖机制真的变了。



### §2.5②③ 只做到了"有能力"，没做到"接上了"（本轮，已修复并验证）

顺着前两轮"声称已验证但没人在复查"的线索往下查，这次不是表写错了，而是**功能只做了一半**。

绑定存储从第一轮起就有 `revokeForUsername`，它的注释甚至写着 "Authorization revocation and account disable both land here (plan §2.5), so the caller can send `bind.drop`"。但**全仓库搜下来，除了它自己的定义和我加的测试，没有任何地方调用它**。

后果：管理员把一个工作区从某账号的授权里拿掉、或者直接删掉那个账号，**那条绑定照样活着** —— 那台机器继续替那个工作区执行命令。"授权"只停留在界面语义上。§2.5 把②③写成"必须一起处理的点"，而它们一直没被处理。

**修法（两处调用）**：

| 位置 | 行为 |
|---|---|
| `/auth/accounts` 的 `upsert` | 在写 roleMap **之前**算出这次被拿掉的标题，只对**消失的那些工作区**解绑 |
| `/auth/accounts` 的 `remove` | 解绑该账号的**全部**绑定 |

**为什么只对"消失的那些"**：如果任何一次编辑都全量解绑，那么管理员给账号**加**一个工作区也会把已有的绑定打掉。只有缩小授权才该解绑。这也是给存储的 `revokeForUsername` 加一个 `workspaceIds` 过滤的原因。

**一个不得不处理的映射**：roleMap 里存的是工作区**标题**（`registry.list().filter(w => mapping.workspaces.indexOf(w.title) !== -1)`，`lib/index.js:1091`），而绑定是按**工作区 uuid** 存的。所以解绑前要用 `workspaceRegistry.list()` 把标题换成 id。

**未挂载时是空操作**：`ctx.get("clientBindings")` 拿不到就返回 —— 线上 `web` profile 没有客户端世界，所以这行改动不可能弄坏它。

**验证**（`pilot-auth`，真实门禁 + 真实 admin 会话）：

| 观察 | 值 |
|---|---|
| 先让 `probe-viewer` 持有另一个工作区的绑定（对照） | `heldBefore: true` |
| `POST /auth/accounts` 授予该工作区 | 200 |
| `POST /auth/accounts` 再收回（workspaces 清空） | 200 |
| **绑定是否还活着** | **`stillLiveAfterRevoke: false`** |
| 结束原因 | **`authorization-revoked`** |

**顺带纠正我自己一个差点写错的结论**：我先是只看 executor 侧，发现它**没有任何处理心跳应答的分支**、`dropBinding` 只被 `bind.drop` 调用一次，于是准备写下"executor 会一直以为自己还持有"。接着去看服务端才发现：**服务端在收到心跳时主动查存储，拒绝就发 `bind.drop`**（`client-transport.js:1083`，注释写着 "it is told to drop it instead of beating into the void"）。而那条通路的另一半——executor 侧打印 `dropped binding …: not-held`——早在本进度文档 §1 里就有证据了。结论：**通路是完整的，不需要额外的通知调用**；教训是下结论前要把整条链看完，而不是看一半就推断。



### 账号被删除，它的 executor token 却还活着（本轮，已复现并修复）

把上一轮那把尺子（"有能力 ≠ 接上了"）再用一遍，这次查的是**凭据**那一半。存储里有三个方法**从来没被调用过**：`revokeTokensForUsername`、`revokeToken`、`listTokens`。

**先复现，不下结论**：建一个一次性账号 → 给它签发一个 executor token → 确认 token 能解析 → **删掉那个账号** → 再看 token 还能不能解析。

| | 修复前 | 修复后 |
|---|---|---|
| 账号存在时解析（对照） | `probe-doomed-token` | `probe-doomed-token` |
| **账号删除后解析** | **`probe-doomed-token`** | **（空 / undefined）** |
| `tokenSurvivesAccountRemoval` | **true** | **false** |

**这比上一轮那个绑定问题更严重，而且正好把上一轮的修复绕过去了**：`claim` 问的是绑定存储，**不查账号是否存在**。所以只要 token 还活着，那台机器可以直接**重新绑定**一个工作区。上一轮做的是"撤销时解绑"，可凭据还在，机器自己就能再绑回来。删除账号而保留凭据，等于没有删除。

**修法**：`revokeClientAccess` 在**全量**撤销（账号删除）时连 token 一起吊销；**局部**撤销（只是少了一个工作区）保留 token —— 那个账号还有别的权利要用它。

**如实说明一处没覆盖的**：配置文件里的 token（`subprocess-dispatch` 的 `tokens:` 键值）是**配置层**的，按用户名直接映射，不走账号库，所以删账号不会让它们失效。删了账号还得顺手把配置里那一行去掉 —— 这条已写进运维提示。



### §2.1 的最后一项：admin 强制解绑的**界面**（本轮完成，并用真实浏览器验证）

§2.1 把"admin 在**界面**强制解绑"列为两条人工出口之一。接口早就能用（`/client-admin/bindings`、`/client-admin/unbind`，非 admin 403），但**没有界面** —— 管理员只能自己想办法发 HTTP。

**做法**：给 `dsh-subprocess-dispatch` 加了一个**浏览器半边**（`lib/client.js` + `package.json` 的 `exports["./client"]` 与 `dsh.client`），注册成 `settings.section`（order 1010，紧跟在 auth 插件的「本地插件」1000 之后）。**放在拥有该端点的插件里**，而不是塞进 auth 插件那个 100KB 的设置页 —— 谁拥有这个管理面，谁就拥有它的界面。

界面内容：工作区 / 占用人 / 机器（含 host 与 platform）/ 状态（占用中·已失效 + 在线·离线 + 绑定时刻）/ 强制解绑按钮（只在 `state === "active"` 时出现）。已失效的记录**照样列出来**——§2.1 的"失效 ≠ 删记录"在这里也有用。

**用真实浏览器验证**（Playwright 无头 Chromium，脚本存为 `~/.dsh/check-client-ui.mjs`）：

| 检查 | 结果 |
|---|---|
| 登录 | 200 |
| 客户端 bundle 是否加载失败 | **false**（页面无 "Failed to load plugins"） |
| 设置里出现「工作区绑定」 | ✅（中文标签） |
| 表格表头 | ✅ 占用人 / 机器 |
| 行内容 | `宝单科技资料 │ probe-primary │ probe-executor │ DESKTOP-LCLS51R │ 占用中 在线 │ 强制解绑` |
| **点击「强制解绑」** | `已释放`，**没有任何一行还是「占用中」** |
| 页面级错误 | **0** |

**浏览器抓出了两个读代码绝对看不出来的 bug**，这正是值得为它搭一套真实浏览器验证的原因：

1. **整个 bundle 加载失败**：页面直接显示 `Failed to load plugins — dsh-subprocess-dispatch: cannot get property "slots" without inject`。原因是 `exports.inject = []`。**客户端半边的 `exports.inject` 是运行期注入，和 `package.json` 里 `dsh.client.inject`（加载期）是两回事** —— 用 `ctx.slots` 就必须声明 `slots`，漏了不是"功能降级"，是整个插件加载失败。
2. **标签语言错了**：改对 inject 之后界面出来了，但它的标签是英文 **"Workspace bindings"**，夹在一排中文（「登录与账号」「本地插件」）中间。原因是我从 `document.documentElement.lang` 猜语言 —— 而这个 shell 把该属性留成英文，界面却是中文。正确做法是用应用的 **`locale` 服务**：`ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`（`dsh-remote` 就是这么做的，它因此也支持运行时切换语言）。

### 提示词段**真的到达了会话**：第一次用真实会话验证（本轮）

§2.8.3 的 `execution:world` 段一直被称为"承重"的——没有它 agent 会以为自己在服务器上，把服务器路径写进 shell 命令。但此前对它的验证**只到函数级**：probe 调 `renderExecutionWorld(cwd)` 看返回值，再用 `assemble({})`（**没有 agent**）确认段确实在装配结果里、而渲染长度为 0。

**缺的那一环是**："一个真实会话装配时 `context.agent` 真的有值吗？" 没有它，`text(context) => renderExecutionWorld(context.agent?.session.header.cwd)` 永远返回空串。

**先按源码把链子核对到行**（四环）：

| 环 | 位置 | 事实 |
|---|---|---|
| 1 | `agent-loop/src/agent.ts:242` | 每一轮都 `this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))` |
| 2 | `agent/src/dispatch.ts:174` | `assembleContextFor(agent, signal)` 返回 `{ agent, scope: agent, ... }` —— **agent 必然有值** |
| 3 | `agent/src/runtime-types.ts:19-24` | `declare module '@deepseek-ai/dsh-system-prompt' { interface AssembleContext { agent?: Agent } }` |
| 4 | `dsh-client-bindings/lib/index.js` | 段注册为 `text: (context) => this.renderExecutionWorld(context.agent?.session.header.cwd)` |

**然后真跑了一次**，因为本轮前半段的教训就是"读得再准也不等于测过"。

**怎么看的**：段的文本**不存在于任何事件里**（它在装配时从活状态重建），但装配后的完整系统提示词**记录在会话的 `request/header` 事件里**。这使会话日志成为事后检查真实会话提示词的唯一入口。

**一个不做就做不成的发现**：会话日志是**一事件一个 zstd 帧**，不是一条连续流。Node 的 `zstdDecompressSync` 只解第一帧，于是 383 KB 的日志"只有一个事件"。按 zstd magic 切开逐帧解，才拿到全部 262 个事件。

**结果**（用**真实浏览器**在 `pilot-auth` 里建会话、发一条 `hi`、走完真实模型调用）：

| 会话 | cwd | 是否绑定 | `hasExecutionWorld` |
|---|---|---|---|
| 既有的真实会话 | `…\宝单科技资料` | 否 | **false** |
| 新建（绑定 `.dsh` **之前**） | `C:\Users\bestarc\.dsh` | 否 | **false** |
| 新建（绑定 `.dsh` **之后**） | `C:\Users\bestarc\.dsh` | **是** | **true** |

绑定后那一次的提示词 20032 字符（未绑定时 18579），段列表里出现 `Where your commands run`，正文是：

```
This session's workspace ".dsh" is bound to the user's own computer (DESKTOP-LCLS51R),
which runs win32 10.0.19045. ...
- The file tools ... address this workspace as `C:\Users\bestarc\.dsh`.
- A shell command's working directory is the SAME directory seen from the user's computer: `C:\dsh-executor-root`.
```

**两个未绑定的对照排除了"段总会渲染"这个替代解释**：同样的代码、同样的 profile，只是没有绑定，段就不出现。

检查工具存为 `~/.dsh/check-session-prompt.mjs`（逐帧解码；报告段是否存在，`--dump` 直接打印那一段）。



### 真实 agent 用 shell 工具跑的命令落到了客户端（本轮，此前只验过分派层）

P2 的验收原文是"**已绑定工作区的 `bash` 在用户机上跑 PowerShell**"。但此前所有路由验证都是**直接调 `ctx.subprocess.spawn`** —— 也就是绕过了 shell 工具那一层。从 `tool-pwsh` 到 `shellEnv.collect`、再到 `pwsh-local` 的 `spawnSpec`、最后才到 `ctx.subprocess` 这段，**只被读过，没被跑过**。

本轮用真实路径跑了一遍：浏览器里在已绑定 `.dsh`（可见路径 `C:\dsh-executor-root`）的工作区建会话，让 agent 自己决定用什么命令。

**会话日志里的原始证据**：

```
tool/call    name=pwsh
             arguments={"command": "Get-Location | Select-Object -ExpandProperty Path; hostname"}
tool/result  "C:\\dsh-executor-root\r\nDESKTOP-LCLS51R\r\n"   isError=false
```

`C:\dsh-executor-root` 是**翻译后的可见路径**，而服务器路径是 `C:\Users\bestarc\.dsh`。所以这一条同时证明：**shell 工具真的走过了分派层**、**命令真的在 executor 侧执行**、**cwd 被翻译过**、**结果经 WebSocket 回来了**。

而且 agent 自己的措辞说明提示词段起了作用（它写着："这个 pwd 是用户电脑上的路径（`C:\dsh-executor-root`），不是文件工具看到的 `C:\Users\bestarc\.dsh` —— 同一份文件的两个写法"）。这正是 §2.8.3 那段存在的理由。

### §2.1 的检查**实际能覆盖到谁**：只覆盖 roleMap 映射过的账号（本轮查清）

上面那次运行里还有一条值得记的事：会话账号是 `probe-admin`，而绑定的占用者是 `probe-primary`，两者不同 —— 按 §2.1 本应**拒绝本地执行**，但命令照样跑在了客户端。追下去发现不是缺陷，而是**检查的射程本来就只到这里**：

| 事实 | 位置 |
|---|---|
| 会话归属只在 `session.prompt` / `rename` / `attachment` 时写入 | `lib/index.js:1279-1282` |
| 整段写入逻辑被 `if (mappedWs !== null)` 包着 | `lib/index.js:1252` |
| `mappedWs` 只对 **roleMap 有工作区映射**的账号非空 | `lib/index.js:1242` |
| 而 admin **没有** roleMap 映射（fork 的既定设计："Admin never receives scopeUser and stays unfiltered"） | 同处 |

所以：**admin 的会话永远不会被登记归属** → `ownerOf` 返回 null → 我的 `admit()` 按"归属未知"处理、保持绑定 → 命令落在那个占用者的机器上。这与我在代码注释里写的"归属未知就不改绑定"是一致的，但**当时没意识到"admin 会话"正是归属未知的常见情形**。

**后果与判断**：受影响的是"管理员在一个被别的账号绑定的工作区里开会话" —— 管理员的命令会跑在别人的电脑上。计划 §2.1 的字面要求是禁止这种情形。但这个部署的账号模型里，admin 本就在按账号区分的机制之外（能看到全部、能强制解绑、没有工作区授权），所以"该管理员自己绑定的那台机器"并没有定义。**如实记为已知边界，不假装它不存在，也不为它发明一套归属**。管理员遇到这种情况的正确动作是：要么自己绑一次，要么先用强制解绑把占用者释放掉。

**受保护的账号（roleMap 映射过的非 admin）不受影响**：它们的会话在第一次发言时就会写入归属，检查随后生效。



### 为什么这条证据是有效的

子进程打印 `process.cwd()`。服务器路径与 `visiblePath` 不同，所以 cwd 等于 `C:\dsh-executor-root` 同时证明三件事：**进程跑在 executor 侧**、**cwd 被翻译过**、**stdout 走完了 WebSocket 往返**。三件事各自都有反例（服务器执行会打印服务器路径）。

> ⚠️ 本次 executor 与服务器**同机**，所以 `argv[0]` 用了服务器侧的 `node.exe` 绝对路径也能跑。跨机时这是个真问题，见 §3.1。**跨机验证至今仍未做**（见 §3.7）。

---

## 2. P1 绑定存储（已验证语义）

| 场景 | 结果 |
|---|---|
| 活跃占用时第二台机器 claim | `ok:false, reason:occupied, occupant:<用户名>` |
| **5 个 claim 同时抢一个空闲工作区** | **恰好 1 个成功**；其余 4 个都回报 `occupied:<胜者>`（§4.2 的单点仲裁，本轮实测） |
| **扫描与认领交错** | 修复前：`claim` 报成功但记录被扫描抹掉（**已修**，见 §1「§4.2 的并发仲裁」） |
| release 后 | `ok:true`，路由回落 server |
| 心跳超时 | `state:expired, endReason:heartbeat-timeout`（**记录保留，不删**） |
| 失效机心跳 | `ok:false, reason:not-held`（**不自动夺回**） |
| 他人接管失效绑定 | `ok:true` |
| 撤销授权 | `dropped:[{workspaceId, machine}]` |

> 上表自本轮起由 probe 的 `binding-expiry-keeps-record` 与 `binding-semantics` 两步**每次运行都复查**，且跑在真实的 20 秒宽限期上（此前只在早期手工核对过一次）。
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
- **admin 强制解绑已完成并验证**（`/client-admin/bindings` + `/client-admin/unbind`，非 admin 403），**界面也已补上**并在真实浏览器里点过（设置 → 工作区绑定，见 §1）
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
| P4 验收 | Figma MCP 工具出现在会话工具表并能取回节点数据 | ⛔ 需 Figma 桌面 App + Dev Mode MCP。**上游没开时的错误路径已验**（502 + 确切端口，见 §1） |
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
5. **清理进程时不要用宽泛的匹配** —— 本轮收尾时用 `*chromium*` 过滤 `node.exe`，杀掉的不只是自己起的无头 Chromium，还有**四个早就存在的 Playwright MCP 服务进程**（父进程已不在，没人会重启它们）。规则：**只杀自己起的东西** —— 用 job id，或记下确切的 pid；非要用命令行子串匹配，先把会命中的清单打印出来看一眼。这条与本项目其它几次操作失误同源（端口没释放就重启、`job_kill` 连带整棵进程树），都是「图省事的一次性清理动作」。

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

> **`pilot`（3082）现在是 UNC 形态**（`visiblePath` 是真实共享），因为它覆盖生产配置，而 `pilot-auth` 用本地路径 —— 两者合起来把两种形态都覆盖。跑 `pilot` 之前要在同一个登录会话里先建一次共享凭据，否则客户端子进程进不去那个目录：
>
> ```powershell
> net use \\192.168.28.239\ws-smbtest /user:dshtest <密码>
> # 跑完：net use \\192.168.28.239\ws-smbtest /delete
> ```
>
> 判据里多两条：`prompt-section-bound` 的 `hasShareGuidance` 与 `hasCmdFallbackWarning` 都应为 **true**（只在 UNC 绑定时出现；`pilot-auth` 的本地路径形态下它们应为 false）。

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
| `relay-upstream-dead` | **502**，且错误文本含 `ECONNREFUSED` 与**确切端口**（3845 无人监听），不能是挂起或无理由的 502 |
| `terminal-signals` | `refusedKill`/`refusedHup` 都是 `ok:false`；`sentInt` 是 `ok:true`；**`interruptedTheCommand` 与 `sessionSurvivedAndUsable` 都为 true**（用随机 GUID 判定，别改成字面标记 —— 见 §1） |
| `terminal-signal-after-terminate` | 错误为 `terminal is terminating` |
| `binding-expiry-keeps-record` | `endedAtSet` true、`endReason=heartbeat-timeout`、`recordStillPresent` true。**`expiredByThisSweep` 通常是 false**（周期扫描先动手，见 `alreadyEndedBeforeMySweep`）—— 那不是失败，别把它当判据 |
| `binding-semantics` | `revivalRefused` true（`not-held`）、`takeoverAllowed` true、`revocationDropped≥1` |
| `account-authorization-revokes-binding` | `heldBefore` true（对照）、两个 `/auth/accounts` 调用都 200、**`stillLiveAfterRevoke` false**、`endedReason=authorization-revoked` |

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


