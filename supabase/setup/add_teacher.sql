-- 把教師帳號加入白名單（每位教師執行一次）
-- 1. 先在 Supabase Dashboard → Authentication → Users → Add user 建立教師帳號（Email＋密碼）
-- 2. 把下面的 Email 改成該帳號後，在 SQL Editor 執行
insert into public.teachers (user_id, email)
select id, email from auth.users where email = 'teacher@example.com'
on conflict (user_id) do nothing;

-- 確認結果（應出現一列）
select t.email, t.created_at from public.teachers t where t.email = 'teacher@example.com';
