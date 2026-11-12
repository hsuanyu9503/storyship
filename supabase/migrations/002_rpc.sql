-- =====================================================================
-- 故事找朋友｜公開 RPC（全部 create or replace，日後修正函式只需重跑本檔）
-- 前置：001_init.sql
-- =====================================================================

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
      for g in select id from public.groups where session_id = p_session and status = 'open' loop
        perform app.snapshot_group(g.id, 'locked');
        update public.groups set status = 'locked' where id = g.id;
      end loop;
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
  if st.phase <= '04' then
    for g in select id from public.groups where session_id = p_session and status = 'open' loop
      perform app.snapshot_group(g.id, 'locked');
      update public.groups set status = 'locked' where id = g.id;
    end loop;
  end if;
  delete from public.group_locks gl using public.groups gg where gl.group_id = gg.id and gg.session_id = p_session;
  update public.sessions set status = 'ended', ended_at = now(), join_open = false where id = p_session;
  update public.session_state set rev = rev + 1, updated_at = now() where session_id = p_session;
end $$;

create or replace function public.teacher_delete_session(p_session uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.own_session(p_session);
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

create or replace function public.teacher_unlock_group(p_group uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_session uuid;
begin
  select session_id into v_session from public.groups where id = p_group;
  if v_session is null then raise exception 'NO_GROUP'; end if;
  perform app.own_session(v_session);
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
  select * into g from public.groups where session_id = p.session_id and number = p_group_number for update;
  if not found then raise exception 'NO_GROUP'; end if;
  if g.id = p.group_id and p.status = 'active' then return; end if;
  update public.groups set seat_seq = seat_seq + 1 where id = g.id returning * into g;
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
        b public.personal_boards; v_active boolean;
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
  return jsonb_build_object(
    'removed', false,
    'session', jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status),
    'state', jsonb_build_object('phase', st.phase, 'sub', st.sub, 'rev', st.rev,
                                'focus_mode', st.focus_mode, 'editing_paused', st.editing_paused),
    'me', jsonb_build_object('group_number', g.number, 'group_name', g.name, 'seat_label', p.seat_label),
    'group', jsonb_build_object('status', g.status, 'board_rev', g.board_rev),
    'personal', jsonb_build_object('rev', coalesce(b.rev, 0), 'submitted', b.submitted_at is not null),
    'can', jsonb_build_object(
      'personal_edit', v_active and st.phase = '03' and not st.editing_paused and b.submitted_at is null,
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
    'problems', app.personal_problems(b.data, v_set),
    'snapshot', case when sn.participant_id is null then null else
      jsonb_build_object('data', sn.data, 'is_complete', sn.is_complete, 'taken_at', sn.taken_at) end);
end $$;

create or replace function app.personal_edit_ctx(p_session uuid, p_token text)
returns public.personal_boards language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants; s public.sessions; st public.session_state; b public.personal_boards;
begin
  p := app.active_participant(p_session, p_token);
  select * into s from public.sessions where id = p_session;
  select * into st from public.session_state where session_id = p_session;
  if s.status <> 'active' then raise exception 'SESSION_ENDED'; end if;
  if st.phase <> '03' then raise exception 'NOT_AVAILABLE'; end if;
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
  update public.personal_boards set submitted_at = null, rev = rev + 1 where participant_id = b.participant_id
  returning * into b;
  return jsonb_build_object('ok', true, 'rev', b.rev);
end $$;

-- ---------------------------------------------------------------------
-- 小組共同分類
--   * 每個操作在伺服器端鎖住小組列後依序執行。
--   * 故事歸屬、分類名稱、分類理由各自有版本號；過期版本一律拒絕並回傳最新值。
--   * 文字欄位與拖曳中的故事卡可取得 15 秒操作鎖（需持續續約，斷線即自動失效）。
-- ---------------------------------------------------------------------
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
    'group_number', g.number, 'group_name', g.name, 'status', g.status, 'board_rev', g.board_rev,
    'can_edit', s.status = 'active' and st.phase = '04' and not st.editing_paused and g.status = 'open',
    'problems', app.group_problems(g.id),
    'locks', coalesce((select jsonb_agg(jsonb_build_object('target', target, 'mine', participant_id = p.id))
                         from public.group_locks where group_id = g.id and expires_at > now()), '[]'::jsonb));
end $$;

create or replace function public.group_add_category(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_no int; v_cat public.group_categories;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  if (select count(*) from public.group_categories where group_id = c.group_id) >= 20 then
    raise exception 'TOO_MANY';
  end if;
  select coalesce(max(label_no), 0) + 1 into v_no from public.group_categories where group_id = c.group_id;
  insert into public.group_categories (group_id, label_no) values (c.group_id, v_no) returning * into v_cat;
  return jsonb_build_object('ok', true, 'category_id', v_cat.id, 'label_no', v_no, 'board_rev', app.bump_board(c.group_id));
end $$;

-- 移動故事卡；p_category 為 null 表示移回未分類區
create or replace function public.group_move_card(p_session uuid, p_token text, p_card uuid,
  p_category uuid, p_expected_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_rev bigint; v_cur uuid; v_holder uuid;
begin
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
declare c record;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  if not exists (select 1 from public.group_categories where id = p_category and group_id = c.group_id) then
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
  update public.group_placements set category_id = null, rev = rev + 1, updated_at = now()
   where group_id = c.group_id and category_id = p_category;
  delete from public.group_locks where group_id = c.group_id
     and target in ('name:' || p_category, 'reason:' || p_category);
  delete from public.group_categories where id = p_category;
  return jsonb_build_object('ok', true, 'board_rev', app.bump_board(c.group_id));
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
  if v_holder is null then perform app.notify('group:' || c.group_id, 'lock'); end if;
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end $$;

-- 提交小組成果：必須基於最新版本（p_expected_board_rev），且資料完整
create or replace function public.group_submit(p_session uuid, p_token text, p_expected_board_rev bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; g public.groups; v_prob jsonb;
begin
  select * into c from app.group_edit_ctx(p_session, p_token);
  select * into g from public.groups where id = c.group_id;
  if g.board_rev <> p_expected_board_rev then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'board_rev', g.board_rev);
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
