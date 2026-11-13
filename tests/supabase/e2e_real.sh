#!/usr/bin/env bash
# 以真實的 GoTrue／PostgREST／Realtime（隔離的本機 Supabase）執行瀏覽器端對端測試 tests/e2e/e2e.js
# 與 shim 版的差別：教師以 GoTrue 帳號密碼登入、RPC 與資料表讀取經真實 PostgREST、Realtime 可用（非只靠輪詢）。
# 用法：bash tests/supabase/e2e_real.sh [log]   （需要 Docker；結束後停止容器）
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd); ROOT=$(realpath ../..); STATE=$(bash "$HERE/state_dir.sh"); LOG=${1:-$STATE/e2e_real.log}
bash "$HERE/up.sh" down >/dev/null; bash "$HERE/up.sh" >/dev/null
set -a; . "$STATE/env"; set +a
psql_() { PGPASSWORD=$POSTGRES_PASSWORD psql -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres "$@"; }
for f in "$ROOT"/supabase/migrations/00{1,2,3}_*.sql "$ROOT/supabase/seed/001_placeholder_content.sql"; do psql_ -f "$f" >/dev/null 2>&1; done
# 測試教師：以 GoTrue 註冊（隨機密碼，只存在這次的容器），再依 supabase/setup/add_teacher.sql 的方式加入白名單
EMAIL="e2e-teacher@example.test"; PASS=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
curl -s -o /dev/null -X POST "http://localhost:$GATEWAY_PORT/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
psql_ -c "insert into public.teachers (user_id, email) select id, email from auth.users where email = '$EMAIL'" >/dev/null
[ "$(psql_ -c "select count(*) from public.teachers")" = "1" ] || { echo "教師帳號建立失敗"; exit 1; }
cd "$ROOT/tests/e2e"
set +e
# Realtime 中斷與恢復（瀏覽器，真實 Realtime）
BASE="http://localhost:$GATEWAY_PORT" E2E_EMAIL=$EMAIL E2E_PASSWORD=$PASS GATEWAY_PID=$(cat "$STATE/gateway.pid") \
  timeout 600 node "$HERE/realtime_browser.js" > "$LOG.realtime" 2>&1
RT=$?
echo "realtime exit $RT $(tail -1 "$LOG.realtime")"
# 觸控與投影（真實堆疊）
BASE="http://localhost:$GATEWAY_PORT" E2E_EMAIL=$EMAIL E2E_PASSWORD=$PASS \
  DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:$DB_PORT/postgres" timeout 900 node touch.js > "$LOG.touch" 2>&1
TC=$?
echo "touch exit $TC $(grep -E '通過 [0-9]+ 項' "$LOG.touch" | tail -1)"
BASE="http://localhost:$GATEWAY_PORT" E2E_EMAIL=$EMAIL E2E_PASSWORD=$PASS \
  DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:$DB_PORT/postgres" timeout 2400 node e2e.js > "$LOG" 2>&1
CODE=$?
[ $CODE = 0 ] && CODE=$RT; [ $CODE = 0 ] && CODE=$TC
set -e
echo "exit $CODE $(grep -E '全部通過|FAIL:|SOFT_FAIL' "$LOG" | tail -2 | tr '\n' ' ')"
# Realtime 伺服器端的警告與錯誤（例如速率限制、斷線），供診斷
docker logs realtime-dev.supabase-realtime 2>&1 | grep -iE "error|warn|limit|disconnect|shutdown" | grep -v "execute \"" | tail -200 > "$LOG.realtime-server" || true
[ -n "${KEEP:-}" ] || bash "$HERE/up.sh" down >/dev/null
exit $CODE
