// 發布範圍（複查風險 1）：tools/build_site.sh 產生的發布產物
//   1. 不含 docs/、source-assets/、supabase/、tests/、tools/；以網址取得 docs/intro-source.json、Word 原稿、揭曉截圖都是 404
//   2. 發布產物的所有文字檔都不含 01 的答案（作品名稱、角色名字）
//   3. 兩張揭曉圖（960／1600）在發布產物中與 repo 逐位元組相同，並能在投影畫面實際載入（用發布產物當網站根目錄）
// 不需要資料庫；用 Node 內建的靜態伺服器提供發布產物（只監聽 127.0.0.1）。
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '../..');
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.json': 'application/json', '.md': 'text/markdown' };

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  const site = path.join(out, '_site');
  let server; let browser;
  try {
    execFileSync('bash', [path.join(ROOT, 'tools/build_site.sh'), site], { stdio: 'pipe' });
    const top = fs.readdirSync(site).sort();
    ok(JSON.stringify(top) === JSON.stringify(['.nojekyll', 'assets', 'config.js', 'css', 'index.html', 'join.html', 'js', 'projector.html', 'teacher.html']),
      `發布產物只有網站檔案（${top.join('、')}）`);
    const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } }; walk(site);
    const rel = files.map((f) => path.relative(site, f));
    ok(!rel.some((f) => /^(docs|source-assets|supabase|tests|tools|\.github)\//.test(f) || /\.(docx|png)$/i.test(f)), `沒有 docs、source-assets、supabase、tests、tools，也沒有 docx／png（共 ${rel.length} 個檔案）`);
    const ANSWERS = ['名偵探柯南', '江戶川柯南', '工藤新一', '神隱少女', '荻野千尋', '湯婆婆收走'];
    const hits = files.filter((f) => /\.(html|js|css|json|md|txt)$/.test(f)).filter((f) => { const t = fs.readFileSync(f, 'utf8'); return ANSWERS.some((w) => t.includes(w)); });
    ok(hits.length === 0, `發布產物的文字檔都沒有 01 的答案${hits.length ? '（' + hits.map((f) => path.relative(site, f)).join('、') + '）' : ''}`);
    for (const f of ['conan-1600', 'conan-960', 'chihiro-1600', 'chihiro-960']) {
      const a = path.join(site, 'assets/intro', f + '.webp'); const b = path.join(ROOT, 'assets/intro', f + '.webp');
      ok(fs.existsSync(a) && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0, `發布產物含 assets/intro/${f}.webp（與 repo 逐位元組相同）`);
    }
    // 以發布產物當網站根目錄
    server = http.createServer((req, res) => {
      const p = path.normalize(path.join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
      if (!p.startsWith(site) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const BASE = `http://127.0.0.1:${server.address().port}`;
    for (const u of ['/docs/intro-source.json', '/source-assets/intro/01%E8%B5%B0%E9%80%B2%E6%95%85%E4%BA%8B%E4%B8%96%E7%95%8C_%E6%8A%95%E5%BD%B1%E6%96%87%E5%AD%97.docx', '/docs/screenshots/intro/03-reveal-conan.webp', '/docs/INTRO_UNIT.md', '/supabase/content/intro_materials_v1.sql']) {
      const r = await fetch(BASE + u); ok(r.status === 404, `發布網站上 ${decodeURIComponent(u)} 為 404`);
    }
    browser = await chromium.launch();
    for (const [w, h] of [[1920, 1080], [1024, 768]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(BASE + '/projector.html');
      const r = await page.evaluate(async () => {
        const { renderProjection } = await import('/js/lib/render-projection.js');
        const shown = [];
        for (const [title, url] of [['名偵探柯南', 'assets/intro/conan-1600.webp'], ['神隱少女', 'assets/intro/chihiro-1600.webp']]) {
          const wrap = document.createElement('div'); wrap.className = 'stage-wrap';
          wrap.append(renderProjection({ status: 'active', projection: { screen: 'intro', view: 'story', story: { index: 0, total: 2, neutral: '神祕故事', clue_total: 0, clues: [],
            title, reveal_text: 'x', image_url: url, image_alt: `《${title}》揭曉圖` } } }, { showQr: false }));
          document.body.replaceChildren(wrap);
          for (let i = 0; i < 60; i++) { const im = wrap.querySelector('img'); if (im && im.complete && im.naturalWidth) break; await new Promise((res) => setTimeout(res, 100)); }
          const im = wrap.querySelector('img');
          shown.push({ title, loaded: Boolean(im && im.complete && im.naturalWidth), src: (im?.currentSrc || '').replace(/^.*\//, '') });
        }
        return shown;
      });
      ok(r.every((x) => x.loaded && /^(conan|chihiro)-(960|1600)\.webp$/.test(x.src) && x.src.startsWith(x.title === '名偵探柯南' ? 'conan' : 'chihiro')),
        `${w}x${h}：以發布產物為網站根目錄，兩張揭曉圖都能載入（${r.map((x) => x.src).join('、')}）`);
      await page.close();
    }
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  if (browser) await browser.close();
  if (server) server.close();
  fs.rmSync(out, { recursive: true, force: true });
  console.log(`\n發布範圍：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
