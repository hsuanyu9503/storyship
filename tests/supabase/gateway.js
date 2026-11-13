// 本機 Supabase 測試用的閘道（代替 Supabase 的 Kong）：
//   /rest/v1/*      → PostgREST（真實）
//   /auth/v1/*      → GoTrue（真實）
//   /realtime/v1/*  → Realtime（真實，含 WebSocket）
//   其他路徑        → 只供應網站本身的檔案（tests/lib/static-site.js）；/config.js 指向本閘道與本次產生的 anon key
// 與 Kong 一樣要求每個 API 請求帶 apikey（anon key 或 service_role key），其餘權限完全由 JWT 角色決定。
// 只供隔離的測試環境使用。
const http = require('http');
const net = require('net');
const path = require('path');
const { serveStatic, LOOPBACK } = require('../lib/static-site.js');

const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '../..'));
const PORT = Number(process.env.GATEWAY_PORT);
const UP = {
  rest: Number(process.env.REST_PORT), auth: Number(process.env.AUTH_PORT), realtime: Number(process.env.REALTIME_PORT),
};
const KEYS = new Set([process.env.ANON_KEY, process.env.SERVICE_KEY].filter(Boolean));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

function route(url) {
  if (url.startsWith('/rest/v1/')) return { port: UP.rest, path: url.slice('/rest/v1'.length) };
  if (url.startsWith('/auth/v1/')) return { port: UP.auth, path: url.slice('/auth/v1'.length) };
  if (url.startsWith('/realtime/v1/')) return { port: UP.realtime, path: '/socket' + url.slice('/realtime/v1'.length), host: 'realtime-dev.supabase-realtime' };
  return null;
}
function apikeyOf(req) {
  const u = new URL(req.url, 'http://x');
  return req.headers.apikey || u.searchParams.get('apikey');
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const r = route(req.url);
  if (r) {
    if (!KEYS.has(apikeyOf(req))) { res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' }); return res.end('{"message":"Invalid API key"}'); }
    const headers = { ...req.headers, host: r.host || `127.0.0.1:${r.port}` };
    const up = http.request({ host: '127.0.0.1', port: r.port, method: req.method, path: r.path, headers }, (ur) => {
      res.writeHead(ur.statusCode, { ...ur.headers, ...CORS });
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, CORS); res.end(); });
    return req.pipe(up);
  }
  // 靜態檔：只供應網站本身的檔案（tests/lib/static-site.js；Phase 5 複檢 F1）
  serveStatic(req, res, ROOT, `export const CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_ANON_KEY: '${process.env.ANON_KEY}' };`);
});

// WebSocket（Realtime）：原樣轉送 upgrade 請求
server.on('upgrade', (req, sock, head) => {
  const r = route(req.url);
  if (!r || !KEYS.has(apikeyOf(req)) || realtimeBlocked) { sock.destroy(); return; }
  const up = net.connect(r.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${r.path} HTTP/1.1`];
    for (const [k, v] of Object.entries({ ...req.headers, host: r.host || `127.0.0.1:${r.port}` })) lines.push(`${k}: ${v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    sock.pipe(up); up.pipe(sock);
  });
  sockets.add(sock); sock.on('close', () => sockets.delete(sock));
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
const sockets = new Set();
let realtimeBlocked = false;
// 測試用：SIGUSR1＝切斷所有 Realtime 連線並拒絕重新連線（模擬學校網路封鎖 WebSocket）；SIGUSR2＝恢復
process.on('SIGUSR1', () => { realtimeBlocked = true; for (const s of sockets) s.destroy(); console.log('realtime blocked'); });
process.on('SIGUSR2', () => { realtimeBlocked = false; console.log('realtime restored'); });
server.listen(PORT, LOOPBACK, () => console.log('gateway on', PORT));   // 只監聽 loopback
