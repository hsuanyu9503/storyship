#!/usr/bin/env bash
# 產生 supabase/upgrade/upgrade.sql：002 → 003 → 檢查，包在單一交易中（任何一步失敗就全部回復，沒有中間狀態）。
# 修改 002／003／verify.sql 後執行：bash supabase/upgrade/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-upgrade/upgrade.sql}
{
  echo "-- ====================================================================="
  echo "-- 故事找朋友｜資料庫升級（已部署 Phase 1／2／3 的資料庫都適用；可重複執行）"
  echo "-- 由 supabase/upgrade/build.sh 產生，請勿手動修改。內容：002_rpc.sql → 003_security.sql → checks/verify.sql"
  echo "-- 整份包在單一交易中：中途任何錯誤都會全部回復，資料庫維持升級前的狀態。"
  echo "-- 不刪除、不修改任何既有資料。執行完畢後，結果表格的 ok 都應為 true。"
  echo "-- ====================================================================="
  echo "begin;"
  echo
  cat migrations/002_rpc.sql
  echo
  cat migrations/003_security.sql
  echo
  echo "commit;"
  echo
  cat checks/verify.sql
} > "$OUT"
echo "已產生 $OUT"
