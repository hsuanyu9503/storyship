// 學生端「回到全螢幕」（瀏覽器模擬：Playwright Chromium headless 的 Fullscreen API；不是實體平板的系統手勢）
//   需要 shim（預設 sf_story：PORT 8789；佔位資料的 sf_e2e 也可）。
//   1. 首次進入：按「進入探索模式」→ 全螢幕、沒有提示
//   2. 03 分類中：放一張卡、開閱讀卡並翻到背面 → 退出全螢幕（document.exitFullscreen，等同 Esc）→ 提示與大按鈕出現在最上層（閱讀卡之上）
//      → 觸控按「回到全螢幕」→ 全螢幕、提示消失；分類、閱讀卡背面、頁面都沒有重新載入
//   3. 連續退出兩次：第二次再出現提示；用鍵盤（Tab 到按鈕＋Enter）回到全螢幕；滑鼠點擊也可
//   4. 請求失敗（瀏覽器拒絕）：顯示可理解的說明與「繼續活動」；按下後提示收起，學生仍可移動卡片
//   5. 裝置不支援全螢幕：顯示說明與「繼續活動」，活動照常
const { chromium } = require('playwright');
const { Pool } = require('pg');
const BASE = process.env.BASE || 'http://localhost:8789';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(100); } return false; }
let ANON = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(fn + ': ' + t); return t ? JSON.parse(t) : null;
}
const fs = (p) => p.evaluate(() => {
  const b = document.querySelector('.fsr-box');
  const shown = Boolean(b && !b.hidden && b.getBoundingClientRect().height > 0);
  let onTop = false;
  if (shown) { const btn = b.querySelector('.fsr-btn').getBoundingClientRect(); const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2); onTop = Boolean(hit && b.contains(hit)); }
  return { inFs: Boolean(document.fullscreenElement), shown, onTop, msg: b?.querySelector('.fsr-msg')?.textContent || '', btn: b?.querySelector('.fsr-btn')?.textContent || '',
    cont: Boolean(b && !b.querySelector('.fsr-continue').hidden), marker: window.__marker || null, focusInBanner: Boolean(b && b.contains(document.activeElement)) };
});

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;
    const cr = await api('teacher_create_session', { p_title: '全螢幕', p_group_count: 2 }, TT);
    const SID = cr.session_id;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, proj) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: false }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    async function student(init, group = 1) {
      const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
      if (init) await ctx.addInitScript(init);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${BASE}/join.html?code=${cr.join_code}`);
      await p.waitForSelector('.s-group'); await p.locator(`.s-group:has(.n:text-is("${group}"))`).tap(); await p.locator('dialog button:has-text("確認加入")').tap();
      await p.waitForFunction((g) => /已加入第 \d 組|已完成加入/.test(document.body.innerText) && document.body.innerText.includes('第 ' + g + ' 組'), group, { timeout: 12000 });
      return p;
    }
    await stage('02', { screen: 'task' });
    const A = await student();
    await A.waitForSelector('text=進入探索模式', { timeout: 15000 });
    await A.evaluate(() => { window.__marker = 'no-reload'; });

    // 1. 首次進入
    await A.locator('button:has-text("進入探索模式")').tap();
    ok(await until(async () => (await fs(A)).inFs), '首次進入：按「進入探索模式」後進入全螢幕');
    let s = await fs(A);
    ok(!s.shown, '首次進入：全螢幕時沒有提示');

    // 2. 03 分類中退出 → 回到全螢幕
    await stage('03', { screen: 'instruction' });
    await A.waitForSelector('.sc-grip', { timeout: 15000 });
    await A.locator('.bd-add').tap(); await A.waitForSelector('.bd-cat');
    await A.locator('.sc-grip').first().tap(); await A.waitForSelector('.bd-movebar:not([hidden])');
    await A.locator('.bd-cat .bd-cat-n').first().tap();
    await until(async () => (await A.textContent('.bd-count')).startsWith('已分類 1'), 6000);
    await A.locator('.bd-left .sc-read').first().tap(); await A.waitForSelector('dialog.reader[open]');
    await A.locator('dialog.reader[open] .sr-front .sr-flip').tap();
    await until(() => A.evaluate(() => document.querySelector('.sr-card')?.dataset.side === 'back' && document.querySelector('.sr-card').classList.contains('flat')), 3000);
    const before = await A.evaluate(() => ({ count: document.querySelector('.bd-count').textContent, side: document.querySelector('.sr-card').dataset.side,
      title: document.querySelector('.sr-back .sr-title').textContent, cats: [...document.querySelectorAll('.bd-cat .sc-title')].map((x) => x.textContent) }));
    ok((await fs(A)).inFs, '03：仍在全螢幕（閱讀卡已翻到背面、已放入一張卡）');
    await A.evaluate(() => document.exitFullscreen());   // 等同 Esc 或系統手勢退出
    ok(await until(async () => (await fs(A)).shown), '退出全螢幕：出現提示');
    s = await fs(A);
    ok(s.msg === '請回到全螢幕，繼續活動' && s.btn === '回到全螢幕' && !s.cont && s.onTop, `提示文字「${s.msg}」、大按鈕「${s.btn}」，顯示在閱讀卡之上且可點中`);
    ok(!s.focusInBanner, '提示出現時不搶走焦點');
    const g = await A.evaluate(() => { const r = document.querySelector('.fsr-btn').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    ok(g[0] >= 200 && g[1] >= 56, `「回到全螢幕」按鈕 ${g[0]}×${g[1]}px`);
    await A.screenshot({ path: __dirname + '/.cache/fullscreen-banner-1024x768.png' });
    await A.locator('.fsr-btn').tap();
    ok(await until(async () => (await fs(A)).inFs && !(await fs(A)).shown), '觸控按「回到全螢幕」→ 回到全螢幕、提示消失');
    const after = await A.evaluate(() => ({ count: document.querySelector('.bd-count').textContent, side: document.querySelector('.sr-card')?.dataset.side,
      title: document.querySelector('.sr-back .sr-title')?.textContent, cats: [...document.querySelectorAll('.bd-cat .sc-title')].map((x) => x.textContent) }));
    ok(JSON.stringify(after) === JSON.stringify(before) && (await fs(A)).marker === 'no-reload', `分類（${after.count}）、閱讀卡背面（${after.title}）都保留，頁面沒有重新載入`);

    // 3. 連續退出兩次；鍵盤與滑鼠
    await A.evaluate(() => document.exitFullscreen());
    ok(await until(async () => (await fs(A)).shown), '第二次退出：提示再次出現');
    await A.locator('.fsr-btn').focus();
    await A.keyboard.press('Enter');
    ok(await until(async () => (await fs(A)).inFs && !(await fs(A)).shown), '鍵盤（焦點在按鈕、Enter）回到全螢幕、提示消失');
    await A.evaluate(() => document.exitFullscreen());
    ok(await until(async () => (await fs(A)).shown), '第三次退出：提示再次出現');
    await A.locator('.fsr-btn').click();
    ok(await until(async () => (await fs(A)).inFs && !(await fs(A)).shown), '滑鼠點擊回到全螢幕');
    ok((await A.evaluate(() => document.querySelector('.sr-card')?.dataset.side)) === 'back' && (await fs(A)).marker === 'no-reload', '多次退出／返回後，閱讀卡仍是背面、頁面沒有重新載入');
    await A.locator('dialog.reader[open] .sr-close').tap();

    // 4. 請求失敗（瀏覽器拒絕）
    await stage('02', { screen: 'task' });
    const B = await student(() => {
      const deny = function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); };
      Element.prototype.requestFullscreen = deny;
    }, 2);
    await B.waitForSelector('text=進入探索模式', { timeout: 15000 });
    await B.locator('button:has-text("進入探索模式")').tap();
    ok(await until(async () => (await fs(B)).shown), '請求失敗：顯示提示');
    s = await fs(B);
    ok(s.msg.includes('瀏覽器沒有允許全螢幕') && s.btn === '再試一次' && s.cont, `請求失敗：說明「${s.msg}」、「再試一次」與「繼續活動」`);
    ok(await until(async () => (await B.innerText('body')).includes('已進入探索模式') && await B.evaluate(() => document.body.classList.contains('focus-mode'))), '請求失敗：仍進入探索模式（網站專注模式）');
    await B.screenshot({ path: __dirname + '/.cache/fullscreen-denied-1024x768.png' });
    await B.locator('.fsr-btn').tap();
    ok(await until(async () => (await fs(B)).shown && (await fs(B)).msg.includes('沒有允許')), '再試一次仍被拒絕：說明保留');
    await B.locator('.fsr-continue').tap();
    ok(await until(async () => !(await fs(B)).shown), '按「繼續活動」後提示收起');
    await stage('03', { screen: 'instruction' });
    await B.waitForSelector('.sc-grip', { timeout: 15000 });
    await B.locator('.bd-add').tap(); await B.waitForSelector('.bd-cat');
    await B.locator('.sc-grip').first().tap(); await B.locator('.bd-cat .bd-cat-n').first().tap();
    ok(await until(async () => (await B.textContent('.bd-count')).startsWith('已分類 1'), 6000) && !(await fs(B)).shown, '請求失敗後仍可繼續活動（移動卡片），提示不再出現');

    // 5. 裝置不支援
    await stage('02', { screen: 'task' });
    const C = await student(() => {
      delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen;
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    }, 2);
    await C.waitForSelector('text=進入探索模式', { timeout: 15000 });
    await C.locator('button:has-text("進入探索模式")').tap();
    ok(await until(async () => (await fs(C)).shown), '不支援全螢幕：顯示提示');
    s = await fs(C);
    ok(s.msg.includes('不支援全螢幕') && s.cont, `不支援全螢幕：說明「${s.msg}」與「繼續活動」`);
    await C.locator('.fsr-continue').click();
    ok(await until(async () => !(await fs(C)).shown) && (await C.innerText('body')).includes('已進入探索模式'), '不支援：按「繼續活動」後照常進行');
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n回到全螢幕：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
