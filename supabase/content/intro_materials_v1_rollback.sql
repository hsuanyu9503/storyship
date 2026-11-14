-- =====================================================================
-- 故事找朋友｜第 01 環節正式教材 v1 的回復：把預設素材組的兩則探索故事、六條線索與 intro_text
-- 還原成第一次執行 intro_materials_v1.sql 之前的內容（備份在 app.intro_material_backups）。
-- 與更新相同：順序或線索不符、或可能正在上課時中止（預檢，不是維護鎖）；不動任何場次或學生資料。
-- =====================================================================
begin;
do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if to_regclass('app.intro_material_backups') is null
     or not exists (select 1 from app.intro_material_backups where version = 'v1' and content_set_id = v_set) then
    raise exception '沒有 v1 的備份（尚未執行過 intro_materials_v1.sql），未做任何修改';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.intro_stories where content_set_id = v_set;
  if v_order is distinct from 'intro-1,intro-2' then
    raise exception '探索故事順序不符，未做任何修改。目前順序：%', coalesce(v_order, '（沒有探索故事）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行。', v_live;
  end if;
  update public.intro_stories i set title = b.title, reveal_text = b.reveal_text, image_url = b.image_url, background_url = b.background_url,
         name_before = b.name_before, name_after = b.name_after, image_alt = b.image_alt
    from app.intro_material_backups b
   where b.version = 'v1' and b.content_set_id = v_set and b.slug = i.slug and b.clue_order = 0 and i.content_set_id = v_set;
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception '預期還原 2 則探索故事，實際 % 則；未做任何修改', v_n; end if;
  update public.intro_clues c set kind = b.kind, label = b.label, body = b.body, image_url = b.clue_image_url
    from app.intro_material_backups b, public.intro_stories i
   where b.version = 'v1' and b.content_set_id = v_set and b.slug = i.slug and b.clue_order = c.sort_order and b.clue_order > 0
     and c.story_id = i.id and i.content_set_id = v_set;
  get diagnostics v_n = row_count;
  if v_n <> 6 then raise exception '預期還原 6 條線索，實際 % 條；未做任何修改', v_n; end if;
  update public.content_sets c set intro_text = b.intro_text
    from app.intro_material_backups b where b.version = 'v1' and b.content_set_id = v_set and b.slug = '*' and c.id = v_set;
end $$;
commit;

select i.slug, i.title from public.intro_stories i join public.content_sets s on s.id = i.content_set_id
 where s.is_default order by i.sort_order, i.slug;
