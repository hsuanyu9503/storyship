// 小說類型圖片框：觸控重試按鈕尺寸（複檢 F1）與圖片框的確定清理（複檢 F2）
//   用真正的 render-projection.js 與 css/app.css 繪製（不需要資料庫）；需要 shim.js（或任何靜態伺服器）在 BASE 提供專案檔案。
//   A. 投影（1024×768、1600×900、1920×1080，觸控＝粗指標）：06 直式、07 橫式圖片永久失敗 →
//      「重新載入圖片」按鈕至少 44×44px、字級 ≥ 15px、完整落在圖片框與投影範圍內；自動重試用完後點一下只多一個請求。
//   B. 清理：同一個 JavaScript 工作內連續重繪 20 次再切到沒有圖片的畫面 → 不再建立新圖片框的情況下，6 秒內全部釋放
//      （ResizeObserver 都 disconnect、保留的圖片框數＝0）；建立後從未掛上畫面的圖片框；移除時圖片請求尚未完成的圖片框。
//   教師端縮小預覽的按鈕在 genre_image_retry.js 用真正的教師主控台驗證。
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const genre06 = (slug, name) => ({ screen: 'genre', view: 'genre', index: 0, total: 5,
  genre: { name, visual_url: `assets/genres/${slug}-portrait.webp`, visual_source: 'portrait', elements: ['一', '二', '三'].map((label) => ({ label, icon: '' })) } });
const TITLES = ['小紅帽與森林裡的大野狼', '會說話的魔法掃帚', '博物館失竊的寶物之謎', '沙漠探險隊與綠洲', '古代皇宮裡的小書僮', '月亮上的兔子工廠'];
const match = (slug, name, cards) => ({ screen: 'match', title: '小小故事分類師', group: { group: '第 1 組', number: 1, kind: 'submitted', complete: true },
  category: { label: '勇敢的主角', unnamed: false, cards: TITLES.slice(0, cards).map((t) => ({ title: t, image_url: null, tracked: false })), reason_state: 'shown', reason: '主角都很勇敢，最後都解決了問題。' },
  genre: { name, visual_url: `assets/genres/${slug}-landscape.webp`, visual_source: 'landscape', elements: [0, 1, 2].map((i) => ({ slot: i, revealed: true, label: '特色' + i, icon: '', highlight: false })) },
  scaffold: true });

async function control(ctx) {
  const c = { reqs: [], mode: '404', hold: null };
  await ctx.route('**/assets/genres/*.webp', async (route) => {
    c.reqs.push(route.request().url().replace(/^.*\/assets\/genres\//, ''));
    if (c.hold) await c.hold;
    if (c.mode === '404') return route.fulfill({ status: 404, body: 'not found' });
    return route.continue().catch(() => {});
  });
  c.count = (re) => c.reqs.filter((f) => re.test(f)).length;
  return c;
}
const roInit = () => {
  const RO = window.ResizeObserver; window.__ro = { created: 0, disconnected: 0 };
  window.ResizeObserver = class extends RO {
    constructor(cb) { super(cb); window.__ro.created++; }
    disconnect() { window.__ro.disconnected++; return super.disconnect(); }
  };
};
// 在頁面中繪製一個投影畫面（取代整個 body）
const show = (page, projection) => page.evaluate(async (projection) => {
  const { renderProjection } = await import('/js/lib/render-projection.js');
  const wrap = document.createElement('div'); wrap.className = 'stage-wrap';
  wrap.append(renderProjection({ projection, status: 'active' }, { showQr: false }));
  document.body.replaceChildren(wrap);
}, projection);

(async () => {
  const browser = await chromium.launch();
  try {
    // ---------- A. 投影上的觸控重試按鈕 ----------
    for (const [w, hgt] of [[1024, 768], [1600, 900], [1920, 1080]]) {
      for (const [label, proj, re] of [['06 直式', genre06('historical', '歷史'), /^historical-portrait/], ['07 橫式（6 張故事）', match('detective', '偵探', 6), /^detective-landscape/]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: true });
        const img = await control(ctx);
        const page = await ctx.newPage();
        await page.clock.install();
        await page.goto(BASE + '/projector.html');
        ok(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), `${w}x${hgt} ${label}：模擬觸控（粗指標）`);
        await show(page, proj);
        await page.waitForSelector('.st-visual.failed .st-visual-retry', { timeout: 10000 });
        // 自動重試用完（2＋6＋15 秒）
        for (let i = 0; i < 6; i++) { await page.clock.fastForward(8000); await sleep(400); }
        const before = img.count(re);
        const m = await page.evaluate(() => {
          const b = document.querySelector('.st-visual-retry'); const r = b.getBoundingClientRect();
          const v = b.closest('.st-visual').getBoundingClientRect(); const s = document.querySelector('.stage').getBoundingClientRect();
          const inside = (o) => r.top >= o.top - 0.5 && r.bottom <= o.bottom + 0.5 && r.left >= o.left - 0.5 && r.right <= o.right + 0.5;
          const cs = getComputedStyle(b);
          return { w: r.width, h: r.height, font: parseFloat(cs.fontSize), visible: cs.display !== 'none' && cs.visibility !== 'hidden', inBox: inside(v), inStage: inside(s),
                   box: `${Math.round(v.width)}×${Math.round(v.height)}` };
        });
        ok(m.visible && m.h >= 44 && m.w >= 44 && m.font >= 15 && m.inBox && m.inStage,
          `${w}x${hgt} ${label}：按鈕 ${m.w.toFixed(1)}×${m.h.toFixed(1)}px、字級 ${m.font}px、完整在圖片框（${m.box}）與投影範圍內`);
        ok(before >= 4 && before <= 6, `${w}x${hgt} ${label}：自動重試用完（共 ${before} 次請求）`);
        await page.tap('.st-visual-retry');
        await sleep(1500);
        ok(img.count(re) === before + 1, `${w}x${hgt} ${label}：點一下只多一個請求（${img.count(re) - before}）`);
        await ctx.close();
      }
    }

    // ---------- B. 圖片框的確定清理 ----------
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await ctx.addInitScript(roInit);
    const img = await control(ctx);
    img.mode = 'ok';
    const page = await ctx.newPage();
    await page.goto(BASE + '/projector.html');
    const state = () => page.evaluate(async () => {
      const { visualBoxCount } = await import('/js/lib/render-projection.js');
      return { ...window.__ro, kept: visualBoxCount(), onScreen: document.querySelectorAll('.st-visual').length };
    });

    // B1. 同一個工作內連續重繪 20 次，最後切到沒有圖片的畫面
    await page.evaluate(async () => {
      const { renderProjection } = await import('/js/lib/render-projection.js');
      const wrap = document.createElement('div'); wrap.className = 'stage-wrap'; document.body.replaceChildren(wrap);
      const SL = ['fantasy', 'detective', 'historical', 'adventure', 'wuxia'];
      for (let i = 0; i < 20; i++) {
        wrap.replaceChildren(renderProjection({ projection: { screen: 'genre', view: 'genre', index: i % 5, total: 5,
          genre: { name: SL[i % 5], visual_url: `assets/genres/${SL[i % 5]}-portrait.webp`, visual_source: 'portrait', elements: [] } }, status: 'active' }, { showQr: false }));
      }
      wrap.replaceChildren(renderProjection({ projection: { screen: 'placeholder', title: '等待' }, status: 'active' }, { showQr: false }));
    });
    const s0 = await state();
    ok(s0.created === 20 && s0.kept === 20, `快速重繪：建立 20 個圖片框（ResizeObserver ${s0.created}、保留 ${s0.kept}）`);
    await sleep(7000);
    const s1 = await state();
    ok(s1.onScreen === 0 && s1.kept === 0 && s1.disconnected === s1.created,
      `快速重繪後停在沒有圖片的畫面：7 秒內全部釋放（建立 ${s1.created}、disconnect ${s1.disconnected}、保留 ${s1.kept}）`);
    ok(img.reqs.length === 0, `快速重繪：被取代的圖片框沒有發出請求（${img.reqs.length} 次）`);

    // B2. 建立後從未掛上畫面
    await page.evaluate(async () => {
      const { renderProjection } = await import('/js/lib/render-projection.js');
      window.__orphan = renderProjection({ projection: { screen: 'genre', view: 'genre', index: 0, total: 5,
        genre: { name: '奇幻', visual_url: 'assets/genres/fantasy-portrait.webp', visual_source: 'portrait', elements: [] } }, status: 'active' }, { showQr: false });
    });
    const s2 = await state();
    ok(s2.kept === 1, '從未掛上畫面：建立時保留 1 個（寬限期內）');
    await sleep(7000);
    const s3 = await state();
    ok(s3.kept === 0 && s3.disconnected === s3.created && img.reqs.length === 0, `從未掛上畫面：寬限期後釋放、沒有請求（保留 ${s3.kept}、請求 ${img.reqs.length}）`);
    await page.evaluate(() => { window.__orphan = null; });

    // B3. 移除時圖片請求尚未完成
    let release; img.hold = new Promise((r) => { release = r; });
    await show(page, genre06('wuxia', '武俠'));
    await page.waitForFunction(() => document.querySelector('.st-visual img'), null, { timeout: 5000 });
    ok(img.count(/^wuxia-portrait/) === 1, '請求中移除：已送出圖片請求');
    await show(page, { screen: 'placeholder', title: '等待' });
    release(); img.hold = null;
    await sleep(7000);
    const s4 = await state();
    ok(s4.kept === 0 && s4.disconnected === s4.created, `請求中移除：釋放（建立 ${s4.created}、disconnect ${s4.disconnected}、保留 ${s4.kept}）`);
    img.mode = '404';
    // 同一情境、請求失敗：已移除的框不再重試
    img.hold = new Promise((r) => { release = r; });
    await show(page, genre06('adventure', '冒險'));
    await page.waitForFunction(() => document.querySelector('.st-visual img'), null, { timeout: 5000 });
    await show(page, { screen: 'placeholder', title: '等待' });
    release(); img.hold = null;
    await sleep(9000);
    const s5 = await state();
    ok(img.count(/^adventure-portrait/) === 1 && s5.kept === 0, `請求中移除且請求失敗：不再重試（${img.count(/^adventure-portrait/)} 次）、已釋放（保留 ${s5.kept}）`);
    await ctx.close();
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await browser.close();
  console.log(`\n圖片框生命週期：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
