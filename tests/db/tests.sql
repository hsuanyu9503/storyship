-- 故事找朋友｜資料庫行為測試（由 run.sh 執行；以 anon／authenticated 角色實際呼叫 RPC）
\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- ---------- 測試工具 ----------
create schema t;
grant usage on schema t to anon, authenticated;
create table t.passes (n serial, msg text);
grant all on t.passes to anon, authenticated;
grant usage on sequence t.passes_n_seq to anon, authenticated;

create function t.ok(cond boolean, msg text) returns text language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if;
  insert into t.passes (msg) values (msg);
  return 'ok - ' || msg;
end $$;

-- 執行 SQL，預期以指定代碼失敗（錯誤訊息或 SQLSTATE 皆可比對）
create function t.raises(q text, code text, msg text) returns text language plpgsql as $$
declare got text;
begin
  begin
    execute q;
  exception when others then
    got := sqlerrm;
    if got = code or sqlstate = code or (code = 'DENIED' and sqlstate = '42501') then
      insert into t.passes (msg) values (msg);
      return 'ok - ' || msg;
    end if;
    raise exception 'FAIL: % (expected %, got % / %)', msg, code, got, sqlstate;
  end;
  raise exception 'FAIL: % (expected %, but succeeded)', msg, code;
end $$;
grant execute on all functions in schema t to anon, authenticated;

\pset tuples_only on
\pset format unaligned

-- ---------- 帳號 ----------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 't1@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'notteacher@example.com'),
  ('33333333-3333-3333-3333-333333333333', 't3@example.com');
insert into public.teachers (user_id, email) values
  ('11111111-1111-1111-1111-111111111111', 't1@example.com'),
  ('33333333-3333-3333-3333-333333333333', 't3@example.com');

\set T1 '11111111-1111-1111-1111-111111111111'
\set T2 '22222222-2222-2222-2222-222222222222'
\set T3 '33333333-3333-3333-3333-333333333333'

-- ======================================================================
-- 1. 匿名角色不能直接存取資料表與教師函式
-- ======================================================================
set role anon;
select t.raises('select * from public.sessions', 'DENIED', 'anon 不能讀 sessions');
select t.raises('select * from public.story_cards', 'DENIED', 'anon 不能讀故事素材');
select t.raises('select * from public.genres', 'DENIED', 'anon 不能讀小說類型（避免提前看到答案）');
select t.raises('select * from public.intro_stories', 'DENIED', 'anon 不能讀第一環節故事答案');
select t.raises('select * from public.personal_boards', 'DENIED', 'anon 不能讀個人分類');
select t.raises($$insert into public.group_categories (group_id, label_no) values (gen_random_uuid(), 1)$$, 'DENIED', 'anon 不能直接寫入小組分類');
select t.raises($$select public.teacher_create_session('x', 6)$$, 'DENIED', 'anon 不能呼叫教師函式');
reset role;

-- 非白名單帳號
set role authenticated;
select set_config('request.jwt.claim.sub', :'T2', false) as _ \gset
select t.ok(not public.is_teacher(), '非白名單帳號 is_teacher = false');
select t.raises($$select public.teacher_create_session('x', 6)$$, 'FORBIDDEN', '非白名單帳號不能建立場次');
select t.ok((select count(*) from public.story_cards) = 0, '非白名單帳號讀不到素材（RLS）');

-- ======================================================================
-- 2. 教師建立場次（六組）
-- ======================================================================
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.ok(public.is_teacher(), 'T1 為教師');
select (r->>'session_id') as sid, (r->>'join_code') as code from (select public.teacher_create_session('故事找朋友', 6) r) x \gset
select t.ok((select count(*) from public.groups where session_id = :'sid') = 6, '建立六組');
select t.ok((select phase from public.session_state where session_id = :'sid') = '00', '初始環節為 00');
select t.ok((select count(*) from public.story_cards) = 8, '教師可讀故事卡（8 張佔位）');
select projector_key as pkey from public.sessions where id = :'sid' \gset
select t.raises('select token_hash from public.participants', 'DENIED', '教師也不能讀裝置憑證雜湊');
reset role;

-- ======================================================================
-- 3. 學生加入（六組、同組多人、重新整理恢復）
-- ======================================================================
set role anon;
select t.ok(jsonb_array_length(public.student_lookup(:'code')->'groups') = 6, '學生以代碼查到六組');
select t.ok(public.student_lookup('ZZZZZZ') is null, '錯誤代碼回傳 null');
select t.raises(format($$select public.student_join(%L, 'short', 1)$$, :'code'), 'INVALID_TOKEN', '憑證格式錯誤被拒絕');

-- 每組兩位：tokA_g / tokB_g；第一組另有第三位 tokC_1
select md5('A1') || md5('A1x') as "tokA1", md5('B1') || md5('B1x') as "tokB1", md5('C1') || md5('C1x') as "tokC1",
       md5('A2') || md5('A2x') as "tokA2", md5('B2') || md5('B2x') as "tokB2" \gset
select count(*) from (
  select public.student_join(:'code', md5('A' || n) || md5('A' || n || 'x'), n),
         public.student_join(:'code', md5('B' || n) || md5('B' || n || 'x'), n)
  from generate_series(1, 6) n) x \gset joined_
select public.student_join(:'code', :'tokC1', 1) is not null as j \gset
select t.ok((select sum((g->>'count')::int) from jsonb_array_elements(public.student_lookup(:'code')->'groups') g) = 13, '13 位學生加入六組');
-- 同一裝置重新加入（重新整理、或選了別組）→ 恢復原身分，不會產生新學生
select t.ok((public.student_join(:'code', :'tokA1', 3)->>'resumed')::boolean, '同一裝置重新加入會恢復原身分');
select t.ok((public.student_state(:'sid', :'tokA1')->'me'->>'group_number')::int = 1, '恢復後仍是原本組別');
select t.ok((public.student_state(:'sid', :'tokA1')->'me'->>'seat_label') = '1 號', '座號標示');
select t.raises(format($$select public.student_state(%L, %L)$$, :'sid', md5('nobody') || md5('nobody')), 'NOT_JOINED', '未加入的裝置讀不到狀態');
select t.ok(not (public.student_state(:'sid', :'tokA1')->'can'->>'personal_edit')::boolean, '00 環節不能編輯');
select t.raises(format($$select public.student_cards(%L, %L)$$, :'sid', :'tokA1'), 'NOT_AVAILABLE', '00 環節讀不到故事卡');
reset role;

-- 人數上限、暫停加入
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_set_group(:'sid', 2, 2) is null as _ \gset
reset role;
set role anon;
select t.raises(format($$select public.student_join(%L, %L, 2)$$, :'code', md5('D2') || md5('D2x')), 'GROUP_FULL', '第二組達上限時不能加入');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_set_group(:'sid', 2, 0) is null as _ \gset
select public.teacher_update_session(:'sid', false) is null as _ \gset
reset role;
set role anon;
select t.raises(format($$select public.student_join(%L, %L, 2)$$, :'code', md5('D2') || md5('D2x')), 'JOIN_CLOSED', '暫停加入時新學生不能加入');
select t.ok((public.student_join(:'code', :'tokA2', 2)->>'resumed')::boolean, '暫停加入時，已加入的學生仍可恢復');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_update_session(:'sid', true) is null as _ \gset
reset role;

-- ======================================================================
-- 4. 投影端權限、教師預覽與狀態機
-- ======================================================================
set role anon;
select t.ok((public.projector_state(:'sid', :'pkey')->'projection'->>'screen') = 'join', '投影金鑰可讀投影狀態');
select t.ok(jsonb_array_length(public.projector_state(:'sid', :'pkey')->'groups') = 6, '加入畫面顯示六組人數');
select t.raises(format($$select public.projector_state(%L, 'wrong')$$, :'sid'), 'FORBIDDEN', '錯誤投影金鑰被拒絕');
select t.raises(format($$select public.projector_state(%L, null)$$, :'sid'), 'FORBIDDEN', '無金鑰的匿名者被拒絕');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T3', false) as _ \gset
select t.raises(format($$select public.projector_state(%L, null)$$, :'sid'), 'FORBIDDEN', '其他教師不能讀別人的投影');
select t.raises(format($$select public.teacher_set_stage(%L, '01', '01-01', '{}'::jsonb, 1, false)$$, :'sid'), 'FORBIDDEN', '其他教師不能切換別人的環節');
select t.ok((select count(*) from public.participants) = 0, '其他教師讀不到別人的學生名單（RLS）');
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as rev0 from public.session_state where session_id = :'sid' \gset
select t.ok((public.teacher_set_stage(:'sid', '01', '01-01', '{"screen":"intro","view":"open"}', :rev0 - 1, false)->>'code') = 'STALE', '過期 rev 的環節切換被拒絕');
select t.raises(format($$select public.teacher_set_stage(%L, '08', 'x', '{}'::jsonb, %s, false)$$, :'sid', :rev0), 'BAD_DATA', '不存在的環節被拒絕');
reset role;
truncate realtime.sent;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.ok((public.teacher_set_stage(:'sid', '01', '01-01', '{"screen":"intro","view":"open"}', :rev0, false)->>'ok')::boolean, '切換到 01');
reset role;
select t.ok(exists (select 1 from realtime.sent where topic = 'lesson:' || :'sid' and not private), '切換環節送出即時通知（public broadcast）');
select t.ok(not exists (select 1 from realtime.sent where payload::text like '%intro%'), '即時通知不含教學內容');
set role anon;
select t.ok((public.projector_state(:'sid', :'pkey')->>'join_code') is null, '非加入畫面不回傳活動代碼');
select t.ok((public.student_state(:'sid', :'tokA1')->'state'->>'phase') = '01', '學生端同步到 01');
select t.raises(format($$select public.student_cards(%L, %L)$$, :'sid', :'tokA1'), 'NOT_AVAILABLE', '01 環節學生讀不到故事卡');
select t.raises(format($$select public.student_save_personal(%L, %L, '{}'::jsonb, 0)$$, :'sid', :'tokA1'), 'NOT_AVAILABLE', '01 環節不能儲存個人分類');
reset role;

-- 進入 03
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'sid' \gset
select public.teacher_set_stage(:'sid', '03', '03', '{"screen":"instruction"}', :r, false) is not null as x \gset
reset role;

-- ======================================================================
-- 5. 個人分類：彼此獨立、版本檢查、提交條件
-- ======================================================================
set role anon;
select t.ok(jsonb_array_length(public.student_cards(:'sid', :'tokA1')) = 8, '03 環節可讀 8 張故事卡');
select t.ok((public.student_state(:'sid', :'tokA1')->'can'->>'personal_edit')::boolean, '03 環節可編輯個人分類');
reset role;
select id as ca from public.story_cards where slug = 'story-a' \gset
select id as cb from public.story_cards where slug = 'story-b' \gset
select string_agg(format('"%s":"c1"', id), ',') as allc1 from public.story_cards \gset
set role anon;
-- A1：先放一張
select t.ok((public.student_save_personal(:'sid', :'tokA1',
  format('{"categories":[{"id":"c1","no":1,"name":""}],"placements":{"%s":"c1"}}', :'ca')::jsonb, 0)->>'rev')::int = 1, 'A1 儲存第一版');
-- B1（同組）：完全不同的分類
select t.ok((public.student_save_personal(:'sid', :'tokB1',
  format('{"categories":[{"id":"x","no":1,"name":"冒險"},{"id":"y","no":2,"name":"魔法"}],"placements":{"%s":"y"}}', :'ca')::jsonb, 0)->>'ok')::boolean, 'B1 儲存自己的分類');
select t.ok((public.student_personal(:'sid', :'tokA1')->'data'->'categories'->0->>'id') = 'c1', 'A1 讀到的是自己的分類');
select t.ok(jsonb_array_length(public.student_personal(:'sid', :'tokB1')->'data'->'categories') = 2, 'B1 讀到的是自己的分類（互不干擾）');
select t.ok((public.student_save_personal(:'sid', :'tokA1', '{"categories":[],"placements":{}}', 0)->>'code') = 'STALE', '舊版本（另一分頁）不能覆蓋新資料');
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{"00000000-0000-0000-0000-000000000000":"c1"}}', 1)$$, :'sid', :'tokA1'), 'BAD_DATA', '引用不存在的故事被拒絕');
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[{"id":"c1"},{"id":"c1"}],"placements":{}}', 1)$$, :'sid', :'tokA1'), 'BAD_DATA', '重複分類 id 被拒絕');
select t.ok((public.student_submit_personal(:'sid', :'tokA1', 1)->>'code') = 'INCOMPLETE', '尚有故事未分類時不能提交');
-- 全部放進 c1，但分類未命名
select t.ok((public.student_save_personal(:'sid', :'tokA1',
  format('{"categories":[{"id":"c1","no":1,"name":""}],"placements":{%s}}', :'allc1')::jsonb, 1)->>'rev')::int = 2, 'A1 全部分類');
select t.ok((public.student_submit_personal(:'sid', :'tokA1', 2)->'problems'->'unnamed'->>0) = 'c1', '分類未命名時不能提交');
select t.ok((public.student_save_personal(:'sid', :'tokA1',
  format('{"categories":[{"id":"c1","no":1,"name":"全部都是故事"},{"id":"c2","no":2,"name":""}],"placements":{%s}}', :'allc1')::jsonb, 2)->>'rev')::int = 3, 'A1 命名（另有一個空分類）');
select t.ok((public.student_submit_personal(:'sid', :'tokA1', 3)->>'ok')::boolean, '空分類不影響提交；A1 提交成功');
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{}}', 4)$$, :'sid', :'tokA1'), 'SUBMITTED', '提交後不能再修改');
select t.ok(not (public.student_state(:'sid', :'tokA1')->'can'->>'personal_edit')::boolean, '提交後 personal_edit = false');
select t.ok((public.student_reopen_personal(:'sid', :'tokA1')->>'ok')::boolean, '03 環節內可繼續修改');
select t.ok((public.student_submit_personal(:'sid', :'tokA1', 5)->>'ok')::boolean, '再次提交');
reset role;

-- 暫停全班編輯
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_set_flags(:'sid', p_editing_paused => true) is not null as x \gset
reset role;
set role anon;
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{}}', 1)$$, :'sid', :'tokB1'), 'PAUSED', '暫停編輯時不能儲存');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_set_flags(:'sid', p_editing_paused => false) is not null as x \gset
select t.ok((select count(*) from public.personal_boards where submitted_at is not null) = 1, '教師端看得到提交人數');

-- ======================================================================
-- 6. 進入 04：個人唯讀快照
-- ======================================================================
select rev as r from public.session_state where session_id = :'sid' \gset
select t.ok((public.teacher_set_stage(:'sid', '04', '04', '{"screen":"instruction"}', :r, false)->>'ok')::boolean, '切換到 04');
select t.ok((select count(*) from public.personal_snapshots where session_id = :'sid') = 13, '每位學生都有快照（含未完成者）');
reset role;
select t.ok((select is_complete and submitted from public.personal_snapshots s join public.participants p on p.id = s.participant_id
              where p.token_hash = encode(sha256(convert_to(:'tokA1', 'UTF8')), 'hex')), 'A1 快照標示完成');
select t.ok((select not is_complete from public.personal_snapshots s join public.participants p on p.id = s.participant_id
              where p.token_hash = encode(sha256(convert_to(:'tokB1', 'UTF8')), 'hex')), 'B1 快照標示未完成，但保留部分成果');
select t.ok((select jsonb_array_length(data->'categories') = 2 from public.personal_snapshots s join public.participants p on p.id = s.participant_id
              where p.token_hash = encode(sha256(convert_to(:'tokB1', 'UTF8')), 'hex')), 'B1 已儲存的部分成果在快照中');
create table t.personal_before as select participant_id, data, rev from public.personal_boards;
create table t.psnap_before as select participant_id, data, taken_at from public.personal_snapshots;

-- ======================================================================
-- 7. 小組共作：空白開始、同步、衝突保護
-- ======================================================================
set role anon;
select t.raises(format($$select public.student_save_personal(%L, %L, '{"categories":[],"placements":{}}', 1)$$, :'sid', :'tokB1'), 'NOT_AVAILABLE', '04 環節不能修改個人分類');
select t.ok(public.student_personal(:'sid', :'tokB1')->'snapshot' is not null, '04 環節可讀自己的個人快照');
select t.ok(jsonb_array_length(public.student_group_board(:'sid', :'tokA1')->'categories') = 0, '小組工作區從空白開始（不匯入個人分類）');
select t.ok((public.student_state(:'sid', :'tokA1')->'can'->>'group_edit')::boolean, '04 環節可編輯小組');
select public.group_add_category(:'sid', :'tokA1')->>'category_id' as g1c1 \gset
select public.group_add_category(:'sid', :'tokB1')->>'category_id' as g1c2 \gset
select t.ok((public.student_group_board(:'sid', :'tokB1')->>'board_rev')::int = 2, '同組另一台裝置看到最新版本');
select t.ok(jsonb_array_length(public.student_group_board(:'sid', :'tokC1')->'categories') = 2, '同組第三位看到兩個分類');
select t.ok(jsonb_array_length(public.student_group_board(:'sid', :'tokA2')->'categories') = 0, '其他組看不到第一組的分類');

-- 兩人同時移動同一張故事卡（都以 rev 0 為基準）
select t.ok((public.group_move_card(:'sid', :'tokA1', :'ca', :'g1c1', 0)->>'ok')::boolean, 'A1 移動故事 A 成功');
select t.ok((public.group_move_card(:'sid', :'tokB1', :'ca', :'g1c2', 0)->>'code') = 'STALE', 'B1 以舊版本移動同一張卡被拒絕');
select t.ok((public.group_move_card(:'sid', :'tokB1', :'ca', :'g1c2', 0)->>'category_id') = :'g1c1', '被拒絕時回傳最新歸屬');
reset role;
select t.ok((select category_id::text from public.group_placements where card_id = :'ca' and category_id is not null) = :'g1c1', '伺服器上只有一個歸屬');
set role anon;
-- 拖曳鎖
select t.ok((public.group_lock(:'sid', :'tokB1', 'card:' || :'cb')->>'ok')::boolean, 'B1 開始拖曳故事 B（取得卡片鎖）');
select t.ok((public.group_move_card(:'sid', :'tokA1', :'cb', :'g1c1', 0)->>'code') = 'LOCKED', '他人拖曳中的卡片不能移動');
select t.ok((public.group_move_card(:'sid', :'tokB1', :'cb', :'g1c2', 0)->>'ok')::boolean, 'B1 放下故事 B');
reset role;
select t.ok(not exists (select 1 from public.group_locks where target = 'card:' || :'cb'), '放下後自動釋放卡片鎖');
set role anon;

-- 同時編輯同一分類名稱
select t.ok((public.group_lock(:'sid', :'tokA1', 'name:' || :'g1c1')->>'ok')::boolean, 'A1 開始編輯分類名稱（取得鎖）');
select t.ok((public.group_lock(:'sid', :'tokB1', 'name:' || :'g1c1')->>'code') = 'LOCKED', 'B1 不能同時取得同一名稱的鎖');
select t.ok((public.group_update_category(:'sid', :'tokB1', :'g1c1', 'name', 'B 的名稱', 1)->>'code') = 'LOCKED', 'B1 不能寫入他人編輯中的名稱');
select t.ok((public.group_update_category(:'sid', :'tokA1', :'g1c1', 'name', '有魔法', 1)->>'rev')::int = 2, 'A1 寫入名稱');
-- 不同欄位可同時編輯
select t.ok((public.group_update_category(:'sid', :'tokB1', :'g1c1', 'reason', '都有神奇的力量', 1)->>'ok')::boolean, '另一人可同時編輯同一分類的理由');
reset role;
-- 模擬 A1 斷線：鎖逾時
update public.group_locks set expires_at = now() - interval '1 second' where target = 'name:' || :'g1c1';
set role anon;
select t.ok((public.group_update_category(:'sid', :'tokB1', :'g1c1', 'name', '舊畫面的名稱', 1)->>'code') = 'STALE', '鎖逾時後，以舊版本寫入仍被拒絕（不回溯）');
select t.ok((public.group_update_category(:'sid', :'tokB1', :'g1c1', 'name', '舊畫面的名稱', 1)->>'value') = '有魔法', 'STALE 時回傳最新內容');
select t.ok((public.group_lock(:'sid', :'tokB1', 'name:' || :'g1c1')->>'ok')::boolean, '斷線者的鎖逾時後，其他人可取得');
select t.ok((public.group_update_category(:'sid', :'tokB1', :'g1c1', 'name', '神奇力量', 2)->>'ok')::boolean, 'B1 以最新版本修改名稱');
select t.ok((public.group_lock(:'sid', :'tokB1', 'name:' || :'g1c1', true)->>'ok')::boolean, 'B1 釋放鎖');

-- 跨組存取
select t.ok((public.group_update_category(:'sid', :'tokA2', :'g1c1', 'name', '入侵', 3)->>'code') = 'NOT_FOUND', '其他組不能修改第一組的分類');
select t.ok((public.group_move_card(:'sid', :'tokA2', :'ca', :'g1c1', 0)->>'code') = 'NOT_FOUND', '其他組不能把卡片放進第一組的分類');
select t.ok((public.group_delete_category(:'sid', :'tokA2', :'g1c1')->>'code') = 'NOT_FOUND', '其他組不能刪除第一組的分類');

-- 刪除分類 → 故事回到未分類
select t.ok((public.group_delete_category(:'sid', :'tokC1', :'g1c2')->>'ok')::boolean, '刪除分類 2');
select t.ok((select category_id is null from public.student_group_board(:'sid', :'tokA1') b, jsonb_to_recordset(b->'placements') x(card_id uuid, category_id uuid, rev int) where card_id = :'cb'), '被刪除分類中的故事回到未分類區');
select t.ok(jsonb_array_length(public.student_group_board(:'sid', :'tokA1')->'placements') = 8, '故事卡沒有消失（仍是 8 張）');
reset role;

-- 小組共作不影響個人資料
select t.ok(not exists (select 1 from public.personal_boards b join t.personal_before o using (participant_id)
                         where b.data is distinct from o.data or b.rev <> o.rev), '小組操作沒有修改任何個人草稿');
select t.ok(not exists (select 1 from public.personal_snapshots s join t.psnap_before o using (participant_id)
                         where s.data is distinct from o.data or s.taken_at <> o.taken_at), '小組操作沒有修改任何個人快照');

-- ======================================================================
-- 8. 小組提交、唯讀、單組解鎖
-- ======================================================================
set role anon;
select (public.student_group_board(:'sid', :'tokA1')->>'board_rev')::int as brev \gset
select t.ok((public.group_submit(:'sid', :'tokA1', :brev)->>'code') = 'INCOMPLETE', '尚未全部分類不能提交');
reset role;
-- 把其餘卡片都放進分類 1（模擬組員依序操作）
set role anon;
select count(*) from (select public.group_move_card(:'sid', :'tokC1', sc.id, :'g1c1',
    coalesce((select rev from public.student_group_board(:'sid', :'tokC1') b, jsonb_to_recordset(b->'placements') x(card_id uuid, category_id uuid, rev int) where card_id = sc.id), 0))
  from (select (x->>'card_id')::uuid id from jsonb_array_elements(public.student_group_board(:'sid', :'tokC1')->'placements') x where x->>'category_id' is null) sc) q \gset moved_
select (public.student_group_board(:'sid', :'tokA1')->>'board_rev')::int as brev \gset
select t.ok((public.student_group_board(:'sid', :'tokA1')->'problems'->>'complete')::boolean, '全部分類、名稱與理由完成');
select t.ok((public.group_submit(:'sid', :'tokB1', :brev - 1)->>'code') = 'STALE', '以舊版本畫面提交被拒絕');
select t.ok((public.group_submit(:'sid', :'tokB1', :brev)->>'ok')::boolean, '第一組提交成功');
select t.raises(format($$select public.group_add_category(%L, %L)$$, :'sid', :'tokA1'), 'SUBMITTED', '提交後組員不能再編輯');
select t.ok(not (public.student_state(:'sid', :'tokC1')->'can'->>'group_edit')::boolean, '提交後所有組員 group_edit = false');
select t.ok((public.student_group_board(:'sid', :'tokC1')->>'status') = 'submitted', '所有組員看到已提交狀態');
select t.ok((public.student_group_board(:'sid', :'tokA2')->>'status') = 'open', '第二組不受影響');
reset role;
select t.ok((select count(*) from public.group_snapshots where kind = 'submitted') = 1, '提交時保存小組成果快照');

set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select id as g1 from public.groups where session_id = :'sid' and number = 1 \gset
select id as g2 from public.groups where session_id = :'sid' and number = 2 \gset
select public.teacher_unlock_group(:'g1') is null as x \gset
select t.ok((select status from public.groups where id = :'g1') = 'open', '教師解鎖第一組');
select t.ok((select status from public.groups where id = :'g2') = 'open', '解鎖不影響其他組');
select t.ok((select count(*) from public.group_snapshots where group_id = :'g1') = 1, '解鎖不刪除已提交的快照');
select t.ok((select count(*) from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = :'sid') = 1, '教師可讀小組分類（RLS）');
reset role;
set role anon;
select t.ok((public.group_add_category(:'sid', :'tokA1')->>'ok')::boolean, '解鎖後可再次編輯');
select (public.student_group_board(:'sid', :'tokA1')->>'board_rev')::int as brev \gset
select public.group_submit(:'sid', :'tokA1', :brev)->>'ok' as resubmit \gset
select t.ok(:'resubmit'::boolean, '空分類不影響提交；第一組重新提交');
-- 第二組：放一張卡後不提交
select public.group_add_category(:'sid', :'tokA2')->>'category_id' as g2c1 \gset
select public.group_move_card(:'sid', :'tokA2', :'ca', :'g2c1', 0)->>'ok' as x \gset
reset role;

-- ======================================================================
-- 9. 離開 04：未提交組別需教師確認；返回不繞過鎖定、不清除資料
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'sid' \gset
select public.teacher_set_stage(:'sid', '05', '05', '{"screen":"placeholder"}', :r, false) as res \gset
select t.ok((:'res'::jsonb->>'code') = 'UNSUBMITTED_GROUPS', '仍有未提交組別時，切換到 05 需確認');
select t.ok(jsonb_array_length(:'res'::jsonb->'groups') = 5, '回報五個未提交組別');
select t.ok((select phase from public.session_state where session_id = :'sid') = '04', '未確認時環節不變');
select t.ok((public.teacher_set_stage(:'sid', '05', '05', '{"screen":"placeholder"}', :r, true)->>'ok')::boolean, '確認鎖定後進入 05');
select t.ok((select count(*) from public.groups where session_id = :'sid' and status = 'locked') = 5, '未提交組別被鎖定');
select t.ok((select count(*) from public.group_snapshots where session_id = :'sid' and kind = 'locked') = 5, '鎖定時保存當下成果');
select t.ok((select (data->'placements') @> format('[{"card_id":"%s","category_id":"%s"}]', :'ca', :'g2c1')::jsonb
               from public.group_snapshots where group_id = :'g2'), '第二組未完成的成果保存在快照中');
reset role;
set role anon;
select t.raises(format($$select public.group_add_category(%L, %L)$$, :'sid', :'tokA2'), 'NOT_AVAILABLE', '05 環節不能編輯小組');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'sid' \gset
select t.ok((public.teacher_set_stage(:'sid', '04', '04', '{"screen":"instruction"}', :r, false)->>'ok')::boolean, '返回 04');
reset role;
set role anon;
select t.raises(format($$select public.group_add_category(%L, %L)$$, :'sid', :'tokA2'), 'SUBMITTED', '返回 04 不會繞過鎖定');
select t.ok(jsonb_array_length(public.student_group_board(:'sid', :'tokA2')->'categories') = 1, '返回 04 不清除小組成果');
select t.ok(public.student_personal(:'sid', :'tokB1')->'snapshot' is not null, '返回 04 不清除個人快照');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'sid' \gset
select t.ok((public.teacher_set_stage(:'sid', '06', '06-01', '{"screen":"genre","view":"recap"}', :r, false)->>'ok')::boolean, '沒有 open 組別時直接前往 06');

-- ======================================================================
-- 10. 名單管理：換組、移出
-- ======================================================================
reset role;
select id as pb2 from public.participants where session_id = :'sid'
   and token_hash = encode(sha256(convert_to(:'tokB2', 'UTF8')), 'hex') \gset
set role authenticated;
select public.teacher_move_participant(:'pb2', 3) is null as x \gset
reset role;
set role anon;
select t.ok((public.student_state(:'sid', :'tokB2')->'me'->>'group_number')::int = 3, '教師調整組別後學生端同步');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_remove_participant(:'pb2') is null as x \gset
reset role;
set role anon;
select t.ok((public.student_state(:'sid', :'tokB2')->>'removed')::boolean, '被移出的學生看到 removed');
select t.raises(format($$select public.student_cards(%L, %L)$$, :'sid', :'tokB2'), 'REMOVED', '被移出的學生不能讀取故事卡');
select t.ok(not (public.student_join(:'code', :'tokB2', 4)->>'resumed')::boolean, '被移出的學生可在開放加入時重新選組');
select t.ok((public.student_state(:'sid', :'tokB2')->'me'->>'group_number')::int = 4, '重新選組成功');
reset role;

-- ======================================================================
-- 11. 結束場次、資料保留
-- ======================================================================
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select public.teacher_end_session(:'sid') is null as x \gset
select t.ok((select status from public.sessions where id = :'sid') = 'ended', '場次已結束');
select t.raises(format($$select public.teacher_set_stage(%L, '07', '07', '{}'::jsonb, 1, false)$$, :'sid'), 'SESSION_ENDED', '結束後不能切換環節');
reset role;
set role anon;
select t.ok(public.student_lookup(:'code') is null, '結束後代碼查不到');
select t.raises(format($$select public.student_join(%L, %L, 1)$$, :'code', md5('E1') || md5('E1x')), 'SESSION_NOT_FOUND', '結束後不能加入');
select t.ok((public.student_state(:'sid', :'tokA1')->'session'->>'status') = 'ended', '學生端看到已結束');
reset role;
select t.ok((select count(*) from public.group_snapshots where session_id = :'sid') = 7, '結束後成果仍保留');
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.ok((public.teacher_purge_expired()->>'deleted')::int = 0, '未過保留期限不會被清除');
reset role;
update public.sessions set ended_at = now() - interval '31 days' where id = :'sid';
set role authenticated;
select set_config('request.jwt.claim.sub', :'T3', false) as _ \gset
select t.ok((public.teacher_purge_expired()->>'deleted')::int = 0, '其他教師不能清除別人的場次');
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select t.ok((public.teacher_purge_expired()->>'deleted')::int = 1, '過保留期限後清除');
reset role;
select t.ok((select count(*) from public.participants) = 0 and (select count(*) from public.group_snapshots) = 0, '清除時一併刪除學生與成果');

\pset tuples_only off
select count(*) as "全部通過的檢查數" from t.passes;
