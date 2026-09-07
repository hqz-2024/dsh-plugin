#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 局域网部署一键安装脚本。

.DESCRIPTION
  在 dsh-plugin 仓库（即 ~/.dsh）根目录运行。按顺序完成：
    0 前置检查          1 引擎拉取/安装    2 profile 依赖
    3 四个插件依赖      4 角色预设校验    5 渲染 cordis.patch.yml
    6 .credentials.yaml 7 dsh-doc 运行时  8 启动脚本 + caddy
    9 自检 verify.ps1

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
  [string]$LanIP = "192.168.28.239",
  [string]$NodePath = "",
  [switch]$SkipEngine
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ProfileDir = Join-Path $Root "profiles\web"
$Plugins = @("dsh-remote-local", "folder-tree-sh-local", "dsh-usage-panel-local", "dsh-local-bridge")

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

# ── 2. profile 依赖（link: 相对路径，会创建 4 个插件 symlink）───
Step "2. profile 依赖"
Push-Location $ProfileDir
try {
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Fail "profile pnpm install 失败" }
  Ok "profile pnpm install 完成"
} finally { Pop-Location }

# ── 3. 四个插件依赖（link: 不装被链接包自己的依赖，须各自 install）───
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

# ── 4. 角色预设（仓库自带，仅校验）─────────────────────────────
Step "4. 角色预设"
$presets = Get-ChildItem -Directory (Join-Path $Root ".agent-presets") |
  Where-Object { Test-Path (Join-Path $_.FullName "agent.cordis.yml") }
Ok ("角色预设数量：" + $presets.Count + " 个")

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

# ── 8. 启动脚本 + caddy ────────────────────────────────────────
Step "8. 启动脚本"
$start = Join-Path $Root "start-dsh-lan.cmd"
$startTxt = @"
@echo off
REM DeepSeek Harness LAN deployment startup (generated by install.ps1)
set "NODE=$NodePath"
set "DSH_DIR=$EngineDir"
set "LAN_IP=$LanIP"
set "CADDY=%USERPROFILE%\.dsh\bin\caddy.exe"
set "CADDYFILE=%USERPROFILE%\.dsh\Caddyfile"

echo [dsh-lan] starting caddy reverse proxy (0.0.0.0:8443 -^> 127.0.0.1:3080)...
start "dsh-caddy" /min "%CADDY%" run --config "%CADDYFILE%"

echo [dsh-lan] starting dsh web (127.0.0.1:3080)...
start "dsh-web" /min /d "%DSH_DIR%" "%NODE%" --import tsx/esm apps/cli/src/bin.ts --profile web --trusted-host %LAN_IP%

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
