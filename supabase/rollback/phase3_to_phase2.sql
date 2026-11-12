-- =====================================================================
-- 故事找朋友｜Phase 3 → Phase 2 回復（只在需要退回 Phase 2 網站時使用）
--
-- 執行順序：
--   1. 執行 Phase 2 版本的 supabase/migrations/002_rpc.sql
--   2. 執行 Phase 2 版本的 supabase/migrations/003_security.sql
--   3. 執行本檔
--   （Phase 2 版本：GitHub 上 Phase 2 合併後的提交 577e76c，或 git show 577e76c:supabase/migrations/002_rpc.sql）
--
-- 不刪除任何資料：小組分類、提交快照、個人快照全部保留。
-- Phase 3 新增的 group_category_tombstones 資料表、session_state.personal_closed_at、groups.lock_rev 欄位保留不動
-- （Phase 2 不會使用它們）。注意：回到 Phase 2 後，個人分類是否鎖定只看是否有個人快照；
-- 「結束 03 時班上沒有學生」的場次在 Phase 2 不會被視為鎖定（這是 Phase 2 原本的行為）。
-- =====================================================================

-- Phase 2 時這三個內部函式定義在 001_init.sql，這裡還原為當時的版本
create or replace function app.group_edit_ctx(p_session uuid, p_token text,
  out participant_id uuid, out group_id uuid, out content_set_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; g public.groups; s public.sessions; st public.session_state;
begin
  p := app.active_participant(p_session, p_token);
  select * into g from public.groups where id = p.group_id for update;
  select * into s from public.sessions where id = p_session;
  select * into st from public.session_state where session_id = p_session;
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if st.phase <> '04' then raise exception 'NOT_AVAILABLE'; end if;
  if st.editing_paused then raise exception 'PAUSED'; end if;
  if g.status <> 'open' then raise exception 'SUBMITTED'; end if;
  participant_id := p.id; group_id := g.id; content_set_id := s.content_set_id;
end $$;

create or replace function app.group_problems(p_group uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (select g.id, s.content_set_id from public.groups g join public.sessions s on s.id = g.session_id where g.id = p_group),
       cards as (select sc.id from public.story_cards sc, g where sc.content_set_id = g.content_set_id),
       unplaced as (select count(*) n from cards where not exists (
         select 1 from public.group_placements gp where gp.group_id = p_group and gp.card_id = cards.id and gp.category_id is not null)),
       used as (select c.* from public.group_categories c where c.group_id = p_group
                  and exists (select 1 from public.group_placements gp where gp.category_id = c.id))
  select jsonb_build_object(
    'unplaced', (select n from unplaced),
    'unnamed',  coalesce((select jsonb_agg(id) from used where btrim(name) = ''), '[]'::jsonb),
    'no_reason', coalesce((select jsonb_agg(id) from used where btrim(reason) = ''), '[]'::jsonb),
    'complete', (select n from unplaced) = 0
                and not exists (select 1 from used where btrim(name) = '' or btrim(reason) = ''));
$$;

create or replace function app.snapshot_group(p_group uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.group_snapshots (group_id, session_id, kind, data, is_complete, board_rev)
  select g.id, g.session_id, p_kind, app.group_board_json(g.id),
         (app.group_problems(g.id) ->> 'complete')::boolean, g.board_rev
    from public.groups g where g.id = p_group;
end $$;

-- Phase 3 複檢修正改寫了 001 的 app.own_session（FOR NO KEY UPDATE），還原為 Phase 2 時的版本
create or replace function app.own_session(p_session uuid) returns public.sessions
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions;
begin
  perform app.require_teacher();
  select * into s from public.sessions where id = p_session for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if s.teacher_id <> auth.uid() then raise exception 'FORBIDDEN'; end if;
  return s;
end $$;

-- 移除 Phase 3 新增的函式
drop function if exists public.group_add_category(uuid, text, uuid);
drop function if exists app.group_result_json(uuid);
drop function if exists app.lock_open_groups(uuid);
