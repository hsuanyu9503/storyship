#!/usr/bin/env bash
# Phase 3 複檢 D2 邊界（docs/REVIEW_PHASE3.md 第三輪）：「三個版本都相同、只有操作鎖逾時」時兩個讀取回應的排序。
# 用兩個真實資料庫連線製造重疊的讀取交易（不是延遲前端回應）：
#   R1：在鎖逾時「之前」開始交易（now() 固定在開始時間），停頓到逾時之後才執行 student_group_board，最後才回來
#   R2：在逾時之後開始並先完成
# 檢查：兩個回應的 board_rev／lock_rev／state_rev 完全相同；R1 仍列出鎖（以它自己的 now() 過濾）、R2 沒有；
#       R1.read_now < R2.read_now；前端實際的判斷函式（js/lib/board-order.js isOlderBoard）會丟棄較晚到的 R1。
#   另一情境：R1 停頓期間鎖被「續約」（lock_rev 不變）→ 兩個回應都列出鎖，排序仍以 read_now 為準、結果一致。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(realpath ../..); HERE=$(pwd); DB=${TEST_DB:-story_friends_race_d2}
as_pg() { if [ "$(id -u)" = 0 ] && [ -z "${PGUSER:-}" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_() { as_pg psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -d "$DB" -c "$1"; }
fail() { echo "FAIL: $*"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; chmod 777 "$TMP"
psql_ -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
psql_ -d postgres -c "create database $DB" >/dev/null
for f in "$HERE/supabase_stub.sql" "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do
  psql_ -d "$DB" -f "$f" >/dev/null 2>&1
done
T1=11111111-1111-1111-1111-111111111111
TA=$(printf 'a%.0s' {1..40}); TB=$(printf 'b%.0s' {1..40})
TEACH="set role authenticated; select set_config('request.jwt.claim.sub', '$T1', false);"
q "insert into auth.users (id, email) values ('$T1', 't1@example.com'); insert into public.teachers values ('$T1', 't1@example.com');" >/dev/null
SID=$(psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_create_session('d2', 6)->>'session_id'" | tail -1)
CODE=$(q "select join_code from public.sessions where id = '$SID'")
q "set role anon; select public.student_join('$CODE', '$TA', 1), public.student_join('$CODE', '$TB', 1)" >/dev/null
psql_ -d "$DB" -c "$TEACH" -c "select public.teacher_set_stage('$SID', '04', '04', '{\"screen\":\"instruction\"}', (select rev from public.session_state where session_id = '$SID'), false)" >/dev/null
CARD=$(q "select id from public.story_cards order by sort_order limit 1")
BOARD="select public.student_group_board('$SID', '$TB')::text"

# 以前端實際使用的函式（js/lib/board-order.js 的 isOlderBoard，js/student/group.js adopt() 呼叫它）判斷：
# 目前採用 a、晚到 b 時，b 是否被丟棄 → 回傳較新的那一個（a 或 b）。不另寫一份判斷，避免兩份邏輯漂移。
newer() { node --input-type=module -e '
  import { isOlderBoard } from "'"$ROOT"'/js/lib/board-order.js";
  const [a, b] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2])];
  // 與 adopt() 相同：採用後存的是正規化過的版本號
  const cur = { board_rev: a.board_rev, lock_rev: a.lock_rev ?? 0, state_rev: a.state_rev ?? 0, read_now: a.read_now ?? 0 };
  console.log(isOlderBoard(cur, b) ? "a" : "b");' "$1" "$2"; }
field() { node -e 'const x = JSON.parse(process.argv[1]); console.log(JSON.stringify(x[process.argv[2]]))' "$1" "$2"; }

scenario() {   # $1 名稱 $2 R1 停頓期間要做的事（空＝讓鎖自然逾時）
  # 組員 A 取得卡片操作鎖，並把逾時改成 2 秒後（不改 lock_rev）
  q "set role anon; select public.group_lock('$SID', '$TA', 'card:$CARD', true)" >/dev/null || true
  [ "$(q "set role anon; select public.group_lock('$SID', '$TA', 'card:$CARD', false)->>'ok'" | tail -1)" = "true" ] || fail "$1：取得鎖失敗"
  q "update public.group_locks set expires_at = now() + interval '2 seconds'" >/dev/null
  # R1：交易在逾時前開始（now() 固定），停頓 3.5 秒後才讀取
  ( psql_ -d "$DB" -c "set role anon" -c "begin; select now(); select pg_sleep(3.5); $BOARD; commit;" | sed -n '3p' > "$TMP/r1" ) &
  local pid=$!
  sleep 2.6                                     # 鎖已逾時（R1 仍在交易中）
  [ -n "$2" ] && eval "$2"
  R2=$(q "set role anon; $BOARD" | tail -1)     # R2 先完成
  wait $pid
  R1=$(cat "$TMP/r1")
  [ -n "$R1" ] && [ -n "$R2" ] || fail "$1：讀取失敗"
  for k in board_rev lock_rev state_rev; do
    [ "$(field "$R1" $k)" = "$(field "$R2" $k)" ] || fail "$1：$k 不同（$(field "$R1" $k) vs $(field "$R2" $k)），不是 D2 邊界情境"
  done
  node -e 'const [a,b]=[JSON.parse(process.argv[1]),JSON.parse(process.argv[2])]; if (!(a.read_now < b.read_now)) process.exit(1)' "$R1" "$R2" \
    || fail "$1：R1（較早開始）的 read_now 應小於 R2"
  [ "$(newer "$R2" "$R1")" = "a" ] || fail "$1：晚到的 R1 沒有被丟棄"
  [ "$(newer "$R1" "$R2")" = "b" ] || fail "$1：R2 應被採用"
  echo "$R1" > "$TMP/last_r1"; echo "$R2" > "$TMP/last_r2"
}

# 情境 1：鎖自然逾時
scenario "鎖逾時" ""
R1L=$(field "$(cat "$TMP/last_r1")" locks); R2L=$(field "$(cat "$TMP/last_r2")" locks)
[ "$R1L" != "[]" ] || fail "鎖逾時：R1 以它自己的 now() 過濾，應仍看到鎖：$R1L"
[ "$R2L" = "[]" ] || fail "鎖逾時：R2 不應看到已逾時的鎖：$R2L"
echo "ok - D2 邊界（真實並行）：三個版本相同、只有鎖逾時；較早開始但較晚完成的讀取（仍含鎖）被丟棄，採用沒有鎖的較新讀取"

# 情境 2：R1 停頓期間，組員 A 續約（lock_rev 不變）
scenario "鎖續約" "q \"set role anon; select public.group_lock('$SID', '$TA', 'card:$CARD', false)\" >/dev/null"
R2L=$(field "$(cat "$TMP/last_r2")" locks)
[ "$R2L" != "[]" ] || fail "鎖續約：R2 應看到續約後的鎖：$R2L"
echo "ok - D2 邊界（真實並行）：停頓期間鎖續約（lock_rev 不變）；兩個回應版本相同，仍以 read_now 採用較新的讀取（含續約後的鎖）"

# 情境 3：同一交易內的一致性——每個回應列出的鎖，在它自己的 read_now 時都尚未逾時
q "set role anon; select public.group_lock('$SID', '$TA', 'card:$CARD', true)" >/dev/null
q "set role anon; select public.group_lock('$SID', '$TA', 'card:$CARD', false)" >/dev/null
q "update public.group_locks set expires_at = now() + interval '1 second'" >/dev/null
BAD=0
for i in $(seq 1 12); do
  R=$(q "set role anon; $BOARD" | tail -1)
  N=$(field "$R" locks | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')
  RN=$(field "$R" read_now)
  LIVE=$(q "select count(*) from public.group_locks where expires_at > to_timestamp($RN)")
  [ "$N" = "$LIVE" ] || BAD=$((BAD + 1))
  sleep 0.15
done
[ "$BAD" = "0" ] || fail "鎖清單與 read_now 不一致 $BAD 次"
echo "ok - D2 邊界：跨越逾時前後的 12 次讀取，每次回應的鎖清單都與它的 read_now 一致"
