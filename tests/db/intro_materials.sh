#!/usr/bin/env bash
# 第 01 環節正式教材 v1（supabase/content/intro_materials_v1.sql）的資料庫測試（只在本機隔離的測試資料庫執行）
#   * 可能正在上課 → 中止、完全不變；探索故事順序或線索數不符 → 中止、完全不變
#   * 成功：兩則依 slug、六條依 sort_order 更新；文字與 Word 原稿逐字相同（tools/intro_text.py 直接讀 docx 比對）；
#     id、slug、sort_order 不變；場次狀態、已公開投影、故事卡與小說類型教材都不變；圖片檔存在
#   * 可重複執行；備份只在第一次寫入；回復腳本還原（逐欄位相同）、再套用與第一次相同
#   * 權限：備份表 anon／教師都讀不到；anon 不能直接讀 intro_stories／intro_clues／content_sets（答案只由教師端在公布後放進投影）
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_intro}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
fail() { echo "FAIL: $*"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 755 "$TMP"
cp "$ROOT/supabase/content/intro_materials_v1.sql" "$ROOT/supabase/content/intro_materials_v1_rollback.sql" "$ROOT/supabase/content/genre_materials_v1.sql" "$ROOT/supabase/content/story_cards_v1.sql" "$TMP/"; chmod 644 "$TMP"/*.sql
CONTENT="$TMP/intro_materials_v1.sql"; ROLLBACK="$TMP/intro_materials_v1_rollback.sql"
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do psql_ -d "$DB" -f "$f" >/dev/null 2>&1; done
psql_ -d "$DB" -f "$TMP/genre_materials_v1.sql" >/dev/null 2>&1 || fail "前置：小說類型教材"
psql_ -d "$DB" -f "$TMP/story_cards_v1.sql" >/dev/null 2>&1 || fail "前置：故事卡教材"
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
[ "$(stage 01 01-02 '{"screen":"intro","view":"story","story":{"index":0,"total":2,"neutral":"神祕故事一","clue_total":3,"clues":[]}}')" = "true" ] || fail "前置：01 投影"
proj() { q "set role anon; select public.projector_state('$SID', '$PK')::text" | tail -1; }
INTRO() { q "select md5(string_agg(i.id || i.slug || i.sort_order || i.title || i.reveal_text || coalesce(i.image_url,'') || coalesce(i.name_before,'') || coalesce(i.name_after,'') || coalesce(i.image_alt,'')
  || coalesce((select string_agg(c.id::text || c.sort_order || c.kind || c.label || c.body || coalesce(c.image_url,''), ',' order by c.sort_order) from public.intro_clues c where c.story_id = i.id), ''), '|' order by i.slug)
  || coalesce((select intro_text::text from public.content_sets where is_default), '')) from public.intro_stories i"; }
IDS() { q "select md5(string_agg(i.id || ':' || i.slug || ':' || i.sort_order || (select string_agg(c.id::text || ':' || c.sort_order, ',' order by c.sort_order) from public.intro_clues c where c.story_id = i.id), '|' order by i.slug)) from public.intro_stories i"; }
STATE() { q "select md5(projection::text || phase || sub || rev) from public.session_state where session_id = '$SID'"; }
OTHER() { q "select md5((select string_agg(id || title || detail || elements::text, '|' order by slug) from public.story_cards) || (select string_agg(id || name || elements::text, '|' order by slug) from public.genres))"; }
C0=$(INTRO); I0=$(IDS); S0=$(STATE); P0=$(proj); O0=$(OTHER)

# 1. 可能正在上課 → 中止
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '可能正在上課' || fail "進行中的場次沒有讓腳本中止：$OUT"
[ "$(INTRO)" = "$C0" ] && [ "$(STATE)" = "$S0" ] || fail "中止後資料被改動"
echo "ok - 01 教材：有 2 小時內有動作的進行中場次時中止，資料完全不變"

# 2. 順序或線索不符 → 中止
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
S0=$(STATE)
q "update public.intro_stories set sort_order = 9 where slug = 'intro-1'" >/dev/null
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '探索故事順序不符' || fail "順序不符沒有中止：$OUT"
q "update public.intro_stories set sort_order = 1 where slug = 'intro-1'" >/dev/null
q "update public.intro_clues set sort_order = 4 where sort_order = 3 and story_id = (select id from public.intro_stories where slug = 'intro-2')" >/dev/null
OUT=$(psql_ -d "$DB" -f "$CONTENT" 2>&1 || true)
echo "$OUT" | grep -q '線索不符' || fail "線索不符沒有中止：$OUT"
q "update public.intro_clues set sort_order = 3 where sort_order = 4" >/dev/null
[ "$(INTRO)" = "$C0" ] || fail "中止後資料被改動"
echo "ok - 01 教材：探索故事順序或線索數不符時中止（不自動修正），資料完全不變"

# 3. 成功：與 Word 原稿逐字相同
psql_ -d "$DB" -f "$CONTENT" > "$TMP/out" 2>&1 || { cat "$TMP/out"; fail "教材腳本失敗"; }
[ "$(grep -c '|t$' "$TMP/out")" = "2" ] || { cat "$TMP/out"; fail "結果檢查不是 2 列 true"; }
python3 -I - "$ROOT/tools" "$TMP/expect.txt" <<'PY'
import sys, json
sys.path.insert(0, sys.argv[1]); import intro_text
d = intro_text.extract()
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    for i, s in enumerate(d['stories']):
        f.write('\t'.join([f'intro-{i+1}', s['title'], s['reveal_text'], s['name_before'], s['name_after']]) + '\n')
        for k, c in enumerate(s['clues']): f.write('\t'.join([f'intro-{i+1}', str(k + 1), 'other', c['label'], c['body']]) + '\n')
    f.write(json.dumps({'opening': d['opening'], 'compare_title': d['compare_title'], 'compare_prompts': d['compare_prompts'], 'naming_prompt': d['naming_prompt'],
                        'bridge_title': d['bridge_title'], 'bridge_text': d['bridge_text']}, ensure_ascii=False, sort_keys=True) + '\n')
PY
{ q "select i.slug || E'\t' || i.title || E'\t' || i.reveal_text || E'\t' || i.name_before || E'\t' || i.name_after || chr(10) ||
      (select string_agg(i.slug || E'\t' || c.sort_order || E'\t' || c.kind || E'\t' || c.label || E'\t' || c.body, chr(10) order by c.sort_order) from public.intro_clues c where c.story_id = i.id)
     from public.intro_stories i order by i.sort_order";
  python3 -I -c "import json,sys; print(json.dumps(json.loads(sys.stdin.read()), ensure_ascii=False, sort_keys=True))" <<< "$(q "select intro_text::text from public.content_sets where is_default")"; } > "$TMP/actual.txt"
diff "$TMP/expect.txt" "$TMP/actual.txt" > "$TMP/diff" || { cat "$TMP/diff"; fail "資料庫內容與 Word 原稿不同"; }
[ "$(q "select string_agg(image_url || ' ' || image_alt, '|' order by sort_order) from public.intro_stories")" = "assets/intro/conan-1600.webp 《名偵探柯南》揭曉圖：工藤新一與江戶川柯南並肩思考|assets/intro/chihiro-1600.webp 《神隱少女》揭曉圖：千尋在湯婆婆面前簽下契約" ] || fail "圖片或替代文字配對不對"
[ "$(IDS)" = "$I0" ] || fail "id、slug 或 sort_order 改變"
[ "$(STATE)" = "$S0" ] || fail "場次狀態被改寫"
[ "$(proj)" = "$P0" ] || fail "已公開的投影被改寫"
[ "$(OTHER)" = "$O0" ] || fail "故事卡或小說類型教材被改動"
for f in conan-1600 conan-960 chihiro-1600 chihiro-960; do [ -f "$ROOT/assets/intro/$f.webp" ] || fail "缺少圖片 $f.webp"; done
echo "ok - 01 教材：兩則故事、六條線索、名字變化、揭曉說明與單元文案與 Word 原稿逐字相同；圖片與替代文字配對正確；id、排序、場次、投影、故事卡與小說類型都不變；圖片檔都存在"
C1=$(INTRO)
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "重複執行失敗"
[ "$(INTRO)" = "$C1" ] || fail "重複執行結果不同"
[ "$(q "select title from app.intro_material_backups where version = 'v1' and slug = 'intro-1' and clue_order = 0")" = "神祕故事一（佔位名稱）" ] || fail "備份被第二次執行覆蓋"
echo "ok - 01 教材可重複執行；備份只在第一次寫入"

# 4. 權限
for role in anon authenticated; do
  OUT=$(psql_ -d "$DB" -c "set role $role" -c "select count(*) from app.intro_material_backups" 2>&1 || true)
  echo "$OUT" | grep -qi "permission denied" || fail "$role 可以讀備份表：$OUT"
done
for t in intro_stories intro_clues content_sets; do
  OUT=$(psql_ -d "$DB" -c "set role anon" -c "select count(*) from public.$t" 2>&1 || true)
  echo "$OUT" | grep -qi "permission denied" || fail "anon 可以直接讀 $t：$OUT"
done
[ "$(tq "select name_after from public.intro_stories where slug = 'intro-2'")" = "小千" ] || fail "教師讀不到名字欄位"
[ "$(tq "select intro_text ->> 'bridge_title' from public.content_sets where is_default")" = "接下來，換你分類" ] || fail "教師讀不到單元文案"
echo "ok - 權限：備份表 anon／教師都讀不到；anon 不能直接讀探索故事、線索與素材組；教師可讀名字與文案"

# 5. 回復與再套用
q "update public.session_state set updated_at = now() - interval '3 hours' where session_id = '$SID'" >/dev/null
psql_ -d "$DB" -f "$ROLLBACK" >/dev/null 2>&1 || fail "回復腳本失敗"
[ "$(INTRO)" = "$C0" ] || fail "回復後與更新前不同"
[ "$(IDS)" = "$I0" ] || fail "回復改變了 id 或排序"
psql_ -d "$DB" -f "$CONTENT" >/dev/null 2>&1 || fail "再套用失敗"
[ "$(INTRO)" = "$C1" ] || fail "再套用後與第一次套用不同"
echo "ok - 回復腳本還原到更新前（逐欄位相同）、再套用後與第一次相同"
