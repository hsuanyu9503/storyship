#!/usr/bin/env bash
# 多連線同時操作測試：12 個連線、六組同時移動故事卡與修改分類名稱，
# 驗證「成功次數＝伺服器版本增加量」（沒有遺失更新、沒有舊資料覆蓋新資料）。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_conc}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql" "$HERE/concurrency.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null
done
as_pg pgbench -n -c 12 -j 4 -t ${TX:-150} -f "$HERE/bench_move.pgb@3" -f "$HERE/bench_name.pgb@1" "$DB" | grep -E 'transactions actually|failed|latency average'
psql_ -d "$DB" <<'SQL'
\pset footer off
select kind, ok, coalesce(code, '-') as code, count(*) from t.log group by 1, 2, 3 order by 1, 2, 3;
do $$
declare bad int;
begin
  -- 每張卡：成功移動次數 = 伺服器上的 rev
  select count(*) into bad from public.group_placements p
   where p.rev <> (select count(*) from t.log l where l.kind = 'move' and l.ok
                    and l.item = p.card_id::text
                    and l.grp = (select number from public.groups g where g.id = p.group_id));
  if bad > 0 then raise exception 'FAIL: % 張卡的版本與成功次數不一致', bad; end if;
  -- 每個分類：成功改名次數 + 1 = name_rev
  select count(*) into bad from public.group_categories c
   where c.name_rev <> 1 + (select count(*) from t.log l where l.kind = 'name' and l.ok and l.item = c.id::text);
  if bad > 0 then raise exception 'FAIL: % 個分類名稱版本不一致', bad; end if;
  -- 每組：board_rev = 2（建立兩個分類）+ 該組所有成功寫入
  select count(*) into bad from public.groups g
   where g.board_rev <> 2 + (select count(*) from t.log l where l.ok and l.grp = g.number);
  if bad > 0 then raise exception 'FAIL: % 組 board_rev 不一致', bad; end if;
  if not exists (select 1 from t.log where code = 'STALE') then raise exception 'FAIL: 沒有產生任何衝突，測試無效'; end if;
  raise notice 'ok - 多連線同時操作：沒有遺失更新，過期操作皆被拒絕';
end $$;
SQL
