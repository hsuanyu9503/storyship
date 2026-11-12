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

# ---------- 六組同時完成並提交（6 個連線同時送出） ----------
psql_ -d "$DB" >/dev/null <<'SQL'
-- 每組：所有故事放進分類 1，兩個分類都命名、寫共同特色（版本取當下最新）
do $$
declare v_sid uuid := (select sid from t.ctx); g int; v_gid uuid; c record; k record; r jsonb; tok text;
begin
  for g in 1..6 loop
    tok := md5('S' || g || '-1') || md5('x');
    select id into v_gid from public.groups where session_id = v_sid and number = g;
    for c in select sc.id, coalesce(gp.rev, 0) rev from public.story_cards sc
               left join public.group_placements gp on gp.group_id = v_gid and gp.card_id = sc.id loop
      r := public.group_move_card(v_sid, tok, c.id, (select id from public.group_categories where group_id = v_gid and label_no = 1), c.rev);
    end loop;
    for k in select * from public.group_categories where group_id = v_gid loop
      perform public.group_update_category(v_sid, tok, k.id, 'name', '第' || g || '組分類' || k.label_no, k.name_rev);
      perform public.group_update_category(v_sid, tok, k.id, 'reason', '共同特色' || k.label_no, k.reason_rev);
    end loop;
  end loop;
end $$;
SQL
SID=$(psql_ -d "$DB" -t -A -c "select sid from t.ctx")
for g in 1 2 3 4 5 6; do
  REV=$(psql_ -d "$DB" -t -A -c "select board_rev from public.groups where session_id = '$SID' and number = $g")
  ( psql_ -d "$DB" -t -A -c "set role anon; select public.group_submit('$SID', md5('S$g-2') || md5('x'), $REV)->>'ok'" > "$HERE/.sub$g" 2>&1 ) &
  ( psql_ -d "$DB" -t -A -c "set role anon; select public.group_submit('$SID', md5('S$g-3') || md5('x'), $REV)->>'code'" > "$HERE/.sub${g}b" 2>&1 ) &
done
wait
cat "$HERE"/.sub* | grep -qi "deadlock" && { echo "FAIL: 同時提交發生死結"; exit 1; }
rm -f "$HERE"/.sub*
psql_ -d "$DB" <<'SQL'
do $$
declare n int; s int;
begin
  select count(*) into n from public.groups g join t.ctx on g.session_id = t.ctx.sid where g.status = 'submitted';
  select count(*) into s from public.group_snapshots gs join t.ctx on gs.session_id = t.ctx.sid where kind = 'submitted';
  if n <> 6 or s <> 6 then raise exception 'FAIL: 六組同時提交：已提交 % 組、快照 % 份（應各為 6）', n, s; end if;
  if exists (select 1 from public.group_snapshots gs join public.groups g on g.id = gs.group_id
              where gs.data->'categories'->0->>'name' not like '第' || g.number || '組%') then
    raise exception 'FAIL: 快照內容混到其他組';
  end if;
  raise notice 'ok - 六組（每組兩位組員）同時提交：6 組各一份快照，內容互不混雜，無死結';
end $$;
SQL
