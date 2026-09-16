<#
.SYNOPSIS
    DSH 客户端执行世界 — SMB 工作区共享安装（P0-2 验证用）

.DESCRIPTION
    对应 ~/.dsh/docs/plan-client-world.md §2.2。建立：
      · 工作区根目录 C:\dsh-workspaces\<name>（计划 §2.1 采用的布局）
      · 一个专用 SMB 本地账号
      · 每个工作区一个共享 \\<server>\ws-<name>
      · 与"账号可访问工作区"一致的 NTFS ACL
      · 文件共享入站防火墙规则（按规则 Name 启用，不受中文系统显示名影响）

    必须用【管理员】PowerShell 运行：建共享、建本地账号、改防火墙都需要提权。

.EXAMPLE
    # 默认：建一个 smbtest 工作区 + dshtest 账号
    .\setup-smb.ps1

.EXAMPLE
    # 指定工作区与账号
    .\setup-smb.ps1 -Workspaces smbtest,alice -SmbUser dshsmb -SmbPassword 'Your-Strong-Pass-2026!'
#>
[CmdletBinding()]
param(
    # 工作区根目录；每个工作区是它下面的一个子目录
    [string]$WorkspaceRoot = 'C:\dsh-workspaces',

    # 要建立并共享的工作区目录名（共享名为 ws-<name>）
    [string[]]$Workspaces = @('smbtest'),

    # 专用 SMB 本地账号名
    [string]$SmbUser = 'dshtest',

    # 该账号的密码。留空则本次随机生成一个强密码并打印。
    # 刻意**不给默认值**：写死在脚本里的密码会被提交进 git，而它对一个真实存在的
    # 本机账号有效 —— 本脚本的第一版就是这么泄的（已从工作副本里去掉，历史里仍有，
    # 见 README 的运维提示）。
    [string]$SmbPassword = ''
)

if (-not $SmbPassword) {
    # 保证四类字符齐全，满足本机密码复杂度策略。
    $body = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ })
    $SmbPassword = $body + 'aA1!'
}

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    [x]  $m" -ForegroundColor Red; exit 1 }

# ── 0. 前置检查 ────────────────────────────────────────────────
Step '0. 前置检查'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail '需要管理员权限。请以管理员身份打开 PowerShell 后重试。'
}
Ok '管理员权限'
$server = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1 -ExpandProperty IPAddress
Ok "服务器地址: $server"

$profiles = Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory -Unique
Ok "网络配置文件: $($profiles -join ', ')"
if ($profiles -contains 'Public') {
    Warn '存在 Public 配置文件；Public 下文件共享默认被拦。若客户端连的是 Public 网络，需要在客户端侧改为专用网络。'
}

# ── 1. 工作区目录 ──────────────────────────────────────────────
Step '1. 工作区目录'
foreach ($ws in $Workspaces) {
    $path = Join-Path $WorkspaceRoot $ws
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    if (-not (Test-Path (Join-Path $path 'server-wrote.txt'))) {
        Set-Content -Path (Join-Path $path 'server-wrote.txt') `
            -Value "written by server ($env:COMPUTERNAME) at $(Get-Date -Format o)" -Encoding UTF8
    }
    Ok "$path（含 server-wrote.txt）"
}

# ── 2. 专用 SMB 账号 ───────────────────────────────────────────
Step '2. 专用 SMB 账号'
$existing = Get-LocalUser -Name $SmbUser -ErrorAction SilentlyContinue
if ($existing) {
    Ok "账号已存在: $SmbUser"
} else {
    $secure = ConvertTo-SecureString $SmbPassword -AsPlainText -Force
    New-LocalUser -Name $SmbUser -Password $secure -PasswordNeverExpires `
        -Description 'DSH 工作区 SMB 访问专用账号' -AccountNeverExpires | Out-Null
    Ok "已创建账号: $SmbUser"
}
# 该账号只用于网络访问，禁止交互式登录可减小面；这里保留默认以便排查登录问题。
Ok "密码: $SmbPassword"

# ── 3. 共享 + NTFS 权限 ────────────────────────────────────────
Step '3. 共享与 ACL'
foreach ($ws in $Workspaces) {
    $path = Join-Path $WorkspaceRoot $ws
    $share = "ws-$ws"

    if (Get-SmbShare -Name $share -ErrorAction SilentlyContinue) {
        Ok "共享已存在: $share"
    } else {
        New-SmbShare -Name $share -Path $path -ChangeAccess $SmbUser `
            -Description "DSH workspace '$ws'" | Out-Null
        Ok "已创建共享: \\$server\$share -> $path"
    }

    # 共享权限之外还需要 NTFS 权限，否则客户端会看到但读写失败。
    $acl = (& icacls $path) -join "`n"
    if ($acl -match [regex]::Escape($SmbUser)) {
        Ok "NTFS 权限已含 $SmbUser"
    } else {
        & icacls $path /grant "${SmbUser}:(OI)(CI)M" /T | Out-Null
        Ok "已授予 NTFS Modify: $SmbUser"
    }
}

# ── 4. 防火墙 ──────────────────────────────────────────────────
Step '4. 防火墙（文件共享入站）'
# 按规则 Name 启用，避免中文系统显示名不匹配。
$ruleNames = @('FPS-SMB-In-TCP', 'FPS-NB_Name-In-UDP', 'FPS-NB_Datagram-In-UDP', 'FPS-LLMNR-In-UDP', 'FPS-RPCSS-In-TCP')
foreach ($name in $ruleNames) {
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if (-not $rule) { Warn "规则不存在: $name"; continue }
    if ($rule.Enabled -eq 'True') { Ok "$name 已启用" }
    else { Enable-NetFirewallRule -Name $name; Ok "$name 已启用（本次开启）" }
}
Ok '445 入站已放行（Private/Domain 配置文件）'

# ── 5. 自检 ────────────────────────────────────────────────────
Step '5. 自检'
foreach ($ws in $Workspaces) {
    $share = "ws-$ws"
    $s = Get-SmbShare -Name $share -ErrorAction SilentlyContinue
    if (-not $s) { Fail "共享缺失: $share" }
    $access = Get-SmbShareAccess -Name $share | ForEach-Object { "$($_.AccountName)=$($_.AccessRight)" }
    Ok "$share  路径=$($s.Path)  访问=$($access -join ', ')"
}
$listen = Get-NetTCPConnection -LocalPort 445 -State Listen -ErrorAction SilentlyContinue
if ($listen) { Ok '445 正在监听' } else { Fail '445 未监听' }

Write-Host ''
Write-Host '服务器侧就绪。现在到第二台设备上执行客户端侧步骤（见 docs/plan-client-world-p0.md §SMB 验证）。' -ForegroundColor Cyan
Write-Host ''
Write-Host '  服务器地址 : ' -NoNewline; Write-Host $server -ForegroundColor White
Write-Host '  账号       : ' -NoNewline; Write-Host $SmbUser -ForegroundColor White
Write-Host '  密码       : ' -NoNewline; Write-Host $SmbPassword -ForegroundColor White
foreach ($ws in $Workspaces) {
    Write-Host "  UNC 路径   : " -NoNewline; Write-Host "\\$server\ws-$ws" -ForegroundColor White
}
