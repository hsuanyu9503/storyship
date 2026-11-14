#!/usr/bin/env bash
# 產生 GitHub Pages 要發布的網站檔案（允許清單）：只有網站本身需要的檔案。
#   包含：index.html、join.html、teacher.html、projector.html、config.js、.nojekyll、js/、css/、assets/
#   不包含：docs/（教材原稿抽出結果、揭曉截圖）、source-assets/（Word 原稿與原始圖）、supabase/、tests/、tools/ 等開發檔案。
# 與 tests/lib/static-site.js（測試伺服器的允許清單）一致。
# 用法：bash tools/build_site.sh [輸出資料夾，預設 _site]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-_site}
case "$OUT" in ""|"/"|".") echo "輸出資料夾不正確：$OUT" >&2; exit 1;; esac
rm -rf -- "$OUT"
mkdir -p -- "$OUT"
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
