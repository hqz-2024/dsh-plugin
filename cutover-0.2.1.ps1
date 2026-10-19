# cutover-0.2.1.ps1 — 把线上 dsh 从 0.1.6-alpha.2 切到 0.2.1-rc.2（web-client profile）
#
# 由独立进程运行（计划任务），因此不会随 3080 里的会话一起被杀。
# 失败自动回滚到 0.1.6。全过程写入桌面《升级结果-0.2.1-rc.2.md》。
#
# 不做的事：不重编译引擎（新引擎已在 C:\Users\bestarc\Desktop\dsh-0.2.1 构建好）、
# 不碰 caddy（8443 继续反代 127.0.0.1:3080）、不删旧引擎。

$ErrorActionPreference = 'Continue'

# 给当前会话留出把最后一条消息写完的时间，再动手。
Start-Sleep -Seconds 240

$DshHome    = Join-Path $env:USERPROFILE '.dsh'
$OldEngine  = 'C:\Users\bestarc\Desktop\deepseek-harness'
$NewEngine  = 'C:\Users\bestarc\Desktop\dsh-0.2.1'
$Node       = 'C:\nvm4w\nodejs\node.exe'
$Profile    = 'web-client'
$LanIp      = '192.168.28.239'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$Report     = Join-Path ([Environment]::GetFolderPath('Desktop')) '升级结果-0.2.1-rc.2.md'
$StartCmd   = Join-Path $DshHome 'start-dsh-lan.cmd'
$Patch      = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$NewLog     = Join-Path $DshHome 'live-0.2.1.log'
$NewErrLog  = Join-Path $DshHome 'live-0.2.1.err.log'
$settings   = Join-Path $DshHome 'settings.yaml'
$imported   = Join-Path $DshHome 'settings.yaml.imported'

$log = New-Object System.Collections.Generic.List[string]
function Say([string]$text) {
  $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $text
  $script:log.Add($line)
  Write-Host $line
  Set-Content -Path $Report -Value ($script:log -join "`n") -Encoding UTF8
}

function Stop-Dsh {
  for ($round = 0; $round -lt 3; $round++) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return }
    $pidToStop = $listener.OwningProcess
    if ($pidToStop -and $pidToStop -ne 0) {
      & taskkill /PID $pidToStop /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3
  }
}

function Start-Dsh([string]$engine, [string]$outLog, [string]$errLog) {
  # Proven launch shape: one detached cmd owns the redirects, so the process
  # survives this script (and the Task Scheduler action) exiting.
  $command = '"' + $Node + '" --import "file:///C:/Users/bestarc/.dsh/engine-patches/register.mjs" ' +
    'apps\cli\lib\bin.js --profile ' + $Profile + ' --trusted-host ' + $LanIp +
    ' > "' + $outLog + '" 2>&1'
  Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $command -WorkingDirectory $engine -WindowStyle Hidden
  return $command
}

function Wait-Ready([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      try {
        $response = Invoke-WebRequest 'http://127.0.0.1:3080/auth/me' -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
        if ($response.StatusCode -eq 200) { return $true }
      } catch { }
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

Say "# 升级结果：dsh 0.1.6-alpha.2 → 0.2.1-rc.2"
Say ''
Say ("开始时间：{0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ''

# ── 0. 快照 ────────────────────────────────────────────────────────────────
$patchBackup  = "$Patch.pre-0.2.1-$Stamp.bak"
$startBackup  = "$StartCmd.pre-0.2.1-$Stamp.bak"
$pkgBackups   = @{}
Copy-Item $Patch $patchBackup -Force
Copy-Item $StartCmd $startBackup -Force
foreach ($name in @('web-client', 'web')) {
  $manifest = Join-Path $DshHome "profiles\$name\package.json"
  if (Test-Path $manifest) {
    $backup = "$manifest.pre-0.2.1-$Stamp.bak"
    Copy-Item $manifest $backup -Force
    $pkgBackups[$manifest] = $backup
  }
}
Say ("[0] 快照：profile patch → {0}" -f (Split-Path $patchBackup -Leaf))
Say ("[0] 快照：start-dsh-lan.cmd → {0}" -f (Split-Path $startBackup -Leaf))

# ── 1. 停线上实例 ──────────────────────────────────────────────────────────
Stop-Dsh
Start-Sleep -Seconds 2
$still = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue
Say ("[1] 已停止 3080 实例：{0}" -f (-not $still))

# ── 2. 改组合行（agent-presets → agent-preset-registry）────────────────────
try {
  $text = Get-Content $Patch -Raw
  $pattern = '(?m)^- id: agent-presets\r?\n  config:\r?\n    default: \S+'
  if ($text -match $pattern) {
    $text = $text -replace $pattern, "- id: agent-preset-registry`n  config:`n    default: cordis"
    [IO.File]::WriteAllText($Patch, $text, (New-Object Text.UTF8Encoding($false)))
    Say '[2] 组合行：agent-presets → agent-preset-registry（default: cordis）'
  } else {
    Say '[2] 组合行：未找到 agent-presets 行（可能已改过），继续'
  }
} catch {
  Say ("[2] 组合行改写失败：" + $_.Exception.Message)
}

# ── 3. 启动脚本指向新引擎 ──────────────────────────────────────────────────
try {
  # Byte-preserving (Latin-1) replace: the .cmd keeps its Chinese comments and
  # its exact bytes except the one ASCII DSH_DIR line.
  $latin = [System.Text.Encoding]::GetEncoding(28591)
  $bytes = [System.IO.File]::ReadAllBytes($StartCmd)
  $text = $latin.GetString($bytes)
  $patched = $text.Replace(('set "DSH_DIR=' + $OldEngine + '"'), ('set "DSH_DIR=' + $NewEngine + '"'))
  if ($patched -eq $text) { Say '[3] 启动脚本里没找到预期的 DSH_DIR 行，未改动' }
  else { [System.IO.File]::WriteAllBytes($StartCmd, $latin.GetBytes($patched)); Say ('[3] start-dsh-lan.cmd 的 DSH_DIR → ' + $NewEngine) }
} catch {
  Say ("[3] 启动脚本改写失败：" + $_.Exception.Message)
}

# ── 4. 启动新引擎 ──────────────────────────────────────────────────────────
Say ("[4] 启动 0.2.1-rc.2（日志 {0}）" -f (Split-Path $NewErrLog -Leaf))
$null = Start-Dsh $NewEngine $NewLog $NewErrLog
Say ('[4] 已拉起（独立 cmd 进程，输出 2>&1 到 ' + (Split-Path $NewLog -Leaf) + '）')

$ready = Wait-Ready 300
Say ("[4] 就绪 = {0}" -f $ready)

# ── 5. 健康检查 ────────────────────────────────────────────────────────────
$checks = [ordered]@{}
$checks['3080 监听'] = [bool](Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue)
try {
  $me = Invoke-WebRequest 'http://127.0.0.1:3080/auth/me' -UseBasicParsing -TimeoutSec 8 -SkipHttpErrorCheck
  $checks['本机 /auth/me'] = ($me.StatusCode -eq 200)
} catch { $checks['本机 /auth/me'] = $false }
try {
  $lan = Invoke-WebRequest 'https://192.168.28.239:8443/auth/me' -UseBasicParsing -TimeoutSec 10 -SkipHttpErrorCheck
  $checks['LAN https /auth/me'] = ($lan.StatusCode -eq 200)
} catch { $checks['LAN https /auth/me'] = $false }
try {
  $token = [regex]::Match((Get-Content $Patch -Raw), 'gw-[A-Za-z0-9\-]+').Value
  $models = Invoke-WebRequest 'http://127.0.0.1:3080/llm/v1/models' -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 10 -SkipHttpErrorCheck
  $checks['网关 /llm/v1/models'] = ($models.StatusCode -eq 200)
} catch { $checks['网关 /llm/v1/models'] = $false }
try {
  $html = Invoke-WebRequest 'http://127.0.0.1:3080/' -Headers @{ Accept = 'text/html' } -UseBasicParsing -TimeoutSec 8 -SkipHttpErrorCheck
  $checks['首页 HTML'] = ($html.StatusCode -eq 200 -and $html.Content -match '<html')
} catch { $checks['首页 HTML'] = $false }

$errText = ''
if (Test-Path $NewErrLog) { $errText = Get-Content $NewErrLog -Raw }
$fatalPatterns = 'failed to activate|ERR_MODULE_NOT_FOUND|Cannot find package|incompatible with dsh|engine patch FAILED|EADDRINUSE'
$fatalHits = @()
foreach ($pattern in $fatalPatterns.Split('|')) {
  if ($errText -match [regex]::Escape($pattern)) { $fatalHits += $pattern }
}
$checks['启动日志无致命错误'] = ($fatalHits.Count -eq 0)
$checks['运行时补丁命中'] = ($errText -match 'engine patch: legacy-turn-restart applied')

Say ''
Say '## 健康检查'
foreach ($key in $checks.Keys) {
  Say ("- {0}：{1}" -f $key, $(if ($checks[$key]) { '通过' } else { '**失败**' }))
}
if ($fatalHits.Count -gt 0) { Say ("- 命中错误特征：" + ($fatalHits -join ', ')) }

$ok = $true
foreach ($key in $checks.Keys) { if (-not $checks[$key]) { $ok = $false } }

# ── 6. 结果 / 回滚 ─────────────────────────────────────────────────────────
if ($ok) {
  Say ''
  Say '## 结果：升级成功 ✅'
  Say ''
  Say ("- 引擎：{0}" -f $NewEngine)
  Say ("- profile：{0}" -f $Profile)
  Say ("- 日志：{0}" -f $NewErrLog)
  Say ''
  Say '## 你接下来要手动确认的'
  Say '1. 浏览器刷新 https://192.168.28.239:8443 或 http://127.0.0.1:3080'
  Say '2. 文件树面板、标题栏两行按钮、刷新按钮是否正常'
  Say '3. 新建会话 → 预设列表里是否有你原来的 286 个预设'
  Say '4. 发一条消息，确认模型能回话（工具调用也试一次）'
  Say '5. 归档、客户端执行世界（executor / machine tools）'
  Say ''
  Say '回滚：把 `~\.dsh\start-dsh-lan.cmd` 的 DSH_DIR 改回旧引擎并重启；'
  Say '或用桌面《回滚操作说明.md》的场景 B。'
} else {
  Say ''
  Say '## 结果：升级失败，正在回滚 ❌'
  Stop-Dsh
  Start-Sleep -Seconds 3
  Copy-Item $patchBackup $Patch -Force
  Copy-Item $startBackup $StartCmd -Force
  foreach ($manifest in $pkgBackups.Keys) { Copy-Item $pkgBackups[$manifest] $manifest -Force }
  foreach ($name in @('web-client', 'web')) {
    $link = Join-Path $DshHome "profiles\$name\node_modules\dsh-agent-presets-local"
    if (Test-Path $link) { & cmd /c rmdir $link 2>&1 | Out-Null }
  }
  Say '- 已还原 package.json（含 dsh-doc / 终端依赖）并移除预设 bundle 链接'
  if ((Test-Path $imported) -and -not (Test-Path $settings)) {
    Move-Item $imported $settings -Force
    Say '- 已把 settings.yaml.imported 还原成 settings.yaml'
  }
  $null = Start-Dsh $OldEngine (Join-Path $DshHome 'live-0.1.6.log') (Join-Path $DshHome 'live-0.1.6.err.log')
  Say '- 已用旧引擎重启（独立 cmd 进程）'
  $back = Wait-Ready 240
  Say ("- 旧引擎就绪 = {0}" -f $back)
  Say ''
  Say '## 失败现场'
  Say ('```')
  foreach ($line in ($errText -split "`n" | Select-Object -Last 20)) { Say $line }
  Say ('```')
  Say ''
  Say '回滚已自动完成；按桌面《回滚操作说明.md》确认数据（会话 V4 是单向的，本次失败前未写入新会话）。'
}

Say ''
Say ("结束时间：{0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
