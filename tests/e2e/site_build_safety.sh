#!/usr/bin/env bash
# tools/build_site.sh 的輸出路徑安全（複查第二輪 P2）。只在拋棄式的專案副本中執行，不碰正式工作目錄。
#   拒絕（且原檔完整）：assets（相對路徑）、專案內其他既有資料夾、專案外既有資料夾、_site 是符號連結、
#     經由符號連結解析到 assets 的路徑、內容不是本工具產生的 _site
#   成功：不給參數（_site）、重複打包、從子資料夾以相對路徑指定 _site、專案外尚不存在的新位置
# 用法：bash tests/e2e/site_build_safety.sh [要測的 build_site.sh，預設為目前的 tools/build_site.sh]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
SCRIPT=${1:-$ROOT/tools/build_site.sh}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; failn=0
ok() { if [ "$1" = 0 ]; then pass=$((pass+1)); echo "ok - $2"; else failn=$((failn+1)); echo "FAIL - $2"; fi; }
fresh() {   # 建立拋棄式副本：網站檔案＋tools＋一個模擬的 docs 資料夾，每個資料夾放標記檔
  local c="$TMP/copy$1"; mkdir -p "$c/tools"
  cp -R "$ROOT/js" "$ROOT/css" "$ROOT/assets" "$c/"; cp "$ROOT"/{index,join,teacher,projector}.html "$ROOT/config.js" "$ROOT/.nojekyll" "$c/"
  cp "$SCRIPT" "$c/tools/build_site.sh"
  mkdir -p "$c/docs"; echo keep > "$c/docs/MARK"; echo keep > "$c/assets/MARK"
  echo "$c"
}
digest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
expect_refused() {   # $1 副本 $2 說明 $3.. 參數（在 $1 或指定目錄執行）
  local c=$1 label=$2; shift 2
  local before; before=$(digest "$c")
  ( cd "$c" && bash tools/build_site.sh "$@" ) >"$TMP/out" 2>&1; local code=$?
  local after; after=$(digest "$c")
  [ $code -ne 0 ] && [ "$before" = "$after" ] && [ -f "$c/assets/MARK" ] && [ -f "$c/docs/MARK" ] && [ -f "$c/assets/intro/conan-1600.webp" ]
  ok $? "$label：被拒絕（結束碼 $code），副本內容完全不變（$before）$( [ $code -ne 0 ] || echo "；輸出：$(tail -1 "$TMP/out")" )"
}

C=$(fresh 1)
expect_refused "$C" "輸出到 assets（相對路徑）" assets
expect_refused "$C" "輸出到 ./assets/（相對路徑、結尾斜線）" ./assets/
expect_refused "$C" "輸出到專案內既有的 docs（絕對路徑）" "$C/docs"
mkdir -p "$TMP/outside_existing"; echo keep > "$TMP/outside_existing/MARK"
expect_refused "$C" "輸出到專案外既有的資料夾" "$TMP/outside_existing"
[ -f "$TMP/outside_existing/MARK" ]; ok $? "專案外既有資料夾的檔案仍在"
ln -s "$C/assets" "$C/_site"
expect_refused "$C" "專用的 _site 是指向 assets 的符號連結" _site
expect_refused "$C" "不給參數（預設 _site）但 _site 是指向 assets 的符號連結"
rm "$C/_site"
ln -s "$C/assets" "$TMP/link_to_assets"
expect_refused "$C" "經由專案外的符號連結指到 assets 內的新路徑" "$TMP/link_to_assets/newdir"
expect_refused "$C" "輸出路徑本身是指向 assets 的符號連結" "$TMP/link_to_assets"
mkdir "$C/_site"; echo mine > "$C/_site/notes.txt"
expect_refused "$C" "_site 已存在但不是本工具產生的（沒有標記檔）" _site
[ -f "$C/_site/notes.txt" ]; ok $? "非本工具產生的 _site 內容仍在"
rm -rf "$C/_site"
expect_refused "$C" "輸出路徑是專案根目錄" .

# 正常打包
( cd "$C" && bash tools/build_site.sh ) >"$TMP/out" 2>&1; ok $? "不給參數：產生 _site（$(tail -1 "$TMP/out")）"
[ -f "$C/_site/assets/intro/conan-1600.webp" ] && [ -f "$C/_site/assets/intro/chihiro-1600.webp" ] && [ ! -e "$C/_site/docs" ] && [ ! -e "$C/_site/tools" ]
ok $? "產物含兩張揭曉圖、不含 docs 與 tools"
( cd "$C" && bash tools/build_site.sh ) >"$TMP/out" 2>&1; ok $? "重複打包成功"
( cd "$C/js" && bash ../tools/build_site.sh ../_site ) >"$TMP/out" 2>&1; ok $? "從子資料夾以相對路徑 ../_site 打包成功"
( cd "$C" && bash tools/build_site.sh "$TMP/brand_new/_site" ) >"$TMP/out" 2>&1; [ $? -ne 0 ]; ok $? "專案外：上層資料夾不存在時拒絕"
mkdir -p "$TMP/brand_new"
( cd "$C" && bash tools/build_site.sh "$TMP/brand_new/_site" ) >"$TMP/out" 2>&1; ok $? "專案外尚不存在的新位置：成功"
[ -f "$C/assets/MARK" ] && [ -f "$C/docs/MARK" ]; ok $? "全部測試後，副本的 assets 與 docs 標記檔仍在"
echo
echo "打包路徑安全：通過 $pass 項，失敗 $failn 項"
[ $failn -eq 0 ]
