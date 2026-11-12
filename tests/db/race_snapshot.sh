#!/usr/bin/env bash
# 教師「結束個人分類」與學生「儲存」同時發生時的一致性（兩個真實資料庫連線）
#   情境 1：學生儲存交易先開始、尚未完成 → 教師切換必須等它完成，快照包含這次儲存
#   情境 2：教師切換交易先開始、尚未完成 → 學生儲存必須等待，之後被拒絕（不會寫入快照之後的資料）
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_race}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done

TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
T1=11111111-1111-1111-1111-111111111111
setup() {   # 建立新場次，兩位學生加入，進入 03；輸出場次 id
  psql_ -d "$DB" <<SQL
insert into auth.users (id, email) values ('$T1', 't1@example.com') on conflict do nothing;
insert into public.teachers (user_id, email) values ('$T1', 't1@example.com') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub', '$T1', false) \g /dev/null
create temp table c as select (public.teacher_create_session('race', 6)->>'session_id')::uuid sid;
select public.student_join(s.join_code, '$TA', 1), public.student_join(s.join_code, '$TB', 1)
  from public.sessions s join c on c.sid = s.id \g /dev/null
select public.teacher_set_stage(sid, '03', '03', '{"screen":"instruction"}', (select rev from public.session_state where session_id = sid), false) from c \g /dev/null
select sid from c;
SQL
}
card() { psql_ -d "$DB" -c "select id from public.story_cards order by sort_order limit 1"; }
CARD=$(card)
stage04() { echo "set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false) \\g /dev/null
select public.teacher_set_stage('$1', '04', '04', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$1'), false)->>'ok';"; }
save() { echo "select coalesce((select rev from public.personal_boards b join public.participants p on p.id = b.participant_id
    where p.session_id = '$1' and p.token_hash = encode(sha256(convert_to('$TA','UTF8')),'hex')), 0) as rv \\gset
set role anon; select public.student_save_personal('$1', '$TA',
  '{\"categories\":[{\"id\":\"c1\",\"no\":1,\"name\":\"$2\"}],\"placements\":{\"$CARD\":\"c1\"}}'::jsonb, :rv)->>'ok';"; }
fail() { echo "FAIL: $*"; exit 1; }

# ---------- 情境 1 ----------
S1=$(setup | tail -1)
( { echo "begin;"; save "$S1" "先到的儲存"; echo "select pg_sleep(2); commit;"; } | psql_ -d "$DB" >/dev/null ) &
sleep 0.6
t0=$(date +%s%N)
r=$(stage04 "$S1" | psql_ -d "$DB" | tail -1)
waited=$(( ($(date +%s%N) - t0) / 1000000 ))
wait
[ "$r" = "true" ] || fail "情境 1 教師切換失敗：$r"
[ "$waited" -ge 900 ] || fail "情境 1 教師切換沒有等待學生交易（${waited} ms）"
snap=$(psql_ -d "$DB" -c "select data->'categories'->0->>'name' from public.personal_snapshots s join public.participants p on p.id = s.participant_id where s.session_id = '$S1' and p.token_hash = encode(sha256(convert_to('$TA','UTF8')),'hex')")
[ "$snap" = "先到的儲存" ] || fail "情境 1 快照沒有包含先到的儲存（得到：$snap）"
echo "ok - 情境 1：學生儲存先開始 → 教師切換等待 ${waited} ms，快照包含該次儲存"

# ---------- 情境 2 ----------
S2=$(setup | tail -1)
( { echo "begin;"; stage04 "$S2"; echo "select pg_sleep(2); commit;"; } | psql_ -d "$DB" >/dev/null ) &
sleep 0.6
t0=$(date +%s%N)
out=$(save "$S2" "晚到的儲存" | psql_ -d "$DB" 2>&1 || true)
waited=$(( ($(date +%s%N) - t0) / 1000000 ))
wait
echo "$out" | grep -q "NOT_AVAILABLE" || fail "情境 2 晚到的儲存沒有被拒絕：$out"
[ "$waited" -ge 900 ] || fail "情境 2 學生儲存沒有等待教師交易（${waited} ms）"
n=$(psql_ -d "$DB" -c "select count(*) from public.personal_boards b where b.session_id = '$S2' and b.data::text like '%晚到的儲存%'")
[ "$n" = "0" ] || fail "情境 2 晚到的資料被寫入草稿"
echo "ok - 情境 2：教師切換先開始 → 學生儲存等待 ${waited} ms 後被拒絕（NOT_AVAILABLE），沒有寫入"
