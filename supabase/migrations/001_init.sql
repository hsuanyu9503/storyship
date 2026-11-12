-- =====================================================================
-- 故事找朋友｜資料庫初始化（只需在 Supabase SQL Editor 執行一次）
--
-- 設計原則
--   * 前端只持有 anon（publishable）key，所有學生／投影端操作都經由
--     SECURITY DEFINER RPC，在伺服器端檢查「裝置憑證＋目前教學環節」。
--   * anon、authenticated 角色對資料表沒有直接寫入權限；教師只能透過
--     RLS 讀取自己的場次資料，寫入一律走 RPC。
--   * 個人分類（personal_*）與小組分類（group_*）是完全分離的資料表，
--     小組共作的任何 RPC 都不會寫入個人資料。
--   * 每一筆可被多人修改的資料都有版本號（rev），伺服器拒絕過期版本；
--     文字欄位另有可逾時的伺服器操作鎖（group_locks）。
--   * 錯誤以 raise exception '<代碼>' 回傳（前端 js/lib/api.js 解析）。
-- =====================================================================

create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------------
-- 1. 教師白名單
-- ---------------------------------------------------------------------
create table public.teachers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. 教學素材（資料驅動；正式素材只需替換資料列與圖片網址）
-- ---------------------------------------------------------------------
create table public.content_sets (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  title      text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index content_sets_one_default on public.content_sets (is_default) where is_default;

-- 第三、四環節的故事卡
create table public.story_cards (
  id             uuid primary key default gen_random_uuid(),
  content_set_id uuid not null references public.content_sets(id) on delete cascade,
  slug           text not null,
  sort_order     int  not null default 0,
  title          text not null,
  summary        text not null default '',
  detail         text not null default '',
  image_url      text,                 -- 空值＝顯示圖片佔位框
  image_alt      text,
  unique (content_set_id, slug)
);

-- 第一環節：故事探索（故事數、線索數皆可任意調整）
create table public.intro_stories (
  id             uuid primary key default gen_random_uuid(),
  content_set_id uuid not null references public.content_sets(id) on delete cascade,
  slug           text not null,
  sort_order     int  not null default 0,
  title          text not null,
  reveal_text    text not null default '',
  image_url      text,                 -- 故事代表圖片
  background_url text,                 -- 情境背景
  unique (content_set_id, slug)
);

create table public.intro_clues (
  id         uuid primary key default gen_random_uuid(),
  story_id   uuid not null references public.intro_stories(id) on delete cascade,
  sort_order int  not null default 0,
  kind       text not null default 'other' check (kind in ('background','character','plot','object','other')),
  label      text not null,
  body       text not null default '',
  image_url  text,                     -- 人物／物件插畫
  unique (story_id, sort_order)
);

-- 第六、七環節：小說類型與三個核心要素
create table public.genres (
  id             uuid primary key default gen_random_uuid(),
  content_set_id uuid not null references public.content_sets(id) on delete cascade,
  slug           text not null,
  sort_order     int  not null default 0,
  name           text not null,
  elements       jsonb not null default '[]'::jsonb   -- [{"label":"想像世界","icon":"✨"}, ...]
                 check (jsonb_typeof(elements) = 'array'),
  visual_url     text,                 -- 小說類型主視覺
  teacher_notes  text,                 -- 只給教師端看的補充資料
  unique (content_set_id, slug)
);

-- ---------------------------------------------------------------------
-- 3. 教學場次、課堂狀態、小組、匿名學生
-- ---------------------------------------------------------------------
create table public.sessions (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid not null references auth.users(id) on delete cascade,
  content_set_id uuid not null references public.content_sets(id),
  title          text not null check (char_length(title) between 1 and 40),
  join_code      text not null check (join_code ~ '^[A-Z0-9]{6}$'),
  projector_key  text not null,
  status         text not null default 'active' check (status in ('active','ended')),
  join_open      boolean not null default true,
  retention_days int  not null default 30 check (retention_days between 1 and 365),
  created_at     timestamptz not null default now(),
  ended_at       timestamptz
);
create unique index sessions_active_code on public.sessions (join_code) where status = 'active';
create index sessions_teacher on public.sessions (teacher_id, created_at desc);

-- 由教師控制的課堂狀態：三端都依此同步
create table public.session_state (
  session_id     uuid primary key references public.sessions(id) on delete cascade,
  phase          text not null default '00',
  sub            text not null default '00',
  projection     jsonb not null default '{"screen":"join"}'::jsonb,  -- 只放「已核准公開」的投影內容
  rev            bigint not null default 1,
  focus_mode     boolean not null default false,
  editing_paused boolean not null default false,
  updated_at     timestamptz not null default now()
);

create table public.groups (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.sessions(id) on delete cascade,
  number       int  not null check (number between 1 and 12),
  name         text not null,
  capacity     int  check (capacity is null or capacity between 1 and 40),
  status       text not null default 'open' check (status in ('open','submitted','locked')),
  board_rev    bigint not null default 0,      -- 小組工作區任何變更都 +1
  seat_seq     int  not null default 0,
  submitted_at timestamptz,
  unique (session_id, number)
);

create table public.participants (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.sessions(id) on delete cascade,
  group_id     uuid references public.groups(id) on delete set null,
  token_hash   text not null,                  -- 只存裝置憑證的 SHA-256
  seat_label   text not null,
  status       text not null default 'active' check (status in ('active','removed')),
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (session_id, token_hash)
);
create index participants_group on public.participants (group_id) where status = 'active';

-- ---------------------------------------------------------------------
-- 4. 個人分類（草稿＋第四環節開始時的唯讀快照）
--    data = {"categories":[{"id":"c1","no":1,"name":"會魔法"}],
--            "placements":{"<card uuid>":"c1", ...}}
-- ---------------------------------------------------------------------
create table public.personal_boards (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  session_id     uuid not null references public.sessions(id) on delete cascade,
  data           jsonb not null default '{"categories":[],"placements":{}}'::jsonb,
  rev            bigint not null default 0,
  updated_at     timestamptz not null default now(),
  submitted_at   timestamptz
);
create index personal_boards_session on public.personal_boards (session_id);

create table public.personal_snapshots (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  session_id     uuid not null references public.sessions(id) on delete cascade,
  data           jsonb not null,
  is_complete    boolean not null,
  submitted      boolean not null,
  board_rev      bigint not null,
  taken_at       timestamptz not null default now()
);
create index personal_snapshots_session on public.personal_snapshots (session_id);

-- ---------------------------------------------------------------------
-- 5. 小組共同分類（正規化成多列，讓不同欄位可各自做版本檢查）
-- ---------------------------------------------------------------------
create table public.group_categories (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  label_no   int  not null,                       -- 暫時名稱「分類 N」
  name       text not null default '' check (char_length(name) <= 30),
  reason     text not null default '' check (char_length(reason) <= 300),
  name_rev   bigint not null default 1,
  reason_rev bigint not null default 1,
  created_at timestamptz not null default now()
);
create index group_categories_group on public.group_categories (group_id);

-- 沒有資料列＝該故事尚未分類（rev 視為 0）
create table public.group_placements (
  group_id    uuid not null references public.groups(id) on delete cascade,
  card_id     uuid not null references public.story_cards(id) on delete cascade,
  category_id uuid references public.group_categories(id) on delete set null,
  rev         bigint not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (group_id, card_id)
);

-- 伺服器協調的短暫操作鎖（逾時自動失效）
create table public.group_locks (
  group_id       uuid not null references public.groups(id) on delete cascade,
  target         text not null,                    -- card:<uuid> | name:<uuid> | reason:<uuid>
  participant_id uuid not null references public.participants(id) on delete cascade,
  expires_at     timestamptz not null,
  primary key (group_id, target)
);

-- 小組正式成果（提交或教師鎖定時寫入；之後的解鎖不會刪除舊快照）
create table public.group_snapshots (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  session_id  uuid not null references public.sessions(id) on delete cascade,
  kind        text not null check (kind in ('submitted','locked')),
  data        jsonb not null,
  is_complete boolean not null,
  board_rev   bigint not null,
  created_at  timestamptz not null default now()
);
create index group_snapshots_group on public.group_snapshots (group_id, created_at desc);

-- =====================================================================
-- 內部輔助函式（schema app，不經 API 公開）
-- =====================================================================
create or replace function app.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.is_teacher() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.teachers where user_id = auth.uid());
$$;

create or replace function app.is_session_teacher(p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.sessions s join public.teachers t on t.user_id = s.teacher_id
                 where s.id = p_session and s.teacher_id = auth.uid());
$$;

create or replace function app.hash_token(p_token text) returns text
language plpgsql immutable as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32,128}$' then
    raise exception 'INVALID_TOKEN';
  end if;
  return encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
end $$;

-- 即時通知：只送「有變更」的訊號，不含任何教學內容；資料一律由 RPC 重新讀取。
-- Realtime 不可用時靜默略過（前端會自動輪詢）。
create or replace function app.notify(p_topic text, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('kind', p_kind), 'changed', p_topic, false);
exception when others then
  null;
end $$;

create or replace function app.require_teacher() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not app.is_teacher() then raise exception 'FORBIDDEN'; end if;
end $$;

-- 取得教師自己的場次（並鎖定該列，避免同時操作）
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

-- 依裝置憑證找學生（不含已移出者的權限判斷）
create or replace function app.participant(p_session uuid, p_token text) returns public.participants
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants;
begin
  select * into p from public.participants
   where session_id = p_session and token_hash = app.hash_token(p_token);
  if not found then raise exception 'NOT_JOINED'; end if;
  return p;
end $$;

create or replace function app.active_participant(p_session uuid, p_token text) returns public.participants
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.participants;
begin
  p := app.participant(p_session, p_token);
  if p.status <> 'active' or p.group_id is null then raise exception 'REMOVED'; end if;
  return p;
end $$;

-- 環節代碼（與 js/lib/phases.js 一致；字串可直接比較先後）
create or replace function app.valid_phase(p text) returns boolean
language sql immutable as $$ select p in ('00','01','02','03','04','05','06','07','99') $$;

-- ---------- 個人分類：資料檢查 ----------
-- 回傳整理後的資料；格式錯誤或引用不存在的故事／分類時 raise BAD_DATA
create or replace function app.normalize_personal(p_data jsonb, p_set uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cats jsonb := coalesce(p_data -> 'categories', '[]'::jsonb);
  pl   jsonb := coalesce(p_data -> 'placements', '{}'::jsonb);
  c jsonb; k text; v jsonb;
  ids text[] := '{}';
  out_cats jsonb := '[]'::jsonb;
  out_pl jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_data) <> 'object' or jsonb_typeof(cats) <> 'array' or jsonb_typeof(pl) <> 'object' then
    raise exception 'BAD_DATA';
  end if;
  if jsonb_array_length(cats) > 30 then raise exception 'BAD_DATA'; end if;
  for c in select * from jsonb_array_elements(cats) loop
    if jsonb_typeof(c) <> 'object' or coalesce(c ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,40}$'
       or (c ->> 'id') = any(ids)
       or char_length(coalesce(c ->> 'name', '')) > 30 then
      raise exception 'BAD_DATA';
    end if;
    ids := ids || (c ->> 'id');
    out_cats := out_cats || jsonb_build_object(
      'id', c ->> 'id',
      'no', coalesce((c ->> 'no')::int, cardinality(ids)),
      'name', btrim(coalesce(c ->> 'name', '')));
  end loop;
  for k, v in select * from jsonb_each(pl) loop
    if jsonb_typeof(v) = 'null' then continue; end if;
    if k !~ '^[0-9a-f-]{36}$'
       or not exists (select 1 from public.story_cards where id = k::uuid and content_set_id = p_set)
       or jsonb_typeof(v) <> 'string' or not ((v #>> '{}') = any(ids)) then
      raise exception 'BAD_DATA';
    end if;
    out_pl := out_pl || jsonb_build_object(k, v);
  end loop;
  return jsonb_build_object('categories', out_cats, 'placements', out_pl);
end $$;

-- 完整性檢查（只檢查是否完成，不判斷分類對錯）
-- 有效分類＝至少放了一張故事卡的分類
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

-- 第三環節結束時保存個人快照（未完成者也保留已儲存部分）
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

-- ---------- 小組分類 ----------
create or replace function app.group_board_json(p_group uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'label_no', c.label_no, 'name', c.name, 'reason', c.reason,
        'name_rev', c.name_rev, 'reason_rev', c.reason_rev) order by c.label_no, c.created_at)
      from public.group_categories c where c.group_id = p_group), '[]'::jsonb),
    'placements', coalesce((select jsonb_agg(jsonb_build_object(
        'card_id', sc.id, 'category_id', gp.category_id, 'rev', coalesce(gp.rev, 0)) order by sc.sort_order, sc.slug)
      from public.groups g
      join public.sessions s on s.id = g.session_id
      join public.story_cards sc on sc.content_set_id = s.content_set_id
      left join public.group_placements gp on gp.group_id = g.id and gp.card_id = sc.id
      where g.id = p_group), '[]'::jsonb));
$$;

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

create or replace function app.bump_board(p_group uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare r bigint;
begin
  update public.groups set board_rev = board_rev + 1 where id = p_group returning board_rev into r;
  perform app.notify('group:' || p_group, 'board');
  return r;
end $$;

create or replace function app.lock_holder(p_group uuid, p_target text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select participant_id from public.group_locks
   where group_id = p_group and target = p_target and expires_at > now();
$$;

-- 小組編輯前置檢查：回傳學生與小組，並以 FOR UPDATE 鎖住小組列，
-- 讓同一組的所有寫入在伺服器端依序執行（原子操作）。
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

-- =====================================================================
-- 觸發器：課堂狀態、小組狀態、名單變更時送出即時通知
-- =====================================================================
create or replace function app.trg_notify_lesson() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.notify('lesson:' || coalesce(new.session_id, old.session_id), tg_table_name);
  return null;
end $$;

create trigger session_state_notify after update on public.session_state
  for each row execute function app.trg_notify_lesson();
create trigger groups_notify after update on public.groups
  for each row when (old.status is distinct from new.status or old.capacity is distinct from new.capacity
                     or old.name is distinct from new.name)
  execute function app.trg_notify_lesson();
create trigger participants_notify_ins after insert or delete on public.participants
  for each row execute function app.trg_notify_lesson();
create trigger participants_notify_upd after update on public.participants
  for each row when (old.status is distinct from new.status or old.group_id is distinct from new.group_id)
  execute function app.trg_notify_lesson();
