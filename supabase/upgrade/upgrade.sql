-- =====================================================================
-- 故事找朋友｜資料庫升級（已部署 Phase 1／2／3 的資料庫都適用；可重複執行）
-- 由 supabase/upgrade/build.sh 產生，請勿手動修改。內容：002_rpc.sql → 003_security.sql → checks/verify.sql
-- 002、003 包在單一交易中：執行中任何錯誤都會全部回復，資料庫維持升級前的狀態。
-- 最後的檢查在 commit 之後執行（唯讀）：若出現 false，升級本身已完成，不會自動回復；請依說明處理後重新執行本檔。
-- 不刪除、不修改任何既有資料。執行完畢後，結果表格的 ok 都應為 true（17 列）。
-- =====================================================================
begin;

-- =====================================================================
-- 故事找朋友｜公開 RPC（全部 create or replace，日後修正函式只需重跑本檔）
-- 前置：001_init.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Phase 3 新增的資料表（可重複執行；已存在時略過，不影響既有資料）
-- 已刪除分類的紀錄：避免延遲送達的「新增分類」重送請求，把組員剛刪除的分類重建回來。
-- ---------------------------------------------------------------------
create table if not exists public.group_category_tombstones (
  category_id uuid primary key,
  group_id    uuid not null references public.groups(id) on delete cascade,
  deleted_at  timestamptz not null default now()
);
create index if not exists group_category_tombstones_group on public.group_category_tombstones (group_id);
-- 建立後立即啟用 RLS 並收回權限（不等 003）：Supabase 會自動把 public 新資料表授權給 anon／authenticated，
-- 若 002 已執行而 003 尚未執行，這裡確保沒有暴露的空窗（複檢）。003 會再套用一次，結果相同。
alter table public.group_category_tombstones enable row level security;
revoke all on public.group_category_tombstones from anon, authenticated, public;

-- 個人分類已結束的明確標記（複檢：結束 03 時班上沒有學生就不會有快照，不能只靠快照判斷）
alter table public.session_state add column if not exists personal_closed_at timestamptz;
-- 小組操作鎖的版本（取得新鎖、釋放鎖時 +1）。與 board_rev、session_state.rev 一起讓前端判斷回應新舊：
-- 同一個資料快照讀出的三個版本彼此一致，較新的快照三者都不會變小（第二輪複檢 D2：不用時鐘時間排序）
alter table public.groups add column if not exists lock_rev bigint not null default 0;
-- 刪除分類的結果（回到未分類的故事與其新版本）：刪除已完成但回應遺失時，重送可以取回同一份結果（第三輪複檢 N2）
alter table public.group_category_tombstones add column if not exists result jsonb;

-- ---------------------------------------------------------------------
-- Phase 4 新增欄位（可重複執行）
--   stage_ctl：教師在 05／07 最後「公開」的選擇（綁定 snapshot ID），只有教師可讀；返回該環節或換裝置時由伺服器重建投影
--   disclosure：跨環節保存的揭露紀錄 {"revealed":{"<類型索引>":[已公開的要素索引]}}（見 app.disc_map）；進入 07 不會無條件公開全部
-- ---------------------------------------------------------------------
alter table public.session_state add column if not exists stage_ctl jsonb not null default '{}'::jsonb;
alter table public.session_state add column if not exists disclosure jsonb not null default '{}'::jsonb;

-- =====================================================================
-- 鎖定協定（Phase 3 複檢後整理；所有寫入路徑都遵守）
--   1. sessions 列：教師以 FOR NO KEY UPDATE 鎖定（同一場次的教師操作依序執行）。
--      這個模式與外鍵檢查的 FOR KEY SHARE 相容：學生插入 group_snapshots／participants 等資料時
--      不會被教師卡住（複檢 F3：原本用 FOR UPDATE，會與學生提交互相等待而死結）。
--   2. session_state 列：學生寫入取 FOR SHARE；教師切換環節、暫停、換組、移出、刪除場次取 FOR UPDATE。
--      教師拿到此鎖時，所有進行中的學生寫入都已完成，新的學生寫入會等待。
--   3. 學生在取得 session_state 鎖「之後」才讀取自己的 participant（組別、是否被移出），
--      因此換組／移出與進行中的寫入不會交錯（複檢 F4）。
--   4. groups 列：FOR UPDATE（同組寫入依序；教師結束時逐組鎖定）。
--   取得順序永遠是 sessions → session_state → groups，不會形成等待環。
-- =====================================================================
create or replace function app.own_session(p_session uuid) returns public.sessions
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions;
begin
  perform app.require_teacher();
  select * into s from public.sessions where id = p_session for no key update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if s.teacher_id <> auth.uid() then raise exception 'FORBIDDEN'; end if;
  return s;
end $$;

-- =====================================================================
-- 教師端
-- =====================================================================
create or replace function public.is_teacher() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_teacher();
$$;

create or replace function public.teacher_create_session(p_title text default '故事找朋友', p_group_count int default 6)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_set uuid; v_code text; v_id uuid; i int;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 去除易混淆的 I O 0 1
begin
  perform app.require_teacher();
  if p_group_count is null or p_group_count not between 1 and 12 then raise exception 'BAD_DATA'; end if;
  select id into v_set from public.content_sets where is_default;
  if v_set is null then raise exception 'NO_CONTENT'; end if;
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.sessions where join_code = v_code and status = 'active');
  end loop;
  insert into public.sessions (teacher_id, content_set_id, title, join_code, projector_key)
  values (auth.uid(), v_set, coalesce(nullif(btrim(p_title), ''), '故事找朋友'), v_code,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning id into v_id;
  insert into public.session_state (session_id) values (v_id);
  insert into public.groups (session_id, number, name)
  select v_id, n, '第 ' || n || ' 組' from generate_series(1, p_group_count) n;
  return jsonb_build_object('session_id', v_id, 'join_code', v_code);
end $$;

create or replace function public.teacher_update_session(p_session uuid, p_join_open boolean default null,
  p_title text default null, p_retention_days int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions;
begin
  s := app.own_session(p_session);
  if s.status <> 'active' and p_join_open then raise exception 'SESSION_ENDED'; end if;
  update public.sessions set
    join_open = coalesce(p_join_open, join_open),
    title = coalesce(nullif(btrim(p_title), ''), title),
    retention_days = coalesce(p_retention_days, retention_days)
  where id = p_session;
  update public.session_state set rev = rev + 1, updated_at = now() where session_id = p_session;
end $$;

-- 小組人數上限（0 或 null＝不限）與名稱
create or replace function public.teacher_set_group(p_session uuid, p_number int,
  p_capacity int default null, p_name text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.own_session(p_session);
  update public.groups set
    capacity = case when p_capacity is null then capacity when p_capacity <= 0 then null else p_capacity end,
    name = coalesce(nullif(btrim(p_name), ''), name)
  where session_id = p_session and number = p_number;
  if not found then raise exception 'NO_GROUP'; end if;
end $$;

create or replace function public.teacher_set_flags(p_session uuid,
  p_focus_mode boolean default null, p_editing_paused boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r bigint;
begin
  perform app.own_session(p_session);
  update public.session_state set
    focus_mode = coalesce(p_focus_mode, focus_mode),
    editing_paused = coalesce(p_editing_paused, editing_paused),
    rev = rev + 1, updated_at = now()
  where session_id = p_session returning rev into r;
  return jsonb_build_object('ok', true, 'rev', r);
end $$;

-- 唯一能改變教學環節與投影內容的函式。
--   p_projection：教師端產生、已核准公開的投影資料（投影端只會讀到這份）
--   p_expected_rev：樂觀鎖，避免兩台教師裝置互相覆蓋
--   p_lock_unsubmitted：離開第四環節時，若仍有小組未提交，是否鎖定其已儲存成果
create or replace function public.teacher_set_stage(p_session uuid, p_phase text, p_sub text,
  p_projection jsonb, p_expected_rev bigint, p_lock_unsubmitted boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; st public.session_state; v_open int[]; g record; v_proj jsonb;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  s := app.own_session(p_session);
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if not app.valid_phase(p_phase) or p_sub is null or char_length(p_sub) > 20 then raise exception 'BAD_DATA'; end if;
  if p_projection is null or jsonb_typeof(p_projection) <> 'object' or octet_length(p_projection::text) > 100000 then
    raise exception 'BAD_DATA';
  end if;
  -- 05／07 的成果畫面只能由伺服器依白名單產生（teacher_publish_compare／teacher_publish_match），不接受前端組好的內容
  if p_projection ->> 'screen' in ('compare', 'match') then raise exception 'BAD_DATA'; end if;
  select * into st from public.session_state where session_id = p_session for update;
  if st.rev <> p_expected_rev then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', st.rev);
  end if;

  -- 離開第四環節（往後）：確認小組皆已提交，或由教師決定鎖定目前成果
  if p_phase > '04' and st.phase <= '04' then
    select array_agg(number order by number) into v_open
      from public.groups where session_id = p_session and status = 'open';
    if v_open is not null then
      if not coalesce(p_lock_unsubmitted, false) then
        return jsonb_build_object('ok', false, 'code', 'UNSUBMITTED_GROUPS', 'groups', to_jsonb(v_open));
      end if;
      perform app.lock_open_groups(p_session);
    end if;
  end if;

  -- 離開第三環節（往後）：保存每位學生的個人分類唯讀快照
  if p_phase >= '04' and st.phase <= '03' then
    perform app.snapshot_personal(p_session);
  end if;

  -- 不在小組共作時，清除所有操作鎖
  if p_phase <> '04' then
    delete from public.group_locks gl using public.groups gg
     where gl.group_id = gg.id and gg.session_id = p_session;
  end if;

  -- 返回 05／07：若教師曾公開過，依當時綁定的快照重建（不會改抓最新快照，也不靠教師瀏覽器的記憶）
  v_proj := p_projection;
  if p_phase = '05' and st.stage_ctl ? '05' then v_proj := (app.compare_build(p_session, st.stage_ctl -> '05')) -> 'projection'; end if;
  if p_phase = '07' and st.stage_ctl ? '07' then v_proj := (app.match_build(p_session, st.stage_ctl -> '07')) -> 'projection'; end if;
  -- 06：揭露紀錄跨環節保存（只增加）；投影由伺服器依紀錄產生（見 app.genre_build）
  st.disclosure := app.disc_from_legacy(p_session, st.disclosure, st.projection);
  if p_projection ->> 'screen' = 'genre' then
    v_proj := app.genre_build(p_session, p_projection, st.disclosure);
    st.disclosure := v_proj -> 'disclosure';
    v_proj := v_proj -> 'projection';
  end if;

  update public.session_state
     set phase = p_phase, sub = p_sub, projection = v_proj, disclosure = st.disclosure, rev = rev + 1, updated_at = now()
   where session_id = p_session
  returning * into st;
  return jsonb_build_object('ok', true, 'rev', st.rev);
end $$;

create or replace function public.teacher_end_session(p_session uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; st public.session_state; g record;
begin
  s := app.own_session(p_session);
  if s.status = 'ended' then return; end if;
  select * into st from public.session_state where session_id = p_session for update;
  if st.phase <= '03' then perform app.snapshot_personal(p_session); end if;
  if st.phase <= '04' then perform app.lock_open_groups(p_session); end if;
  delete from public.group_locks gl using public.groups gg where gl.group_id = gg.id and gg.session_id = p_session;
  update public.sessions set status = 'ended', ended_at = now(), join_open = false where id = p_session;
  update public.session_state set rev = rev + 1, updated_at = now() where session_id = p_session;
end $$;

create or replace function public.teacher_delete_session(p_session uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.own_session(p_session);
  -- 先等進行中的學生寫入結束、並阻擋新的寫入，再刪除（刪除需要 sessions 的 FOR UPDATE）
  perform 1 from public.session_state where session_id = p_session for update;
  delete from public.sessions where id = p_session;
end $$;

-- 清除已結束且超過保留天數的場次（只限自己的場次）
create or replace function public.teacher_purge_expired()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform app.require_teacher();
  delete from public.sessions
   where teacher_id = auth.uid() and status = 'ended'
     and ended_at + make_interval(days => retention_days) < now();
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end $$;

-- 重新開放指定小組：只限第四環節（第五環節以後須先返回 04 再明確重新開放）。
-- 先前的提交快照全部保留；再次提交會建立新的快照版本。
create or replace function public.teacher_unlock_group(p_group uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_session uuid; s public.sessions; st public.session_state;
begin
  select session_id into v_session from public.groups where id = p_group;
  if v_session is null then raise exception 'NO_GROUP'; end if;
  s := app.own_session(v_session);
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  select * into st from public.session_state where session_id = v_session for update;
  if st.phase <> '04' then raise exception 'NOT_AVAILABLE'; end if;
  perform 1 from public.groups where id = p_group for update;
  update public.groups set status = 'open', submitted_at = null where id = p_group;
  perform app.bump_board(p_group);
end $$;

create or replace function public.teacher_move_participant(p_participant uuid, p_group_number int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; g public.groups;
begin
  select * into p from public.participants where id = p_participant;
  if not found then raise exception 'NOT_JOINED'; end if;
  perform app.own_session(p.session_id);
  -- 等進行中的學生寫入結束、並阻擋新的寫入，換組後才放行（複檢 F4）
  perform 1 from public.session_state where session_id = p.session_id for update;
  select * into g from public.groups where session_id = p.session_id and number = p_group_number for update;
  if not found then raise exception 'NO_GROUP'; end if;
  if g.id = p.group_id and p.status = 'active' then return; end if;
  update public.groups set seat_seq = seat_seq + 1 where id = g.id returning * into g;
  update public.groups set lock_rev = lock_rev + 1 where id in (select group_id from public.group_locks where participant_id = p.id);
  delete from public.group_locks where participant_id = p.id;
  update public.participants set group_id = g.id, status = 'active', seat_label = g.seat_seq || ' 號'
   where id = p.id;
end $$;

create or replace function public.teacher_remove_participant(p_participant uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants;
begin
  select * into p from public.participants where id = p_participant;
  if not found then raise exception 'NOT_JOINED'; end if;
  perform app.own_session(p.session_id);
  perform 1 from public.session_state where session_id = p.session_id for update;   -- 同上（複檢 F4）
  update public.groups set lock_rev = lock_rev + 1 where id in (select group_id from public.group_locks where participant_id = p.id);
  delete from public.group_locks where participant_id = p.id;
  update public.participants set status = 'removed' where id = p.id;
end $$;

-- =====================================================================
-- 投影端（以投影金鑰或教師身分讀取；只回傳已公開的投影資料）
-- =====================================================================
create or replace function public.projector_state(p_session uuid, p_key text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.sessions; st public.session_state; v_groups jsonb := null; v_join boolean;
begin
  select * into s from public.sessions where id = p_session;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if not ((p_key is not null and p_key = s.projector_key) or app.is_session_teacher(p_session)) then
    raise exception 'FORBIDDEN';
  end if;
  select * into st from public.session_state where session_id = p_session;
  v_join := st.projection ->> 'screen' = 'join';
  if v_join then
    select jsonb_agg(jsonb_build_object('number', g.number, 'name', g.name,
             'count', (select count(*) from public.participants p where p.group_id = g.id and p.status = 'active'))
             order by g.number)
      into v_groups from public.groups g where g.session_id = p_session;
  end if;
  return jsonb_build_object(
    -- rev 包含名單資訊，讓「加入狀態」畫面在人數變動時也會更新
    'rev', st.rev || ':' || s.status || ':' || s.join_open || ':' || md5(coalesce(v_groups::text, '')),
    'title', s.title,
    'status', s.status,
    'phase', st.phase,
    'sub', st.sub,
    'projection', st.projection,
    'join_code', case when v_join then s.join_code end,
    'join_open', case when v_join then s.join_open end,
    'groups', v_groups);
end $$;

-- =====================================================================
-- 學生端（匿名；以裝置憑證識別）
-- =====================================================================
create or replace function public.student_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.sessions;
begin
  select * into s from public.sessions where join_code = upper(btrim(p_code)) and status = 'active';
  if not found then return null; end if;
  return jsonb_build_object('session_id', s.id, 'title', s.title, 'join_open', s.join_open,
    'groups', (select jsonb_agg(jsonb_build_object('number', g.number, 'name', g.name, 'capacity', g.capacity,
                 'count', (select count(*) from public.participants p where p.group_id = g.id and p.status = 'active'))
                 order by g.number) from public.groups g where g.session_id = s.id));
end $$;

create or replace function public.student_join(p_code text, p_token text, p_group_number int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; g public.groups; p public.participants; v_hash text; v_count int;
begin
  v_hash := app.hash_token(p_token);
  select * into s from public.sessions where join_code = upper(btrim(p_code)) and status = 'active';
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  -- 與其他學生寫入相同的鎖定順序：先 session_state（SHARE）再 groups。
  -- 教師刪除場次會先取 session_state FOR UPDATE，因此兩者依序執行，不會死結（第二輪複檢 D1）
  perform 1 from public.session_state where session_id = s.id for share;
  select * into s from public.sessions where id = s.id and status = 'active';
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  select * into p from public.participants where session_id = s.id and token_hash = v_hash;
  -- 已加入的裝置：直接恢復原本身分（換組需由教師調整）
  if found and p.status = 'active' and p.group_id is not null then
    return jsonb_build_object('session_id', s.id, 'resumed', true);
  end if;
  if not s.join_open then raise exception 'JOIN_CLOSED'; end if;
  select * into g from public.groups where session_id = s.id and number = p_group_number for update;
  if not found then raise exception 'NO_GROUP'; end if;
  select count(*) into v_count from public.participants where group_id = g.id and status = 'active';
  if g.capacity is not null and v_count >= g.capacity then raise exception 'GROUP_FULL'; end if;
  if p.id is null and (select count(*) from public.participants where session_id = s.id) >= 200 then
    raise exception 'SESSION_FULL';
  end if;
  update public.groups set seat_seq = seat_seq + 1 where id = g.id returning * into g;
  if p.id is null then
    insert into public.participants (session_id, group_id, token_hash, seat_label)
    values (s.id, g.id, v_hash, g.seat_seq || ' 號') returning * into p;
    insert into public.personal_boards (participant_id, session_id) values (p.id, s.id);
  else
    update public.participants set group_id = g.id, status = 'active', seat_label = g.seat_seq || ' 號',
           last_seen_at = now() where id = p.id;
  end if;
  return jsonb_build_object('session_id', s.id, 'resumed', false);
end $$;

-- 學生的課堂狀態與可用權限（三端同步的學生側入口；同時更新在線時間）
create or replace function public.student_state(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; s public.sessions; st public.session_state; g public.groups;
        b public.personal_boards; v_active boolean; v_locked boolean;
begin
  p := app.participant(p_session, p_token);
  select * into s from public.sessions where id = p_session;
  if p.status <> 'active' or p.group_id is null then
    return jsonb_build_object('removed', true, 'join_open', s.join_open and s.status = 'active',
                              'session', jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status));
  end if;
  update public.participants set last_seen_at = now()
   where id = p.id and last_seen_at < now() - interval '10 seconds';
  select * into st from public.session_state where session_id = p_session;
  select * into g from public.groups where id = p.group_id;
  select * into b from public.personal_boards where participant_id = p.id;
  v_active := s.status = 'active';
  v_locked := app.personal_closed(p_session);
  return jsonb_build_object(
    'removed', false,
    'session', jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status),
    'state', jsonb_build_object('phase', st.phase, 'sub', st.sub, 'rev', st.rev,
                                'focus_mode', st.focus_mode, 'editing_paused', st.editing_paused),
    'me', jsonb_build_object('group_number', g.number, 'group_name', g.name, 'seat_label', p.seat_label),
    'group', jsonb_build_object('status', g.status, 'board_rev', g.board_rev),
    'personal', jsonb_build_object('rev', coalesce(b.rev, 0), 'submitted', b.submitted_at is not null,
                                   'locked', v_locked),
    'can', jsonb_build_object(
      'personal_edit', v_active and st.phase = '03' and not st.editing_paused and b.submitted_at is null
                       and not v_locked,
      'group_edit',    v_active and st.phase = '04' and not st.editing_paused and g.status = 'open'));
end $$;

-- 故事卡：第三環節起才開放（之前的環節學生讀不到任何故事資料）
create or replace function public.student_cards(p_session uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.participants; v_phase text; v_set uuid;
begin
  p := app.active_participant(p_session, p_token);
  select st.phase, s.content_set_id into v_phase, v_set
    from public.session_state st join public.sessions s on s.id = st.session_id where st.session_id = p_session;
  if v_phase < '03' then raise exception 'NOT_AVAILABLE'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'summary', summary,
            'detail', detail, 'image_url', image_url, 'image_alt', image_alt) order by sort_order, slug)
           from public.story_cards where content_set_id = v_set), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 個人分類
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- 個人分類（Phase 2）
--   鎖定：教師「結束個人分類」（離開 03 前往 04 以後，或結束場次）時，
--         系統為全班寫入 personal_snapshots。只要本場次已有快照，個人分類即視為鎖定：
--         返回 03 不會自動解除，離線裝置重新連線也無法再寫入。
--         （鎖定狀態由快照是否存在推導，因此不需要新增欄位，升級只需重跑本檔。）
--   一致性：每個寫入 RPC 以 FOR SHARE 讀取 session_state；教師切換環節時以 FOR UPDATE 鎖住同一列，
--         因此「學生儲存」與「教師建立快照」在伺服器端必定依序執行：
--         先到的學生儲存會被快照包含；晚到的儲存會看到新環節而被拒絕，不會出現快照之後才寫入的資料。
-- ---------------------------------------------------------------------
create or replace function app.personal_closed(p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.session_state where session_id = p_session and personal_closed_at is not null)
      or exists (select 1 from public.personal_snapshots where session_id = p_session);   -- 升級前建立的快照
$$;

-- 暫時名稱：空白，或學生沒有改動的「分類 N」（含全形數字）都不算正式命名
create or replace function app.is_temp_name(p_name text) returns boolean
language sql immutable as $$
  select btrim(coalesce(p_name, '')) = '' or btrim(p_name) ~ '^分類\s*[0-9０-９]+$';
$$;

-- 完整性檢查（只檢查是否完成，不判斷分類對錯）
-- 有效分類＝至少放了一張故事卡的分類；空分類不影響提交
create or replace function app.personal_problems(p_data jsonb, p_set uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with cards as (select id::text as id from public.story_cards where content_set_id = p_set),
       pl as (select key as card, value #>> '{}' as cat from jsonb_each(coalesce(p_data -> 'placements', '{}'::jsonb))),
       cats as (select c ->> 'id' as id, coalesce(c ->> 'name', '') as name, (c ->> 'no')::int as no, ord
                  from jsonb_array_elements(coalesce(p_data -> 'categories', '[]'::jsonb)) with ordinality as e(c, ord)),
       unplaced as (select count(*) n from cards where not exists (
                      select 1 from pl join cats on cats.id = pl.cat where pl.card = cards.id)),
       unnamed as (select coalesce(jsonb_agg(cats.id order by cats.ord), '[]'::jsonb) ids,
                          coalesce(jsonb_agg(cats.no order by cats.ord), '[]'::jsonb) nos from cats
                    where app.is_temp_name(cats.name)
                      and exists (select 1 from pl join cards on cards.id = pl.card where pl.cat = cats.id))
  select jsonb_build_object('total', (select count(*) from cards),
                            'unplaced', (select n from unplaced),
                            'unnamed', (select ids from unnamed), 'unnamed_no', (select nos from unnamed),
                            'complete', (select n from unplaced) = 0 and jsonb_array_length((select ids from unnamed)) = 0);
$$;

-- 結束個人分類時保存唯讀快照（未完成者保留已儲存部分並標示 is_complete=false）。
-- 已有快照的學生不覆寫：第一次結束時的成果就是正式快照。
create or replace function app.snapshot_personal(p_session uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_set uuid;
begin
  select content_set_id into v_set from public.sessions where id = p_session;
  insert into public.personal_snapshots (participant_id, session_id, data, is_complete, submitted, board_rev, taken_at)
  select p.id, p_session,
         coalesce(b.data, '{"categories":[],"placements":{}}'::jsonb),
         coalesce((app.personal_problems(b.data, v_set) ->> 'complete')::boolean, false) and b.submitted_at is not null,
         b.submitted_at is not null, coalesce(b.rev, 0), now()
    from public.participants p
    left join public.personal_boards b on b.participant_id = p.id
   where p.session_id = p_session and p.status = 'active'
  on conflict (participant_id) do nothing;
  update public.session_state set personal_closed_at = coalesce(personal_closed_at, now()) where session_id = p_session;
  perform app.notify('lesson:' || p_session, 'personal');
end $$;

create or replace function public.student_personal(p_session uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.participants; b public.personal_boards; sn public.personal_snapshots; v_phase text; v_set uuid;
begin
  p := app.active_participant(p_session, p_token);
  select st.phase, s.content_set_id into v_phase, v_set
    from public.session_state st join public.sessions s on s.id = st.session_id where st.session_id = p_session;
  if v_phase < '03' then raise exception 'NOT_AVAILABLE'; end if;
  select * into b from public.personal_boards where participant_id = p.id;
  select * into sn from public.personal_snapshots where participant_id = p.id;
  return jsonb_build_object(
    'data', b.data, 'rev', b.rev, 'submitted', b.submitted_at is not null,
    'updated_at', b.updated_at, 'locked', app.personal_closed(p_session),
    'problems', app.personal_problems(b.data, v_set),
    'snapshot', case when sn.participant_id is null then null else
      jsonb_build_object('data', sn.data, 'is_complete', sn.is_complete, 'taken_at', sn.taken_at) end);
end $$;

create or replace function app.personal_edit_ctx(p_session uuid, p_token text)
returns public.personal_boards language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; s public.sessions; st public.session_state; b public.personal_boards;
begin
  -- FOR SHARE：與教師切換環節（FOR UPDATE）互斥，保證快照與最後一次儲存的先後一致；
  -- 之後才讀學生身分（與移出互斥）
  select * into st from public.session_state where session_id = p_session for share;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  p := app.active_participant(p_session, p_token);
  select * into s from public.sessions where id = p_session;
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if st.phase <> '03' then raise exception 'NOT_AVAILABLE'; end if;
  if app.personal_closed(p_session) then raise exception 'PERSONAL_LOCKED'; end if;
  if st.editing_paused then raise exception 'PAUSED'; end if;
  select * into b from public.personal_boards where participant_id = p.id for update;
  if not found then
    insert into public.personal_boards (participant_id, session_id) values (p.id, p_session) returning * into b;
  end if;
  return b;
end $$;

-- 自動儲存（整份覆寫＋版本檢查；同一學生開兩個分頁也不會用舊資料蓋掉新資料）
create or replace function public.student_save_personal(p_session uuid, p_token text, p_data jsonb, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.personal_boards; v_set uuid; v_data jsonb;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  b := app.personal_edit_ctx(p_session, p_token);
  if b.submitted_at is not null then raise exception 'SUBMITTED'; end if;
  if b.rev <> p_expected_rev then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', b.rev, 'data', b.data);
  end if;
  select content_set_id into v_set from public.sessions where id = p_session;
  v_data := app.normalize_personal(p_data, v_set);
  update public.personal_boards set data = v_data, rev = rev + 1, updated_at = now()
   where participant_id = b.participant_id returning * into b;
  return jsonb_build_object('ok', true, 'rev', b.rev, 'problems', app.personal_problems(b.data, v_set));
end $$;

create or replace function public.student_submit_personal(p_session uuid, p_token text, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.personal_boards; v_set uuid; v_prob jsonb;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  b := app.personal_edit_ctx(p_session, p_token);
  if b.submitted_at is not null then return jsonb_build_object('ok', true, 'rev', b.rev); end if;
  if b.rev <> p_expected_rev then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', b.rev, 'data', b.data);
  end if;
  select content_set_id into v_set from public.sessions where id = p_session;
  v_prob := app.personal_problems(b.data, v_set);
  if not (v_prob ->> 'complete')::boolean then
    return jsonb_build_object('ok', false, 'code', 'INCOMPLETE', 'problems', v_prob);
  end if;
  update public.personal_boards set submitted_at = now(), rev = rev + 1 where participant_id = b.participant_id
  returning * into b;
  perform app.notify('lesson:' || p_session, 'personal');
  return jsonb_build_object('ok', true, 'rev', b.rev);
end $$;

-- 第三環節內，提交後仍可「繼續修改」
create or replace function public.student_reopen_personal(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.personal_boards;
begin
  b := app.personal_edit_ctx(p_session, p_token);
  if b.submitted_at is null then return jsonb_build_object('ok', true, 'rev', b.rev); end if;
  update public.personal_boards set submitted_at = null, rev = rev + 1 where participant_id = b.participant_id
  returning * into b;
  perform app.notify('lesson:' || p_session, 'personal');
  return jsonb_build_object('ok', true, 'rev', b.rev);
end $$;

-- ---------------------------------------------------------------------
-- 小組共同分類
--   * 每個操作在伺服器端鎖住小組列後依序執行。
--   * 故事歸屬、分類名稱、分類理由各自有版本號；過期版本一律拒絕並回傳最新值。
--   * 文字欄位與拖曳中的故事卡可取得 15 秒操作鎖（需持續續約，斷線即自動失效）。
-- ---------------------------------------------------------------------
-- Phase 3：以下內部函式覆蓋 001_init.sql 中的版本（001 不可重跑，因此修正放在本檔）
--
-- 鎖定順序（避免死結、保證快照一致）：所有寫入一律「先 session_state、再 groups」。
--   學生：session_state FOR SHARE → groups FOR UPDATE（同組寫入依序執行，不同組互不阻塞）
--   教師切換環節／暫停／結束：session_state FOR UPDATE（等所有進行中的學生寫入完成，並阻擋新的寫入）
-- 因此教師建立快照、鎖定小組之後，不可能再有舊的學生操作寫入。
create or replace function app.group_edit_ctx(p_session uuid, p_token text,
  out participant_id uuid, out group_id uuid, out content_set_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; g public.groups; s public.sessions; st public.session_state;
begin
  -- 先鎖課堂狀態，再讀學生的組別：換組／移出（持有 FOR UPDATE）完成前不會讀到舊組別（複檢 F4）
  select * into st from public.session_state where session_id = p_session for share;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  p := app.active_participant(p_session, p_token);
  select * into s from public.sessions where id = p_session;
  select * into g from public.groups where id = p.group_id for update;
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if st.phase <> '04' then raise exception 'NOT_AVAILABLE'; end if;
  if st.editing_paused then raise exception 'PAUSED'; end if;
  if g.status <> 'open' then raise exception 'SUBMITTED'; end if;
  participant_id := p.id; group_id := g.id; content_set_id := s.content_set_id;
end $$;

-- 完整性檢查（只檢查是否完成，不判斷分類對錯）；暫時名稱「分類 N」不算命名
create or replace function app.group_problems(p_group uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (select g.id, s.content_set_id from public.groups g join public.sessions s on s.id = g.session_id where g.id = p_group),
       cards as (select sc.id from public.story_cards sc, g where sc.content_set_id = g.content_set_id),
       unplaced as (select count(*) n from cards where not exists (
         select 1 from public.group_placements gp where gp.group_id = p_group and gp.card_id = cards.id and gp.category_id is not null)),
       used as (select c.* from public.group_categories c where c.group_id = p_group
                  and exists (select 1 from public.group_placements gp join cards on cards.id = gp.card_id where gp.category_id = c.id))
  select jsonb_build_object(
    'total', (select count(*) from cards),
    'unplaced', (select n from unplaced),
    'used', (select count(*) from used),
    'unnamed',  coalesce((select jsonb_agg(id order by label_no) from used where app.is_temp_name(name)), '[]'::jsonb),
    'unnamed_no', coalesce((select jsonb_agg(label_no order by label_no) from used where app.is_temp_name(name)), '[]'::jsonb),
    'no_reason', coalesce((select jsonb_agg(id order by label_no) from used where btrim(reason) = ''), '[]'::jsonb),
    'no_reason_no', coalesce((select jsonb_agg(label_no order by label_no) from used where btrim(reason) = ''), '[]'::jsonb),
    'complete', (select n from unplaced) = 0
                and not exists (select 1 from used where app.is_temp_name(name) or btrim(reason) = ''));
$$;

-- 小組成果（快照與 Phase 4 使用）：只含有故事的分類，依分類順序排列，每個分類附故事清單
--   {"categories":[{"id","order","label_no","name","reason","cards":[故事 id…]}],
--    "placements":[{"card_id","category_id"}], "unplaced":[故事 id…]}
create or replace function app.group_result_json(p_group uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with g as (select g.id, s.content_set_id from public.groups g join public.sessions s on s.id = g.session_id where g.id = p_group),
       cards as (select sc.id, sc.sort_order, sc.slug from public.story_cards sc, g where sc.content_set_id = g.content_set_id),
       pl as (select cards.id card_id, cards.sort_order, cards.slug, gp.category_id
                from cards left join public.group_placements gp on gp.group_id = p_group and gp.card_id = cards.id),
       used as (select c.*, row_number() over (order by c.label_no, c.created_at) ord from public.group_categories c
                 where c.group_id = p_group and exists (select 1 from pl where pl.category_id = c.id))
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'order', u.ord, 'label_no', u.label_no,
        'name', btrim(u.name), 'reason', btrim(u.reason),
        'cards', (select jsonb_agg(pl.card_id order by pl.sort_order, pl.slug) from pl where pl.category_id = u.id)) order by u.ord)
      from used u), '[]'::jsonb),
    'placements', coalesce((select jsonb_agg(jsonb_build_object('card_id', pl.card_id, 'category_id', pl.category_id)
        order by pl.sort_order, pl.slug) from pl), '[]'::jsonb),
    'unplaced', coalesce((select jsonb_agg(pl.card_id order by pl.sort_order, pl.slug) from pl where pl.category_id is null), '[]'::jsonb));
$$;

create or replace function app.snapshot_group(p_group uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.group_snapshots (group_id, session_id, kind, data, is_complete, board_rev)
  select g.id, g.session_id, p_kind, app.group_result_json(g.id),
         -- 教師結束時保存的成果，即使資料完整也不算學生正式提交
         p_kind = 'submitted' and (app.group_problems(g.id) ->> 'complete')::boolean, g.board_rev
    from public.groups g where g.id = p_group;
end $$;

-- 鎖定所有仍可編輯的小組並保存當下成果（教師結束共同分類、結束場次時）。
-- 呼叫前必須已持有 session_state 的 FOR UPDATE 鎖。
create or replace function app.lock_open_groups(p_session uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record;
begin
  for g in select id from public.groups where session_id = p_session and status = 'open' order by number for update loop
    perform app.snapshot_group(g.id, 'locked');
    update public.groups set status = 'locked' where id = g.id;
    perform app.bump_board(g.id);
  end loop;
end $$;

create or replace function public.student_group_board(p_session uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.participants; g public.groups; st public.session_state; s public.sessions;
begin
  p := app.active_participant(p_session, p_token);
  select * into st from public.session_state where session_id = p_session;
  select * into s from public.sessions where id = p_session;
  if st.phase < '04' then raise exception 'NOT_AVAILABLE'; end if;
  select * into g from public.groups where id = p.group_id;
  return app.group_board_json(g.id) || jsonb_build_object(
    'group_id', g.id, 'group_number', g.number, 'group_name', g.name, 'status', g.status, 'board_rev', g.board_rev,
    -- 回應新舊的判斷依據（與資料同一快照）：board_rev（小組內容）、lock_rev（操作鎖）、state_rev（環節／暫停）
    'lock_rev', g.lock_rev, 'state_rev', st.rev,
    -- 讀取交易的時間（now()＝交易開始時間，與下方過濾逾時鎖的 now() 相同）：三個版本都相同時用來排序
    'read_now', extract(epoch from now()),
    'paused', st.editing_paused, 'phase', st.phase,
    'can_edit', s.status = 'active' and st.phase = '04' and not st.editing_paused and g.status = 'open',
    'problems', app.group_problems(g.id),
    'locks', coalesce((select jsonb_agg(jsonb_build_object('target', target, 'mine', participant_id = p.id))
                         from public.group_locks where group_id = g.id and expires_at > now()), '[]'::jsonb));
end $$;

-- 新增分類。p_category：前端產生的分類 id（UUID），同時作為操作識別碼：
-- 網路逾時後重送同一個請求時，不會建立第二個分類，而是回傳第一次的結果。
drop function if exists public.group_add_category(uuid, text);
create or replace function public.group_add_category(p_session uuid, p_token text, p_category uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_no int; v_cat public.group_categories; v_rev bigint;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  if p_category is not null then
    if exists (select 1 from public.group_category_tombstones where category_id = p_category) then
      return jsonb_build_object('ok', false, 'code', 'DELETED');   -- 已被刪除：不重建
    end if;
    select * into v_cat from public.group_categories where id = p_category;
    if found then
      if v_cat.group_id <> c.group_id then raise exception 'BAD_DATA'; end if;
      select board_rev into v_rev from public.groups where id = c.group_id;
      return jsonb_build_object('ok', true, 'category_id', v_cat.id, 'label_no', v_cat.label_no, 'board_rev', v_rev, 'duplicate', true);
    end if;
  end if;
  if (select count(*) from public.group_categories where group_id = c.group_id) >= 20 then
    raise exception 'TOO_MANY';
  end if;
  -- 小組列已鎖定，同組同時新增會依序取得不同的編號
  select coalesce(max(label_no), 0) + 1 into v_no from public.group_categories where group_id = c.group_id;
  insert into public.group_categories (id, group_id, label_no) values (coalesce(p_category, gen_random_uuid()), c.group_id, v_no)
  returning * into v_cat;
  return jsonb_build_object('ok', true, 'category_id', v_cat.id, 'label_no', v_no, 'board_rev', app.bump_board(c.group_id));
end $$;

-- 移動故事卡；p_category 為 null 表示移回未分類區
create or replace function public.group_move_card(p_session uuid, p_token text, p_card uuid,
  p_category uuid, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_rev bigint; v_cur uuid; v_holder uuid;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  select * into c from app.group_edit_ctx(p_session, p_token);
  if not exists (select 1 from public.story_cards where id = p_card and content_set_id = c.content_set_id) then
    raise exception 'BAD_DATA';
  end if;
  if p_category is not null and not exists (select 1 from public.group_categories where id = p_category and group_id = c.group_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  v_holder := app.lock_holder(c.group_id, 'card:' || p_card);
  if v_holder is not null and v_holder <> c.participant_id then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;
  select rev, category_id into v_rev, v_cur from public.group_placements where group_id = c.group_id and card_id = p_card;
  v_rev := coalesce(v_rev, 0);
  if v_rev <> p_expected_rev then
    -- 重送或他人已把卡放到同一位置：結果已符合要求，不重複寫入
    if v_cur is not distinct from p_category then
      return jsonb_build_object('ok', true, 'rev', v_rev, 'category_id', v_cur, 'unchanged', true,
                                'board_rev', (select board_rev from public.groups where id = c.group_id));
    end if;
    return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', v_rev, 'category_id', v_cur);
  end if;
  insert into public.group_placements (group_id, card_id, category_id, rev, updated_at)
  values (c.group_id, p_card, p_category, 1, now())
  on conflict (group_id, card_id) do update
     set category_id = excluded.category_id, rev = public.group_placements.rev + 1, updated_at = now()
  returning rev into v_rev;
  delete from public.group_locks where group_id = c.group_id and target = 'card:' || p_card;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'board_rev', app.bump_board(c.group_id));
end $$;

-- 修改分類名稱或共同特色／理由
create or replace function public.group_update_category(p_session uuid, p_token text, p_category uuid,
  p_field text, p_value text, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_cat public.group_categories; v_holder uuid; v_cur_rev bigint; v_val text;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  select * into c from app.group_edit_ctx(p_session, p_token);
  if p_field not in ('name', 'reason') then raise exception 'BAD_DATA'; end if;
  v_val := coalesce(p_value, '');
  if (p_field = 'name' and char_length(v_val) > 30) or (p_field = 'reason' and char_length(v_val) > 300) then
    raise exception 'TOO_LONG';
  end if;
  select * into v_cat from public.group_categories where id = p_category and group_id = c.group_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  v_holder := app.lock_holder(c.group_id, p_field || ':' || p_category);
  if v_holder is not null and v_holder <> c.participant_id then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;
  v_cur_rev := case p_field when 'name' then v_cat.name_rev else v_cat.reason_rev end;
  if v_cur_rev <> p_expected_rev then
    if v_val = (case p_field when 'name' then v_cat.name else v_cat.reason end) then
      return jsonb_build_object('ok', true, 'rev', v_cur_rev, 'unchanged', true,
                                'board_rev', (select board_rev from public.groups where id = c.group_id));
    end if;
    return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', v_cur_rev,
      'value', case p_field when 'name' then v_cat.name else v_cat.reason end);
  end if;
  if p_field = 'name' then
    update public.group_categories set name = v_val, name_rev = name_rev + 1 where id = p_category returning name_rev into v_cur_rev;
  else
    update public.group_categories set reason = v_val, reason_rev = reason_rev + 1 where id = p_category returning reason_rev into v_cur_rev;
  end if;
  return jsonb_build_object('ok', true, 'rev', v_cur_rev, 'board_rev', app.bump_board(c.group_id));
end $$;

-- 刪除分類：其中的故事回到未分類區（不會消失）
create or replace function public.group_delete_category(p_session uuid, p_token text, p_category uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_cards jsonb;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  if not exists (select 1 from public.group_categories where id = p_category and group_id = c.group_id) then
    -- 同一個刪除的重送（第一次已完成、回應遺失）：回傳第一次的結果，讓接續的操作有正確的基準版本
    select result into v_cards from public.group_category_tombstones where category_id = p_category and group_id = c.group_id;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'cards', coalesce(v_cards -> 'cards', '[]'::jsonb),
                                'board_rev', (select board_rev from public.groups where id = c.group_id));
    end if;
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  -- 其他組員正在編輯此分類的文字，或正在拖曳其中的故事 → 拒絕
  if exists (select 1 from public.group_locks gl
              where gl.group_id = c.group_id and gl.expires_at > now() and gl.participant_id <> c.participant_id
                and (gl.target in ('name:' || p_category, 'reason:' || p_category)
                     or gl.target in (select 'card:' || card_id from public.group_placements
                                       where group_id = c.group_id and category_id = p_category))) then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;
  -- 回到未分類的故事版本 +1，並回傳新版本：同一裝置緊接著移動這些故事時以此為基準（第二輪複檢 R3）
  with u as (update public.group_placements set category_id = null, rev = rev + 1, updated_at = now()
              where group_id = c.group_id and category_id = p_category returning card_id, rev)
  select coalesce(jsonb_agg(jsonb_build_object('card_id', card_id, 'rev', rev)), '[]'::jsonb) into v_cards from u;
  delete from public.group_locks where group_id = c.group_id
     and target in ('name:' || p_category, 'reason:' || p_category);
  delete from public.group_categories where id = p_category;
  insert into public.group_category_tombstones (category_id, group_id, result)
  values (p_category, c.group_id, jsonb_build_object('cards', v_cards))
  on conflict (category_id) do nothing;
  return jsonb_build_object('ok', true, 'cards', v_cards, 'board_rev', app.bump_board(c.group_id));
end $$;

-- 取得／續約／釋放操作鎖。每位學生同時只持有一個鎖（取得新鎖會釋放舊鎖）。
create or replace function public.group_lock(p_session uuid, p_token text, p_target text, p_release boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_kind text; v_id uuid; v_holder uuid; v_exp timestamptz;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  if p_target !~ '^(card|name|reason):[0-9a-f-]{36}$' then raise exception 'BAD_DATA'; end if;
  v_kind := split_part(p_target, ':', 1);
  v_id := split_part(p_target, ':', 2)::uuid;
  if p_release then
    delete from public.group_locks where group_id = c.group_id and target = p_target and participant_id = c.participant_id;
    if found then update public.groups set lock_rev = lock_rev + 1 where id = c.group_id; end if;
    return jsonb_build_object('ok', true);
  end if;
  if (v_kind = 'card' and not exists (select 1 from public.story_cards where id = v_id and content_set_id = c.content_set_id))
     or (v_kind <> 'card' and not exists (select 1 from public.group_categories where id = v_id and group_id = c.group_id)) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  v_holder := app.lock_holder(c.group_id, p_target);
  if v_holder is not null and v_holder <> c.participant_id then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;
  delete from public.group_locks where participant_id = c.participant_id and target <> p_target;
  v_exp := now() + interval '15 seconds';
  insert into public.group_locks (group_id, target, participant_id, expires_at)
  values (c.group_id, p_target, c.participant_id, v_exp)
  on conflict (group_id, target) do update set participant_id = excluded.participant_id, expires_at = excluded.expires_at;
  if v_holder is null then
    update public.groups set lock_rev = lock_rev + 1 where id = c.group_id;   -- 新取得（續約不改版本）
    perform app.notify('group:' || c.group_id, 'lock');
  end if;
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end $$;

-- 提交小組成果（同一個交易內完成：驗證 → 建立快照 → 改為已提交 → 清除操作鎖 → 更新版本）
--   * 必須基於最新版本（p_expected_board_rev）
--   * 其他組員正在輸入名稱／理由或拖曳故事時回傳 EDITING（避免遺漏他們尚未送出的內容）
--   * 兩人同時提交：第二個請求等第一個完成後回傳 ALREADY_SUBMITTED，不會產生第二份快照
create or replace function public.group_submit(p_session uuid, p_token text, p_expected_board_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; g public.groups; v_prob jsonb; v_editing jsonb;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_board_rev is null then raise exception 'BAD_DATA'; end if;
  begin
    select * into c from app.group_edit_ctx(p_session, p_token);
  exception when raise_exception then
    if sqlerrm = 'SUBMITTED' then
      select g2.* into g from public.groups g2 join public.participants p on p.group_id = g2.id
       where p.session_id = p_session and p.token_hash = app.hash_token(p_token);
      return jsonb_build_object('ok', false, 'code', 'ALREADY_SUBMITTED', 'status', g.status, 'board_rev', g.board_rev);
    end if;
    raise;
  end;
  select * into g from public.groups where id = c.group_id;
  if g.board_rev <> p_expected_board_rev then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'board_rev', g.board_rev);
  end if;
  select jsonb_agg(target) into v_editing from public.group_locks
   where group_id = c.group_id and expires_at > now() and participant_id <> c.participant_id;
  if v_editing is not null then
    return jsonb_build_object('ok', false, 'code', 'EDITING', 'targets', v_editing);
  end if;
  v_prob := app.group_problems(c.group_id);
  if not (v_prob ->> 'complete')::boolean then
    return jsonb_build_object('ok', false, 'code', 'INCOMPLETE', 'problems', v_prob);
  end if;
  perform app.snapshot_group(c.group_id, 'submitted');
  update public.groups set status = 'submitted', submitted_at = now() where id = c.group_id;
  delete from public.group_locks where group_id = c.group_id;
  return jsonb_build_object('ok', true, 'board_rev', app.bump_board(c.group_id));
end $$;


-- =====================================================================
-- Phase 4：05 分類成果大公開、07 小小故事分類師
--
-- 原則
--   * 成果一律來自已保存的 group_snapshots（不讀仍可變動的 group_categories／group_placements），
--     每次預覽與公開都明確綁定 snapshot ID；伺服器不會自動改抓「最新快照」。
--   * 投影資料由伺服器依白名單產生：只有教師已揭露的理由、要素才會出現在回傳的 JSON 中；
--     不含任何 ID、未揭露的文字或教師補充資料。
--   * 預覽（teacher_preview_*）與公開（teacher_publish_*）使用同一個產生函式，預覽只讀不寫。
--   * 公開以 session_state.rev 做版本檢查；過期的請求回傳 STALE，不覆蓋較新的公開內容。
--   * 這些函式只讀取快照與素材，從不修改個人資料、小組資料或任何快照。
-- =====================================================================

-- 教師身分＋場次擁有者（只讀，不鎖定；給預覽與產生函式使用）
create or replace function app.teacher_session_ro(p_session uuid) returns public.sessions
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.sessions;
begin
  perform app.require_teacher();
  select * into s from public.sessions where id = p_session;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if s.teacher_id <> auth.uid() then raise exception 'FORBIDDEN'; end if;
  return s;
end $$;

-- 快照內容正規化（相容兩種格式）：
--   Phase 3 起：{"categories":[{id,order,label_no,name,reason,cards}],"placements":[...],"unplaced":[...]}
--   Phase 1／2：{"categories":[{id,label_no,name,reason,name_rev,reason_rev}],"placements":[{card_id,category_id,rev}]}
-- 一律以 placements 決定歸屬（兩種格式都有）；只保留有故事的分類；故事依素材順序；不修改原快照。
create or replace function app.snapshot_norm(p_data jsonb, p_set uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with cards as (select sc.id::text id, sc.sort_order, sc.slug from public.story_cards sc where sc.content_set_id = p_set),
       pl as (select p ->> 'card_id' card, p ->> 'category_id' cat
                from jsonb_array_elements(case when jsonb_typeof(p_data -> 'placements') = 'array' then p_data -> 'placements' else '[]'::jsonb end) p),
       cats as (select c ->> 'id' id, nullif(c ->> 'order', '')::int ord, coalesce(nullif(c ->> 'label_no', '')::int, 0) label_no,
                       btrim(coalesce(c ->> 'name', '')) name, btrim(coalesce(c ->> 'reason', '')) reason
                  from jsonb_array_elements(case when jsonb_typeof(p_data -> 'categories') = 'array' then p_data -> 'categories' else '[]'::jsonb end) c),
       used as (select cats.*, row_number() over (order by coalesce(cats.ord, 2147483647), cats.label_no, cats.id) n
                  from cats where exists (select 1 from pl join cards on cards.id = pl.card where pl.cat = cats.id))
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'n', u.n, 'label_no', u.label_no, 'name', u.name, 'reason', u.reason,
        'cards', (select jsonb_agg(cards.id order by cards.sort_order, cards.slug) from pl join cards on cards.id = pl.card where pl.cat = u.id))
        order by u.n) from used u), '[]'::jsonb),
    'unplaced', coalesce((select jsonb_agg(cards.id order by cards.sort_order, cards.slug) from cards
        where not exists (select 1 from pl join used on used.id = pl.cat where pl.card = cards.id)), '[]'::jsonb));
$$;

-- 取得本場次的一份快照（必須屬於這個場次），回傳正規化內容與組別資訊
create or replace function app.snapshot_for(p_session uuid, p_snapshot uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sn public.group_snapshots; g public.groups; v_set uuid;
begin
  select * into sn from public.group_snapshots where id = p_snapshot and session_id = p_session;
  if not found then raise exception 'BAD_DATA'; end if;     -- 不存在或屬於其他場次
  select * into g from public.groups where id = sn.group_id and session_id = p_session;
  if not found then raise exception 'BAD_DATA'; end if;
  select content_set_id into v_set from public.sessions where id = p_session;
  return jsonb_build_object('group_id', g.id, 'number', g.number, 'name', g.name, 'kind', sn.kind,
                            'complete', sn.is_complete, 'norm', app.snapshot_norm(sn.data, v_set));
end $$;

-- 分類的顯示名稱：暫時名稱「分類 N」視為未命名
create or replace function app.cat_label(p_cat jsonb) returns jsonb
language sql immutable as $$
  select case when app.is_temp_name(p_cat ->> 'name')
              then jsonb_build_object('label', '分類 ' || coalesce(nullif(p_cat ->> 'label_no', '0'), p_cat ->> 'n'), 'unnamed', true)
              else jsonb_build_object('label', p_cat ->> 'name', 'unnamed', false) end;
$$;

-- 故事的公開資訊（只有名稱與圖片）
create or replace function app.card_pub(p_set uuid, p_ids jsonb, p_track text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', sc.title, 'image_url', sc.image_url,
                                               'tracked', p_track is not null and sc.id::text = p_track)
                            order by sc.sort_order, sc.slug), '[]'::jsonb)
    from public.story_cards sc
   where sc.content_set_id = p_set and sc.id::text in (select jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)));
$$;

-- 驗證：字串陣列中的每個 ID 都必須在允許清單中
create or replace function app.ids_subset(p_ids jsonb, p_allowed jsonb) returns boolean
language sql immutable as $$
  select p_ids is null or jsonb_typeof(p_ids) = 'null'
      or (jsonb_typeof(p_ids) = 'array' and not exists (
            select 1 from jsonb_array_elements(p_ids) x
             where jsonb_typeof(x) <> 'string' or not (p_allowed @> jsonb_build_array(x))));
$$;

create or replace function app.uuid_or_null(p jsonb) returns uuid
language plpgsql immutable as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or (p #>> '{}') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_DATA'; end if;
  return (p #>> '{}')::uuid;
end $$;

-- ---------- 05：雙組比較 ----------
-- ctl = {"left": snapshot|null, "right": snapshot|null, "story": 故事|null,
--        "reasons": {"left":[分類 id], "right":[分類 id]}, "page": {"left":0,"right":0}, "focus": {"left": 分類 id|null, "right": …},
--        "per": {"left": 4|2|1, "right": 4|2|1},   每頁分類數（教師控制；理由長時改為 2 或 1，不縮小字級）
--        "zoom": null|"left"|"right"}               放大單側：投影只顯示該側、使用整個畫面寬度（另一側不放進投影資料）
-- 回傳 {"ctl": 正規化後的選擇, "projection": 投影資料（白名單）}
create or replace function app.compare_build(p_session uuid, p_ctl jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_set uuid; v_story uuid; v_track text; side text; snap uuid; d jsonb; cats jsonb; cat jsonb;
  rev_ids jsonb; foc text; pg int; pages int; per int; shown jsonb; out_cats jsonb;
  sides jsonb := '[]'::jsonb; ctl jsonb; groups uuid[] := '{}'; track jsonb; v_story_title text;
begin
  if p_ctl is null or jsonb_typeof(p_ctl) <> 'object' then raise exception 'BAD_DATA'; end if;
  select content_set_id into v_set from public.sessions where id = p_session;
  v_story := app.uuid_or_null(p_ctl -> 'story');
  if v_story is not null then
    select title into v_story_title from public.story_cards where id = v_story and content_set_id = v_set;
    if not found then raise exception 'BAD_DATA'; end if;
  end if;
  v_track := v_story::text;
  ctl := jsonb_build_object('left', null, 'right', null, 'story', v_story,
                            'reasons', jsonb_build_object('left', '[]'::jsonb, 'right', '[]'::jsonb),
                            'page', jsonb_build_object('left', 0, 'right', 0),
                            'focus', jsonb_build_object('left', null, 'right', null),
                            'per', jsonb_build_object('left', 4, 'right', 4), 'zoom', null);
  foreach side in array array['left', 'right'] loop
    snap := app.uuid_or_null(p_ctl -> side);
    continue when snap is null;
    d := app.snapshot_for(p_session, snap);
    if (d ->> 'group_id')::uuid = any(groups) then raise exception 'SAME_GROUP'; end if;   -- 兩側不能是同一組
    groups := groups || (d ->> 'group_id')::uuid;
    cats := d -> 'norm' -> 'categories';
    rev_ids := coalesce(p_ctl -> 'reasons' -> side, '[]'::jsonb);
    if not app.ids_subset(rev_ids, coalesce((select jsonb_agg(c -> 'id') from jsonb_array_elements(cats) c), '[]'::jsonb)) then
      raise exception 'BAD_DATA';
    end if;
    foc := nullif(p_ctl -> 'focus' ->> side, '');
    if foc is not null and not exists (select 1 from jsonb_array_elements(cats) c where c ->> 'id' = foc) then raise exception 'BAD_DATA'; end if;
    per := coalesce(nullif(p_ctl -> 'per' ->> side, '')::int, 4);
    if per not in (1, 2, 4) then raise exception 'BAD_DATA'; end if;
    pages := greatest(1, ceil(jsonb_array_length(cats)::numeric / per)::int);
    pg := coalesce(nullif(p_ctl -> 'page' ->> side, '')::int, 0);
    if pg < 0 or pg >= pages then raise exception 'BAD_DATA'; end if;
    -- 這一頁（或聚焦的那一個）要顯示的分類
    select coalesce(jsonb_agg(c order by (c ->> 'n')::int), '[]'::jsonb) into shown from jsonb_array_elements(cats) c
     where (foc is not null and c ->> 'id' = foc)
        or (foc is null and (c ->> 'n')::int > pg * per and (c ->> 'n')::int <= (pg + 1) * per);
    select coalesce(jsonb_agg(app.cat_label(c) || jsonb_build_object(
             'cards', app.card_pub(v_set, c -> 'cards', v_track),
             -- 理由：只有教師揭露的才放進資料；其餘一律只標示 hidden（不含內容，也不透露是否為空）
             'reason_state', case when rev_ids @> jsonb_build_array(c -> 'id')
                                  then case when coalesce(c ->> 'reason', '') = '' then 'empty' else 'shown' end else 'hidden' end)
           || case when rev_ids @> jsonb_build_array(c -> 'id') and coalesce(c ->> 'reason', '') <> ''
                   then jsonb_build_object('reason', c ->> 'reason') else '{}'::jsonb end
           order by (c ->> 'n')::int), '[]'::jsonb) into out_cats from jsonb_array_elements(shown) c;
    -- 指定故事在這一組的位置
    track := null;
    if v_track is not null then
      select app.cat_label(c) into track from jsonb_array_elements(cats) c where c -> 'cards' @> jsonb_build_array(v_track) limit 1;
      track := case when track is null then jsonb_build_object('where', null, 'unplaced', true)
                    else jsonb_build_object('where', track ->> 'label', 'unplaced', false) end;
    end if;
    sides := sides || jsonb_build_array(jsonb_build_object(
      'side', side, 'group', d ->> 'name', 'number', (d ->> 'number')::int,
      'kind', d ->> 'kind', 'complete', (d ->> 'complete')::boolean,
      'total', jsonb_array_length(cats), 'page', pg, 'pages', pages, 'per', per, 'focus', foc is not null,
      'categories', out_cats, 'unplaced_count', jsonb_array_length(d -> 'norm' -> 'unplaced'), 'track', track));
    ctl := jsonb_set(jsonb_set(jsonb_set(jsonb_set(ctl, array[side], to_jsonb(snap)),
             array['reasons', side], coalesce(rev_ids, '[]'::jsonb)), array['page', side], to_jsonb(pg)),
             array['focus', side], coalesce(to_jsonb(foc), 'null'::jsonb));
    ctl := jsonb_set(ctl, array['per', side], to_jsonb(per));
  end loop;
  -- 放大單側：只保留該側（必須已選）
  if p_ctl ? 'zoom' and jsonb_typeof(p_ctl -> 'zoom') <> 'null' then
    if p_ctl ->> 'zoom' not in ('left', 'right') or jsonb_typeof(ctl -> (p_ctl ->> 'zoom')) = 'null' then raise exception 'BAD_DATA'; end if;
    ctl := jsonb_set(ctl, '{zoom}', p_ctl -> 'zoom');
    select coalesce(jsonb_agg(x), '[]'::jsonb) into sides from jsonb_array_elements(sides) x where x ->> 'side' = p_ctl ->> 'zoom';
  end if;
  return jsonb_build_object('ctl', ctl, 'projection', jsonb_build_object(
    'screen', 'compare', 'title', '分類成果大公開',
    'story', case when v_story is null then null else jsonb_build_object('title', v_story_title) end,
    'zoom', jsonb_typeof(ctl -> 'zoom') = 'string',
    'sides', sides));
end $$;

-- ---------- 07：原始分類與小說要素對照 ----------
-- ctl = {"snapshot": id|null, "category": 分類 id|null, "show_reason": bool, "genre": 類型索引|null,
--        "elements": [已揭露的要素索引], "highlights": [標示相似的要素索引（必須已揭露）], "scaffold": bool}
create or replace function app.match_build(p_session uuid, p_ctl jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_set uuid; snap uuid; d jsonb; cat jsonb; v_cat text; gi int; gr public.genres; n_el int;
  els jsonb; hls jsonb; out_cat jsonb := null; out_genre jsonb := null; show_reason boolean; ctl jsonb; e_out jsonb; i int;
begin
  if p_ctl is null or jsonb_typeof(p_ctl) <> 'object' then raise exception 'BAD_DATA'; end if;
  select content_set_id into v_set from public.sessions where id = p_session;
  snap := app.uuid_or_null(p_ctl -> 'snapshot');
  v_cat := nullif(p_ctl ->> 'category', '');
  show_reason := coalesce((p_ctl ->> 'show_reason')::boolean, false);
  if snap is not null then
    d := app.snapshot_for(p_session, snap);
    if v_cat is not null then
      select c into cat from jsonb_array_elements(d -> 'norm' -> 'categories') c where c ->> 'id' = v_cat;
      if cat is null then raise exception 'BAD_DATA'; end if;
      out_cat := app.cat_label(cat) || jsonb_build_object('cards', app.card_pub(v_set, cat -> 'cards', null),
        'reason_state', case when show_reason then case when coalesce(cat ->> 'reason', '') = '' then 'empty' else 'shown' end else 'hidden' end)
        || case when show_reason and coalesce(cat ->> 'reason', '') <> '' then jsonb_build_object('reason', cat ->> 'reason') else '{}'::jsonb end;
    end if;
  elsif v_cat is not null then
    raise exception 'BAD_DATA';
  end if;
  els := coalesce(p_ctl -> 'elements', '[]'::jsonb);
  hls := coalesce(p_ctl -> 'highlights', '[]'::jsonb);
  if jsonb_typeof(els) <> 'array' or jsonb_typeof(hls) <> 'array' then raise exception 'BAD_DATA'; end if;
  if jsonb_typeof(p_ctl -> 'genre') = 'number' then
    gi := (p_ctl ->> 'genre')::int;
    select * into gr from public.genres where content_set_id = v_set order by sort_order, slug offset gi limit 1;
    if gi < 0 or not found then raise exception 'BAD_DATA'; end if;
    n_el := least(3, jsonb_array_length(gr.elements));
    -- 要素索引必須是 0～n-1 的整數、不重複；標示相似的要素必須已揭露（不能藉標示提前公開）
    if exists (select 1 from jsonb_array_elements(els) x where jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not in (select generate_series(0, n_el - 1)))
       or (select count(*) from jsonb_array_elements(els)) <> (select count(distinct x) from jsonb_array_elements(els) x)
       or exists (select 1 from jsonb_array_elements(hls) x where not (els @> jsonb_build_array(x)))
       or (select count(*) from jsonb_array_elements(hls)) <> (select count(distinct x) from jsonb_array_elements(hls) x) then
      raise exception 'BAD_DATA';
    end if;
    e_out := '[]'::jsonb;
    for i in 0 .. n_el - 1 loop
      if els @> to_jsonb(i) or els @> jsonb_build_array(i) then
        e_out := e_out || jsonb_build_array(jsonb_build_object('slot', i, 'revealed', true,
                   'label', gr.elements -> i ->> 'label', 'icon', coalesce(gr.elements -> i ->> 'icon', ''),
                   'highlight', hls @> jsonb_build_array(i)));
      else
        e_out := e_out || jsonb_build_array(jsonb_build_object('slot', i, 'revealed', false));
      end if;
    end loop;
    out_genre := jsonb_build_object('name', gr.name, 'visual_url', gr.visual_url, 'elements', e_out);
  elsif jsonb_typeof(p_ctl -> 'genre') not in ('null') and p_ctl ? 'genre' then
    raise exception 'BAD_DATA';
  else
    if jsonb_array_length(els) > 0 or jsonb_array_length(hls) > 0 then raise exception 'BAD_DATA'; end if;   -- 沒有類型就沒有要素
  end if;
  ctl := jsonb_build_object('snapshot', snap, 'category', v_cat, 'show_reason', show_reason,
                            'genre', gi, 'elements', (select coalesce(jsonb_agg(x order by x::int), '[]'::jsonb) from jsonb_array_elements(els) x),
                            'highlights', (select coalesce(jsonb_agg(x order by x::int), '[]'::jsonb) from jsonb_array_elements(hls) x),
                            'scaffold', coalesce((p_ctl ->> 'scaffold')::boolean, false));
  return jsonb_build_object('ctl', ctl, 'projection', jsonb_build_object(
    'screen', 'match', 'title', '小小故事分類師',
    'group', case when d is null then null else jsonb_build_object('group', d ->> 'name', 'number', (d ->> 'number')::int,
                                                                    'kind', d ->> 'kind', 'complete', (d ->> 'complete')::boolean) end,
    'category', out_cat, 'genre', out_genre, 'scaffold', coalesce((p_ctl ->> 'scaffold')::boolean, false)));
end $$;

-- 跨環節揭露紀錄：{"revealed": {"<類型索引>": [已公開的要素索引]}}
--   * 有 key ＝ 類型名稱已公開；要素只有列在陣列中的才公開
--   * 06「揭開小說世界」＝名稱＋全部要素；07 只加入當次公開的要素
--   * 舊格式 {"genres":[…]}（升級前的 Phase 4）無法分辨名稱與要素，保守視為「只公開名稱、零要素」
drop function if exists app.disclose_genres(uuid, jsonb, jsonb);

create or replace function app.disc_map(p_disc jsonb) returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select coalesce(case when jsonb_typeof(p_disc -> 'revealed') = 'object' then p_disc -> 'revealed' end, '{}'::jsonb)
      || coalesce((select jsonb_object_agg(k, '[]'::jsonb)
                      from (select distinct x #>> '{}' k
                              from jsonb_array_elements(case when jsonb_typeof(p_disc -> 'genres') = 'array' then p_disc -> 'genres' else '[]'::jsonb end) x
                             where jsonb_typeof(x) = 'number') t
                     where not (case when jsonb_typeof(p_disc -> 'revealed') = 'object' then p_disc -> 'revealed' else '{}'::jsonb end) ? k),
                   '{}'::jsonb);
$$;

-- 本場素材的類型（與教師端相同排序）
create or replace function app.genre_at(p_session uuid, p_idx int) returns public.genres
language sql stable security definer set search_path = public, pg_temp as $$
  select g.* from public.genres g join public.sessions s on s.content_set_id = g.content_set_id
   where s.id = p_session order by g.sort_order, g.slug offset p_idx limit 1;
$$;

-- 加入揭露（只增加）；p_els 為 null ＝ 該類型全部要素
create or replace function app.disc_add(p_session uuid, p_disc jsonb, p_idx int, p_els jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare gr public.genres; n_el int; m jsonb; v_add jsonb;
begin
  if p_idx is null or p_idx < 0 then raise exception 'BAD_DATA'; end if;
  gr := app.genre_at(p_session, p_idx);
  if gr.id is null then raise exception 'BAD_DATA'; end if;
  n_el := least(3, jsonb_array_length(gr.elements));
  v_add := case when p_els is null then (select coalesce(jsonb_agg(i), '[]'::jsonb) from generate_series(0, n_el - 1) i) else p_els end;
  m := app.disc_map(p_disc);
  m := m || jsonb_build_object(p_idx::text,
         (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb)
            from (select (jsonb_array_elements_text(coalesce(m -> p_idx::text, '[]'::jsonb) || v_add))::numeric::int x) t
           where x between 0 and n_el - 1));
  return (coalesce(p_disc, '{}'::jsonb) - 'genres') || jsonb_build_object('revealed', m);
end $$;

-- 06 的投影由伺服器依揭露紀錄產生；教師端只送畫面種類與索引（ctl.view、ctl.index、ctl.reveal、recap 的 items），
-- 教師端送來的 genres／genre／ctl.revealed 一律忽略，不能藉此擴大公開範圍。
-- 回傳 {projection, disclosure}
create or replace function app.genre_build(p_session uuid, p_req jsonb, p_disc jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  n int; v_view text; v_idx int := 0; x jsonb; m jsonb; v_full jsonb; v_items jsonb := '[]'::jsonb;
  ctl jsonb; proj jsonb; gr public.genres; n_el int;
begin
  select count(*) into n from public.genres g join public.sessions s on s.content_set_id = g.content_set_id where s.id = p_session;
  v_view := coalesce(p_req -> 'ctl' ->> 'view', p_req ->> 'view');
  if v_view is null or v_view not in ('recap', 'teaser', 'genre', 'overview') then raise exception 'BAD_DATA'; end if;
  x := p_req -> 'ctl' -> 'index';
  if x is null or jsonb_typeof(x) = 'null' then
    if v_view in ('teaser', 'genre') then raise exception 'BAD_DATA'; end if;
  elsif jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not in (select generate_series(0, n - 1)) then
    raise exception 'BAD_DATA';
  else
    v_idx := (x #>> '{}')::numeric::int;
  end if;
  -- 只有明確的「揭開小說世界」才完整揭露
  if v_view = 'genre' and p_req -> 'ctl' -> 'reveal' = 'true'::jsonb then
    p_disc := app.disc_add(p_session, p_disc, v_idx, null);
  end if;
  m := app.disc_map(p_disc);
  select coalesce(jsonb_agg(t.i order by t.i), '[]'::jsonb) into v_full
    from (select (row_number() over (order by g.sort_order, g.slug) - 1)::int i, least(3, jsonb_array_length(g.elements)) n_el
            from public.genres g join public.sessions s on s.content_set_id = g.content_set_id where s.id = p_session) t
   where m ? t.i::text and jsonb_array_length(m -> t.i::text) >= t.n_el;
  if v_view = 'genre' and not v_full @> to_jsonb(v_idx) then v_view := 'teaser'; end if;
  ctl := jsonb_build_object('view', v_view, 'index', v_idx, 'revealed', v_full);

  if v_view = 'recap' then
    x := p_req -> 'items';
    if jsonb_typeof(x) = 'array' and jsonb_array_length(x) <= 8
       and not exists (select 1 from jsonb_array_elements(x) e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 200) then
      v_items := x;
    end if;
    proj := jsonb_build_object('screen', 'genre', 'view', 'recap', 'items', v_items, 'ctl', ctl);
  elsif v_view = 'overview' then
    proj := jsonb_build_object('screen', 'genre', 'view', 'overview', 'ctl', ctl, 'genres',
      (select coalesce(jsonb_agg(case when m ? t.i::text then
                 jsonb_build_object('name', t.name, 'visual_url', t.visual_url, 'elements',
                   (select coalesce(jsonb_agg(case when (m -> t.i::text) @> to_jsonb(k)
                                                   then jsonb_build_object('label', t.elements -> k ->> 'label', 'icon', coalesce(t.elements -> k ->> 'icon', ''))
                                                   else jsonb_build_object('hidden', true) end order by k), '[]'::jsonb)
                      from generate_series(0, least(3, jsonb_array_length(t.elements)) - 1) k))
               else null end order by t.i), '[]'::jsonb)
         from (select (row_number() over (order by g.sort_order, g.slug) - 1)::int i, g.name, g.visual_url, g.elements
                 from public.genres g join public.sessions s on s.content_set_id = g.content_set_id where s.id = p_session) t));
  else
    gr := app.genre_at(p_session, v_idx);
    n_el := least(3, jsonb_array_length(gr.elements));
    proj := jsonb_build_object('screen', 'genre', 'view', v_view, 'ctl', ctl, 'index', v_idx, 'total', n,
      'genre', case when v_view = 'genre' then jsonb_build_object('name', gr.name, 'visual_url', gr.visual_url, 'elements',
                 (select coalesce(jsonb_agg(jsonb_build_object('label', gr.elements -> k ->> 'label', 'icon', coalesce(gr.elements -> k ->> 'icon', '')) order by k), '[]'::jsonb)
                    from generate_series(0, n_el - 1) k)) end);
  end if;
  return jsonb_build_object('projection', proj, 'disclosure', coalesce(p_disc, '{}'::jsonb));
end $$;

-- 升級相容：舊版教師端在 06 自行產生的投影，ctl.revealed 是當時「已完整揭露」並已顯示在投影上的類型。
-- 離開這個畫面前把它併入紀錄（無效的索引略過，不讓切換失敗）；伺服器產生的投影再併一次結果不變。
create or replace function app.disc_from_legacy(p_session uuid, p_disc jsonb, p_proj jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n int; x jsonb;
begin
  if coalesce(p_proj ->> 'screen', '') <> 'genre' or coalesce(jsonb_typeof(p_proj -> 'ctl' -> 'revealed'), '') <> 'array' then return p_disc; end if;
  select count(*) into n from public.genres g join public.sessions s on s.content_set_id = g.content_set_id where s.id = p_session;
  for x in select * from jsonb_array_elements(p_proj -> 'ctl' -> 'revealed') loop
    if jsonb_typeof(x) = 'number' and (x #>> '{}')::numeric in (select generate_series(0, n - 1)) then
      p_disc := app.disc_add(p_session, p_disc, (x #>> '{}')::numeric::int, null);
    end if;
  end loop;
  return p_disc;
end $$;

-- 預覽：只讀，不改變投影或任何資料
create or replace function public.teacher_preview_compare(p_session uuid, p_ctl jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.teacher_session_ro(p_session);
  return app.compare_build(p_session, p_ctl);
end $$;

create or replace function public.teacher_preview_match(p_session uuid, p_ctl jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.teacher_session_ro(p_session);
  return app.match_build(p_session, p_ctl);
end $$;

-- 公開：版本檢查＋只限該環節；投影資料由伺服器產生，選擇（綁定 snapshot ID）保存在 stage_ctl
create or replace function public.teacher_publish_compare(p_session uuid, p_ctl jsonb, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; st public.session_state; r jsonb;
begin
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  s := app.own_session(p_session);
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  select * into st from public.session_state where session_id = p_session for update;
  if st.rev <> p_expected_rev then return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', st.rev); end if;
  if st.phase <> '05' then raise exception 'NOT_AVAILABLE'; end if;
  r := app.compare_build(p_session, p_ctl);
  update public.session_state set projection = r -> 'projection', sub = '05',
         stage_ctl = stage_ctl || jsonb_build_object('05', r -> 'ctl'), rev = rev + 1, updated_at = now()
   where session_id = p_session returning * into st;
  return jsonb_build_object('ok', true, 'rev', st.rev, 'ctl', r -> 'ctl');
end $$;

create or replace function public.teacher_publish_match(p_session uuid, p_ctl jsonb, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; st public.session_state; r jsonb;
begin
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  s := app.own_session(p_session);
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  select * into st from public.session_state where session_id = p_session for update;
  if st.rev <> p_expected_rev then return jsonb_build_object('ok', false, 'code', 'STALE', 'rev', st.rev); end if;
  if st.phase <> '07' then raise exception 'NOT_AVAILABLE'; end if;
  r := app.match_build(p_session, p_ctl);
  update public.session_state set projection = r -> 'projection', sub = '07',
         stage_ctl = stage_ctl || jsonb_build_object('07', r -> 'ctl'),
         -- 在 07 公開的類型名稱與「當次公開的要素」加入揭露紀錄；未公開的要素不會因此在 06 總覽出現
         disclosure = case when r -> 'ctl' -> 'genre' is null or jsonb_typeof(r -> 'ctl' -> 'genre') = 'null' then disclosure
                           else app.disc_add(p_session, disclosure, (r -> 'ctl' ->> 'genre')::int, r -> 'ctl' -> 'elements') end,
         rev = rev + 1, updated_at = now()
   where session_id = p_session returning * into st;
  return jsonb_build_object('ok', true, 'rev', st.rev, 'ctl', r -> 'ctl');
end $$;

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

commit;

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
select '17. Phase 4 函式存在且只開放給教師（含 06 伺服器產生投影）',
       to_regprocedure('public.teacher_publish_compare(uuid,jsonb,bigint)') is not null
       and to_regprocedure('public.teacher_publish_match(uuid,jsonb,bigint)') is not null
       and has_function_privilege('authenticated', 'public.teacher_preview_compare(uuid,jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.teacher_preview_compare(uuid,jsonb)', 'execute')
       and not has_function_privilege('anon', 'public.teacher_publish_match(uuid,jsonb,bigint)', 'execute')
       and not has_function_privilege('anon', 'app.compare_build(uuid,jsonb)', 'execute')
       and to_regprocedure('app.genre_build(uuid,jsonb,jsonb)') is not null
       and not has_function_privilege('anon', 'app.genre_build(uuid,jsonb,jsonb)', 'execute')
       and not has_function_privilege('authenticated', 'app.genre_build(uuid,jsonb,jsonb)', 'execute');
