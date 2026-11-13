-- =====================================================================
-- 故事找朋友｜故事卡正式教材 v1 的回復：把預設素材組的八張 story_cards 還原成
-- 第一次執行 story_cards_v1.sql 之前的內容（備份在 app.story_card_backups）。
-- 與更新相同：只依 slug 更新、不改 id 與排序、順序不符或可能正在上課時中止（預檢，不是維護鎖）；不動任何場次或學生資料。
-- =====================================================================
begin;
do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if to_regclass('app.story_card_backups') is null
     or not exists (select 1 from app.story_card_backups where version = 'v1' and content_set_id = v_set) then
    raise exception '沒有 v1 的備份（尚未執行過 story_cards_v1.sql），未做任何修改';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.story_cards where content_set_id = v_set;
  if v_order is distinct from 'story-a,story-b,story-c,story-d,story-e,story-f,story-g,story-h' then
    raise exception '故事卡順序不符，未做任何修改。目前順序：%', coalesce(v_order, '（沒有故事卡）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行。', v_live;
  end if;
  update public.story_cards c set title = b.title, summary = b.summary, detail = b.detail,
         image_url = b.image_url, image_alt = b.image_alt, elements = coalesce(b.elements, '[]'::jsonb)
    from app.story_card_backups b
   where b.version = 'v1' and b.content_set_id = v_set and b.slug = c.slug and c.content_set_id = v_set;
  get diagnostics v_n = row_count;
  if v_n <> 8 then raise exception '預期還原 8 張故事卡，實際 % 張；未做任何修改', v_n; end if;
end $$;
commit;

select c.slug, c.title from public.story_cards c join public.content_sets s on s.id = c.content_set_id
 where s.is_default order by c.sort_order, c.slug;
