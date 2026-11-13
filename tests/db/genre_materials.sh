#!/usr/bin/env bash
# 小說類型教材 v1（supabase/content/genre_materials_v1.sql）與 06／07 圖片來源規則的資料庫測試
#   * 可能正在上課（2 小時內有動作的進行中場次）→ 中止、完全不變
#   * 類型順序不符 → 中止、完全不變
#   * 成功：五筆依 slug 更新；id、sort_order、場次的 projection／disclosure／stage_ctl、快照都不變；可重複執行；有備份
#   * 06 用直式、07 用橫式（預覽＝公開）；舊資料缺橫式圖時回退直式；都沒有圖時為 null
#   * 教師補充（teacher_notes、genre_teacher_guide）與未揭露的特色不在投影 API；備份表前端角色讀不到
#   * 回復腳本還原、再套用
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_genre}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
fail() { echo "FAIL: $*"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 755 "$TMP"
cp "$ROOT/supabase/content/genre_materials_v1.sql" "$ROOT/supabase/content/genre_materials_v1_rollback.sql" "$TMP/"; chmod 644 "$TMP"/*.sql
CONTENT="$TMP/genre_materials_v1.sql"; ROLLBACK="$TMP/genre_materials_v1_rollback.sql"
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
T1=11111111-1111-1111-1111-111111111111; TA=$(printf 'a%.0s' {1..40})
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"
tq() { psql_ -d "$DB" -c "$TEACH" -c "$1" | tail -1; }
q "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(tq "select public.teacher_create_session('教材', 2)->>'session_id'")
PK=$(q "select projector_key from public.sessions where id = '$SID'")
CODE=$(q "select join_code from public.sessions where id = '$SID'")
q "set role anon; select public.student_join('$CODE', '$TA', 1)" >/dev/null
REV() { q "select rev from public.session_state where session_id = '$SID'"; }
stage() { tq "select public.teacher_set_stage('$SID', '$1', '$2', '$3', $(REV), true)->>'ok'"; }
proj() { q "set role anon; select public.projector_state('$SID', '$PK')::text" | tail -1; }
[ "$(stage 06 06-02 '{"screen":"genre","view":"genre","ctl":{"view":"genre","index":1,"reveal":true}}')" = "true" ] || fail "前置：06 揭開第 1 類"
GENRES() { q "select md5(string_agg(id || slug || sort_order || name || elements::text || coalesce(teacher_notes,'') || coalesce(visual_url,'') || coalesce(visual_landscape_url,''), '|' order by slug)) from public.genres"; }
IDS() { q "select md5(string_agg(id || ':' || slug || ':' || sort_order, '|' order by slug)) from public.genres"; }
STATE() { q "select md5(projection::text || disclosure::text || stage_ctl::text || phase || rev) from public.session_state where session_id = '$SID'"; }
G0=$(GENRES); I0=$(IDS); S0=$(STATE); P0=$(proj)
echo "$P0" | grep -q '偵探小說' || fail "前置：投影是舊文字"

# 1. 可能正在上課 → 中止
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '可能正在上課' || fail "進行中的場次沒有讓腳本中止：$OUT"
[ "$(GENRES)" = "$G0" ] && [ "$(STATE)" = "$S0" ] || fail "中止後資料被改動"
echo "ok - 教材腳本：有 2 小時內有動作的進行中場次時中止，資料完全不變"

# 2. 順序不符 → 中止
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
S0=$(STATE)
q "update public.genres set sort_order = 9 where slug = 'fantasy'" >/dev/null
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '類型順序不符' || fail "順序不符沒有中止：$OUT"
q "update public.genres set sort_order = 1 where slug = 'fantasy'" >/dev/null
[ "$(GENRES)" = "$G0" ] || fail "順序不符中止後資料被改動"
echo "ok - 教材腳本：類型順序不符時中止（避免揭露紀錄錯置），資料完全不變"

# 3. 成功
psql_ -d "$DB" -f "$CONTENT" > "$TMP/out" 2>&1 || { cat "$TMP/out"; fail "教材腳本失敗"; }
[ "$(grep -c '|t$' "$TMP/out")" = "5" ] || { cat "$TMP/out"; fail "結果檢查不是 5 列 true"; }
[ "$(q "select string_agg(name, ',' order by sort_order, slug) from public.genres")" = "奇幻,偵探,歷史,冒險,武俠" ] || fail "名稱或順序不對"
[ "$(q "select elements::text from public.genres where slug = 'detective'")" = '[{"label": "離奇事件與謎團"}, {"label": "敏銳觀察與分析"}, {"label": "透過推理解開謎題"}]' ] || fail "偵探的常見特色不對"
[ "$(q "select visual_url || ' ' || visual_landscape_url from public.genres where slug = 'detective'")" = "assets/genres/detective-portrait.webp assets/genres/detective-landscape.webp" ] || fail "推理→偵探 的圖片對應不對"
[ "$(IDS)" = "$I0" ] || fail "id 或 sort_order 改變"
[ "$(STATE)" = "$S0" ] || fail "場次的 projection／disclosure／stage_ctl 被改寫"
[ "$(proj)" = "$P0" ] || fail "已公開的投影被改寫（應等教師重新公開）"
for f in fantasy detective historical adventure wuxia; do
  for k in portrait landscape portrait-600w landscape-960w; do [ -f "$ROOT/assets/genres/$f-$k.webp" ] || fail "缺少圖片 assets/genres/$f-$k.webp"; done
done
echo "ok - 教材腳本：五類名稱「奇幻、偵探、歷史、冒險、武俠」、常見特色、圖片依 slug 更新；id、排序、場次狀態與已公開投影都不變；圖片檔都存在"
G1=$(GENRES)
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "重複執行失敗"
[ "$(GENRES)" = "$G1" ] || fail "重複執行結果不同"
[ "$(q "select name from app.genre_material_backups where version = 'v1' and slug = 'detective'")" = "偵探小說" ] || fail "備份被第二次執行覆蓋"
echo "ok - 教材腳本可重複執行；備份只在第一次寫入"

# 4. 06 直式、07 橫式（重新公開後）；預覽＝公開；不含教師補充與未揭露特色
[ "$(stage 06 06-02 '{"screen":"genre","view":"genre","ctl":{"view":"genre","index":1,"reveal":true}}')" = "true" ] || fail "重新公開 06"
P6=$(proj)
echo "$P6" | grep -q '"visual_url": "assets/genres/detective-portrait.webp"' && echo "$P6" | grep -q '"visual_source": "portrait"' || fail "06 沒有用直式主圖：$P6"
echo "$P6" | grep -q '透過推理解開謎題' || fail "06 揭開後沒有三項常見特色"
for w in 提問 補充 剛才我們閱讀故事 常見特色，不是每個故事 圖片只提供觀察線索; do echo "$P6" | grep -q "$w" && fail "06 投影含教師補充（$w）"; done
[ "$(stage 07 07 '{"screen":"placeholder","title":"小小故事分類師"}')" = "true" ] || fail "進入 07"
PRE=$(tq "select (public.teacher_preview_match('$SID', '{\"genre\":3,\"elements\":[0]}') -> 'projection')::text")
[ "$(tq "select (public.teacher_publish_match('$SID', '{\"genre\":3,\"elements\":[0]}', $(REV))->>'ok')")" = "true" ] || fail "公開 07"
P7=$(proj)
echo "$P7" | grep -q '"visual_url": "assets/genres/adventure-landscape.webp"' && echo "$P7" | grep -q '"visual_source": "landscape"' || fail "07 沒有用橫式圖：$P7"
[ "$(q "select (projection)::text from public.session_state where session_id = '$SID'")" = "$PRE" ] || fail "07 預覽與公開不同"
echo "$P7" | grep -q '不尋常的冒險經歷' || fail "07 已揭露的特色不在"
for w in 遭遇危險與困難 運用智慧克服困難 提問 野營; do echo "$P7" | grep -q "$w" && fail "07 投影含未揭露特色或教師補充（$w）"; done
echo "ok - 06 使用直式主圖、07 使用橫式圖（預覽＝公開）；投影 API 不含教師補充與未揭露的特色"

# 5. 舊資料相容：缺橫式圖 → 07 回退直式；都沒有 → null（畫面顯示替代框）
q "update public.genres set visual_landscape_url = null where slug = 'adventure'" >/dev/null
[ "$(tq "select (public.teacher_preview_match('$SID', '{\"genre\":3}') #>> '{projection,genre,visual_url}')")" = "assets/genres/adventure-portrait.webp" ] || fail "缺橫式圖時沒有回退直式"
[ "$(tq "select (public.teacher_preview_match('$SID', '{\"genre\":3}') #>> '{projection,genre,visual_source}')")" = "portrait" ] || fail "回退時 visual_source 應為 portrait"
q "update public.genres set visual_url = null where slug = 'adventure'" >/dev/null
[ "$(tq "select coalesce(public.teacher_preview_match('$SID', '{\"genre\":3}') #>> '{projection,genre,visual_url}', 'NULL')")" = "NULL" ] || fail "都沒有圖時應為 null"
q "update public.genres set visual_url = null, visual_landscape_url = 'assets/genres/adventure-landscape.webp' where slug = 'adventure'" >/dev/null
[ "$(stage 06 06-02 '{"screen":"genre","view":"genre","ctl":{"view":"genre","index":3,"reveal":true}}')" = "true" ] || fail "06 揭開冒險"
echo "$(proj)" | grep -q '"visual_source": "landscape"' || fail "06 缺直式圖時沒有回退橫式"
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "還原圖片欄位"
echo "ok - 舊資料相容：07 缺橫式圖時回退直式、06 缺直式圖時回退橫式、都沒有時為 null"

# 6. 權限：備份表與教師共同補充
for role in anon authenticated; do
  OUT=$(psql_ -d "$DB" -c "set role $role" -c "select count(*) from app.genre_material_backups" 2>&1 || true)
  echo "$OUT" | grep -qi "permission denied" || fail "$role 可以讀備份表：$OUT"
done
OUT=$(psql_ -d "$DB" -c "set role anon" -c "select genre_teacher_guide from public.content_sets" 2>&1 || true)
echo "$OUT" | grep -qi "permission denied" || fail "anon 可以讀教師共同補充：$OUT"
[ "$(tq "select genre_teacher_guide ->> 'image_note' from public.content_sets where is_default")" = "圖片只提供觀察線索，不能僅憑一張圖判定全部特色。" ] || fail "教師讀不到共同補充"
echo "ok - 權限：備份表 anon／教師都讀不到；教師共同補充只有教師可讀"

# 7. 回復與再套用
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
psql_ -d "$DB" -f "$ROLLBACK" >/dev/null 2>&1 || fail "回復腳本失敗"
[ "$(q "select string_agg(name, ',' order by sort_order, slug) from public.genres")" = "奇幻小說,偵探小說,歷史小說,冒險小說,武俠小說" ] || fail "回復後名稱不對"
[ "$(GENRES)" = "$G0" ] || fail "回復後與更新前不同"
[ "$(IDS)" = "$I0" ] || fail "回復改變了 id 或排序"
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "再套用失敗"
[ "$(GENRES)" = "$G1" ] || fail "再套用後與第一次套用不同"
echo "ok - 回復腳本還原到更新前（逐欄位相同）、再套用後與第一次相同"
