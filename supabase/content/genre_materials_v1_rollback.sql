-- =====================================================================
-- 故事找朋友｜小說類型教材 v1 的回復：把預設素材組的五筆 genres 與教師共同補充
-- 還原成第一次執行 genre_materials_v1.sql 之前的內容（備份在 app.genre_material_backups）。
-- 與更新相同：只依 slug 更新、不改 id 與排序、順序不符或可能正在上課時中止；不動任何場次或學生資料。
-- =====================================================================
begin;
do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if to_regclass('app.genre_material_backups') is null
     or not exists (select 1 from app.genre_material_backups where version = 'v1' and content_set_id = v_set) then
    raise exception '沒有 v1 的備份（尚未執行過 genre_materials_v1.sql），未做任何修改';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.genres where content_set_id = v_set;
  if v_order is distinct from 'fantasy,detective,historical,adventure,wuxia' then
    raise exception '類型順序不符，未做任何修改。目前順序：%', coalesce(v_order, '（沒有類型）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行。', v_live;
  end if;
  update public.genres g set name = b.name, elements = b.elements, teacher_notes = b.teacher_notes,
         visual_url = b.visual_url, visual_landscape_url = b.visual_landscape_url
    from app.genre_material_backups b
   where b.version = 'v1' and b.content_set_id = v_set and b.slug = g.slug and g.content_set_id = v_set;
  get diagnostics v_n = row_count;
  if v_n <> 5 then raise exception '預期還原 5 筆類型，實際 % 筆；未做任何修改', v_n; end if;
  update public.content_sets c set genre_teacher_guide = b.genre_teacher_guide
    from app.genre_material_backups b where b.version = 'v1' and b.content_set_id = v_set and b.slug = '*' and c.id = v_set;
end $$;
commit;

select g.slug, g.name from public.genres g join public.content_sets c on c.id = g.content_set_id
 where c.is_default order by g.sort_order, g.slug;
