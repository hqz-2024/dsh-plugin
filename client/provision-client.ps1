<#
.SYNOPSIS
给一台客户端电脑写本地模式与服务器模式需要的东西：模型端点、网关凭据、桌面 profile 的补丁层，
以及桌面应用该连哪个部署（desktop-client.json）。

.DESCRIPTION
本地模式在本机跑 agent 循环，模型请求打到部署的模型网关 —— 所以客户端需要知道
"网关在哪、用哪个 token、网关开放哪些模型"，但**不需要也不能有**真 AI key。
这三件都是部署的事实，装不进桌面应用的二进制里，只能落到这台机器的 $DSH_HOME。

服务器模式是同一个窗口加载部署自己的 Web UI，客户端只需要知道部署地址 ——
桌面应用把它读在 %APPDATA% 下的 desktop-client.json 里（用户文件优先于安装包里
烘进去的默认值），所以本脚本顺手把它也写好：一条命令配好两种模式。

写之前先看一眼：-WhatIfOnly 只打印将要写入的内容，不碰磁盘。

.PARAMETER GatewayOrigin
部署的对外地址，例如 https://192.168.28.239:8443。模型路径是 <origin>/llm/v1。

.PARAMETER GatewayToken
管理台签发的网关 token。它属于这台机器，泄漏的后果是别人用部署的额度。

.PARAMETER HomeDir
目标 $DSH_HOME；省略时用 %USERPROFILE%\.dsh（桌面应用默认读的那个）。

.PARAMETER Models
网关开放给客户端的模型 id；默认与 dsh-llm-gateway-local 的清单一致。

.PARAMETER ArchiveToken
归档 token；给了就写进 .credentials.yaml，本地会话归档（export-session.mjs）会用它。
不给就只写网关凭据，归档功能在这台机器上不可用。

.PARAMETER ArchiveOrigin
归档端的部署地址；省略时用 GatewayOrigin。归档端与模型网关挂在同一个部署上。

.PARAMETER DesktopServerOrigin
服务器模式要连的部署地址；省略时用 GatewayOrigin（同一个部署）。

.PARAMETER DesktopLabel
服务器模式窗口标题与徽标上显示的名字，例如 "HQZ 局域网"。

.PARAMETER DesktopGatewayCa
部署 TLS 终结器的**根证书**（PEM 文件路径），例如 caddy 的
%APPDATA%\Caddy\pki\authorities\local\root.crt。Node 不读 Windows 证书库，
所以本地 Host（真正发模型请求的那个进程）必须有这个根证书才肯和部署握手 ——
桌面应用从安装包里烘的根证书或这个文件里取一个用；不带根证书的安装包就用这个。
要根证书而不是叶子证书：终结器换叶子证书时根证书不变。

.PARAMETER DesktopUserDataDir
桌面应用的浏览器数据目录；省略时用 %APPDATA%\@deepseek-ai\dsh-desktop
（安装包的清单里没有 productName，所以应用名就是包名）。

.PARAMETER SkipDesktopServer
不动 desktop-client.json —— 例如安装包里已经烘好了别的地址，不想让这台机器改。

.PARAMETER WhatIfOnly
只打印将写入的文件内容。

.EXAMPLE
.\provision-client.ps1 -GatewayOrigin 'https://192.168.28.239:8443' -GatewayToken 'xxx' -WhatIfOnly

.EXAMPLE
.\provision-client.ps1 -GatewayOrigin 'https://192.168.28.239:8443' -GatewayToken 'xxx' `
	-DesktopGatewayCa "$env:APPDATA\Caddy\pki\authorities\local\root.crt"
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$GatewayOrigin,
	[Parameter(Mandatory = $true)][string]$GatewayToken,
	[string]$HomeDir = (Join-Path $env:USERPROFILE '.dsh'),
	[string[]]$Models = @('deepseek-v4-flash', 'deepseek-v4-pro'),
	[string]$ArchiveToken = '',
	[string]$ArchiveOrigin = '',
	[string]$DesktopServerOrigin = '',
	[string]$DesktopLabel = '',
	[string]$DesktopGatewayCa = '',
	[string]$DesktopUserDataDir = (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'),
	[switch]$SkipDesktopServer,
	[switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 没有 -Encoding utf8NoBOM，而客户端机器上很可能就是它。用 .NET 写，
# 两个版本行为一致：UTF-8、不带 BOM（带 BOM 的 YAML/JSON 会让解析器读到多余字符）。
function Write-TextFile([string]$Path, [string]$Content) {
	[System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# 端点必须是 origin：带路径的 baseURL 会让适配器拼出 /llm/v1/v1/chat/completions。
# 桌面应用读 desktop-client.json 用的是同一套规则，所以这里就按同一套校验 ——
# 配错了要在这台机器上立刻报出来，而不是等应用启动时弹一个原生错误框。
function Resolve-Origin([string]$Value, [string]$Name) {
	$parsed = $null
	if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) { throw "$Name 不是 URL：$Value" }
	if ($parsed.Scheme -ne 'https') { throw "$Name 必须是 https（桌面应用拒绝 http）：$Value" }
	if ($parsed.AbsolutePath -ne '/' -or $parsed.Query -ne '' -or $parsed.Fragment -ne '') {
		throw "$Name 必须是 origin（不带路径/查询/片段），收到：$Value"
	}
	if ($parsed.UserInfo -ne '') { throw "$Name 不能带凭据：$Value" }
	return $parsed.GetLeftPart([UriPartial]::Authority) -replace '^([a-z]+://)', '$1'
}

$origin = Resolve-Origin $GatewayOrigin 'GatewayOrigin'
if ($GatewayToken.Trim() -eq '') { throw 'GatewayToken 不能为空' }
if ($Models.Count -eq 0) { throw 'Models 不能为空' }

$desktopOrigin = $origin
if ($DesktopServerOrigin.Trim() -ne '') { $desktopOrigin = Resolve-Origin $DesktopServerOrigin 'DesktopServerOrigin' }
if (-not $SkipDesktopServer -and $DesktopUserDataDir.Trim() -eq '') {
	throw 'DesktopUserDataDir 不能为空（或改用 -SkipDesktopServer）'
}

# 适配器按 protocol 拼请求路径：chat-completions 会追加 /chat/completions，
# 而网关的服务面是 <origin>/llm/v1/chat/completions。
$baseUrl = "$origin/llm/v1"
$modelLines = ($Models | ForEach-Object { "    - id: $_" }) -join "`n"

$settings = @"
# 客户端本机设置。由 client/provision-client.ps1 写入；模型面是部署的事实。
# 本地模式的 agent 循环在本机，模型请求打到部署网关，这里没有任何 AI key。
llm-deepseek:
  protocol: chat-completions
  baseURL: $baseUrl
  apiKeyEnv: HQZ_GATEWAY_TOKEN
  models:
$modelLines
agent-default-model:
  provider: deepseek-official
  model: $($Models[0])
permission:
  defaultPreset: danger-full-access
"@

$refs = [ordered]@{ HQZ_GATEWAY_TOKEN = $GatewayToken }
if ($ArchiveToken.Trim() -ne '') { $refs['HQZ_ARCHIVE_TOKEN'] = $ArchiveToken.Trim() }
$credentialLines = ($refs.GetEnumerator() | ForEach-Object { "  $($_.Key): $($_.Value)" }) -join "`n"
$credentials = @"
# 客户端持有的凭据：部署网关的 token（模型），以及归档 token（会话回传）。
# 真 AI key 不进客户端 —— 这两个 token 泄漏的后果是别人用部署的额度，不是拿到 key。
# version 是必需的：凭据文档有版本，缺了就按 pre-release 的扁平布局读、直接报错。
version: 1
refs:
$credentialLines
"@

$patch = @"
# 桌面 profile 的补丁层：应用每次启动都会读它，且不会覆盖已存在的文件。
# 本地模式默认不需要额外行 —— 模型面在 settings.yaml 里。
[]
"@

# 归档端与模型网关挂在同一个部署上，所以默认同源；单独给就把归档指向别处。
$archive = $ArchiveOrigin.Trim()
if ($archive -eq '') { $archive = $origin }
$archiveConfig = @"
{
  "origin": "$archive",
  "endpoint": "$archive/archive/v1/sessions"
}
"@

$targets = [ordered]@{
	(Join-Path $HomeDir 'settings.yaml') = $settings
	(Join-Path $HomeDir '.credentials.yaml') = $credentials
	(Join-Path $HomeDir 'archive.json') = $archiveConfig
	(Join-Path $HomeDir 'profiles\desktop\cordis.patch.yml') = $patch
}

# 部署的根证书。桌面应用启动时读 $DSH_HOME\profiles\desktop\gateway-ca.crt 并把它
# 作为 NODE_EXTRA_CA_CERTS 交给本地 Host —— 装出来的客户端不带根证书时（比如
# DSH_DESKTOP_GATEWAY=none 的构建），信任就由这个文件提供。
# 用 .NET 读、不带 BOM 写：证书文件里多一个 BOM，Node 就解析不出第一张证书。
if ($DesktopGatewayCa.Trim() -ne '') {
	$caPath = $DesktopGatewayCa.Trim()
	if (-not (Test-Path -LiteralPath $caPath -PathType Leaf)) { throw "DesktopGatewayCa 不是文件：$caPath" }
	$caText = [System.IO.File]::ReadAllText($caPath)
	if ($caText -notmatch '-----BEGIN CERTIFICATE-----' -or $caText -notmatch '-----END CERTIFICATE-----') {
		throw "DesktopGatewayCa 不是 PEM 证书：$caPath"
	}
	$targets[(Join-Path $HomeDir 'profiles\desktop\gateway-ca.crt')] = ($caText -replace "`r`n", "`n").TrimEnd() + "`n"
}

# 服务器模式的部署地址。桌面应用按 环境变量 → 这个文件 → 安装包里的默认值 取，
# 所以写在这里就等于替这台机器点定一个部署；安装包里烘过的默认值仍然管别的机器。
if (-not $SkipDesktopServer) {
	$serverEntry = [ordered]@{ origin = $desktopOrigin }
	if ($DesktopLabel.Trim() -ne '') { $serverEntry['label'] = $DesktopLabel.Trim() }
	$serverBlock = @{ server = $serverEntry } | ConvertTo-Json -Depth 4
	$targets[(Join-Path $DesktopUserDataDir 'desktop-client.json')] = "$serverBlock`n"
}

if ($WhatIfOnly) {
	foreach ($entry in $targets.GetEnumerator()) {
		Write-Host "=== $($entry.Key) ===" -ForegroundColor Cyan
		Write-Host $entry.Value
	}
	return
}

$backedUp = @('settings.yaml', 'desktop-client.json')
foreach ($entry in $targets.GetEnumerator()) {
	$path = $entry.Key
	$directory = Split-Path -Parent $path
	if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
	# 覆盖会丢掉用户在这台机器上的其他设置（或手工钉过的证书指纹）；先备份一次。
	if ((Test-Path $path) -and ($backedUp -contains (Split-Path -Leaf $path))) {
		$backup = "$path.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
		Copy-Item $path $backup
		Write-Host "已备份原文件：$backup"
	}
	Write-TextFile $path $entry.Value
	Write-Host "已写入 $path"
}

Write-Host ''
Write-Host '完成。桌面应用启动后：' -ForegroundColor Green
Write-Host "  本地模式：模型来自 $baseUrl（网关），本机没有 AI key。"
if ($DesktopGatewayCa.Trim() -ne '') {
	Write-Host '  证书：部署根证书已写入 profiles\desktop\gateway-ca.crt；本地 Host 会带着它启动。'
} else {
	Write-Host '  证书：未给 -DesktopGatewayCa；应用只用安装包里烘的根证书（没有就握手失败）。' -ForegroundColor Yellow
}
if ($SkipDesktopServer) {
	Write-Host '  服务器模式：未配置（-SkipDesktopServer）；应用用安装包里烘进去的默认值。'
} else {
	Write-Host "  服务器模式：连 $desktopOrigin（菜单「模式 → 服务器模式」，第一次要登录）。"
}
