// Phase 5 複檢 F1：測試用伺服器（tests/e2e/shim.js、tests/supabase/gateway.js）不得供應網站以外的檔案，且只監聽 loopback。
// 以「假的 repository root」（只放假資料）啟動兩個伺服器實際發出 HTTP 請求；斷言不輸出任何回應內容。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DUMMY = 'DUMMY-NOT-A-SECRET-' + Date.now();
let root; let sibling; const procs = [];

function write(rel, body, base = root) { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function start(script, env, readyText) {
  const p = spawn(process.execPath, [script], { env: { ...process.env, ...env, ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start: ' + script)), 10000);
    p.stdout.on('data', (d) => { if (String(d).includes(readyText)) { clearTimeout(t); res(); } });
    p.on('exit', (c) => { clearTimeout(t); rej(new Error('server exited ' + c)); });
  });
}
// 原始請求（不經 URL 正規化，才能送出 ../ 與編碼過的路徑）
function raw(port, reqPath, headers = {}) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    });
    let buf = ''; s.on('data', (d) => { buf += d; }); s.on('end', () => res({ status: Number(buf.split(' ')[1]), leaked: buf.includes(DUMMY) }));
    s.on('error', rej);
  });
}
const nonLoopback = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const canConnect = (host, port) => new Promise((res) => { const s = net.connect(port, host); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 2000); });

const servers = {};
// shim.js 需要 tests/e2e 的依賴（pg、jsonwebtoken）；沒有安裝時略過 shim 的部分（gateway 沒有依賴，一律執行）
import { createRequire } from 'node:module';
let shimDeps = true;
try { const r = createRequire(path.join(REPO, 'tests/e2e/package.json')); r.resolve('pg'); r.resolve('jsonwebtoken'); } catch { shimDeps = false; }
before(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-static-'));
  root = path.join(base, 'repo'); sibling = path.join(base, 'repo-secret');
  for (const f of ['index.html', 'join.html', 'teacher.html', 'projector.html']) write(f, '<!doctype html><title>ok</title>');
  write('js/teacher/main.js', 'export const ok = 1;'); write('js/vendor/x.js', 'export {}'); write('css/app.css', 'body{}'); write('assets/a.svg', '<svg/>');
  write('config.js', `export const CONFIG = { SUPABASE_ANON_KEY: '${DUMMY}' };`);   // 真正的 config.js 不應被供應（由伺服器產生）
  write('tests/supabase/.state/env', `SERVICE_KEY=${DUMMY}\nJWT_SECRET=${DUMMY}\n`);
  write('.git/config', `[remote] url = ${DUMMY}`);
  write('.env', `X=${DUMMY}`);
  write('supabase/migrations/001_init.sql', `-- ${DUMMY}`);
  write('package.json', `{"x":"${DUMMY}"}`);
  write('file', DUMMY, sibling);
  if (shimDeps) {
    servers.shim = await freePort();
    await start(path.join(REPO, 'tests/e2e/shim.js'), { PORT: String(servers.shim), DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, 'shim on');
  }
  servers.gateway = await freePort();
  await start(path.join(REPO, 'tests/supabase/gateway.js'), { GATEWAY_PORT: String(servers.gateway), REST_PORT: '1', AUTH_PORT: '1', REALTIME_PORT: '1', ANON_KEY: 'anon-test', SERVICE_KEY: 'service-test' }, 'gateway on');
});
after(() => { for (const p of procs) p.kill(); });

const BLOCKED = ['/tests/supabase/.state/env', '/.git/config', '/.env', '/package.json', '/supabase/migrations/001_init.sql',
  '/js/../tests/supabase/.state/env', '/js/%2e%2e/tests/supabase/.state/env', '/%2e%2e/repo-secret/file', '/../repo-secret/file',
  '/js/..%2f..%2frepo-secret%2ffile', '/js/%2E%2E%2F.git%2Fconfig', '/tests%2fsupabase%2f.state%2fenv', '/js/.hidden', '/js/teacher/main.js%00.css', '/README.md', '/docs/PHASE5.md'];
for (const name of ['shim', 'gateway']) {
  const skip = name === 'shim' && !shimDeps ? '未安裝 tests/e2e 的依賴（cd tests/e2e && npm install）' : false;
  test(`${name}：網站以外的檔案（密鑰檔、.git、隱藏檔、tests、越界與編碼路徑）一律 403／404，且回應不含其內容`, { skip }, async () => {
    for (const p of BLOCKED) {
      const r = await raw(servers[name], p);
      assert.ok([400, 403, 404].includes(r.status), `${name} ${p} → ${r.status}`);
      assert.equal(r.leaked, false, `${name} ${p} 回應含有檔案內容`);
    }
  });
  test(`${name}：網站本身的 HTML／JS／CSS／素材仍可載入；config.js 由伺服器產生`, { skip }, async () => {
    for (const p of ['/', '/index.html', '/join.html?code=ABC', '/teacher.html', '/projector.html', '/js/teacher/main.js', '/js/vendor/x.js', '/css/app.css', '/assets/a.svg', '/config.js']) {
      const r = await raw(servers[name], p);
      assert.equal(r.status, 200, `${name} ${p} → ${r.status}`);
      assert.equal(r.leaked, false, `${name} ${p}`);
    }
  });
  test(`${name}：只監聽 loopback`, { skip }, async (t) => {
    const ip = nonLoopback();
    if (!ip) return t.skip('沒有非 loopback 的網路介面');
    assert.equal(await canConnect(ip, servers[name]), false, `${name} 可從 ${ip} 連線`);
  });
}
test('gateway：API 沒有有效 apikey 時拒絕（401）', async () => {
  for (const p of ['/rest/v1/sessions', '/auth/v1/settings', '/rest/v1/rpc/projector_state']) {
    assert.equal((await raw(servers.gateway, p)).status, 401, p);
    assert.equal((await raw(servers.gateway, p, { apikey: 'wrong' })).status, 401, p + ' wrong key');
  }
});

test('本機 Supabase 的密鑰目錄不能位於 repository 之內', async () => {
  const { spawnSync } = await import('node:child_process');
  const sh = path.join(REPO, 'tests/supabase/state_dir.sh');
  const inside = spawnSync('bash', [sh], { env: { ...process.env, SB_STATE_DIR: path.join(REPO, 'tests/supabase/.state') }, encoding: 'utf8' });
  assert.notEqual(inside.status, 0, 'repo 內的目錄應被拒絕');
  assert.equal(fs.existsSync(path.join(REPO, 'tests/supabase/.state')), false, '被拒絕時不應建立目錄');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-state-'));
  const outside = spawnSync('bash', [sh], { env: { ...process.env, SB_STATE_DIR: outDir }, encoding: 'utf8' });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout.trim(), fs.realpathSync(outDir));
  const dflt = spawnSync('bash', [sh], { env: { ...process.env, SB_STATE_DIR: '' }, encoding: 'utf8' });
  assert.equal(dflt.status, 0);
  assert.ok(path.relative(REPO, dflt.stdout.trim()).startsWith('..'), '預設目錄在 repo 之外');
});
