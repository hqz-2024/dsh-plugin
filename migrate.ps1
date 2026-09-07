#Requires -Version 5.1
<#
.SYNOPSIS
  恢复 backup.ps1 的 zip 到 ~/.dsh，并把旧机用户名/绝对路径映射到新机。

.DESCRIPTION
  前置：先在新机跑 install.ps1（装好引擎 + 插件 + 预设 + 生成 cordis.patch.yml），
  再跑本脚本恢复数据。脚本会：
    1) 解压备份；
    2) 把文本文件里的绝对路径（workspace.json / cordis.patch.yml / settings.yaml 等）
       从 C:\Users\<OldUser>\ 映射为 C:\Users\<NewUser>\；
    3) 重命名 sessions\ / sessions-archived\ 下的变形目录名；
    4) 合并进 ~/.dsh。

.PARAMETER Backup
  备份 zip 的路径（必填）。
.PARAMETER OldUser
  旧机用户名（默认=当前用户名，即同名迁移，无需重映射）。
.PARAMETER NewUser
  新机用户名（默认当前用户名）。
.PARAMETER DshHome
  目标 ~/.dsh 目录（默认 %USERPROFILE%\.dsh）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Backup,
  [string]$OldUser = $env:USERNAME,
  [string]$NewUser = $env:USERNAME,
  [string]$DshHome = (Join-Path $env:USERPROFILE ".dsh")
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Backup)) { throw "备份文件不存在：" + $Backup }

$stage = Join-Path $env:TEMP ("dsh-migrate-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Remap-TextFile {
  param([string]$Path)
  $c = [System.IO.File]::ReadAllText($Path)
  $n = $c
  $n = $n.Replace(('C:\Users\' + $OldUser + '\'), ('C:\Users\' + $NewUser + '\'))
  $n = $n.Replace(('C:\\Users\\' + $OldUser + '\\'), ('C:\\Users\\' + $NewUser + '\\'))
  if ($n -ne $c) {
    [System.IO.File]::WriteAllText($Path, $n, (New-Object System.Text.UTF8Encoding($false)))
    return $true
  }
  return $false
}

try {
  Write-Host "解压备份..." 
  Expand-Archive -Path $Backup -DestinationPath $stage -Force

  # 1) 文本文件里的绝对路径（单反斜杠 YAML / 双反斜杠 JSON 都覆盖）
  $remapped = 0
  Get-ChildItem -Path $stage -Recurse -File | Where-Object { $_.Extension -in ".json", ".yaml", ".yml" } | ForEach-Object {
    if (Remap-TextFile $_.FullName) { $script:remapped++ }
  }
  Write-Host ("已重映射文本文件：" + $remapped + " 个")

  # 2) sessions / sessions-archived 目录名里的变形路径
  if ($OldUser -ne $NewUser) {
    $prefix = "--C-Users-" + $OldUser + "-"
    $newPrefix = "--C-Users-" + $NewUser + "-"
    foreach ($sdir in @("sessions", "sessions-archived")) {
      $p = Join-Path $stage $sdir
      if (Test-Path $p) {
        Get-ChildItem $p -Directory | ForEach-Object {
          if ($_.Name.StartsWith($prefix)) {
            $newName = $newPrefix + $_.Name.Substring($prefix.Length)
            if ($newName -ne $_.Name) { Rename-Item -Path $_.FullName -NewName $newName }
          }
        }
      }
    }
  }

  # 3) 合并进 ~/.dsh
  Write-Host ("合并到 " + $DshHome + " ...")
  Copy-Item -Path (Join-Path $stage "*") -Destination $DshHome -Recurse -Force

  Write-Host "迁移完成。" -ForegroundColor Green
  Write-Host ("路径映射：C:\Users\" + $OldUser + "\  ->  C:\Users\" + $NewUser + "\")
  Write-Host ""
  Write-Host "后续手工步骤：" -ForegroundColor Yellow
  Write-Host "  1) 确认工作区文件夹在新路径存在（如 C:\Users\$NewUser\Desktop\finance-ws），否则会话无 cwd。"
  if ($OldUser -ne $NewUser) {
    Write-Host "  2) ⚠ 跨用户名迁移：会话日志（session.jsonl.zstd）内的 cwd 是压缩二进制，本脚本不重写；"
    Write-Host "     若打开旧会话被拒（'session outside your workspace'），请改回同名用户，或联系维护者做 zstd 级重映射。"
  }
  Write-Host "  3) 改 Caddyfile / start-dsh-lan.cmd 里的 LAN_IP；放行 8443 入站防火墙；信任 caddy 根证书。"
  Write-Host "  4) 在 profiles\web 重新 pnpm install 重连 link 依赖；启动后按 MIGRATION.md 验证清单核对。"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
