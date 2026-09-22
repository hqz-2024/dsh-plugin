#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 局域网部署一键安装脚本。

.DESCRIPTION
  在 dsh-plugin 仓库（即 ~/.dsh）根目录运行。按顺序完成：
    0 前置检查          1 引擎拉取/安装    2 profile 依赖
    3 五个插件依赖      4 角色预设 + 全局 skill 校验
    5 渲染 cordis.patch.yml                  6 .credentials.yaml
    7 dsh-doc 运行时  7b FFmpeg 二进制  8 启动脚本 + caddy  9 自检 verify.ps1

  幂等：可重复运行，已存在的文件/已完成步骤会跳过（不覆盖你的 token）。

.PARAMETER EngineDir
  deepseek-harness checkout 路径（默认 %USERPROFILE%\Desktop\deepseek-harness）。
.PARAMETER EngineRepo
  引擎仓库（含会话隔离改动），默认 https://github.com/hqz-2024/hqz-dsh.git。
.PARAMETER EngineBranch
  引擎分支，默认 hqz-dsh。
.PARAMETER LanIP
  服务器局域网 IP（写入 caddy 反代地址与 --trusted-host）。
.PARAMETER NodePath
  node.exe 绝对路径；留空则自动用 PATH 里的 node。
.PARAMETER SkipEngine
  跳过引擎拉取与 pnpm install（引擎已就绪时用）。
#>
[CmdletBinding()]
param(
  [string]$EngineDir = (Join-Path $env:USERPROFILE "Desktop\deepseek-harness"),
  [string]$EngineRepo = "https://github.com/hqz-2024/hqz-dsh.git",
  [string]$EngineBranch = "hqz-dsh",
  [string]$LanIP = "",
  [string]$NodePath = "",
  # 生成的启动脚本用哪个 profile：web（默认，全部在服务器执行）或
  # web-client（挂客户端执行世界）。改了 profile 之后重跑 install.ps1 时，
  # 不带这个参数会把启动脚本改回 web。
  [string]$RunProfile = "web",
  [switch]$SkipEngine
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ProfileDir = Join-Path $Root "profiles\web"
$Plugins = @(Get-ChildItem (Join-Path $PSScriptRoot "plugins") -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
  Select-Object -ExpandProperty Name)
$Presets = @("finance-manager", "art-design", "business-sales", "procurement", "production", "hr-management", "rd-development")
$Skills  = @("sidecar", "dsh-development", "dsh-video-studio", "firecrawl", "adobe-illustrator-scripting",
             "defuddle", "json-canvas", "obsidian-cli", "obsidian-markdown", "obsidian-bases")

function Step($msg) { Write-Host ("`n==> " + $msg) -ForegroundColor Cyan }
function Ok($msg)   { Write-Host ("    [ok] " + $msg) -ForegroundColor Green }
function Warn($msg) { Write-Host ("    [!!] " + $msg) -ForegroundColor Yellow }
function Fail($msg) { throw $msg }

# 40 位十六进制随机 token（sidecar 用）
function New-Token {
  $bytes = New-Object byte[] 20
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
}

# ── 0. 前置检查 ────────────────────────────────────────────────
Step "0. 前置检查"
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source } else { Fail "未找到 node：请安装 Node.js 22.19+ 或 24+" }
}
$nodeVer = & $NodePath --version
Ok ("node: " + $nodeVer + "  (" + $NodePath + ")")
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail "未找到 pnpm：先执行 corepack enable" }
Ok ("pnpm: " + (& pnpm --version))
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "未找到 git" }

# ── 1. 引擎 ────────────────────────────────────────────────────
if (-not $SkipEngine) {
  Step "1. deepseek-harness 引擎"
  if (-not (Test-Path (Join-Path $EngineDir "package.json"))) {
    Warn ("引擎目录不存在，正在 clone " + $EngineRepo + " 分支 " + $EngineBranch)
    git clone -b $EngineBranch $EngineRepo $EngineDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone 失败" }
  } else {
    Ok ("引擎已存在：" + $EngineDir)
  }
  Push-Location $EngineDir
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "engine pnpm install 失败" }
    Ok "engine pnpm install 完成"
  } finally { Pop-Location }
}

# ── 2. profile 依赖（link: 相对路径，会创建 5 个插件 symlink）───
Step "2. profile 依赖"
Push-Location $ProfileDir
try {
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Fail "profile pnpm install 失败" }
  Ok "profile pnpm install 完成"
} finally { Pop-Location }

# ── 3. 插件依赖（link: 不装被链接包自己的依赖，须各自 install）───
# 清单由 plugins\ 目录推导：写死过一版（五个名字），后来删掉一个、又加了五个，
# 没人回来改 —— 少装的插件要到 profile 启动时才炸。
Step "3. 插件依赖"
foreach ($p in $Plugins) {
  $d = Join-Path $Root ("plugins\" + $p)
  if (-not (Test-Path (Join-Path $d "package.json"))) { Warn ("插件缺失：" + $p); continue }
  Push-Location $d
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Warn ($p + " pnpm install 失败（请检查网络/依赖）") }
    else { Ok ($p + " 依赖 ok") }
  } finally { Pop-Location }
}

# ── 4. 角色预设 + 全局 skill（仓库自带，仅校验）─────────────────
Step "4. 角色预设 + 全局 skill"
$missing = @()
foreach ($p in $Presets) {
  if (-not (Test-Path (Join-Path $Root (".agent-presets\" + $p + "\agent.cordis.yml")))) { $missing += $p }
}
if ($missing.Count -eq 0) { Ok ("自定义角色预设齐全：" + $Presets.Count + " 个（各带 skills 目录）") }
else { Warn ("角色预设缺失：" + ($missing -join ", ")) }

$allPresets = (Get-ChildItem -Directory (Join-Path $Root ".agent-presets") |
  Where-Object { Test-Path (Join-Path $_.FullName "agent.cordis.yml") }).Count
if ($allPresets -lt 286) { Warn ("预设总数 " + $allPresets + " 个，少于预期的 286（7 自定义 + 279 agency）") }
else { Ok ("预设总数：" + $allPresets + " 个（7 自定义 + 279 agency）") }

$missingSkill = @()
foreach ($s in $Skills) {
  if (-not (Test-Path (Join-Path $Root ("skills\" + $s + "\SKILL.md")))) { $missingSkill += $s }
}
if ($missingSkill.Count -eq 0) { Ok ("全局 skill 齐全：" + $Skills.Count + " 个（~\.dsh\skills 自动被 dsh 加载）") }
else { Warn ("全局 skill 缺失：" + ($missingSkill -join ", ")) }

# ── 5. 渲染 cordis.patch.yml ───────────────────────────────────
Step "5. 渲染 cordis.patch.yml（token + 路径）"
$example = Join-Path $ProfileDir "cordis.patch.example.yml"
$target  = Join-Path $ProfileDir "cordis.patch.yml"
if (-not (Test-Path $example)) { Fail ("缺模板：" + $example) }
if (Test-Path $target) {
  Ok "cordis.patch.yml 已存在，跳过（避免覆盖你的 token）"
} else {
  $content = Get-Content $example -Raw
  $content = $content -replace '<USERNAME>', $env:USERNAME
  $content = $content -replace 'REPLACE_WITH_RANDOM_TOKEN_40HEX_admin',        (New-Token)
  $content = $content -replace 'REPLACE_WITH_RANDOM_TOKEN_40HEX_finance_mgr',  (New-Token)
  $content = $content -replace 'REPLACE_WITH_RANDOM_TOKEN_40HEX_finance_staff',(New-Token)
  [System.IO.File]::WriteAllText($target, $content, (New-Object System.Text.UTF8Encoding($false)))
  Ok "已生成 cordis.patch.yml（含 3 个新 sidecar token）"
}

# ── 6. .credentials.yaml（API key）─────────────────────────────
Step "6. DEEPSEEK_API_KEY"
$cred = Join-Path $Root ".credentials.yaml"
if (Test-Path $cred) {
  Ok ".credentials.yaml 已存在"
} else {
  $key = Read-Host "请输入 DEEPSEEK_API_KEY（留空跳过，稍后手动补）"
  if ($key -and $key.Trim().Length -gt 0) {
    $txt = "version: 1`r`nrefs:`r`n  DEEPSEEK_API_KEY: " + $key.Trim() + "`r`n"
    [System.IO.File]::WriteAllText($cred, $txt, (New-Object System.Text.UTF8Encoding($false)))
    Ok "已生成 .credentials.yaml（browser-session 记录会在首次连接时自动建立）"
  } else {
    Warn "未填 API key。迁移旧机请直接 robocopy .credentials.yaml 过来"
  }
}

# ── 7. dsh-doc OCR 运行时 ──────────────────────────────────────
Step "7. dsh-doc OCR 运行时"
$rt = Join-Path $Root "runtimes\dshdoc-runtime-win32-x64"
if (Test-Path $rt) { Ok ("运行时已存在：" + $rt) }
else {
  $fetch = Join-Path $ProfileDir "node_modules\dsh-doc\scripts\fetch-runtime-win32-x64.mjs"
  if (Test-Path $fetch) {
    Warn "运行时缺失，正在从 dsh-doc GitHub Release 下载（~178MB，含 SHA-256 校验）..."
    & $NodePath $fetch $rt
    if (($LASTEXITCODE -eq 0) -and (Test-Path $rt)) { Ok "运行时下载 + 校验完成" }
    else { Warn ("下载失败。可稍后手动执行：node `"" + $fetch + "`" `"" + $rt + "`"") }
  } else {
    Warn "dsh-doc 未安装，无法自动下载运行时（请先完成 profile/插件的 pnpm install）"
  }
}

# ── 7b. FFmpeg 二进制（dsh-video-studio 内嵌）───────────────────
Step "7b. FFmpeg 二进制"
$vsBin = Join-Path $Root "plugins\dsh-video-studio-local\bin"
$ffmpegExe = Join-Path $vsBin "ffmpeg.exe"
$ffprobeExe = Join-Path $vsBin "ffprobe.exe"
if ((Test-Path $ffmpegExe) -and (Test-Path $ffprobeExe)) {
  Ok "FFmpeg 二进制已存在（ffmpeg.exe + ffprobe.exe）"
} else {
  New-Item -ItemType Directory -Force -Path $vsBin | Out-Null
  $ffZip = Join-Path $env:TEMP "ffmpeg-master-latest-win64-gpl.zip"
  $ffUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  $ffSha = "073f39088fae36179dfe745406aa8ce67affcde0d91dc0bda7dba5c1964e03be"
  Warn "正在下载 FFmpeg（~185MB，含 SHA-256 校验）..."
  & curl.exe -L --fail --retry 3 -o $ffZip $ffUrl
  if ($LASTEXITCODE -ne 0) {
    Warn "curl 下载失败（可稍后手动下载 ffmpeg.exe/ffprobe.exe 到 $vsBin）"
  } else {
    $hash = (Get-FileHash -Algorithm SHA256 $ffZip).Hash.ToLowerInvariant()
    if ($hash -ne $ffSha) {
      Warn ("SHA256 不匹配：" + $hash)
    } else {
      $extract = Join-Path $env:TEMP "ffmpeg-extract"
      if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
      Expand-Archive -Path $ffZip -DestinationPath $extract
      $ff = Get-ChildItem -Path $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
      $fp = Get-ChildItem -Path $extract -Recurse -Filter ffprobe.exe | Select-Object -First 1
      Copy-Item $ff.FullName $ffmpegExe -Force
      Copy-Item $fp.FullName $ffprobeExe -Force
      Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
      Remove-Item $ffZip -ErrorAction SilentlyContinue
      Ok "FFmpeg 下载 + SHA256 校验 + 解压完成"
    }
  }
}

# ── 7c. manifest 校对工具（下载 exe，失败则本地打包）─────────
Step "7c. manifest 校对工具"
$mtDir = Join-Path $Root "tools\manifest-tool"
$mtExe = Join-Path $Root "plugins\dsh-video-studio-local\assets\manifest-tool.exe"
$mtUrl = "https://github.com/hqz-2024/dsh-plugin/releases/download/v0.1.0/manifest-tool.exe"
$mtSha = "120134f3dd7ba13e2df464d10468a74e201fdae968755aa85f81c4830962c1c5"
if (Test-Path $mtExe) {
  Ok "manifest 校对工具 exe 已存在"
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $mtExe) | Out-Null
  Warn "正在下载 manifest 校对工具 exe（~152MB，含 SHA256 校验）..."
  & curl.exe -L --fail --retry 2 -o $mtExe $mtUrl
  $hash = if (Test-Path $mtExe) { (Get-FileHash -Algorithm SHA256 $mtExe).Hash.ToLowerInvariant() } else { "" }
  if (($LASTEXITCODE -eq 0) -and ($hash -eq $mtSha)) {
    Ok "manifest 校对工具下载 + 校验完成"
  } else {
    Remove-Item $mtExe -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $mtDir "package.json"))) {
      Warn "下载失败且源码缺失，跳过（可稍后手动处理）"
    } else {
      Warn "下载失败，尝试本地打包（需网络下载 electron，约 2-5 分钟）..."
      $ffmpegBin = Join-Path $Root "plugins\dsh-video-studio-local\bin"
      $mtFfmpeg = Join-Path $mtDir "ffmpeg"
      if ((Test-Path (Join-Path $ffmpegBin "ffmpeg.exe")) -and (-not (Test-Path (Join-Path $mtFfmpeg "ffmpeg.exe")))) {
        New-Item -ItemType Directory -Force -Path $mtFfmpeg | Out-Null
        Copy-Item (Join-Path $ffmpegBin "ffmpeg.exe") $mtFfmpeg -Force
        Copy-Item (Join-Path $ffmpegBin "ffprobe.exe") $mtFfmpeg -Force
      }
      Push-Location $mtDir
      try {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
        $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
        & npm install
        if ($LASTEXITCODE -ne 0) { Warn "manifest 工具 npm install 失败" }
        else {
          & npx electron-builder --win portable
          $dist = Join-Path $mtDir "dist\manifest-tool.exe"
          if (($LASTEXITCODE -eq 0) -and (Test-Path $dist)) {
            Copy-Item $dist $mtExe -Force
            Ok "manifest 校对工具本地打包完成"
          } else { Warn "manifest 工具打包失败" }
        }
      } finally { Pop-Location }
    }
  }
}

# ── 8. Caddyfile + 启动脚本 ────────────────────────────────────
Step "8. Caddyfile + 启动脚本"
if (-not $LanIP -or $LanIP.Trim() -eq "") {
  $LanIP = Read-Host "请输入服务器局域网 IP（如 192.168.x.x）"
}
if (-not $LanIP -or $LanIP.Trim() -eq "") { Fail "未提供局域网 IP（用 -LanIP 传入）" }

# Caddyfile（真实文件 gitignore，含机器 IP）
$caddyfile = Join-Path $Root "Caddyfile"
$caddyTxt = @"
# dsh 局域网 HTTPS 反代（由 install.ps1 生成）
# 局域网设备访问 https://${LanIP}:8443
# 转发到本机 dsh (127.0.0.1:3080)。dsh 仍只监听本机，caddy 是唯一对外入口。
# tls internal = caddy 本地自签证书；reverse_proxy 自动转发 WebSocket 升级。
https://${LanIP}:8443 {
	tls internal
	reverse_proxy 127.0.0.1:3080
}
"@
[System.IO.File]::WriteAllText($caddyfile, $caddyTxt, (New-Object System.Text.UTF8Encoding($false)))
Ok ("已生成 Caddyfile：" + $caddyfile)

# 启动脚本（真实文件 gitignore，含机器路径）
$start = Join-Path $Root "start-dsh-lan.cmd"
$startTxt = @"
@echo off
REM DeepSeek Harness LAN deployment startup (generated by install.ps1)
set "NODE=$NodePath"
set "DSH_DIR=$EngineDir"
set "LAN_IP=$LanIP"
REM web = 全部命令在服务器执行；web-client = 已绑定的工作区由绑定它的机器执行。
REM 生成的默认值是 -RunProfile 给的那个（默认 web），改了 profile 之后重跑 install.ps1
REM 会把这里改回来，所以要么带上 -RunProfile，要么记得回来改这一行。
set "PROFILE=$RunProfile"
set "CADDY=%USERPROFILE%\.dsh\bin\caddy.exe"
set "CADDYFILE=%USERPROFILE%\.dsh\Caddyfile"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080, profile=%PROFILE%)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile %PROFILE% --trusted-host %LAN_IP%

echo [dsh-lan] started. LAN access: https://%LAN_IP%:8443
"@
[System.IO.File]::WriteAllText($start, $startTxt, (New-Object System.Text.UTF8Encoding($false)))
Ok ("已生成启动脚本：" + $start)

if (-not (Test-Path (Join-Path $Root "bin\caddy.exe"))) {
  Warn "未找到 bin\caddy.exe：请 winget install CaddyServer.Caddy 后复制到 ~\.dsh\bin\caddy.exe"
}

# ── 9. 自检 ────────────────────────────────────────────────────
Step "9. 自检 verify.ps1"
$verify = Join-Path $Root "verify.ps1"
if (Test-Path $verify) {
  & $verify
  if ($LASTEXITCODE -eq 0) { Ok "自检通过" } else { Warn "自检未全通过（见上方输出）" }
} else { Warn "缺 verify.ps1" }

Write-Host ("`n安装流程结束。启动：`n  " + $start) -ForegroundColor Green
Write-Host "首次启动后用 loopback 引导创建 admin，再在设置页建账号；信任 caddy 根证书见 README.md 第七节。"
