-- =====================================================================
-- 故事找朋友｜升級後檢查（唯讀，可隨時執行；不修改任何資料）
-- 在 Supabase SQL Editor 執行後，每一列（17 列）的 ok 都應為 true。
-- =====================================================================
with
tables as (
  select unnest(array['teachers','content_sets','story_cards','intro_stories','intro_clues','genres','sessions',
    'session_state','groups','participants','personal_boards','personal_snapshots','group_categories',
    'group_placements','group_locks','group_snapshots','group_category_tombstones']) t
),
fns as (
  select unnest(array[
    'public.student_state(uuid,text)', 'public.student_personal(uuid,text)', 'public.student_group_board(uuid,text)',
    'public.group_add_category(uuid,text,uuid)', 'public.group_move_card(uuid,text,uuid,uuid,bigint)',
    'public.group_update_category(uuid,text,uuid,text,text,bigint)', 'public.group_delete_category(uuid,text,uuid)',
    'public.group_lock(uuid,text,text,boolean)', 'public.group_submit(uuid,text,bigint)',
    'public.teacher_set_stage(uuid,text,text,jsonb,bigint,boolean)', 'public.teacher_unlock_group(uuid)',
    'app.group_result_json(uuid)', 'app.lock_open_groups(uuid)', 'app.personal_closed(uuid)']) f
),
student_fns as (
  select unnest(array['public.student_group_board(uuid,text)', 'public.group_add_category(uuid,text,uuid)',
    'public.group_move_card(uuid,text,uuid,uuid,bigint)', 'public.group_update_category(uuid,text,uuid,text,text,bigint)',
    'public.group_delete_category(uuid,text,uuid)', 'public.group_lock(uuid,text,text,boolean)',
    'public.group_submit(uuid,text,bigint)', 'public.student_save_personal(uuid,text,jsonb,bigint)']) f
)
select '1. 資料表都存在' as check, count(*) = (select count(*) from tables) as ok
  from tables where to_regclass('public.' || t) is not null
union all
select '2. 所有資料表都啟用 RLS', bool_and(c.relrowsecurity)
  from tables join pg_class c on c.oid = to_regclass('public.' || t)
union all
select '3. 學生（anon）不能直接讀寫任何資料表',
       not exists (select 1 from tables where has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete'))
union all
select '4. 教師（authenticated）不能直接寫入任何資料表',
       not exists (select 1 from tables where has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete'))
union all
select '5. 裝置憑證雜湊不開放讀取', not has_column_privilege('authenticated', 'public.participants', 'token_hash', 'select')
union all
select '6. Phase 3 函式都存在', count(*) = (select count(*) from fns) from fns where to_regprocedure(f) is not null
union all
select '7. 舊版 group_add_category(uuid,text) 已移除', to_regprocedure('public.group_add_category(uuid,text)') is null
union all
select '8. 學生可執行小組與個人 RPC', bool_and(has_function_privilege('anon', f, 'execute')) from student_fns
union all
select '9. 學生不能執行教師 RPC',
       not has_function_privilege('anon', 'public.teacher_set_stage(uuid,text,text,jsonb,bigint,boolean)', 'execute')
       and not has_function_privilege('anon', 'public.teacher_unlock_group(uuid)', 'execute')
union all
select '10. 內部函式（app）不開放給學生', not has_function_privilege('anon', 'app.lock_open_groups(uuid)', 'execute')
union all
select '11. SECURITY DEFINER 函式都固定 search_path',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname in ('public', 'app') and p.prosecdef
                      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
union all
select '12. 小組狀態值都合法（資料完整性）',
       not exists (select 1 from public.groups where status not in ('open', 'submitted', 'locked'))
union all
select '13. 小組故事歸屬沒有指向其他組的分類',
       not exists (select 1 from public.group_placements gp join public.group_categories gc on gc.id = gp.category_id
                    where gc.group_id <> gp.group_id)
union all
select '14. 個人分類結束標記欄位存在', exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'session_state' and column_name = 'personal_closed_at')
union all
select '15. 小組操作鎖版本欄位存在', exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'groups' and column_name = 'lock_rev')
union all
select '16. Phase 4 欄位存在（公開選擇、揭露紀錄、刪除結果）',
       (select count(*) from information_schema.columns where table_schema = 'public'
          and ((table_name = 'session_state' and column_name in ('stage_ctl', 'disclosure'))
            or (table_name = 'group_category_tombstones' and column_name = 'result'))) = 3
union all
select '17. Phase 4 函式存在且只開放給教師',
       to_regprocedure('public.teacher_publish_compare(uuid,jsonb,bigint)') is not null
       and to_regprocedure('public.teacher_publish_match(uuid,jsonb,bigint)') is not null
       and has_function_privilege('authenticated', 'public.teacher_preview_compare(uuid,jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.teacher_preview_compare(uuid,jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.teacher_publish_match(uuid,jsonb,bigint)', 'execute')
       and not has_function_privilege('anon', 'app.compare_build(uuid,jsonb)', 'execute');
