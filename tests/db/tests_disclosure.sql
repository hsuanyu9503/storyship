-- Phase 4 複檢 F1：類型「名稱已公開」與「要素已公開」必須分開
-- 一律檢查 projector_state 的原始 JSON（投影端實際收到的內容）。
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
\set T1 '11111111-1111-1111-1111-111111111111'

set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select (r->>'session_id') as ds from (select public.teacher_create_session('揭露測試', 6) r) x \gset
select projector_key as dpk from public.sessions where id = :'ds' \gset
reset role;

-- 06 與 05 之間的切換以教師身分執行；06 的投影內容模擬「舊版教師端」送出的內容（含完整要素）
-- 教師端組的 06 總覽：把清單中的類型都帶出完整要素（這正是舊版合併 disclosure 後送出的內容）
create function t.overview(p_revealed int[]) returns jsonb language sql as $$
  select jsonb_build_object('screen', 'genre', 'view', 'overview',
    'ctl', jsonb_build_object('view', 'overview', 'index', 0, 'revealed', to_jsonb(p_revealed)),
    'genres', (select jsonb_agg(case when g.i = any(p_revealed)
                 then jsonb_build_object('name', g.name, 'visual_url', null, 'elements', g.elements) else null end order by g.i)
               from (select x.*, (row_number() over (order by sort_order, slug) - 1)::int i from public.genres x
                      where content_set_id = (select id from public.content_sets where is_default)) g));
$$;
create function t.genre_view(p_index int, p_revealed int[]) returns jsonb language sql as $$
  select jsonb_build_object('screen', 'genre', 'view', 'genre', 'index', p_index,
    'ctl', jsonb_build_object('view', 'genre', 'index', p_index, 'revealed', to_jsonb(p_revealed), 'reveal', true));
$$;
grant execute on all functions in schema t to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
-- 06：明確揭開第 0 類（奇幻小說）
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-02', t.genre_view(0, array[0]), :r, true)->>'ok' as x \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-03', t.overview(array[0]), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' like '%想像世界%' and :'pj' not like '%偵探小說%', 'F1：06 明確揭開的類型在總覽中有完整要素；未揭開的類型不出現');
reset role;

-- 07：只公開第 1 類（偵探小說）的名稱，零要素
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '07', '07', '{"screen":"placeholder","title":"小小故事分類師"}', :r, true)->>'ok' as x \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_publish_match(:'ds', '{"genre":1,"elements":[]}', :r)->>'ok' as x \gset
-- 返回 06 總覽：送出舊版教師端會送的內容（偵探小說帶完整要素）
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-03', t.overview(array[0, 1]), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' like '%偵探小說%', 'F1：07 公開過名稱的類型，返回 06 總覽時名稱仍公開');
select t.ok(:'pj' not like '%神祕案件%' and :'pj' not like '%尋找線索%' and :'pj' not like '%推理解謎%',
            'F1：07 只公開名稱（零要素）→ 返回 06 總覽，三個要素都不在投影 JSON 中');
select t.ok(:'pj' like '%想像世界%', 'F1：06 明確揭開的類型經過 07 後返回仍完整');
reset role;

-- 07：再只公開偵探小說的第 0 個要素 → 返回 06
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '07', '07', '{"screen":"placeholder","title":"小小故事分類師"}', :r, true)->>'ok' as x \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_publish_match(:'ds', '{"genre":1,"elements":[0]}', :r)->>'ok' as x \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-03', t.overview(array[0, 1]), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' like '%神祕案件%' and :'pj' not like '%尋找線索%' and :'pj' not like '%推理解謎%',
            'F1：07 只公開一個要素 → 返回 06 總覽只有那一個要素');
reset role;

-- 06 的單一類型畫面：偵探小說只公開名稱與一個要素時，不能因為停在它的畫面就顯示全部（只有「揭開小說世界」才完整揭露）
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-02', jsonb_build_object('screen', 'genre', 'view', 'teaser', 'index', 1,
  'ctl', jsonb_build_object('view', 'teaser', 'index', 1, 'revealed', '[0,1]'::jsonb)), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' not like '%尋找線索%' and :'pj' not like '%推理解謎%', 'F1：06「即將揭開」畫面不會帶出要素');
reset role;
-- 06 明確揭開偵探小說 → 完整
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-02', t.genre_view(1, array[0, 1]), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' like '%神祕案件%' and :'pj' like '%尋找線索%' and :'pj' like '%推理解謎%', 'F1：06 明確「揭開小說世界」仍完整揭露該類型（既有操作保留）');
reset role;
-- 不存在的類型索引
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select t.raises(format($$select public.teacher_set_stage(%L, '06', '06-02', %L, %s, false)$$, :'ds', t.genre_view(99, array[99]), :r), 'BAD_DATA', 'F1：不存在的類型索引被拒絕');
reset role;

-- 沒有「揭開」指令時，停在未完整公開類型的 genre 畫面會降為「即將揭開」（不會自動擴大）
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-02', '{"screen":"genre","view":"genre","index":3,"genre":{"name":"冒險小說","elements":[{"label":"未知探索"}]},"ctl":{"view":"genre","index":3,"revealed":[3]}}', :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' not like '%冒險小說%' and :'pj' not like '%未知探索%' and :'pj' like '%"view": "teaser"%', 'F1：沒有明確揭開指令時，教師端送來的 genre 內容與 revealed 一律忽略');
reset role;

-- 舊格式揭露紀錄（升級前 Phase 4 的 {"genres":[…]}）：保守視為只公開名稱
update public.session_state set disclosure = '{"genres":[3]}' where session_id = :'ds';
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '06', '06-03', t.overview(array[3]), :r, true)->>'ok' as x \gset
reset role;
set role anon;
select public.projector_state(:'ds', :'dpk')::text as pj \gset
select t.ok(:'pj' like '%冒險小說%' and :'pj' not like '%未知探索%' and :'pj' not like '%困難挑戰%' and :'pj' not like '%冒險旅程%',
            'F1：舊格式揭露紀錄只視為名稱已公開，不帶出要素');
reset role;

-- 升級相容（候選 A）：Phase 3 停在 06 時的投影由舊版教師端產生，ctl.revealed 是已顯示在投影上的完整類型
update public.session_state set disclosure = '{}',
  projection = '{"screen":"genre","view":"genre","index":2,"total":5,"genre":{"name":"歷史小說"},"ctl":{"view":"genre","index":2,"revealed":[2]}}'
 where session_id = :'ds';
set role authenticated;
select set_config('request.jwt.claim.sub', :'T1', false) as _ \gset
select rev as r from public.session_state where session_id = :'ds' \gset
select public.teacher_set_stage(:'ds', '07', '07', '{"screen":"placeholder","title":"小小故事分類師"}', :r, true)->>'ok' as x \gset
select t.ok((select disclosure from public.session_state where session_id = :'ds') = '{"revealed":{"2":[0,1,2]}}'::jsonb,
            '候選 A：升級前停在 06 已揭開的類型，離開時保存為完整揭露（沒有遺失、沒有多加）');
reset role;
delete from public.sessions where id = :'ds';
drop function t.overview(int[]); drop function t.genre_view(int, int[]);

\pset tuples_only off
select count(*) as "全部通過的檢查數（含 F1）" from t.passes;
