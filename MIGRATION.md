# DSH 局域网部署迁移说明

本文件描述如何把整套 DeepSeek Harness 局域网部署（多账号登录 + 角色权限 + 会话隔离 + 文件树 + 文档解析 + 本机桥接）迁移到另一台 Windows 服务器，并**完整保留所有数据**（会话历史、账号、工作区文件、配置、插件改动）。

> **占位符说明**：本文所有路径都不含真实用户名/IP。
> - `<用户名>` = 你的 Windows 用户名（等价于 `%USERNAME%`）
> - `%USERPROFILE%` = 你的用户主目录（如 `C:\Users\<用户名>`）
> - `<局域网IP>` = 服务器的局域网 IP

适用基线（本文所有路径以此为准）：

| 项 | 值 |
|---|---|
| 用户名 | `<用户名>` |
| DSH 代码 checkout | `C:\Users\<用户名>\Desktop\deepseek-harness` |
| DSH 数据/配置主目录 | `%USERPROFILE%\.dsh` |
| 财务工作区 | `C:\Users\<用户名>\Desktop\finance-ws` |
| 反代端口 | `https://<局域网IP>:8443` → 本机 `127.0.0.1:3080` |
| 反代 | caddy（`tls internal` 自签证书） |

---

## 一、架构总览

```
局域网设备 ── HTTPS ──> caddy (0.0.0.0:8443) ── HTTP ──> dsh (127.0.0.1:3080)
```

- dsh 只监听本机 loopback，caddy 是唯一对外入口。
- 多账号认证、角色门禁、会话隔离、工作区限制全部由本地 fork 插件实现；**核心 checkout 零改动**（可干净 `git clone`）。
- `dsh-local-bridge` 的 sidecar 跑在**每台用户自己的电脑**上，出站连接服务器的 `/sidecar`。

---

## 二、推荐：自动化迁移（backup.ps1 + migrate.ps1）

### 旧机：打包
```powershell
cd %USERPROFILE%\.dsh
powershell -ExecutionPolicy Bypass -File .\backup.ps1
# 产出 %USERPROFILE%\.dsh\backup\dsh-backup-<时间戳>.zip
```
> 备份含机密（`.credentials.yaml`、`auth\store.json`、`cordis.patch.yml` 的 sidecar token），请走可信通道，勿提交 git。

### 新机：先铺代码，再恢复数据
```powershell
# 1) 克隆本仓库到 %USERPROFILE%\.dsh，然后
cd %USERPROFILE%\.dsh
powershell -ExecutionPolicy Bypass -File .\install.ps1 -LanIP <局域网IP>

# 2) 恢复数据（把旧用户名路径自动映射成新机）
powershell -ExecutionPolicy Bypass -File .\migrate.ps1 -Backup <备份zip> -OldUser <旧用户名> -NewUser <新用户名>
```

`migrate.ps1` 会自动：解压 → 把 `workspace.json` / `cordis.patch.yml` / `settings.yaml` 等文本里的绝对路径从 `C:\Users\<旧用户名>\` 映射成 `C:\Users\<新用户名>\` → 重命名 `sessions\` / `sessions-archived\` 下的变形目录名 → 合并进 `~\.dsh`。

> ⚠ **跨用户名限制**：会话日志 `session.jsonl.zstd` 是 zstd 压缩二进制，其内部 cwd 脚本不重写；跨用户名恢复旧会话可能被拒（"session outside your workspace"）。**建议新机保持同名用户**，或由维护者做 zstd 级重映射。

---

## 三、手动迁移清单（自动化不可用时）

### 1. 数据（丢失不可恢复，最高优先级）

| 源路径（旧机） | 内容 | 是否必须 |
|---|---|---|
| `.dsh\sessions\` | 所有会话历史（按工作区路径分目录） | 必须 |
| `.dsh\sessions-archived\` | 归档会话 | 必须 |
| `.dsh\attachments\` | 会话附件 | 必须 |
| `.dsh\auth\store.json` | 账号（密码哈希 + TOTP + cookie 签名密钥） | 必须 |
| `.dsh\auth\session-owners.json` | 会话归属账号映射（账号隔离依据） | 必须 |
| `.dsh\storages\workspace.json` | 工作区注册表（路径 + 会话列表） | 必须 |
| `.dsh\storages\session_projcache.json` + `session_projcache\` | 会话投影缓存（可重建） | 建议 |
| `.dsh\llm-deepseek\` | DeepSeek provider 状态 | 建议 |
| `.dsh\dsh-remote-files.json` | /auth/file 额外允许目录 | 建议 |
| `.dsh\.anonymous-user-id` | 匿名 ID | 建议 |
| `C:\Users\<用户名>\Desktop\finance-ws\` | 财务工作区实际文件（业务数据） | 必须 |

### 2. 配置 + 插件 + 运行时

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `.dsh\profiles\web\`（不含 node_modules） | profile 组合：`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 必须 |
| `.dsh\plugins\` | 4 个本地 fork：`dsh-remote-local`、`folder-tree-sh-local`、`dsh-local-bridge`、`dsh-usage-panel-local` | 必须 |
| `.dsh\.agent-presets\` | 8 个角色预设（含 skills）+ `standard-terminal` | 必须 |
| `.dsh\skills\` | 全局 skill（sidecar 使用规范等），各预设 agent 共用 | 必须（或由 install.ps1 git clone 带来） |
| `.dsh\runtimes\dshdoc-runtime-win32-x64\` | dsh-doc 离线 Python 运行时（openpyxl/python-docx + OCR） | 必须（或由 install.ps1 重新下载） |
| `.dsh\settings.yaml` | 默认权限 danger-full-access、模型等 | 必须 |
| `.dsh\.credentials.yaml` | API Key（**机密**） | 必须 |
| `.dsh\Caddyfile` | 反代配置 | 必须 |
| `.dsh\bin\caddy.exe` | caddy 可执行文件（或用 winget 重装后复制） | 必须 |
| `.dsh\start-dsh-lan.cmd` | 一键启动脚本 | 必须（或由 install.ps1 重新生成） |

### 3. 程序本体

| 源路径 | 内容 | 是否必须 |
|---|---|---|
| `C:\Users\<用户名>\Desktop\deepseek-harness\`（不含 node_modules） | DSH 源码 checkout | 必须（或 `git clone https://github.com/hqz-2024/hqz-dsh.git -b hqz-dsh`） |

---

## 四、坑（必读）

### 坑 1：引擎 checkout 是零改动的，可以干净 clone
会话隔离已从核心 `session-controller` 源码移到 `dsh-remote-local` 插件（服务层包装 `sessionController.list`），所以引擎仓库 `hqz-2024/hqz-dsh` 可以直接 `git clone -b hqz-dsh`，**无需再手工打任何源码补丁**。

### 坑 2：绝对路径被写死在很多地方
用户名 `<用户名>` 和 `C:\Users\<用户名>\...` 出现在：

| 位置 | 字段 |
|---|---|
| `storages\workspace.json` | 各工作区的 `path` |
| `sessions\` 目录名 | `--C-Users-<用户名>-Desktop-finance-ws--` 等（按工作区路径变形） |
| `profiles\web\cordis.patch.yml` | dsh-doc 的 `runtimeDir` |
| `start-dsh-lan.cmd` | `NODE`、`DSH_DIR` |

**换用户名/换盘符时**：`migrate.ps1` 会自动重映射文本路径 + 重命名会话目录；手动迁移则需全局替换 + 重命名 + 改 `runtimeDir`。想省事就**保持同名用户 + 原目录结构**。

### 坑 3：机密文件要原样、安全地拷
- `.credentials.yaml`（API Key）
- `auth\store.json`（密码哈希 + 签名密钥；session cookie 的密钥也在这里）
- `profiles\web\cordis.patch.yml` 里的 local-bridge sidecar token

丢了或改了会导致账号无法登录 / 本机桥接失效。请走可信通道拷贝，不要提交进 git。

### 坑 4：sidecar 按「账号 token」路由，迁移必须保住 token
- 每个账号一个独立 sidecar token（`profiles\web\cordis.patch.yml` 的 `local-bridge.tokens`）。
- `local_run` 按「当前会话归属账号」自动路由到该账号的 sidecar，绝不串到别的账号的机器；「本地插件」设置页只显示当前登录账号自己的 token，属正常。
- 迁移时**原样保留 token**——改了 token 会让已装好的 sidecar 全部失联，需重新给每台机器下发新 token。

---

## 五、验证清单

1. 三个账号都能登录：`admin` / `Finance-mgr` / `Finance-staff`。
2. Finance-mgr、Finance-staff **只看到自己的会话**，看不到别人的。
3. 文件树全操作正常：新建文件、新建文件夹、重命名、复制、粘贴（剪切）、删除、上传、编辑保存、Excel 保存。
4. 上传 docx / xlsx 能正常预览（验证 dsh-doc 运行时）。
5. admin 能打开用量面板（admin-only）。
6. 每台用户机 sidecar 能连上，`local_run` 能驱动用户本机。
7. 安全门禁：非 admin 调 `session.search` / `session.export` 返回 403；`session.follow` 拉取他人会话被断连。

---

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 局域网设备连不上 8443 | 防火墙未放行 8443；或 IP 变了没改 `Caddyfile`/脚本 |
| 提示证书不受信 | 在设备上手动信任 caddy 的 `root.crt` |
| caddy 报 502 | dsh 没启动（先起 dsh 再起 caddy） |
| 登录后看不到自己的历史会话 | `auth\session-owners.json` 或 `storages\workspace.json` 没恢复；或会话目录与 workspace.json 路径不一致（坑 2） |
| 文件树写操作 `forbidden` / `signal time out` | 插件 fork 没装全，或 `profiles\web` 的 `pnpm install` 没重建 link 依赖 |
| 文档预览失败 | `runtimes\dshdoc-runtime-win32-x64` 缺失，或 `cordis.patch.yml` 的 `runtimeDir` 路径不对 |
| 打开旧会话被拒 "session outside your workspace" | 跨用户名迁移导致会话日志 cwd 与新工作区路径不一致（见「二」的跨用户名限制） |

### 手工启动命令（不用脚本时）
```powershell
# 终端 1：caddy
%USERPROFILE%\.dsh\bin\caddy.exe run --config %USERPROFILE%\.dsh\Caddyfile

# 终端 2：dsh（在 checkout 目录）
cd C:\Users\<用户名>\Desktop\deepseek-harness
pnpm dsh --profile web --trusted-host <局域网IP>
```
