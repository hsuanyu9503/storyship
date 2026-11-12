-- 故事找朋友｜Phase 4（05 成果比較、06 揭露紀錄、07 對照）的資料庫測試
-- run.sh 在 tests_group.sql 之後執行；沿用 t schema。使用獨立的新場次。
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
\set T1 '11111111-1111-1111-1111-111111111111'
\set T3 '33333333-3333-3333-3333-333333333333'

-- ---------- 準備：場次、四組學生、03 → 04、各組成果 ----------
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select (r->>'session_id') as rs, (r->>'join_code') as rcode from (select public.teacher_create_session('成果展示測試', 6) r) x \gset
select projector_key as rpk from public.sessions where id = :'rs' \gset
-- 另一個場次（跨場次 ID 測試用）
select (r->>'session_id') as os from (select public.teacher_create_session('另一個場次', 6) r) x \gset
reset role;
select md5('R4-1') || md5('x') as "v1", md5('R4-2') || md5('x') as "v2", md5('R4-3') || md5('x') as "v3",
       md5('R4-5') || md5('x') as "v5" \gset
set role anon;
select public.student_join(:'rcode', :'v1', 1), public.student_join(:'rcode', :'v2', 2),
       public.student_join(:'rcode', :'v3', 3), public.student_join(:'rcode', :'v5', 5) is not null as j \gset
reset role;
create temp table rcards as select id, slug from public.story_cards;
grant select on rcards to anon;
select id as ka from rcards where slug = 'story-a' \gset
select id as kb from rcards where slug = 'story-b' \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select public.teacher_set_stage(:'rs', '04', '04', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;

-- 第 1 組：兩個分類、長名稱與長理由，全部分類後正式提交
set role anon;
select public.group_add_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000001') is not null as x \gset
select public.group_add_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000002') is not null as x \gset
select count(*) from (select public.group_move_card(:'rs', :'v1', id,
  case when slug in ('story-a', 'story-c', 'story-f') then '41000000-0000-4000-8000-000000000001'::uuid else '41000000-0000-4000-8000-000000000002'::uuid end, 0)
  from rcards) x \gset
select public.group_update_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000001', 'name', '主角擁有神奇力量而且會去很遠的地方冒險', 1) is not null as x \gset
select public.group_update_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000001', 'reason', '第一組的祕密理由：這些故事都有魔法，主角都靠神奇的力量解決問題，而且故事發生在想像出來的世界。', 1) is not null as x \gset
select public.group_update_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000002', 'name', '尋找答案', 1) is not null as x \gset
select public.group_update_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000002', 'reason', '第一組第二個理由', 1) is not null as x \gset
select (public.student_group_board(:'rs', :'v1')->>'board_rev')::bigint as b1 \gset
select t.ok((public.group_submit(:'rs', :'v1', :b1)->>'ok')::boolean, 'P4 準備：第 1 組正式提交');
-- 第 2 組：未命名的分類、故事 A 未分類（之後由教師結束保存）
select public.group_add_category(:'rs', :'v2', '42000000-0000-4000-8000-000000000001') is not null as x \gset
select public.group_move_card(:'rs', :'v2', :'kb', '42000000-0000-4000-8000-000000000001', 0) is not null as x \gset
select public.group_update_category(:'rs', :'v2', '42000000-0000-4000-8000-000000000001', 'reason', '第二組還沒寫完的理由', 1) is not null as x \gset
-- 第 5 組：六個分類（測試分頁）
select count(*) from (select public.group_add_category(:'rs', :'v5', ('45000000-0000-4000-8000-00000000000' || n)::uuid) from generate_series(1, 6) n) x \gset
reset role;
create temp table m5 as select sc.id, ('45000000-0000-4000-8000-00000000000' || (1 + (row_number() over (order by sort_order) - 1) % 6))::uuid cat from public.story_cards sc;
grant select on m5 to anon;
set role anon;
select count(*) from (select public.group_move_card(:'rs', :'v5', id, cat, 0) from m5) x \gset
reset role;
-- 第 4 組：沒有學生；以 Phase 1／2 舊格式直接寫入一份快照（相容讀取測試）
select id as g4 from public.groups where session_id = :'rs' and number = 4 \gset
insert into public.group_snapshots (group_id, session_id, kind, data, is_complete, board_rev)
values (:'g4', :'rs', 'submitted', jsonb_build_object(
  'categories', jsonb_build_array(jsonb_build_object('id', '44000000-0000-4000-8000-000000000001', 'label_no', 1, 'name', '舊格式分類', 'reason', '舊格式理由', 'name_rev', 2, 'reason_rev', 2),
                                  jsonb_build_object('id', '44000000-0000-4000-8000-000000000002', 'label_no', 2, 'name', '', 'reason', '', 'name_rev', 1, 'reason_rev', 1)),
  'placements', (select jsonb_agg(jsonb_build_object('card_id', id, 'category_id', '44000000-0000-4000-8000-000000000001', 'rev', 1)) from public.story_cards)), true, 9);

-- 進入 05（未提交的組由教師結束保存）
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select t.ok((public.teacher_set_stage(:'rs', '05', '05', '{"screen":"placeholder","title":"分類成果大公開"}', :r, true)->>'ok')::boolean, 'P4：進入 05');
reset role;
select id as s1 from public.group_snapshots where session_id = :'rs' and group_id = (select id from public.groups where session_id = :'rs' and number = 1) \gset
select id as s2 from public.group_snapshots where session_id = :'rs' and group_id = (select id from public.groups where session_id = :'rs' and number = 2) \gset
select id as s4 from public.group_snapshots where session_id = :'rs' and group_id = :'g4' and board_rev = 9 \gset
select id as s5 from public.group_snapshots where session_id = :'rs' and group_id = (select id from public.groups where session_id = :'rs' and number = 5) \gset
select t.ok((select kind from public.group_snapshots where id = :'s1') = 'submitted' and (select kind from public.group_snapshots where id = :'s2') = 'locked',
            'P4 準備：第 1 組為正式提交、第 2 組為教師結束保存');
-- 之後的展示操作都不得修改的資料
create table t.p4_snaps as select id, md5(data::text || kind || is_complete || board_rev || created_at) h from public.group_snapshots where session_id = :'rs';
create view t.p4_work as select md5(coalesce(string_agg(x, '|' order by x), '')) h from (
  select 'gc' || gc.id || gc.name || gc.reason || gc.name_rev || gc.reason_rev x from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = :'rs' union all
  select 'gp' || gp.group_id || gp.card_id || coalesce(gp.category_id::text, '') || gp.rev from public.group_placements gp join public.groups g on g.id = gp.group_id where g.session_id = :'rs' union all
  select 'pb' || participant_id || data::text || rev from public.personal_boards where session_id = :'rs' union all
  select 'ps' || participant_id || data::text from public.personal_snapshots where session_id = :'rs') z;
create table t.p4_work0 as select h from t.p4_work;

-- ======================================================================
-- 05：預覽不改變公開狀態；公開後投影與預覽一致
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r0, projection::text as pj0 from public.session_state where session_id = :'rs' \gset
select public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s1', 'right', :'s2', 'story', :'ka',
  'reasons', jsonb_build_object('left', jsonb_build_array('41000000-0000-4000-8000-000000000001')))) as pv \gset
select t.ok((select rev = :r0 and projection::text = :'pj0' from public.session_state where session_id = :'rs'), 'P4：教師私下預覽不改變投影與版本');
select t.ok((:'pv'::jsonb -> 'projection' ->> 'screen') = 'compare' and jsonb_array_length(:'pv'::jsonb -> 'projection' -> 'sides') = 2, 'P4：預覽回傳雙組比較');
reset role;
set role anon;
select t.ok(public.projector_state(:'rs', :'rpk')::text not like '%第一組的祕密理由%', 'P4：預覽後投影端仍看不到任何成果');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
-- 預設：理由全部不公開
select t.ok((public.teacher_publish_compare(:'rs', jsonb_build_object('left', :'s1', 'right', :'s2', 'story', :'ka'), :r0)->>'ok')::boolean, 'P4：公開比較');
reset role;
set role anon;
select public.projector_state(:'rs', :'rpk') as pub \gset
select t.ok((:'pub'::jsonb -> 'projection' ->> 'screen') = 'compare', 'P4：投影顯示比較畫面');
select t.ok(:'pub'::text not like '%祕密理由%' and :'pub'::text not like '%第一組第二個理由%' and :'pub'::text not like '%還沒寫完%',
            'P4：理由預設不公開——內容不在投影 API 回應中');
select t.ok(:'pub'::text not like '%41000000-%' and :'pub'::text not like '%' || :'s1' || '%' and :'pub'::text not like '%' || :'ka' || '%',
            'P4：投影資料不含分類、快照、故事的 ID');
select t.ok((:'pub'::jsonb #>> '{projection,sides,0,categories,0,reason_state}') = 'hidden', 'P4：未揭露的理由只標示 hidden');
select t.ok((:'pub'::jsonb #>> '{projection,sides,0,categories,0,label}') = '主角擁有神奇力量而且會去很遠的地方冒險', 'P4：長名稱完整保留');
-- 故事追蹤：第 1 組在分類中、第 2 組未分類
select t.ok((:'pub'::jsonb #>> '{projection,sides,0,track,where}') = '主角擁有神奇力量而且會去很遠的地方冒險'
            and (:'pub'::jsonb #>> '{projection,sides,1,track,unplaced}')::boolean, 'P4：指定故事在第 1 組的分類位置，在第 2 組為尚未分類');
select t.ok((select count(*) from jsonb_array_elements(:'pub'::jsonb #> '{projection,sides,0,categories,0,cards}') c where (c->>'tracked')::boolean) = 1,
            'P4：指定故事在卡片上標示（只標示一張）');
select t.ok((:'pub'::jsonb #>> '{projection,sides,1,categories,0,unnamed}')::boolean and (:'pub'::jsonb #>> '{projection,sides,1,categories,0,label}') = '分類 1',
            'P4：未命名的分類以「分類 N」呈現並標示未命名');
select t.ok((:'pub'::jsonb #>> '{projection,sides,0,kind}') = 'submitted' and (:'pub'::jsonb #>> '{projection,sides,1,kind}') = 'locked'
            and not (:'pub'::jsonb #>> '{projection,sides,1,complete}')::boolean, 'P4：區分正式提交與教師結束保存（未完成）');
select t.ok((:'pub'::jsonb #>> '{projection,sides,1,unplaced_count}')::int = 7, 'P4：顯示未分類的故事數量（第 2 組 7 張）');
reset role;

-- 揭露左側一個理由
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select t.ok((public.teacher_publish_compare(:'rs', jsonb_build_object('left', :'s1', 'right', :'s2', 'story', :'ka',
  'reasons', jsonb_build_object('left', jsonb_build_array('41000000-0000-4000-8000-000000000001'))), :r)->>'ok')::boolean, 'P4：揭露左側第一個分類的理由');
reset role;
set role anon;
select public.projector_state(:'rs', :'rpk') as pub \gset
select t.ok(:'pub'::text like '%第一組的祕密理由%' and :'pub'::text not like '%第一組第二個理由%' and :'pub'::text not like '%還沒寫完%',
            'P4：只有揭露的那一個理由出現在投影資料中');
reset role;

-- 驗證與衝突
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select t.raises(format($$select public.teacher_publish_compare(%L, %L, %s)$$, :'rs', jsonb_build_object('left', :'s1', 'right', :'s1'), :r), 'SAME_GROUP', 'P4：同一組不能同時放在兩側');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'rs', jsonb_build_object('left', :'s1', 'reasons', jsonb_build_object('left', jsonb_build_array('42000000-0000-4000-8000-000000000001')))), 'BAD_DATA', 'P4：理由只能揭露該側快照中的分類');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'rs', jsonb_build_object('left', :'s5', 'page', jsonb_build_object('left', 5))), 'BAD_DATA', 'P4：不存在的頁數被拒絕');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'rs', jsonb_build_object('left', :'s1', 'focus', jsonb_build_object('left', '45000000-0000-4000-8000-000000000001'))), 'BAD_DATA', 'P4：聚焦只能選該側的分類');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'rs', jsonb_build_object('left', 'not-a-uuid')), 'BAD_DATA', 'P4：不合法的 ID 被拒絕');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'os', jsonb_build_object('left', :'s1')), 'BAD_DATA', 'P4：其他場次不能使用這個場次的快照');
select t.raises(format($$select public.teacher_preview_compare(%L, %L)$$, :'rs', jsonb_build_object('story', gen_random_uuid())), 'BAD_DATA', 'P4：不屬於本場素材的故事被拒絕');
select t.ok((public.teacher_publish_compare(:'rs', jsonb_build_object('left', :'s1'), :r - 1)->>'code') = 'STALE', 'P4：過期的公開請求被拒絕（兩台教師裝置）');
select t.raises(format($$select public.teacher_publish_compare(%L, '{}', null)$$, :'rs'), 'BAD_DATA', 'P4：版本號為 null 被拒絕');
select t.raises(format($$select public.teacher_set_stage(%L, '05', '05', '{"screen":"compare","sides":[]}', %s, false)$$, :'rs', :r), 'BAD_DATA', 'P4：不能以一般環節切換塞入自組的成果畫面');
-- 單組、無成果、分頁、聚焦、舊格式
select t.ok(jsonb_array_length(public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s1')) -> 'projection' -> 'sides') = 1, 'P4：只選一組時單組展示');
select t.ok(jsonb_array_length(public.teacher_preview_compare(:'rs', '{}') -> 'projection' -> 'sides') = 0, 'P4：沒有選任何成果時為空狀態（不產生假成果）');
select t.ok((public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s5')) #>> '{projection,sides,0,pages}')::int = 2
            and jsonb_array_length(public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s5')) #> '{projection,sides,0,categories}') = 4
            and jsonb_array_length(public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s5', 'page', jsonb_build_object('left', 1))) #> '{projection,sides,0,categories}') = 2,
            'P4：六個分類分成兩頁（每頁 4 個），由教師翻頁');
select t.ok(jsonb_array_length(public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s1', 'focus', jsonb_build_object('left', '41000000-0000-4000-8000-000000000002'))) #> '{projection,sides,0,categories}') = 1,
            'P4：聚焦單一分類');
select public.teacher_preview_compare(:'rs', jsonb_build_object('left', :'s4', 'reasons', jsonb_build_object('left', jsonb_build_array('44000000-0000-4000-8000-000000000001')))) as old \gset
select t.ok((:'old'::jsonb #>> '{projection,sides,0,categories,0,label}') = '舊格式分類' and jsonb_array_length(:'old'::jsonb #> '{projection,sides,0,categories}') = 1
            and jsonb_array_length(:'old'::jsonb #> '{projection,sides,0,categories,0,cards}') = 8 and (:'old'::jsonb #>> '{projection,sides,0,categories,0,reason}') = '舊格式理由',
            'P4：Phase 1／2 舊格式快照可相容讀取（空分類不顯示）');
reset role;

-- 權限：其他教師、匿名、學生
set role authenticated;
select set_config('request.jwt.claim.sub', :'T3', false) as _ \gset
select t.raises(format($$select public.teacher_preview_compare(%L, '{}')$$, :'rs'), 'FORBIDDEN', 'P4：其他教師不能預覽此場次');
select t.raises(format($$select public.teacher_publish_compare(%L, '{}', 1)$$, :'rs'), 'FORBIDDEN', 'P4：其他教師不能公開此場次');
select t.raises(format($$select public.teacher_preview_match(%L, '{}')$$, :'rs'), 'FORBIDDEN', 'P4：其他教師不能預覽 07');
select t.ok((select count(*) from public.session_state where session_id = :'rs') = 0, 'P4：其他教師讀不到此場次的公開選擇（stage_ctl）');
reset role;
set role anon;
select t.raises(format($$select public.teacher_preview_compare(%L, '{}')$$, :'rs'), 'DENIED', 'P4：匿名（學生、投影）不能呼叫預覽');
select t.raises(format($$select public.teacher_publish_match(%L, '{}', 1)$$, :'rs'), 'DENIED', 'P4：匿名不能呼叫公開');
select t.raises('select * from public.group_snapshots', 'DENIED', 'P4：匿名不能直接讀小組快照');
select t.ok((public.student_state(:'rs', :'v1')->'state') ? 'phase' and (public.student_state(:'rs', :'v1'))::text not like '%祕密理由%', 'P4：學生狀態不含任何展示內容');
reset role;

select t.ok((select h from t.p4_work) = (select h from t.p4_work0), 'P4：05 的預覽、公開、揭露、追蹤、驗證失敗都沒有修改小組與個人資料');
select t.ok(not exists (select 1 from t.p4_snaps b left join public.group_snapshots gs on gs.id = b.id
                         where gs.id is null or md5(gs.data::text || gs.kind || gs.is_complete || gs.board_rev || gs.created_at) <> b.h), 'P4：05 操作後所有快照內容不變');

-- ======================================================================
-- 公開綁定快照：重新開放、再次提交不會偷偷改變已公開內容
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select public.teacher_set_stage(:'rs', '04', '04', '{"screen":"instruction"}', :r, false) is not null as x \gset
select public.teacher_unlock_group((select id from public.groups where session_id = :'rs' and number = 1)) is null as x \gset
reset role;
set role anon;
select public.group_update_category(:'rs', :'v1', '41000000-0000-4000-8000-000000000001', 'reason', '重新開放後改寫的理由', 3) is not null as x \gset
select (public.student_group_board(:'rs', :'v1')->>'board_rev')::bigint as b1 \gset
select t.ok((public.group_submit(:'rs', :'v1', :b1)->>'ok')::boolean, 'P4：重新開放後再次提交（產生新快照）');
reset role;
select t.ok((select count(*) from public.group_snapshots where group_id = (select id from public.groups where session_id = :'rs' and number = 1)) = 2, 'P4：第 1 組有兩份快照');
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select t.ok((public.teacher_set_stage(:'rs', '05', '05', '{"screen":"placeholder","title":"分類成果大公開"}', :r, true)->>'ok')::boolean, 'P4：返回 05');
reset role;
set role anon;
select public.projector_state(:'rs', :'rpk') as pub \gset
select t.ok((:'pub'::jsonb -> 'projection' ->> 'screen') = 'compare' and :'pub'::text like '%第一組的祕密理由%' and :'pub'::text not like '%重新開放後改寫%',
            'P4：返回 05 時依原本綁定的快照重建公開畫面（不改抓最新快照）');
reset role;

-- ======================================================================
-- 06 揭露紀錄 → 07 對照
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select public.teacher_set_stage(:'rs', '06', '06-02', '{"screen":"genre","view":"genre","ctl":{"view":"genre","index":2,"revealed":[0,2]}}', :r, false) is not null as x \gset
select t.ok((select disclosure -> 'genres' from public.session_state where session_id = :'rs') = '[0, 2]'::jsonb, 'P4：06 公開的類型記錄在伺服器（跨環節保存）');
select rev as r from public.session_state where session_id = :'rs' \gset
select t.raises(format($$select public.teacher_set_stage(%L, '06', '06-02', '{"screen":"genre","ctl":{"revealed":[99]}}', %s, false)$$, :'rs', :r), 'BAD_DATA', 'P4：不存在的類型索引被拒絕');
select rev as r from public.session_state where session_id = :'rs' \gset
select t.ok((public.teacher_set_stage(:'rs', '07', '07', '{"screen":"placeholder","title":"小小故事分類師"}', :r, false)->>'ok')::boolean, 'P4：進入 07');
select t.ok((select disclosure -> 'genres' from public.session_state where session_id = :'rs') = '[0, 2]'::jsonb, 'P4：進入 07 不會無條件公開全部類型');
reset role;
set role anon;
select t.ok(public.projector_state(:'rs', :'rpk')::text not like '%偵探小說%' and public.projector_state(:'rs', :'rpk')::text not like '%神祕案件%', 'P4：07 起始投影不含未公開的類型與要素');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r0, projection::text as pj0 from public.session_state where session_id = :'rs' \gset
select public.teacher_preview_match(:'rs', jsonb_build_object('snapshot', :'s2', 'category', '42000000-0000-4000-8000-000000000001', 'genre', 1, 'elements', '[0,1,2]'::jsonb)) is not null as x \gset
select t.ok((select rev = :r0 and projection::text = :'pj0' from public.session_state where session_id = :'rs'), 'P4：07 私下預覽類型與要素不改變投影');
-- 公開：分類＋類型（只揭露第 0 個要素並標示）
select t.ok((public.teacher_publish_match(:'rs', jsonb_build_object('snapshot', :'s2', 'category', '42000000-0000-4000-8000-000000000001',
  'genre', 1, 'elements', '[0]'::jsonb, 'highlights', '[0]'::jsonb, 'scaffold', true), :r0)->>'ok')::boolean, 'P4：公開 07 對照');
reset role;
set role anon;
select public.projector_state(:'rs', :'rpk') as pub \gset
select t.ok((:'pub'::jsonb #>> '{projection,genre,name}') = '偵探小說' and :'pub'::text like '%神祕案件%'
            and :'pub'::text not like '%尋找線索%' and :'pub'::text not like '%推理解謎%', 'P4：只有揭露的要素出現在投影資料中');
select t.ok((:'pub'::jsonb #>> '{projection,genre,elements,0,highlight}')::boolean and not (:'pub'::jsonb #>> '{projection,genre,elements,1,revealed}')::boolean,
            'P4：相似要素標示；未揭露的要素只有位置');
select t.ok(:'pub'::text not like '%教師補充%' and :'pub'::text not like '%還沒寫完%', 'P4：不含教師補充資料；理由未顯示時不含內容');
select t.ok((:'pub'::jsonb #>> '{projection,scaffold}')::boolean and (:'pub'::jsonb #>> '{projection,category,label}') = '分類 1', 'P4：句型鷹架顯示；未命名分類以「分類 N」呈現');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.ok((select disclosure -> 'genres' from public.session_state where session_id = :'rs') = '[0, 1, 2]'::jsonb, 'P4：在 07 公開的類型加入揭露紀錄');
select rev as r from public.session_state where session_id = :'rs' \gset
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('genre', 1, 'elements', '[0]'::jsonb, 'highlights', '[1]'::jsonb)), 'BAD_DATA', 'P4：不能標示尚未揭露的要素');
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('genre', 1, 'elements', '[3]'::jsonb)), 'BAD_DATA', 'P4：不合法的要素索引被拒絕');
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('genre', 1, 'elements', '[0,0]'::jsonb)), 'BAD_DATA', 'P4：重複的要素索引被拒絕');
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('genre', 9)), 'BAD_DATA', 'P4：不存在的類型被拒絕');
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('elements', '[0]'::jsonb)), 'BAD_DATA', 'P4：沒有選類型時不能揭露要素');
select t.raises(format($$select public.teacher_preview_match(%L, %L)$$, :'rs', jsonb_build_object('snapshot', :'s1', 'category', '42000000-0000-4000-8000-000000000001')), 'BAD_DATA', 'P4：分類必須屬於選定的快照');
select t.raises(format($$select public.teacher_publish_compare(%L, '{}', %s)$$, :'rs', :r), 'NOT_AVAILABLE', 'P4：07 環節不能公開 05 的比較');
-- 允許不選類型
select (public.teacher_publish_match(:'rs', jsonb_build_object('snapshot', :'s1', 'category', '41000000-0000-4000-8000-000000000002'), :r)->>'ok') as okm \gset
select t.ok(:'okm'::boolean and (select projection -> 'genre' from public.session_state where session_id = :'rs') = 'null'::jsonb, 'P4：可以只公開分類、不選任何類型');
reset role;

-- ======================================================================
-- 結束：全程沒有修改任何原始資料或快照（第 1 組再次提交產生的新快照除外）
-- ======================================================================
select t.ok(not exists (select 1 from t.p4_snaps b left join public.group_snapshots gs on gs.id = b.id
                         where gs.id is null or md5(gs.data::text || gs.kind || gs.is_complete || gs.board_rev || gs.created_at) <> b.h),
            'P4：全部流程後（含 07、返回、結束），05 前的每一份快照仍逐位元組相同');
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'rs' \gset
select public.teacher_set_stage(:'rs', '99', '99', '{"screen":"end"}', :r, false) is not null as x \gset
select public.teacher_end_session(:'rs') is null as x \gset
reset role;
select t.ok((select count(*) from public.group_snapshots where session_id = :'rs') = 8, 'P4：前進、結束場次後成果快照全部保留（8 份）');
delete from public.sessions where id in (:'rs', :'os');

\pset tuples_only off
select count(*) as "全部通過的檢查數（含 Phase 4）" from t.passes;
