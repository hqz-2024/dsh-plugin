@echo off
REM ============================================================
REM 放行 DSH 局域网部署所需端口（需管理员权限）
REM 用法：右键本文件 → 以管理员身份运行
REM ============================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [错误] 请右键本文件，选择"以管理员身份运行"。
  pause
  exit /b 1
)

echo 正在放行 8443 入站（caddy HTTPS 反代）...
netsh advfirewall firewall add rule name="dsh-lan-8443" dir=in action=allow protocol=TCP localport=8443

echo 正在放行 caddy.exe ...
netsh advfirewall firewall add rule name="dsh-lan-caddy" dir=in action=allow program="%USERPROFILE%\.dsh\bin\caddy.exe" enable=yes

echo.
echo 完成。现在从局域网其他电脑访问 https://<服务器局域网IP>:8443 即可。
pause
