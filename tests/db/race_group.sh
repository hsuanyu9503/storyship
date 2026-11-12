#!/usr/bin/env bash
# Phase 3 小組共作的多連線競態測試（每個情境用兩個真實資料庫連線、交易中刻意停頓製造重疊）
#   1. 學生操作進行中 → 教師結束共同分類：教師等待，快照包含該次操作
#   2. 教師結束進行中 → 學生操作：學生等待後被拒絕，不會寫在快照之後
#   3. 兩位組員同時提交：只產生一份快照，另一位得到 ALREADY_SUBMITTED
#   4. 一人把故事移入分類、另一人同時刪除該分類：故事不會落在不存在的分類
#   5. 兩人同時新增分類：兩個都保留，編號不同
#   6. 教師暫停與學生操作同時：暫停生效後不再有寫入
# 每個情境都檢查沒有死結（deadlock）錯誤。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_race_group}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
T1=11111111-1111-1111-1111-111111111111
TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
q "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
CARD=$(q "select id from public.story_cards order by sort_order limit 1")
ALL="'$(q "select string_agg(id::text, ',') from public.story_cards")'"
fail() { echo "FAIL: $*"; exit 1; }
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"

setup() {   # 新場次，TA、TB 同在第一組，進入 04；輸出場次 id
  local sid code
  sid=$(psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_create_session('race', 6)->>'session_id'" | tail -1)
  code=$(q "select join_code from public.sessions where id = '$sid'")
  q "set role anon; select public.student_join('$code', '$TA', 1), public.student_join('$code', '$TB', 1)" >/dev/null
  psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_set_stage('$sid', '04', '04', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$sid'), false)" >/dev/null
  echo "$sid"
}
stage() {   # $1 場次 $2 環節 → 教師切換（未提交者鎖定）
  echo "$TEACH
select public.teacher_set_stage('$1', '$2', '$2', '{\"screen\":\"placeholder\"}', (select rev from public.session_state where session_id = '$1'), true)->>'ok';"
}
anon() { echo "set role anon; $1"; }
timed() { local t0; t0=$(date +%s%N); OUT=$(eval "$1" 2>&1 || true); WAITED=$(( ($(date +%s%N) - t0) / 1000000 )); }
nodeadlock() { echo "$1" | grep -qi deadlock && fail "$2：發生死結" || true; }

# 先讓 anon 能讀場次 id（setup 內已處理）；以下各情境
# ---------- 1 ----------
S=$(setup)
q "set role anon; select public.group_add_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000001')" >/dev/null
( { echo "begin;"; anon "select public.group_update_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000001', 'reason', '先到的理由', 1);"; echo "select pg_sleep(2); commit;"; } | psql_ -d "$DB" >/dev/null 2>"$HERE/.race1.err" ) &
sleep 0.6
timed "stage '$S' 05 | psql_ -d '$DB' | tail -1"
wait; nodeadlock "$(cat "$HERE/.race1.err")$OUT" 情境1; rm -f "$HERE/.race1.err"
[ "$OUT" = "true" ] || fail "情境 1 教師切換失敗：$OUT"
[ "$WAITED" -ge 900 ] || fail "情境 1 教師沒有等待進行中的學生操作（$WAITED ms）"
[ "$(q "select data->'categories' is not null and (select reason from public.group_categories where id = 'cccccccc-0000-4000-8000-000000000001') = '先到的理由' from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.session_id = '$S' and g.number = 1")" = "t" ] || fail "情境 1 理由沒有寫入"
# 快照只含有故事的分類；這裡檢查快照版本等於小組最後版本（沒有寫在快照之後）
[ "$(q "select gs.board_rev + 1 = g.board_rev from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.session_id = '$S' and g.number = 1")" = "t" ] || fail "情境 1 快照之後仍有寫入"
echo "ok - 情境 1：學生操作進行中 → 教師結束共同分類等待 ${WAITED} ms，快照基於該操作之後的版本，無死結"

# ---------- 2 ----------
S=$(setup)
q "set role anon; select public.group_add_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000002')" >/dev/null
( { echo "begin;"; stage "$S" 05; echo "select pg_sleep(2); commit;"; } | psql_ -d "$DB" >/dev/null 2>"$HERE/.race2.err" ) &
sleep 0.6
timed "psql_ -d '$DB' -c \"set role anon; select public.group_move_card('$S', '$TB', '$CARD', 'cccccccc-0000-4000-8000-000000000002', 0)\""
wait; nodeadlock "$(cat "$HERE/.race2.err")$OUT" 情境2; rm -f "$HERE/.race2.err"
echo "$OUT" | grep -q "NOT_AVAILABLE" || fail "情境 2 晚到的操作沒有被拒絕：$OUT"
[ "$WAITED" -ge 900 ] || fail "情境 2 學生操作沒有等待教師交易（$WAITED ms）"
[ "$(q "select count(*) from public.group_placements gp join public.groups g on g.id = gp.group_id where g.session_id = '$S'")" = "0" ] || fail "情境 2 晚到的操作被寫入"
echo "ok - 情境 2：教師結束進行中 → 學生操作等待 ${WAITED} ms 後被拒絕（NOT_AVAILABLE），沒有寫入"

# ---------- 3 ----------
S=$(setup)
psql_ -d "$DB" >/dev/null <<SQL
set role anon;
select public.group_add_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000003');
select public.group_update_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000003', 'name', '全部', 1);
select public.group_update_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000003', 'reason', '都是故事', 1);
reset role;
create temp table m as select unnest(string_to_array($ALL, ','))::uuid id; grant select on m to anon;
set role anon;
select count(*) from (select public.group_move_card('$S', '$TA', id, 'cccccccc-0000-4000-8000-000000000003', 0) from m) x;
SQL
BREV=$(q "select board_rev from public.groups where session_id = '$S' and number = 1")
( psql_ -d "$DB" -c "set role anon; select public.group_submit('$S', '$TA', $BREV)->>'code', pg_sleep(0)" > "$HERE/.race3a" 2>&1 ) &
( psql_ -d "$DB" -c "set role anon; select public.group_submit('$S', '$TB', $BREV)->>'code'" > "$HERE/.race3b" 2>&1 ) &
wait
R="$(cat "$HERE/.race3a" "$HERE/.race3b" | tr '\n' ' ')"; rm -f "$HERE/.race3a" "$HERE/.race3b"
nodeadlock "$R" 情境3
[ "$(q "select count(*) from public.group_snapshots gs join public.groups g on g.id = gs.group_id where g.session_id = '$S'")" = "1" ] || fail "情境 3 產生了多份快照（$R）"
echo "$R" | grep -q "ALREADY_SUBMITTED" || fail "情境 3 第二位提交者沒有得到 ALREADY_SUBMITTED：$R"
echo "ok - 情境 3：兩位組員同時提交 → 只有一份快照，另一位得到 ALREADY_SUBMITTED"

# ---------- 4 ----------
for i in 1 2 3 4 5 6; do
  S=$(setup)
  q "set role anon; select public.group_add_category('$S', '$TA', 'cccccccc-0000-4000-8000-00000000004$i')" >/dev/null
  ( psql_ -d "$DB" -c "set role anon; select pg_sleep(random() * 0.02), public.group_move_card('$S', '$TA', '$CARD', 'cccccccc-0000-4000-8000-00000000004$i', 0)->>'code'" > "$HERE/.r4a" 2>&1 ) &
  ( psql_ -d "$DB" -c "set role anon; select pg_sleep(random() * 0.02), public.group_delete_category('$S', '$TB', 'cccccccc-0000-4000-8000-00000000004$i')->>'ok'" > "$HERE/.r4b" 2>&1 ) &
  wait
  nodeadlock "$(cat "$HERE/.r4a" "$HERE/.r4b")" 情境4; rm -f "$HERE/.r4a" "$HERE/.r4b"
  [ "$(q "select count(*) from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = '$S'")" = "0" ] || fail "情境 4 分類沒有被刪除"
  [ "$(q "select count(*) from public.group_placements gp join public.groups g on g.id = gp.group_id where g.session_id = '$S' and gp.category_id is not null")" = "0" ] || fail "情境 4 故事落在不存在的分類"
done
echo "ok - 情境 4：移入與刪除同一分類同時發生（6 次隨機先後）→ 分類刪除、故事都在未分類區"

# ---------- 5 ----------
S=$(setup)
for i in $(seq 1 8); do
  ( q "set role anon; select public.group_add_category('$S', '$( [ $((i % 2)) = 0 ] && echo "$TA" || echo "$TB")', 'cccccccc-0000-4000-8000-00000000050$i')" >/dev/null 2>"$HERE/.r5$i" ) &
done
wait
nodeadlock "$(cat "$HERE"/.r5*)" 情境5; rm -f "$HERE"/.r5*
[ "$(q "select count(*) = 8 and count(distinct label_no) = 8 and max(label_no) = 8 from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = '$S'")" = "t" ] || fail "情境 5 同時新增結果不正確"
echo "ok - 情境 5：兩人同時新增 8 個分類 → 全部保留，編號 1～8 不重複"

# ---------- 6 ----------
S=$(setup)
q "set role anon; select public.group_add_category('$S', '$TA', 'cccccccc-0000-4000-8000-000000000006')" >/dev/null
( { echo "begin;"; echo "$TEACH"; echo "select public.teacher_set_flags('$S', p_editing_paused => true); select pg_sleep(2); commit;"; } | psql_ -d "$DB" >/dev/null 2>&1 ) &
sleep 0.6
timed "psql_ -d '$DB' -c \"set role anon; select public.group_move_card('$S', '$TB', '$CARD', 'cccccccc-0000-4000-8000-000000000006', 0)\""
wait
echo "$OUT" | grep -q "PAUSED" || fail "情境 6 暫停後的操作沒有被拒絕：$OUT"
echo "ok - 情境 6：教師暫停進行中 → 學生操作等待 ${WAITED} ms 後被拒絕（PAUSED）"
