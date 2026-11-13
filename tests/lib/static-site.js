// 測試用伺服器（tests/e2e/shim.js、tests/supabase/gateway.js）共用的靜態檔供應：只供應網站本身的檔案。
//   允許：根目錄的 index.html、join.html、teacher.html、projector.html，以及 js/、css/、assets/ 之下的檔案
//   拒絕：其他所有路徑（tests/、supabase/、docs/、.git/、.state/、任何以「.」開頭的路徑段、..、NUL、反斜線、
//         解碼失敗、經符號連結跳出根目錄）
//   config.js 一律由伺服器產生（指向測試 API），不讀取磁碟上的 config.js
// Phase 5 複檢 F1：先前以 startsWith(ROOT) 判斷，會供應整個 repository（包含本機測試密鑰檔）。
const fs = require('fs');
const path = require('path');

const PUBLIC_FILES = new Set(['index.html', 'join.html', 'teacher.html', 'projector.html']);
const PUBLIC_DIRS = new Set(['js', 'css', 'assets']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

// 回傳可供應的絕對路徑；不允許時回傳 null
function resolvePublic(root, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  const segs = p.split('/').filter((s) => s !== '');
  if (segs.length === 0) segs.push('index.html');
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  if (segs.length === 1 ? !PUBLIC_FILES.has(segs[0]) : !PUBLIC_DIRS.has(segs[0])) return null;
  const base = fs.realpathSync(root);
  const f = path.resolve(base, ...segs);
  if (!within(base, f)) return null;
  let real;
  try { real = fs.realpathSync(f); } catch { return null; }
  if (!within(base, real) || !fs.statSync(real).isFile()) return null;
  return real;
}
// 真正的目錄邊界判斷（/repo-secret 不算在 /repo 之內）
function within(base, f) {
  const rel = path.relative(base, f);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

// 處理靜態請求；configJs：config.js 的內容
function serveStatic(req, res, root, configJs) {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(configJs);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const f = resolvePublic(root, pathname);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}

// 測試伺服器只監聽 loopback
const LOOPBACK = '127.0.0.1';

module.exports = { resolvePublic, serveStatic, LOOPBACK };
