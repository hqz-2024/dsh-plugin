<#
.SYNOPSIS
一条命令构建客户端安装包，并把产物放进设置页「本地插件」的分发目录。

.DESCRIPTION
做三件事：
  1. 备好本机 Electron 镜像并起一个临时 HTTP 服务 —— 这台机器从 GitHub release 拉
     150 MB 的 electron zip 会稳定卡死在 0 字节，打包因此走本机镜像（哈希仍按上游
     SHASUMS256.txt 校验，不是我们自己算的）；
  2. 在桌面 worktree 里跑 package:desktop:win:x64:unsigned（安装包里的部署地址由打包
     时自动探测，见 apps/desktop/.env.windows 的 DSH_DESKTOP_SERVER_MODE）；
  3. 把新产物复制到 $DSH_HOME\client\dist —— 设置页「本地插件」按"目录里最新的 .exe"
     现读，所以复制完刷新页面就能下载，不用改代码、不用重启 dsh。

**构建期间不要动这个仓库**：客户端构建把 HEAD 记进构件记录，release:pack 会再比一次，
中途提交会让打包以 "client build environment differs … DSH_CLIENT_COMMIT_HASH" 中止。

.PARAMETER Repo
桌面 worktree（默认 C:\Users\bestarc\Desktop\dsh-desktop）。

.PARAMETER DistDir
分发目录；默认 %USERPROFILE%\.dsh\client\dist。

.PARAMETER MirrorPort
本机 Electron 镜像用的端口，默认 8791。

.PARAMETER SkipBuild
不构建，只把现有产物发布出去（想重发上一次的结果时用）。

.PARAMETER SkipPublish
只构建，不复制到分发目录。

.PARAMETER StopRunning
如果目标目录里正跑着客户端实例（它们锁着 win-unpacked 里的 dll），先把它们结束掉。
不给就报错退出，由你决定。

.EXAMPLE
.\build-client.ps1
#>
[CmdletBinding()]
param(
	[string]$Repo = 'C:\Users\bestarc\Desktop\dsh-desktop',
	[string]$DistDir = (Join-Path $env:USERPROFILE '.dsh\client\dist'),
	[int]$MirrorPort = 8791,
	[switch]$SkipBuild,
	[switch]$SkipPublish,
	[switch]$StopRunning
)

$ErrorActionPreference = 'Stop'

$ElectronVersion = 'v44.0.0'
$Artifacts = Join-Path $Repo 'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts'
$MirrorRoot = Join-Path $Repo 'apps\desktop\.desktop-build\targets\win-x64\electron-mirror'
$MirrorServer = Join-Path $env:USERPROFILE '.dsh\electron-mirror-server.mjs'
$CacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'

function Test-Port([int]$Port) {
	return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# 把已经下载并核对过的那份 zip 摆成 @electron/get 认的布局：<mirror>/v44.0.0/<文件名>。
function Initialize-Mirror {
	$versionDir = Join-Path $MirrorRoot $ElectronVersion
	New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
	$zip = Join-Path $versionDir "electron-$ElectronVersion-win32-x64.zip"
	if (-not (Test-Path $zip)) {
		$cached = Get-ChildItem $CacheRoot -Recurse -Filter "electron-$ElectronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
			Sort-Object Length -Descending | Select-Object -First 1
		if ($null -eq $cached) {
			throw "本机缓存里没有 electron-$ElectronVersion-win32-x64.zip（$CacheRoot）；先让一次打包把它下下来，或手工放一份到 $versionDir"
		}
		Copy-Item $cached.FullName $zip -Force
		Write-Host "已从缓存取用 $($cached.FullName)"
	}
	$sums = Join-Path $versionDir 'SHASUMS256.txt'
	if (-not (Test-Path $sums)) {
		$response = Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/$ElectronVersion/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60
		# 上游这份文件是 application/octet-stream，Invoke-WebRequest 会给 byte[]；
		# 直接 Set-Content 会把每个字节写成一行十进制数字。
		[System.IO.File]::WriteAllBytes($sums, $response.Content)
	}
	# 上游声明的哈希必须与本地这份 zip 一致，否则 sumchecker 会在打包中途失败。
	$expected = (Select-String -Path $sums -Pattern "electron-$ElectronVersion-win32-x64\.zip").Line.Split(' ')[0]
	$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
	if ($expected -ne $actual) { throw "镜像里的 zip 与上游 SHASUMS256.txt 不一致：期望 $expected，实际 $actual" }
	return $versionDir
}

$startedMirror = $false
$mirrorProcess = $null
try {
	if (-not $SkipBuild) {
		# 从目标目录跑着的客户端锁着 win-unpacked 里的 dxcompiler.dll 等文件，打包会一路跑到最后
		# 一步才以 `EPERM: operation not permitted, unlink …` 失败 —— 那已经是十几分钟以后。
		$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
			Where-Object { $_.Path -like "$Artifacts*" })
		if ($running.Count -gt 0) {
			if (-not $StopRunning) {
				$pids = ($running | ForEach-Object { $_.Id }) -join ', '
				throw "有 $($running.Count) 个客户端实例正从目标目录运行（pid $pids）：它们锁着 win-unpacked 里的文件，打包会在最后一步以 EPERM 失败。先关掉它们，或加 -StopRunning 让本脚本代关。"
			}
			$running | Stop-Process -Force
			Start-Sleep -Seconds 2
			Write-Host "已结束 $($running.Count) 个占用目标目录的客户端实例"
		}
		$null = Initialize-Mirror
		if (-not (Test-Port $MirrorPort)) {
			Write-Host "起本机 Electron 镜像（127.0.0.1:$MirrorPort）…"
			$mirrorProcess = Start-Process node -ArgumentList @($MirrorServer, $MirrorRoot, "$MirrorPort") -PassThru -WindowStyle Hidden
			$startedMirror = $true
			$deadline = (Get-Date).AddSeconds(30)
			while (-not (Test-Port $MirrorPort) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
			if (-not (Test-Port $MirrorPort)) { throw "镜像没能在 30 秒内监听 $MirrorPort" }
		} else {
			Write-Host "端口 $MirrorPort 已经在听 —— 复用现有的镜像，不另起一个。"
		}
		Write-Host '开始构建（约 15 分钟）…' -ForegroundColor Cyan
		$env:ELECTRON_MIRROR = "http://127.0.0.1:$MirrorPort/"
		Push-Location $Repo
		try {
			& pnpm run package:desktop:win:x64:unsigned
			if ($LASTEXITCODE -ne 0) { throw "打包失败（退出码 $LASTEXITCODE）" }
		} finally { Pop-Location }
	}

	$installer = Get-ChildItem $Artifacts -Filter '*.exe' -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTime -Descending | Select-Object -First 1
	if ($null -eq $installer) { throw "在 $Artifacts 里找不到安装包" }
	Write-Host ''
	Write-Host "产物：$($installer.FullName)" -ForegroundColor Green
	Write-Host "  $([math]::Round($installer.Length / 1MB, 2)) MB，构建于 $($installer.LastWriteTime)"

	if ($SkipPublish) {
		Write-Host '（-SkipPublish）没有复制到分发目录。'
	} else {
		New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
		Get-ChildItem $DistDir -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
			if ($_.Name -ne $installer.Name) { Write-Host "  清掉旧版本 $($_.Name)"; Remove-Item $_.FullName -Force }
		}
		Copy-Item $installer.FullName $DistDir -Force
		$published = Join-Path $DistDir $installer.Name
		if ((Get-FileHash $published).Hash -ne (Get-FileHash $installer.FullName).Hash) { throw '复制后哈希不一致' }
		Write-Host "已发布到 $published" -ForegroundColor Green
		Write-Host "  SHA-256 $((Get-FileHash $published).Hash)"
		Write-Host ''
		Write-Host '客户端在 设置 →「本地插件」→「桌面客户端（可选）」里直接下载（列表每次请求现读，刷新页面即可）。'
		$lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
			Where-Object {
				$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '172.1[6-9].*' -and
				$_.IPAddress -notlike '172.2[0-9].*' -and $_.IPAddress -notlike '172.3[01].*'
			} |
			Sort-Object @{ Expression = { if ($_.IPAddress -like '192.168.*') { 0 } elseif ($_.IPAddress -like '10.*') { 1 } else { 2 } } }, IPAddress |
			Select-Object -First 1
		if ($null -ne $lan) { Write-Host "  部署入口：https://$($lan.IPAddress):8443（与打包时烘进客户端的是同一个规则：私网段优先、排除虚拟网卡）" }
	}
} finally {
	if ($startedMirror -and $null -ne $mirrorProcess -and -not $mirrorProcess.HasExited) {
		Stop-Process -Id $mirrorProcess.Id -Force -ErrorAction SilentlyContinue
		Write-Host '（已停掉本次起的镜像）'
	}
}
