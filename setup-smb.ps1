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
    [string]$SmbPassword = '',

    # 就地共享这些已存在的工作区目录（共享名 = ws-<目录名>）。
    # 上面的 -Workspaces 只认「根目录 + 子目录」的布局；真实部署里的工作区常常已经在
    # 桌面上或别处的既有工程里，把它们搬进受管根目录不是脚本该替人做的决定。这一项
    # 按「工作区在哪就共享哪」补齐：只建共享与 ACL，不移动、不复制、不改动内容。
    [string[]]$SharePaths = @(),

    # 从部署的工作区注册表里读出所有工作区并逐个共享（只读那个文件）。
    # 线上路径：%USERPROFILE%\.dsh\storages\workspace.json
    [switch]$ShareWorkspacesFromRegistry,

    # -ShareWorkspacesFromRegistry 用到的文件；留空则用当前 DSH_HOME 的默认位置。
    [string]$WorkspaceFile = '',

    # 排除项：这些目录永远不共享。默认排除部署自己的数据目录 —— 规则或注册表一旦
    # 覆盖到它，共享出去就是把 API key、会话日志、账号库发给每台客户端机器。
    [string[]]$NeverShare = @()
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

# ── 6. 就地共享既有工作区（可选）────────────────────────────────
# 上面那一段按「工作区根目录 + 子目录」的布局建共享。真实部署里的工作区通常已经在
# 别的目录下过日子（桌面上、或别处的既有工程），所以这一段按「工作区在哪就共享哪」
# 补齐。共享名仍是 `ws-<目录名>`，与 profile 的 `visiblePathHints` 约定一致 ——
# 客户端看到的路径写法因此与受管根目录下的工作区相同。
if ($SharePaths.Count -gt 0 -or $ShareWorkspacesFromRegistry) {

    Step '6. 就地共享既有工作区'

    if ($NeverShare.Count -eq 0) {
        # 部署自己的数据目录：规则或注册表一旦覆盖到它，共享出去就是把凭据发给客户端。
        $NeverShare = @((Join-Path $env:USERPROFILE '.dsh'))
        Ok "默认排除: $($NeverShare -join ', ')"
    }
    $neverFolded = $NeverShare | ForEach-Object { $_.ToLower().TrimEnd('\') }

    $targets = @()
    foreach ($p in $SharePaths) { $targets += [pscustomobject]@{ title = Split-Path -Leaf $p; path = $p } }

    if ($ShareWorkspacesFromRegistry) {
        if (-not $WorkspaceFile) { $WorkspaceFile = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json' }
        $registry = @()
        try {
            $json = Get-Content -LiteralPath $WorkspaceFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($prop in $json.tables.workspaces.PSObject.Properties) {
                $w = $prop.Value
                if ($w -and $w.title -and $w.path) { $registry += [pscustomobject]@{ title = $w.title; path = $w.path } }
            }
            Ok "从注册表读到 $($registry.Count) 个工作区: $WorkspaceFile"
        }
        catch {
            Warn "读不出工作区注册表: $WorkspaceFile（$($_.Exception.Message)）"
        }
        $targets += $registry
    }

    $shared = 0
    foreach ($t in $targets) {
        $path = $t.path
        $folded = $path.ToLower().TrimEnd('\')
        $skip = $false
        foreach ($n in $neverFolded) {
            if ($n -and ($folded -eq $n -or $folded.StartsWith("$n\"))) { $skip = $true; break }
        }
        if ($skip) { Warn "拒绝共享（在排除列表里）: $path"; continue }

        # 共享名取目录名；Windows 共享名允许中文与空格，这里只去掉路径分隔符。
        $name = "ws-" + (Split-Path -Leaf $path)
        if ($name -match '[\\/]' -or $name.Length -le 3) { Warn "无法从路径推出共享名: $path"; continue }

        if (-not (Test-Path -LiteralPath $path)) { Warn "跳过（目录不存在）: $path"; continue }
        $resolved = (Resolve-Path -LiteralPath $path).Path

        $existingShare = Get-SmbShare -Name $name -ErrorAction SilentlyContinue
        if ($existingShare) {
            if ($existingShare.Path -ne $resolved) {
                Warn "共享名冲突: $name 已指向 $($existingShare.Path)，本次要的是 $resolved —— 跳过，请手工决定用哪个名字"
                continue
            }
            Ok "共享已存在: $name -> $resolved"
        }
        else {
            New-SmbShare -Name $name -Path $resolved -ChangeAccess $SmbUser `
                -Description "DSH workspace '$($t.title)'" | Out-Null
            Ok "已创建共享: \\$server\$name -> $resolved"
            $shared++
        }

        # 共享权限之外还需要 NTFS 权限，否则客户端能看见目录却读写失败。
        $acl = (& icacls $resolved) -join "`n"
        if ($acl -match [regex]::Escape($SmbUser)) {
            Ok "  NTFS 权限已含 $SmbUser"
        }
        else {
            & icacls $resolved /grant "${SmbUser}:(OI)(CI)M" /T | Out-Null
            Ok "  已授予 NTFS Modify: $SmbUser"
        }
    }

    Write-Host ''
    Warn "共享会一直保留（SMB 共享本身是持久设置）。要撤销某一条：Remove-SmbShare -Name <共享名> -Force"

    if ($shared -eq 0) { Warn '本次没有新建任何共享。若期望有，请检查上面的拒绝/冲突行。' }
}
