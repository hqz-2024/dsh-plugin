#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 局域网部署自检：逐项断言"该有的模块都在"，输出 ✓/✗ 清单，全部通过返回 0。
#>
$ErrorActionPreference = "Continue"
$Root = $PSScriptRoot
$ProfileDir = Join-Path $Root "profiles\web"
$fail = 0
$warn = 0

function Check($ok, $label, $level = "fail") {
  if ($ok) { Write-Host ("  [✓] " + $label) -ForegroundColor Green }
  else {
    if ($level -eq "warn") { Write-Host ("  [~] " + $label + "  (警告，可后补)") -ForegroundColor Yellow; $script:warn++ }
    else { Write-Host ("  [✗] " + $label) -ForegroundColor Red; $script:fail++ }
  }
}

Write-Host "DSH 部署自检：" -ForegroundColor Cyan

# 1. 角色预设（7 个自定义角色 + agency 角色库）
Write-Host "  [角色预设]"
$expect = @("finance-manager","art-design","business-sales","procurement","production","hr-management","rd-development")
foreach ($id in $expect) {
  $ok = (Test-Path (Join-Path $Root ".agent-presets\$id\agent.cordis.yml")) -and
        (Test-Path (Join-Path $Root ".agent-presets\$id\preset.yml")) -and
        (Test-Path (Join-Path $Root ".agent-presets\$id\skills"))
  Check $ok ("preset " + $id)
}
$allPresets = (Get-ChildItem -Directory (Join-Path $Root ".agent-presets") | Where-Object { Test-Path (Join-Path $_.FullName "agent.cordis.yml") }).Count
Check ($allPresets -ge 7) ("预设总数 " + $allPresets + " 个（含 agency 角色库）")
Check (Test-Path (Join-Path $Root "skills\sidecar\SKILL.md")) "全局 sidecar skill"

# 2. 四个插件（源码 + node_modules）
Write-Host "  [插件]"
foreach ($p in @("dsh-remote-local","folder-tree-sh-local","dsh-usage-panel-local","dsh-local-bridge")) {
  $src = Test-Path (Join-Path $Root "plugins\$p\lib\index.js")
  $deps = Test-Path (Join-Path $Root "plugins\$p\node_modules")
  Check ($src) ("plugin src " + $p)
  Check ($deps) ("plugin deps " + $p)
}

# 3. 配置
Write-Host "  [配置]"
$patch = Join-Path $ProfileDir "cordis.patch.yml"
if (Test-Path $patch) {
  Check $true "cordis.patch.yml 存在"
  $raw = Get-Content $patch -Raw
  Check ($raw -notmatch 'REPLACE_WITH_RANDOM_TOKEN') "sidecar token 已填充（无占位符）"
  Check ($raw -notmatch '<USERNAME>') "runtimeDir 路径已替换（无 <USERNAME>）"
} else {
  Check $false "cordis.patch.yml 存在"
}
$pkg = Join-Path $ProfileDir "package.json"
$pkgRaw = Get-Content $pkg -Raw
Check ($pkgRaw -notmatch 'link:[A-Za-z]:') "package.json 的 link: 为相对路径（无绝对盘符路径）"

# 4. 密钥与引擎
Write-Host "  [密钥/引擎]"
Check (Test-Path (Join-Path $Root ".credentials.yaml")) ".credentials.yaml 存在"
$engine = Join-Path $env:USERPROFILE "Desktop\deepseek-harness"
Check (Test-Path (Join-Path $engine "package.json")) ("引擎 checkout 存在：" + $engine)
Check (Test-Path (Join-Path $engine "packages\api\session-controller\src\index.ts")) "session-controller 源码存在"

# 5. 运行时 / caddy（警告级）
Write-Host "  [可选运行时]"
Check (Test-Path (Join-Path $Root "runtimes\dshdoc-runtime-win32-x64")) "dsh-doc OCR 运行时" "warn"
Check (Test-Path (Join-Path $Root "bin\caddy.exe")) "caddy.exe" "warn"

Write-Host ""
if ($fail -eq 0) {
  Write-Host ("自检通过（" + $warn + " 个警告）") -ForegroundColor Green
  exit 0
} else {
  Write-Host ("自检未通过：" + $fail + " 项缺失/错误，" + $warn + " 个警告") -ForegroundColor Red
  exit 1
}
