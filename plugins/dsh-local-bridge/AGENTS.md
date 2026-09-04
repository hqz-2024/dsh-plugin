# AGENTS.md — dsh-local-bridge

本目录实现「agent 操作用户本机」能力。改造或排查时先读 README.md 与 sidecar/README.md。

## 你能做什么（agent 视角）

- 你有一个工具 **`local_run`**：它把命令发到**当前会话归属账号**在自己 Windows 机器上
  运行的 sidecar，并返回 stdout/stderr/exitCode 与回传文件。
- 典型用法：
  - 打开/编辑本机文档：把工作区里的 .xlsx/.docx/.pdf 作为 `inputFiles` 发过去，
    用 PowerShell/脚本处理，再 `collect` 回传结果，写回工作区。
  - 跑 PowerShell：`command="pwsh"`，`args=["<整段脚本>"]`。
  - 跑任意本机脚本/程序：`command="python"`（或 exe 路径），`args=["script.py", …]`。
  - 操控 PS / Blender 等软件：调用其脚本/COM 接口（先确认该软件支持脚本自动化）。

## 你必须遵守的操作规范

1. **先确认后执行**：任何可能产生副作用的命令（写入、删除、安装、联网、启动软件），
   执行前先用 `ask_user_question` 或对话向用户确认「命令做什么、在哪台机器、影响什么」。
   用户明确要求某动作时，把将要执行的命令复述一遍再执行。
2. **不要破坏性命令**：避免 `Remove-Item -Recurse`、`Format`、`del /s`、改注册表、
   杀进程等危险操作；确需时先征得用户同意并给出精确路径。
3. **会话归属**：local_run 只作用于「当前账号」本机；不要试图操作其他账号的机器，
   那在服务端会被路由拦截。
4. **文件往返走工作区**：要处理的文件从工作区经 `inputFiles` 下发，结果经 `collect`
   回传后写回工作区；不要假设本机任意路径，也不要读用户本机无关文件。
5. **超时与大小**：单命令默认 120s（可到 900s）；stdout/stderr 各截断 1MB；单文件 50MB。
   大数据量用脚本分片，不要硬塞。
6. **失败处理**：sidecar 未连接时 local_run 会返回明确错误——提示用户启动 sidecar，
   不要反复重试。
7. **日志**：每次 local_run 的 command + args 前缀会写入服务器日志；这是审计依据，
   不要尝试规避。

## 维护须知

- 协议字段见 README「协议」节；改协议要同步 sidecar.mjs 与 lib/index.js 两处。
- token 配置在 `profiles/web/cordis.patch.yml` 的 `local-bridge` 行；新增用户 = 加一行
  token，并把 token 交给该用户。
- 会话→账号归属来自 `~/.dsh/auth/session-owners.json`（由 dsh-remote fork 维护）。
- 当前是 MVP：没有可执行程序白名单，也没有逐动作审批。要做更强管控，方向：
  ① 在 lib/index.js 里加 exe 白名单/参数模板；② 接入 approval 链（需先解决财务会话
  approval=never 的冲突）。
