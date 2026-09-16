@echo off
REM ============================================================
REM DeepSeek Harness LAN deployment startup script（模板）
REM 真实 start-dsh-lan.cmd 由 install.ps1 按实际路径/IP 生成，且被 gitignore。
REM   dsh web     -> 127.0.0.1:3080  (loopback only)
REM   caddy https -> 0.0.0.0:8443     (reverse proxy -> 3080)
REM LAN access: https://<局域网IP>:8443
REM ============================================================

REM 部署时可改的四处（install.ps1 会自动填入）
set "NODE=node"
set "DSH_DIR=%USERPROFILE%\Desktop\deepseek-harness"
set "LAN_IP=<局域网IP>"
REM PROFILE 决定要不要挂「客户端执行世界」：
REM   web        = 所有命令都在服务器上执行（不挂客户端世界）
REM   web-client = 工作区被某台机器绑定后，该工作区的命令在那台机器上执行；未绑定照旧在服务器
REM 两者只差三行组合（subprocess 让位、两个新插件、门禁放行三个前缀），未绑定时
REM 行为完全一致（可用 `--dump-config` 对拍），所以随时可以改回来。
set "PROFILE=web"

set "CADDY=%USERPROFILE%\.dsh\bin\caddy.exe"
set "CADDYFILE=%USERPROFILE%\.dsh\Caddyfile"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080, profile=%PROFILE%)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile %PROFILE% --trusted-host %LAN_IP%

echo [dsh-lan] started. LAN access: https://%LAN_IP%:8443
