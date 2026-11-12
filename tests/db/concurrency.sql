-- 多連線壓力測試的準備資料（由 concurrency.sh 呼叫）
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 't1@example.com');
insert into public.teachers (user_id, email) values ('11111111-1111-1111-1111-111111111111', 't1@example.com');
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false) as _ \gset
select public.teacher_create_session('壓力測試', 6) ->> 'join_code' as code \gset
select id as sid from public.sessions \gset
-- 六組 × 三位學生
select count(*) from (select public.student_join(:'code', md5('S' || g || '-' || s) || md5('x'), g)
  from generate_series(1, 6) g, generate_series(1, 3) s) x \gset
select public.teacher_set_stage(:'sid', '04', '04', '{"screen":"instruction"}', 1, false) ->> 'ok' as ok \gset
-- 每組兩個分類
select count(*) from (select public.group_add_category(:'sid', md5('S' || g || '-1') || md5('x')), public.group_add_category(:'sid', md5('S' || g || '-1') || md5('x'))
  from generate_series(1, 6) g) x \gset

create schema t;
create table t.log (kind text, ok boolean, code text, grp int, item text);
create table t.ctx as select :'sid'::uuid as sid;

-- 讀取目前版本後立即寫入：多個連線同時讀到相同版本時，只能有一個成功
create function t.bench_move(g int, s int, c int, k int) returns void language plpgsql as $$
declare v_sid uuid := (select sid from t.ctx); v_tok text := md5('S' || g || '-' || s) || md5('x');
        v_card uuid; v_cat uuid; v_gid uuid; v_rev bigint; r jsonb;
begin
  select id into v_gid from public.groups where session_id = v_sid and number = g;
  select id into v_card from public.story_cards order by sort_order offset c - 1 limit 1;
  select id into v_cat from public.group_categories where group_id = v_gid and label_no = k;
  select coalesce((select rev from public.group_placements where group_id = v_gid and card_id = v_card), 0) into v_rev;
  perform pg_sleep(random() * 0.003);
  r := public.group_move_card(v_sid, v_tok, v_card, case when k = 3 then null else v_cat end, v_rev);
  insert into t.log values ('move', (r->>'ok')::boolean, r->>'code', g, v_card::text);
end $$;

create function t.bench_name(g int, s int, k int) returns void language plpgsql as $$
declare v_sid uuid := (select sid from t.ctx); v_tok text := md5('S' || g || '-' || s) || md5('x');
        v_cat public.group_categories; v_gid uuid; r jsonb;
begin
  select id into v_gid from public.groups where session_id = v_sid and number = g;
  select * into v_cat from public.group_categories where group_id = v_gid and label_no = k;
  perform pg_sleep(random() * 0.003);
  r := public.group_update_category(v_sid, v_tok, v_cat.id, 'name', 'S' || s || '-' || to_char(clock_timestamp(), 'SSSS.US'), v_cat.name_rev);
  insert into t.log values ('name', (r->>'ok')::boolean, r->>'code', g, v_cat.id::text);
end $$;
