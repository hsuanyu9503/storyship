#!/usr/bin/env bash
# 輸出本機 Supabase 測試的狀態目錄（密鑰、閘道 pid、記錄檔）。必須在 repository 之外（先檢查、再建立）。
set -euo pipefail
ROOT=$(realpath "$(dirname "$0")/../..")
DIR=${SB_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/storyship-sbtest}
ABS=$(realpath -m "$DIR")
case "$ABS/" in "$ROOT"/*) echo "SB_STATE_DIR 不能位於 repository 之內：$ABS" >&2; exit 1 ;; esac
mkdir -p "$ABS"; chmod 700 "$ABS"
echo "$ABS"
