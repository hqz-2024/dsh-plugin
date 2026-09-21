# 客户端应用：本机要装什么

这是**客户端电脑**（局域网里跑桌面应用的机器）需要的部署侧文件，不是服务器上跑的东西。
桌面应用本身由上游 `apps/desktop` 构建（见 `docs/plan-two-paths.md` 阶段 2/4）；
本目录补的是它**装不进二进制的那一半**：这台机器该连哪个部署、模型走哪条路。

## 一个窗口，两种模式

| 模式 | 文档从哪来 | 模型从哪来 | 密钥在哪 |
|---|---|---|---|
| **服务器模式** | `https://<服务器>:8443`（部署自己的 Web UI，含登录页） | 服务器上的 agent 循环 | 只在服务器 |
| **本地模式** | 应用自带的 Web 前端 + 本机 dsh Host | **本机 agent 循环**，模型请求打到部署的**模型网关** | **客户端一个 key 都没有** |

两种模式的差别只有"文档 + 谁来跑循环"。工具、工作区、会话在本地模式下全在本机，
所以本机 agent 能直接操作本机文件与软件，不需要执行器、不需要共享。

## 这台机器要放的五样东西

`provision-client.ps1` 会把它们写好：前四样落在 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`），
第五样落在桌面应用的浏览器数据目录（默认 `%APPDATA%\@deepseek-ai\dsh-desktop`）：

| 文件 | 作用 | 为什么必须在这台机器上 |
|---|---|---|
| `settings.yaml` | `llm-deepseek` 段把模型端点指到部署网关，并声明网关开放的模型 id | 端点与模型清单是**部署**的事实，随服务器走 |
| `.credentials.yaml` | 网关 token（`HQZ_GATEWAY_TOKEN`）与归档 token（`HQZ_ARCHIVE_TOKEN`） | 这是客户端仅有的凭据；真 AI key 永远不进客户端 |
| `archive.json` | 会话归档端的地址 | 归档端与网关同属一个部署 |
| `profiles/desktop/cordis.patch.yml` | 桌面 profile 的补丁层（默认留空） | 桌面应用独占这个 profile，补丁层是它唯一的组合入口 |
| `desktop-client.json` | **服务器模式**要连的部署地址（`{ "server": { "origin": …, "label": … } }`） | 应用按 `环境变量 → 这个文件 → 安装包里的默认值` 取地址，这一层是本机的覆写 |

`profiles/desktop/` 本身由桌面应用首次启动时创建（bundle 列表是 `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app`，自包含、没有 `link:` 依赖），**应用不会覆盖已存在的文件**，
所以先放 patch 层是安全的。

## 用法

```powershell
# 在一台客户端电脑上（管理员或当前用户均可；Windows PowerShell 5.1 与 pwsh 7 都能跑）
.\provision-client.ps1 `
  -GatewayOrigin 'https://192.168.28.239:8443' `
  -GatewayToken  '<管理台签发的网关 token>' `
  -ArchiveToken  '<归档 token>' `
  -DesktopLabel  'HQZ 局域网'
```

一条命令配好两种模式：本地模式拿 `settings.yaml` + `.credentials.yaml`；服务器模式拿
`desktop-client.json`（`origin` 省略时与 `-GatewayOrigin` 同一个部署）。

| 参数 | 作用 |
|---|---|
| `-HomeDir` | 目标 `$DSH_HOME`；省略时 `%USERPROFILE%\.dsh` |
| `-DesktopServerOrigin` | 服务器模式连别处（默认与网关同源） |
| `-DesktopLabel` | 服务器模式窗口标题与徽标上的名字 |
| `-DesktopUserDataDir` | 应用的浏览器数据目录（默认 `%APPDATA%\@deepseek-ai\dsh-desktop`） |
| `-SkipDesktopServer` | 不写 `desktop-client.json`（例如安装包里已经烘好了别的地址） |
| `-WhatIfOnly` | 只打印将要写入的内容 |

先跑 `-WhatIfOnly` 看一眼再落盘。覆盖 `settings.yaml` 或 `desktop-client.json` 之前，
各自会留一份 `*.bak-<时间戳>`。

**安装包里可能已经烘好了地址**：打包时 `.env.windows` 里的 `DSH_DESKTOP_SERVER_MODE=auto`
会让构建机逐个候选地址问一次 `https://<地址>:8443/auth/me`，谁答就把谁写进应用清单的
`dshDesktopServerMode`。那样客户端**装完就自带服务器模式**，本脚本只在需要把某一台机器
改指到别处时才非跑不可。

**网关 token 从哪来**：见 `README.md` 的"模型网关"一节。当前部署里 token 写在
`profiles/<profile>/cordis.patch.yml` 的 `llm-gateway.config.tokens` 里（阶段 1 的形态）；
签发与吊销（计划 B2）尚未做，所以现在等于"管理员手工发一个"。
token 泄漏的后果是**别人可以用部署的额度**，不是拿到 AI key。

## 本地模式为什么不需要 API key

模型请求的形状是 `POST <GatewayOrigin>/llm/v1/chat/completions`，
带 `Authorization: Bearer <网关 token>`。网关按 token 认账号、按账号限额与入账，
再带着**部署自己的**凭据转发到真 AI 接口。客户端既没有、也不需要
`DEEPSEEK_API_KEY`；`provision-client.ps1` 也不会写它。

## 与服务器的关系

- 服务器模式：客户端只是一个浏览器窗口，服务端零改动。
- 本地模式：客户端不连服务器的会话/工作区，服务器只看到网关上的 token 用量。
- 归档回传（阶段 3）：本地会话导成文档、按账号上传，走的是另一条通道，与本地模型无关。

## 会话归档（阶段 3）

本地会话 → 转录 → 上传给部署 → 部署用**自己的**模型精简 → 写进 Obsidian 库。

```powershell
# 最近一个会话
node export-session.mjs --latest

# 所有自上次归档后变化过的会话（桌面端的定时任务用的就是这个）
node export-session.mjs --pending

# 指定会话 / 限定工作区 / 只看不传
node export-session.mjs --session session-3c956039-... --origin https://192.168.28.239:8443
node export-session.mjs --latest --workspace 'C:\Users\bestarc\Desktop\deepseek-harness' --dry-run
```

**`--pending` 与台账**：它读 `$DSH_HOME/client/archive-state.json`，只上传"大小或修改时间与
上次归档时不同"的会话，每成功一个记一笔。没有台账的话，定时任务会把同一个会话反复上传 ——
服务器每次都要跑一次模型精简，那是真金白银。台账丢了只会多传一次，不会丢东西。

**桌面端会自动跑它**：应用启动后约 1 分钟跑第一次，之后每 6 小时一次
（`DSH_DESKTOP_ARCHIVE_INTERVAL_MS` 可调，最小 10 秒；设 `0` 只关定时，
仍可用菜单里的"立即归档会话"触发）。启用的条件是**两件事同时成立**：
`$DSH_HOME/client/export-session.mjs` 存在（provisioning 放进去的）**且**归档地址已配置
（`archive.json` 或 `HQZ_ARCHIVE_ORIGIN`）—— 所以只装了桌面端、没配归档的机器不会自己去连任何地方。

地址与 token 按三层取：命令行 → 环境变量（`HQZ_ARCHIVE_ORIGIN` / `HQZ_ARCHIVE_TOKEN`）
→ `$DSH_HOME/archive.json` 与 `.credentials.yaml`（`provision-client.ps1 -ArchiveToken` 写的）。

转录只收**这个人真的说的话**：`user/message` 的 `source.kind` 有 `plugin`、
`agent-instructions`、`skill-catalog` 等多种，那些是 harness 注入的上下文（动辄几万字），
收进来只会让"这次对话做了什么"被指令原文淹没。助手的思考默认不收，`--with-reasoning` 可开。

服务端那一半在 `~/.dsh/plugins/dsh-archive-local/`；笔记格式**不是它发明的**，
是照着 `obsidian笔记\会话记录\` 里已有的样本做的，改格式前先看那三篇。


