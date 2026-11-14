#!/usr/bin/env bash
# 產生 GitHub Pages 要發布的網站檔案（允許清單）：只有網站本身需要的檔案。
#   包含：index.html、join.html、teacher.html、projector.html、config.js、.nojekyll、js/、css/、assets/
#   不包含：docs/（教材原稿抽出結果、揭曉截圖）、source-assets/（Word 原稿與原始圖）、supabase/、tests/、tools/ 等開發檔案。
# 與 tests/lib/static-site.js（測試伺服器的允許清單）一致。
#
# 輸出位置的安全規則（複查第二輪 P2：避免誤傳既有資料夾而被遞迴刪除）：
#   * 不給參數：專案根目錄下專用的 _site（GitHub Actions 使用這個）。可重複執行：只有在 _site 是空的、
#     或含本工具寫入的標記檔 .storyship-site-build 時才會清掉重建；其他內容的 _site 一律拒絕。
#   * 給參數：先依「呼叫時的目前目錄」解析相對路徑，上層目錄以實體路徑（解開符號連結）核對：
#       - 等於專案的 _site → 同上
#       - 位於專案內的其他位置（例如 assets、js、docs）→ 拒絕
#       - 專案外 → 只允許「尚不存在」的路徑（在全新的位置建立）；已存在的檔案或資料夾一律拒絕，不刪除、不覆寫
#   * 輸出路徑本身是符號連結 → 拒絕（不跟隨連結刪除）。
#   所有檢查都在任何刪除或寫入之前完成。
# 用法：bash tools/build_site.sh [輸出資料夾]
set -euo pipefail
CALLER=$(pwd -P)
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
MARK=.storyship-site-build
refuse() { echo "拒絕：$*（未刪除或修改任何檔案）" >&2; exit 2; }

ARG=${1:-$ROOT/_site}
[ -n "$ARG" ] || refuse "輸出路徑是空字串"
case "$ARG" in /*) ;; *) ARG="$CALLER/$ARG" ;; esac
ARG=${ARG%/}
NAME=$(basename -- "$ARG"); PARENT=$(dirname -- "$ARG")
case "$NAME" in ""|"."|"..") refuse "輸出路徑不正確：$1" ;; esac
[ -d "$PARENT" ] || refuse "上層資料夾不存在：$PARENT"
PPARENT=$(cd -P -- "$PARENT" && pwd -P)
OUT="$PPARENT/$NAME"
[ ! -L "$OUT" ] || refuse "輸出路徑是符號連結：$OUT"

if [ "$OUT" = "$ROOT/_site" ]; then
  if [ -e "$OUT" ]; then
    [ -d "$OUT" ] || refuse "$OUT 不是資料夾"
    if [ -n "$(ls -A -- "$OUT")" ] && [ ! -f "$OUT/$MARK" ]; then refuse "$OUT 不是本工具產生的（沒有 $MARK 標記檔）"; fi
    rm -rf -- "$OUT"
  fi
else
  case "$OUT/" in "$ROOT"/*) refuse "專案內只允許輸出到專用的 _site：$OUT" ;; esac
  [ ! -e "$OUT" ] || refuse "$OUT 已存在；專案外只能輸出到尚不存在的新位置"
fi

cd "$ROOT"
mkdir -- "$OUT"
: > "$OUT/$MARK"
for f in index.html join.html teacher.html projector.html config.js .nojekyll; do
  [ -f "$f" ] || { echo "缺少 $f" >&2; exit 1; }
  cp -- "$f" "$OUT/"
done
for d in js css assets; do cp -R -- "$d" "$OUT/"; done
# 防呆：開發檔案絕不可出現在發布產物中
for bad in docs source-assets supabase tests tools .github; do
  [ ! -e "$OUT/$bad" ] || { echo "發布產物含有 $bad" >&2; exit 1; }
done
echo "已產生 $OUT（$(find "$OUT" -type f | wc -l) 個檔案）"
