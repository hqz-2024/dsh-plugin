#!/usr/bin/env bash
# ============================================================
# DSH 局域网部署备份（Linux / macOS）
# 与 backup.ps1（Windows）对应：打包 ~/.dsh 的「状态 + 机密」为 tar.gz。
# 不含：node_modules、runtimes（可重下）、bin（caddy）、.git、日志。
# 代码（plugins/.agent-presets/skills）走 dsh-plugin 仓库，不在此备份内。
#
# 用法：
#   bash backup.sh [--output <tar.gz>] [--skip-secrets]
# ============================================================
set -euo pipefail

ROOT="${DSH_HOME:-$HOME/.dsh}"
OUTPUT=""
SKIP_SECRETS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

OUTPUT="${OUTPUT:-$ROOT/backup/dsh-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"

ITEMS=(sessions sessions-archived attachments auth storages llm-deepseek \
       settings.yaml dsh-remote-files.json .anonymous-user-id \
       profiles/web/cordis.patch.yml)
[[ "$SKIP_SECRETS" -eq 0 ]] && ITEMS+=(".credentials.yaml")

EXISTING=()
for it in "${ITEMS[@]}"; do
  [[ -e "$ROOT/$it" ]] && EXISTING+=("$it")
done
[[ "${#EXISTING[@]}" -gt 0 ]] || { echo "没有可备份的内容（$ROOT 下未找到任何目标）" >&2; exit 1; }

mkdir -p "$(dirname "$OUTPUT")"
tar -czf "$OUTPUT" -C "$ROOT" "${EXISTING[@]}"

size=$(du -h "$OUTPUT" | cut -f1)
echo "备份完成：$OUTPUT  ($size)"
echo "包含：${EXISTING[*]}"
if [[ "$SKIP_SECRETS" -eq 0 ]]; then
  echo "⚠ 本备份含机密（.credentials.yaml / auth/store.json / cordis.patch.yml 的 sidecar token），请走可信通道，勿提交 git。"
else
  echo "已跳过 .credentials.yaml（auth/store.json 与 cordis.patch.yml 仍在备份内）。"
fi
