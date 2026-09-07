@echo off
REM ============================================================
REM DeepSeek Harness LAN deployment startup script（模板）
REM 真实 start-dsh-lan.cmd 由 install.ps1 按实际路径/IP 生成，且被 gitignore。
REM   dsh web     -> 127.0.0.1:3080  (loopback only)
REM   caddy https -> 0.0.0.0:8443     (reverse proxy -> 3080)
REM LAN access: https://<局域网IP>:8443
REM ============================================================

REM 部署时可改的三处（install.ps1 会自动填入）
set "NODE=node"
set "DSH_DIR=%USERPROFILE%\Desktop\deepseek-harness"
set "LAN_IP=<局域网IP>"

set "CADDY=%USERPROFILE%\.dsh\bin\caddy.exe"
set "CADDYFILE=%USERPROFILE%\.dsh\Caddyfile"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile web --trusted-host %LAN_IP%

echo [dsh-lan] started. LAN access: https://%LAN_IP%:8443
