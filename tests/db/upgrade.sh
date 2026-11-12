#!/usr/bin/env bash
# 升級測試：以 Phase 1 版本（git 標記 PHASE1_REF，預設 main 上第一版）建立資料庫並放入上課中的資料，
# 再依 docs/DEPLOY.md 的升級步驟執行新版 002 → 003 → seed，確認既有資料完全保留且新功能可用。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_upgrade}
REF=${PHASE1_REF:-5e850ad}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
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

T1=11111111-1111-1111-1111-111111111111
TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
# Phase 1 版本中進行到 03、兩位學生各有草稿（一位已提交）
psql_ -d "$DB" >/dev/null <<SQL
insert into auth.users (id, email) values ('$T1', 't1@example.com');
insert into public.teachers (user_id, email) values ('$T1', 't1@example.com');
set role authenticated;
select set_config('request.jwt.claim.sub', '$T1', false);
create temp table c as select (public.teacher_create_session('upgrade', 6)->>'session_id')::uuid sid;
grant select on c to anon;
select public.student_join(s.join_code, '$TA', 1), public.student_join(s.join_code, '$TB', 2) from public.sessions s join c on c.sid = s.id;
select public.teacher_set_stage(sid, '03', '03', '{"screen":"instruction"}', (select rev from public.session_state where session_id = sid), false) from c;
reset role;
create temp table allc as select jsonb_object_agg(id, 'c1') pl from public.story_cards;
grant select on allc to anon;
set role anon;
select public.student_save_personal(sid, '$TA', jsonb_build_object('categories', '[{"id":"c1","no":1,"name":"全部"}]'::jsonb,
  'placements', (select pl from allc)), 0) from c;
select public.student_submit_personal(sid, '$TA', 1) from c;
select public.student_save_personal(sid, '$TB', '{"categories":[{"id":"x","no":1,"name":""}],"placements":{}}', 0) from c;
reset role;
SQL
before=$(psql_ -d "$DB" -c "select md5(string_agg(t, '|' order by t)) from (
  select 's' || id || title || join_code || status as t from public.sessions union all
  select 'p' || id || group_id || seat_label || status from public.participants union all
  select 'b' || participant_id || data::text || rev || coalesce(submitted_at::text, '') from public.personal_boards union all
  select 'g' || id || number || status || board_rev from public.groups union all
  select 'st' || session_id || phase || rev from public.session_state) x")

# ---------- 升級（docs/DEPLOY.md「從 Phase 1 升級」）----------
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql" "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
after=$(psql_ -d "$DB" -c "select md5(string_agg(t, '|' order by t)) from (
  select 's' || id || title || join_code || status as t from public.sessions union all
  select 'p' || id || group_id || seat_label || status from public.participants union all
  select 'b' || participant_id || data::text || rev || coalesce(submitted_at::text, '') from public.personal_boards union all
  select 'g' || id || number || status || board_rev from public.groups union all
  select 'st' || session_id || phase || rev from public.session_state) x")
[ "$before" = "$after" ] || { echo "FAIL: 升級後既有資料改變"; exit 1; }
echo "ok - 升級後既有場次、學生、分組、個人草稿、課堂狀態完全不變"

# 上課中的場次在升級後可直接繼續：B 繼續儲存、教師結束個人分類、快照建立、鎖定生效
SID=$(psql_ -d "$DB" -c "select id from public.sessions limit 1")
r=$(psql_ -d "$DB" <<SQL
set role anon;
select public.student_save_personal('$SID', '$TB',
  '{"categories":[{"id":"x","no":1,"name":"升級後繼續"}],"placements":{}}', 1)->>'ok';
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '$T1', false) \g /dev/null
select public.teacher_set_stage('$SID', '04', '04', '{"screen":"instruction"}', (select rev from public.session_state where session_id = '$SID'), false)->>'ok';
reset role;
set role anon;
select (public.student_state('$SID', '$TB')->'personal'->>'locked');
reset role;
select count(*) from public.personal_snapshots;
select count(*) from public.story_cards where char_length(detail) > 150;
SQL
)
[ "$(echo "$r" | tr '\n' ' ')" = "true true true 2 8 " ] || { echo "FAIL: 升級後功能檢查：$r"; exit 1; }
echo "ok - 升級後上課中的場次可繼續操作；結束個人分類後建立快照並鎖定；測試故事文字已更新"
# 重跑一次升級步驟（可重複執行）
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql" "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
echo "ok - 升級 SQL 可重複執行"

# ---------- 回復到 Phase 1（docs/DEPLOY.md「回復方式」）----------
for f in "$TMP/002_rpc.sql" "$TMP/003_security.sql" "$ROOT/supabase/rollback/phase2_to_phase1.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
r=$(psql_ -d "$DB" <<SQL
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname in ('personal_closed', 'is_temp_name');
set role anon;
select public.student_state('$SID', '$TB')->'state'->>'phase';
reset role;
select count(*) from public.personal_snapshots;
SQL
)
[ "$(echo "$r" | tr '\n' ' ')" = "0 04 2 " ] || { echo "FAIL: 回復到 Phase 1 後檢查：$r"; exit 1; }
echo "ok - 可回復到 Phase 1 函式版本，資料（含快照）保留"
for f in "$ROOT/supabase/migrations/002_rpc.sql" "$ROOT/supabase/migrations/003_security.sql"; do psql_ -d "$DB" -f "$f" >/dev/null; done
[ "$(psql_ -d "$DB" -c "set role anon; select public.student_state('$SID', '$TB')->'personal'->>'locked';" | tail -1)" = "true" ] || { echo "FAIL: 再次升級"; exit 1; }
echo "ok - 回復後可再次升級到 Phase 2"
