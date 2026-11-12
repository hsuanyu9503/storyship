#!/usr/bin/env bash
# 單一檔案升級（supabase/upgrade/upgrade.sql）的測試：
#   1. 與 002／003／verify.sql 同步（由 build.sh 產生，沒有手動改動）
#   2. 從已部署的 Phase 3（main 2bb50e4，複檢前版本）＋上課中資料升級：資料不變、17 項檢查全過、修正生效
#   3. 從 Phase 2（577e76c）升級：檢查全過
#   4. 原子性：在交易中段注入錯誤 → 資料庫完全維持升級前狀態（沒有半套）
#   5. 可重複執行；以 Supabase 式的預設權限（新資料表自動授權 anon）執行
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd)
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 755 "$TMP"
BUNDLE="$ROOT/supabase/upgrade/upgrade.sql"

# 1. 同步檢查
bash "$ROOT/supabase/upgrade/build.sh" "$TMP/fresh.sql" >/dev/null
cmp -s "$TMP/fresh.sql" "$BUNDLE" || fail "supabase/upgrade/upgrade.sql 與 002／003／verify.sql 不同步，請執行 bash supabase/upgrade/build.sh"
echo "ok - 單一升級檔與 002／003／verify.sql 同步"
cp "$BUNDLE" "$TMP/bundle.sql"; chmod 644 "$TMP/bundle.sql"

mkdb() {   # $1 資料庫 $2 git 版本：以該版本的 001～003＋seed 建立；模擬 Supabase 預設權限
  local db=$1 ref=$2 f
  psql_ -d postgres -c "drop database if exists $db" >/dev/null 2>&1
  psql_ -d postgres -c "create database $db" >/dev/null
  psql_ -d "$db" -f "$HERE/supabase_stub.sql" >/dev/null
  psql_ -d "$db" -c "alter default privileges in schema public grant all on tables to anon, authenticated" >/dev/null
  for f in supabase/migrations/001_init.sql supabase/migrations/002_rpc.sql supabase/migrations/003_security.sql supabase/seed/001_placeholder_content.sql; do
    git -C "$ROOT" show "$ref:$f" > "$TMP/$(basename "$f")"; chmod 644 "$TMP/$(basename "$f")"
    psql_ -d "$db" -f "$TMP/$(basename "$f")" >/dev/null 2>&1
  done
}
digest() { psql_ -d "$1" -c "select md5(string_agg(t, '|' order by t)) from (
  select 's' || id || status || join_code as t from public.sessions union all
  select 'p' || id || coalesce(group_id::text, '') || seat_label || status from public.participants union all
  select 'b' || participant_id || data::text || rev || coalesce(submitted_at::text, '') from public.personal_boards union all
  select 'ps' || participant_id || data::text || is_complete || taken_at from public.personal_snapshots union all
  select 'g' || id || status || board_rev from public.groups union all
  select 'gc' || id || group_id || label_no || name || reason || name_rev || reason_rev from public.group_categories union all
  select 'gp' || group_id || card_id || coalesce(category_id::text, '') || rev from public.group_placements union all
  select 'gs' || id || group_id || kind || data::text || is_complete || board_rev || created_at from public.group_snapshots union all
  select 'st' || session_id || phase || rev || editing_paused from public.session_state) x"; }
verify_ok() { local bad; bad=$(psql_ -d "$1" -f "$ROOT/supabase/checks/verify.sql" | grep -c '|f$' || true)
  [ "$bad" = "0" ] && [ "$(psql_ -d "$1" -f "$ROOT/supabase/checks/verify.sql" | grep -c '|t$')" = "17" ]; }

# 2. 已部署的 Phase 3（複檢前）＋上課中資料
DB=story_friends_bundle_p3
mkdb $DB 2bb50e4
T1=11111111-1111-1111-1111-111111111111
TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"
psql_ -d $DB -c "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(psql_ -d $DB -c "$TEACH" -c "select public.teacher_create_session('bundle', 6)->>'session_id'" | tail -1)
CODE=$(psql_ -d $DB -c "select join_code from public.sessions where id = '$SID'")
stage() { psql_ -d $DB -c "$TEACH" -c "select public.teacher_set_stage('$SID', '$1', '$1', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$SID'), false)->>'ok'" | tail -1; }
psql_ -d $DB -c "set role anon" -c "select public.student_join('$CODE', '$TA', 1), public.student_join('$CODE', '$TB', 1)" >/dev/null
stage 03 >/dev/null; stage 04 >/dev/null
psql_ -d $DB -c "set role anon" -c "select public.group_add_category('$SID', '$TA', 'eeeeeeee-0000-4000-8000-000000000001')" \
  -c "select public.group_update_category('$SID', '$TB', 'eeeeeeee-0000-4000-8000-000000000001', 'reason', '升級前的理由', 1)" >/dev/null
BEFORE=$(digest $DB)

# 4. 原子性：在 commit 之前注入錯誤
sed 's/^commit;$/select 1 \/ 0;  -- 測試：注入錯誤\ncommit;/' "$TMP/bundle.sql" > "$TMP/broken.sql"; chmod 644 "$TMP/broken.sql"
psql_ -d $DB -f "$TMP/broken.sql" >/dev/null 2>&1 && fail "注入錯誤的升級竟然成功"
[ "$(digest $DB)" = "$BEFORE" ] || fail "升級失敗後資料改變"
[ -z "$(psql_ -d $DB -c "select 1 from information_schema.columns where table_name = 'session_state' and column_name = 'personal_closed_at'")" ] || fail "升級失敗後仍留下新欄位（不是原子的）"
psql_ -d $DB -c "select prosrc from pg_proc where proname = 'own_session'" | grep -q "for update" || fail "升級失敗後函式已被改動（不是原子的）"
echo "ok - 升級檔中段失敗時全部回復：資料、欄位、函式都維持升級前狀態"

psql_ -d $DB -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "升級失敗"
[ "$(digest $DB)" = "$BEFORE" ] || fail "升級後既有資料改變"
verify_ok $DB || { psql_ -d $DB -f "$ROOT/supabase/checks/verify.sql"; fail "升級後檢查未全數通過"; }
psql_ -d $DB -c "select prosrc from pg_proc where proname = 'own_session'" | grep -q "for no key update" || fail "修正沒有生效"
echo "ok - 從已部署的 Phase 3（2bb50e4）＋上課中資料升級：資料不變、17 項檢查全過、修正生效"
OUT=$(psql_ -d $DB -c "set role anon" -c "select public.group_update_category('$SID', '$TA', 'eeeeeeee-0000-4000-8000-000000000001', 'reason', 'x', null)" 2>&1 || true)
echo "$OUT" | grep -q BAD_DATA || fail "升級後 null 版本號仍被接受：$OUT"
[ "$(psql_ -d $DB -c "set role anon" -c "select public.student_group_board('$SID', '$TA')->'categories'->0->>'reason'" | tail -1)" = "升級前的理由" ] || fail "上課中資料無法讀取"
echo "ok - 升級後上課中的小組可直接讀取，null 版本號被拒絕"
psql_ -d $DB -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "重複執行失敗"
verify_ok $DB || fail "重複執行後檢查未通過"
echo "ok - 升級檔可重複執行"

# 3. 從 Phase 2 升級
DB2=story_friends_bundle_p2
mkdb $DB2 577e76c
psql_ -d $DB2 -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "從 Phase 2 升級失敗"
verify_ok $DB2 || fail "從 Phase 2 升級後檢查未通過"
echo "ok - 從 Phase 2（577e76c）以單一檔案升級：17 項檢查全過"

# 5. 從已部署的 Phase 3（main 89299af）＋上課中資料升級到 Phase 4
DB3=story_friends_bundle_p4
mkdb $DB3 89299af
psql_ -d $DB3 -c "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(psql_ -d $DB3 -c "$TEACH" -c "select public.teacher_create_session('p4', 6)->>'session_id'" | tail -1)
CODE=$(psql_ -d $DB3 -c "select join_code from public.sessions where id = '$SID'")
st3() { psql_ -d $DB3 -c "$TEACH" -c "select public.teacher_set_stage('$SID', '$1', '$1', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$SID'), ${2:-false})->>'ok'" | tail -1; }
psql_ -d $DB3 -c "set role anon" -c "select public.student_join('$CODE', '$TA', 1), public.student_join('$CODE', '$TB', 2)" >/dev/null
st3 03 >/dev/null; st3 04 >/dev/null
psql_ -d $DB3 -c "set role anon" -c "select public.group_add_category('$SID', '$TA', 'ffffffff-0000-4000-8000-000000000001')" \
  -c "select public.group_update_category('$SID', '$TA', 'ffffffff-0000-4000-8000-000000000001', 'reason', 'Phase 3 時的理由', 1)" >/dev/null
CARD1=$(psql_ -d $DB3 -c "select id from public.story_cards order by sort_order limit 1")
psql_ -d $DB3 -c "set role anon" -c "select public.group_move_card('$SID', '$TA', '$CARD1', 'ffffffff-0000-4000-8000-000000000001', 0)" >/dev/null
st3 05 true >/dev/null                                   # Phase 3 版本：教師結束共同分類
BEFORE=$(digest $DB3)
SNAPS=$(psql_ -d $DB3 -c "select md5(string_agg(id || data::text || created_at, '|' order by id)) from public.group_snapshots")
psql_ -d $DB3 -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "從 Phase 3 升級失敗"
[ "$(digest $DB3)" = "$BEFORE" ] || fail "升級到 Phase 4 後既有資料改變"
[ "$(psql_ -d $DB3 -c "select md5(string_agg(id || data::text || created_at, '|' order by id)) from public.group_snapshots")" = "$SNAPS" ] || fail "升級後快照改變"
verify_ok $DB3 || { psql_ -d $DB3 -f "$ROOT/supabase/checks/verify.sql"; fail "升級到 Phase 4 後檢查未全數通過"; }
echo "ok - 從已部署的 Phase 3（89299af）＋上課中資料升級：資料與快照不變、17 項檢查全過"
S1=$(psql_ -d $DB3 -c "select gs.id from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.session_id = '$SID' and g.number = 1")
R=$(psql_ -d $DB3 -c "$TEACH" -c "select public.teacher_publish_compare('$SID', jsonb_build_object('left', '$S1', 'reasons', jsonb_build_object('left', jsonb_build_array('ffffffff-0000-4000-8000-000000000001'))), (select rev from public.session_state where session_id = '$SID'))->>'ok'" | tail -1)
[ "$R" = "true" ] || fail "升級後無法公開升級前保存的快照：$R"
psql_ -d $DB3 -c "set role anon" -c "select public.projector_state('$SID', (select projector_key from public.sessions where id = '$SID'))::text" 2>/dev/null | grep -q "Phase 3 時的理由" \
  || { PK=$(psql_ -d $DB3 -c "select projector_key from public.sessions where id = '$SID'"); psql_ -d $DB3 -c "set role anon" -c "select public.projector_state('$SID', '$PK')::text" | grep -q "Phase 3 時的理由" || fail "投影沒有顯示升級前快照的理由"; }
echo "ok - 升級後可直接在 05 公開升級前保存的快照"
psql_ -d $DB3 -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "重複執行失敗"
verify_ok $DB3 || fail "重複執行後檢查未通過"
echo "ok - Phase 4 升級檔可重複執行（公開狀態保留：$(psql_ -d $DB3 -c "select (stage_ctl ? '05')::text from public.session_state where session_id = '$SID'")）"
# 回復到 Phase 3 再升級
for f in 002_rpc.sql 003_security.sql; do git -C "$ROOT" show "89299af:supabase/migrations/$f" > "$TMP/p3_$f"; chmod 644 "$TMP/p3_$f"; psql_ -d $DB3 -f "$TMP/p3_$f" >/dev/null 2>&1; done
psql_ -d $DB3 -f "$ROOT/supabase/rollback/phase4_to_phase3.sql" >/dev/null 2>&1
[ -z "$(psql_ -d $DB3 -c "select to_regprocedure('public.teacher_publish_compare(uuid,jsonb,bigint)')")" ] || fail "回復後 Phase 4 函式仍存在"
[ "$(psql_ -d $DB3 -c "select md5(string_agg(id || data::text || created_at, '|' order by id)) from public.group_snapshots")" = "$SNAPS" ] || fail "回復後快照改變"
psql_ -d $DB3 -f "$TMP/bundle.sql" >/dev/null 2>&1 || fail "回復後再升級失敗"
verify_ok $DB3 || fail "回復後再升級的檢查未通過"
echo "ok - 可回復到 Phase 3（快照不變）並再次升級到 Phase 4"
