#!/usr/bin/env bash
# 升級測試（Phase 2 → Phase 3）：以 Phase 2 驗收版本（git 577e76c）建立資料庫，放入「正在進行 04」的資料
# （個人快照、一組已提交、一組編輯中），再執行新版 002 → 003，確認：
#   既有資料完全不變、升級後檢查全數通過、上課中可直接繼續、可回復到 Phase 2、可再次升級。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_upgrade_p3}
REF=${PHASE2_REF:-577e76c}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 755 "$TMP"
for f in supabase/migrations/001_init.sql supabase/migrations/002_rpc.sql supabase/migrations/003_security.sql supabase/seed/001_placeholder_content.sql; do
  git -C "$ROOT" show "$REF:$f" > "$TMP/$(basename "$f")"
done
chmod 644 "$TMP"/*
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$TMP/001_init.sql" "$TMP/002_rpc.sql" "$TMP/003_security.sql" "$TMP/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
fail() { echo "FAIL: $*"; exit 1; }
T1=11111111-1111-1111-1111-111111111111
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"
TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40}); TC=$(printf 'c%.0s' {1..40})
q "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_create_session('upgrade', 6)->>'session_id'" | tail -1)
CODE=$(q "select join_code from public.sessions where id = '$SID'")
stage() { psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_set_stage('$SID', '$1', '$1', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$SID'), ${2:-false})->>'ok'" | tail -1; }
q "set role anon; select public.student_join('$CODE', '$TA', 1), public.student_join('$CODE', '$TB', 1), public.student_join('$CODE', '$TC', 2)" >/dev/null
stage 03 >/dev/null
q "set role anon; select public.student_save_personal('$SID', '$TA', '{\"categories\":[{\"id\":\"c1\",\"no\":1,\"name\":\"想法\"}],\"placements\":{}}', 0)" >/dev/null
stage 04 >/dev/null
# Phase 2 版本的小組操作（舊的兩個參數版本 group_add_category）
CARDS=$(q "select string_agg(id::text, ' ' order by sort_order) from public.story_cards")
G1C=$(q "set role anon; select public.group_add_category('$SID', '$TA')->>'category_id'" | tail -1)
G2C=$(q "set role anon; select public.group_add_category('$SID', '$TC')->>'category_id'" | tail -1)
for c in $CARDS; do q "set role anon; select public.group_move_card('$SID', '$TA', '$c', '$G1C', 0)" >/dev/null; done
q "set role anon; select public.group_update_category('$SID', '$TA', '$G1C', 'name', '全部', 1), public.group_update_category('$SID', '$TB', '$G1C', 'reason', '都是故事', 1)" >/dev/null
BREV=$(q "select board_rev from public.groups where session_id = '$SID' and number = 1")
[ "$(q "set role anon; select public.group_submit('$SID', '$TA', $BREV)->>'ok'" | tail -1)" = "true" ] || fail "Phase 2 版本提交失敗"
q "set role anon; select public.group_move_card('$SID', '$TC', '$(echo $CARDS | cut -d' ' -f1)', '$G2C', 0)" >/dev/null

digest() { q "select md5(string_agg(t, '|' order by t)) from (
  select 's' || id || status || join_code as t from public.sessions union all
  select 'p' || id || coalesce(group_id::text, '') || seat_label || status from public.participants union all
  select 'b' || participant_id || data::text || rev || coalesce(submitted_at::text, '') from public.personal_boards union all
  select 'ps' || participant_id || data::text || is_complete || taken_at from public.personal_snapshots union all
  select 'g' || id || status || board_rev from public.groups union all
  select 'gc' || id || group_id || label_no || name || reason || name_rev || reason_rev from public.group_categories union all
  select 'gp' || group_id || card_id || coalesce(category_id::text, '') || rev from public.group_placements union all
  select 'gs' || id || group_id || kind || data::text || is_complete || board_rev || created_at from public.group_snapshots union all
  select 'st' || session_id || phase || rev from public.session_state) x"; }
BEFORE=$(digest)

# ---------- 複檢：升級空窗（只執行了 002、003 尚未執行）----------
# 模擬 Supabase 的預設權限：public 新建的資料表自動授權給 anon／authenticated
q "alter default privileges in schema public grant all on tables to anon, authenticated" >/dev/null
psql_ -d "$DB" -f "$ROOT/supabase/migrations/002_rpc.sql" >/dev/null 2>&1
for stmt in "select count(*) from public.group_category_tombstones" \
            "insert into public.group_category_tombstones (category_id, group_id) select gen_random_uuid(), id from public.groups limit 1"; do
  OUT=$(psql_ -d "$DB" -c "set role anon" -c "$stmt" 2>&1 || true)
  echo "$OUT" | grep -qi "permission denied" || fail "只執行 002 時 anon 可以存取 tombstone 資料表：$stmt → $OUT"
done
echo "ok - 複檢：只執行 002（003 尚未執行）時，新資料表已啟用 RLS、anon 不能讀寫（模擬 Supabase 預設權限）"
q "alter default privileges in schema public revoke all on tables from anon, authenticated" >/dev/null
q "drop table public.group_category_tombstones" >/dev/null
q "drop function if exists public.group_add_category(uuid, text, uuid); drop function if exists app.group_result_json(uuid); drop function if exists app.lock_open_groups(uuid)" >/dev/null
psql_ -d "$DB" -f "$TMP/002_rpc.sql" >/dev/null 2>&1; psql_ -d "$DB" -f "$TMP/003_security.sql" >/dev/null 2>&1
psql_ -d "$DB" -f "$ROOT/supabase/rollback/phase3_to_phase2.sql" >/dev/null 2>&1
[ "$(digest)" = "$BEFORE" ] || fail "空窗測試後無法回到升級前狀態"

# ---------- 升級（docs/PHASE3.md 第二節）----------
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
[ "$(digest)" = "$BEFORE" ] || fail "升級後既有資料改變"
echo "ok - Phase 2 → 3 升級：場次、學生、個人草稿與快照、小組分類、提交快照、課堂狀態完全不變"
BAD=$(psql_ -d "$DB" -f "$ROOT/supabase/checks/verify.sql" | grep -c '|f$' || true)
[ "$BAD" = "0" ] || { psql_ -d "$DB" -f "$ROOT/supabase/checks/verify.sql"; fail "升級後檢查有 $BAD 項未通過"; }
echo "ok - 升級後檢查（supabase/checks/verify.sql）全數通過"

# 上課中的場次直接繼續：第二組用新版操作、教師結束共同分類、原提交快照保留
R=$(psql_ -d "$DB" <<SQL
set role anon;
select public.group_add_category('$SID', '$TC', 'dddddddd-0000-4000-8000-000000000001')->>'label_no';
select public.group_update_category('$SID', '$TC', '$G2C', 'reason', '升級後補寫', 1)->>'ok';
reset role;
SQL
)
[ "$(echo "$R" | tr '\n' ' ')" = "2 true " ] || fail "升級後第二組無法繼續：$R"
[ "$(stage 05 true)" = "true" ] || fail "升級後教師無法結束共同分類"
[ "$(q "select count(*) from public.group_snapshots")" = "6" ] || fail "快照數量不正確（應為 1 份提交＋5 組教師結束保存）"
[ "$(q "select count(*) from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.number = 1 and gs.kind = 'submitted' and gs.data->'categories'->0->>'reason' = '都是故事'")" = "1" ] || fail "Phase 2 時的提交快照沒有保留"
[ "$(q "select kind || is_complete from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.number = 2")" = "lockedfalse" ] || fail "第二組結束保存狀態不正確"
echo "ok - 升級後上課中的場次可直接繼續；結束共同分類時保存第二組成果；Phase 2 時的提交快照保留"
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
echo "ok - 升級 SQL 可重複執行"

# ---------- 回復到 Phase 2 ----------
AFTER=$(digest)
for f in "$TMP/002_rpc.sql" "$TMP/003_security.sql" "$ROOT/supabase/rollback/phase3_to_phase2.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
[ "$(digest)" = "$AFTER" ] || fail "回復時資料改變"
[ -z "$(q "select to_regprocedure('public.group_add_category(uuid,text,uuid)')")" ] || fail "回復後新版函式仍存在"
stage 04 >/dev/null
[ "$(q "set role anon; select public.student_group_board('$SID', '$TC')->>'status'" | tail -1)" = "locked" ] || fail "回復後無法讀取小組資料"
psql_ -d "$DB" -c "select prosrc from pg_proc where proname = 'own_session'" | grep -q "for no key update" && fail "回復後 app.own_session 仍是 Phase 3 版本"
echo "ok - 可回復到 Phase 2 函式版本（含 app.own_session），所有資料保留"
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
BAD=$(psql_ -d "$DB" -f "$ROOT/supabase/checks/verify.sql" | grep -c '|f$' || true)
[ "$BAD" = "0" ] || fail "再次升級後檢查未通過"
echo "ok - 回復後可再次升級到 Phase 3，檢查全數通過"
