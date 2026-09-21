<#
.SYNOPSIS
把一个 profile 变成"客户端可用的部署"：开通模型网关与会话归档端，并放行它们的前缀。

.DESCRIPTION
两件功能都是"三处齐全"才挂得上（少了任何一处都**不一定报错**，只是静默不生效）：

  1. profile 的 package.json —— 依赖里加 link:，bundles 里列出来；
  2. profile 的 cordis.patch.yml —— 用完整 config 打开那一行（补丁是**整体替换**该行 config）；
  3. 门禁行的 publicPrefixes —— 客户端拿的是 token 不是会话 cookie，不放行就永远 403。

这三处都由本脚本一次做完，且**幂等**：重复跑只补缺口，不会写第二遍。

默认只打印将要做的改动（-WhatIf 是默认行为）；要真写必须显式给 -Apply。

注意：目标 profile 若是 patchReload: live（线上 web-client 就是），**改完立刻生效**，
不需要重启 —— 但这也意味着改动直接落在用户正在用的实例上。

.PARAMETER Profile
目标 profile 名（$DSH_HOME/profiles/<name>）。

.PARAMETER Features
要开通的功能，默认两个都要：llm-gateway（客户端本地模式的模型）、archive（会话归档）。

.PARAMETER GatewayToken
模型网关 token；不给就随机生成一个并打印出来。

.PARAMETER ArchiveToken
归档 token；不给就随机生成一个并打印出来。

.PARAMETER VaultDir
归档要写入的 Obsidian 库目录，默认 C:\Users\<用户>\obsidian笔记。

.PARAMETER Apply
真的写入。不给就只打印。

.PARAMETER DshHome
部署数据目录，默认 %USERPROFILE%\.dsh。
#>
[CmdletBinding()]
param(
	[string]$Profile = 'web-client',
	[ValidateSet('llm-gateway', 'archive')][string[]]$Features = @('llm-gateway', 'archive'),
	[string]$GatewayToken = '',
	[string]$ArchiveToken = '',
	[string]$VaultDir = (Join-Path $env:USERPROFILE 'obsidian笔记'),
	[switch]$Apply,
	[string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'

# 读文件一律显式按 UTF-8：Windows PowerShell 5.1 的 Get-Content 对没有 BOM 的文件
# 用系统代码页解码，中文注释会变成乱码 —— 而乱码会让 3 字节的汉字与后一个字节配对，
# 行结构跟着错位（连 publicPrefixes: 这种纯 ASCII 行都可能被并进上一行）。
function Read-Utf8Text([string]$Path) {
	return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-Utf8Lines([string]$Path) {
	return [System.IO.File]::ReadAllLines($Path, (New-Object System.Text.UTF8Encoding($false)))
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
foreach ($path in @($manifestPath, $patchPath)) {
	if (-not (Test-Path $path)) { throw "找不到 $path（profile '$Profile' 不存在？）" }
}

$wantGateway = $Features -contains 'llm-gateway'
$wantArchive = $Features -contains 'archive'
$changes = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
# 只有 package.json 真被改过才算"manifest 变了"：修一条 junction 也在 $changes 里，
# 但它不该让脚本去重写那两个文件、在 profile 目录里留一堆内容相同的备份。
$manifestEdits = 0

function New-Token([string]$label) {
	# 32 字节 base64url，够长且不带需要转义的字符。
	$bytes = New-Object byte[] 32
	[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
	return "$label-" + [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

<#
	取出本脚本上次写进这一行的 token。

	幂等的前提是**不重新发明凭据**：已经发到客户端手里的 token 一旦被换掉，
	那些机器下一次上传/请求就是 401，而且报错在客户端，不在这里。
	所以只有在命令行显式给了 token、或这一行还没有 token 时，才生成新的。
#>
function Get-ExistingToken([System.Collections.Generic.List[string]]$source, [string]$rowId) {
	$start = -1
	for ($i = 0; $i -lt $source.Count; $i++) { if ($source[$i] -match "^- id:\s*$([regex]::Escape($rowId))\s*$") { $start = $i; break } }
	if ($start -lt 0) { return '' }
	for ($i = $start + 1; $i -lt $source.Count; $i++) {
		if ($source[$i] -match '^- id:') { break }
		if ($source[$i] -match '^\s+tokens:\s*$') {
			for ($j = $i + 1; $j -lt $source.Count; $j++) {
				if ($source[$j] -match '^\s+(\S+):\s*\S*\s*$') { return $Matches[1] }
				break
			}
		}
	}
	return ''
}

$lines = [System.Collections.Generic.List[string]](Read-Utf8Lines $patchPath)

$existingGatewayToken = if ($wantGateway) { Get-ExistingToken $lines 'llm-gateway' } else { '' }
$existingArchiveToken = if ($wantArchive) { Get-ExistingToken $lines 'archive' } else { '' }
if ($wantGateway -and $GatewayToken.Trim() -eq '') {
	$GatewayToken = if ($existingGatewayToken -ne '') { $existingGatewayToken } else { New-Token 'gw' }
}
if ($wantArchive -and $ArchiveToken.Trim() -eq '') {
	$ArchiveToken = if ($existingArchiveToken -ne '') { $existingArchiveToken } else { New-Token 'ar' }
}

# ── 1. package.json：依赖 + bundles ──────────────────────────────────────────

$manifest = Read-Utf8Text $manifestPath | ConvertFrom-Json
if ($null -eq $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @($manifest.dsh.profile.bundles)
$dependencies = $manifest.dependencies

foreach ($feature in @(@{ id = 'llm-gateway'; package = 'dsh-llm-gateway-local' }, @{ id = 'archive'; package = 'dsh-archive-local' })) {
	if ($feature.id -eq 'llm-gateway' -and -not $wantGateway) { continue }
	if ($feature.id -eq 'archive' -and -not $wantArchive) { continue }
	$package = $feature.package
	if ($dependencies.PSObject.Properties.Name -notcontains $package) {
		$dependencies | Add-Member -NotePropertyName $package -NotePropertyValue "link:../../plugins/$package" -Force
		$changes.Add("package.json: dependencies 加 $package = link:../../plugins/$package")
		$manifestEdits++
	}
	if ($bundles -notcontains $package) {
		$bundles += $package
		$changes.Add("package.json: bundles 加 $package")
		$manifestEdits++
	}
}
$manifest.dsh.profile.bundles = $bundles

# ── 2. cordis.patch.yml：门禁前缀 + 两行配置 ─────────────────────────────────

function Add-PublicPrefix([string]$prefix) {
	$start = -1
	for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*publicPrefixes:\s*$') { $start = $i; break } }
	if ($start -lt 0) { throw "profile patch 里没有 publicPrefixes：本脚本不猜门禁配置长什么样，请手工加 $prefix" }
	$indent = $null
	$last = $start
	for ($i = $start + 1; $i -lt $lines.Count; $i++) {
		if ($lines[$i] -match '^(\s*)-\s*(\S+)\s*$') {
			if ($null -eq $indent) { $indent = $Matches[1] }
			if ($Matches[2] -eq $prefix) { return }   # 已经有了
			$last = $i
			continue
		}
		break
	}
	if ($null -eq $indent) { throw "publicPrefixes 下面一条都没有：请手工加 $prefix" }
	$lines.Insert($last + 1, "$indent- $prefix")
	$changes.Add("cordis.patch.yml: publicPrefixes 加 $prefix")
}

if ($wantGateway) { Add-PublicPrefix '/llm' }
if ($wantArchive) { Add-PublicPrefix '/archive' }

$marker = '# ── hqz-dsh 客户端功能（enable-client-features.ps1 管理，删除本行以下即可撤销）──'
$existing = $lines.IndexOf($marker)
# 重新装进一个可变的 List：GetRange 返回的是定长包装，RemoveAt 会抛"集合大小固定"。
$head = [System.Collections.Generic.List[string]]::new()
$keep = if ($existing -ge 0) { $existing } else { $lines.Count }
for ($i = 0; $i -lt $keep; $i++) { $head.Add($lines[$i]) }
while ($head.Count -gt 0 -and $head[$head.Count - 1].Trim() -eq '') { $head.RemoveAt($head.Count - 1) }
$block = [System.Collections.Generic.List[string]]::new()
$block.Add('')
$block.Add($marker)

if ($wantGateway) {
	$block.Add('- id: llm-gateway')
	$block.Add('  disabled: false')
	$block.Add('  config:')
	$block.Add("    path: '/llm'")
	$block.Add("    upstream: 'https://api.deepseek.com'")
	$block.Add("    apiKeyEnv: 'DEEPSEEK_API_KEY'")
	$block.Add('    models:')
	$block.Add('      - deepseek-v4-flash')
	$block.Add('      - deepseek-v4-pro')
	$block.Add('    tokens:')
	$block.Add("      ${GatewayToken}: admin")
	$block.Add('    maxConcurrentPerAccount: 4')
	$block.Add('    dailyTokenLimit: 0')
	$block.Add("    usagePath: !!js dshHomePath('profiles/$Profile/llm-gateway-usage.jsonl')")
}
if ($wantArchive) {
	$block.Add('- id: archive')
	$block.Add('  disabled: false')
	$block.Add('  config:')
	$block.Add("    path: '/archive'")
	$block.Add("    vaultDir: '$VaultDir'")
	$block.Add("    sessionDir: '会话记录'")
	$block.Add("    indexFile: '会话记录索引.md'")
	$block.Add("    storeDir: !!js dshHomePath('profiles/$Profile/archive-raw')")
	$block.Add("    provider: 'deepseek-official'")
	$block.Add("    model: 'deepseek-v4-flash'")
	$block.Add('    tokens:')
	$block.Add("      ${ArchiveToken}: admin")
	$block.Add("    logPath: !!js dshHomePath('profiles/$Profile/archive-usage.jsonl')")
}

$next = ($head + $block) -join "`n"
$next += "`n"
$current = Read-Utf8Text $patchPath
$patchChanged = ($next -ne $current)

# ── 3. node_modules 链接：link: 依赖要真的挂上才算数 ─────────────────────────
# pnpm 会为 link: 依赖建 junction，但这里不跑包管理器（线上 profile 不该因为一次配置
# 改动去碰网络），所以自己建同一种。**只看"在不在"是不够的**：断链的 junction（目标
# 被删了）名字还占着，mklink 于是失败；指向别处的 junction 会被当成"已就绪"放过。
# 前者让 bundles 里那一行解析失败，后者更糟 —— 挂上的是另一个 home 里的插件。
$moduleDir = Join-Path $profileDir 'node_modules'
$links = [System.Collections.Generic.List[object]]::new()
foreach ($dependency in @($dependencies.PSObject.Properties)) {
	$package = $dependency.Name
	$spec = [string]$dependency.Value
	if (-not $spec.StartsWith('link:')) { continue }
	# 目标以 package.json 里的 link: 为准，**不要按包名猜**：`dsh-video-studio` 挂在
	# `plugins/dsh-video-studio-local`，`@xgone/dsh-remote` 挂在 `plugins/dsh-remote-local`，
	# 按名字拼会拼到不存在的目录（目录恰好存在时更糟 —— 指到别人的插件上）。
	$target = [System.IO.Path]::GetFullPath((Join-Path $profileDir $spec.Substring(5)))
	if (-not (Test-Path $target)) { continue }
	$link = Join-Path $moduleDir ($package -replace '/', '\')
	# 名字不能叫 $existing / $current：那两个在上面记着"本脚本管理的补丁区块在哪"。
	$linkItem = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
	$isLink = $null -ne $linkItem -and ($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
	$pointsAt = if ($isLink) { @($linkItem.Target) | Select-Object -First 1 } else { $null }
	if ($isLink -and $null -ne $pointsAt -and $pointsAt.TrimEnd('\') -ieq $target.TrimEnd('\')) { continue }
	if ($null -ne $linkItem -and -not $isLink) {
		# 真目录而不是链接：本脚本只建链接，覆盖它等于删掉别人装的东西。
		$notes.Add("node_modules\$package 是真实目录而不是链接，没有动它；若它挡着，请手工处理")
		continue
	}
	$links.Add([pscustomobject]@{ Link = $link; Target = $target; Current = $pointsAt; Exists = ($null -ne $linkItem) })
	$where = if ($null -eq $pointsAt) { '（断链）' } else { $pointsAt }
	$changes.Add($(if ($null -eq $linkItem) { "node_modules\$package 缺失，要链接到 $target" } else { "node_modules\$package 现在指向 $where，要重建成 $target" }))
}

Write-Host "profile : $Profile" -ForegroundColor Cyan
Write-Host "manifest: $manifestPath"
Write-Host "patch   : $patchPath"
Write-Host ''
if ($changes.Count -eq 0 -and -not $patchChanged) {
	Write-Host '已经是最新状态，没有要改的。' -ForegroundColor Green
} else {
	foreach ($change in $changes) { Write-Host "  改动  $change" }
	if ($patchChanged) {
		if ($existing -ge 0) { Write-Host '  改动  cordis.patch.yml: 重写本脚本管理的那个区块' }
		else { Write-Host '  改动  cordis.patch.yml: 末尾追加本脚本管理的区块' }
	}
}

foreach ($note in $notes) { Write-Host "  注意  $note" -ForegroundColor Yellow }

$manifestChanged = $manifestEdits -gt 0
$nothingToDo = (-not $manifestChanged) -and (-not $patchChanged) -and $links.Count -eq 0

if (-not $Apply) {
	Write-Host ''
	Write-Host '当前是预览（默认）。确认无误后加 -Apply 真正写入。' -ForegroundColor Yellow
} elseif ($nothingToDo) {
	# 什么都不用改就不要写盘：反复跑会在线上 profile 目录里堆一串无意义的备份。
	Write-Host ''
	Write-Host '没有要写的改动，未触碰任何文件。' -ForegroundColor Green
} else {
	foreach ($path in @($manifestPath, $patchPath)) {
		# 后缀必须以 `.bak` 结尾：仓库的 .gitignore 忽略的是 `*.bak`，而 profile 的
		# patch 里带着真 token —— 一个 `*.bak-<时间戳>` 的备份会正好落在忽略规则之外。
		$backup = "$path.$(Get-Date -Format 'yyyyMMddHHmmss').bak"
		Copy-Item $path $backup
		Write-Host "已备份 $backup"
	}
	# 修链接：到这里才动盘。rmdir 对 junction 只摘链接、不碰目标内容，对非空真目录
	# 会失败 —— 正好挡住"误删别人装的东西"；真目录上面巡检时已经排除，这里只剩链接。
	if ($links.Count -gt 0 -and -not (Test-Path $moduleDir)) { New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null }
	foreach ($link in $links) {
		# 带域的包（`@xgone/dsh-remote`）在 node_modules 下多一层，少了这层 mklink 会失败。
		$linkParent = Split-Path $link.Link -Parent
		if (-not (Test-Path $linkParent)) { New-Item -ItemType Directory -Force -Path $linkParent | Out-Null }
		if ($link.Exists) {
			Remove-Item -LiteralPath $link.Link -Force -Recurse
			Write-Host "已移除旧链接 $($link.Link)"
		}
		cmd /c mklink /J "$($link.Link)" "$($link.Target)" | Out-Null
		if ($LASTEXITCODE -ne 0) {
			# 名字被一个 Get-Item 看不见的断链目录项占着：摘掉它再建一次。
			cmd /c rmdir "$($link.Link)" | Out-Null
			cmd /c mklink /J "$($link.Link)" "$($link.Target)" | Out-Null
		}
		if ($LASTEXITCODE -ne 0) { throw "无法建立链接 $($link.Link) -> $($link.Target)" }
		Write-Host "已链接 $($link.Link) -> $($link.Target)"
	}
	# 换行统一成 LF：仓库是 eol=lf，PowerShell 默认写 CRLF。
	$manifestText = ($manifest | ConvertTo-Json -Depth 8).Replace("`r`n", "`n") + "`n"
	[System.IO.File]::WriteAllText($manifestPath, $manifestText, (New-Object System.Text.UTF8Encoding($false)))
	[System.IO.File]::WriteAllText($patchPath, $next, (New-Object System.Text.UTF8Encoding($false)))
	Write-Host '已写入。' -ForegroundColor Green
}

Write-Host ''
if ($wantGateway) { Write-Host "模型网关 token（发给客户端，provision-client.ps1 -GatewayToken）: $GatewayToken" }
if ($wantArchive) {
	Write-Host "归档 token（发给客户端，provision-client.ps1 -ArchiveToken）: $ArchiveToken"
	Write-Host ''
	Write-Host "归档会写进：$VaultDir\会话记录\" -ForegroundColor Yellow
	Write-Host '  每个上传的会话产生一篇笔记（YYYY-MM-DD 主题.md）并追加一行到索引；' -ForegroundColor Yellow
	Write-Host '  同一会话重复归档是替换，旧笔记会被删掉。原始转录另存在 profiles/<profile>/archive-raw/。' -ForegroundColor Yellow
	Write-Host '  那是你的 Obsidian 库（git 仓库）：启用前先确认这个路径就是你要的。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '生效方式：该 profile 若是 patchReload: live（web-client 就是），改完立刻生效，不用重启。'
Write-Host '客户端侧：在每台客户端电脑上跑 client\provision-client.ps1，把上面的 token 与部署地址填进去。'
