// 第 01 環節複查：鍵盤／簡報筆走完全程（P2）與快速雙點（風險 2）。從正常課程入口開始（教師登入 → 建立場次 → 開啟投影 → 啟動第一環節）。
//   需要：setup_story_db.sh 的 sf_story 與對應 shim（PORT=8789）。瀏覽器模擬，不是實體簡報筆或平板。
//   A. 只用 PageDown：開場 → 兩則故事（各三條線索＋公布）→ 比較 → 命名 → 轉場；在轉場頁再按一次 → 教師端與投影端都進入 02，且只切換一次
//   B. 另一個場次：只用 →（ArrowRight）走到轉場頁，再按一次 → 進入 02，只切換一次
//   C. 快速雙點：第一下「公布作品」完成並刷新後，在同一位置送出同一次雙點的第二下（距第一下 ≤ DOUBLE_MS）
//      → 只公布一次、停在揭曉頁；之後的有意操作（間隔 > 冷卻時間）仍可前進到神祕故事二
const { chromium } = require('playwright');
const { Pool } = require('pg');
const BASE = process.env.BASE || 'http://localhost:8789';
const T_EMAIL = process.env.E2E_EMAIL || 't1@example.com';
const T_PASS = process.env.E2E_PASSWORD || 'pass';
const DOUBLE_MS = Number(process.env.DOUBLE_MS || 300);   // 一般觸控雙點的兩下間隔上限
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(40); } return false; }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const T_ctx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true });
  const T = await T_ctx.newPage(); T.on('pageerror', (e) => errors.push('teacher: ' + e.message));
  await T.goto(BASE + '/teacher.html');
  await T.fill('input[type=email]', T_EMAIL); await T.fill('input[type=password]', T_PASS); await T.click('button[type=submit]');
  await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
  async function newSession() {
    if (!(await T.locator('text=建立（六組）').count())) { await T.goto(BASE + '/teacher.html'); await T.waitForFunction(() => document.body.innerText.includes('建立教學場次')); }
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    const code = (await T.textContent('.code b')).trim();
    const SID = (await pg.query('select id from public.sessions where join_code = $1', [code])).rows[0].id;
    const href = await T.getAttribute('a:has-text("開啟投影")', 'href');
    const P = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    P.on('pageerror', (e) => errors.push('projector: ' + e.message));
    await P.goto(href.startsWith('http') ? href : new URL(href, BASE + '/teacher.html').href);
    await P.waitForFunction(() => document.body.innerText.includes('各組加入狀態'));
    await T.click('text=啟動第一環節：走進故事世界 →');
    await until(() => P.evaluate(() => document.querySelector('.stage')?.dataset.screen === 'intro'));
    return { SID, P };
  }
  const state = async (SID) => (await pg.query('select phase, sub, rev, projection from public.session_state where session_id = $1', [SID])).rows[0];
  const phaseChanges = async (SID, since) => Number((await pg.query(
    "select count(*) from public.session_state where session_id = $1 and phase = '02'", [SID])).rows[0].count);
  const focusPage = async () => { await T.locator('h2').first().click(); };

  try {
    // ---------- A. 只用 PageDown ----------
    for (const [label, key] of [['PageDown', 'PageDown'], ['→', 'ArrowRight']]) {
      const { SID, P } = await newSession();
      const subs = [];
      await focusPage();
      let guard = 0;
      while ((await state(SID)).sub !== '01-05' && guard++ < 30) {
        const r0 = Number((await state(SID)).rev);
        await T.keyboard.press(key);
        await until(async () => Number((await state(SID)).rev) === r0 + 1, 8000);
        subs.push((await state(SID)).sub);
        await sleep(750);   // 冷卻（700ms）之後才按下一次：模擬老師看完畫面再按
      }
      const want = ['01-02', '01-02', '01-02', '01-02', '01-03', '01-02', '01-02', '01-02', '01-02', '01-03', '01-04', '01-04', '01-05'];
      ok(JSON.stringify(subs) === JSON.stringify(want), `只用 ${label}：開場 → 兩則故事各三條線索與公布 → 比較 → 命名 → 轉場（${subs.length} 步，每次一步）`);
      const before = await state(SID);
      await T.keyboard.press(key);
      ok(await until(async () => (await state(SID)).phase === '02', 8000), `轉場頁再按一次 ${label}：教師端送出進入 02`);
      ok(await until(() => P.evaluate(() => document.body.innerText.includes('仔細觀察故事的共同特色')), 10000), `轉場頁按 ${label}：投影端顯示 02「分類任務啟動」`);
      ok(await until(() => T.evaluate(() => document.body.innerText.includes('02｜分類任務啟動')), 8000), `轉場頁按 ${label}：教師端面板切換到 02`);
      // 只切換一次：再按一次（冷卻內與冷卻後）都不會再切換（02 不處理 01 的按鍵）
      const r1 = Number((await state(SID)).rev);
      await T.keyboard.press(key); await sleep(900); await T.keyboard.press(key); await sleep(900);
      const after = await state(SID);
      ok(after.phase === '02' && Number(after.rev) === r1 && Number(after.rev) === Number(before.rev) + 1,
        `轉場頁按 ${label}：只切換一次（版本 ${before.rev} → ${after.rev}，之後再按不會再變）`);
      await P.context().close();
    }

    // ---------- C. 快速雙點 ----------
    const { SID, P } = await newSession();
    const nextBtn = T.locator('.intro-next');
    const label = async () => (await nextBtn.innerText()).trim();
    // 走到神祕故事一的第三條線索（按鈕為「公布作品」）
    while ((await label()) !== '公布作品 →') {
      const r0 = Number((await state(SID)).rev);
      await nextBtn.tap();
      await until(async () => Number((await state(SID)).rev) === r0 + 1, 8000);
      await until(async () => (await label()) !== '', 2000);
      await sleep(750);
    }
    const box = await nextBtn.boundingBox();
    const x = box.x + box.width / 2; const y = box.y + box.height / 2;
    const r0 = Number((await state(SID)).rev);
    const t0 = Date.now();
    await T.touchscreen.tap(x, y);
    // 等第一下完成並刷新（教師端畫面已換成下一步的文字），再在同一位置送出第二下
    const refreshed = await until(async () => Number((await state(SID)).rev) === r0 + 1 && !(await label()).startsWith('公布作品'), 3000);
    const refreshMs = Date.now() - t0;
    const wait = Math.max(0, DOUBLE_MS - refreshMs - 20);
    await sleep(Math.min(wait, 60));
    const secondAt = Date.now() - t0;
    await T.touchscreen.tap(x, y);
    await sleep(1200);
    const st = await state(SID);
    const v = st.projection?.ctl || {};
    ok(refreshed && secondAt <= DOUBLE_MS,
      `快速雙點情境成立：第一下完成並刷新用了 ${refreshMs}ms，第二下在第一下之後 ${secondAt}ms 送出（雙點間隔上限 ${DOUBLE_MS}ms）`);
    ok(Number(st.rev) === r0 + 1 && v.view === 'story' && v.index === 0 && v.revealed === true,
      `快速雙點只公布一次、停在柯南的揭曉頁（版本 ${r0} → ${st.rev}；index ${v.index}、revealed ${v.revealed}）`);
    ok(await P.evaluate(() => document.body.innerText.includes('《名偵探柯南》')), '快速雙點後投影仍是《名偵探柯南》揭曉頁');
    // 之後的有意操作仍可前進
    await sleep(800);
    const r2 = Number((await state(SID)).rev);
    await nextBtn.tap();
    await until(async () => Number((await state(SID)).rev) === r2 + 1, 8000);
    const st2 = await state(SID);
    ok(st2.projection?.ctl?.index === 1 && st2.projection?.ctl?.clues === 0, `冷卻後（間隔約 ${800 + 1200}ms）有意的下一步仍可前進到神祕故事二`);
    // 鍵盤：前進後立刻再按（間隔 100ms）也只前進一步
    const r3 = Number((await state(SID)).rev);
    await sleep(800);
    await focusPage();
    await T.keyboard.press('PageDown'); await sleep(100); await T.keyboard.press('PageDown');
    await sleep(1200);
    ok(Number((await state(SID)).rev) === r3 + 1, `鍵盤連按兩下（間隔 100ms）只前進一步（版本 ${r3} → ${(await state(SID)).rev}）`);
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n01 鍵盤與快速雙點：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
