-- 本機測試用：模擬 Supabase 提供的角色、auth schema 與 realtime.send()
-- （只用於 tests/db/run.sh 建立的暫時資料庫，不要在 Supabase 執行）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;

create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create function auth.uid() returns uuid language sql stable as $$
  -- anon（未登入）沒有 sub
  select case when current_setting('role', true) = 'anon' then null
              else nullif(current_setting('request.jwt.claim.sub', true), '')::uuid end
$$;
grant execute on function auth.uid() to anon, authenticated;

create schema realtime;
create table realtime.sent (id bigserial primary key, topic text, event text, payload jsonb, private boolean, at timestamptz default clock_timestamp());
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql as $$ insert into realtime.sent (topic, event, payload, private) values (topic, event, payload, private) $$;
