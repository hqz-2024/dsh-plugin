# verify-upgrade.ps1 — post-cutover health check for the running dsh instance.
# Usage: pwsh -File verify-upgrade.ps1 [-Port 3080]
param([int]$Port = 3080)

$ErrorActionPreference = 'Continue'
$DshHome = Join-Path $env:USERPROFILE '.dsh'
$pass = 0
$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $script:total = $script:total + 1
  if ($ok) { $script:pass++ } else { $script:fail++ }
  '{0,-34} {1}  {2}' -f $name, $(if ($ok) { 'PASS' } else { 'FAIL' }), $detail
}

$owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
Check "port $Port listening" ([bool]$owner) ("pid=" + $owner)

$engine = ''
if ($owner) {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue).CommandLine
  if ($cmd -match '(?i)([A-Z]:\\[^"]*?(?:deepseek-harness|dsh-0\.\d+\.\d+))') { $engine = $Matches[1] }
}
# The launcher starts dsh with a relative apps\cli\lib\bin.js, so the command
# line carries no engine path; the launcher's DSH_DIR is the authoritative one.
if (-not $engine) {
  $launcher = Join-Path $DshHome 'start-dsh-lan.cmd'
  if (Test-Path $launcher) {
    $m = [regex]::Match((Get-Content $launcher -Raw), 'set "DSH_DIR=([^"]+)"')
    if ($m.Success) { $engine = $m.Groups[1].Value.TrimEnd('\') }
  }
}
Check 'engine checkout' ($engine -ne '') $engine
if ($engine -and (Test-Path (Join-Path $engine 'package.json'))) {
  $version = (Get-Content (Join-Path $engine 'package.json') -Raw | ConvertFrom-Json).version
  Check 'engine version = 0.2.1-rc.2' ($version -eq '0.2.1-rc.2') $version
}

# PowerShell 5.1 has no -SkipHttpErrorCheck; probe with curl.exe so the script
# behaves the same under powershell.exe and pwsh.
function Probe([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{}, [string]$Body = '') {
  $out = Join-Path $env:TEMP ('probe-' + [guid]::NewGuid().ToString('N') + '.txt')
  $curlArgs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', $Method, '--max-time', '12')
  foreach ($key in $Headers.Keys) { $curlArgs += @('-H', ($key + ': ' + $Headers[$key])) }
  if ($Body) { $curlArgs += @('-H', 'Content-Type: application/json', '--data', $Body) }
  $curlArgs += $Url
  $code = (& curl.exe @curlArgs) | Select-Object -Last 1
  $body = ''
  if (Test-Path $out) { $body = Get-Content $out -Raw -ErrorAction SilentlyContinue; Remove-Item $out -Force -ErrorAction SilentlyContinue }
  [pscustomobject]@{ StatusCode = [int]$code; Content = $body }
}
try {
  $me = Probe "http://127.0.0.1:$Port/auth/me"
  Check '/auth/me' ($me.StatusCode -eq 200) ("status=" + $me.StatusCode)
} catch { Check '/auth/me' $false $_.Exception.Message }

try {
  $html = Probe "http://127.0.0.1:$Port/" -Headers @{ Accept = 'text/html' }
  Check 'app shell' ($html.StatusCode -eq 200 -and $html.Content -match '<html') ("status=" + $html.StatusCode)
} catch { Check 'app shell' $false $_.Exception.Message }

$patch = Join-Path $DshHome 'profiles\web-client\cordis.patch.yml'
$token = ''
if (Test-Path $patch) { $token = [regex]::Match((Get-Content $patch -Raw), 'gw-[A-Za-z0-9\-]+').Value }
if ($token) {
  try {
    $models = Probe "http://127.0.0.1:$Port/llm/v1/models" -Headers @{ Authorization = "Bearer $token" }
    $ids = ([regex]::Matches($models.Content, '"id":"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }) -join ','
    Check '/llm/v1/models' ($models.StatusCode -eq 200) $ids
  } catch { Check '/llm/v1/models' $false $_.Exception.Message }
  try {
    $archive = Probe "http://127.0.0.1:$Port/archive/v1/sessions" -Method POST -Headers @{ Authorization = 'Bearer invalid' } -Body '{}'
    Check '/archive route mounted' ($archive.StatusCode -eq 401) ("status=" + $archive.StatusCode)
  } catch { Check '/archive route mounted' $false $_.Exception.Message }
}
try {
  $auth = Probe "http://127.0.0.1:$Port/client-auth" -Method POST -Body '{}'
  Check '/client-auth route mounted' ($auth.StatusCode -eq 401) ("status=" + $auth.StatusCode)
} catch { Check '/client-auth route mounted' $false $_.Exception.Message }

# Startup log: newest of the two engines' error logs.
$logs = Get-ChildItem (Join-Path $DshHome 'live-*.err.log') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($logs) {
  $text = Get-Content $logs[0].FullName -Raw
  Check 'startup log clean' ($text -notmatch 'failed to activate|Cannot find package|incompatible with dsh|ERR_MODULE_NOT_FOUND|EADDRINUSE') $logs[0].Name
  Check 'engine patch applied' ($text -match 'engine patch: legacy-turn-restart applied') $logs[0].Name
}

''
'{0} passed, {1} failed' -f $pass, $fail
if ($fail -gt 0) { exit 1 }
