#!/usr/bin/env bash
# 在隔離的本機 Supabase（tests/supabase/up.sh）上驗證安裝、升級、回復與 API 權限。
# 每條路徑都使用全新的 Supabase（down -v 後重新啟動），SQL 一律以 postgres 角色執行（與 Supabase SQL Editor 相同，非超級使用者）。
#   1. 全新安裝：001 → 002 → 003 → seed → verify.sql（17 項）→ api_test.mjs（權限、錯誤格式、公開 API、Realtime）
#   2. 從已部署的 Phase 3（git 89299af）＋上課中資料（停在 06、已揭開兩類）升級：
#      upgrade.sql → 資料與快照不變、17 項、舊版 06 揭露保留且不擴大 → 重複執行 → 回復到 Phase 3 → 再升級
# 用法：bash tests/supabase/run.sh  （需要 Docker；結束後停止容器）
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd); ROOT=$(realpath ../..); STATE=$(bash "$HERE/state_dir.sh")
fail() { echo "FAIL: $*"; bash "$HERE/up.sh" down >/dev/null; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fresh() { bash "$HERE/up.sh" down >/dev/null; bash "$HERE/up.sh" >/dev/null || fail "Supabase 啟動失敗"; set -a; . "$STATE/env"; set +a; export GATEWAY_URL="http://localhost:$GATEWAY_PORT"; }
psql_() { PGPASSWORD=$POSTGRES_PASSWORD psql -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres "$@"; }
verify17() { local out; out=$(psql_ -f "$ROOT/supabase/checks/verify.sql"); [ "$(echo "$out" | grep -c '|t$')" = "17" ] && ! echo "$out" | grep -q '|f$' || { echo "$out"; return 1; }; }
digest() { psql_ -c "select md5(string_agg(t, '|' order by t)) from (
  select 's' || id || status || join_code as t from public.sessions union all
  select 'p' || id || coalesce(group_id::text, '') || seat_label || status from public.participants union all
  select 'b' || participant_id || data::text || rev || coalesce(submitted_at::text, '') from public.personal_boards union all
  select 'ps' || participant_id || data::text || is_complete || taken_at from public.personal_snapshots union all
  select 'g' || id || status || board_rev from public.groups union all
  select 'gc' || id || group_id || label_no || name || reason || name_rev || reason_rev from public.group_categories union all
  select 'gp' || group_id || card_id || coalesce(category_id::text, '') || rev from public.group_placements union all
  select 'gs' || id || group_id || kind || data::text || is_complete || board_rev || created_at from public.group_snapshots union all
  select 'st' || session_id || phase || rev || editing_paused from public.session_state) x"; }

echo "== 1. 全新安裝（Supabase 映像檔的預設權限）"
fresh
for f in "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do psql_ -f "$f" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "安裝失敗：$f"; }; done
verify17 || fail "全新安裝後 verify.sql 未全數通過"
echo "ok - 全新安裝（以 postgres 角色執行 001→002→003→seed）：verify.sql 17 項全為 true"
psql_ -f "$ROOT/supabase/content/genre_materials_v1.sql" > "$TMP/content" 2>&1 || { cat "$TMP/content"; fail "小說類型教材腳本失敗"; }
[ "$(grep -c '|t$' "$TMP/content")" = "5" ] || { cat "$TMP/content"; fail "教材腳本結果不是 5 列 true"; }
echo "ok - 小說類型教材腳本（以 postgres 角色、Supabase 預設權限）：五類更新完成"
psql_ -f "$ROOT/supabase/content/story_cards_v1.sql" > "$TMP/content" 2>&1 || { cat "$TMP/content"; fail "故事卡教材腳本失敗"; }
[ "$(grep -c '|t$' "$TMP/content")" = "8" ] || { cat "$TMP/content"; fail "故事卡教材腳本結果不是 8 列 true"; }
echo "ok - 故事卡教材腳本（以 postgres 角色、Supabase 預設權限）：八張更新完成"
for f in "$ROOT"/supabase/migrations/00{2,3}_*.sql; do psql_ -f "$f" >/dev/null 2>&1 || fail "重複執行失敗：$f"; done
verify17 || fail "重複執行 002／003 後檢查未通過"
echo "ok - 重複執行 002、003 後仍全數通過"
node "$HERE/api_test.mjs" || fail "API 測試未全數通過"

echo "== 2. 從已部署的 Phase 3（89299af）＋上課中資料升級"
fresh
for f in supabase/migrations/001_init.sql supabase/migrations/002_rpc.sql supabase/migrations/003_security.sql supabase/seed/001_placeholder_content.sql supabase/rollback/phase3_to_phase2.sql; do
  git -C "$ROOT" show "89299af:$f" > "$TMP/p3_$(basename "$f")"
done
git -C "$ROOT" show "89299af:supabase/checks/verify.sql" > "$TMP/p3_verify.sql"
for f in 001_init 002_rpc 003_security 001_placeholder_content; do psql_ -f "$TMP/p3_$f.sql" >/dev/null 2>&1 || fail "安裝 Phase 3 失敗：$f"; done
LIVE=$(node "$HERE/seed_phase3_live.mjs") || fail "建立 Phase 3 上課中資料失敗"
SID=$(node -e 'console.log(JSON.parse(process.argv[1]).sid)' "$LIVE")
BEFORE=$(digest)
SNAPS=$(psql_ -c "select md5(string_agg(id || data::text || created_at, '|' order by id)) from public.group_snapshots")
psql_ -f "$ROOT/supabase/upgrade/upgrade.sql" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "upgrade.sql 失敗"; }
[ "$(digest)" = "$BEFORE" ] || fail "升級後學生資料或狀態改變"
[ "$(psql_ -c "select md5(string_agg(id || data::text || created_at, '|' order by id)) from public.group_snapshots")" = "$SNAPS" ] || fail "升級後快照改變"
verify17 || fail "升級後 verify.sql 未全數通過"
echo "ok - Phase 3（89299af）上課中（停在 06）升級：學生資料、快照、課堂狀態完全不變；17 項全為 true"
node "$HERE/upgrade_check.mjs" "$LIVE" || fail "升級後舊版 06 揭露檢查未通過"
psql_ -f "$ROOT/supabase/upgrade/upgrade.sql" >/dev/null 2>&1 || fail "重複執行 upgrade.sql 失敗"
verify17 || fail "重複執行後檢查未通過"
echo "ok - upgrade.sql 重複執行：17 項全為 true"
AFTER_UP=$(digest)
# 回復（docs/PHASE4.md 第八節）：Phase 3 的 002 → 003 → rollback/phase4_to_phase3.sql
for f in "$TMP/p3_002_rpc.sql" "$TMP/p3_003_security.sql" "$ROOT/supabase/rollback/phase4_to_phase3.sql"; do psql_ -f "$f" >/dev/null 2>"$TMP/err" || { cat "$TMP/err"; fail "回復失敗：$f"; }; done
[ "$(digest)" = "$AFTER_UP" ] || fail "回復到 Phase 3 後資料改變"
[ -z "$(psql_ -c "select 1 from pg_proc where proname in ('teacher_publish_compare','genre_build')")" ] || fail "回復後 Phase 4 函式仍存在"
P3BAD=$(psql_ -f "$TMP/p3_verify.sql" | grep -c '|f$' || true); [ "$P3BAD" = "0" ] || fail "回復後 Phase 3 的 verify.sql 有 $P3BAD 項未通過"
echo "ok - 回復到 Phase 3：資料不變、Phase 4 函式移除、Phase 3 的 verify.sql 全數通過"
psql_ -f "$ROOT/supabase/upgrade/upgrade.sql" >/dev/null 2>&1 || fail "回復後再升級失敗"
verify17 || fail "再升級後檢查未通過"
[ "$(digest)" = "$AFTER_UP" ] || fail "再升級後資料改變"
echo "ok - 回復後再次升級：資料不變、17 項全為 true"
bash "$HERE/up.sh" down >/dev/null
echo "== 全部通過"
