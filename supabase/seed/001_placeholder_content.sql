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
  ('story-a', 1, '故事 A', '（示意）一位少年在森林裡發現會說話的樹。',
   E'（測試用文字，正式素材確定後替換）\n阿樹住在山腳下的小村子。有一天，他追著一隻發光的松鼠走進森林深處，聽見身旁的老橡樹輕輕嘆了一口氣。老橡樹說，森林的泉水正在一點一點乾涸，只有找到藏在三座山後的「月光種子」，才能讓森林重新長出綠葉。\n阿樹帶著老橡樹送給他的一片葉子出發。葉子會在危險靠近時變成紅色，也會在夜裡為他指出方向。一路上，他遇見怕水的河童、愛說謊的狐狸，還有一位迷路的旅人。阿樹必須分辨誰說的是真話，並決定要不要相信這些奇怪的同伴。'),
  ('story-b', 2, '故事 B', '（示意）小鎮接連發生怪事，有人留下奇怪的記號。',
   E'（測試用文字，正式素材確定後替換）\n一連三個晚上，海邊小鎮的商店門口都出現了用粉筆畫的三角形記號。第一天，麵包店的招牌不見了；第二天，鐘樓的時鐘停在九點十五分；第三天，圖書館少了一本沒有人借過的舊地圖。\n小鎮的孩子小晴發現，三個記號的尖角都指向同一個方向。她把每件事發生的時間、地點和留下的線索寫在筆記本上，一一比對，又請教了每天清晨送報的老伯。真相似乎就藏在那本舊地圖裡，可是，畫下記號的人究竟想告訴大家什麼？'),
  ('story-c', 3, '故事 C', '（示意）很久以前的某個朝代，一位小書僮的經歷。',
   E'（測試用文字，正式素材確定後替換）\n很久很久以前，京城裡有一位十二歲的小書僮，名叫硯生。他每天替主人磨墨、整理書卷，也偷偷在燭光下自己學寫字。那一年，城外連月乾旱，米價一天比一天高，街上到處是逃難的人。\n有一天，主人要硯生把一封重要的信送到城南的官府。路上，他看見官差強收百姓僅剩的糧食，也聽到茶館裡的人議論朝廷的新政策。硯生握緊懷中的信，心裡開始猶豫：這封信，會讓百姓的日子變好，還是變得更苦？'),
  ('story-d', 4, '故事 D', '（示意）一群孩子划著小船，前往地圖上沒有的小島。',
   E'（測試用文字，正式素材確定後替換）\n暑假的最後一個星期，四個好朋友在外婆家的閣樓裡找到一張泛黃的海圖。海圖上畫著一座小島，旁邊寫著：「退潮時，路會出現。」可是無論翻遍哪一本地圖，都找不到這座島。\n他們借來漁夫爺爺的小船，帶著水壺、繩子和手電筒出發。海上起了大霧，指南針忽然亂轉，小船差點撞上礁石。四個人必須分工合作：有人看海浪、有人划槳、有人記錄方向。當霧散去時，他們眼前真的出現了一片從來沒有人走過的沙灘。'),
  ('story-e', 5, '故事 E', '（示意）年輕的劍客為了守護村莊，踏上江湖。',
   E'（測試用文字，正式素材確定後替換）\n竹林村的少年林青，從小跟著隱居的師父練劍。師父總說：「劍是用來保護別人，不是用來逞強的。」一天夜裡，一群蒙面人闖進村子，搶走了村民賴以為生的藥材，還留下一句話：要拿回藥材，就到三百里外的黑風寨來。\n林青告別師父，背著木劍踏上旅途。路上，他遇見行俠仗義的女俠，也遇見假裝好人的騙子；他學會了在客棧裡打聽消息，也學會在比武時手下留情。最後，他終於站在黑風寨的大門前，卻發現寨主竟然和師父有著很深的關係。'),
  ('story-f', 6, '故事 F', '（示意）魔法學校的新生發現一扇不該打開的門。',
   E'（測試用文字，正式素材確定後替換）\n星語學院建在雲上，學生們騎著掃帚上課，用會唱歌的羽毛筆寫作業。新生米亞第一天報到，就在走廊盡頭看見一扇沒有把手的藍色木門。學長姊都說，那扇門已經一百年沒有人打開過了。\n某天晚上，米亞在圖書館的魔法書裡讀到一句咒語，門竟然自己慢慢打開了。門的另一邊，是一座時間停止的花園，花園中央站著一位看起來和米亞一模一樣的女孩。女孩說：「我等你很久了。只有你能讓花園的時間重新開始。」'),
  ('story-g', 7, '故事 G', '（示意）博物館的寶物不見了，只留下一張車票。',
   E'（測試用文字，正式素材確定後替換）\n市立博物館最珍貴的玉雕「青鳥」，在開館前一個小時消失了。展示櫃完好無缺，警報器也沒有響，地上只留下一張上午七點零五分開往山城的火車票。\n館長、清潔員、夜班警衛和一位提早到場的記者，每個人都說自己沒有離開過大廳。十一歲的小偵探阿哲注意到：車票上的剪票孔位置不太對，警衛的鞋底沾著一點紅色泥土，而記者的相機裡少了一張照片。他把線索排在一起，一步一步推理出寶物真正的去向。'),
  ('story-h', 8, '故事 H', '（示意）沙漠中的探險隊遇到暴風，必須找到綠洲。',
   E'（測試用文字，正式素材確定後替換）\n為了尋找傳說中的古城遺跡，一支五人探險隊騎著駱駝深入大沙漠。第三天下午，天空忽然變成橘紅色，巨大的沙暴從地平線捲了過來。等風停下時，他們發現水壺破了一個洞，原本的路線也被沙丘完全掩蓋。\n隊伍裡年紀最小的阿米爾記得，祖父說過：夜晚的星星和清晨的露水，都能告訴人們綠洲在哪裡。大家輪流守夜、節省每一口水，靠著星星辨認方向。在最後一點力氣用完之前，他們能找到那片長著椰棗樹的綠洲嗎？')
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
