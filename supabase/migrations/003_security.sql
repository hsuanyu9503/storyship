-- =====================================================================
-- 故事找朋友｜權限設定（RLS、資料表與函式授權）
-- 前置：001_init.sql、002_rpc.sql。可重複執行。
--
--   anon（學生、投影端）：不能直接讀寫任何資料表，只能呼叫學生／投影 RPC。
--   authenticated（教師）：只能「讀取」自己場次的資料；所有寫入都走 RPC。
--   participants.token_hash 不開放任何前端讀取。
-- =====================================================================

-- ---------- 資料表：全部啟用 RLS，先收回 Supabase 預設給予的權限 ----------
do $$
declare t text;
begin
  foreach t in array array['teachers','content_sets','story_cards','intro_stories','intro_clues','genres',
                           'sessions','session_state','groups','participants','personal_boards',
                           'personal_snapshots','group_categories','group_placements','group_locks','group_snapshots',
                           'group_category_tombstones']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
  end loop;
end $$;

grant usage on schema app to authenticated;
grant execute on function app.is_teacher() to authenticated;
grant execute on function app.is_session_teacher(uuid) to authenticated;

-- 教師只讀
grant select on public.teachers, public.content_sets, public.story_cards, public.intro_stories,
                public.intro_clues, public.genres, public.sessions, public.session_state, public.groups,
                public.personal_boards, public.personal_snapshots, public.group_categories,
                public.group_placements, public.group_snapshots
   to authenticated;
grant select (id, session_id, group_id, seat_label, status, joined_at, last_seen_at)
   on public.participants to authenticated;

-- 重建政策（可重複執行）
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy teachers_self on public.teachers for select to authenticated
  using (user_id = (select auth.uid()));

-- 教學素材：只有教師可直接讀取（學生透過 RPC 依環節取得，故事答案與類型不會提前外流）
create policy content_sets_teacher on public.content_sets for select to authenticated using ((select app.is_teacher()));
create policy story_cards_teacher on public.story_cards for select to authenticated using ((select app.is_teacher()));
create policy intro_stories_teacher on public.intro_stories for select to authenticated using ((select app.is_teacher()));
create policy intro_clues_teacher on public.intro_clues for select to authenticated using ((select app.is_teacher()));
create policy genres_teacher on public.genres for select to authenticated using ((select app.is_teacher()));

-- 場次資料：只限該場次的教師
create policy sessions_owner on public.sessions for select to authenticated
  using (teacher_id = (select auth.uid()) and (select app.is_teacher()));
create policy session_state_owner on public.session_state for select to authenticated
  using (app.is_session_teacher(session_id));
create policy groups_owner on public.groups for select to authenticated
  using (app.is_session_teacher(session_id));
create policy participants_owner on public.participants for select to authenticated
  using (app.is_session_teacher(session_id));
create policy personal_boards_owner on public.personal_boards for select to authenticated
  using (app.is_session_teacher(session_id));
create policy personal_snapshots_owner on public.personal_snapshots for select to authenticated
  using (app.is_session_teacher(session_id));
create policy group_snapshots_owner on public.group_snapshots for select to authenticated
  using (app.is_session_teacher(session_id));
create policy group_categories_owner on public.group_categories for select to authenticated
  using (exists (select 1 from public.groups g where g.id = group_id and app.is_session_teacher(g.session_id)));
create policy group_placements_owner on public.group_placements for select to authenticated
  using (exists (select 1 from public.groups g where g.id = group_id and app.is_session_teacher(g.session_id)));
-- group_locks、group_category_tombstones：不開放直接讀取

-- ---------- 函式授權 ----------
-- 先收回所有函式的預設執行權，再逐一開放
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.is_teacher() to authenticated;
grant execute on function app.is_session_teacher(uuid) to authenticated;

-- 投影端與學生端（anon）；教師帳號用同一瀏覽器測試學生端時也可用
grant execute on function
  public.projector_state(uuid, text),
  public.student_lookup(text),
  public.student_join(text, text, int),
  public.student_state(uuid, text),
  public.student_cards(uuid, text),
  public.student_personal(uuid, text),
  public.student_save_personal(uuid, text, jsonb, bigint),
  public.student_submit_personal(uuid, text, bigint),
  public.student_reopen_personal(uuid, text),
  public.student_group_board(uuid, text),
  public.group_add_category(uuid, text, uuid),
  public.group_move_card(uuid, text, uuid, uuid, bigint),
  public.group_update_category(uuid, text, uuid, text, text, bigint),
  public.group_delete_category(uuid, text, uuid),
  public.group_lock(uuid, text, text, boolean),
  public.group_submit(uuid, text, bigint)
to anon, authenticated;

-- 教師端（函式內另檢查教師白名單與場次擁有者）
grant execute on function
  public.is_teacher(),
  public.teacher_create_session(text, int),
  public.teacher_update_session(uuid, boolean, text, int),
  public.teacher_set_group(uuid, int, int, text),
  public.teacher_set_flags(uuid, boolean, boolean),
  public.teacher_set_stage(uuid, text, text, jsonb, bigint, boolean),
  public.teacher_end_session(uuid),
  public.teacher_delete_session(uuid),
  public.teacher_purge_expired(),
  public.teacher_unlock_group(uuid),
  public.teacher_move_participant(uuid, int),
  public.teacher_remove_participant(uuid),
  public.teacher_preview_compare(uuid, jsonb),
  public.teacher_preview_match(uuid, jsonb),
  public.teacher_publish_compare(uuid, jsonb, bigint),
  public.teacher_publish_match(uuid, jsonb, bigint)
to authenticated;

-- 之後新增的函式預設不開放
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
