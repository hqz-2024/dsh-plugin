# STATE.md — hqz-dsh 部署现状与交接说明

> **这份文件回答三个问题：现在是什么、怎么跑、坏了怎么修。**
> 任何人（包括下一个 agent）接手这个部署时，先读这一份，再按需下钻。
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
| 线上实例 | 端口 **3080**（`127.0.0.1`），启动命令 `node --import tsx/esm apps/cli/src/bin.ts --profile web-client --trusted-host 192.168.28.239`（由 `start-dsh-lan.cmd` 启动） |
| 局域网入口 | caddy 反向代理 **8443** → `https://192.168.28.239:8443`（自签证书，客户端需信任根证书） |
| 启动脚本 | `start-dsh-lan.cmd`（同时拉起 caddy 与 dsh；`set PROFILE=web-client`） |
| 健康检查 | `check-live-client-world.ps1`（期望 exit 0；第 4 项 502/403 属正常） |
| 诊断产物 | `profiles/web-client/dispatch-trace.jsonl`（分派决策）、`profiles/pilot-auth/{probe-result,machine-probe,llm-gateway-usage}.jsonl` |
| 关键约束 | **重启 3080 会切断用户正在用的那段对话**（对话就跑在这个进程里）→ 先征得同意 |

---

## 3. 插件清单（10 个，全部在 `plugins/`）

每个插件都是独立的 `link:` 包，通过 profile 的 `dsh.profile.bundles` 挂载；**新增插件必须三处齐全**（插件目录 + profile `package.json` 的 `link:` 依赖 + bundles 列表），少一处会静默不挂载。

| 插件 | 作用 | 行 id | 挂在 |
|---|---|---|---|
| **dsh-remote-local** | 门禁/账号/角色/会话可见性（**部署的关键定制**：`sessionController.list` 按工作区与账号过滤、隐藏项、登录页与 cookie 引导） | `remote`, `directory-picker` 等 4 行 | 线上（`@xgone/dsh-remote`） |
| **dsh-subprocess-dispatch** | 拥有 `ctx.subprocess` 的分派器；**并注册两个机器工具** `machine_list` / `machine_run`（`lib/machine-tools.js`） | `subprocess-dispatch` | 线上 |
| **dsh-client-bindings** | 工作区↔执行器绑定存储（含心跳、会话归属判定、`isOccupant`）。Web UI 的绑定入口已退休，路由层仍在 | `client-bindings` | 线上 |
| **dsh-local-bridge** | 本机桥接 sidecar（`local_run` 工具）——**逃生口**，用户本机需装 sidecar 才可用 | `local-bridge` | 线上 |
| **folder-tree-sh-local** | Web UI 工作区文件树（上传/下载/拖拽、xlsx 网格、Office 写回）。绑定按钮已退休 | `folder-tree-sh` | 线上 |
| **dsh-video-studio-local** | 视频剪辑（内嵌 FFmpeg + 11 个模型工具）与 manifest 校对工具的分发 | `dsh-video-studio` | 线上 |
| **dsh-usage-panel-local** | 设置页「消耗统计」（token/会话用量） | `usage-stats` | 线上 |
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
