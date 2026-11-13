-- =====================================================================
-- 故事找朋友｜Phase 4 → Phase 3 回復（只在需要退回 Phase 3 網站時使用）
--
-- 執行順序：
--   1. 執行 Phase 3 版本（main 89299af）的 supabase/migrations/002_rpc.sql
--   2. 執行 Phase 3 版本的 supabase/migrations/003_security.sql
--   3. 執行本檔
--   （git show 89299af:supabase/migrations/002_rpc.sql）
--
-- 不刪除任何資料。Phase 4 新增的欄位 session_state.stage_ctl、session_state.disclosure 保留不動（Phase 3 不使用）。
-- 回到 Phase 3 後，05／07 的投影若停在成果畫面，教師切換環節即會換成 Phase 3 的佔位畫面。
-- =====================================================================
drop function if exists public.teacher_preview_compare(uuid, jsonb);
drop function if exists public.teacher_preview_match(uuid, jsonb);
drop function if exists public.teacher_publish_compare(uuid, jsonb, bigint);
drop function if exists public.teacher_publish_match(uuid, jsonb, bigint);
drop function if exists app.compare_build(uuid, jsonb);
drop function if exists app.match_build(uuid, jsonb);
drop function if exists app.disclose_genres(uuid, jsonb, jsonb);
drop function if exists app.genre_build(uuid, jsonb, jsonb);
drop function if exists app.genre_visual(text, text, text);
drop function if exists app.disc_from_legacy(uuid, jsonb, jsonb);
drop function if exists app.disc_add(uuid, jsonb, int, jsonb);
drop function if exists app.genre_at(uuid, int);
drop function if exists app.disc_map(jsonb);
drop function if exists app.snapshot_for(uuid, uuid);
drop function if exists app.snapshot_norm(jsonb, uuid);
drop function if exists app.card_pub(uuid, jsonb, text);
drop function if exists app.cat_label(jsonb);
drop function if exists app.ids_subset(jsonb, jsonb);
drop function if exists app.uuid_or_null(jsonb);
drop function if exists app.teacher_session_ro(uuid);
