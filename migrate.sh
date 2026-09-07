#!/usr/bin/env bash
# ============================================================
# DSH 局域网部署恢复（Linux / macOS）
# 与 migrate.ps1（Windows）对应：解压备份 → 重映射旧用户名路径 → 合并进 ~/.dsh。
#
# 用法：
#   bash migrate.sh --backup <备份.tar.gz|备份.zip> \
#                   [--old-user <旧用户名>] [--new-user <新用户名>] [--dsh-home <目录>]
# ============================================================
set -euo pipefail

BACKUP=""
OLD_USER=""
NEW_USER="${USER}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --old-user) OLD_USER="$2"; shift 2 ;;
    --new-user) NEW_USER="$2"; shift 2 ;;
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BACKUP" ]] || { echo "缺少 --backup <备份文件>" >&2; exit 2; }
[[ -f "$BACKUP" ]] || { echo "备份文件不存在: $BACKUP" >&2; exit 1; }
OLD_USER="${OLD_USER:-$NEW_USER}"   # 默认同名迁移，无需重映射

NEW_HOME="$HOME"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "解压备份..."
case "$BACKUP" in
  *.zip)
    command -v unzip >/dev/null 2>&1 || { echo "需要 unzip" >&2; exit 1; }
    unzip -q "$BACKUP" -d "$STAGE" ;;
  *.tar.gz|*.tgz)
    tar -xzf "$BACKUP" -C "$STAGE" ;;
  *)
    echo "不支持的备份格式（需 .zip / .tar.gz / .tgz）" >&2; exit 1 ;;
esac

# 1) 文本文件里的绝对路径：Unix 老 home → 新 home；Windows 老 home → 新 home
remap_text() {
  local f="$1"
  # Linux/macOS 老 home
  sed -i.bak \
    -e "s|/home/${OLD_USER}|${NEW_HOME}|g" \
    -e "s|/Users/${OLD_USER}|${NEW_HOME}|g" \
    "$f" 2>/dev/null || true
  # Windows 老 home（JSON 双反斜杠 + 普通单反斜杠），best-effort
  sed -i.bak \
    -e "s|C:\\\\\\\\Users\\\\\\\\${OLD_USER}|${NEW_HOME}|g" \
    -e "s|C:\\\\Users\\\\${OLD_USER}|${NEW_HOME}|g" \
    "$f" 2>/dev/null || true
  rm -f "$f.bak"
}

remapped=0
while IFS= read -r -d '' f; do
  case "$f" in
    *.json|*.yaml|*.yml) remap_text "$f" && remapped=$((remapped+1)) ;;
  esac
done < <(find "$STAGE" -type f -print0)
echo "已重映射文本文件：$remapped 个"

# 2) sessions / sessions-archived 目录名里的变形路径（同平台：替换用户名部分）
if [[ "$OLD_USER" != "$NEW_USER" ]]; then
  for sdir in sessions sessions-archived; do
    p="$STAGE/$sdir"
    [[ -d "$p" ]] || continue
    for d in "$p"/*/; do
      [[ -d "$d" ]] || continue
      base="$(basename "$d")"
      new="$(printf '%s' "$base" \
        | sed "s/--home-${OLD_USER}-/--home-${NEW_USER}-/" \
        | sed "s/--Users-${OLD_USER}-/--Users-${NEW_USER}-/" \
        | sed "s/--C-Users-${OLD_USER}-/--home-${NEW_USER}-/")"
      if [[ "$new" != "$base" ]]; then mv "$d" "$p/$new"; fi
    done
  done
fi

# 3) 合并进 ~/.dsh
echo "合并到 $DSH_HOME ..."
mkdir -p "$DSH_HOME"
cp -a "$STAGE"/. "$DSH_HOME"/

echo "迁移完成。"
echo "路径映射：/home|/Users|C:\\Users 的 $OLD_USER  ->  $NEW_HOME"
echo
echo "后续手工步骤："
echo "  1) 确认工作区文件夹在新路径存在（如 $HOME/finance-ws），否则会话无 cwd。"
if [[ "$OLD_USER" != "$NEW_USER" ]]; then
  echo "  2) ⚠ 跨用户名迁移：会话日志（session.jsonl.zstd）内的 cwd 是压缩二进制，本脚本不重写；"
  echo "     若打开旧会话被拒（'session outside your workspace'），请改回同名用户。"
fi
echo "  3) 改 Caddyfile / start-dsh-lan.sh 里的 LAN_IP；放行 8443 入站防火墙；信任 caddy 根证书。"
echo "  4) 在 profiles/web 重新 pnpm install 重连 link 依赖；启动后按 MIGRATION.md 验证清单核对。"
