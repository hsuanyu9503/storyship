#!/usr/bin/env bash
# 本機資料庫測試：建立暫時資料庫 → 載入 Supabase 模擬環境 → 執行 migrations 與 seed → 跑測試。
# 需要本機 PostgreSQL 15+ 與 psql。以 root 執行時自動切換為 postgres 使用者；
# 其他情況使用 PGHOST／PGUSER 等環境變數連線。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..)
HERE=$(pwd)
DB=${TEST_DB:-story_friends_test}
psql_() {
  if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"
  else psql -X -q -v ON_ERROR_STOP=1 "$@"; fi
}
psql_ -d postgres -c "drop database if exists $DB" >/dev/null
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" \
         "$ROOT/supabase/migrations/001_init.sql" "$ROOT/supabase/migrations/002_rpc.sql" \
         "$ROOT/supabase/migrations/003_security.sql" "$ROOT/supabase/seed/001_placeholder_content.sql" \
         "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql" \
         "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
echo "schema OK（含重跑 002／003／seed 的可重複執行檢查）"
psql_ -d "$DB" -f "$HERE/tests.sql"
psql_ -d "$DB" -f "$HERE/tests_group.sql"
psql_ -d "$DB" -f "$HERE/tests_results.sql"
psql_ -d "$DB" -f "$HERE/tests_disclosure.sql"
bash "$HERE/genre_materials.sh"
bash "$HERE/story_cards.sh"
