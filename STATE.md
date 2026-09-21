# STATE.md — hqz-dsh 部署现状与交接说明
5. 线上 3080 **重启会切断用户当前对话** —— 需要重启先确认。

---

## 10. 2026-09-18 19:00 增补：工具调用崩溃与三个打不开的会话

### 10.1 一执行工具整段对话就死（`Cannot read properties of undefined (reading 'prepare')`）

- **现象**：0.1.6 上任何一次工具调用都抛 `Cannot read properties of undefined (reading 'prepare')`，随后日志里留下无结果的 `tool/call`；从下一轮起 DeepSeek 一律拒绝（`DeepSeek Messages tool calls need immediate results`），对话等于报废。
- **根因（两层）**：① `~/.dsh/profiles/node_modules` 的安装回退链仍指向 `Desktop\deepseek-harness`（0.1.3），其中 59 条是死链——正常解析失败，于是 tsx 的 tsconfig `paths` 兜底把引擎内部的 `@deepseek-ai/*` 解析成 `packages/*/src/index.ts`，而 profile 加载器把插件行解析成 `packages/*/lib/index.js`，同一模块两份实例 → `TOOL_RUNTIME_SCHEDULER` 唯一符号不匹配 → `ctx.tools[SYM]` 为 undefined → agent-loop 取 `.prepare` 崩。② 即便回退链修好，`node --import tsx/esm apps/cli/src/bin.ts` 仍会在真实工具调用上崩（headless 实测），构建产物启动 `node apps/cli/lib/bin.js` 则成功。
- **修复**：`start-dsh-lan.cmd` 改为 `DSH_DIR=dsh-0.1.6` + `node apps\cli\lib\bin.js`（备份 `start-dsh-lan.cmd.pre-0.1.6-launchfix.bak`）；**不要再用源码启动**。
- **配套**：已用引擎自带 `healProfilesModuleFallback`（installAnchor = dsh-0.1.6/apps/cli/package.json）把回退链重指到 dsh-0.1.6，并新增 `~\.dsh\node_modules` → `~\.dsh\profiles\node_modules`（让 `~/.dsh/plugins/**` 的普通 Node 解析也能沿父目录走到安装闭包）。修完 `web`/`web-client` 启动 0 警告，部署插件全部挂载。
- **自检**：`node apps\cli\lib\bin.js --profile web --patch C:\Users\bestarc\.dsh\check-module-identity.yml --port 3099 --no-open`，读 `~\.dsh\module-identity-report.json`，要求 `ok: true`（源码启动会报 `ok: false`，这是有意的）。

### 10.2 三个会话在 0.1.6 里打不开（v2→v3 迁移被拒）

- **现象**：`deepseek-harness` 工作区里 `session-31804be7`（160 轮）、`session-9c25a037`（64 轮）、`session-b7beba73`（42 轮）打开即失败。
- **根因**：这些 v2 日志里有「turn 未收尾就被下一轮顶掉」的历史形态——某轮模型调用被打断（`assistant/attempt` 空流），写了 `step/end` 却没写 `turn/end`，之后用户重发消息直接开了下一轮。v0→v1 / v1→v2 的关系校验本来就承认这种 released 形态（`legacyInterruptedTurnRestart`，引擎自己的测试辅助里就带这个标志），但 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 没带 → v2→v3 迁移一律拒绝，日志本身没坏、只是读不了。
- **修复**：`dsh-0.1.6/packages/session/session-format-v1-to-v2/{src/validation.ts,lib/index.js}` 的 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 加上 `legacyInterruptedTurnRestart: true`（构建产物与源码同步改，否则重启后按启动方式只生效一半）。
- **验证**：隔离 home 副本上，三个会话从 `REFUSED` 变为可加载（`--session-id <id>` 不再报 migration 拒绝）。
- **兜底存档**：`C:\Users\bestarc\Desktop\dsh-session-recovery\`（`INDEX.md` + 每个会话一份 Markdown 全文，直接从 `session.v?.jsonl.zstd` 解帧导出，不依赖 UI）。

### 10.3 执行结果（2026-09-18 16:30，用户已同意重启）

- **16:30:37 线上已切到构建产物**：`node apps\cli\lib\bin.js --profile web-client --trusted-host 192.168.28.239`（pid 27296，`start-dsh-lan.cmd` 即此命令）；启动日志 `~\.dsh\live-0.1.6.log`、`live-0.1.6.err.log`（stdout/stderr 重定向，便于下次核对），**0 警告**。旧的 tsx 源码实例与 3090 演练实例已停。
- **验证**：`check-module-identity.mjs` → `ok: true`（built）；`/api` 匿名 403、`/client-auth/state` 匿名 401、`/client-relay/错密钥` 403、`/executor` 错 token close 4001（curl 复核；`check-live-client-world.ps1` 自身在 PS 5.1 下取不到状态码，是脚本探测问题）；`/` 与 `https://192.168.28.239:8443/` 均 200。
- **10.2 的三个会话**：`session-31804be7` 已在 16:20:03 迁移出 v3 后继（13.5 MB），可正常打开；另两条随点随迁移。
- **脏会话扫描**（`check-dangling-tool-results.mjs`，只读）：全库只有 2 条——`session-06841b50`、`session-f0fbb722`，各 1 个无结果的 `pwsh` 调用。两条都是今天 15:47/15:49 的"在吗"会话（内容是恢复对话的请求本身），建议存档后弃用。

### 10.4 剩余待办

1. **引擎侧护栏（建议做）**：调度器失败时，agent-loop 目前只记 `tool/call`、不补 `tool/result`（`packages/core/agent-loop/src/tool-calls.ts` 注释写着 "Scheduler failure drains dispatches without committing synthetic recovery results"），于是那条会话此后每轮都被 DeepSeek 拒收。建议在 turn 结束前为已发出的调用补一条明确的失败结果事件（模型可见 ⟺ 已记录），改动局限在 agent-loop + 一条测试。
2. **就地修复那 2 条脏会话不可行**：`tool/result` 必须紧跟在 assistant 的 tool-call 之后，追加到日志末尾会落在后续 user 消息之后，救不了；要救必须重写日志（seq 重排），不值得为两条"在吗"会话做。
3. **补丁上游化**：`session-format-v1-to-v2` 的 `legacyInterruptedTurnRestart` 属于上游遗漏（他们的测试辅助里就有这个标志），建议给 deepseek-harness 提 issue/PR，否则下次同步上游会丢。
4. `cutover-report.txt` 还停在 15:32 的"已回滚"，与现状不符（16:18 手工切换、16:30 换启动方式）；`cutover-0.1.6.ps1` 需要同步成"构建产物启动"再复用。
4. **断言要落在只有当事者才能产生的事实上**（子进程自报的 cwd/hostname、执行器环境里的标记），不要落在中间变量的说法上。
**升级顺序与进度（2026-09-18）**：

1. **A 备份与基线**：✅ **已完成** —— `backup/dsh-backup-20260918-134233.zip`（33.7 MB，含 sessions/storages/auth/凭据）＋ `backup/dsh-backup-20260918-134233-files/`（补上备份脚本没带的 `profiles/web-client/cordis.patch.yml`）；引擎回滚分支 **`hqz-dsh-pre-upgrade` = `94c528137c`**。
2. **B 无风险演练**：✅ **已完成**。演练 home = `~/.dsh-upgrade-check`（线上数据的副本 + junction 复用 plugins/profiles）；新版 worktree = `C:\Users\bestarc\Desktop\dsh-0.1.6`（不动主 checkout）；起在 3090（web-client）与 3091（pilot-auth）。结果：

| 判据 | 结果 |
|---|---|
| 新版本带我们的组合能起来 | ✅ 两个 profile 都起得来 |
| **旧对话列表** | ✅ 全在（宝单科技资料 6 条、deepseek-harness 4 条、微众诉讼 1 条，含 7–10 天前的） |
| **打开旧会话** | ✅ 内容完整渲染（9-17 那段跨机 hostname 对话原文都在，含工具调用与用量） |
| 工作区 / 文件树 | ✅ 5 个工作区、文件树正常 |
| 我们的插件 | ✅ **9/9 挂载**；`dsh-usage-panel-local`（消耗统计）按用户要求**已删除**（插件目录 + 两个 profile 的依赖/bundles + junction 全清），删后演练**0 警告启动** |
| 网关（阶段 1 插件） | ✅ 3091 上 `/llm/v1/models` 200 |
| 预设 | ⚠️ 279/286 引用了被删的包 → **已修**（见 C） |

3. **C 修**：✅ 预设 279 个已脚本化替换（`fix-preset-workflow-row.mjs`：`@deepseek-ai/dsh-workflow-worker-thread` → `@deepseek-ai/dsh-workflow-ptc`，行 id 同步改），复查后**0 处缺失引用**；✅ 消耗统计面板已删除；✅ 删后演练**0 警告启动**（3090）。
4. **D 切线上**：⬜ **待用户确认** —— 停 3080 → 切版本 → 起 → 体检全绿 → 观察；出问题切回 `hqz-dsh-pre-upgrade` 重建。
>
> 最后更新：**2026-09-18**（升级到 0.1.6-alpha.2 之前）
> 相关文档：用户手册 `README.md`｜当前状态与决策 `docs/memory.md`｜计划与进度 `docs/plan-two-paths.md`｜实施与验收证据 `docs/plan-client-world-progress.md`｜**铁律与实现级陷阱 `AGENTS.md`（必读）**

---

## 1. 这是什么

`~/.dsh`（`C:\Users\bestarc\.dsh`）是 **hqz 的 DeepSeek Harness 局域网部署目录**：一台 Windows 服务器上跑 dsh（all-plugin Cordis harness），局域网里的同事用浏览器访问；另有一条"客户端执行世界"的支线（执行器 + 机器工具 + 模型网关）。

- **不是** dsh 引擎源码。引擎 checkout 在 `C:\Users\bestarc\Desktop\deepseek-harness`（分支 `hqz-dsh`），**保持零改动**铁律。
- 部署仓库就是本目录，远端是**公开**仓库 `github.com/hqz-2024/dsh-plugin`；当前在分支 **`client-world`**（`main` = `origin/main` = `73ad10f`，不要往 main 提交）。
- 本目录含真机密（`.credentials.yaml` 的 AI key、`profiles/*/cordis.patch.yml` 的 token），已在 `.gitignore` 里；**push 前先跑 `check-secret-leak.mjs`**。

---

## 2. 运行面（谁会跑、在哪跑）

| 项 | 值 |
|---|---|
| 线上实例 | 端口 **3080**（`127.0.0.1`），启动命令 `node --import file:///C:/Users/bestarc/.dsh/engine-patches/register.mjs apps\cli\lib\bin.js --profile web-client --trusted-host 192.168.28.239`（由 `start-dsh-lan.cmd` 启动；**源码启动已废弃**，理由见 §10.1；`--import` 是部署侧运行时补丁，见 §12） |
| 局域网入口 | caddy 反向代理 **8443** → `https://192.168.28.239:8443`（自签证书，客户端需信任根证书） |
| 启动脚本 | `start-dsh-lan.cmd`（同时拉起 caddy 与 dsh；`set PROFILE=web-client`）。脚本会校验 node/`lib\bin.js`/caddy 是否存在、已监听 8443 的 caddy 不重复拉、dsh 输出重定向到 `live-0.1.6.log`/`live-0.1.6.err.log`、等待 3080 监听最多 30 秒并在失败时打印 stderr 尾部。**这个文件必须保持纯 ASCII**——见 §10.5。 |
| 健康检查 | `check-live-client-world.ps1`（期望 exit 0；第 4 项 502/403 属正常） |
| 诊断产物 | `profiles/web-client/dispatch-trace.jsonl`（分派决策）、`profiles/pilot-auth/{probe-result,machine-probe,llm-gateway-usage}.jsonl` |
| 关键约束 | **重启 3080 会切断用户正在用的那段对话**（对话就跑在这个进程里）→ 先征得同意 |

---

## 3. 插件清单（9 个，全部在 `plugins/`）

每个插件都是独立的 `link:` 包，通过 profile 的 `dsh.profile.bundles` 挂载；**新增插件必须三处齐全**（插件目录 + profile `package.json` 的 `link:` 依赖 + bundles 列表），少一处会静默不挂载。

| 插件 | 作用 | 行 id | 挂在 |
|---|---|---|---|
| **dsh-remote-local** | 门禁/账号/角色/会话可见性（**部署的关键定制**：`sessionController.list` 按工作区与账号过滤、隐藏项、登录页与 cookie 引导） | `remote`, `directory-picker` 等 4 行 | 线上（`@xgone/dsh-remote`） |
| **dsh-subprocess-dispatch** | 拥有 `ctx.subprocess` 的分派器；**并注册两个机器工具** `machine_list` / `machine_run`（`lib/machine-tools.js`） | `subprocess-dispatch` | 线上 |
| **dsh-client-bindings** | 工作区↔执行器绑定存储（含心跳、会话归属判定、`isOccupant`）。Web UI 的绑定入口已退休，路由层仍在 | `client-bindings` | 线上 |
| **dsh-local-bridge** | 本机桥接 sidecar（`local_run` 工具）——**逃生口**，用户本机需装 sidecar 才可用 | `local-bridge` | 线上 |
| **folder-tree-sh-local** | Web UI 工作区文件树（上传/下载/拖拽、xlsx 网格、Office 写回）。绑定按钮已退休 | `folder-tree-sh` | 线上 |
| **dsh-video-studio-local** | 视频剪辑（内嵌 FFmpeg + 11 个模型工具）与 manifest 校对工具的分发 | `dsh-video-studio` | 线上 |
| **dsh-llm-gateway-local** | **模型网关**（阶段 1 新增）：`/llm/v1/chat/completions`(SSE) + `/llm/v1/models`，按 Bearer 网关 token 认证，带部署凭据转发到真 AI 接口；含封闭模型清单、每账号并发/日额度、用量入账、取消贯穿 | `llm-gateway` | 仅 `pilot-auth`（**尚未上线上**） |
| **dsh-subprocess-probe** | 验证探针：分派冒烟（cwd→工作区→绑定、终端、断线、权限一致性） | `subprocess-probe` | 仅 `pilot-auth` |
| **dsh-machine-probe** | 验证探针：机器工具六步（含超时不留残进程、执行器环境标记） | `machine-probe` | 仅 `pilot-auth` |

> 除上述 10 个，线上 profile 还挂 `dsh-doc`（文档解析，来自 `dshdoc-runtime`）。

---

## 4. profiles（5 个）与验证 home（3 个）

| profile | bundles | 用途 |
|---|---|---|
| **web-client** | base, web-app, `@xgone/dsh-remote`, dsh-doc, folder-tree-sh, usage-panel, local-bridge, video-studio, client-bindings, subprocess-dispatch | **线上**（3080） |
| web | 同上但没有 client-bindings / subprocess-dispatch | 纯服务器形态（回滚目标） |
| pilot | base, web-app, client-bindings, subprocess-dispatch, subprocess-probe | 最小组合验证 |
| **pilot-auth** | pilot + `@xgone/dsh-remote` + machine-probe + **llm-gateway** | **主力验证环境**（3084；含真门禁、探针、网关） |
| ~~node_modules~~ | —— | 依赖目录，不是 profile |

| 验证 home | 端口 | 说明 |
|---|---|---|
| `.dsh-pilot` | 3082 | 最小组合 |
| `.dsh-pilot-auth` | 3084 | 主验证环境（网关/token/探针都在这） |
| `.dsh-web-client` | 3086 | 真实 web 组合的隔离副本 |

三个 home 都用 junction 复用 `~/.dsh/plugins` 与 `~/.dsh/profiles`，各自独立的 `auth`/`sessions`/`storages`。

---

## 5. 数据面

| 项 | 位置 | 现状 |
|---|---|---|
| AI 凭据 | `.credentials.yaml`（gitignored） | `refs.DEEPSEEK_API_KEY`（**密钥只在本机**） |
| 账号/角色 | `auth/{store,role-map,session-owners,hidden-items}.json`（gitignored） | `admin`（admin，口令 123456）、`AAAA`（user，授权 `smbtest`、`宝单科技资料`）等 |
| 会话 | `sessions/<工作区>/<会话>/session.v2.jsonl.zstd` | **19 个会话**，格式 **v2**（升级到 0.1.6 时由 v2→v3 迁移读取） |
| 工作区 | `storages/workspace.json` | `deepseek-harness`、`宝单科技资料`、`微众诉讼`、`.dsh`、`smbtest` |
| 绑定存储 | `storages/client_binding.json` | 历史记录都有 `endedAt`，**当前无活动绑定** |
| 角色预设 | `.agent-presets/`（286 个） | ⚠️ **279 个引用了新版已删除的 `@deepseek-ai/dsh-workflow-worker-thread`**（升级必改，见 §7） |
| 全局 skill | `skills/`（11 个） | 同步到 GitHub（**不要放第三方 skill**） |
| 设置 | `settings.yaml` | 默认预设 `cordis`、默认模型 `deepseek-flash`、权限 `danger-full-access` |

---

## 6. 客户端世界（支线的现状）

| 能力 | 状态 | 证据/位置 |
|---|---|---|
| 执行器（用户电脑上的"手脚"） | ✅ 可用 | `plugins/dsh-subprocess-dispatch/executor/executor.mjs`；SEA exe + 旁挂 node-pty；分发包 `dist/dsh-executor.zip`（32.4 MB，`/dsh-subprocess-dispatch/dsh-executor.zip`） |
| 机器工具（agent 直接操作指定机器） | ✅ 已上线（3080 trace 有 `machine-tools-registered`） | `machine_list` / `machine_run`；**不绑定、不共享** |
| 打包 exe 的"第二个自己"缺陷 | ✅ 已修 | node-pty 的 `fork` 跑的是 `process.execPath`；复现工具 `check-conpty-agent-fork.mjs` |
| 工作区共享/绑定 | ⛔ 已退休（UI 入口删除，路由层保留） | 恢复步骤见 `README.md` 与 `docs/memory.md` |
| **模型网关** | ✅ 已验证（真模型跑通，含流式、用量、取消、额度 429） | 插件 `dsh-llm-gateway-local`；证据 `docs/memory.md §5 阶段 1` |

---

## 7. 在飞的工作：升级到 `dsh-v0.1.6-alpha.2`

**为什么升**：客户端应用（计划 B 阶段 2）要复用**上游自带的 Electron 桌面端** `apps/desktop`，而它**不在我们当前的 0.1.3-alpha.1 基线里**（0.1.6 里已长到 291 个文件）。

**升级前体检已做完**（脚本：`check-upgrade-readiness.mjs`、`check-upgrade-references.mjs`）：

| 检查 | 结论 |
|---|---|
| 距离 | 落后 **2849 个提交**（`hqz-dsh` → `dsh-v0.1.6-alpha.2`） |
| 会话格式 | 我们 v2 → 新版 v3，**新版带 `session-format-v2-to-v3` 迁移包** → 旧对话不是"必然读不出" |
| 我们的插件引用的引擎包 | **10 个全在**（`@deepseek-ai/dsh-shell/render` 只出现在注释里） |
| 我们的组合 patch 目标行 | 全在（新版只删了 `code-runtime`、`tool-str-replace-editor`、`workflow-worker-thread`） |
| **预设** | **279/286 引用了被删的 `@deepseek-ai/dsh-workflow-worker-thread`** → 新版是 `@deepseek-ai/dsh-workflow-ptc`（行 `workflow-ptc`）+ `@deepseek-ai/dsh-tool-workflow`。**这就是上次"插件全失效"的最可能原因** |
| 上次"旧对话全丢" | 假设：`dsh-remote-local` 包装的 `sessionController.list` API 变了 → 列表空（文件其实还在）。**靠演练区分"数据丢了"与"看不见"** |

**升级顺序（未获确认前不动线上）**：
1. **A 备份与基线**：`backup.ps1` 全量备份；记录基线；引擎分支打 `hqz-dsh-pre-upgrade` 作为回滚点。
2. **B 无风险演练**：新版本检出/构建 → **复制**线上数据到隔离 home（`.dsh-upgrade-check`）→ 另起端口 → 判据：19 个旧会话能列出/打开/继续、10 个插件逐个挂载、286 个预设能起会话、网关仍工作、迁移可回滚。
3. **C 修**：脚本化替换 279 个预设的 workflow 包名；修演练暴露的插件 API。
4. **D 切线上**：停 3080 → 切版本 → 起 → 体检全绿 → 观察；出问题切回 `hqz-dsh-pre-upgrade` 重建。

---

## 8. 故障处置手册

| 症状 | 先做什么 |
|---|---|
| 局域网打不开 | ① `Get-NetTCPConnection -LocalPort 3080 -State Listen` 有没有 ② caddy 在不在（8443） ③ 跑 `check-live-client-world.ps1` |
| 登录后看不到会话/工作区 | 那是 `dsh-remote-local` 的可见性过滤：查 `auth/role-map.json` 里该账号的 `workspaces`；再看 `auth/hidden-items.json` |
| agent 用不了某个工具 | ① 该插件是否在 profile 的 `bundles` 里 ② profile 的 `package.json` 有没有 `link:` 依赖 ③ `node_modules` 里有没有 junction ④ 重启后仍不行就看启动日志的 schema/inject 报错 |
| 执行器连不上/机器列表为空 | 客户端机器上跑 `dsh-executor.exe --self-test`；服务端看 `dispatch-trace.jsonl` 的 `machine-tools-registered` |
| 网关 401/403/404/429 | 401=没有/错 token；404=模型不在白名单；429=并发或日额度；502=上游拒绝或不可达 |
| 要整份退回纯服务器形态 | 把 profile 里 `subprocess-dispatch` 行改 `disabled: true`、`subprocess` 行去掉 `disabled`，重启（详见 `README.md`） |
| 升级后要回滚 | 引擎切回 `hqz-dsh-pre-upgrade` 重新构建；数据在 `~/.dsh` 里没被升级过程改写（**迁移是否原地改写要在演练里确认**） |

---

## 9. 给下一个 agent 的话

1. **先读 `AGENTS.md`**：那里是铁律（引擎零改动、别扰动线上、机密文件、隔离 home 验证）与 10 条实现级陷阱（SEA 会 fork 自己、`hello` 事实、同机测试的证伪力……）。
2. **改动提交到 `client-world` 分支**，不推、不动 main；push 前跑 `check-secret-leak.mjs`。
3. **跑验证在隔离 home**（`.dsh-pilot-auth` 3084 最全），不要拿线上试。
4. **断言要落在只有当事者才能产生的事实上**（子进程自报的 cwd/hostname、执行器环境里的标记），不要落在中间变量的说法上。
5. 线上 3080 **重启会切断用户当前对话** —— 需要重启先确认。

---

## 11. 2026-09-18 17:00：`start-dsh-lan.cmd` 为什么"只有 caddy 起来了"

- **根因：编码，不是路径也不是命令。** 脚本原是 UTF-8 无 BOM，而 `cmd.exe` 按 OEM 代码页（本机 GBK）读 `.cmd`：中文注释被拆成乱码命令逐行执行，其中一处把 `set "NODE=C:\nvm4w\nodejs\node.exe"` 吃掉 → `%NODE%` 为空 → `start ... "" apps\cli\lib\bin.js ...` 立刻失败；窗口是 `/min`，一闪而过看不见。caddy 那行在损坏点之前，所以只有它活着。这与上一个 agent 记的"PS 5.1 读不了无 BOM 的 UTF-8 脚本"是同一类坑（那条坑杀掉过一次切换脚本）。
- **修复**：脚本改为**纯 ASCII**（中文说明留在本文件）；同时加了前置校验、caddy 去重、stdout/stderr 重定向到 `live-0.1.6.log`/`live-0.1.6.err.log`、等待 3080 监听 30 秒并在失败时打印 stderr 尾部——以后再坏，cmd 窗口里会直接指出是哪一步。
- **验证（2026-09-18 16:56）**：`cmd /c C:\Users\bestarc\.dsh\start-dsh-lan.cmd` → exit 0 打印 "up"；3080 = 构建产物实例（pid 32216，`apps\cli\lib\bin.js --profile web-client`）；8443 复用既有 caddy 未重复拉起；`/` 与 `https://192.168.28.239:8443/` 均 200；日志无警告。
- **给下一个 agent**：改这个 `.cmd` 时不要写非 ASCII 字符；中文说明写进本文件。同类坑：`.ps1` 中文必须带 BOM 或纯 ASCII。

---

## 12. 2026-09-18 17:40：引擎回到 `deepseek-harness`，且保持官方原样

- **引擎**：`C:\Users\bestarc\Desktop\deepseek-harness`，分支 **`hqz-dsh-0.1.6`** = `ddefc45fbc` = 上游 `origin/master` = tag `dsh-v0.1.6-alpha.2`；`git status` 干净。旧分支 `hqz-dsh`、`hqz-dsh-pre-upgrade`（均 94c528137c）保留作归档，`README.zh.md` 那 2 行改动在 `git stash` 里。`dsh-0.1.6` 已还原成**与官方逐字一致**的参考副本，不再用于运行。
- **引擎目录内不再有任何部署改动**：打在 `session-format-v1-to-v2` 的那一行已还原，改成 `~\.dsh\engine-patches\` 的 Node loader hook（`register.mjs` + `legacy-turn-restart.mjs`），由启动脚本 `--import file:///C:/Users/bestarc/.dsh/engine-patches/register.mjs` 加载；命中写 `engine-patches\applied.log`，锚点丢失时大声报错（见该目录 README）。
- **部署解析链**：已用 `healProfilesModuleFallback`（installAnchor = `deepseek-harness/apps/cli/package.json`）重指到新引擎；`@deepseek-ai/*`、`react`、`typescript` 等均解析到 `deepseek-harness`。
- **验证**：`pnpm install`（24 s，exit 0）+ `pnpm build`（约 5.5 min，exit 0）；脚本重启 3080 → pid 32772，`3080=200`、`8443=200`，启动日志 **0 警告**，stderr 含 `engine patch: legacy-turn-restart applied`。
- **回滚点**：引擎 = 把 `start-dsh-lan.cmd` 的 `DSH_DIR` 改回 `dsh-0.1.6`；分支 = `hqz-dsh` / `hqz-dsh-pre-upgrade`。
