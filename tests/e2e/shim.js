// 本機端對端測試用的最小「Supabase 相容」伺服器：
//   * 靜態檔案（專案根目錄），config.js 改指向本伺服器
//   * /auth/v1/token、/auth/v1/user：以 JWT 模擬教師登入
//   * /rest/v1/rpc/:fn、/rest/v1/:table：轉成 SQL，以 anon / authenticated 角色在真實 PostgreSQL 執行
//   * 不提供 Realtime（用來驗證前端的輪詢備援）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '../..'));
const PORT = Number(process.env.PORT || 8787);
const SECRET = 'e2e-secret';
// 連線字串例：postgres://postgres:密碼@127.0.0.1/sf_e2e
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.md': 'text/plain' };

function send(res, code, body, headers = {}) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', ...headers };
  if (body === undefined) { res.writeHead(code, h); return res.end(); }
  res.writeHead(code, { 'Content-Type': 'application/json', ...h });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function identity(req) {
  const a = req.headers.authorization || '';
  const tok = a.replace(/^Bearer /, '');
  try { const c = jwt.verify(tok, SECRET); return { role: 'authenticated', sub: c.sub }; } catch { return { role: 'anon', sub: '' }; }
}

async function asRole(id, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${id.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [id.sub]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

function pgErr(res, e) {
  const status = e.code === '42501' ? 403 : 400;
  send(res, status, { code: e.code, message: e.message, details: null, hint: null });
}

function body(req) {
  return new Promise((ok) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
}

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('bad ident ' + s); return s; };

async function rpc(req, res, fn) {
  const args = await body(req);
  const id = identity(req);
  try {
    const keys = Object.keys(args);
    const sqlArgs = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    const ret = await pool.query(`select p.prorettype::regtype::text t from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and proname=$1`, [fn]);
    if (!ret.rows.length) return send(res, 404, { code: 'PGRST202', message: 'function not found' });
    const isVoid = ret.rows[0].t === 'void';
    const r = await asRole(id, (c) => c.query(`select ${isVoid ? '' : 'to_jsonb'}(public.${ident(fn)}(${sqlArgs})) as r`, vals));
    if (isVoid) return send(res, 204);
    send(res, 200, JSON.stringify(r.rows[0].r));
  } catch (e) { pgErr(res, e); }
}

async function table(req, res, name, q) {
  const id = identity(req);
  try {
    ident(name);
    const sel = q.get('select') || '*';
    const parts = sel.match(/[a-z_]+\([^)]*\)|[^,]+/g).map((s) => s.trim());
    const cols = [];
    for (const p of parts) {
      const m = p.match(/^([a-z_]+)\((.*)\)$/);
      if (m) {
        const fk = await pool.query(`select kcu.column_name from information_schema.referential_constraints rc
          join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
          join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.unique_constraint_name
          where kcu.table_name = $1 and ccu.table_name = $2`, [m[1], name]);
        cols.push(`(select coalesce(json_agg(e.*), '[]') from public.${ident(m[1])} e where e.${ident(fk.rows[0].column_name)} = base.id) as ${m[1]}`);
      } else cols.push(p === '*' ? 'base.*' : 'base.' + ident(p));
    }
    const where = []; const vals = [];
    let order = '';
    for (const [k, v] of q.entries()) {
      if (k === 'select' || k === 'limit' || k === 'offset') continue;
      if (k === 'order') { order = ' order by ' + v.split(',').map((o) => { const [c, d] = o.split('.'); return 'base.' + ident(c) + (d === 'desc' ? ' desc' : ' asc'); }).join(', '); continue; }
      const m = v.match(/^eq\.(.*)$/);
      if (m) { vals.push(m[1]); where.push(`base.${ident(k)}::text = $${vals.length}`); }
    }
    const sql = `select ${cols.join(', ')} from public.${name} base ${where.length ? 'where ' + where.join(' and ') : ''}${order}`;
    const r = await asRole(id, (c) => c.query(sql, vals));
    if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
      if (r.rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return send(res, 200, r.rows[0]);
    }
    send(res, 200, r.rows);
  } catch (e) { pgErr(res, e); }
}

async function auth(req, res, p) {
  if (p.startsWith('/auth/v1/token')) {
    const b = await body(req);
    const r = await pool.query('select id, email from auth.users where email = $1', [b.email]);
    if (!r.rows.length || b.password !== 'pass') return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    const u = r.rows[0];
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    return send(res, 200, { access_token: jwt.sign({ sub: u.id, role: 'authenticated', exp, email: u.email }, SECRET), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r-' + u.id, user });
  }
  if (p.startsWith('/auth/v1/user')) {
    const id = identity(req);
    if (!id.sub) return send(res, 401, { message: 'no' });
    const r = await pool.query('select id, email from auth.users where id = $1', [id.sub]);
    return send(res, 200, { id: r.rows[0].id, email: r.rows[0].email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
  }
  if (p.startsWith('/auth/v1/logout')) return send(res, 204);
  send(res, 404, { message: 'not implemented' });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);
  if (p.startsWith('/rest/v1/rpc/')) return rpc(req, res, p.slice('/rest/v1/rpc/'.length));
  if (p.startsWith('/rest/v1/')) return table(req, res, p.slice('/rest/v1/'.length), u.searchParams);
  if (p.startsWith('/auth/v1/')) return auth(req, res, p);
  if (p.startsWith('/realtime/')) return send(res, 404, { message: 'realtime disabled in e2e' });
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`export const CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_ANON_KEY: 'e2e-anon' };`);
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('shim on', PORT));
