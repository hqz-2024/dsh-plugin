#Requires -Version 5.1
<#
.SYNOPSIS
  打包 ~/.dsh 的「状态 + 密钥」为 zip，用于备份 / 迁移。

.DESCRIPTION
  只打包运行时状态与机密，不打包可再生/可下载的东西：
    - 不含 node_modules（pnpm install 重建）
    - 不含 runtimes\dshdoc-runtime-*（install.ps1 从 GitHub Release 重新下载）
    - 不含 bin\caddy.exe（winget 重装 + 复制）
    - 不含 .git、*.log
  代码（plugins / .agent-presets / profiles 模板）走 dsh-plugin 仓库，不在此备份内。

.PARAMETER Output
  输出 zip 路径（默认 ~/.dsh/backup/dsh-backup-<时间戳>.zip）。
.PARAMETER SkipSecrets
  跳过 .credentials.yaml（API key），但 auth\store.json 与 cordis.patch.yml 仍会包含。
#>
[CmdletBinding()]
param(
  [string]$Output = (Join-Path $env:USERPROFILE (".dsh\backup\dsh-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")),
  [switch]$SkipSecrets
)
$ErrorActionPreference = "Stop"
$Root = Join-Path $env:USERPROFILE ".dsh"

$items = @(
  "sessions",
  "sessions-archived",
  "attachments",
  "auth",
  "storages",
  "llm-deepseek",
  "settings.yaml",
  "dsh-remote-files.json",
  ".anonymous-user-id",
  "profiles\web\cordis.patch.yml"
)
if (-not $SkipSecrets) { $items += ".credentials.yaml" }

$stage = Join-Path $env:TEMP ("dsh-backup-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  $copied = @()
  foreach ($it in $items) {
    $src = Join-Path $Root $it
    if (Test-Path $src) {
      $dst = Join-Path $stage $it
      New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
      Copy-Item -Path $src -Destination $dst -Recurse -Force
      $copied += $it
    }
  }
  if ($copied.Count -eq 0) { throw "没有可备份的内容（~/.dsh 下未找到任何目标路径）" }

  New-Item -ItemType Directory -Path (Split-Path $Output) -Force | Out-Null
  $top = Get-ChildItem -Path $stage -Force | ForEach-Object { $_.FullName }
  Compress-Archive -Path $top -DestinationPath $Output -CompressionLevel Optimal -Force

  $sz = (Get-Item $Output).Length
  Write-Host ("备份完成：" + $Output + "  (" + [math]::Round($sz/1MB,1) + " MB)") -ForegroundColor Green
  Write-Host ("包含：" + ($copied -join ", "))
  if (-not $SkipSecrets) {
    Write-Host "⚠ 本备份含机密（.credentials.yaml / auth\store.json / cordis.patch.yml 的 sidecar token），请走可信通道，勿提交 git。" -ForegroundColor Yellow
  } else {
    Write-Host "已跳过 .credentials.yaml（auth\store.json 与 cordis.patch.yml 仍在备份内）。" -ForegroundColor Yellow
  }
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
