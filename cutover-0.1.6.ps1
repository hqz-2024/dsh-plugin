# 把线上 dsh 从 0.1.3-alpha.1（checkout）切到 0.1.6-alpha.2（worktree）。
#
# 为什么由脚本做、而不是由一个工具调用做：线上 3080 就是当前对话所在的进程，
# 停掉它 = 掐断发起切换的那个会话。所以脚本必须独立于那个进程运行（用计划任务拉起），
# 并且自己判断成功与否：成功就留着新版，失败就自动把启动脚本改回去、把旧版重新拉起。
#
# 日志：~/.dsh/cutover-report.txt（全程可读）

$ErrorActionPreference = 'Continue'
$home_ = "$env:USERPROFILE\.dsh"
$log = "$home_\cutover-report.txt"
$oldEngine = 'C:\Users\bestarc\Desktop\deepseek-harness'
$newEngine = 'C:\Users\bestarc\Desktop\dsh-0.1.6'
$launcher = "$home_\start-dsh-lan.cmd"
$liveLog = "$home_\live-0.1.6.log"
$node = 'C:\nvm4w\nodejs\node.exe'
$profile = 'web-client'
$trustedHost = '192.168.28.239'

function Log([string]$message) {
	$line = "$(Get-Date -Format 'HH:mm:ss') $message"
	Add-Content -Path $log -Value $line -Encoding utf8
}

"=== 切换到 dsh 0.1.6-alpha.2  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content -Path $log -Encoding utf8
Log "旧引擎: $oldEngine"
Log "新引擎: $newEngine"

# 给发起切换的那段对话留出把最后一条消息发完的时间。
Log '等待 45 秒，让当前对话把消息发完…'
Start-Sleep -Seconds 45

# ── 1. 停旧实例 ──────────────────────────────────────────────────────────────
$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
	$oldPid = $listener.OwningProcess
	Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
	Log "已停掉旧实例 pid=$oldPid"
} else {
	Log '3080 上没有监听者（可能已经停了）'
}
Start-Sleep -Seconds 3

# ── 2. 把启动脚本指向新引擎 ───────────────────────────────────────────────────
Copy-Item $launcher "$launcher.pre-0.1.6.bak" -Force
# 逐字节替换：只动那一行 ASCII，其它字节（中文注释）原样保留，不经过任何编码转换。
$latin = [System.Text.Encoding]::GetEncoding(28591)
$bytes = [System.IO.File]::ReadAllBytes($launcher)
$text = $latin.GetString($bytes)
$patched = $text.Replace("set `"DSH_DIR=$oldEngine`"", "set `"DSH_DIR=$newEngine`"")
if ($patched -eq $text) { Log '⚠ 启动脚本里没找到预期的 DSH_DIR 行，未改动。' }
else { [System.IO.File]::WriteAllBytes($launcher, $latin.GetBytes($patched)) }
Log "启动脚本已更新（备份在 $launcher.pre-0.1.6.bak）"
Log ("启动脚本现在指向: " + ((Select-String -Path $launcher -Pattern 'set "DSH_DIR=' | Select-Object -First 1).Line.Trim()))

# ── 3. 起新版（独立进程，输出进 live 日志）─────────────────────────────────────
$command = "`"$node`" --import tsx/esm apps/cli/src/bin.ts --profile $profile --trusted-host $trustedHost > `"$liveLog`" 2>&1"
Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $command -WorkingDirectory $newEngine -WindowStyle Hidden
Log '已拉起新版 dsh（独立进程），输出写入 live-0.1.6.log'

# ── 4. 等监听 ────────────────────────────────────────────────────────────────
$up = $false
for ($i = 0; $i -lt 60; $i++) {
	Start-Sleep -Seconds 2
	if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
Log "3080 已监听: $up（等待 $($i * 2) 秒）"

# ── 5. 体检 ──────────────────────────────────────────────────────────────────
$health = 1
if ($up) {
	& "$home_\check-live-client-world.ps1" *>&1 | Add-Content -Path $log -Encoding utf8
	$health = $LASTEXITCODE
	Log "体检退出码: $health（0 = 全绿）"
	# 再确认新进程确实是新引擎：它加载的 apps/desktop 之类只在新版里有
	$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'apps/cli/src/bin.ts' } | Select-Object -First 1
	Log "新进程 pid=$($proc.ProcessId)"
	if (Test-Path "$newEngine\apps\desktop") { Log '新引擎目录里存在 apps/desktop（0.1.6 特征）' }
}

# ── 6. 失败则回滚 ─────────────────────────────────────────────────────────────
if (-not $up -or $health -ne 0) {
	Log '❌ 判定失败：开始回滚'
	$bad = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
	if ($bad) { Stop-Process -Id $bad.OwningProcess -Force -ErrorAction SilentlyContinue; Log "停掉失败的实例 pid=$($bad.OwningProcess)" }
	Copy-Item "$launcher.pre-0.1.6.bak" $launcher -Force
	Log '启动脚本已还原'
	$oldLog = "$home_\live-0.1.3.log"
	$oldCommand = "`"$node`" --import tsx/esm apps/cli/src/bin.ts --profile $profile --trusted-host $trustedHost > `"$oldLog`" 2>&1"
	Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $oldCommand -WorkingDirectory $oldEngine -WindowStyle Hidden
	Log '已重新拉起旧版（0.1.3-alpha.1）'
	for ($i = 0; $i -lt 45; $i++) {
		Start-Sleep -Seconds 2
		if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { break }
	}
	$back = [bool](Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)
	Log "回滚后 3080 监听: $back"
	Log '结论：**已回滚，服务在旧版本上**。请把 cutover-report.txt 发给助手。'
} else {
	Log '✅ 切换成功：线上运行 dsh 0.1.6-alpha.2，体检全绿。'
	Log '请刷新浏览器（Ctrl+F5）后确认：工作区 5 个、历史会话都在、新建会话能对话。'
}
Log '=== 结束 ==='
