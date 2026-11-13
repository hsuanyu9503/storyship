#!/usr/bin/env bash
# 建立端對端測試用資料庫 sf_e2e（Supabase 模擬環境＋migrations＋佔位素材＋教師 t1@example.com）
set -euo pipefail
cd "$(dirname "$0")"; ROOT=$(realpath ../..)
psql_() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; else psql -X -q -v ON_ERROR_STOP=1 "$@"; fi; }
psql_ -d postgres -c "drop database if exists sf_e2e" >/dev/null 2>&1
psql_ -d postgres -c "create database sf_e2e" >/dev/null
cat "$ROOT/tests/db/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql" | psql_ -d sf_e2e >/dev/null
# 小說類型正式教材（與已部署資料庫相同的更新方式）
cat "$ROOT/supabase/content/genre_materials_v1.sql" | psql_ -d sf_e2e >/dev/null
psql_ -d sf_e2e -c "insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 't1@example.com');
  insert into public.teachers values ('11111111-1111-1111-1111-111111111111', 't1@example.com');" >/dev/null
echo "sf_e2e ready"
