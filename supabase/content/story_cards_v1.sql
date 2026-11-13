-- =====================================================================
-- 故事找朋友｜故事卡正式教材 v1（第 03、04 環節：八部作品的名稱、故事介紹、故事元素、圖片）
--
-- 用途：已部署的資料庫把預設素材組的八張佔位故事卡（故事 A～H）換成正式教材。可重複執行（結果相同）。
-- 前置：先執行 supabase/upgrade/upgrade.sql（建立 story_cards.elements 欄位）。
-- 文字來源：source-assets/stories/小卡故事分類小卡_八部作品最新版.docx，由 tools/story_text.py 逐字抽出（不摘要、不改寫）。
--
-- 一對一更新表（依 slug；id、slug、sort_order 都不變）：
--   story-a → 01 神奇柑仔店    story-b → 02 鬼滅之刃    story-c → 03 國家寶藏    story-d → 04 動物方城市
--   story-e → 05 北海小英雄    story-f → 06 寶可夢      story-g → 07 功夫熊貓    story-h → 08 倚天屠龍記
--
-- 安全設計（任何一項不符合就整筆中止、資料庫完全不變）：
--   * 只更新「預設素材組」（content_sets.is_default）中 slug 相符的八筆 story_cards；不新增、不刪除、不改 id 與 sort_order，
--     因此個人分類、小組分類、提交、快照與場次中以 id 記錄的故事都不受影響（也不會被清空）。
--   * 故事卡順序（sort_order, slug）必須正好是 story-a～story-h；不符時中止、不自動修正（編號 01～08 依此順序顯示）。
--   * 若有使用這份素材、2 小時內仍有動作的進行中場次，中止。這只是「預檢」，不是維護鎖：檢查之後才開始的授課操作不會被擋下，
--     所以請在沒有課堂時執行（確認無誤可把下面的 allow_during_class 改成 true）。
--   * 不修改 session_state（projection 等）、快照或任何學生資料；不重新執行佔位 seed，也不碰小說類型教材（genres）。
--
-- 對舊場次與已保存成果的影響：快照與分類只記錄故事 id，名稱與圖片在顯示時才讀取，所以更新後舊場次的成果
-- 也會顯示新的作品名稱與圖片（分類內容不變）。已公開在投影上的 05／07 畫面要等教師重新公開後才會換成新名稱與圖片。
-- 回復：supabase/content/story_cards_v1_rollback.sql（還原成第一次執行本檔之前的內容）。
-- =====================================================================
begin;

-- 更新前的內容備份（只在第一次執行時寫入）。放在 app schema（PostgREST 不公開），並收回所有前端角色的權限。
create table if not exists app.story_card_backups (
  version text not null, content_set_id uuid not null, slug text not null,
  title text, summary text, detail text, image_url text, image_alt text, elements jsonb,
  taken_at timestamptz not null default now(),
  primary key (version, content_set_id, slug));
alter table app.story_card_backups enable row level security;
revoke all on app.story_card_backups from public, anon, authenticated;

do $$
declare
  allow_during_class constant boolean := false;
  v_set uuid; v_order text; v_live int; v_n int;
begin
  select id into v_set from public.content_sets where is_default;
  if v_set is null then raise exception '找不到預設素材組（content_sets.is_default）'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'story_cards' and column_name = 'elements') then
    raise exception '請先執行 supabase/upgrade/upgrade.sql（缺少 story_cards.elements 欄位）';
  end if;
  select string_agg(slug, ',' order by sort_order, slug) into v_order from public.story_cards where content_set_id = v_set;
  if v_order is distinct from 'story-a,story-b,story-c,story-d,story-e,story-f,story-g,story-h' then
    raise exception '故事卡順序不符（預期 story-a～story-h 共 8 張），未做任何修改。目前順序：%', coalesce(v_order, '（沒有故事卡）');
  end if;
  select count(*) into v_live from public.sessions s join public.session_state st on st.session_id = s.id
   where s.content_set_id = v_set and s.status = 'active' and st.updated_at > now() - interval '2 hours';
  if v_live > 0 and not allow_during_class then
    raise exception '有 % 個使用這份素材的場次在 2 小時內仍有動作，可能正在上課。請在沒有課堂時執行（或結束這些場次）。', v_live;
  end if;

  insert into app.story_card_backups (version, content_set_id, slug, title, summary, detail, image_url, image_alt, elements)
  select 'v1', c.content_set_id, c.slug, c.title, c.summary, c.detail, c.image_url, c.image_alt, c.elements
    from public.story_cards c where c.content_set_id = v_set
  on conflict do nothing;

  -- summary 清空：正式教材沒有另寫摘要（看板小卡只顯示編號、圖片與名稱；全文在閱讀卡背面）
  update public.story_cards c set
    title = v.title, summary = '', detail = v.detail, elements = v.elements, image_url = v.image_url, image_alt = v.image_alt
  from (values
    ('story-a', '神奇柑仔店', E'一間不起眼的柑仔店， 一個笑容詭異的老闆娘，店裡有各種你從未見過的神奇零食，吃下去，就能解決所有人生的煩惱：模型美人魚軟糖、猛獸餅乾、發抖幽靈果凍……神奇柑仔店「錢天堂」滿足你所有的願望！', '["神奇零食", "實現願望", "意外結果", "人生選擇"]'::jsonb, 'assets/stories/story-01.webp', '《神奇柑仔店》故事情境圖'),
    ('story-b', '鬼滅之刃', E'日本大正時期，吃人的惡鬼潛藏在人類世界。少年炭治郎的家人慘遭惡鬼殺害，唯一倖存的妹妹禰豆子也變成了鬼。\n為了讓妹妹恢復人類的身分，炭治郎帶著妹妹踏上旅程，加入鬼殺隊，學習能強化戰鬥能力的「呼吸法」，並與夥伴一起對抗擁有特殊「血鬼術」的強大惡鬼。\n在一次次戰鬥中，他逐漸發現，許多惡鬼原本也是人類，背後藏著不為人知的悲傷與過去。', '["大正時代", "惡鬼與血鬼術", "劍術與戰鬥", "夥伴情誼與成長"]'::jsonb, 'assets/stories/story-02.webp', '《鬼滅之刃》故事情境圖'),
    ('story-c', '國家寶藏', E'傳說，美國開國先賢曾將一批價值連城的寶藏藏在某個祕密地點，數百年來始終無人能找到。\n尋寶家班傑明意外發現，通往寶藏的關鍵線索，竟然藏在兩百多年前、美國宣布脫離英國統治的重要歷史文件——《獨立宣言》的背面！\n為了搶在其他尋寶者之前解開謎團，他決定冒險竊取這份受到嚴密保護的珍貴文件，與夥伴一起破解古老密碼、追查歷史留下的蛛絲馬跡，卻也因此陷入一場充滿危機的爭奪戰。', '["歷史文件", "神祕密碼", "隱藏線索", "寶藏爭奪"]'::jsonb, 'assets/stories/story-03.webp', '《國家寶藏》故事情境圖'),
    ('story-d', '動物方城市', E'在一個各種動物共同生活的世界裡，兔子茱蒂從小就夢想成為警察。雖然大家都認為兔子不適合當警察，但她仍然努力實現夢想，成為動物方城市的第一位兔子警官。\n然而，來到警察局後，茱蒂卻只被分配到開交通罰單的工作。為了證明自己的能力，她主動接下一起水獺失蹤案件，並找來曾經見過失蹤水獺的狐狸尼克協助調查。\n兩人透過尋找目擊者、追查車輛與蒐集線索，逐漸發現這起案件與其他動物的失蹤事件有關，而且部分失蹤的動物竟然出現了異常的攻擊行為。為了找出這些事件的真相，茱蒂與尼克展開了一場充滿危險與謎團的調查。', '["動物世界", "失蹤案件", "蒐集線索", "追查真相", "夥伴合作"]'::jsonb, 'assets/stories/story-04.webp', '《動物方城市》故事情境圖'),
    ('story-e', '北海小英雄', E'在北歐的維京村落裡，住著一群經常乘船出海的維京人。小威是維京船長的兒子，雖然身材瘦小，也不擅長打鬥，卻擁有比其他人更靈活的頭腦。\n小威跟隨父親與船員們出海冒險，旅途中經常遭遇敵人的襲擊、海上的危險，甚至被困在陌生的地方。當其他維京人想靠武力解決問題時，小威總能仔細觀察周遭的事物，動動腦筋，利用身邊的物品想出巧妙的辦法，幫助大家度過危機。', '["維京海盜", "航海冒險", "陌生地域", "危機挑戰", "智慧解決問題"]'::jsonb, 'assets/stories/story-05.webp', '《北海小英雄》故事情境圖'),
    ('story-f', '寶可夢', E'在一個人類與寶可夢共同生活的世界裡，少年小智夢想成為寶可夢大師。他帶著自己的第一隻寶可夢皮卡丘，踏上冒險旅程。\n旅途中，小智認識並收服了許多擁有不同能力的寶可夢，與牠們一起訓練、挑戰各地的道館，並以參加寶可夢聯盟為目標。在一次次的冒險與對戰中，小智也逐漸了解寶可夢，學會與夥伴互相信任、並肩作戰。', '["特殊生物", "收服與培育", "夥伴情誼", "道館挑戰", "冒險旅程"]'::jsonb, 'assets/stories/story-06.webp', '《寶可夢》故事情境圖'),
    ('story-g', '功夫熊貓', E'阿波是一隻在家中麵店幫忙的熊貓，從小夢想成為功夫高手，卻從來沒有真正學過功夫。一次意外，他竟然被烏龜大師選為傳說中的神龍大俠。\n面對師父與蓋世五俠的懷疑，以及即將前來搶奪神龍秘笈的強敵太郎，阿波必須克服自己的不足，在師父的引導下，找到屬於自己的功夫之道。', '["功夫修練", "武術高手", "師徒關係", "神龍秘笈", "自我突破"]'::jsonb, 'assets/stories/story-07.webp', '《功夫熊貓》故事情境圖'),
    ('story-h', '倚天屠龍記', E'江湖上流傳著兩件威力強大的兵器——倚天劍與屠龍刀。傳說只要得到屠龍刀，就能號令武林，因此引起各大門派的爭奪。\n少年張無忌的父母因屠龍刀的祕密而遭到武林人士逼迫，最終雙雙身亡。張無忌也因身受重傷，踏上尋求治療的旅程，並在因緣際會下學會了九陽神功與乾坤大挪移等高深武功。\n後來，各大門派聯手圍攻明教，張無忌挺身而出，化解了一場武林危機，並成為明教教主。從此，他必須面對各大門派的恩怨、倚天劍與屠龍刀的祕密，以及江湖中的各種紛爭。', '["江湖門派", "武功祕笈", "神祕兵器", "門派恩怨", "武林爭鬥"]'::jsonb, 'assets/stories/story-08.webp', '《倚天屠龍記》故事情境圖')
  ) as v(slug, title, detail, elements, image_url, image_alt)
  where c.content_set_id = v_set and c.slug = v.slug;
  get diagnostics v_n = row_count;
  if v_n <> 8 then raise exception '預期更新 8 張故事卡，實際 % 張；未做任何修改', v_n; end if;
end $$;

commit;

-- 結果（應為八列，順序 story-a → story-h，ok 都是 true）
select c.slug, c.title, jsonb_array_length(c.elements) between 4 and 5 and c.image_url like 'assets/stories/story-0_.webp'
       and length(c.detail) > 80 and c.summary = '' as ok
  from public.story_cards c join public.content_sets s on s.id = c.content_set_id
 where s.is_default order by c.sort_order, c.slug;
