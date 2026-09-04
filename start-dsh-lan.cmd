@echo off
REM ============================================================
REM DeepSeek Harness LAN deployment startup script
REM   dsh web     -> 127.0.0.1:3080  (loopback only)
REM   caddy https -> 0.0.0.0:8443     (reverse proxy -> 3080)
REM LAN access: https://192.168.28.239:8443
REM ============================================================

set "NODE=C:\nvm4w\nodejs\node.exe"
set "CADDY=C:\Users\bestarc\.dsh\bin\caddy.exe"
set "CADDYFILE=C:\Users\bestarc\.dsh\Caddyfile"
set "DSH_DIR=C:\Users\bestarc\Desktop\deepseek-harness"
set "LAN_IP=192.168.28.239"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile web --trusted-host %LAN_IP%

echo [dsh-lan] started. LAN access: https://%LAN_IP%:8443
