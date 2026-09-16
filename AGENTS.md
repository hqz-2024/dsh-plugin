# AGENTS.md — 本部署（hqz-dsh 局域网部署）

本目录 `~/.dsh`（`%USERPROFILE%\.dsh`）是**部署数据目录**，不是 dsh 引擎源码。引擎 checkout 在别处（见下），本目录放的是配置、插件、预设、skill 与运维脚本。

面向使用者的手册见 `README.md`；面向实施过程的记录见 `docs/plan-client-world-progress.md`。

---

## 一、铁律（改动前必读）

1. **引擎 checkout 零改动。** 所有定制都在 `~/.dsh/{plugins,profiles,skills,.agent-presets}` 里。引擎 checkout（`C:\Users\<用户名>\Desktop\deepseek-harness`）保持只读，这样才能干净地跟官方上游。当前 checkout 里唯一未提交的改动是 `README.zh.md` 加了一行局域网启动命令，与本部署的定制无关。
2. **线上实例不能被扰动。** 3080 上的 dsh 是用户正在用的实例。不要重启它、不要停它、不要改它的组合。
3. **`profiles/web/cordis.patch.yml` 与 `profiles/web-client/cordis.patch.yml` 是本机机密文件。** 它们含真实的 sidecar token 与 executor token，已被 `.gitignore` 排除。要提交配置改动时，改对应的 `cordis.patch.example.yml`（占位版），并确认待提交文件里搜不到真实 token。
4. **`profiles/web/cordis.patch.yml` 的改动会实时生效。** 该 profile 设了 `patchReload: live`，改这个文件会热重载线上实例的组合 —— 等于直接改生产。要试新组合，另建 profile。
5. **第三方 skill 不要放进 `~/.dsh/skills`。** 该目录会同步到 GitHub。放别处，或用预设自带的 `skills/`（走 `customSkillDirs`）。
6. **跑验证要在隔离 home 里做**，不要拿线上 home 试。现成的：`.dsh-pilot`（3082）、`.dsh-pilot-auth`（3084）、`.dsh-web-client`（3086），都用 junction 复用 `plugins`/`profiles`，各自独立的 `auth`/`sessions`/`storages`。

---

## 二、客户端执行世界（工作区绑定决定命令跑在哪）

这是本部署最重要的行为约定：**一个工作区被某台机器绑定后，该工作区里的 shell / 终端 / LSP 全部在**那台机器**上执行；没绑定的工作区在执行服务器上执行。** agent 不需要选，也没有开关。

### 你必须知道自己在哪台机器上

会话的提示词里有一段 `execution:world`（order 700，排在所有工具说明之前）。**已绑定时**它会给出：可见路径、对应的服务器路径、机器名与平台。**未绑定时整段消失**。动手写 shell 命令前先读它 —— 写错了平台路径，命令会在用户的电脑上失败。

### 大文件走本机暂存（这是主路径，不是例外）

本地执行下，**> 10MB 或重软件工程格式（PSD / .blend / 大素材）一律走暂存**，流程是：判定 → 签出到本机暂存目录 → 调本机软件 → 回写 → 清理。完整规范见全局 skill `local-staging`。

**为什么必须这样（Adobe 官方立场）**：Photoshop **只支持在本地硬盘上使用**，官方明确"不支持把网络或可移动驱动器作为暂存盘"，推荐流程就是"先在本地硬盘上工作，再拷贝到网络盘"。在网络上直接工作可能间歇性报 `file is locked` / `disk error` / `unknown format`，而且**损坏可能延迟出现且无法被察觉**。Blender 在 SMB 上的外部资源（Alembic / VDB）也有已知的严重 I/O 问题。

> **用户须知**：**不要在资源管理器里双击 SMB 共享上的大文件直接用 PS / Blender 打开。** 这条规则保护的是文件本身，绕过去损坏了不一定当场发现。SMB 只承担文本 / Office / PDF 这类轻量文件的直接读写。

### 本地执行不可用时的语义（已定，不要绕过）

- **不属于任何已绑定工作区** → 在服务器执行。这是定义好的规则，不是降级。
- **属于已绑定工作区、但 executor 掉线** → `spawn` **明确失败**并提示本地执行不可用，**绝不静默改到服务器执行**。如果你看到这个错误，不要以为"那就跑在服务器上了" —— 命令根本没跑。
- **工作区被别的账号占用** → 对你这个会话而言等同于未绑定，回落服务器（权限一致性）。
- 用户合上笔记本、关掉 executor、或网络抖动超过宽限期，都会让出工作区；回来时可能已被别人绑走，需要重新绑定。

### `local_run` 的定位

本机桥接的 `local_run`（设置页"本地插件"里的 sidecar）**已降级为逃生口**：跑一次不常用的 exe、应急排查用。**处理工作区里的文件不要用它** —— 客户端执行世界下文件本来就在工作区里，不需要在模型的上下文里往返搬运。用法见全局 skill `sidecar`。

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

---

## 五、怎么验证

验证载体是 profile + 隔离 home，不是线上实例。三个现成的：

| profile | home | 端口 | 用途 |
|---|---|---|---|
| `pilot` | `.dsh-pilot` | 3082 | 最小组合，验客户端执行机制 |
| `pilot-auth` | `.dsh-pilot-auth` | 3084 | 最小组合 + 真门禁，含权限一致性与断线用例 |
| `web-client` | `.dsh-web-client` | 3086 | 真实 `web` 组合 + 客户端世界（上线 profile） |

跑法与读法见 `docs/plan-client-world-progress.md` §6。诊断产物是 `profiles/<name>/dispatch-trace.jsonl`（分派决策）与 `probe-result.jsonl`（冒烟步骤）。

**两条判读经验**：

- **区分"被门禁拦"与"被处理器拒绝"**：两者都是 403，但**处理器会带上自己的错误文本**（如 `unknown relay secret`）。没有文本的 403 才是门禁。
- **`/executor` 的握手先于认证**：无 token 时 WebSocket upgrade **会成功**，随后服务端以 close code **4001** 关闭。所以"连接上了"什么都证明不了，**只有 close code 能证明**。

验证要能证伪才算数：断言落在**执行位置**上（子进程自报的 `cwd`），而不是落在这条链上任何中间变量的说法。本机 executor 与服务器同机时尤其要注意 —— 同机跑通不等于跨机跑通（`argv[0]` 是典型反例）。
