-- 故事找朋友｜Phase 3 小組共作的資料庫測試（run.sh 在 tests.sql 之後執行；沿用 t schema 的測試工具）
-- 使用獨立的新場次：六組、第一組四位學生（其中一位在第四環節才加入）
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
\set T1 '11111111-1111-1111-1111-111111111111'
\set T3 '33333333-3333-3333-3333-333333333333'

set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select (r->>'session_id') as gs, (r->>'join_code') as gcode from (select public.teacher_create_session('小組共作測試', 6) r) x \gset
reset role;
select md5('P3-1a') || md5('x') as "u1a", md5('P3-1b') || md5('x') as "u1b", md5('P3-1c') || md5('x') as "u1c",
       md5('P3-1d') || md5('x') as "u1d", md5('P3-2a') || md5('x') as "u2a" \gset
set role anon;
select public.student_join(:'gcode', :'u1a', 1) is not null as j \gset
select public.student_join(:'gcode', :'u1b', 1) is not null as j \gset
select public.student_join(:'gcode', :'u1c', 1) is not null as j \gset
select public.student_join(:'gcode', :'u2a', 2) is not null as j \gset
reset role;
select id as gcard_a from public.story_cards where slug = 'story-a' \gset
select id as gcard_b from public.story_cards where slug = 'story-b' \gset

-- 03：1a 完成個人分類（全部放進一類並命名），1b 只放一張
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'gs' \gset
select public.teacher_set_stage(:'gs', '03', '03', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;
create temp table allcards as select jsonb_object_agg(id, 'c1') pl from public.story_cards;
grant select on allcards to anon;
set role anon;
select public.student_save_personal(:'gs', :'u1a', jsonb_build_object('categories', '[{"id":"c1","no":1,"name":"我的想法"}]'::jsonb,
  'placements', (select pl from allcards)), 0) is not null as x \gset
select public.student_submit_personal(:'gs', :'u1a', 1) is not null as x \gset
select public.student_save_personal(:'gs', :'u1b', format('{"categories":[{"id":"k","no":1,"name":""}],"placements":{"%s":"k"}}', :'gcard_a')::jsonb, 0) is not null as x \gset
-- 複檢：版本號傳 null 不能跳過版本檢查
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{}}', null)$$, :'gs', :'u1b'), 'BAD_DATA', '複檢：個人儲存的版本號為 null 被拒絕');
select t.raises(format($$select public.student_submit_personal(%L, %L, null)$$, :'gs', :'u1b'), 'BAD_DATA', '複檢：個人提交的版本號為 null 被拒絕');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.raises(format($$select public.teacher_set_stage(%L, '02', '02', '{"screen":"task"}', null, false)$$, :'gs'), 'BAD_DATA', '複檢：環節切換的版本號為 null 被拒絕');
reset role;
create table t.p3_personal_before as select participant_id, data, rev from public.personal_boards where session_id = :'gs';

-- ======================================================================
-- 3A：進入 04 — 同組只有一份工作區、從空白開始、個人快照不變
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'gs' \gset
select t.ok((public.teacher_set_stage(:'gs', '04', '04', '{"screen":"instruction"}', :r, false)->>'ok')::boolean, 'P3：進入 04');
reset role;
set role anon;
select public.student_group_board(:'gs', :'u1a')->>'group_id' as g1id \gset
select t.ok((public.student_group_board(:'gs', :'u1b')->>'group_id') = :'g1id'
            and (public.student_group_board(:'gs', :'u1c')->>'group_id') = :'g1id', 'P3：同組三位學生讀到同一份小組工作區');
select t.ok((public.student_group_board(:'gs', :'u2a')->>'group_id') <> :'g1id', 'P3：第二組是另一份工作區');
select t.ok(jsonb_array_length(public.student_group_board(:'gs', :'u1a')->'categories') = 0
            and (public.student_group_board(:'gs', :'u1a')->'problems'->>'unplaced')::int = 8, 'P3：小組工作區從空白開始，不匯入任何人的個人分類');
-- 補加入（04 才加入）：沒有個人快照，但可以共作
select public.student_join(:'gcode', :'u1d', 1) is not null as j \gset
select t.ok(public.student_personal(:'gs', :'u1d')->'snapshot' = 'null'::jsonb, 'P3：04 才加入的學生沒有個人快照（不偽造）');
select t.ok((public.student_state(:'gs', :'u1d')->'can'->>'group_edit')::boolean
            and (public.student_group_board(:'gs', :'u1d')->>'group_id') = :'g1id', 'P3：補加入學生可參與同一份小組共作');
select t.ok((public.student_personal(:'gs', :'u1a')->'snapshot'->'data'->'categories'->0->>'name') = '我的想法', 'P3：學生可讀自己的個人快照');
reset role;
select t.ok((select count(*) from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = :'gs') = 0
            and (select count(*) from public.group_placements gp join public.groups g on g.id = gp.group_id where g.session_id = :'gs') = 0,
            'P3：多人讀取工作區不會建立任何資料（沒有重複副本）');

-- ======================================================================
-- 3C：操作識別與冪等（重送同一請求不產生副作用）
-- ======================================================================
set role anon;
select t.ok((public.group_add_category(:'gs', :'u1a', 'aaaaaaaa-0000-4000-8000-000000000001')->>'label_no')::int = 1, 'P3：新增分類（前端產生 id）');
select t.ok((public.group_add_category(:'gs', :'u1a', 'aaaaaaaa-0000-4000-8000-000000000001')->>'duplicate')::boolean, 'P3：重送同一新增請求回傳 duplicate');
select t.ok(jsonb_array_length(public.student_group_board(:'gs', :'u1b')->'categories') = 1, 'P3：重送後仍只有一個分類');
select t.ok((public.group_add_category(:'gs', :'u1b', 'aaaaaaaa-0000-4000-8000-000000000002')->>'label_no')::int = 2
            and (public.group_add_category(:'gs', :'u1c', 'aaaaaaaa-0000-4000-8000-000000000003')->>'label_no')::int = 3, 'P3：不同組員新增分類各自保留，編號不重複');
select t.raises(format($$select public.group_add_category(%L, %L, 'aaaaaaaa-0000-4000-8000-000000000001')$$, :'gs', :'u2a'), 'BAD_DATA', 'P3：其他組不能用已存在的分類 id');
select t.ok(jsonb_array_length(public.student_group_board(:'gs', :'u2a')->'categories') = 0, 'P3：第二組看不到第一組的分類');
\set gc1 'aaaaaaaa-0000-4000-8000-000000000001'
\set gc2 'aaaaaaaa-0000-4000-8000-000000000002'
\set gc3 'aaaaaaaa-0000-4000-8000-000000000003'
select t.ok((public.group_move_card(:'gs', :'u1a', :'gcard_a', :'gc1', 0)->>'rev')::int = 1, 'P3：移動故事 A');
select t.ok((public.group_move_card(:'gs', :'u1a', :'gcard_a', :'gc1', 0)->>'unchanged')::boolean, 'P3：重送同一移動：成功但不重複寫入');
reset role;
select t.ok((select rev from public.group_placements where card_id = :'gcard_a' and group_id = :'g1id') = 1, 'P3：重送後版本未增加');
set role anon;
select t.ok((public.group_move_card(:'gs', :'u1b', :'gcard_a', :'gc2', 0)->>'code') = 'STALE', 'P3：以舊版本把同一張卡移到別處被拒絕');
select t.ok((public.group_update_category(:'gs', :'u1a', :'gc1', 'reason', '都有神奇的力量', 1)->>'rev')::int = 2, 'P3：填寫共同特色');
select t.ok((public.group_update_category(:'gs', :'u1a', :'gc1', 'reason', '都有神奇的力量', 1)->>'unchanged')::boolean, 'P3：重送同一理由：成功但不重複寫入');
select t.ok((public.group_update_category(:'gs', :'u1b', :'gc1', 'reason', '別的說法', 1)->>'code') = 'STALE', 'P3：舊版本的理由不能覆蓋');
select t.raises(format($$select public.group_update_category(%L, %L, %L, 'reason', '用 null 覆蓋', null)$$, :'gs', :'u1b', :'gc1'), 'BAD_DATA', '複檢：修改理由的版本號為 null 被拒絕');
select t.raises(format($$select public.group_move_card(%L, %L, %L, %L, null)$$, :'gs', :'u1b', :'gcard_a', :'gc2'), 'BAD_DATA', '複檢：移動故事的版本號為 null 被拒絕');
select t.ok((public.student_group_board(:'gs', :'u1a')->'categories'->0->>'reason') = '都有神奇的力量', '複檢：null 版本號沒有改動任何資料');

-- 刪除與移動、編輯的衝突
select t.ok((public.group_lock(:'gs', :'u1b', 'reason:' || :'gc3')->>'ok')::boolean, 'P3：1b 開始編輯分類 3 的理由');
select t.ok((public.group_delete_category(:'gs', :'u1a', :'gc3')->>'code') = 'LOCKED', 'P3：他人正在編輯理由時不能刪除該分類');
select (public.student_group_board(:'gs', :'u1a')->>'lock_rev')::bigint as lr0 \gset
select t.ok((public.group_lock(:'gs', :'u1b', 'reason:' || :'gc3')->>'ok')::boolean
            and (public.student_group_board(:'gs', :'u1a')->>'lock_rev')::bigint = :lr0, '第二輪複檢 D2：續約不改變 lock_rev');
select t.ok((public.group_lock(:'gs', :'u1b', 'reason:' || :'gc3', true)->>'ok')::boolean, 'P3：1b 結束編輯');
select t.ok((public.student_group_board(:'gs', :'u1a')->>'lock_rev')::bigint = :lr0 + 1, '第二輪複檢 D2：釋放鎖使 lock_rev 前進（前端可分辨鎖狀態新舊）');
select t.ok((public.student_group_board(:'gs', :'u1a')->>'state_rev') is not null, '第二輪複檢 D2：回應含 state_rev（環節／暫停的版本）');
select t.ok((public.group_delete_category(:'gs', :'u1a', :'gc3')->>'ok')::boolean, 'P3：刪除分類 3');
select t.ok((public.group_move_card(:'gs', :'u1c', :'gcard_b', :'gc3', 0)->>'code') = 'NOT_FOUND', 'P3：移到已刪除的分類被拒絕');
select t.ok((public.group_delete_category(:'gs', :'u1a', :'gc3')->>'duplicate')::boolean
            and jsonb_typeof(public.group_delete_category(:'gs', :'u1a', :'gc3')->'cards') = 'array', '第三輪複檢 N2：刪除的重送回傳第一次的結果（含故事版本）');
select t.ok((public.group_delete_category(:'gs', :'u2a', :'gc3')->>'code') = 'NOT_FOUND', '第三輪複檢 N2：其他組不能取得此組的刪除結果');
select t.ok((public.group_update_category(:'gs', :'u1c', :'gc3', 'name', '復活', 1)->>'code') = 'NOT_FOUND', 'P3：修改已刪除的分類被拒絕');
reset role;
select t.ok(not exists (select 1 from public.group_placements where card_id = :'gcard_b' and category_id is not null), 'P3：故事沒有被放到不存在的分類');
set role anon;
select t.ok((public.group_add_category(:'gs', :'u1c', :'gc3')->>'code') = 'DELETED'
            and jsonb_array_length(public.student_group_board(:'gs', :'u1a')->'categories') = 2, 'P3：延遲送達的新增請求不會重建組員已刪除的分類');
reset role;

-- ======================================================================
-- 3D：提交
-- ======================================================================
create temp table moves as select sc.id, coalesce(gp.rev, 0) rev from public.story_cards sc
  left join public.group_placements gp on gp.group_id = :'g1id' and gp.card_id = sc.id where sc.id <> :'gcard_b';
grant select on moves to anon;
set role anon;
select count(*) from (select public.group_move_card(:'gs', :'u1a', id, :'gc1', rev) from moves) x \gset
reset role;
set role anon;
select (public.student_group_board(:'gs', :'u1a')->>'board_rev')::bigint as brev \gset
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->>'code') = 'INCOMPLETE'
            and (public.group_submit(:'gs', :'u1a', :brev)->'problems'->>'unplaced')::int = 1, 'P3：尚有故事未分類不能提交');
select t.ok((public.group_move_card(:'gs', :'u1b', :'gcard_b', :'gc2', 0)->>'ok')::boolean, 'P3：把最後一張放進分類 2');
select (public.student_group_board(:'gs', :'u1a')->>'board_rev')::bigint as brev \gset
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->'problems'->'unnamed_no') = '[1, 2]'::jsonb, 'P3：分類未命名不能提交（回傳編號）');
select public.group_update_category(:'gs', :'u1a', :'gc1', 'name', '分類 1', 1) is not null as x \gset
select public.group_update_category(:'gs', :'u1b', :'gc2', 'name', '尋找答案', 1) is not null as x \gset
select (public.student_group_board(:'gs', :'u1a')->>'board_rev')::bigint as brev \gset
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->'problems'->'unnamed_no') = '[1]'::jsonb, 'P3：原樣保留「分類 1」不算命名');
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->'problems'->'no_reason_no') = '[2]'::jsonb, 'P3：缺少共同特色不能提交（回傳編號）');
select public.group_update_category(:'gs', :'u1a', :'gc1', 'name', '神奇的事', 2) is not null as x \gset
select public.group_update_category(:'gs', :'u1b', :'gc2', 'reason', '主角都在找答案', 1) is not null as x \gset
select public.group_add_category(:'gs', :'u1c', 'aaaaaaaa-0000-4000-8000-000000000009') is not null as x \gset
-- 其他組員正在輸入時不能提交
select public.group_lock(:'gs', :'u1c', 'name:aaaaaaaa-0000-4000-8000-000000000009') is not null as x \gset
select (public.student_group_board(:'gs', :'u1a')->>'board_rev')::bigint as brev \gset
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->>'code') = 'EDITING', 'P3：其他組員正在輸入時不能提交（避免遺漏）');
select public.group_lock(:'gs', :'u1c', 'name:aaaaaaaa-0000-4000-8000-000000000009', true) is not null as x \gset
select t.ok((public.group_submit(:'gs', :'u1a', :brev - 1)->>'code') = 'STALE', 'P3：以舊畫面提交被拒絕');
select t.raises(format($$select public.group_submit(%L, %L, null)$$, :'gs', :'u1a'), 'BAD_DATA', '複檢：提交的版本號為 null 被拒絕');
select t.ok((public.group_submit(:'gs', :'u1a', :brev)->>'ok')::boolean, 'P3：合法成果提交成功（空分類不影響）');
select t.ok((public.group_submit(:'gs', :'u1b', :brev)->>'code') = 'ALREADY_SUBMITTED', 'P3：第二位組員重複提交 → ALREADY_SUBMITTED');
reset role;
select t.ok((select count(*) from public.group_snapshots where group_id = :'g1id') = 1, 'P3：只產生一份提交快照');
select t.ok((select kind = 'submitted' and is_complete and jsonb_array_length(data->'categories') = 2
                    and data->'categories'->0->>'name' = '神奇的事' and data->'categories'->0->>'reason' = '都有神奇的力量'
                    and jsonb_array_length(data->'categories'->0->'cards') = 7 and data->'categories'->1->>'order' = '2'
                    and jsonb_array_length(data->'unplaced') = 0
               from public.group_snapshots where group_id = :'g1id'), 'P3：快照含名稱、理由、故事清單、順序；排除空分類');
set role anon;
select t.raises(format($$select public.group_move_card(%L, %L, %L, %L, 1)$$, :'gs', :'u1c', :'gcard_b', :'gc1'), 'SUBMITTED', 'P3：提交後全組不能移動（API 直接呼叫也一樣）');
select t.raises(format($$select public.group_update_category(%L, %L, %L, 'reason', 'x', 3)$$, :'gs', :'u1d', :'gc1'), 'SUBMITTED', 'P3：提交後不能修改理由');
select t.raises(format($$select public.group_lock(%L, %L, %L)$$, :'gs', :'u1b', 'name:' || :'gc1'), 'SUBMITTED', 'P3：提交後不能取得操作鎖');
select t.ok(not (public.student_state(:'gs', :'u1d')->'can'->>'group_edit')::boolean, 'P3：補加入學生也同步為唯讀');
reset role;
select t.ok(not exists (select 1 from public.personal_boards b join t.p3_personal_before o using (participant_id)
                         where b.data is distinct from o.data or b.rev <> o.rev), 'P3：小組共作沒有改動任何個人資料');

-- ======================================================================
-- 3D：教師控制
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_set_flags(:'gs', p_editing_paused => true) is not null as x \gset
select public.teacher_set_flags(:'gs', p_editing_paused => false) is not null as x \gset
select t.ok((select status from public.groups where id = :'g1id') = 'submitted', 'P3：暫停再恢復不會解鎖已提交的組');
reset role;
set role anon;
select t.ok((public.student_state(:'gs', :'u2a')->'can'->>'group_edit')::boolean, 'P3：恢復後未提交的組可繼續編輯');
reset role;
-- 其他教師不能重新開放
set role authenticated;
select set_config('request.jwt.claim.sub', :'T3', false) as _ \gset
select t.raises(format($$select public.teacher_unlock_group(%L)$$, :'g1id'), 'FORBIDDEN', 'P3：其他教師不能重新開放此組');
select t.ok((select count(*) from public.group_snapshots) = 0, 'P3：其他教師讀不到小組快照（RLS）');
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_unlock_group(:'g1id') is null as x \gset
select t.ok((select status from public.groups where id = :'g1id') = 'open', 'P3：教師重新開放第一組');
reset role;
set role anon;
select t.ok((public.group_update_category(:'gs', :'u1a', :'gc2', 'reason', '主角都想知道真相', 2)->>'ok')::boolean, 'P3：重新開放後可繼續修改目前資料');
select (public.student_group_board(:'gs', :'u1a')->>'board_rev')::bigint as brev \gset
select t.ok((public.group_submit(:'gs', :'u1b', :brev)->>'ok')::boolean, 'P3：再次提交');
reset role;
select t.ok((select count(*) from public.group_snapshots where group_id = :'g1id') = 2
            and (select data->'categories'->1->>'reason' from public.group_snapshots where group_id = :'g1id' order by created_at limit 1) = '主角都在找答案'
            and (select data->'categories'->1->>'reason' from public.group_snapshots where group_id = :'g1id' order by created_at desc limit 1) = '主角都想知道真相',
            'P3：再次提交建立新版本快照，先前的提交快照保留不變');

-- 第二組：未完成，教師結束共同分類 → 保存為「教師結束保存」、不算正式提交
set role anon;
select public.group_add_category(:'gs', :'u2a', 'bbbbbbbb-0000-4000-8000-000000000001') is not null as x \gset
select public.group_move_card(:'gs', :'u2a', :'gcard_a', 'bbbbbbbb-0000-4000-8000-000000000001', 0) is not null as x \gset
select public.group_update_category(:'gs', :'u2a', 'bbbbbbbb-0000-4000-8000-000000000001', 'reason', '還沒寫完', 1) is not null as x \gset
reset role;
select id as g2id from public.groups where session_id = :'gs' and number = 2 \gset
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'gs' \gset
select t.ok((public.teacher_set_stage(:'gs', '05', '05', '{"screen":"placeholder"}', :r, false)->>'code') = 'UNSUBMITTED_GROUPS', 'P3：仍有小組未提交時先詢問教師');
select t.ok((public.teacher_set_stage(:'gs', '05', '05', '{"screen":"placeholder"}', :r, true)->>'ok')::boolean, 'P3：教師確認結束共同分類');
select t.ok((select count(*) from public.groups where session_id = :'gs' and status = 'locked') = 5, 'P3：未提交的五組被鎖定');
select t.ok((select kind = 'locked' and not is_complete and data->'categories'->0->>'reason' = '還沒寫完'
               from public.group_snapshots where group_id = :'g2id'), 'P3：未完成組別保存當下成果，標示為教師結束（非正式提交）');
select t.raises(format($$select public.teacher_unlock_group(%L)$$, :'g2id'), 'NOT_AVAILABLE', 'P3：第五環節不能直接重新開放（須先回到 04）');
reset role;
set role anon;
select t.raises(format($$select public.group_update_category(%L, %L, 'bbbbbbbb-0000-4000-8000-000000000001', 'reason', '離線後補寫', 2)$$, :'gs', :'u2a'), 'NOT_AVAILABLE', 'P3：結束後離線學生的舊操作被拒絕');
reset role;
-- 回到 03 再回到 04：不重新初始化、不解鎖
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'gs' \gset
select public.teacher_set_stage(:'gs', '03', '03', '{"screen":"instruction"}', :r, false) is not null as x \gset
select rev as r from public.session_state where session_id = :'gs' \gset
select public.teacher_set_stage(:'gs', '04', '04', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;
set role anon;
select t.ok((public.student_group_board(:'gs', :'u2a')->>'status') = 'locked'
            and jsonb_array_length(public.student_group_board(:'gs', :'u2a')->'categories') = 1, 'P3：返回 03 再進 04：小組成果保留且維持鎖定');
select t.ok(not (public.student_state(:'gs', :'u1b')->'can'->>'personal_edit')::boolean, 'P3：返回 03 時個人分類仍鎖定');
reset role;
-- 投影端不含任何小組成果
select projector_key as gpk from public.sessions where id = :'gs' \gset
set role anon;
select t.ok(public.projector_state(:'gs', :'gpk')::text not like '%神奇的事%' and public.projector_state(:'gs', :'gpk')::text not like '%reason%', 'P3：投影端資料不含小組成果');
reset role;
-- 清除本場次（避免影響 tests.sql 之後的檢查）
delete from public.sessions where id = :'gs';

-- ======================================================================
-- 複檢：結束個人分類時班上沒有學生 → 之後加入、返回 03 仍為鎖定
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select (r->>'session_id') as es, (r->>'join_code') as ecode from (select public.teacher_create_session('空班測試', 6) r) x \gset
select rev as r from public.session_state where session_id = :'es' \gset
select public.teacher_set_stage(:'es', '03', '03', '{"screen":"instruction"}', :r, false) is not null as x \gset
select rev as r from public.session_state where session_id = :'es' \gset
select public.teacher_set_stage(:'es', '04', '04', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;
set role anon;
select public.student_join(:'ecode', md5('late') || md5('x'), 1) is not null as j \gset
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'es' \gset
select public.teacher_set_stage(:'es', '03', '03', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;
set role anon;
select t.ok(not (public.student_state(:'es', md5('late') || md5('x'))->'can'->>'personal_edit')::boolean, '複檢：結束 03 時沒有學生，之後加入並返回 03 仍為鎖定');
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{}}', 0)$$, :'es', md5('late') || md5('x')), 'PERSONAL_LOCKED', '複檢：上述情況下 API 也拒絕寫入');
reset role;
delete from public.sessions where id = :'es';

\pset tuples_only off
select count(*) as "全部通過的檢查數（含 Phase 3）" from t.passes;
