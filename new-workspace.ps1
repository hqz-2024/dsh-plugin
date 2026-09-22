# 新建工作区并建立共享 —— 一条命令做完，需要管理员权限（会弹 UAC）。
#
# 为什么需要提权：Windows 上创建 SMB 共享必须用提升的令牌（实测：普通身份下
# New-SmbShare 与 net share 都是 Access denied）。dsh 服务器是以普通用户身份运行的，
# 所以这件事只能由人点一次 UAC，服务器不能替你静默完成。
#
# 用法（把 <名字> 换成工作区名）：
#   Start-Process pwsh -Verb RunAs -ArgumentList '-NoExit','-File',"$env:USERPROFILE\.dsh\new-workspace.ps1",'-Names','<名字>'
#
# 一次建多个：把逗号隔开的名字作为 -Names 的单个值，如 '-Names','甲方资料,乙方合同'
#
# 幂等：目录或共享已存在时会复用并报告，不会重复创建、不会改动目录内容。
[CmdletBinding()]
param(
    # 工作区名字（共享名 = ws-<名字>）。可给多个。
    [Parameter(Position = 0)][string[]]$Names = @(),

    # 工作区根目录。默认与线上可见路径规则一致（C:\dsh-workspaces）。
    [string]$WorkspaceRoot = 'C:\dsh-workspaces',

    # 专用 SMB 账号（沿用现有共享账号，不新建）。
    [string]$SmbUser = 'dshtest',

    # 该账号密码。留空则本次随机生成并打印 —— 仅当账号不存在时才会用到。
    [string]$SmbPassword = '',

    # 只查看现状，不改任何东西：列出根目录下每个目录是否已有共享。
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    [x]  $m" -ForegroundColor Red; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Status) {
    Step "现状：$WorkspaceRoot"
    if (-not $elevated) { Warn '非管理员：只能读取共享列表，看不到别人创建的共享的完整权限信息' }
    if (-not (Test-Path -LiteralPath $WorkspaceRoot)) { Fail "根目录不存在: $WorkspaceRoot" }
    Get-ChildItem -LiteralPath $WorkspaceRoot -Directory | ForEach-Object {
        $name = "ws-$($_.Name)"
        $share = Get-SmbShare -Name $name -ErrorAction SilentlyContinue
        if ($share -and $share.Path -eq $_.FullName) {
            $access = (Get-SmbShareAccess -Name $name -ErrorAction SilentlyContinue | ForEach-Object { "$($_.AccountName)=$($_.AccessRight)" }) -join ', '
            Ok "$($_.Name)  ->  \\<server>\$name   访问=$access"
        }
        elseif ($share) {
            Warn "$($_.Name)  ->  共享名 $name 被 $($share.Path) 占用（冲突）"
        }
        else {
            Warn "$($_.Name)  ->  还没有共享（在 Web UI 里无法绑定到客户端）"
        }
    }
    Step '已配置的共享'
    Get-SmbShare | Where-Object { $_.Name -like 'ws-*' } | ForEach-Object { Ok "$($_.Name) -> $($_.Path)" }
    exit 0
}

if (-not $elevated) {
    Fail '需要管理员权限（创建 SMB 共享必须提权）。用 Start-Process -Verb RunAs 重新运行本脚本，见文件头的用法。'
}
if ($Names.Count -eq 0) {
    Fail '没有给出工作区名字。用法见文件头；或用 -Status 查看现状。'
}

$server = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1 -ExpandProperty IPAddress
Ok "服务器地址: $server"

# ── SMB 账号：沿用现有的，不新建 ───────────────────────────────────────────────
Step '1. 共享账号'
$account = Get-LocalUser -Name $SmbUser -ErrorAction SilentlyContinue
if ($account) {
    Ok "账号已存在: $SmbUser（未改动密码）"
}
else {
    if (-not $SmbPassword) {
        $body = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ })
        $SmbPassword = $body + 'aA1!'
    }
    $secure = ConvertTo-SecureString $SmbPassword -AsPlainText -Force
    New-LocalUser -Name $SmbUser -Password $secure -PasswordNeverExpires `
        -Description 'DSH 工作区 SMB 访问专用账号' -AccountNeverExpires | Out-Null
    Ok "已创建账号: $SmbUser"
    Write-Host "    密码: $SmbPassword" -ForegroundColor White
    Warn '请把这个密码记进客户端执行器的「工作区共享凭据」，它不会显示第二次。'
}

# ── 每个工作区：目录 + 共享 + NTFS ─────────────────────────────────────────────
Step '2. 工作区目录、共享与权限'
foreach ($raw in $Names) {
    $name = ($raw -replace '[\\/:*?"<>|]', '').Trim()
    if ($name.Length -eq 0) { Warn "跳过空名字"; continue }
    $path = Join-Path $WorkspaceRoot $name
    $share = "ws-$name"

    if (Test-Path -LiteralPath $path) { Ok "目录已存在: $path" }
    else {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Ok "已创建目录: $path"
    }
    $resolved = (Resolve-Path -LiteralPath $path).Path

    $existing = Get-SmbShare -Name $share -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.Path -ne $resolved) {
            Warn "共享名冲突: $share 已指向 $($existing.Path) —— 跳过，请手工决定用哪个名字"
            continue
        }
        Ok "共享已存在: $share"
    }
    else {
        New-SmbShare -Name $share -Path $resolved -ChangeAccess $SmbUser `
            -Description "DSH workspace '$name'" | Out-Null
        Ok "已创建共享: \\$server\$share -> $resolved"
    }

    $acl = (& icacls $resolved) -join "`n"
    if ($acl -match [regex]::Escape($SmbUser)) { Ok "NTFS 权限已含 $SmbUser" }
    else {
        & icacls $resolved /grant "${SmbUser}:(OI)(CI)M" /T | Out-Null
        Ok "已授予 NTFS Modify: $SmbUser"
    }
}

# ── 自检 ───────────────────────────────────────────────────────────────────────
Step '3. 自检'
foreach ($raw in $Names) {
    $name = ($raw -replace '[\\/:*?"<>|]', '').Trim()
    if ($name.Length -eq 0) { continue }
    $share = "ws-$name"
    $s = Get-SmbShare -Name $share -ErrorAction SilentlyContinue
    if (-not $s) { Warn "共享缺失: $share"; continue }
    $access = (Get-SmbShareAccess -Name $share | ForEach-Object { "$($_.AccountName)=$($_.AccessRight)" }) -join ', '
    Ok "$share  ->  \\$server\$share   访问=$access"
}
if (-not (Get-NetTCPConnection -LocalPort 445 -State Listen -ErrorAction SilentlyContinue)) {
    Warn '445 未监听：文件共享入站可能没开，客户端会连不上（见 setup-smb.ps1 第 4 段）'
}
else { Ok '445 正在监听' }

Write-Host ''
Write-Host '完成。接下来在 Web UI 里：' -ForegroundColor Cyan
Write-Host '  1) 设置 → 工作区 → 添加，路径填上面那个目录（例如 ' -NoNewline
Write-Host "$WorkspaceRoot\$($Names[0])" -NoNewline -ForegroundColor White
Write-Host '）'
Write-Host '  2) 需要哪个账号能用它，就在账号表单里勾上（授权与绑定是两件事）'
Write-Host '  3) 打开左侧文件树面板，点「本地模式」即绑到当前这台客户端'
Write-Host ''
Warn "共享是持久设置，不会自己消失。要撤销某一条：Remove-SmbShare -Name <共享名> -Force"
