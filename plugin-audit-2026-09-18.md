# 自加插件体检报告 — 引擎 dsh-v0.1.6-alpha.2

> 体检时间：2026-09-18 18:00–18:20（+08:00）
> 体检对象：`~/.dsh` 里自加的 10 个插件（`plugins/` 下 9 个本地包 + 安装包 `dsh-doc`）
> 引擎：`C:\Users\bestarc\Desktop\deepseek-harness` = `ddefc45fbc` = tag `dsh-v0.1.6-alpha.2` = `origin/master`，工作区干净
> 线上实例：pid 32404（17:49:37 启动，profile `web-client`），**全程未重启、未改组合**

## 一句话结论

**10 个插件全部挂载。** 功能上发现并**已修** 1 处真实缺陷（§6：`folder-tree-sh` 的文件树不跟随工作区），
另有 1 处探针记账缺陷（§2，不影响功能）与 3 条陈旧痕迹（§3）。

---

## 1. 逐个结论与证据

| # | 插件 | 挂在 | 判定 | 关键证据 |
|---|---|---|---|---|
| 1 | **dsh-remote-local**（`@xgone/dsh-remote` 0.3.0） | 线上 | ✅ 正常 | 行 active；线上 `run-diag.log` 有 `confinement armed` / `session.list service filter armed` / roleMap；隔离实例 `POST /auth/login` 200、`/auth/me` 身份正确、`/auth/config-options` 200（87 KB）、`/auth/local-plugins` 200（三张卡片）；真实浏览器：标题 `HQZ-DSH`、设置里「登录与账号」「本地插件」都在、0 报错 |
| 2 | **dsh-subprocess-dispatch** 0.1.0 | 线上 | ✅ 正常 | 线上 trace：`delegate-mounted`、`machine-tools-registered`、`client-transport-started`、`routing-index ok`、每次 spawn 都有 `decision`；`/client-admin/bindings` 200、`/client-auth/state` 401（处理器文本）、`executor.mjs` 200 / `dsh-executor.zip` 206；**端到端**：源码 executor 连上后 `machine_list` 报出机器自报的 host/user/home，`machine_run` 在它上面真跑；浏览器里「工作区绑定」页渲染正常 |
| 3 | **dsh-client-bindings** 0.1.0 | 线上 | ✅ 正常 | `/client-admin/bindings` → `{"actor":"audit","bindings":[]}`；线上 routing-index `hasBindings: true`；探针的绑定语义全过（`claim-with-visible-path`、`binding-expiry-keeps-record`、`binding-semantics`、并发抢占 `winners=1 exactlyOne=true`） |
| 4 | **dsh-local-bridge** 0.1.0 | 线上 | ✅ 正常 | `/dsh-local-bridge/sidecar.mjs` 200（6397 B = 文件大小）；`local_run` 在会话工具表里；「本地插件」页出现 sidecar 卡（显示"未连接"＝本机没启动 sidecar，属正常状态） |
| 5 | **folder-tree-sh-local**（`folder-tree-sh` 0.3.0） | 线上 | ✅ 正常 | 13 条 `/dsh-ftree-*` 路由逐条探：`meta`/`token`/`list`/`read`/`git` 全 200 且带真实数据（list 8274 B 条目、read 17012 B = 文件内容）；浏览器里侧栏 `文件树` 开关存在，点击后浮层面板渲染出「文件 / Git / 名称 / 大小 / 时间 / 刷新 / 上传 / 传文件夹」 |
| 6 | **dsh-video-studio-local** 0.1.0 | 线上 | ✅ 正常 | `/dsh-video-studio/manifest-tool` 200（159 MB）；内置 ffmpeg/ffprobe 可运行（`N-126537`）；`video_probe` 真跑一次：**`时长 2s，320x240@15fps，有音轨，编码 h264`** |
| 7 | **dsh-doc** 0.1.1 | 线上 | ✅ 正常 | `dshdoc_health`：ready / xberg-python 1.0.14 / OCR chi_sim+eng；真解析一份工作区文档成功（`packages/README.md` → 正文完整）。`allowedLocalRoots: []` 会拒绝工作区外路径 —— 配置策略，不是缺陷 |
| 8 | **dsh-llm-gateway-local** 0.1.0 | 仅 pilot-auth | ✅ 正常 | 无 token / 错 token → 401「a valid gateway token is required」；正确 token `/v1/models` 200 且只列白名单两个模型；白名单外 `gpt-4o` → 404；**真实上游补全 200**（`model: deepseek-flash`、usage 45 tokens）；`llm-gateway-usage.jsonl` 入账一行 |
| 9 | **dsh-subprocess-probe** 0.1.0 | 仅 pilot-auth | ✅ 正常 | 一次完整跑 **67 步**，唯一 top-level `ok:false` 是文档早已记明的**刻意负例** `argv0-unresolvable`；关键判据全绿：`client-execution-verdict ranOnClient=true cwdMatchesVisiblePath=true`（服务端 `…\Desktop\宝单科技资料` → 客户端 `C:\dsh-executor-root`）、release 后 `executedOn=server`、并发抢占 `exactlyOne=true`、relay 三态（拒绝端口/未知密钥/上游不可达）、门禁登录→发 executor token→管理员强制解绑→权限一致性、pwsh 与 python 两个 REPL |
| 10 | **dsh-machine-probe** 0.1.0 | 仅 pilot-auth | ✅ 正常 | 六步全过：`tools-registered` / `machine-list`（自报 host、user、home）/ `machine-run-identity`（子进程报出**只有执行器进程才有的环境标记** `marker=from-executor-env`）/ `machine-run-cwd` / `machine-run-command`（`shell-ok 5`）/ `machine-run-timeout`（超时杀进程树、不留残文件）/ `machine-run-unknown`（报错并列出在线机器） |

挂载面另有一份独立证据：线上 `plugin_manager list_plugins` 显示 `include:remote`、`include:directory-picker-browse(+ui)`、`include:dsh-doc`、`include:folder-tree-sh`、`include:local-bridge`、`include:dsh-video-studio`、`include:client-bindings`、`include:subprocess-dispatch` **全部 `enabled: true` + `fiberPhase: "active"`**（`include:subprocess` 按设计为 disabled）。

## 2. 探针的记账缺陷（不影响任何功能）

`plugins/dsh-subprocess-probe/lib/index.js:449`：

```js
await attemptSpawn('argv0-unresolvable', serverCwd, ['C:\\no-such-dir\\no-such-program-xyz.exe'])
```

少传第 5 个参数 `{ expectFailure: true }`。按 `attemptSpawn` 的实现（L169-170），刻意构造的失败没有声明成期望，
于是这条**故意跑的负例**被记成 `ok: false`，让每次体检都常驻一行 FAIL。`docs/plan-client-world-progress.md`
（L544 / L1808 / L1947）早已把它记成"刻意的负例"，所以这是**升级前就存在的记账缺陷，不是回归**。一行可修：

```js
await attemptSpawn('argv0-unresolvable', serverCwd, ['C:\\no-such-dir\\no-such-program-xyz.exe'], undefined, { expectFailure: true })
```

## 3. 不是缺陷、但值得知道的三件事

1. **`profiles/web-client/node_modules` 里有 4 条指向隔离 home 的 junction**（`iconv-lite` / `mammoth` / `qrcode` / `xlsx` → `C:\Users\bestarc\.dsh-web-client\profiles\web-client\.dsh-module-fallback\node_modules\…`）。它们**不参与解析**：每个插件都有自己的 `node_modules/.pnpm`（已实测 `require.resolve` 落在插件自己的目录里），Node 走 realpath。所以删掉 `.dsh-web-client` 不会影响线上；想清理就删这 4 条链接。
2. **所有插件都按新写法注册路由**（`{ kind: 'exact', path, handler }`）。这一项在旧写法里缺省会落进 prefix 表，虽然仍能被精确路径命中，但会顺带匹配子路径。
3. **部署文档 `STATE.md` 有陈旧/错位内容**：第 2 行是半截的"5. 线上 3080 …"；§3 的 `web-client` bundles 仍写着 `usage-panel`（该插件已删除）；§5 仍写"19 个会话 / 格式 v2"，而 §10 已记录 v2→v3 迁移。建议顺手对齐。

## 4. 方法（可复现，全程不碰线上）

验证载体是**新建的隔离 home** `C:\Users\bestarc\.dsh-audit`（junction 复用 `plugins`/`profiles`/`skills`/`.agent-presets`，自带 `auth`/`storages`）：

```bat
:: 同一组合的 web-client 实例（3088），带种子管理员与真实门禁
set DSH_HOME=C:\Users\bestarc\.dsh-audit
node apps\cli\lib\bin.js --profile web-client --patch C:\Users\bestarc\.dsh-audit\gate-on.yml --port 3088 --no-open

:: pilot-auth 实例（3089）：网关 + 两个探针
node apps\cli\lib\bin.js --profile pilot-auth --patch C:\Users\bestarc\.dsh-audit\pilot-audit.yml --port 3089 --no-open

:: 源码执行器（与分发包同一份 executor.mjs），只为把机器工具/分派链路跑通
node plugins\dsh-subprocess-dispatch\executor\executor.mjs ^
  --server ws://127.0.0.1:3089/executor --secret pilot-auth-machine-secret-0123456789abcdef --no-open
```

产物（**可整个删除 `C:\Users\bestarc\.dsh-audit\`**）：

| 文件 | 内容 |
|---|---|
| `gate-off.yml` / `gate-on.yml` / `pilot-audit.yml` | 三个 `--patch` 覆盖层（关/开门禁、种子管理员、把探针输出改到审计目录） |
| `probe-routes.ps1` / `probe-auth.ps1` / `probe-gateway.ps1` | HTTP 面探针（未登录 / 已登录 / 网关三组） |
| `check-plugins-ui.mjs` | 真实无头 Chromium：登录 → 枚举设置页 → 逐个渲染「登录与账号 / 本地插件 / 工作区绑定」→ 点开文件树 → 收集 pageerror / console error |
| `probe-result.jsonl` | `dsh-subprocess-probe` 的 67 步结果 |
| `machine-probe.jsonl` | `dsh-machine-probe` 的六步结果 |
| `llm-gateway-usage.jsonl` | 网关用量入账（本次那一条） |

对**线上 3080 只做只读观测**，从未重启、未改 `cordis.patch.yml`、未动数据：
`plugin_manager list_plugins`、Cordis Inspect（Host Service / Client Slots）、本会话工具调用（`machine_list`、`pwsh`、`dshdoc_*`、`video_*`），以及读 `profiles/web-client/dispatch-trace.jsonl` 与 `plugins/dsh-remote-local/run-diag.log`。

## 5. 本次没有覆盖到的

- **真机上的 `dsh-executor.exe`**：我用的是与分发包同一份源码 `executor.mjs`（协议、凭据、node-pty 加载路径相同），但"双击 exe、免配置入网"那一步没跑。
- **用户本机的 sidecar 与 manifest 校对工具**：只能在装了它们的那台机器上手动启动才能验到"已连接"。
- **线上实例的带登录态 UI**：用的是同一组合、同一插件代码的隔离实例（门禁为真），线上只做了只读观测；没有用真实账号登录线上。
- **`crash-armed` 之后的半段**（外部中途杀掉执行器、再把绑定抢回来）：需要编排外部 kill，本次只跑到 arm 那一步，所以是 67 步而不是文档记的 68 步。

---

## 6. 追加（2026-09-18 18:40）：文件树不跟随工作区 —— 已修

**现象**（用户报告）：文件树面板永远显示 `smbtest`，怎么切换工作区都不变。

**根因**：引擎 0.1.3 → 0.1.6 把客户端 `SessionListState` 的 **`current` 字段删掉了**，而插件的客户端半边正是靠它定位"当前会话"
（`plugins/folder-tree-sh-local/lib/client.js:1787`）：

```js
const currentId = sesState ? sesState.current : undefined;            // 0.1.6 里恒为 undefined
...
workspace = items.find(w => w.sessionIds.indexOf(currentId) !== -1)   // 落空（currentId 为空）
  ?? items.find(w => w.path === cwd)                                  // cwd 来自 byId[currentId]，也落空
  ?? items.find(w => w.workspaceId === wsState.recentWorkspaceId)     // 该字段两个版本都不存在，死分支
  ?? items[0]                                                         // → 永远取列表第一个
```

`items` 的顺序就是宿主的 `workspaceIds` 顺序，而本部署 `storages/workspace.json` 的第一个是 **smbtest**
（`4e7e3506…` = `C:\dsh-workspaces\smbtest`）—— 所以"永远 smbtest"。

**证据**：

| 判据 | 结果 |
|---|---|
| 0.1.3 的 `SessionListState` | `git show hqz-dsh:…/sessions/service.ts` → 有 `current: SessionId \| undefined` |
| 0.1.6 的同文件 | 字段已删除（只剩 `ids` / `byId` / `phase` / `subagentsByParent` / `jobsBySession`） |
| 隔离实例**复现**（未修） | 在 `宝单科技资料`、`微众诉讼` 各新建一个会话后，面板仍是 `smbtest` / `C:\dsh-workspaces\smbtest`（`matches:false`） |
| 隔离实例**修复后** | 同样两步 → `宝单科技资料` / `C:\Users\bestarc\Desktop\宝单科技资料`，再切 → `微众诉讼` / `C:\Users\bestarc\Desktop\微众诉讼`，`matches:true`，0 page error |

**修法**（`client.js:1787`）：引擎自己的侧栏用"保留计数"判定当前会话
（`packages/client/ui-workspace/src/client/tree.ts` 的 `mainSessionId`：`retainedBy.mainView > 0`），照抄同一规则，并保留 `s.current` 以兼容旧引擎：

```js
const currentId = sesState
  ? (sesState.current ?? Object.values(sesState.byId || {}).find((s) => s && s.retainedBy && (s.retainedBy.mainView ?? 0) > 0)?.id)
  : undefined;
```

**生效方式**：客户端半边由引擎的 `client-modules` 监听文件并重建（HMR），**浏览器 Ctrl+F5 即可**，不需要重启 3080。

**遗留（不影响使用）**：
- 没有任何会话打开时（hero 界面）面板仍回落到 `items[0]` —— 这个槽位（`shell.overlay`）的框架钩子只有 `useSessions` / `useWorkspaces` / `useSessionStatus` / `useSessionRetainInfo`，拿不到"侧栏当前选中/展开哪个工作区"，那一段没有可靠信号。
- `wsState.recentWorkspaceId` 那一行在两个引擎版本都不存在，是死分支，可删；`client.js:1725` 的 `s.current` 在注释块里，也是死代码。

---

## 7. 第二轮（2026-09-18 18:40–19:20）：账号可见性 / 预设切换 —— 按用户报告的四个现象逐条定位

用户报告：① 预设角色切换不了、切了也不生效；② 换账号登录后授权工作区的旧对话看不到；③ 新建对话后重新登录又消失；④ 新建对话的工作区选择器暴露所有工作区。

**方法**：隔离 home 里起实例（3088，真门禁 + 两个账号：admin `audit` 与受限账号 `probe`，后者由 `auth/role-map.json` 映射到单一工作区），真浏览器操作，并把每次 `/api` 的请求体与响应体录下来 —— 结论全部来自服务端自己的应答。

### 7.1 根因（②③）：0.1.6 的网关拒绝被注入的 RPC 参数

`dsh-remote-local` 的可见性设计是"把 `scopeUser` 塞进 `session.list` 的请求体"。0.1.6 的 typert 网关新增了参数名校验，录到的原始应答：

```json
{"result":{"ok":false,"error":{"code":"gateway/arguments-invalid",
 "message":"typert gateway: session/list: args fields do not match the descriptor: unexpected \"request\""}}}
```

宿主 `list(_request, signal)` 的参数名是 `_request`，插件写的是 `args.request` → 每个**受限账号**的 `session.list` 直接报错 → 侧栏没有会话（②），刚建的会话刷新后也不再出现（③）。这也解释了 `run-diag.log` 里 18:23 连点 6 次"新建会话"的现象。

**修法**：身份不再走 wire，改为进程内传递 —— 门禁在处理请求前 `AsyncLocalStorage.run({username, role})`，`sessionController.list` 的服务包装器读它并按 owner 过滤（admin 不过滤）。与 Remote 签名/校验方式解耦。

**验证**（`probe` 映射到"宝单科技资料"）：
- 修复前 `session/list` → `arguments-invalid`；修复后 `200` 且只含自己的会话。
- 服务端自己的计数：`session.list filtered 6 -> 2 for probe`。
- 跨账号：admin 在 `微众诉讼` 新建并发消息 → 受限账号刷新后 `seesForeignSession=false`、`seesForeignWorkspace=false`、自己的 3 条照常。

### 7.2 根因（④）：隐藏只做到"行"，没做到"组头"和选择器

受限账号侧栏里工作区的 `projectRow` 确实被隐藏，但**组头（groupSection）仍在** —— 侧栏照样列出每个工作区名；"新建会话"选择器的条目是菜单行、不是 tree 行，从来没被覆盖。

**修法**（客户端半边 `hideForeignWorkspaces`）：① 组内没有可见行时把组头一起隐藏；② 对 `[role="menu"]/[role="listbox"]/[role="dialog"]` 中以被禁工作区标题命名的条目隐藏（同时含允许工作区标题的条目不隐藏）。

**验证**：`微众诉讼`/`smbtest` 组头 `display=block` → `display=none hidden=1`；跨账号测试中受限账号页面文本不再出现 `微众诉讼`。

### 7.3 （①）预设切换：两个真缺陷 + 一条设计约束

原始 RPC 直接问服务端（admin、空白会话）：

| 目标预设 | 结果 |
|---|---|
| `ptc` | `ok:true`，value `ptc` |
| `standard` | `ok:true`，value `standard` |
| `minimal` | **`agent-preset/invalid`**：`preset "minimal" failed to mount: 1 row(s) did not activate: terminal-pwsh (@deepseek-ai/dsh-terminal-bash): never started` |

- **两个本地预设的 YAML 混进了不可打印字符**（`## =<U+0004>`、`## =<U+0080>`；170 个同类标题用的是 emoji）→ 解析失败、无法选中：`engineering-mobile-app-builder`、`marketing-app-store-optimizer`。**已修**，修后 `agentPresets/list` 的 `broken` 由 2 条变为 **0（290 个预设全部可解析）**。
- **引擎自带的 `minimal`（极简模式）在本部署挂不起来**：`terminal-pwsh (@deepseek-ai/dsh-terminal-bash)`"never started"；该包 inject 是 `['terminals','sandboxPolicy','sessionProjections','subprocess']`，而本部署关闭了 `subprocess` 行、由 `subprocess-dispatch` 接管 —— **待查（未修）**。
- **设计约束**：受限账号的预设被 role-map 钉死（门禁改写 `agentPresets.select` 与 `session.create` 的 `agentPreset`），所以 AAAA/ABC 这类账号"切了也不生效"是刻意行为。

### 7.4 本轮改动与生效方式

| 文件 | 生效方式 |
|---|---|
| `plugins/dsh-remote-local/lib/index.js` | **需重启 3080**（host 半边） |
| `plugins/dsh-remote-local/lib/client.js` | 浏览器 Ctrl+F5（client 半边 HMR） |
| `.agent-presets/{engineering-mobile-app-builder,marketing-app-store-optimizer}/agent.cordis.yml` | 即时 |

脚本都在 `C:\Users\bestarc\.dsh-audit\`：`check-two-accounts.mjs`、`check-cross-account.mjs`、`probe-preset-select.mjs`、`diag-picker.mjs`。
