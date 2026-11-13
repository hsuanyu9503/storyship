#!/usr/bin/env bash
# 啟動隔離的本機 Supabase（db＋GoTrue＋PostgREST＋Realtime＋閘道）。只供測試。
#   用法：bash tests/supabase/up.sh            # 啟動（資料庫為空，尚未安裝本專案 SQL）
#         bash tests/supabase/up.sh down       # 停止並刪除容器與資料
# 隨機產生的密鑰寫在 repository 之外的狀態目錄（預設 ~/.cache/storyship-sbtest，可用 SB_STATE_DIR 指定；不會輸出到畫面）。
# 不放在 repo 內：測試伺服器供應網站靜態檔，密鑰檔不能位於任何可能被供應的目錄之下（Phase 5 複檢 F1）。
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd); ROOT=$(realpath ../..)
STATE=$(bash "$HERE/state_dir.sh")
if [ "${1:-}" = "down" ]; then
  [ -f "$STATE/gateway.pid" ] && kill "$(cat "$STATE/gateway.pid")" 2>/dev/null || true
  docker compose --env-file "$STATE/env" -f docker-compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$STATE/env" "$STATE/gateway.pid"; echo "stack down"; exit 0
fi
NODE_PATH=$HERE/../e2e/node_modules
rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
if [ ! -f "$STATE/env" ]; then
  JWT_SECRET=$(rnd 32)
  sign() { NODE_PATH=$NODE_PATH node -e "console.log(require('jsonwebtoken').sign({ role: '$1', iss: 'supabase-demo' }, process.argv[1], { expiresIn: '10y' }))" "$JWT_SECRET"; }
  cat > "$STATE/env" <<ENV
POSTGRES_PASSWORD=$(rnd 16)
JWT_SECRET=$JWT_SECRET
SECRET_KEY_BASE=$(rnd 32)
ANON_KEY=$(sign anon)
SERVICE_KEY=$(sign service_role)
DB_PORT=${SB_DB_PORT:-54322}
AUTH_PORT=${SB_AUTH_PORT:-54329}
REST_PORT=${SB_REST_PORT:-54330}
REALTIME_PORT=${SB_REALTIME_PORT:-54340}
GATEWAY_PORT=${SB_GATEWAY_PORT:-54321}
ENV
  chmod 600 "$STATE/env"
fi
set -a; . "$STATE/env"; set +a
docker compose --env-file "$STATE/env" -f docker-compose.yml up -d >/dev/null 2>&1
# 等待各服務
wait_http() { for i in $(seq 1 90); do curl -s -o /dev/null "$1" && return 0; sleep 1; done; echo "timeout: $2"; docker compose --env-file "$STATE/env" -f docker-compose.yml logs --tail 30 "$2"; exit 1; }
wait_http "http://127.0.0.1:$AUTH_PORT/health" auth
wait_http "http://127.0.0.1:$REST_PORT/" rest
wait_http "http://127.0.0.1:$REALTIME_PORT/" realtime
[ -f "$STATE/gateway.pid" ] && kill "$(cat "$STATE/gateway.pid")" 2>/dev/null || true
nohup env ROOT="$HERE/../.." GATEWAY_PORT=$GATEWAY_PORT REST_PORT=$REST_PORT AUTH_PORT=$AUTH_PORT REALTIME_PORT=$REALTIME_PORT \
  ANON_KEY=$ANON_KEY SERVICE_KEY=$SERVICE_KEY node "$HERE/gateway.js" > "$STATE/gateway.log" 2>&1 &
echo $! > "$STATE/gateway.pid"
wait_http "http://127.0.0.1:$GATEWAY_PORT/index.html" gateway
echo "stack up: gateway http://localhost:$GATEWAY_PORT（db 127.0.0.1:$DB_PORT）"
