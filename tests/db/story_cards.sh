#!/usr/bin/env bash
# 故事卡正式教材 v1（supabase/content/story_cards_v1.sql）的資料庫測試（只在本機隔離的測試資料庫執行）
#   * 可能正在上課（2 小時內有動作的進行中場次）→ 中止、完全不變
#   * 故事卡順序不符 → 中止、完全不變
#   * 成功：八張依 slug 一對一更新；名稱、全文（段落）、元素與 Word 原稿逐字相同（tools/story_text.py 直接讀 docx 比對）；
#     id、slug、sort_order 不變；個人分類、小組分類、場次狀態、已公開投影都不變；小說類型教材不受影響；圖片檔都存在
#   * 可重複執行；備份只在第一次寫入；回復腳本還原（逐欄位相同）、再套用與第一次相同
#   * 學生讀取（student_cards）含 elements；舊資料（elements 為空陣列、沒有圖片）照常讀取；elements 必須是陣列
#   * 權限：備份表 anon／教師都讀不到；anon 不能直接讀 story_cards（只能透過 03 起開放的 student_cards）
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_cards}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
fail() { echo "FAIL: $*"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 755 "$TMP"
cp "$ROOT/supabase/content/story_cards_v1.sql" "$ROOT/supabase/content/story_cards_v1_rollback.sql" "$ROOT/supabase/content/genre_materials_v1.sql" "$TMP/"; chmod 644 "$TMP"/*.sql
CONTENT="$TMP/story_cards_v1.sql"; ROLLBACK="$TMP/story_cards_v1_rollback.sql"
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
psql_ -d "$DB" -f "$TMP/genre_materials_v1.sql" >/dev/null 2>&1 || fail "前置：小說類型教材"
T1=11111111-1111-1111-1111-111111111111; TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"
tq() { psql_ -d "$DB" -c "$TEACH" -c "$1" | tail -1; }
aq() { psql_ -d "$DB" -c "set role anon" -c "$1" | tail -1; }
q "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(tq "select public.teacher_create_session('故事卡', 2)->>'session_id'")
PK=$(q "select projector_key from public.sessions where id = '$SID'")
CODE=$(q "select join_code from public.sessions where id = '$SID'")
aq "select public.student_join('$CODE', '$TA', 1)" >/dev/null
aq "select public.student_join('$CODE', '$TB', 1)" >/dev/null
REV() { q "select rev from public.session_state where session_id = '$SID'"; }
stage() { tq "select public.teacher_set_stage('$SID', '$1', '$2', '$3', $(REV), true)->>'ok'"; }
CARD() { q "select id from public.story_cards where slug = '$1'"; }
CA=$(CARD story-a); CD=$(CARD story-d)
# 個人分類（03）與小組分類（04）中有故事
[ "$(stage 03 03 '{"screen":"instruction"}')" = "true" ] || fail "前置：進入 03"
K1=$(q "select gen_random_uuid()")
[ "$(aq "select public.student_save_personal('$SID', '$TA', '{\"categories\":[{\"id\":\"$K1\",\"name\":\"勇敢\"}],\"placements\":{\"$CA\":\"$K1\",\"$CD\":\"$K1\"}}', 0)->>'ok'")" = "true" ] || fail "前置：個人分類"
[ "$(stage 04 04 '{"screen":"instruction"}')" = "true" ] || fail "前置：進入 04"
GC=$(aq "select public.group_add_category('$SID', '$TA')->>'category_id'")
[ "$(aq "select public.group_move_card('$SID', '$TA', '$CA', '$GC', 0)->>'rev'")" = "1" ] || fail "前置：小組移動故事"
proj() { q "set role anon; select public.projector_state('$SID', '$PK')::text" | tail -1; }
CARDS() { q "select md5(string_agg(id || slug || sort_order || title || summary || detail || coalesce(image_url,'') || coalesce(image_alt,'') || elements::text, '|' order by slug)) from public.story_cards"; }
IDS() { q "select md5(string_agg(id || ':' || slug || ':' || sort_order || ':' || content_set_id, '|' order by slug)) from public.story_cards"; }
WORK() { q "select md5(coalesce((select string_agg(data::text || rev, '|' order by participant_id) from public.personal_boards), '')
                    || coalesce((select string_agg(card_id || ':' || category_id, '|' order by card_id) from public.group_placements), '')
                    || coalesce((select string_agg(id || ':' || coalesce(name, '') || label_no, '|' order by id) from public.group_categories), '')
                    || coalesce((select string_agg(t::text, '|' order by t::text) from public.group_snapshots t), '')
                    || coalesce((select string_agg(t::text, '|' order by t::text) from public.personal_snapshots t), ''))"; }
STATE() { q "select md5(projection::text || disclosure::text || stage_ctl::text || phase || rev) from public.session_state where session_id = '$SID'"; }
GENRES() { q "select md5(string_agg(id || slug || name || elements::text || coalesce(visual_url,''), '|' order by slug)) from public.genres"; }
C0=$(CARDS); I0=$(IDS); W0=$(WORK); S0=$(STATE); P0=$(proj); G0=$(GENRES)
[ "$(q "select count(*) from public.group_placements")" = "1" ] || fail "前置：小組分類沒有資料"

# 1. 可能正在上課 → 中止
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '可能正在上課' || fail "進行中的場次沒有讓腳本中止：$OUT"
[ "$(CARDS)" = "$C0" ] && [ "$(STATE)" = "$S0" ] || fail "中止後資料被改動"
echo "ok - 故事卡教材：有 2 小時內有動作的進行中場次時中止，資料完全不變"

# 2. 順序不符 → 中止
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
S0=$(STATE)
q "update public.story_cards set sort_order = 9 where slug = 'story-a'" >/dev/null
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '故事卡順序不符' || fail "順序不符沒有中止：$OUT"
q "update public.story_cards set sort_order = 1 where slug = 'story-a'" >/dev/null
[ "$(CARDS)" = "$C0" ] || fail "順序不符中止後資料被改動"
echo "ok - 故事卡教材：順序不符時中止（不自動修正），資料完全不變"

# 3. 成功：與 Word 原稿逐字相同
psql_ -d "$DB" -f "$CONTENT" > "$TMP/out" 2>&1 || { cat "$TMP/out"; fail "教材腳本失敗"; }
[ "$(grep -c '|t$' "$TMP/out")" = "8" ] || { cat "$TMP/out"; fail "結果檢查不是 8 列 true"; }
python3 -I - "$ROOT/tools" "$TMP/expect.tsv" <<'PY'
import sys, json
sys.path.insert(0, sys.argv[1]); import story_text
rows = story_text.extract()
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    for slug, c in zip(story_text.SLUGS, rows):
        f.write('\t'.join([slug, c['title'], '\n'.join(c['paragraphs']).replace('\n', '\\n'), json.dumps(c['elements'], ensure_ascii=False),
                           f"assets/stories/story-{c['no']}.webp"]) + '\n')
PY
q "select slug || E'\t' || title || E'\t' || replace(detail, E'\n', '\n') || E'\t' || elements::text || E'\t' || image_url from public.story_cards order by sort_order, slug" > "$TMP/actual.tsv"
diff "$TMP/expect.tsv" "$TMP/actual.tsv" > "$TMP/diff" || { cat "$TMP/diff"; fail "資料庫內容與 Word 原稿不同"; }
[ "$(q "select string_agg(title, ',' order by sort_order, slug) from public.story_cards")" = "神奇柑仔店,鬼滅之刃,國家寶藏,動物方城市,北海小英雄,寶可夢,功夫熊貓,倚天屠龍記" ] || fail "名稱或順序不對"
[ "$(q "select count(*) from public.story_cards where title like '%動物方程市%' or detail like '%動物方程市%'")" = "0" ] || fail "出現「動物方程市」"
[ "$(q "select array_length(string_to_array(detail, E'\n'), 1) from public.story_cards where slug = 'story-e'")" = "2" ] || fail "05 北海小英雄應為兩段"
[ "$(q "select count(*) from public.story_cards where summary <> ''")" = "0" ] || fail "summary 應清空（不另寫摘要）"
[ "$(IDS)" = "$I0" ] || fail "id、slug 或 sort_order 改變"
[ "$(WORK)" = "$W0" ] || fail "個人／小組分類或快照被改動"
[ "$(STATE)" = "$S0" ] || fail "場次狀態被改寫"
[ "$(proj)" = "$P0" ] || fail "已公開的投影被改寫"
[ "$(GENRES)" = "$G0" ] || fail "小說類型教材被改動"
for n in 01 02 03 04 05 06 07 08; do for k in "" -600w; do [ -f "$ROOT/assets/stories/story-$n$k.webp" ] || fail "缺少圖片 story-$n$k.webp"; done; done
echo "ok - 故事卡教材：八張依 slug 一對一更新，名稱、全文段落、故事元素、圖片路徑與 Word 原稿逐字相同；id、排序、分類、場次、投影與小說類型教材都不變；圖片檔都存在"
C1=$(CARDS)
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "重複執行失敗"
[ "$(CARDS)" = "$C1" ] || fail "重複執行結果不同"
[ "$(q "select title from app.story_card_backups where version = 'v1' and slug = 'story-d'")" = "故事 D" ] || fail "備份被第二次執行覆蓋"
echo "ok - 故事卡教材可重複執行；備份只在第一次寫入"

# 4. 學生讀取：含 elements；06 之前 03 才開放
R=$(aq "select public.student_cards('$SID', '$TA')::text")
echo "$R" | grep -q '"elements": \["動物世界", "失蹤案件", "蒐集線索", "追查真相", "夥伴合作"\]' || fail "student_cards 沒有元素：$R"
echo "$R" | grep -q '"image_url": "assets/stories/story-04.webp"' || fail "student_cards 圖片路徑不對"
[ "$(aq "select jsonb_array_length(public.student_cards('$SID', '$TA'))")" = "8" ] || fail "student_cards 不是 8 張"
[ "$(aq "select public.student_cards('$SID', '$TA') -> 0 ->> 'title'")" = "神奇柑仔店" ] || fail "student_cards 順序不對"
echo "ok - 學生讀取（student_cards）含故事元素與正式圖片路徑，依 01～08 順序"

# 5. 舊資料相容與欄位型別
q "update public.story_cards set elements = '[]', image_url = null where slug = 'story-h'" >/dev/null
[ "$(aq "select public.student_cards('$SID', '$TA') -> 7 ->> 'elements'")" = "[]" ] || fail "空元素讀取"
OUT=$(q "update public.story_cards set elements = '\"不是陣列\"' where slug = 'story-h'" 2>&1 || true)
echo "$OUT" | grep -qi "story_cards_elements_array" || fail "elements 不是陣列時應被拒絕：$OUT"
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "還原 story-h"
echo "ok - 舊資料相容：沒有元素（空陣列）與沒有圖片時照常讀取；elements 必須是陣列"

# 6. 權限
for role in anon authenticated; do
  OUT=$(psql_ -d "$DB" -c "set role $role" -c "select count(*) from app.story_card_backups" 2>&1 || true)
  echo "$OUT" | grep -qi "permission denied" || fail "$role 可以讀備份表：$OUT"
done
OUT=$(psql_ -d "$DB" -c "set role anon" -c "select elements from public.story_cards" 2>&1 || true)
echo "$OUT" | grep -qi "permission denied" || fail "anon 可以直接讀 story_cards：$OUT"
[ "$(tq "select elements ->> 0 from public.story_cards where slug = 'story-a'")" = "神奇零食" ] || fail "教師讀不到元素"
echo "ok - 權限：備份表 anon／教師都讀不到；anon 不能直接讀 story_cards；教師可讀元素"

# 7. 回復與再套用
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
psql_ -d "$DB" -f "$ROLLBACK" >/dev/null 2>&1 || fail "回復腳本失敗"
[ "$(CARDS)" = "$C0" ] || fail "回復後與更新前不同"
[ "$(IDS)" = "$I0" ] && [ "$(WORK)" = "$W0" ] || fail "回復改變了 id、排序或分類"
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "再套用失敗"
[ "$(CARDS)" = "$C1" ] || fail "再套用後與第一次套用不同"
echo "ok - 回復腳本還原到更新前（逐欄位相同）、再套用後與第一次相同"
