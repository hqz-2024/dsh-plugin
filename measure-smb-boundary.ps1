<#
.SYNOPSIS
    DSH 客户端执行世界 — SMB 边界与性能基准（计划 §4.8 / P0-3）

.DESCRIPTION
    回答计划 P0-3 要的那组数据：**8–10MB 边界文件**在共享上用起来有没有痛感，以及
    打算直用共享的轻量负载（Office 那类"很多小文件 + 保存时改名替换 + 文件锁"）
    在共享上是不是成立。

    为什么要在**客户端**上跑：要测的是"用户在他的电脑上通过共享访问"这条路径，
    在服务器上跑本地路径只能得到磁盘速度，没有意义。脚本也可以对着本地目录跑，
    那正是用来做对照的基线（计划 §4.8：「SMB 往返延迟 vs 本机盘」）。

    测什么、以及为什么：

      顺序吞吐（1/5/8/10/12/25 MB）  写入时强制 Flush，否则量到的是本机缓存而不是网络
      小文件操作（200 × 4KB）        Office 打开一个文档会做几十次小操作，这才是它卡不卡的原因
      改名替换（temp → 覆盖目标）    Office/PS 保存就是"写临时文件再改名覆盖"，网络文件系统
                                     对这种操作的代价差别很大
      共享冲突语义                   独占打开时第二个句柄必须被拒（IOException）。这条不成立
                                     就意味着两个进程能同时改同一个文件 —— 那才是会损坏文件的
      会话事实                       SMB 方言 / 签名 / 加密（仅在 UNC 路径上有意义）

    脚本只在自己的子目录里建文件，跑完即删（-Keep 可保留）。

.PARAMETER Path
    要测的目录。客户端上填 UNC（\\<服务器>\ws-<工作区>），做基线时填本机目录。

.PARAMETER Keep
    保留测试文件，便于自己复核。默认删除。

.EXAMPLE
    # 在客户端机器上跑（这才是 P0-3 要的数据）
    .\measure-smb-boundary.ps1 -Path '\\192.168.28.239\ws-smbtest'

.EXAMPLE
    # 在服务器上对着本地盘跑，作为对照基线
    .\measure-smb-boundary.ps1 -Path 'C:\dsh-workspaces\smbtest'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$sizes = @(1, 5, 8, 10, 12, 25)

function Info($m) { Write-Host "    $m" }
function Head($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

if (-not (Test-Path -LiteralPath $Path)) { Write-Error "目录不存在：$Path"; exit 1 }
$isUnc = $Path.StartsWith('\\')
$work = Join-Path $Path ('_bench-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

Write-Host "DSH SMB 边界基准" -ForegroundColor White
Info "目标目录 : $Path"
Info "路径类型 : $(if ($isUnc) { 'UNC（客户端经共享访问）' } else { '本地（基线对照）' })"
Info "工作目录 : $work"
Info "PowerShell: $($PSVersionTable.PSVersion) on $([System.Environment]::Version)"
Info "时间     : $(Get-Date -Format o)"

try {
    # ── 会话事实（只在 UNC 上有意义）────────────────────────────────────────
    if ($isUnc) {
        Head 'SMB 会话'
        try {
            $server = ($Path -split '\\')[2]
            $conn = Get-SmbConnection -ServerName $server -ErrorAction Stop | Select-Object -First 1
            if ($conn) {
                Info "方言     : $($conn.Dialect)"
                Info "签名     : $($conn.Signed)"
                Info "加密     : $($conn.Encrypted)"
            } else { Info '（拿不到会话信息）' }
        } catch { Info "（拿不到会话信息：$($_.Exception.Message)）" }
    }

    # ── 顺序吞吐 ───────────────────────────────────────────────────────────
    Head '顺序吞吐（写入强制 Flush；读取可能命中缓存，看数量级即可）'
    Write-Host ('    {0,6}  {1,10}  {2,10}  {3,10}  {4,10}' -f 'MB', '写(s)', '读(s)', '写(MB/s)', '读(MB/s)')
    $rows = @()
    $buffer = New-Object byte[] (1MB)
    (New-Object Random 42).NextBytes($buffer)
    foreach ($mb in $sizes) {
        $file = Join-Path $work "size-$mb.bin"
        $fs = [System.IO.File]::Create($file)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        for ($i = 0; $i -lt $mb; $i++) { $fs.Write($buffer, 0, $buffer.Length) }
        $fs.Flush($true)                     # 推到共享，别只推到本机缓存
        $sw.Stop()
        $fs.Dispose()
        $writeS = $sw.Elapsed.TotalSeconds

        $fs = [System.IO.File]::OpenRead($file)
        $sink = New-Object byte[] (1MB)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($fs.Read($sink, 0, $sink.Length) -gt 0) { }
        $sw.Stop()
        $fs.Dispose()
        $readS = $sw.Elapsed.TotalSeconds

        $rows += [pscustomobject]@{ MB = $mb; WriteS = $writeS; ReadS = $readS; WriteMBs = $mb / $writeS; ReadMBs = $mb / $readS }
        Write-Host ('    {0,6}  {1,10:N2}  {2,10:N2}  {3,10:N1}  {4,10:N1}' -f $mb, $writeS, $readS, ($mb / $writeS), ($mb / $readS))
        Remove-Item -LiteralPath $file -Force
    }

    # ── 小文件操作（Office 的真实负载）────────────────────────────────────
    Head '小文件操作（200 × 4KB 建+删）—— Office/PS 打开文档就是这种负载'
    $small = New-Object byte[] 4096
    (New-Object Random 7).NextBytes($small)
    $n = 200
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt $n; $i++) {
        $f = Join-Path $work "small-$i.tmp"
        [System.IO.File]::WriteAllBytes($f, $small)
        [System.IO.File]::Delete($f)
    }
    $sw.Stop()
    $perOp = $sw.Elapsed.TotalMilliseconds / $n
    Info ("{0} 次建+删共 {1:N2} s，单次 {2:N1} ms，{3:N0} 次/秒" -f $n, $sw.Elapsed.TotalSeconds, $perOp, ($n / $sw.Elapsed.TotalSeconds))
    Info "$(if ($perOp -lt 15) { '单次开销可忽略' } elseif ($perOp -lt 60) { '偏慢，Office 打开文档会有可感的等待（几十次小操作叠加）' } else { '很慢，Office 直接在这种共享上工作会很痛苦' })"

    # ── 改名替换（Office 保存的动作）──────────────────────────────────────
    Head '改名替换（写临时文件 → 覆盖目标）—— Office/PS 保存就是这个动作'
    # 两种机制都要测，因为"保存"在不同程序里走的是不同的 Win32 调用，而它们在这条
    # 共享上的表现**不一样**：只测一种会得出一个过强或过弱的结论。
    #   1. File.Replace  → Win32 ReplaceFile，最严格的原子替换
    #   2. 改名覆盖      → MoveFileEx(MOVEFILE_REPLACE_EXISTING)
    $target = Join-Path $work 'replace-target.bin'
    $backup = Join-Path $work 'replace-backup.bin'
    $smallBytes = New-Object byte[] 4096
    (New-Object Random 11).NextBytes($smallBytes)
    $rounds = 20

    $replaceOk = 0; $replaceFail = 0; $replaceError = ''
    $moveOk = 0; $moveFail = 0; $moveError = ''; $moveVia = ''
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt $rounds; $i++) {
        [System.IO.File]::WriteAllBytes($target, $smallBytes)

        $src = Join-Path $work 'replace-src.bin'
        [System.IO.File]::WriteAllBytes($src, $smallBytes)
        try {
            # 备份参数不能传 $null：PowerShell 会把它编组成空字符串，.NET 报
            # "The path is empty" —— 那看起来和文件系统故障一模一样，只数异常
            # 次数会把它误判成"共享不支持原子替换"。
            [System.IO.File]::Replace($src, $target, $backup)
            $replaceOk++
        } catch {
            $replaceFail++; $replaceError = $_.Exception.Message
            Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
        }

        $src = Join-Path $work 'replace-src2.bin'
        [System.IO.File]::WriteAllBytes($src, $smallBytes)
        try {
            try { [System.IO.File]::Move($src, $target, $true); $moveVia = 'Move(overwrite)' }
            catch [System.Management.Automation.MethodException] {
                # Windows PowerShell 5.1 跑在 .NET Framework 上，没有带 overwrite 的
                # 重载；先删再移会短暂失去目标文件，但那是 5.1 上唯一基于改名的选项。
                [System.IO.File]::Delete($target)
                [System.IO.File]::Move($src, $target)
                $moveVia = 'Delete+Move'
            }
            $moveOk++
        } catch {
            $moveFail++; $moveError = $_.Exception.Message
            Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
        }
    }
    $sw.Stop()
    Info ("{0} 轮，共 {1:N2} s（单轮 {2:N1} ms）" -f $rounds, $sw.Elapsed.TotalSeconds, ($sw.Elapsed.TotalMilliseconds / $rounds))
    Info ("File.Replace（ReplaceFile）  ：成功 {0} / 失败 {1}{2}" -f $replaceOk, $replaceFail, $(if ($replaceFail) { "  ← $replaceError" } else { '' }))
    Info ("改名覆盖（$moveVia）：成功 {0} / 失败 {1}{2}" -f $moveOk, $moveFail, $(if ($moveFail) { "  ← $moveError" } else { '' }))
    if ($replaceFail -gt 0 -and $moveOk -gt 0) {
        Info '两种机制表现不同：最严格的原子替换在这条共享上不可用，改名覆盖可用。'
        Info '程序用哪一种取决于它自己，所以"能不能在共享上原地保存"没有统一答案 ——'
        Info '这正是 §2.6 要求重软件一律走本机暂存、而不是去逐个试的原因。'
    } elseif ($replaceOk -eq $rounds -and $moveOk -eq $rounds) {
        Info '两种改名替换机制都可用 —— 这条共享在保存语义上没有明显短板。'
    }

    # ── 共享冲突语义 ───────────────────────────────────────────────────────
    Head '共享冲突语义（独占打开时第二个句柄必须被拒）'
    $lockFile = Join-Path $work 'lock-probe.bin'
    [System.IO.File]::WriteAllBytes($lockFile, $small)
    $exclusive = $null
    try {
        $exclusive = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        try {
            $second = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $second.Dispose()
            Info '第二个句柄竟然成功了 —— 该共享不强制文件锁，两个进程能同时改同一个文件'
        } catch [System.IO.IOException] {
            Info "第二个句柄被拒（$($_.Exception.GetType().Name)）—— 文件锁在共享上生效"
        }
    } finally {
        if ($exclusive) { $exclusive.Dispose() }
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
    }

    # ── 结论 ───────────────────────────────────────────────────────────────
    Head '结论（给"10MB 阈值要不要下调"用）'
    $where = if ($isUnc) { '共享' } else { '本机盘' }
    $ten = $rows | Where-Object { $_.MB -eq 10 }
    Info ("10MB 文件：写 {0:N2} s、读 {1:N2} s" -f $ten.WriteS, $ten.ReadS)
    $worst = ($rows | Sort-Object ReadS -Descending | Select-Object -First 1)
    Info ("最慢一次读：{0}MB 用 {1:N2} s（{2:N1} MB/s）" -f $worst.MB, $worst.ReadS, $worst.ReadMBs)
    if ($ten.WriteS -lt 1.0) { Info "10MB 级文件在${where}上是一秒以内的事 —— 阈值保持 10MB 合理" }
    elseif ($ten.WriteS -lt 3.0) { Info "10MB 级文件在${where}上要 1–3 秒 —— 阈值保持，但超过 10MB 走暂存确实有必要" }
    else { Info "10MB 级文件在${where}上已超过 3 秒 —— 建议把阈值下调（改 local-staging skill 里的判定）" }
    if (-not $isUnc) { Info '注意：这是本机盘基线。阈值该不该下调要看**客户端经共享**那一份数据。' }
} finally {
    if ($Keep) { Info "`n保留测试文件：$work" }
    else { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue; Info "`n已清理测试目录" }
}
