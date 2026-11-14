-- =====================================================================
-- 故事找朋友｜第 01 環節「走進故事世界」正式教材 v1（兩則神祕故事的線索、揭曉、名字變化、揭曉圖與單元文案）
--
-- 用途：已部署的資料庫把預設素材組的兩則佔位探索故事換成正式教材。可重複執行（結果相同）。
-- 前置：先執行 supabase/upgrade/upgrade.sql（建立 intro_stories.name_before／name_after／image_alt 與 content_sets.intro_text）。
-- 文字來源：source-assets/intro/01走進故事世界_投影文字.docx，由 tools/intro_text.py 逐字抽出（docs/intro-source.json）。
--
-- 一對一更新表（依 slug；id、slug、sort_order 不變；線索依 sort_order 1～3 更新，不新增、不刪除）：
--   intro-1 → 《名偵探柯南》（工藤新一 → 江戶川柯南）    intro-2 → 《神隱少女》（荻野千尋 → 小千）
--
-- 安全設計（任何一項不符合就整筆中止、資料庫完全不變）：
--   * 只更新預設素材組（content_sets.is_default）的兩則探索故事、各三條線索與 content_sets.intro_text。
--   * 探索故事順序（sort_order, slug）必須正好是 intro-1, intro-2，且每則正好有 sort_order 1、2、3 三條線索。
--   * 若有使用這份素材、2 小時內仍有動作的進行中場次，中止。這只是「預檢」，不是維護鎖，請在沒有課堂時執行
--     （確認無誤可把下面的 allow_during_class 改成 true）。
--   * 不修改 session_state、快照或任何學生資料；不碰故事卡（story_cards）與小說類型（genres）。
--     已公開在投影上的 01 畫面保留舊文字，直到教師再次操作 01。
-- 回復：supabase/content/intro_materials_v1_rollback.sql（還原成第一次執行本檔之前的內容）。
-- =====================================================================
begin;

-- 更新前的內容備份（只在第一次執行時寫入）。放在 app schema（PostgREST 不公開），並收回所有前端角色的權限。
create table if not exists app.intro_material_backups (
  version text not null, content_set_id uuid not null, slug text not null, clue_order int not null default 0,   -- clue_order 0＝故事本身；slug '*'＝素材組文案
  title text, reveal_text text, image_url text, background_url text, name_before text, name_after text, image_alt text,
  kind text, label text, body text, clue_image_url text, intro_text jsonb,
  taken_at timestamptz not null default now(),
  primary key (version, content_set_id, slug, clue_order));
alter table app.intro_material_backups enable row level security;
revoke all on app.intro_material_backups from public, anon, authenticated;

do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_clues text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if v_set is null then raise exception '找不到預設素材組（content_sets.is_default）'; end if;
  if (select count(*) from information_schema.columns where table_schema = 'public'
        and ((table_name = 'intro_stories' and column_name in ('name_before', 'name_after', 'image_alt'))
          or (table_name = 'content_sets' and column_name = 'intro_text'))) <> 4 then
    raise exception '請先執行 supabase/upgrade/upgrade.sql（缺少第一環節的新欄位）';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.intro_stories where content_set_id = v_set;
  if v_order is distinct from 'intro-1,intro-2' then
    raise exception '探索故事順序不符（預期 intro-1、intro-2），未做任何修改。目前順序：%', coalesce(v_order, '（沒有探索故事）');
  end if;
  select string_agg(i.slug || ':' || c.sort_order, ',' order by i.sort_order, c.sort_order) into v_clues
    from public.intro_stories i join public.intro_clues c on c.story_id = i.id where i.content_set_id = v_set;
  if v_clues is distinct from 'intro-1:1,intro-1:2,intro-1:3,intro-2:1,intro-2:2,intro-2:3' then
    raise exception '線索不符（預期每則三條、順序 1～3），未做任何修改。目前：%', coalesce(v_clues, '（沒有線索）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行（或結束這些場次）。', v_live;
  end if;

  insert into app.intro_material_backups (version, content_set_id, slug, clue_order, title, reveal_text, image_url, background_url, name_before, name_after, image_alt)
  select 'v1', i.content_set_id, i.slug, 0, i.title, i.reveal_text, i.image_url, i.background_url, i.name_before, i.name_after, i.image_alt
    from public.intro_stories i where i.content_set_id = v_set
  on conflict do nothing;
  insert into app.intro_material_backups (version, content_set_id, slug, clue_order, kind, label, body, clue_image_url)
  select 'v1', i.content_set_id, i.slug, c.sort_order, c.kind, c.label, c.body, c.image_url
    from public.intro_stories i join public.intro_clues c on c.story_id = i.id where i.content_set_id = v_set
  on conflict do nothing;
  insert into app.intro_material_backups (version, content_set_id, slug, clue_order, intro_text)
  select 'v1', c.id, '*', 0, c.intro_text from public.content_sets c where c.id = v_set
  on conflict do nothing;

  update public.intro_stories i set
    title = v.title, reveal_text = v.reveal_text, name_before = v.name_before, name_after = v.name_after,
    image_url = v.image_url, image_alt = v.image_alt, background_url = null
  from (values
    ('intro-1', '名偵探柯南', '為了保護自己和身邊的人，新一主動取了化名，把真正的身分藏起來。', '工藤新一', '江戶川柯南', 'assets/intro/conan-1600.webp', '《名偵探柯南》揭曉圖：工藤新一與江戶川柯南並肩思考'),
    ('intro-2', '神隱少女', '簽下契約後，千尋被改叫「小千」。她必須記得自己原來的名字。', '荻野千尋', '小千', 'assets/intro/chihiro-1600.webp', '《神隱少女》揭曉圖：千尋在湯婆婆面前簽下契約')
  ) as v(slug, title, reveal_text, name_before, name_after, image_url, image_alt)
  where i.content_set_id = v_set and i.slug = v.slug;
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception '預期更新 2 則探索故事，實際 % 則；未做任何修改', v_n; end if;

  -- 線索：kind 改為 other（原稿沒有分類），不顯示插畫
  update public.intro_clues c set kind = 'other', label = v.label, body = v.body, image_url = null
  from (values
    ('intro-1', 1, '發生了什麼事？', '一名高中生被灌下藥物。醒來時，他發現自己的身體竟然變成了小學生的模樣。'),
    ('intro-1', 2, '為什麼換了名字？', '為了隱藏自己還活著的事實，他替自己取了一個新名字。'),
    ('intro-1', 3, '原來的名字為什麼重要？', '如果灌他藥的人發現這個孩子就是當年的高中生，他和身邊的人都可能遇到危險。'),
    ('intro-2', 1, '發生了什麼事？', '一名女孩和父母穿過隧道，走進陌生的小鎮。父母吃下店裡的食物後，竟然變成了豬。'),
    ('intro-2', 2, '為什麼換了名字？', '為了留下來工作，女孩簽下一份契約。湯婆婆收走她名字裡的字，只留下一個「千」。'),
    ('intro-2', 3, '原來的名字為什麼重要？', '白龍提醒她，一定要記住自己的真名。如果連她自己也忘了，就可能找不到回家的路。')
  ) as v(slug, ord, label, body), public.intro_stories i
  where i.content_set_id = v_set and i.slug = v.slug and c.story_id = i.id and c.sort_order = v.ord;
  get diagnostics v_n = row_count;
  if v_n <> 6 then raise exception '預期更新 6 條線索，實際 % 條；未做任何修改', v_n; end if;

  update public.content_sets set intro_text = '{"opening": "今天，我們要猜兩個故事。每看到一條線索，就想一想：你猜的是哪一部作品？哪個細節讓你這樣想？", "compare_title": "兩個故事放在一起", "compare_prompts": ["新一最怕誰認出他？千尋為什麼要記住自己的真名？"], "naming_prompt": "如果把這兩個故事放在同一組，你會幫這一組取什麼名字？哪一條線索最能支持你的分法？", "bridge_title": "接下來，換你分類", "bridge_text": "讀一讀八張故事卡，把有共同特色的故事放在一起，替每一組取個名字。你在故事裡找到哪些線索，讓你決定這樣分？"}'::jsonb where id = v_set;
end $$;

commit;

-- 結果（應為兩列，順序 intro-1 → intro-2，ok 都是 true）
select i.slug, i.title, i.name_before || ' → ' || i.name_after as names,
       i.image_url like 'assets/intro/%-1600.webp' and coalesce(i.image_alt, '') <> ''
       and (select count(*) from public.intro_clues c where c.story_id = i.id and c.kind = 'other') = 3
       and (select intro_text ? 'opening' from public.content_sets where id = i.content_set_id) as ok
  from public.intro_stories i join public.content_sets s on s.id = i.content_set_id
 where s.is_default order by i.sort_order, i.slug;
