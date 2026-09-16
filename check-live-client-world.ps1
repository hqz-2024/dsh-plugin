# check-live-client-world.ps1 — 切换 profile 之后，确认客户端执行世界的各个面都对。
#
# 为什么要有它：客户端世界挂在真实组合上时，最容易出问题的不是"机制"，而是**三道
# 门禁与新前缀的相互作用** —— 门禁拦了 /executor，executor 就连不上；前缀放行了但
# 处理器没自校验，就是一条无鉴权通道。这些症状在浏览器里表现为"一直连接中"或
# "某个功能静默不工作"，很难归因。这个脚本逐条把"期望 / 实际"摆出来。
#
# 只读：只发 GET / 一次 WebSocket 握手，不改任何状态。
#
#   .\check-live-client-world.ps1                      # 线上实例（127.0.0.1:3080）
#   .\check-live-client-world.ps1 -Port 3086           # 先拿旁路实例试
#   .\check-live-client-world.ps1 -Via https://192.168.28.239:8443   # 走 caddy（含 TLS）
#
# 判据（每一项都必须"符合期望"）：
#   1. /api 匿名              → 403，且 body 里**没有**处理器文本（是门禁答的）
#   2. /client-auth/state 匿名 → 401，且 body 里**有**处理器文本（前缀确实放行）
#   3. /client-relay/<错密钥>  → 403 unknown relay secret（处理器答的 → 又一条前缀放行）
#   4. /client-relay/<对密钥>  → 502 no executor is connected（密钥被识别、账号映射对）
#   5. /executor 错 token      → WebSocket close 4001
#   2 与 5 合起来才是结论：路由存在 **且** 无凭据进不来。
#
# 第 4 项需要一个真密钥。默认从 profiles/web-client/cordis.patch.yml 的 relayTokens
# 里取第一个；取不到就跳过（不猜）。

[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$Via = '',
  [string]$RelaySecret = '',
  # 不能叫 $Home：那是 PowerShell 的只读自动变量，赋值会直接报错。
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Continue'
$script:failures = 0

function Section($text) { Write-Host ''; Write-Host "── $text" -ForegroundColor Cyan }

function Report($name, $expected, $actual, $ok) {
  $mark = if ($ok) { 'OK  ' } else { 'FAIL'; $script:failures += 1 }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}" -f $mark, $name) -ForegroundColor $color
  Write-Host ("        期望: {0}" -f $expected)
  Write-Host ("        实际: {0}" -f $actual)
}

# 门禁的 403 是通用文案；处理器会带上自己的错误文本。这条区分是本项目反复踩到的。
function Invoke-Probe($url, $skipCert) {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 10 -SkipCertificateCheck:$skipCert -ErrorAction Stop
    return @{ status = [int]$r.StatusCode; body = [string]$r.Content }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode.value__ }
    return @{ status = $status; body = [string]$_.ErrorDetails.Message }
  }
}

$base = if ($Via) { $Via.TrimEnd('/') } else { "http://127.0.0.1:$Port" }
$skipCert = $Via -like 'https://*'

Write-Host "检查目标: $base" -ForegroundColor Yellow
if ($Via) { Write-Host "（走反代：TLS 证书不做校验 —— 这里测的是门禁与路由，不是证书链）" }

Section '1. 会话门禁还在（匿名访问 /api 应当被拦）'
$a = Invoke-Probe "$base/api" $skipCert
Report '/api 匿名' '403 且 body 无处理器文本（门禁自己答的）' ("{0} {1}" -f $a.status, $a.body) `
  ($a.status -eq 403 -and $a.body -notmatch 'executor token|relay secret')

Section '2. /client-auth 已被门禁放行、且处理器自己校验凭据'
$b = Invoke-Probe "$base/client-auth/state" $skipCert
Report '/client-auth/state 匿名' '401 且 body 含处理器文本 "a valid executor token is required"' ("{0} {1}" -f $b.status, $b.body) `
  ($b.status -eq 401 -and $b.body -match 'executor token')
if ($b.status -eq 404 -or ($b.status -eq 200 -and $b.body -match '<!doctype html>')) {
  Write-Host '        提示：这条路由不存在 —— 当前实例还没挂客户端世界（profile 仍是 web）。' -ForegroundColor Yellow
  Write-Host '        未挂载时实际返回的是 200 + index.html（前端兜底路由），不是 404；只看状态码会误判。' -ForegroundColor DarkGray
}

Section '3. /client-relay 的密钥校验生效'
$c = Invoke-Probe "$base/client-relay/definitely-not-the-secret/3845/x" $skipCert
Report '错密钥' '403 unknown relay secret（处理器答的）' ("{0} {1}" -f $c.status, $c.body) `
  ($c.status -eq 403 -and $c.body -match 'unknown relay secret')

Section '4. 真密钥被识别（对端账号映射正确）'
if (-not $RelaySecret) {
  $patch = Join-Path $DshHome 'profiles\web-client\cordis.patch.yml'
  if (Test-Path $patch) {
    # 只从 relayTokens 那一块里取：同一份 patch 里 local-bridge 的 sidecar token
    # 也是 48 位十六进制，按"第一个像密钥的行"抓会抓到它（本轮踩到过）。
    $lines = Get-Content $patch
    $at = ($lines | Select-String -Pattern '^\s*relayTokens:\s*$' | Select-Object -First 1).LineNumber
    if ($at) {
      for ($i = $at; $i -lt [Math]::Min($at + 8, $lines.Count); $i++) {
        if ($lines[$i] -match '^\s+([0-9a-f]{16,}):\s+\S+\s*$') { $RelaySecret = $Matches[1]; break }
        if ($lines[$i] -match '^[a-z-]' ) { break }
      }
    }
    if ($RelaySecret) { Write-Host '  （密钥取自 patch 的 relayTokens 块）' -ForegroundColor DarkGray }
  }
}
if (-not $RelaySecret) {
  Write-Host '  [SKIP] 没有密钥可用（-RelaySecret 没给，patch 里也没读到）' -ForegroundColor Yellow
} else {
  $d = Invoke-Probe "$base/client-relay/$RelaySecret/3845/x" $skipCert
  Report '真密钥' '502 no executor is connected for <账号>（密钥被识别）' ("{0} {1}" -f $d.status, $d.body) `
    ($d.status -eq 502 -and $d.body -match 'no executor is connected')
}

Section '5. /executor 的握手要凭据（无 token 必须被 4001 关掉）'
$ws = Join-Path $env:TEMP 'dsh-executor-handshake-check.mjs'
@'
const [url, via] = process.argv.slice(2)
if (via) process.env.NODE_EXTRA_CA_CERTS = via
const ws = new WebSocket(url)
let lastError = ''
const timer = setTimeout(() => { console.log(`no close in 8s (last error: ${lastError || 'none'})`); process.exit(0) }, 8000)
ws.addEventListener('close', (e) => { clearTimeout(timer); console.log(`close ${e.code} ${e.reason || ''}`.trim()); process.exit(0) })
// 记下来但不退出：非 101 的响应会先给 error，能不能拿到 close 取决于实现，
// 两种情况都要如实说出来（只报"超时"会让人以为是网络问题）。
ws.addEventListener('error', (e) => { lastError = String(e?.message ?? e?.error?.message ?? 'error') })
'@ | Set-Content -Path $ws -Encoding utf8
$wsUrl = ($base -replace '^http://', 'ws://' -replace '^https://', 'wss://') + '/executor?token=not-a-real-token'
$out = & node $ws $wsUrl 2>&1 | Out-String
Report '/executor 错 token' 'close 4001（握手成功但认证失败）' $out.Trim() ($out -match 'close 4001')
if ($out -notmatch 'close 4001') {
  Write-Host '        提示：拿不到 4001 通常意味着这条路由不在这个实例上（没挂客户端世界），' -ForegroundColor DarkGray
  Write-Host '        或反向代理没有转发 WebSocket 升级 —— 两者都不该出现，先查 profile 再查反代。' -ForegroundColor DarkGray
}

Section '结论'
if ($script:failures -eq 0) {
  Write-Host '  全部符合期望：门禁在、三条客户端前缀确实放行、处理器各自校验凭据。' -ForegroundColor Green
} else {
  Write-Host ("  有 {0} 项不符期望 —— 先看上面每一项的 期望/实际 两行。" -f $script:failures) -ForegroundColor Red
  Write-Host '  先看第 2 项：它为 200+HTML 或 404，就说明这个实例还没挂客户端世界（profile 仍是 web）。' -ForegroundColor Yellow
}
exit $script:failures
