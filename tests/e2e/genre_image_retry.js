// 小說類型圖片的失敗恢復（複檢 F1）與 ResizeObserver 清理
//   投影端只在公開版本（rev）改變時重繪；圖片短暫失敗後，必須在「同一個公開版本」下自行恢復。
//   1. 06：第一次圖片請求失敗 → 替代框 → 自動重試成功（rev 不變）
//   2. 07：橫式圖第一次失敗 → 網路恢復（online 事件）時重試成功（rev 不變）
//   3. 永久 404：重試次數有上限；替代框有「重新載入圖片」按鈕，按一次只多一個請求
//   4. 重試期間切換類型：舊圖的重試取消、不再請求，新圖正常顯示
//   5. 成功的圖片不重複下載
//   6. 教師預覽與投影各自失敗、各自恢復
//   7. 連續切換畫面後，已移除的圖片框其 ResizeObserver 都已 disconnect
//   8. 教師平板（觸控，1366×1024、1024×768）：縮小預覽裡不放小按鈕，改在預覽下方顯示一般大小的「重新載入預覽圖片」
//      （至少 44px 高、完整可見），點一下每個失敗的預覽圖只多一個請求、投影端不受影響（複檢 F1）
// 需要 shim（資料庫已套用 genre_materials_v1.sql）。
const { chromium } = require('playwright');
const { Pool } = require('pg');
const BASE = process.env.BASE || 'http://localhost:8787';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_e2e' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重繪中 */ } await sleep(150); } return false; }
let ANON = ''; let TT = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(fn + ': ' + t); return t ? JSON.parse(t) : null;
}
// 圖片請求控制：rule(file, n) 回傳 'ok'｜'fail'｜'404'；記錄每次請求
async function imageControl(ctx) {
  const c = { reqs: [], rule: () => 'ok' };
  await ctx.route('**/assets/genres/*.webp', (route) => {
    const f = route.request().url().replace(/^.*\/assets\/genres\//, '');
    const n = c.reqs.filter((x) => x === f).length;
    c.reqs.push(f);
    const r = c.rule(f, n);
    if (r === 'fail') return route.abort('failed');
    if (r === '404') return route.fulfill({ status: 404, body: 'not found' });
    return route.continue();
  });
  c.count = (re) => c.reqs.filter((f) => re.test(f)).length;
  return c;
}
const visual = (page, scope = '.stage') => page.evaluate((scope) => {
  const box = document.querySelector(scope + ' .st-visual'); if (!box) return null;
  const img = box.querySelector('img');
  return { cls: box.className, loaded: Boolean(img && img.complete && img.naturalWidth > 0 && !box.classList.contains('missing')),
           src: (img?.currentSrc || '').replace(/^.*\/assets\/genres\//, ''), retryBtn: Boolean(box.querySelector('button')), text: box.innerText };
}, scope);

(async () => {
  const browser = await chromium.launch();
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;
    const cr = await api('teacher_create_session', { p_title: '圖片恢復', p_group_count: 2 }, TT);
    const SID = cr.session_id;
    const pk = (await pg.query('select projector_key from public.sessions where id = $1', [SID])).rows[0].projector_key;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, sub, proj) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: sub, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: true }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    const reveal = (i) => stage('06', '06-02', { screen: 'genre', view: 'genre', ctl: { view: 'genre', index: i, reveal: true } });

    const pc = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    // ResizeObserver 計數（第 7 項）
    await pc.addInitScript(() => {
      const RO = window.ResizeObserver; window.__ro = { created: 0, disconnected: 0 };
      window.ResizeObserver = class extends RO {
        constructor(cb) { super(cb); window.__ro.created++; }
        disconnect() { window.__ro.disconnected++; return super.disconnect(); }
      };
    });
    const img = await imageControl(pc);
    const P = await pc.newPage();
    await P.goto(`${BASE}/projector.html?s=${SID}&k=${pk}`);

    // 1. 06：第一次失敗 → 自動重試成功（rev 不變）
    img.rule = (f, n) => (f.startsWith('fantasy-portrait') && n === 0 ? 'fail' : 'ok');
    await reveal(0);
    const r1 = await rev();
    ok(await until(async () => (await visual(P))?.cls.includes('missing'), 10000), '06：第一次圖片請求失敗時顯示替代框');
    ok(await until(async () => (await visual(P))?.loaded, 20000) && (await rev()) === r1, `06：同一個公開版本下自動重試，圖片恢復（rev ${r1} 不變；請求 ${img.count(/^fantasy-portrait/)} 次）`);

    // 5. 成功的圖片不重複下載
    const n5 = img.count(/^fantasy-portrait/);
    await sleep(8000);
    ok(img.count(/^fantasy-portrait/) === n5, `成功載入後不再重複下載（8 秒內 ${img.count(/^fantasy-portrait/) - n5} 次）`);

    // 2. 07：橫式第一次失敗 → online 事件時重試（rev 不變）
    await stage('07', '07', { screen: 'placeholder', title: '小小故事分類師' });
    img.rule = (f, n) => (f.startsWith('detective-landscape') && n === 0 ? 'fail' : 'ok');
    await pc.setOffline(false);
    const pub = await api('teacher_publish_match', { p_session: SID, p_ctl: { genre: 1, elements: [0] }, p_expected_rev: await rev() }, TT);
    if (!pub.ok) throw new Error(JSON.stringify(pub));
    const r2 = await rev();
    ok(await until(async () => (await visual(P))?.cls.includes('missing'), 10000), '07：橫式圖第一次失敗時顯示替代框');
    await pc.setOffline(true); await sleep(300); await pc.setOffline(false);   // 觸發 online 事件
    ok(await until(async () => (await visual(P))?.loaded, 8000) && (await rev()) === r2, `07：網路恢復時重試，圖片恢復（rev ${r2} 不變）`);

    // 3. 永久 404：有上限；手動重試一次只多一個請求
    img.rule = (f) => (f.startsWith('historical-portrait') ? '404' : 'ok');
    await reveal(2);
    ok(await until(async () => (await visual(P))?.cls.includes('missing'), 10000), '永久 404：顯示替代框');
    await sleep(30000);
    const n3 = img.count(/^historical-portrait/);
    ok(n3 >= 2 && n3 <= 5, `永久 404：自動重試有上限（30 秒內共 ${n3} 次請求）`);
    await sleep(15000);
    ok(img.count(/^historical-portrait/) === n3, '永久 404：達到上限後不再自動請求');
    const v3 = await visual(P);
    ok(v3?.retryBtn && v3.text.includes('歷史'), `永久 404：替代框有描述文字與「重新載入圖片」按鈕（${v3?.text.replace(/\s+/g, ' ')}）`);
    if (v3?.retryBtn) {
      await P.locator('.stage .st-visual button').click();
      await sleep(2500);
      ok(img.count(/^historical-portrait/) === n3 + 1, `手動重試一次只多一個請求（${img.count(/^historical-portrait/) - n3}）`);
    } else ok(false, '手動重試：沒有重試按鈕');

    // 4. 重試期間切換類型：舊圖取消重試
    img.rule = (f) => (f.startsWith('adventure-portrait') ? 'fail' : 'ok');
    await reveal(3);
    ok(await until(async () => (await visual(P))?.cls.includes('missing'), 10000), '切換測試：冒險的圖片失敗');
    await reveal(4);
    ok(await until(async () => (await visual(P))?.loaded && (await visual(P)).src.startsWith('wuxia-portrait'), 15000), '切換到武俠後顯示武俠的圖');
    const n4 = img.count(/^adventure-portrait/);
    await sleep(20000);
    ok(img.count(/^adventure-portrait/) === n4 && (await visual(P)).src.startsWith('wuxia-portrait'), `切換後舊圖不再重試（20 秒內 ${img.count(/^adventure-portrait/) - n4} 次）、畫面維持新圖`);

    // 7. ResizeObserver 清理：再切換 10 次畫面
    const SL = ['fantasy', 'detective', 'historical', 'adventure', 'wuxia'];
    for (let i = 0; i < 10; i++) {
      await reveal(i % 5);   // 每次都等到該類型的圖實際顯示（確定畫面重繪過）
      await until(async () => { const v = await visual(P); return v?.loaded && v.src.startsWith(SL[i % 5]); }, 15000);
    }
    await sleep(1500);
    const ro = await P.evaluate(() => window.__ro);
    const live = await P.evaluate(() => document.querySelectorAll('.st-visual').length);
    ok(ro.created - ro.disconnected <= live, `移除的圖片框都已釋放 ResizeObserver（建立 ${ro.created}、disconnect ${ro.disconnected}、畫面上 ${live}）`);

    // 6. 教師預覽與投影各自失敗、各自恢復
    img.rule = () => 'ok';
    const tc = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    const timg = await imageControl(tc);
    timg.rule = (f, n) => (f.startsWith('fantasy-portrait') && n === 0 ? 'fail' : 'ok');
    const T = await tc.newPage();
    await T.goto(`${BASE}/teacher.html#/s/${SID}`);
    await T.waitForSelector('input[type=email], .genre-pick', { timeout: 15000 });
    if (await T.locator('input[type=email]').count()) {
      await T.fill('input[type=email]', process.env.E2E_EMAIL || 't1@example.com'); await T.fill('input[type=password]', process.env.E2E_PASSWORD || 'pass'); await T.click('button[type=submit]');
    }
    await reveal(0);
    await T.waitForSelector('.genre-pick', { timeout: 15000 });
    ok(await until(async () => (await visual(T, '.previews'))?.loaded, 25000), `教師預覽：自己的圖片請求失敗後自行恢復（教師端請求 ${timg.count(/^fantasy-portrait/)} 次）`);
    ok(await until(async () => (await visual(P))?.loaded && (await visual(P)).src.startsWith('fantasy-portrait'), 15000), '投影不受教師端的失敗影響');
    await tc.close();

    // 8. 教師平板的預覽重試按鈕
    for (const [w, hgt] of [[1366, 1024], [1024, 768]]) {
      const kc = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: true });
      const kimg = await imageControl(kc);
      kimg.rule = (f) => (f.startsWith('detective-portrait') ? '404' : 'ok');
      const K = await kc.newPage();
      await K.goto(`${BASE}/teacher.html#/s/${SID}`);
      await K.waitForSelector('input[type=email], .genre-pick', { timeout: 15000 });
      if (await K.locator('input[type=email]').count()) {
        await K.fill('input[type=email]', process.env.E2E_EMAIL || 't1@example.com'); await K.fill('input[type=password]', process.env.E2E_PASSWORD || 'pass'); await K.click('button[type=submit]');
      }
      const pBefore = img.count(/^detective-portrait/);
      await reveal(1);
      await K.waitForSelector('.genre-pick', { timeout: 15000 });
      ok(await until(() => K.evaluate(() => !document.querySelector('.preview-img-retry').hidden), 15000), `${w}x${hgt} 教師平板：預覽圖片失敗時顯示「重新載入預覽圖片」`);
      await sleep(25000);   // 自動重試用完
      const m = await K.evaluate(() => {
        const b = document.querySelector('.preview-img-retry'); const r = b.getBoundingClientRect();
        const inner = [...document.querySelectorAll('.previews .st-visual-retry')].map((x) => getComputedStyle(x).display);
        return { coarse: matchMedia('(pointer: coarse)').matches, w: r.width, h: r.height, font: parseFloat(getComputedStyle(b).fontSize),
                 inView: r.top >= 0 && r.left >= 0 && r.right <= innerWidth, inner, failed: document.querySelectorAll('.previews .st-visual.failed').length };
      });
      ok(m.coarse && m.h >= 44 && m.w >= 44 && m.font >= 14 && m.inView && m.inner.every((d) => d === 'none'),
        `${w}x${hgt} 教師平板：按鈕 ${m.w.toFixed(0)}×${m.h.toFixed(0)}px、字級 ${m.font}px、在畫面內；預覽裡的小按鈕不顯示（${m.inner.join(',')}）`);
      await K.locator('.preview-img-retry').scrollIntoViewIfNeeded();
      const before = kimg.count(/^detective-portrait/);
      await K.tap('.preview-img-retry');
      await sleep(1500);
      ok(m.failed >= 1 && kimg.count(/^detective-portrait/) === before + m.failed, `${w}x${hgt} 教師平板：點一下每個失敗的預覽圖只多一個請求（失敗 ${m.failed} 個、多 ${kimg.count(/^detective-portrait/) - before} 次）`);
      ok(await until(() => K.evaluate(() => !document.querySelector('.preview-img-retry').hidden), 5000), `${w}x${hgt} 教師平板：仍失敗時按鈕維持顯示`);
      ok(img.count(/^detective-portrait/) - pBefore <= 1, `${w}x${hgt} 教師平板：投影端請求不受教師端重試影響（投影 ${img.count(/^detective-portrait/) - pBefore} 次）`);
      await kc.close();
    }
    await pc.close();
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n圖片失敗恢復：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
