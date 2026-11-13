-- =====================================================================
-- 故事找朋友｜小說類型教材 v1（正式文字、常見特色、教師補充、圖片）
--
-- 用途：已部署的資料庫更新第 06、07 環節的小說類型教材。可重複執行（結果相同）。
-- 前置：先執行 supabase/upgrade/upgrade.sql（建立 genres.visual_landscape_url、content_sets.genre_teacher_guide 欄位）。
--
-- 安全設計（任何一項不符合就整筆中止、資料庫完全不變）：
--   * 只更新「預設素材組」（content_sets.is_default）中 slug 相符的五筆 genres；不新增、不刪除、不改 id 與 sort_order。
--   * 類型順序（sort_order, slug）必須正好是 fantasy, detective, historical, adventure, wuxia：
--     揭露紀錄與 07 的選擇以「索引」記錄類型，順序不同會造成類型錯置，所以不符時中止、不自動修正。
--   * 若有使用這份素材、2 小時內仍有動作的進行中場次，中止（請在沒有課堂時執行；確認無誤可把下面的 allow_during_class 改成 true）。
--   * 不修改 session_state（projection、disclosure、stage_ctl）、快照或任何學生資料。
--     已公開在投影上的舊文字要等教師重新切換或公開該畫面後才會換成新版。
-- =====================================================================
begin;

-- 更新前的內容備份（只在第一次執行時寫入；回復用 genre_materials_v1_rollback.sql）。
-- 放在 app schema（PostgREST 不公開），並收回所有前端角色的權限。
create table if not exists app.genre_material_backups (
  version text not null, content_set_id uuid not null, slug text not null,   -- slug '*' 為素材組層級（教師共同補充）
  name text, elements jsonb, teacher_notes text, visual_url text, visual_landscape_url text, genre_teacher_guide jsonb,
  taken_at timestamptz not null default now(),
  primary key (version, content_set_id, slug));
alter table app.genre_material_backups enable row level security;
revoke all on app.genre_material_backups from public, anon, authenticated;

do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if v_set is null then raise exception '找不到預設素材組（content_sets.is_default）'; end if;
  if to_regclass('public.genres') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'genres' and column_name = 'visual_landscape_url')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'content_sets' and column_name = 'genre_teacher_guide') then
    raise exception '請先執行 supabase/upgrade/upgrade.sql（缺少 visual_landscape_url 或 genre_teacher_guide 欄位）';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.genres where content_set_id = v_set;
  if v_order is distinct from 'fantasy,detective,historical,adventure,wuxia' then
    raise exception '類型順序不符，為避免揭露紀錄錯置，未做任何修改。目前順序：%', coalesce(v_order, '（沒有類型）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行（或結束這些場次）。', v_live;
  end if;

  insert into app.genre_material_backups (version, content_set_id, slug, name, elements, teacher_notes, visual_url, visual_landscape_url)
  select 'v1', g.content_set_id, g.slug, g.name, g.elements, g.teacher_notes, g.visual_url, g.visual_landscape_url
    from public.genres g where g.content_set_id = v_set
  on conflict do nothing;
  insert into app.genre_material_backups (version, content_set_id, slug, genre_teacher_guide)
  select 'v1', c.id, '*', c.genre_teacher_guide from public.content_sets c where c.id = v_set
  on conflict do nothing;

  update public.genres g set
    name = v.name,
    elements = v.elements,
    teacher_notes = v.notes,
    visual_url = v.portrait,
    visual_landscape_url = v.landscape
  from (values
    ('fantasy', '奇幻',
     '[{"label":"不同於現實的時空"},{"label":"魔法或超自然力量"},{"label":"神祕奇異的事物"}]'::jsonb,
     E'提問：這個世界和現實有哪些不同？神奇力量如何運作？它讓故事發生什麼變化？\n補充：可延伸討論條件與限制，但短篇沒有交代時，不要求學生硬找答案。',
     'assets/genres/fantasy-portrait.webp', 'assets/genres/fantasy-landscape.webp'),
    ('detective', '偵探',
     '[{"label":"離奇事件與謎團"},{"label":"敏銳觀察與分析"},{"label":"透過推理解開謎題"}]'::jsonb,
     E'提問：主角注意到什麼？如何分析這些線索？根據什麼推理出答案？',
     'assets/genres/detective-portrait.webp', 'assets/genres/detective-landscape.webp'),
    ('historical', '歷史',
     '[{"label":"歷史事件或人物"},{"label":"特定的歷史時期"},{"label":"當時的社會風貌"}]'::jsonb,
     E'提問：故事與哪些歷史事件或人物有關？哪些細節呈現當時的生活？\n補充：只出現古裝或「很久以前」不足以判定；歷史小說可以結合史實與虛構。赤壁圖片為情境插畫，不是精確戰場復原。',
     'assets/genres/historical-portrait.webp', 'assets/genres/historical-landscape.webp'),
    ('adventure', '冒險',
     '[{"label":"不尋常的冒險經歷"},{"label":"遭遇危險與困難"},{"label":"運用智慧克服困難"}]'::jsonb,
     E'提問：主角遇到什麼不尋常的事？面臨哪些危險？如何想辦法克服？\n補充：圖卡呈現冒險途中的野營、分工與準備，不代表只要露營就屬於冒險類型。',
     'assets/genres/adventure-portrait.webp', 'assets/genres/adventure-landscape.webp'),
    ('wuxia', '武俠',
     '[{"label":"多以古代為背景"},{"label":"俠客、門派或幫派"},{"label":"人物與群體間的恩怨"}]'::jsonb,
     E'提問：有哪些人物或門派？他們之間有什麼恩怨？\n補充：「多以古代為背景」不是必然條件。武藝、俠義可延伸討論。',
     'assets/genres/wuxia-portrait.webp', 'assets/genres/wuxia-landscape.webp')
  ) as v(slug, name, elements, notes, portrait, landscape)
  where g.content_set_id = v_set and g.slug = v.slug;
  get diagnostics v_n = row_count;
  if v_n <> 5 then raise exception '預期更新 5 筆類型，實際 % 筆；未做任何修改', v_n; end if;

  update public.content_sets set genre_teacher_guide = jsonb_build_object(
    'intro', '剛才我們閱讀故事，從人物、情節和背景找出共同特色。這些特色，也能幫助我們認識小說的類型。今天要認識的是奇幻、偵探、歷史、冒險和武俠。這些特色不只會出現在小說裡，電影、動畫或其他故事中也可能看得到。',
    'reminder', '這三項是幫助我們觀察的常見特色，不是每個故事都必須全部符合。同一個故事，也可能具有不同類型的特色。',
    'image_note', '圖片只提供觀察線索，不能僅憑一張圖判定全部特色。')
  where id = v_set;
end $$;

commit;

-- 結果（應為五列，順序 fantasy → wuxia，ok 都是 true）
select g.slug, g.name, jsonb_array_length(g.elements) = 3 and g.visual_url like 'assets/genres/%-portrait.webp'
       and g.visual_landscape_url like 'assets/genres/%-landscape.webp' and coalesce(g.teacher_notes, '') like '提問：%' as ok
  from public.genres g join public.content_sets c on c.id = g.content_set_id
 where c.is_default order by g.sort_order, g.slug;
