-- =====================================================================
-- 故事找朋友｜佔位教學素材（可重複執行；以 slug 對應，重跑會更新文字）
--
-- 換成正式素材的方式：
--   1. 直接在 Supabase Table Editor 修改 story_cards / intro_stories /
--      intro_clues / genres 的文字與 *_url 欄位；或
--   2. 修改本檔後重新執行。
--   圖片網址可填 GitHub Pages 上的相對路徑（例如 assets/story-a.png）或完整網址；
--   留空（null）時畫面會顯示虛線佔位框。
--   故事卡數量、第一環節故事數與線索數都不限，畫面依資料自動調整。
--
-- 注意：已建立的場次會沿用同一份素材；上課中請勿刪除故事卡，
--       否則該故事的分類紀錄會一併刪除。
-- =====================================================================

insert into public.content_sets (slug, title, is_default)
values ('default', '故事找朋友（佔位素材）', true)
on conflict (slug) do update set title = excluded.title;

-- ---------- 第三、四環節：故事卡 A～H ----------
with s as (select id from public.content_sets where slug = 'default')
insert into public.story_cards (content_set_id, slug, sort_order, title, summary, detail, image_url)
select s.id, v.slug, v.ord, v.title, v.summary, v.detail, null from s, (values
  ('story-a', 1, '故事 A', '（示意）一位少年在森林裡發現會說話的樹。', '（示意文字）這裡放故事 A 的詳細介紹，約 80～150 字，說明人物、背景與主要情節。正式素材確定後替換。'),
  ('story-b', 2, '故事 B', '（示意）小鎮接連發生怪事，有人留下奇怪的記號。', '（示意文字）這裡放故事 B 的詳細介紹。'),
  ('story-c', 3, '故事 C', '（示意）很久以前的某個朝代，一位小書僮的經歷。', '（示意文字）這裡放故事 C 的詳細介紹。'),
  ('story-d', 4, '故事 D', '（示意）一群孩子划著小船，前往地圖上沒有的小島。', '（示意文字）這裡放故事 D 的詳細介紹。'),
  ('story-e', 5, '故事 E', '（示意）年輕的劍客為了守護村莊，踏上江湖。', '（示意文字）這裡放故事 E 的詳細介紹。'),
  ('story-f', 6, '故事 F', '（示意）魔法學校的新生發現一扇不該打開的門。', '（示意文字）這裡放故事 F 的詳細介紹。'),
  ('story-g', 7, '故事 G', '（示意）博物館的寶物不見了，只留下一張車票。', '（示意文字）這裡放故事 G 的詳細介紹。'),
  ('story-h', 8, '故事 H', '（示意）沙漠中的探險隊遇到暴風，必須找到綠洲。', '（示意文字）這裡放故事 H 的詳細介紹。')
) as v(slug, ord, title, summary, detail)
on conflict (content_set_id, slug) do update
  set sort_order = excluded.sort_order, title = excluded.title,
      summary = excluded.summary, detail = excluded.detail;

-- ---------- 第一環節：故事探索（兩個故事 × 三個線索） ----------
with s as (select id from public.content_sets where slug = 'default')
insert into public.intro_stories (content_set_id, slug, sort_order, title, reveal_text, image_url, background_url)
select s.id, v.slug, v.ord, v.title, v.reveal, null, null from s, (values
  ('intro-1', 1, '神祕故事一（佔位名稱）', '（示意）揭曉時顯示的故事名稱與相關資訊。'),
  ('intro-2', 2, '神祕故事二（佔位名稱）', '（示意）揭曉時顯示的故事名稱與相關資訊。')
) as v(slug, ord, title, reveal)
on conflict (content_set_id, slug) do update
  set sort_order = excluded.sort_order, title = excluded.title, reveal_text = excluded.reveal_text;

with st as (
  select i.id, i.slug from public.intro_stories i
  join public.content_sets c on c.id = i.content_set_id and c.slug = 'default')
insert into public.intro_clues (story_id, sort_order, kind, label, body)
select st.id, v.ord, v.kind, v.label, v.body from st join (values
  ('intro-1', 1, 'background', '背景線索', '（示意）一座被霧包圍的古老城堡。'),
  ('intro-1', 2, 'character',  '人物線索', '（示意）一位戴著斗篷的少女。'),
  ('intro-1', 3, 'plot',       '情節線索', '（示意）她必須在月圓之前找到失落的鑰匙。'),
  ('intro-2', 1, 'background', '背景線索', '（示意）下著大雨的城市街道。'),
  ('intro-2', 2, 'object',     '物件線索', '（示意）一只停在三點十五分的懷錶。'),
  ('intro-2', 3, 'plot',       '情節線索', '（示意）有人在半夜聽見奇怪的敲門聲。')
) as v(slug, ord, kind, label, body) on v.slug = st.slug
on conflict (story_id, sort_order) do update
  set kind = excluded.kind, label = excluded.label, body = excluded.body;

-- ---------- 第六、七環節：五種小說類型（教學文字草案，待依課本校對） ----------
-- 圖示目前以 emoji 佔位，可改為圖片網址或其他符號。
with s as (select id from public.content_sets where slug = 'default')
insert into public.genres (content_set_id, slug, sort_order, name, elements, teacher_notes)
select s.id, v.slug, v.ord, v.name, v.elements::jsonb, v.notes from s, (values
  ('fantasy',   1, '奇幻小說',
   '[{"label":"想像世界","icon":"🌌"},{"label":"神奇力量","icon":"✨"},{"label":"超自然現象","icon":"🌀"}]',
   '（教師補充，佔位）'),
  ('detective', 2, '偵探小說',
   '[{"label":"神祕案件","icon":"❓"},{"label":"尋找線索","icon":"🔍"},{"label":"推理解謎","icon":"🧩"}]',
   '（教師補充，佔位）'),
  ('historical',3, '歷史小說',
   '[{"label":"歷史時代","icon":"🏯"},{"label":"真實背景","icon":"📜"},{"label":"虛構故事","icon":"🖋️"}]',
   '（教師補充，佔位）'),
  ('adventure', 4, '冒險小說',
   '[{"label":"未知探索","icon":"🧭"},{"label":"困難挑戰","icon":"⛰️"},{"label":"冒險旅程","icon":"🗺️"}]',
   '（教師補充，佔位）'),
  ('wuxia',     5, '武俠小說',
   '[{"label":"江湖世界","icon":"🏞️"},{"label":"武藝對決","icon":"⚔️"},{"label":"俠義精神","icon":"🤝"}]',
   '（教師補充，佔位）')
) as v(slug, ord, name, elements, notes)
on conflict (content_set_id, slug) do update
  set sort_order = excluded.sort_order, name = excluded.name, elements = excluded.elements,
      teacher_notes = excluded.teacher_notes;
