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
declare s public.sessions; st public.session_state; v_open int[]; g record;
begin
  -- 版本號不可為 null（null 會讓「版本不符」的比較失效而略過檢查）
  if p_expected_rev is null then raise exception 'BAD_DATA'; end if;
  s := app.own_session(p_session);
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if not app.valid_phase(p_phase) or p_sub is null or char_length(p_sub) > 20 then raise exception 'BAD_DATA'; end if;
  if p_projection is null or jsonb_typeof(p_projection) <> 'object' or octet_length(p_projection::text) > 100000 then
    raise exception 'BAD_DATA';
  end if;
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

  update public.session_state
     set phase = p_phase, sub = p_sub, projection = p_projection, rev = rev + 1, updated_at = now()
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
