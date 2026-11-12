-- =====================================================================
-- 故事找朋友｜Phase 2 → Phase 1 回復（只在需要退回 Phase 1 網站時使用）
--
-- 執行順序：
--   1. 執行 Phase 1 版本的 supabase/migrations/002_rpc.sql
--   2. 執行 Phase 1 版本的 supabase/migrations/003_security.sql
--   3. 執行本檔
--   （Phase 1 版本可在 GitHub 上切換到 Phase 1 的提交取得，或執行
--     git show 5e850ad:supabase/migrations/002_rpc.sql）
--
-- 本檔只還原兩個 Phase 1 定義在 001_init.sql 的內部函式，並移除 Phase 2 新增的兩個內部函式。
-- 不修改、不刪除任何資料表或資料（Phase 2 沒有新增欄位或資料表）。
-- =====================================================================

create or replace function app.personal_problems(p_data jsonb, p_set uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with cards as (select id::text as id from public.story_cards where content_set_id = p_set),
       pl as (select key as card, value #>> '{}' as cat from jsonb_each(coalesce(p_data -> 'placements', '{}'::jsonb))),
       cats as (select c ->> 'id' as id, coalesce(c ->> 'name', '') as name
                  from jsonb_array_elements(coalesce(p_data -> 'categories', '[]'::jsonb)) c),
       unplaced as (select count(*) n from cards where not exists (
                      select 1 from pl join cats on cats.id = pl.cat where pl.card = cards.id)),
       unnamed as (select coalesce(jsonb_agg(cats.id), '[]'::jsonb) ids from cats
                    where btrim(cats.name) = '' and exists (select 1 from pl where pl.cat = cats.id))
  select jsonb_build_object('unplaced', (select n from unplaced), 'unnamed', (select ids from unnamed),
                            'complete', (select n from unplaced) = 0 and jsonb_array_length((select ids from unnamed)) = 0);
$$;

create or replace function app.snapshot_personal(p_session uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_set uuid;
begin
  select content_set_id into v_set from public.sessions where id = p_session;
  insert into public.personal_snapshots (participant_id, session_id, data, is_complete, submitted, board_rev, taken_at)
  select p.id, p_session,
         coalesce(b.data, '{"categories":[],"placements":{}}'::jsonb),
         coalesce((app.personal_problems(b.data, v_set) ->> 'complete')::boolean, false),
         b.submitted_at is not null, coalesce(b.rev, 0), now()
    from public.participants p
    left join public.personal_boards b on b.participant_id = p.id
   where p.session_id = p_session and p.status = 'active'
  on conflict (participant_id) do update
     set data = excluded.data, is_complete = excluded.is_complete, submitted = excluded.submitted,
         board_rev = excluded.board_rev, taken_at = excluded.taken_at;
end $$;

drop function if exists app.personal_closed(uuid);
drop function if exists app.is_temp_name(text);
