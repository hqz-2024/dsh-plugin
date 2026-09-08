---
name: dsh-development
description: Use when 开发、修改、扩展或升级本机 DeepSeek Harness 部署——编辑 ~/.dsh 下的 agent 预设、fork 插件、全局 skill 或 cordis 组合，或改动 deepseek-harness 引擎源码；也用于诊断某个预设/插件行为何未挂载、未生效、报 schema/权限/隔离错误。
---

# dsh-development（本机 DeepSeek Harness 部署开发指南）

## Overview

本机跑的是「引擎 + 部署层」分离的 DeepSeek Harness（dsh）：引擎 checkout **零改动**，所有定制都在 `~/.dsh`。开发 = 改预设 / 插件 / skill / 组合，几乎不碰引擎源码。每次改动前先想清三件事：**改哪个文件、改完要不要重启、以及这条改动到底属于 host 还是 preset 平面**——这三件想错了，改动就"改了但没生效"或"挂载报错"。

## 一、架构总览

### 两个仓库

| | 引擎 checkout | 部署层 ~/.dsh |
|---|---|---|
| 路径 | `<engine-checkout>`（引擎源码目录） | `~/.dsh`（`$DSH_HOME`） |
| git 远程 | `mine`=hqz-2024/hqz-dsh（fork）、`origin`=deepseek-ai/deepseek-harness（官方） | `origin`=hqz-2024/dsh-plugin |
| 分支 | `hqz-dsh` | `main` |
| 原则 | **零改动**，可干净 pull 官方上游 | 所有定制都在这里 |

引擎本身是 all-plugin 的 Cordis harness：**没有特权核心**，连模型适配器、工具注册表、会话日志、agent 主循环都是插件。插件的核心概念：ctx 是服务仓库（`ctx.tools`/`ctx.llm`/`ctx.sessions`…），插件用 `inject` 声明依赖，注册是可逆副作用（`ctx.effect()`/`ctx.on()`），能力由「Service Definition / Provider / Consumer」三件套组成（capability seam）。

### 组合的两个平面（决定代码放哪，最重要）

- **Host 组合**：全进程一份，跨会话共享——工具注册表 `ctx.tools`、`systemPrompt`、`agents`、`agent-loop`、`sessions`、持久化、沙箱/审批栈、模型路由、subagent 注册表。
- **Agent 预设**：每会话一份，挂在该会话 scope 下——工具插件、persona、prompt 段、compaction 策略。
- **判断标准**：一个服务只要存在预设之外的消费者（如 api-proxy 的跨会话查询、subagents 注册表），就**不能进预设**；预设真正自有的服务必须包进带 `isolate` realm 的 group，否则第二个会话挂载冲突。

### ~/.dsh 目录结构

| 路径 | 作用 |
|---|---|
| `plugins/` | 4 个本地 fork 插件：`dsh-remote-local`（账号登录/角色/会话隔离）、`folder-tree-sh-local`（文件树）、`dsh-local-bridge`（sidecar + local_run）、`dsh-usage-panel-local`（用量统计） |
| `.agent-presets/<id>/` | 角色预设，每目录一个 `agent.cordis.yml` + `preset.yml` + 可选 `skills/` |
| `skills/` | **全局 skill**（所有预设共用），本 skill 就放这里 |
| `profiles/web/` | `cordis.yml`（空根）、`cordis.patch.yml`（真实配置，gitignore）、`cordis.patch.example.yml`（脱敏模板）、`package.json`（bundles + `link:` 依赖） |
| `auth/` | 账号、会话归属、隐藏项、roleMap（机密，gitignore） |
| `settings.yaml` / `.credentials.yaml` | 用户设置 / API key（机密） |

### 组合装配顺序

启动时按序应用：`package.json` 的 `dsh.profile.bundles`（每个 bundle 一份 patch）→ profile 的 `cordis.patch.yml` → home 级 patch → `--patch` overlay。patch 按 `id` **整体替换**某行的 config，不是合并——所以覆写某行必须重述要保留的全部字段。

### skill 从哪些路径加载

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<项目>/.dsh/skills` |
| 200 | project-agents | `<项目>/.agents/skills` |
| 300 | custom | 预设里 `customSkillDirs` |
| 400 | user-dsh | `~/.dsh/skills`（**全局 skill 在这**） |
| 500 | user-agents | `~/.agents/skills` |
| 600 | bundled | `$DSH_BUNDLED_SKILL_DIR` |

- skill 格式：`<root>/<name>/SKILL.md` 或平铺 `<root>/<name>.md`，**只扫一层不递归**；frontmatter 必填 `name`（kebab-case）+ `description`。
- 预设自带的 `skills/` 目录**不会自动加载**——必须在预设的 `skill-filesystem` 行加 `customSkillDirs` 指向它，写法：
  ```yaml
  - id: skill-filesystem
    name: '@deepseek-ai/dsh-skill-filesystem'
    config:
      customSkillDirs:
        - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
  ```
  （`baseUrl` 挂载时就是该预设目录。）

## 二、开发方式

### 改 agent 预设（改角色能力）
- 编辑 `.agent-presets/<id>/agent.cordis.yml`。
- 预设文件在**新会话挂载时读取**：新开会话即生效；运行中的会话不会自动重挂载，稳妥做法是整进程重启。
- 给某预设加自有 skill → 按上面写法加 `customSkillDirs`。
- 验证组合用挂载校验（`standingKeyFor`/mount），别只看 roster 的 `broken` 字段——后者只查文件形状，查不出"服务没 isolate"或"行没激活"。

### 改 fork 插件
- host 侧 `lib/index.js`：**整进程重启**生效。
- 客户端 `lib/client.js`：HMR 自动重发，浏览器 Ctrl+F5。

### 改 cordis 组合
- 改 `profiles/web/cordis.patch.yml`：**整进程重启**生效（本部署约定，见 ~/.dsh README 运维提示）。
- 只改 `cordis.patch.example.yml` 不生效——它是脱敏模板，要同步改真实的 `cordis.patch.yml`。

### 加全局 skill
- 新建 `~/.dsh/skills/<name>/SKILL.md`，frontmatter 必填 `name` + `description`，`description` 只写触发条件。

### 改引擎源码（慎）
- 只在确有必要时改 `packages/`，改前先读 `docs/architecture.md`。任何对引擎的改动都会破坏「零改动、可干净 pull 上游」的前提，需权衡。

## 三、规则

1. **核心 checkout 零改动**：所有定制放 `~/.dsh`，引擎保持可干净 pull 官方上游。
2. **平面归属**：跨会话 / 被 host 消费 → host；单会话 → preset（服务必须 `isolate` realm）。
3. **机密不提交**：`.credentials.yaml`、`auth/`、`cordis.patch.yml`（含 sidecar token）、`backup/`、`sessions*/`、`prof/`、`*.bak` 都 gitignore；提交的是脱敏版 `cordis.patch.example.yml`。
4. **改完要重启**：host 插件 + `cordis.patch.yml` 整进程重启；预设新会话；client HMR。
5. **验证真挂载**：用 mount/`standingKeyFor` 校验，别只看 roster 的 `broken` 字段。
6. **`!!js` 而非 `!js`**：cordis.yml 里用 `!!js` 表达式；其他元数据保持字面量。

## 四、触发条件（何时用本 skill）

- 用户要求「开发 / 改造 / 升级 dsh」「加个预设 / 插件 / skill」「改角色权限 / 工作区 / 登录门禁」。
- 要改 `~/.dsh` 下的任何 `agent.cordis.yml`、`cordis.yml` / `cordis.patch.yml`、插件 `lib/`，或新增全局 skill。
- 诊断「某预设 / 插件没生效」「改完没反应」「挂载报错 / schema 报错」「该改动放 host 还是 preset」这类问题。

## 五、常见错误

| 现象 | 原因 / 处理 |
|---|---|
| 改了预设但新会话没变化 | 预设自带 skill 没接 `customSkillDirs`；或没重启 |
| 改了 `cordis.patch.yml` 不生效 | 需整进程重启，不是 live |
| 改了 example.yml 不生效 | 模板不参与装配，要改真实 `cordis.patch.yml` |
| 第二个会话挂载冲突 | 预设里的服务没加 `isolate` realm |
| 登录后看不到历史会话 | `auth/session-owners.json` 或 `storages/workspace.json` 没恢复 |
| dsh 启动报 schema 错误 | 某 tool 的 JSON Schema 不合法（`required` 在 items 里、object 缺 `additionalProperties` 等） |
| 反代后 401 / 一直"连接中" | `remote.trustProxy` 与 `--trusted-host` 不匹配 |

## 六、快速参考（改什么 → 改哪 → 怎么生效 → 怎么验证）

| 要改的 | 改哪个文件 | 生效方式 | 验证 |
|---|---|---|---|
| 角色能力 / 工具集 | `.agent-presets/<id>/agent.cordis.yml` | 新会话（或整进程重启） | 新会话看工具列表 / mount 校验 |
| 预设自有 skill | 预设 `agent.cordis.yml` 的 skill-filesystem 行 | 同上 | 新会话看 skill 目录 |
| 全局 skill | `~/.dsh/skills/<name>/SKILL.md` | 即时（watcher 热更新） | 会话 skill 目录出现 |
| 认证/隔离/文件树/用量 | `plugins/*/lib/index.js` | 整进程重启 | 重启后验证对应功能 |
| 插件 UI | `plugins/*/lib/client.js` | HMR + Ctrl+F5 | 浏览器刷新看界面 |
| 默认预设/roleMap/权限/token | `profiles/web/cordis.patch.yml` | 整进程重启 | 重启后登录验证 |
| 引擎行为 | `packages/`（慎） | 重新 build + 重启 | 跑对应测试 |

> 引擎更深的架构（bundle/profile 装配、turn flow、capability seam、事件 map）见引擎仓库的 `docs/architecture.md`、`docs/cordis-primer.md`、`packages/README.md`；部署的迁移/备份见 `~/.dsh/MIGRATION.md` 与 `README.md`。
