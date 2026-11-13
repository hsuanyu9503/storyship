// Phase 5：觸控與投影驗收（瀏覽器模擬，不是實體裝置）
//   教師平板（iPad 橫向／直向，觸控）：05、07 的公開、放棄變更、翻頁、每頁分類數、放大此側都能以 tap 操作，
//     控制項可見、沒有被其他元素蓋住（點擊位置的元素就是該控制項）、不依賴 hover，量測觸控目標大小。
//   學生平板／手機（觸控）：觸控捲動不會誤移故事、點選移動、模擬螢幕鍵盤（視窗變矮）時輸入框仍可見、
//     重複點擊「完成」只送出一次、斷線後恢復自動補存。
//   16:9 投影：以真實流程建立合法上限內容（分類名稱 30 字、理由 300 字、8 張故事、6 個分類），
//     量測投影是否裁切；教師端預覽的「放不下」提醒與實際投影一致；改用放大此側＋每頁 1 類後完整可見。
// 需要 shim.js（或 tests/supabase 的真實堆疊：設定 BASE、E2E_EMAIL、E2E_PASSWORD、DATABASE_URL）。
const { chromium, devices } = require('playwright');
const { Pool } = require('pg');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8787';
const T_EMAIL = process.env.E2E_EMAIL || 't1@example.com';
const T_PASS = process.env.E2E_PASSWORD || 'pass';
const OUT = path.join(__dirname, '.cache/shots');
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_e2e' });
let passed = 0; const fails = []; const notes = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const note = (m) => { notes.push(m); console.log('  note -', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 12000) => { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(150); } return false; };
const NAME30 = '主角都很勇敢而且最後都學到一件很重要的事情的那一類好聽的故事們'.slice(0, 30);
const REASON300 = ('這些故事的主角一開始都遇到困難，後來靠著自己的勇氣和朋友的幫忙解決問題，最後都學到了重要的道理，所以我們把它們分在一起。').repeat(6).slice(0, 300);

let ANON = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const rev = async (sid) => (await pg.query('select rev from public.session_state where session_id = $1', [sid])).rows[0].rev;

// 觸控控制項檢查：捲到可見 → 中心點的元素就是它（沒有被蓋住）→ 回傳大小
async function touchTarget(page, loc, label) {
  let r;
  for (let i = 0; i < 5; i++) {   // 面板會因輪詢重畫：元素被替換時重試
    try { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }); r = await measure(loc); break; } catch (e) { if (i === 4) throw e; await sleep(300); }
  }
  ok(r.inView && r.hit, `${label}：可見且沒有被遮住（${r.w}×${r.h}px）`);
  if (Math.min(r.w, r.h) < 44) note(`${label} 觸控目標較小：${r.w}×${r.h}px（建議至少 44px）`);
  return r;
}
async function measure(loc) {
  return loc.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { w: Math.round(b.width), h: Math.round(b.height), inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth,
             hit: Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el) && hit.tagName === 'LABEL')) };
  });
}
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const tok = await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: T_EMAIL, password: T_PASS }) })).json();
    const TT = tok.access_token;
    const cr = await api('teacher_create_session', { p_title: '觸控驗收', p_group_count: 2 }, TT);
    const SID = cr.session_id; const CODE = cr.join_code;
    const pk = (await pg.query('select projector_key from public.sessions where id = $1', [SID])).rows[0].projector_key;
    const stage = async (phase, proj, lock = true) => {
      const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: await rev(SID), p_lock_unsubmitted: lock }, TT);
      if (!r.ok) throw new Error('stage ' + phase + ' ' + JSON.stringify(r));
    };
    const cards = (await pg.query(`select id, title from public.story_cards where content_set_id = (select content_set_id from public.sessions where id = $1) order by sort_order`, [SID])).rows;

    // ---------- 學生：觸控裝置以 UI 加入 ----------
    const studentDevs = [['iPad Mini', 1], ['iPad Mini landscape', 1], ['Pixel 7', 2]];
    const S = [];
    for (const [dev, g] of studentDevs) {
      const c = await browser.newContext({ ...devices[dev] });
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(dev + ': ' + e.message));
      await p.goto(`${BASE}/join.html?code=${CODE}`);
      await p.waitForSelector('.s-group');
      await p.locator(`.s-group:has(.n:text-is("${g}"))`).tap();
      await p.locator('dialog button:has-text("確認加入")').tap();
      await p.waitForFunction((n) => document.body.innerText.includes('已加入第 ' + n + ' 組'), g, { timeout: 12000 });
      const token = await p.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('sf.token.'))?.[1]?.replace(/"/g, ''));
      S.push({ dev, g, c, p, token });
    }
    ok(S.every((x) => /^[0-9a-f]{32,}$/.test(x.token || '')), '學生以觸控裝置（iPad Mini 直／橫、Pixel 7）點選加入組別');

    // ---------- 03：觸控捲動、點選移動、螢幕鍵盤、重複點擊、斷線恢復 ----------
    await stage('03', { screen: 'instruction' }, false);
    const A = S[0].p;
    await A.waitForSelector('.sc-grip', { timeout: 15000 });
    ok(await noHScroll(A), '03（iPad Mini 直向）：沒有水平捲動');
    // 觸控捲動（Chromium 的觸控捲動手勢）：在手機上（內容比畫面長）捲動不會開啟移動列、不會移動故事
    const Ph = S[2].p;
    await Ph.waitForSelector('.sc-grip', { timeout: 15000 });
    const cdp = await Ph.context().newCDPSession(Ph);
    const sc0 = await Ph.evaluate(() => [scrollY, ...[...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollTop)].join());
    const start = await Ph.locator('.sc').nth(1).boundingBox();
    // 從故事卡上開始、往上滑 300px（真實的 touchstart／touchmove／touchend 事件）
    const sx = Math.round(start.x + start.width / 2); const sy = Math.round(start.y + start.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    const sc1 = await Ph.evaluate(() => [scrollY, ...[...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollTop)].join());
    ok(sc1 !== sc0, `03（Pixel 7）：觸控滑動可以捲動畫面（${sc0} → ${sc1}）`);
    ok(await Ph.locator('.bd-movebar:not([hidden])').count() === 0 && (await Ph.locator('.bd-cat .sc').count()) === 0, '03（Pixel 7）：從故事卡上開始滑動不會誤開移動列或移動故事');
    // 點選移動
    await A.locator('.bd-add').tap();
    await A.locator('.sc:has(.sc-title:text-is("' + cards[0].title + '")) .sc-grip').tap();
    await A.waitForSelector('.bd-movebar:not([hidden])');
    await A.locator('.bd-cat').first().locator('.bd-cat-head .bd-cat-n').tap();
    ok(await until(async () => (await A.locator('.bd-cat .sc').count()) === 1), '03：點選故事、再點分類即可移動（觸控）');
    // 螢幕鍵盤：點名稱欄、視窗變矮（模擬鍵盤佔掉下半部），輸入框仍在可見範圍
    await A.locator('.bd-cat').first().locator('.bd-name').tap();
    const vp = A.viewportSize();
    await A.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) });
    await sleep(500);
    const kb = await A.evaluate(() => { const e = document.activeElement; const b = e.getBoundingClientRect(); return { tag: e.className, top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight }; });
    ok(kb.tag.includes('bd-name') && kb.top >= 0 && kb.bottom <= kb.h, `03：模擬螢幕鍵盤（視窗高度 ${kb.h}px）時，正在輸入的名稱欄仍可見（${kb.top}–${kb.bottom}）`);
    await A.keyboard.type('touch-name');
    await A.setViewportSize(vp);
    await A.locator('.pb-title, h1, h2').first().tap().catch(() => {});
    // 斷線：移動後顯示「尚未儲存」，恢復後自動補存
    await A.context().setOffline(true);
    await A.locator('.sc:has(.sc-title:text-is("' + cards[1].title + '")) .sc-grip').tap();
    await A.locator('.bd-cat').first().locator('.bd-cat-head .bd-cat-n').tap();
    ok(await until(() => A.evaluate(() => document.body.innerText.includes('尚未儲存'))), '03：斷線時移動，畫面標示「尚未儲存」');
    await A.context().setOffline(false);
    ok(await until(async () => {
      const r = (await pg.query(`select data from public.personal_boards b join public.participants p on p.id = b.participant_id where p.session_id = $1 and p.group_id = (select id from public.groups where session_id = $1 and number = 1) order by b.updated_at desc limit 1`, [SID])).rows[0];
      return r && Object.keys(r.data.placements || {}).length === 2;
    }, 25000), '03：網路恢復後自動補存到伺服器');
    // 其餘故事以 API 放好（加快）；學生端重新整理後以觸控「重複點擊」完成
    const personal = await api('student_personal', { p_session: SID, p_token: S[0].token });
    const full = { categories: [{ id: 'c1', no: 1, name: 'touch-name', reason: '' }], placements: Object.fromEntries(cards.map((c) => [c.id, 'c1'])) };
    await api('student_save_personal', { p_session: SID, p_token: S[0].token, p_data: full, p_expected_rev: personal.rev });
    await A.reload();
    await A.waitForSelector('.pb-done');
    let submits = 0;
    A.on('request', (r) => { if (r.url().includes('/rpc/student_submit_personal')) submits++; });
    await A.locator('.pb-done').tap(); await A.locator('.pb-done').tap({ force: true }).catch(() => {}); await A.locator('.pb-done').tap({ force: true }).catch(() => {});
    ok(await until(() => A.evaluate(() => document.body.innerText.includes('已完成個人分類'))), '03：完成個人分類');
    await sleep(800);
    ok(submits === 1, `03：快速連點三次「完成」只送出一次（${submits} 次）`);
    await A.screenshot({ path: path.join(OUT, 'touch-s03-ipadmini.png') });

    // ---------- 04：小組內容（合法上限）以 API 建立；學生端觸控檢查 ----------
    await stage('04', { screen: 'instruction' }, false);
    const g1 = [S[0], S[1]]; const g2 = S[2];
    const catIds = [];
    for (let i = 0; i < 6; i++) {
      const id = `7c000000-0000-4000-8000-00000000000${i + 1}`; catIds.push(id);
      await api('group_add_category', { p_session: SID, p_token: g1[0].token, p_category: id });
      await api('group_update_category', { p_session: SID, p_token: g1[1].token, p_category: id, p_field: 'name', p_value: (i + 1 + NAME30).slice(0, 30), p_expected_rev: 1 });
      await api('group_update_category', { p_session: SID, p_token: g1[1].token, p_category: id, p_field: 'reason', p_value: REASON300, p_expected_rev: 1 });
    }
    // 第 1 類放 3 張，其餘各 1 張（共 8 張）
    const where = [0, 0, 0, 1, 2, 3, 4, 5];
    for (let k = 0; k < cards.length; k++) await api('group_move_card', { p_session: SID, p_token: g1[0].token, p_card: cards[k].id, p_category: catIds[where[k]], p_expected_rev: 0 });
    const G = '.gw-main';
    const B = S[1].p;
    await B.waitForSelector(`${G} .bd-cat`, { timeout: 15000 });
    ok(await until(async () => (await B.locator(`${G} .bd-cat`).count()) === 6), '04（iPad Mini 橫向）：組員看到 6 個分類');
    ok(await noHScroll(B), '04：長名稱、長理由時沒有水平捲動');
    const reasonBox = B.locator(`${G} .bd-cat`).first().locator('.bd-reason');
    await reasonBox.tap();
    const vpB = B.viewportSize();
    await B.setViewportSize({ width: vpB.width, height: Math.round(vpB.height * 0.55) });
    await sleep(500);
    const kbB = await B.evaluate(() => { const e = document.activeElement; const b = e.getBoundingClientRect(); return { tag: e.className, top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight }; });
    ok(kbB.tag.includes('bd-reason') && kbB.top >= 0 && kbB.top < kbB.h, `04：模擬螢幕鍵盤時，正在輸入的理由欄仍可見（${kbB.top}–${kbB.bottom}／${kbB.h}）`);
    await B.setViewportSize(vpB);
    await B.locator(`${G} h2, ${G} h1`).first().tap().catch(() => {});
    await B.screenshot({ path: path.join(OUT, 'touch-s04-ipadmini-landscape.png') });
    const board = await api('student_group_board', { p_session: SID, p_token: g1[0].token });
    await api('group_submit', { p_session: SID, p_token: g1[0].token, p_expected_board_rev: board.board_rev });
    // 第 2 組：手機上點選移動一張故事
    const P = g2.p;
    await P.waitForSelector(`${G} .bd-add`, { timeout: 15000 });
    await P.locator(`${G} .bd-add`).tap();
    await until(async () => (await P.locator(`${G} .bd-cat`).count()) === 1);
    ok(await noHScroll(P), '04（Pixel 7）：手機寬度沒有水平捲動');
    await P.locator(`${G} .sc:has(.sc-title:text-is("${cards[0].title}")) .sc-grip`).tap();
    await P.locator(`${G} .bd-cat`).first().locator('.bd-cat-head .bd-cat-n').tap();
    ok(await until(async () => (await pg.query(`select count(*)::int n from public.group_placements gp join public.groups g on g.id = gp.group_id where g.session_id = $1 and g.number = 2 and gp.category_id is not null`, [SID])).rows[0].n === 1, 15000),
      '04（Pixel 7）：手機上點選移動故事，伺服器已保存');
    await stage('05', { screen: 'placeholder', title: '分類成果大公開' }, true);

    // ---------- 05：教師平板觸控 ----------
    const pc = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const proj = await pc.newPage();
    await proj.goto(`${BASE}/projector.html?s=${SID}&k=${pk}`);
    const projFits = () => proj.evaluate(() => {
      const st = document.querySelector('.stage'); if (!st) return null;
      return ![st, ...st.querySelectorAll('.st-cats, .st-side, .st-match-left, .st-match-right, .st-cmp-body, .st-match-body')].some((e) => e.scrollHeight > e.clientHeight + 2);
    });
    for (const [devName, orient] of [['iPad (gen 7) landscape', '橫向'], ['iPad (gen 7)', '直向']]) {
      const tc = await browser.newContext({ ...devices[devName] });
      const T = await tc.newPage();
      T.on('pageerror', (e) => errors.push('teacher ' + orient + ': ' + e.message));
      await T.goto(`${BASE}/teacher.html#/s/${SID}`);
      await T.waitForSelector('input[type=email], .rs-grid', { timeout: 15000 });
      if (await T.locator('input[type=email]').count()) {
        await T.locator('input[type=email]').tap(); await T.keyboard.type(T_EMAIL);
        await T.locator('input[type=password]').tap(); await T.keyboard.type(T_PASS);
        await T.locator('button[type=submit]').tap();
      }
      await T.waitForSelector('.rs-grid', { timeout: 15000 });
      ok(await noHScroll(T), `05 教師平板${orient}：沒有水平捲動`);
      const rg = (n) => T.locator(`.rs-group:has(b:text-is("第 ${n} 組"))`);
      if (orient === '橫向') {
        await touchTarget(T, rg(1).locator('button:has-text("放左側")'), `05 ${orient}「放左側」`);
        await rg(1).locator('button:has-text("放左側")').tap();
        await rg(2).locator('button:has-text("放右側")').tap();
        await T.locator('.rs-side').first().locator('button:has-text("全部揭露")').tap();
        await T.locator('.rs-side').nth(1).locator('button:has-text("全部揭露")').tap().catch(() => {});
      }
      const pub = T.locator('.rs-bar button.primary:has-text("公開到投影")').last();
      await until(async () => (await pub.isEnabled()));
      await touchTarget(T, pub, `05 ${orient}「公開到投影」`);
      if (orient === '橫向') {
        // 預設：雙組＋每頁 4 類＋全部揭露 300 字理由 → 教師預覽應提醒放不下
        const warn = await until(() => T.locator('.draft-wrap .rs-fit-warn').isVisible(), 6000);
        ok(warn, '05：上限內容（雙組、每頁 4 類、300 字理由）時，教師預覽顯示「投影放不下」提醒');
        await pub.tap();
        await until(async () => (await pg.query(`select projection ->> 'screen' s from public.session_state where session_id = $1`, [SID])).rows[0].s === 'compare', 12000);
        await sleep(3500);
        ok((await projFits()) === false, '05：未調整前投影確實放不下（提醒與實際投影一致）');
        // 翻頁
        const next = T.locator('.rs-side').first().locator('button.small:has-text("▶")');
        await touchTarget(T, next, `05 ${orient}「下一頁 ▶」`);
        await next.tap();
        ok(await until(async () => (await T.locator('.rs-side').first().textContent()).includes('2／2')), '05：觸控翻頁（第 2／2 頁）');
        // 放棄變更
        const discard = T.locator('button:has-text("放棄變更")').first();
        await touchTarget(T, discard, `05 ${orient}「放棄變更」`);
        await discard.tap();
        ok(await until(async () => (await T.locator('.rs-side').first().textContent()).includes('1／2')), '05：觸控「放棄變更」回到投影中的頁數');
        // 每頁 1 類＋放大此側
        await T.locator('.rs-side').first().locator('select.rs-per').selectOption('1');
        const zoom = T.locator('.rs-side').first().locator('button:has-text("放大此側")');
        await touchTarget(T, zoom, `05 ${orient}「放大此側」`);
        await zoom.tap();
        await until(async () => (await pub.isEnabled()) && !(await T.locator('.draft-wrap .rs-fit-warn').isVisible()), 8000);
        ok(!(await T.locator('.draft-wrap .rs-fit-warn').isVisible()), '05：放大此側＋每頁 1 類後預覽沒有提醒');
        await pub.tap();
        await until(async () => (await pg.query(`select projection ->> 'zoom' z from public.session_state where session_id = $1`, [SID])).rows[0].z === 'true', 12000);
        await sleep(3500);
        ok((await projFits()) === true, '05：16:9 投影（1920×1080）上限內容完整可見（放大此側＋每頁 1 類）');
        const fs = await proj.evaluate(() => Math.min(...[...document.querySelectorAll('.st-cat-reason, .st-chip-card')].map((e) => parseFloat(getComputedStyle(e).fontSize))));
        ok(fs >= 24, `05：投影最小字級 ${fs.toFixed(1)}px（1920 寬；未縮小字級）`);
        await proj.screenshot({ path: path.join(OUT, 'touch-p05-zoom.png') });
      } else {
        await touchTarget(T, T.locator('.rs-side').first().locator('button:has-text("取消放大")'), `05 ${orient}「取消放大」`);
        await touchTarget(T, T.locator('.rs-side').first().locator('select.rs-per'), `05 ${orient}「每頁」選單`);
      }
      await T.screenshot({ path: path.join(OUT, `touch-t05-${orient === '橫向' ? 'landscape' : 'portrait'}.png`) });
      await tc.close();
    }

    // ---------- 07：教師平板觸控、理由與 8 張故事 ----------
    await stage('06', { screen: 'genre', view: 'recap', items: [], ctl: { view: 'recap', index: 0 } }, true);
    await stage('07', { screen: 'placeholder', title: '小小故事分類師' }, true);
    const tc7 = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
    const T7 = await tc7.newPage();
    await T7.goto(`${BASE}/teacher.html#/s/${SID}`);
    await T7.waitForSelector('input[type=email], .genre-pick', { timeout: 15000 });
    if (await T7.locator('input[type=email]').count()) {
      await T7.locator('input[type=email]').tap(); await T7.keyboard.type(T_EMAIL);
      await T7.locator('input[type=password]').tap(); await T7.keyboard.type(T_PASS);
      await T7.locator('button[type=submit]').tap();
    }
    await T7.waitForSelector('.genre-pick', { timeout: 15000 });
    await T7.locator('.rs-side select').first().selectOption({ index: 1 });
    const firstCat = T7.locator('input[name=rs07cat]').first();
    await until(async () => (await firstCat.count()) > 0);
    await touchTarget(T7, T7.locator('label:has(input[name=rs07cat])').first(), '07 橫向「選分類」');
    await T7.locator('label:has(input[name=rs07cat])').first().tap();
    await T7.locator('label:has-text("一併顯示這一類的共同特色")').tap();
    const gbtn = T7.locator('button.genre-btn:has-text("2. 偵探")');
    await touchTarget(T7, gbtn, '07 橫向「選類型」');
    await gbtn.tap();
    const el0 = T7.locator('.rs-el').first().locator('label').first();
    await touchTarget(T7, el0, '07 橫向「揭露要素」');
    await el0.tap();
    const pub7 = T7.locator('.rs-bar button.primary:has-text("公開到投影")').last();
    await until(async () => pub7.isEnabled());
    await touchTarget(T7, pub7, '07 橫向「公開到投影」');
    await pub7.tap();
    await until(async () => (await pg.query(`select projection ->> 'screen' s from public.session_state where session_id = $1`, [SID])).rows[0].s === 'match', 12000);
    await sleep(3500);
    const p7 = await proj.evaluate(() => document.body.innerText);
    ok(p7.includes('共同特色') && p7.includes('離奇事件與謎團'), '07：投影顯示分類（3 張故事）、300 字共同特色、已揭露的要素');
    ok((await projFits()) === true, '07：16:9 投影上限內容（30 字名稱、300 字理由、句型鷹架）完整可見');
    await proj.screenshot({ path: path.join(OUT, 'touch-p07.png') });
    await T7.screenshot({ path: path.join(OUT, 'touch-t07-landscape.png') });

    ok(errors.length === 0, '沒有前端執行錯誤 ' + errors.join(' | '));
  } catch (e) {
    console.error(e.stack || e.message); fails.push('例外：' + e.message);
  } finally {
    await pg.end().catch(() => {});
    await browser.close();
    console.log(`\n觸控／投影：通過 ${passed} 項，失敗 ${fails.length} 項`);
    if (notes.length) { console.log('附註：'); notes.forEach((n) => console.log('  - ' + n)); }
    if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
  }
})();
