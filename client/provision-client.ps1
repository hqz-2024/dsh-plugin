<#
.SYNOPSIS
给一台客户端电脑写本地模式需要的三样东西：模型端点、网关凭据、桌面 profile 的补丁层。

.DESCRIPTION
本地模式在本机跑 agent 循环，模型请求打到部署的模型网关 —— 所以客户端需要知道
"网关在哪、用哪个 token、网关开放哪些模型"，但**不需要也不能有**真 AI key。
这三件都是部署的事实，装不进桌面应用的二进制里，只能落到这台机器的 $DSH_HOME。

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

.PARAMETER WhatIfOnly
只打印将写入的文件内容。

.EXAMPLE
.\provision-client.ps1 -GatewayOrigin 'https://192.168.28.239:8443' -GatewayToken 'xxx' -WhatIfOnly
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$GatewayOrigin,
	[Parameter(Mandatory = $true)][string]$GatewayToken,
	[string]$HomeDir = (Join-Path $env:USERPROFILE '.dsh'),
	[string[]]$Models = @('deepseek-v4-flash', 'deepseek-v4-pro'),
	[string]$ArchiveToken = '',
	[string]$ArchiveOrigin = '',
	[switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# 端点必须是 origin：带路径的 baseURL 会让适配器拼出 /llm/v1/v1/chat/completions。
$parsed = $null
if (-not [uri]::TryCreate($GatewayOrigin, [UriKind]::Absolute, [ref]$parsed)) {
	throw "GatewayOrigin 不是 URL：$GatewayOrigin"
}
if ($parsed.AbsolutePath -ne '/' -or $parsed.Query -ne '' -or $parsed.Fragment -ne '') {
	throw "GatewayOrigin 必须是 origin（不带路径/查询/片段），收到：$GatewayOrigin"
}
if ($parsed.UserInfo -ne '') { throw "GatewayOrigin 不能带凭据：$GatewayOrigin" }
$origin = $parsed.GetLeftPart([UriPartial]::Authority) -replace '^([a-z]+://)', '$1'
if ($GatewayToken.Trim() -eq '') { throw 'GatewayToken 不能为空' }
if ($Models.Count -eq 0) { throw 'Models 不能为空' }

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

if ($WhatIfOnly) {
	foreach ($entry in $targets.GetEnumerator()) {
		Write-Host "=== $($entry.Key) ===" -ForegroundColor Cyan
		Write-Host $entry.Value
	}
	return
}

foreach ($entry in $targets.GetEnumerator()) {
	$path = $entry.Key
	$directory = Split-Path -Parent $path
	if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
	# 覆盖 settings.yaml 会丢掉用户在这台机器上的其他设置；先备份一次。
	if ((Test-Path $path) -and (Split-Path -Leaf $path) -eq 'settings.yaml') {
		$backup = "$path.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
		Copy-Item $path $backup
		Write-Host "已备份原设置：$backup"
	}
	Set-Content -Path $path -Value $entry.Value -Encoding utf8NoBOM
	Write-Host "已写入 $path"
}

Write-Host ''
Write-Host "完成。启动桌面应用后：本地模式的模型来自 $baseUrl（网关），本机没有 AI key。" -ForegroundColor Green
