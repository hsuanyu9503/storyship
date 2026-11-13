#!/usr/bin/env bash
# 故事卡正式教材的測試資料庫（sf_story）：與 sf_e2e 相同，另外套用 story_cards_v1.sql（與已部署資料庫相同的更新方式）。
# e2e.js 仍使用 sf_e2e（佔位故事 A～H，同時驗證舊資料相容）；story_reader.js 使用這個資料庫。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..)
DB=${STORY_DB:-sf_story}
psql_() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; else psql -X -q -v ON_ERROR_STOP=1 "$@"; fi; }
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
cat "$ROOT/tests/db/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql" | psql_ -d "$DB" >/dev/null
cat "$ROOT/supabase/content/genre_materials_v1.sql" | psql_ -d "$DB" >/dev/null
cat "$ROOT/supabase/content/story_cards_v1.sql" | psql_ -d "$DB" >/dev/null
psql_ -d "$DB" -c "insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 't1@example.com');
  insert into public.teachers values ('11111111-1111-1111-1111-111111111111', 't1@example.com');" >/dev/null
echo "$DB ready"
