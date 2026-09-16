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
| **P0-2 / P0-3** | SMB 双向可见 / 边界实测 | ⛔ 阻塞：需管理员提权 + 第二台设备 |
| **P1** | 绑定存储（占用人 / 心跳 / 失效 / 仲裁 / 撤销） | ✅ 已验证 |
| **P1** | executor 授权与登录链路 + **本地配置页**（§2.5 闭环） | ✅ 已验证（`pilot-auth`，真实门禁下） |
| **P1** | admin 强制解绑（接口层） | ✅ 已验证；Web UI 入口未做 |
| **P1 剩余** | 账号上的工作区授权字段、admin 强制解绑界面 | ❌ 未做 |
| **P2** | 客户端真的执行：传输层 + executor + 路径翻译 + 终止阶梯 | ✅ 已验证（含心跳回路） |
| **P2** | **权限一致性**（§2.1：执行机必须是会话账号自己绑定的那台） | ✅ 已验证（本轮，`DSH_SESSION_ID` 归属比对） |
| **P2** | 终止按进程树、不留孤儿（`tasklist` 可证） | ✅ 已验证（本轮，孙进程用例 + 独立复核） |
| **P2** | 断线语义（§4.6：在跑的调用有确定结局、不挂起） | ✅ 已验证（本轮，1964 ms 失败收场） |
| **P2** | §4.5 executor 掉线时后续 spawn **明确失败**、绝不静默回落服务器 | ✅ 已验证（本轮，错误文本自己声明未回落） |
| **P2 剩余** | `argv[0]` 跨机解析 **已修复**；stdin / spill 未验证 | 🟡 部分 |
| **P3** | ConPTY 交互式终端（含 Ctrl-C 中断） | ✅ 已验证 |
| **P3** | crashtest：关 executor 时终端不挂死 | ✅ 已验证（本轮） |
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

### 3.2 权限一致性（§2.1 的安全要求）—— ✅ 已修复

计划要求"执行机必须是该会话账号自己绑定的那台"。原缺口：dispatcher 看不到会话身份，所以**工作区被 A 绑定时 B 的会话照用不误**。

**已按 §4.5 实现并验证**（证据见 §1「P2 权限一致性」）：`DSH_SESSION_ID` 是 shell 工具每次都会注入的内建环境变量，所以 shell 调用这条路径上会话身份本来就是可得的 —— 只是没人用。dispatcher 现在拿它与绑定的占用者比对，不一致则视同未绑定、回落服务器。

**仍未覆盖的输入**：不带 `DSH_SESSION_ID` 的 spawn（LSP、subagent CLI、`fs` 搜索的 ripgrep）仍只按绑定路由。这些路径上没有任何东西标识会话，要覆盖它们需要另一条身份通道（或让这些消费者也走 shell-env），属 v2。

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

### 3.7 按计划的验收判据逐条核对后，仍缺的项（本轮复核）

拿 `plan-client-world.md` 里**写明的验收判据**逐条对账，而不是凭印象。本轮补掉的是 §4.5 / §4.6、P2 的终止树与 P3 的 crashtest（证据见 §1）。仍然缺的：

| 判据出处 | 判据 | 状态 |
|---|---|---|
| P0 验收 | SMB 双向可见 | ⛔ 阻塞（需管理员 + 第二台设备） |
| P0-3 | 8–10MB 边界文件与 **Office 在 SMB 上的锁文件行为**有数据 | ⛔ 阻塞（依赖 SMB） |
| P3 验收 | **python REPL** 可用（已验的是 PowerShell） | 🟡 未做 |
| P3 验收 | "断网"（不只是关 executor） | 🟡 未做（已验的是进程消失） |
| P4 验收 | Figma MCP 工具出现在会话工具表并能取回节点数据 | ⛔ 需 Figma 桌面 App + Dev Mode MCP |
| P5 | 三个真实软件端到端（Blender `-b -P`、Photoshop COM/ExtendScript、Figma MCP） | ⛔ 需真实软件 |
| **P5** | **补 `AGENTS.md` / `README.md` / 用户须知**（含"不要在 SMB 上直接双击大文件用 PS 打开"）；`local_run` 降级为逃生口 | ❌ **纯文档，未做** |
| §4.8 | 性能基准 | ❌ 未做（计划自己标了"未测，需补"） |
| §3.3 | `proc.stdin`、spill 文件 | 🟡 已实现未测 |

其中 **P5 的文档那条是唯一完全不依赖外部条件的缺口**，下一轮做。P0-3 的 Office 与"断网"两项都真实需要 P0-2 先落地。

### 3.6 `plan.md` 里关于引擎源码改动的说法已过期（本轮核对）

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
  --token web-client-executor-token-0123456789 --label go-live-check
```

绑定后隔 2–3 秒读 `profiles/web-client/dispatch-trace.jsonl` 里最后一条 `routing-index`：应从 `宝单科技资料=server` 翻为 `=client`，`unbind` 后翻回。

三条门禁判据（**看错误文本判断是谁答的**：有处理器文本 = 已放行）：

```powershell
$h = @{ authorization = "Bearer web-client-executor-token-0123456789" }
Invoke-WebRequest http://127.0.0.1:3086/api -SkipHttpErrorCheck                                   # 403 门禁
Invoke-WebRequest http://127.0.0.1:3086/client-auth/state -SkipHttpErrorCheck                     # 401 我的处理器
Invoke-WebRequest http://127.0.0.1:3086/client-auth/state -Headers $h -SkipHttpErrorCheck         # 200
```
