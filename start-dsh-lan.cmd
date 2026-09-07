@echo off
REM ============================================================
REM DeepSeek Harness LAN deployment startup script
REM   dsh web     -> 127.0.0.1:3080  (loopback only)
REM   caddy https -> 0.0.0.0:8443     (reverse proxy -> 3080)
REM LAN access: https://192.168.28.239:8443
REM ============================================================

REM 以下三行是部署时可改项（其余路径自动用 %USERPROFILE% 定位 ~/.dsh）
set "NODE=C:\nvm4w\nodejs\node.exe"
set "DSH_DIR=C:\Users\bestarc\Desktop\deepseek-harness"
set "LAN_IP=192.168.28.239"

set "CADDY=%USERPROFILE%\.dsh\bin\caddy.exe"
set "CADDYFILE=%USERPROFILE%\.dsh\Caddyfile"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile web --trusted-host %LAN_IP%

echo [dsh-lan] started. LAN access: https://%LAN_IP%:8443
