# AGENTS.md — 本部署（hqz-dsh 局域网部署）

本目录 `~/.dsh`（`%USERPROFILE%\.dsh`）是**部署数据目录**，不是 dsh 引擎源码。引擎 checkout 在别处（见下），本目录放的是配置、插件、预设、skill 与运维脚本。

部署现状与交接见 `STATE.md`（插件清单、运行面、故障处置）；面向使用者的手册见 `README.md`；**"现在是什么状态、下一步做什么"先看 `docs/memory.md`**；实施过程记录见 `docs/plan-client-world-progress.md`；两条路线评估见 `docs/plan-two-paths.md`。

---

## 一、铁律（改动前必读）

1. **引擎 checkout 零改动。** 所有定制都在 `~/.dsh/{plugins,profiles,skills,.agent-presets}` 里。引擎 checkout（`C:\Users\<用户名>\Desktop\deepseek-harness`）保持只读，这样才能干净地跟官方上游。当前 checkout 里唯一未提交的改动是 `README.zh.md` 加了一行局域网启动命令，与本部署的定制无关。
2. **线上实例不能被扰动。** 3080 上的 dsh 是用户正在用的实例。不要重启它、不要停它、不要改它的组合。**注意：重启 3080 会切断用户当前正在用的那段对话（它就跑在这个进程里）** —— 需要重启时先征得同意，或让用户自己重启。
3. **改动都提交到分支 `client-world`。** `main` 与 `origin/main` 保持一致（`73ad10f`），除非用户明确要求，**不推送、不合并、不动 main**。仓库是公开的（`github.com/hqz-2024/dsh-plugin`），push 前先跑 `check-secret-leak.mjs`。
4. **`profiles/web/cordis.patch.yml` 与 `profiles/web-client/cordis.patch.yml` 是本机机密文件。** 它们含真实的 sidecar token 与 executor token，已被 `.gitignore` 排除。要提交配置改动时，改对应的 `cordis.patch.example.yml`（占位版），并确认待提交文件里搜不到真实 token。
5. **`profiles/web/cordis.patch.yml` 的改动会实时生效。** 该 profile 设了 `patchReload: live`，改这个文件会热重载线上实例的组合 —— 等于直接改生产。要试新组合，另建 profile。
6. **第三方 skill 不要放进 `~/.dsh/skills`。** 该目录会同步到 GitHub。放别处，或用预设自带的 `skills/`（走 `customSkillDirs`）。
7. **跑验证要在隔离 home 里做**，不要拿线上 home 试。现成的：`.dsh-pilot`（3082）、`.dsh-pilot-auth`（3084）、`.dsh-web-client`（3086），都用 junction 复用 `plugins`/`profiles`，各自独立的 `auth`/`sessions`/`storages`。

---

## 二、操作用户电脑：机器工具（不是绑定）

**内置的 shell / 终端 / LSP 一律在执行服务器上跑。** 这是定义好的规则，不是降级：会话的工作区在 `C:\Users\<用户>\Desktop\...`，`read`/`write`/`grep` 与 shell 看到的是同一份文件，没有任何跨机路由。

要操作用户自己的电脑，用**两个模型工具**（由 `dsh-subprocess-dispatch` 注册，见 `plugins/dsh-subprocess-dispatch/lib/machine-tools.js`）：

| 工具 | 作用 |
|---|---|
| `machine_list` | 列出当前**执行器在线**的机器：机器 ID、主机名、系统、登录用户、主目录 |
| `machine_run` | 在一台指定机器上跑一条命令，返回 stdout / stderr / 退出码 |

### 用之前必须知道的三件事

1. **路径是那台机器上的路径。** 服务器路径（`C:\Users\bestarc\Desktop\宝单科技资料`）在那台机器上不存在。省略 `cwd` 时用的是**那台机器在 `hello` 里自报的用户主目录**。
2. **没连执行器 = 明确失败。** 工具直接把"没有名为 X 的在线机器"和在线机器列表返回给你，**绝不静默改在服务器上跑**。看到这个错误不要以为命令跑过了。
3. **两个工具之外没有别的通道。** 客户端的 shell 工具、终端、LSP 都不在那台机器上；`machine_run` 是你唯一的手脚。

### 机器与账号的关系（当前的授权模型）

- 执行器用**部署级密钥**注册（`machineSecret`，已内置进分发的 exe），机器在 `hello` 里自报 `machineId`、主机名、平台、登录用户、主目录；服务器此后按 machineId 寻址它。
- **任何已登录本部署的账号都可以寻址任何在线机器。** 一台机器可被寻址的前提是有人在那台机器上**把执行器打开** —— 这是本地动作，也是当前唯一的准入。如果以后要按账号限制，改 `machine-tools.js` 里的准入判断（现在没有这个开关）。
- 工作区授权（`roleMap.<账号>.workspaces`）管的是**能看到哪些工作区/会话**，与机器工具无关。

### 已停用（2026-09-17）：工作区共享与绑定

- **什么被删了**：**从 Web UI 创建绑定的那套入口** —— `/client-web` 接口（`startWeb`/`serveWeb`）、文件树面板里的执行位置标签与绑定按钮、会话标题栏的本地模式徽标、executor 配置页的工作区选择器；新建工作区时的共享步骤也不再走。
- **什么还在（别误以为删干净了）**：`spawn` 按 `cwd` → 工作区 → 绑定决定跑在哪的**路由层代码**（`decide`/`admit`/`spawnOnClient`/`translateCwd`）、绑定存储与心跳、`/client-auth` 的 `bind`/`unbind`、`/client-admin/bindings`、`execution:world` 提示词段。**没有绑定记录时它们全部退化为"在服务器执行"**，所以现在看到的都是服务器执行 —— 但恢复入口之后它们立刻又能用。
- **其他留着的**：共享本身（`ws-smbtest`、`ws-宝单科技资料` 等）与 `dshtest` 账号；`visiblePathHints` / `noShareRoots` 配置项（当前无消费者，文件内有标注）。
- **恢复办法**：见 `README.md` 的"工作区共享／绑定已停用"一节。

### 已知缺口：服务器上的文件不会自动出现在客户端机器上

共享停用之后，**agent 在客户端机器上看不到服务器工作区里的文件**。`machine_run` 只能操作那台机器本地已有的东西。要在客户端机器上处理服务器上的文件，目前只有一条路：人工从共享/拷贝把文件放过去（共享还在，但 dsh 不再自动挂 `net use`）。**同一条通道上加传输工具（`machine_read_file` / `machine_write_file`）是自然的下一步，但现在还没有。**

### 大文件走本机暂存（仍然有效）

在那台机器上处理 **> 10MB 或重软件工程格式（PSD / .blend / 大素材）** 时，仍然走"签出到本机暂存目录 → 调本机软件 → 回写 → 清理"，规范见全局 skill `local-staging`。

**为什么必须这样（Adobe 官方立场）**：Photoshop **只支持在本地硬盘上使用**，官方明确"不支持把网络或可移动驱动器作为暂存盘"，推荐流程就是"先在本地硬盘上工作，再拷贝到网络盘"。在网络上直接工作可能间歇性报 `file is locked` / `disk error` / `unknown format`，而且**损坏可能延迟出现且无法被察觉**。Blender 在 SMB 上的外部资源（Alembic / VDB）也有已知的严重 I/O 问题。

> **用户须知**：**不要在资源管理器里双击 SMB 共享上的大文件直接用 PS / Blender 打开。** 这条规则保护的是文件本身，绕过去损坏了不一定当场发现。SMB 只承担文本 / Office / PDF 这类轻量文件的直接读写。

### `local_run` 的定位

本机桥接的 `local_run`（设置页"本地插件"里的 sidecar）**是逃生口**：跑一次不常用的 exe、应急排查用。用户本机没装 sidecar 时它直接失败 —— 那是正常状态，不是故障。用法见全局 skill `sidecar`。

---

## 三、组合与行的规则

- 一个 profile 的树由**补丁层**拼成：`package.json` 的 `dsh.profile.bundles` 里各 bundle 的 patch，然后是 `profiles/<name>/cordis.patch.yml`，最后是 `--patch` 覆盖层。`cordis.yml` 是空表，不要改它。
- **一个 patch 替换该行整个 `config`**，不是合并。所以改一行时要把完整的配置重述一遍。
- 行按 `id` 命中。基座里 subprocess provider 的行 id 是 **`subprocess`**，**不是** `subprocess-local`（`packages/bundle/base/cordis.patch.yml:205`）—— 写错会静默失效。
- 新增插件要**三处齐全**：`plugins/<name>/`（含 `cordis.patch.yml`，把行插成 `disabled: true`）、profile 的 `package.json` 里加 `link:` 依赖、以及 `dsh.profile.bundles` 里列出它。少一处就完全不挂载，而且不一定报错。
- 隔离（`ctx.isolate(...)`）用于同名服务共存。

---

## 四、实现级坑（踩过的，写下来省下一次）

1. **Cordis 服务里不能用 ES `#private` 字段** —— 服务被 Proxy 包装后 receiver 取不到私有字段，报 "Cannot read private member #x from an object whose class did not declare it"。用普通属性。
2. **`ctx.plugin()` 不同步发布服务** —— 返回的是 `Fiber & PromiseLike<Fiber>`，必须 `await` 之后 `get()` 才拿得到。
3. **`spawn()` 是同步的，而 `workspaceRegistry.resolveByPath()` 是异步的**（且对不存在的路径会 **reject**）。依赖它的决策不能放在 `spawn` 里；本部署的做法是一张同步路由索引 + 后台刷新。
4. **Windows 环境变量名大小写不敏感，但"复制出来的普通对象"不是** —— 介质里写的是 `Path` 不是 `PATH`，把 `process.env` 复制进普通对象后按 `.PATH` 读会得到 `undefined`，PATH 搜索**静默空转**。所有环境变量查找必须大小写不敏感（引擎在 `packages/subprocess/subprocess/src/index.ts:53-55` 也警告过）。
5. **storage domain 名不能含连字符**（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`），用下划线，否则模块加载时直接抛错。
6. **workspace registry 在启动后约 3.2 秒才可用**（inject `storageDomain` + `sessionPersistence` + 异步 init）。读它的插件必须容忍"暂时不可用"。
7. **`SubprocessRuntime.spawn(spec)` 不携带会话身份**。要会话身份只能从 `spec.env.DSH_SESSION_ID` 取 —— 它是 shell 工具每次都会注入的内建键。
8. **单文件打包（Node SEA）会把"fork 自己"变成"再启动一个自己"**。任何走 `process.execPath` 的第三方代码在打包形态下都要重新检查一遍：node-pty 用 `child_process.fork()` 起它的 console-list 助手，打包后 execPath 就是执行器本身 —— 于是**每结束一个终端就多出一个执行器**，它报同一个 machineId，服务器把第二条连接判为重连并 retire 第一条，在飞的进程/终端句柄全废（指纹：日志里出现第二次启动横幅 + `EADDRINUSE` 抢不到 38460）。执行器现在认出这个助手就只跑助手然后退出；复现工具是 `check-conpty-agent-fork.mjs`（精确复刻 node-pty 的 fork，注意它传的路径**不带 `.js`**）。
9. **`hello` 里的事实只有那台机器能提供**。机器工具要用"另一台机器上的路径"就必须先由执行器自报（`home`/`user` 就是这么加的）；服务器侧默认值（执行器进程的当前目录 = 解压出来的文件夹）在用户看来永远是个意外。
10. **同机测试证明不了跨机**。服务器与执行器同机时，`hostname`、`cwd` 都不是有效判据；有效的做法是让断言落在**只有执行器进程才有的东西**上（例如只能存在于执行器环境里的变量 —— 注意不能用 `DSH_` 前缀，会被清洗）。

---

## 五、怎么验证

验证载体是 profile + 隔离 home，不是线上实例。三个现成的：

| profile | home | 端口 | 用途 |
|---|---|---|---|
| `pilot` | `.dsh-pilot` | 3082 | 最小组合，验客户端执行机制 |
| `pilot-auth` | `.dsh-pilot-auth` | 3084 | 最小组合 + 真门禁，含权限一致性与断线用例 |
| `web-client` | `.dsh-web-client` | 3086 | 真实 `web` 组合 + 客户端世界（上线 profile） |

跑法与读法见 `docs/plan-client-world-progress.md` §6。诊断产物是 `profiles/<name>/dispatch-trace.jsonl`（分派决策）、`probe-result.jsonl`（分派冒烟步骤）与 `machine-probe.jsonl`（机器工具；插件 `plugins/dsh-machine-probe`，已挂在 `pilot-auth`）。

**两条判读经验**：

- **区分"被门禁拦"与"被处理器拒绝"**：两者都是 403，但**处理器会带上自己的错误文本**（如 `unknown relay secret`）。没有文本的 403 才是门禁。
- **`/executor` 的握手先于认证**：无 token 时 WebSocket upgrade **会成功**，随后服务端以 close code **4001** 关闭。所以"连接上了"什么都证明不了，**只有 close code 能证明**。

验证要能证伪才算数：断言落在**执行位置**上（子进程自报的 `cwd`），而不是落在这条链上任何中间变量的说法。本机 executor 与服务器同机时尤其要注意 —— 同机跑通不等于跨机跑通（`argv[0]` 是典型反例）。
