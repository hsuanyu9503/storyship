// 第 03／04 環節的故事卡與雙面閱讀卡（瀏覽器模擬：Playwright Chromium，不是實體平板）
//   需要：tests/e2e/setup_story_db.sh 建立的 sf_story（已套用 story_cards_v1.sql），以及在 BASE 上提供 sf_story 的 shim：
//     bash tests/e2e/setup_story_db.sh
//     (cd tests/e2e && PORT=8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node shim.js &)
//     BASE=http://localhost:8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node tests/e2e/story_reader.js
//   檢查：
//     1. 八張卡的編號、名稱、圖片、全文（段落）與元素逐一和 Word 原稿（docs/story-cards-source.json）相同（03 與 04 都檢查）
//     2. 開啟、翻面、捲動、翻回、關閉；再開啟預設正面；關閉後看板捲動位置與分類不變、焦點回到「閱讀」
//     3. 1366×1024、1024×768、768×1024（觸控）：字級 ≥18px、按鈕 ≥44×44 且可見未被遮住、卡片在視窗內、最長文案可讀完
//     4. 動畫中有 3D 翻轉、結束後回到平面（無鏡像、隱藏面不可見且 inert）；快速連點後狀態與畫面一致；減少動態效果時立即切換
//     5. 鍵盤：Enter 開啟、Tab 不離開對話框、隱藏面的按鈕不會被聚焦、Escape 關閉並還原焦點
//     6. 拖曳與點選移動不受閱讀影響；選取移動時點閱讀入口不會開啟閱讀卡
//     7. 04 兩位組員：一人翻面不改變另一人畫面，也沒有任何分類寫入請求或版本變化
//     8. 圖片：WebP；看板只下載 600w 縮圖、閱讀卡依寬度與像素比選擇；大圖失敗時保留名稱與描述並可重試；移除後不殘留
//     9. 07 投影的故事小卡用 600w 縮圖、完整呈現（contain）
const { chromium } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
const OUT = path.join(__dirname, '.cache/story');
fs.mkdirSync(OUT, { recursive: true });
const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/story-cards-source.json'), 'utf8'));
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(120); } return false; }
let ANON = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(fn + ': ' + t); return t ? JSON.parse(t) : null;
}
// 請求紀錄：寫入類 RPC 與圖片
const WRITES = /\/rpc\/(student_save_personal|student_submit_personal|group_add_category|group_move_card|group_update_category|group_delete_category|group_lock|group_submit)/;
function track(ctx) {
  const t = { writes: [], imgs: [] };
  ctx.on('request', (r) => {
    const u = r.url();
    if (WRITES.test(u)) t.writes.push(u.replace(/^.*\/rpc\//, ''));
    if (/\/assets\/stories\//.test(u)) t.imgs.push(u.replace(/^.*\/assets\/stories\//, ''));
  });
  return t;
}
const reader = (p) => p.evaluate(() => {
  const d = document.querySelector('dialog.reader[open]'); if (!d) return null;
  const card = d.querySelector('.sr-card'); const front = d.querySelector('.sr-front'); const back = d.querySelector('.sr-back');
  const vis = (f) => getComputedStyle(f).visibility !== 'hidden';
  const img = front.querySelector('.st-visual img');
  return { side: card.dataset.side, flat: card.classList.contains('flat'), frontInert: front.inert, backInert: back.inert,
    frontVis: vis(front), backVis: vis(back), frontAria: front.getAttribute('aria-hidden'), backAria: back.getAttribute('aria-hidden'),
    no: front.querySelector('.sr-no')?.textContent, title: front.querySelector('.sr-title')?.textContent, backNo: back.querySelector('.sr-no')?.textContent,
    backTitle: back.querySelector('.sr-title')?.textContent,
    paras: [...back.querySelectorAll('.sr-reading > p')].map((x) => x.textContent), tags: [...back.querySelectorAll('.sr-tags li')].map((x) => x.textContent),
    img: img ? { src: (img.currentSrc || '').replace(/^.*\/assets\/stories\//, ''), loaded: img.complete && img.naturalWidth > 0, fit: getComputedStyle(img).objectFit } : null,
    flipperT: getComputedStyle(d.querySelector('.sr-flipper')).transform, active: document.activeElement?.closest('.sr-face')?.className || document.activeElement?.className || '' };
});
// 量測：元素完整在視窗內、中心點沒有被蓋住
const geom = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map((el) => {
  const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return { w: b.width, h: b.height, inView: b.top >= -0.5 && b.left >= -0.5 && b.bottom <= innerHeight + 0.5 && b.right <= innerWidth + 0.5, hit: Boolean(hit && el.contains(hit)), text: el.textContent.trim() };
}), sel);
async function openReader(p, title) {
  await p.locator(`.sc:has(.sc-title:text-is("${title}")) .sc-read`).first().tap();
  await p.waitForSelector('dialog.reader[open]', { timeout: 5000 });
}
const flipBtn = (p) => p.locator('dialog.reader[open] .sr-face:not([inert]) .sr-flip');
async function flip(p) { await flipBtn(p).tap(); await until(async () => (await reader(p))?.flat, 3000); }
async function closeReader(p) { await p.locator('dialog.reader[open] .sr-close').tap(); await until(async () => (await p.locator('dialog.reader').count()) === 0, 3000); }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;
    const cr = await api('teacher_create_session', { p_title: '故事卡', p_group_count: 2 }, TT);
    const SID = cr.session_id;
    const pk = (await pg.query('select projector_key from public.sessions where id = $1', [SID])).rows[0].projector_key;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, proj, lock = false) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: lock }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    const join = async (ctx) => {
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${BASE}/join.html?code=${cr.join_code}`);
      await p.waitForSelector('.s-group'); await p.locator('.s-group:has(.n:text-is("1"))').tap(); await p.locator('dialog button:has-text("確認加入")').tap();
      await p.waitForFunction(() => document.body.innerText.includes('已加入第 1 組'), null, { timeout: 12000 });
      return p;
    };
    const ctxA = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true });
    const tA = track(ctxA);
    const A = await join(ctxA);
    const ctxB = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, deviceScaleFactor: 2 });
    const tB = track(ctxB);
    const B = await join(ctxB);
    await stage('03', { screen: 'instruction' });
    await A.waitForSelector('.sc-grip', { timeout: 15000 }); await B.waitForSelector('.sc-grip', { timeout: 15000 });
    await until(() => A.evaluate(() => [...document.querySelectorAll('.sc-img img')].filter((i) => i.complete && i.naturalWidth).length === 8), 15000);

    // ---------- 1. 看板小卡與八張卡的內容 ----------
    const board = await A.evaluate(() => [...document.querySelectorAll('.bd-left .sc')].map((s) => ({ no: s.querySelector('.sc-no')?.textContent, title: s.querySelector('.sc-title')?.textContent,
      open: s.querySelector('.sc-open')?.textContent, img: (s.querySelector('.sc-img img')?.currentSrc || '').replace(/^.*\/assets\/stories\//, '') })));
    ok(board.length === 8 && board.every((b, i) => b.no === SRC[i].no && b.title === SRC[i].title && b.open === '閱讀'),
      `03 看板：8 張小卡依序顯示編號、名稱與「閱讀」入口（${board.map((b) => b.no + b.title).join('、')}）`);
    ok(board.every((b, i) => b.img === `story-${SRC[i].no}-600w.webp`), `03 看板：縮圖都是 600w WebP（${[...new Set(board.map((b) => b.img.replace(/\d\d/, 'NN')))].join()}）`);
    ok(tA.imgs.every((f) => /-600w\.webp$/.test(f)), `03 看板：載入看板時沒有下載閱讀用大圖（${tA.imgs.length} 個請求，皆為 600w）`);
    ok(!(await A.textContent('.bd')).includes('動物方程市') && !(await A.textContent('.bd')).includes('故事 A'), '03 看板：沒有佔位標題或「動物方程市」');
    const w0 = tA.writes.length;
    for (let i = 0; i < 8; i++) {
      const c = SRC[i];
      await openReader(A, c.title);
      let r = await reader(A);
      ok(r.side === 'front' && r.flat && r.no === c.no && r.title === c.title && !r.frontInert && r.backInert && r.backAria === 'true' && !r.backVis,
        `${c.no} ${c.title}：預設正面（編號、名稱），背面隱藏且 inert`);
      await until(async () => (await reader(A))?.img?.loaded, 8000);
      r = await reader(A);
      ok(r.img?.loaded && /^story-\d\d(-600w)?\.webp$/.test(r.img.src) && r.img.src.startsWith(`story-${c.no}`) && r.img.fit === 'contain', `${c.no}：正面圖片完整呈現（${r.img?.src}、${r.img?.fit}）`);
      await flip(A);
      r = await reader(A);
      ok(r.side === 'back' && r.backNo === c.no && r.backTitle === c.title && r.frontInert && !r.backInert && !r.frontVis && r.backVis,
        `${c.no}：翻面後只顯示背面（正面 inert、不可見）`);
      ok(JSON.stringify(r.paras) === JSON.stringify(c.paragraphs), `${c.no}：故事介紹 ${r.paras.length} 段，與原稿逐字相同`);
      ok(JSON.stringify(r.tags) === JSON.stringify(c.elements), `${c.no}：故事元素與原稿相同（${r.tags.join('／')}）`);
      await flip(A);
      ok((await reader(A)).side === 'front', `${c.no}：翻回圖片`);
      await closeReader(A);
      const f = await A.evaluate(() => document.activeElement?.closest('.sc')?.querySelector('.sc-title')?.textContent);
      ok(f === c.title, `${c.no}：關閉後焦點回到該張的「閱讀」（${f}）`);
    }
    ok(tA.writes.length === w0 && (await A.textContent('.bd-count')) === '已分類 0 / 8', `閱讀、翻面、關閉都沒有送出寫入請求（${tA.writes.length - w0}）、分類不變`);
    await openReader(A, SRC[3].title); await flip(A); await closeReader(A);
    await openReader(A, SRC[3].title);
    ok((await reader(A)).side === 'front', '再次開啟同一張：回到正面');
    await closeReader(A);

    // ---------- 3. 三種尺寸：字級、按鈕、溢出、最長文案 ----------
    const longest = SRC.reduce((a, c) => (c.paragraphs.join('').length > a.paragraphs.join('').length ? c : a), SRC[0]);
    for (const [w, hh] of [[1366, 1024], [1024, 768], [768, 1024]]) {
      await A.setViewportSize({ width: w, height: hh }); await sleep(300);
      // 看板捲到中間（可捲動時），從那裡開啟最後一張故事
      const sc0 = await A.evaluate(() => { const s = document.querySelector('.bd-left .bd-scroll'); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight }; });
      await openReader(A, longest.title);
      await A.screenshot({ path: path.join(OUT, `front-${w}x${hh}.png`) });
      const fb = await geom(A, 'dialog.reader[open] .sr-front .sr-flip, dialog.reader[open] .sr-close');
      ok(fb.length === 2 && fb.every((b) => b.w >= 44 && b.h >= 44 && b.inView && b.hit), `${w}x${hh} 正面：翻面與關閉按鈕 ≥44px、可見未被遮住（${fb.map((b) => `${Math.round(b.w)}×${Math.round(b.h)}`).join('、')}）`);
      await flip(A);
      const m = await A.evaluate(() => {
        const d = document.querySelector('dialog.reader[open]'); const face = d.querySelector('.sr-back').getBoundingClientRect();
        const rd = d.querySelector('.sr-reading'); const ps = [...rd.querySelectorAll('p')];
        return { font: Math.min(...ps.map((p) => parseFloat(getComputedStyle(p).fontSize))), tagFont: Math.min(...[...rd.querySelectorAll('li')].map((x) => parseFloat(getComputedStyle(x).fontSize))),
          face: { top: face.top, bottom: face.bottom, left: face.left, right: face.right }, vw: innerWidth, vh: innerHeight,
          hscroll: d.scrollWidth > d.clientWidth + 1 || rd.scrollWidth > rd.clientWidth + 1, scrollable: rd.scrollHeight > rd.clientHeight + 1 };
      });
      ok(m.font >= 18 && m.tagFont >= 16, `${w}x${hh} 背面：內文 ${m.font}px、元素 ${m.tagFont}px（不縮小字級）`);
      ok(m.face.top >= 0 && m.face.left >= 0 && m.face.bottom <= m.vh && m.face.right <= m.vw && !m.hscroll, `${w}x${hh} 背面：卡片完整在視窗內、沒有水平溢出`);
      // 捲到最後：最後一個元素可見、翻回與關閉按鈕仍可見
      await A.evaluate(() => { const rd = document.querySelector('dialog.reader[open] .sr-reading'); rd.scrollTop = rd.scrollHeight; });
      await sleep(150);
      const end = await A.evaluate(() => {
        const rd = document.querySelector('dialog.reader[open] .sr-reading'); const r = rd.getBoundingClientRect();
        const last = [...rd.querySelectorAll('li')].pop().getBoundingClientRect();
        return { lastVisible: last.top >= r.top - 1 && last.bottom <= r.bottom + 1, atEnd: rd.scrollTop + rd.clientHeight >= rd.scrollHeight - 1 };
      });
      const bb = await geom(A, 'dialog.reader[open] .sr-back .sr-flip, dialog.reader[open] .sr-close');
      ok(end.lastVisible && end.atEnd && bb.every((b) => b.w >= 44 && b.h >= 44 && b.inView && b.hit), `${w}x${hh} 最長文案（${longest.no} ${longest.title}）：可捲到最後一個元素${m.scrollable ? '（需要捲動）' : '（不需捲動）'}，翻回與關閉按鈕可見`);
      await A.evaluate(() => { document.querySelector('dialog.reader[open] .sr-reading').scrollTop = 0; });
      await A.screenshot({ path: path.join(OUT, `back-${w}x${hh}.png`) });
      await closeReader(A);
      const sc1 = await A.evaluate(() => document.querySelector('.bd-left .bd-scroll').scrollTop);
      ok(sc1 === sc0.top && (await A.evaluate(() => document.activeElement?.closest('.sc')?.querySelector('.sc-title')?.textContent)) === longest.title,
        `${w}x${hh} 關閉後看板捲動位置不變（${sc0.top} → ${sc1}，可捲動範圍 ${sc0.max}px）、焦點回到原卡`);
      await A.screenshot({ path: path.join(OUT, `board-03-${w}x${hh}.png`) });
    }
    await A.setViewportSize({ width: 1366, height: 1024 });

    // ---------- 4. 動畫、快速連點、減少動態效果 ----------
    await openReader(A, SRC[1].title);
    await flipBtn(A).tap();
    await sleep(160);
    const mid = await reader(A);
    await A.screenshot({ path: path.join(OUT, 'flip-mid.png') });
    ok(!mid.flat && mid.flipperT !== 'none', `翻面動畫進行中為 3D 旋轉（${mid.flipperT.slice(0, 24)}…）`);
    await until(async () => (await reader(A)).flat, 2000);
    const after = await reader(A);
    ok(after.flat && after.flipperT === 'none' && after.side === 'back' && !after.frontVis, '動畫結束後回到平面（沒有殘留旋轉，文字不鏡像）、正面不可見');
    const dur = await A.evaluate(() => getComputedStyle(document.querySelector('.sr-flipper')).transitionDuration);
    ok(/^0\.4s$/.test(dur) || dur === '0s', `翻面動畫時間（${dur}，平面狀態下為 0s）`);
    // 快速連點（同一位置連點 6 次，每次間隔 40ms）
    const fbBox = await flipBtn(A).boundingBox();
    for (let i = 0; i < 6; i++) { await A.mouse.click(fbBox.x + fbBox.width / 2, fbBox.y + fbBox.height / 2); await sleep(40); }
    await until(async () => (await reader(A)).flat, 3000);
    const rr = await reader(A);
    ok((rr.side === 'front' ? rr.frontVis && !rr.backVis && !rr.frontInert && rr.backInert : rr.backVis && !rr.frontVis && rr.backInert === false && rr.frontInert),
      `快速連點 6 次後狀態與畫面一致（目前 ${rr.side}，只有這一面可見且可操作）`);
    await closeReader(A);
    await A.emulateMedia({ reducedMotion: 'reduce' });
    const R = A;
    await openReader(R, SRC[0].title);
    await flipBtn(R).tap();
    const rm = await reader(R);
    const rmDur = await R.evaluate(() => getComputedStyle(document.querySelector('.sr-flipper')).transitionDuration);
    ok(rm.side === 'back' && rm.flat && rm.backVis && !rm.frontVis && rmDur === '0s', `減少動態效果：立即切換到背面（transition ${rmDur}）`);
    await closeReader(R);
    await A.emulateMedia({ reducedMotion: 'no-preference' });

    // ---------- 5. 鍵盤與焦點 ----------
    await A.locator(`.sc:has(.sc-title:text-is("${SRC[4].title}")) .sc-read`).focus();
    await A.keyboard.press('Enter');
    await A.waitForSelector('dialog.reader[open]');
    let k = await reader(A);
    ok(k.active.includes('sr-front') || (await A.evaluate(() => document.activeElement?.classList.contains('sr-flip'))), '鍵盤：Enter 開啟閱讀卡，焦點在「翻面閱讀」');
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await A.keyboard.press('Tab');
      seen.push(await A.evaluate(() => { const a = document.activeElement; return { inDlg: Boolean(a.closest('dialog.reader[open]')), inHidden: Boolean(a.closest('.sr-face[inert]')), t: a === document.body ? '(body)' : a.textContent.trim().slice(0, 6) }; }));
    }
    ok(seen.every((s) => s.inDlg && !s.inHidden), `鍵盤：Tab 循環都留在對話框內、不會進入隱藏的一面（${[...new Set(seen.map((s) => s.t))].join('／')}）`);
    await A.locator('dialog.reader[open] .sr-front .sr-flip').focus();
    await A.keyboard.press('Enter');
    await until(async () => (await reader(A)).flat, 2000);
    k = await reader(A);
    ok(k.side === 'back' && (await A.evaluate(() => document.activeElement?.textContent.includes('翻回圖片'))), '鍵盤：Enter 翻面後焦點移到「翻回圖片」');
    // 背面的閱讀區可用鍵盤捲動
    await A.locator('dialog.reader[open] .sr-reading').focus();
    await A.keyboard.press('End'); await sleep(200);
    ok(await A.evaluate(() => { const rd = document.querySelector('dialog.reader[open] .sr-reading'); return rd.scrollHeight <= rd.clientHeight + 1 || rd.scrollTop > 0; }), '鍵盤：閱讀區可聚焦並以鍵盤捲動');
    await A.keyboard.press('Escape');
    await until(async () => (await A.locator('dialog.reader').count()) === 0, 2000);
    ok((await A.evaluate(() => document.activeElement?.closest('.sc')?.querySelector('.sc-title')?.textContent)) === SRC[4].title, '鍵盤：Escape 關閉，焦點回到開啟它的「閱讀」');

    // ---------- 6. 移動與閱讀互不干擾 ----------
    await A.click('.bd-add');
    await A.waitForSelector('.bd-cat');
    await A.locator(`.sc:has(.sc-title:text-is("${SRC[0].title}")) .sc-grip`).tap();
    await A.waitForSelector('.bd-movebar:not([hidden])');
    await A.locator(`.bd-left .sc:has(.sc-title:text-is("${SRC[2].title}")) .sc-read`).tap({ force: true });
    await sleep(400);
    ok((await A.locator('dialog.reader[open]').count()) === 0, '選取移動時點另一張的閱讀入口：不開啟閱讀卡');
    ok((await A.locator('.bd-movebar:not([hidden])').count()) === 0 && (await A.textContent('.bd-count')) === '已分類 0 / 8', '（既有行為）選取中點「尚未分類」區內任一處＝放回尚未分類、取消選取');
    await A.locator(`.sc:has(.sc-title:text-is("${SRC[0].title}")) .sc-grip`).tap();
    await A.waitForSelector('.bd-movebar:not([hidden])');
    await A.locator('.bd-cat .bd-cat-n').first().tap();
    await until(async () => (await A.textContent('.bd-count')) === '已分類 1 / 8', 5000);
    ok((await A.textContent('.bd-cat')).includes(SRC[0].title), '點選移動：選取後點分類，故事移入');
    await openReader(A, SRC[0].title);   // 已分類的小卡也能閱讀
    await flip(A); await closeReader(A);
    ok((await A.textContent('.bd-count')) === '已分類 1 / 8' && (await A.locator('.bd-movebar:not([hidden])').count()) === 0, '閱讀已分類的故事不會觸發移動');
    // 觸控拖曳（把手）在閱讀後仍正常
    const cdp = await ctxA.newCDPSession(A);
    const from = await A.locator(`.sc:has(.sc-title:text-is("${SRC[5].title}")) .sc-grip`).boundingBox();
    const to = await A.locator('.bd-cat').first().boundingBox();
    const [x0, y0, x1, y1] = [from.x + from.width / 2, from.y + from.height / 2, to.x + to.width / 2, to.y + 30];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= 14; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 14, y: y0 + (y1 - y0) * i / 14 }] }); await sleep(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(async () => (await A.textContent('.bd-count')) === '已分類 2 / 8', 5000);
    ok((await A.textContent('.bd-cat')).includes(SRC[5].title) && (await A.locator('dialog.reader[open]').count()) === 0, '觸控拖曳把手：故事移入分類，不會開啟閱讀卡');
    await until(() => A.evaluate(() => !document.body.innerText.includes('儲存中')), 8000);

    // ---------- 7. 04：兩位組員 ----------
    await stage('04', { screen: 'instruction' }, true);
    const G = '.gw-main';
    await A.waitForSelector(`${G} .sc-read`, { timeout: 15000 }); await B.waitForSelector(`${G} .sc-read`, { timeout: 15000 });
    await sleep(1500);
    const gboard = await B.evaluate(() => [...document.querySelectorAll('.gw-main .sc')].map((s) => s.querySelector('.sc-no')?.textContent + s.querySelector('.sc-title')?.textContent));
    ok(gboard.join() === SRC.map((c) => c.no + c.title).join(), `04 小組看板：同一套八張小卡（${gboard.length} 張）`);
    const brev0 = (await pg.query("select board_rev from public.groups where session_id = $1 and number = 1", [SID])).rows[0].board_rev;
    const wa = tA.writes.length; const wb = tB.writes.length;
    await A.locator(`${G} .sc:has(.sc-title:text-is("${SRC[7].title}")) .sc-read`).tap();
    await A.waitForSelector('dialog.reader[open]');
    await flip(A);
    const ga = await reader(A);
    ok(ga.side === 'back' && JSON.stringify(ga.paras) === JSON.stringify(SRC[7].paragraphs) && JSON.stringify(ga.tags) === JSON.stringify(SRC[7].elements), '04：組員 A 開啟閱讀卡並翻到背面（內容與原稿相同）');
    await sleep(2500);   // 等過一次同步週期
    ok((await B.locator('dialog.reader').count()) === 0 && (await B.locator(`${G} .sc-selected`).count()) === 0, '04：組員 B 的畫面沒有開啟閱讀卡、沒有任何卡被翻面或選取');
    await B.locator(`${G} .sc:has(.sc-title:text-is("${SRC[2].title}")) .sc-read`).tap();
    await B.waitForSelector('dialog.reader[open]');
    ok((await reader(B)).side === 'front' && (await reader(A)).side === 'back', '04：兩人各自閱讀：B 是正面、A 仍是背面（互不影響）');
    await B.screenshot({ path: path.join(OUT, 'group-04-768x1024-front.png') });
    await closeReader(B);
    await A.evaluate(() => { const rd = document.querySelector('dialog.reader[open] .sr-reading'); rd.scrollTop = rd.scrollHeight; });
    await flip(A);
    ok((await reader(A)).side === 'front', '04：組員 A 捲動背面後翻回圖片');
    await closeReader(A);
    ok((await A.locator('dialog.reader').count()) === 0 && (await A.evaluate(() => document.activeElement?.closest('.sc')?.querySelector('.sc-title')?.textContent)) === SRC[7].title, '04：關閉後焦點回到該張的「閱讀」');
    const brev1 = (await pg.query("select board_rev from public.groups where session_id = $1 and number = 1", [SID])).rows[0].board_rev;
    ok(tA.writes.length === wa && tB.writes.length === wb && String(brev1) === String(brev0),
      `04：閱讀與翻面沒有送出分類寫入請求（A ${tA.writes.length - wa}、B ${tB.writes.length - wb}），小組版本不變（${brev0} → ${brev1}）`);
    await A.screenshot({ path: path.join(OUT, 'group-04-1366x1024.png') });
    // 像素比 2（iPad）：閱讀卡選用 1200 寬的閱讀圖，看板仍是 600w
    await B.locator(`${G} .sc:has(.sc-title:text-is("${SRC[3].title}")) .sc-read`).tap();
    await B.waitForSelector('dialog.reader[open]');
    await until(async () => (await reader(B))?.img?.loaded, 8000);
    const bi = (await reader(B)).img;
    ok(bi?.src === 'story-04.webp', `像素比 2：閱讀卡選用閱讀圖（${bi?.src}）`);
    const bigB = [...new Set(tB.imgs.filter((f) => !/-600w/.test(f)))].sort();
    ok(bigB.join() === 'story-03.webp,story-04.webp', `像素比 2：只下載 B 打開過的故事的大圖（${bigB.join() || '無'}；看板縮圖都是 600w）`);
    await closeReader(B);

    // ---------- 8. 圖片失敗與恢復、移除後不殘留 ----------
    const ctxF = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, storageState: await ctxA.storageState() });   // 同一位學生的另一個分頁
    let fail04 = true; const reqF = [];
    await ctxF.route('**/assets/stories/*.webp', (route) => {
      const f = route.request().url().replace(/^.*\/assets\/stories\//, ''); reqF.push(f);
      if (f === 'story-02-600w.webp') return route.fulfill({ status: 404, body: '' });
      if (/^story-04/.test(f) && fail04) return route.fulfill({ status: 404, body: '' });
      return route.continue();
    });
    await ctxF.addInitScript(() => {
      const RO = window.ResizeObserver; window.__ro = { c: 0, d: 0 };
      window.ResizeObserver = class extends RO { constructor(cb) { super(cb); window.__ro.c++; } disconnect() { window.__ro.d++; return super.disconnect(); } };
    });
    const F = await ctxF.newPage();
    await F.goto(A.url());
    await F.waitForSelector(`${G} .sc-read`, { timeout: 15000 });
    await until(() => F.evaluate(() => document.querySelectorAll('.gw-main .st-visual.failed').length >= 2), 10000);
    const tf = await F.evaluate(() => { const s = [...document.querySelectorAll('.gw-main .sc')].find((x) => x.querySelector('.sc-title').textContent === '鬼滅之刃');
      return { title: s.querySelector('.sc-title').textContent, alt: s.querySelector('.st-visual-alt')?.textContent, btn: s.querySelectorAll('.sc-img button').length }; });
    ok(tf.title === '鬼滅之刃' && tf.alt === '《鬼滅之刃》故事情境圖' && tf.btn === 0, `縮圖失敗：小卡保留名稱與替代文字（${tf.alt}），閱讀按鈕內不放巢狀按鈕`);
    const ro0 = await F.evaluate(() => ({ ...window.__ro }));
    const kept0 = await F.evaluate(async () => (await import('/js/lib/visual.js')).visualBoxCount());
    await F.locator(`${G} .sc:has(.sc-title:text-is("動物方城市")) .sc-read`).tap();
    await F.waitForSelector('dialog.reader[open] .sr-front .st-visual.failed', { timeout: 8000 });
    const fr = await F.evaluate(() => { const d = document.querySelector('dialog.reader[open]');
      return { title: d.querySelector('.sr-front .sr-title').textContent, alt: d.querySelector('.sr-front .st-visual-alt')?.textContent, btn: Boolean(d.querySelector('.sr-front .st-visual-retry')), flip: Boolean(d.querySelector('.sr-front .sr-flip')) }; });
    ok(fr.title === '動物方城市' && fr.alt === '《動物方城市》故事情境圖' && fr.btn && fr.flip, '閱讀圖失敗：保留名稱、替代文字、「重新載入圖片」與翻面按鈕');
    await F.screenshot({ path: path.join(OUT, 'image-failed-1024x768.png') });
    fail04 = false;
    const n04 = reqF.filter((f) => /^story-04/.test(f)).length;
    await F.locator('dialog.reader[open] .st-visual-retry').tap();
    ok(await until(() => F.evaluate(() => { const i = document.querySelector('dialog.reader[open] .sr-front .st-visual img'); return i && i.complete && i.naturalWidth > 0 && !i.closest('.st-visual').classList.contains('failed'); }), 6000),
      `按「重新載入圖片」後恢復（多 ${reqF.filter((f) => /^story-04/.test(f)).length - n04} 個請求）`);
    await closeReader(F);
    await sleep(7000);
    const kept1 = await F.evaluate(async () => (await import('/js/lib/visual.js')).visualBoxCount());
    const ro1 = await F.evaluate(() => ({ ...window.__ro }));
    ok(kept1 === kept0 && ro1.d - ro0.d >= 1, `關閉閱讀卡後圖片框釋放（保留 ${kept0} → ${kept1}，閱讀卡的 ResizeObserver 已 disconnect ${ro1.d - ro0.d} 個）`);
    const n02 = reqF.filter((f) => f === 'story-02-600w.webp').length;
    await sleep(2000);
    ok(n02 >= 2 && n02 <= 6, `縮圖失敗後有限次數自動重試（目前 ${n02} 次）`);
    await ctxF.close();

    // ---------- 9. 07 投影的故事小卡 ----------
    const P = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await P.goto(`${BASE}/projector.html?s=${SID}&k=${pk}`);
    const m7 = await P.evaluate(async () => {
      const { renderProjection } = await import('/js/lib/render-projection.js');
      const proj = { screen: 'match', title: '小小故事分類師', group: { group: '第 1 組', number: 1, kind: 'submitted', complete: true },
        category: { label: '勇敢', unnamed: false, cards: [{ title: '神奇柑仔店', image_url: 'assets/stories/story-01.webp' }, { title: '鬼滅之刃', image_url: 'assets/stories/story-02.webp' }], reason_state: 'hidden' },
        genre: null, scaffold: false };
      const wrap = document.createElement('div'); wrap.className = 'stage-wrap'; wrap.append(renderProjection({ projection: proj, status: 'active' }, { showQr: false }));
      document.body.replaceChildren(wrap);
      await new Promise((r) => setTimeout(r, 800));
      return [...document.querySelectorAll('img.st-match-img')].map((i) => ({ src: i.getAttribute('src'), fit: getComputedStyle(i).objectFit, loaded: i.naturalWidth > 0 }));
    });
    ok(m7.length === 2 && m7.every((x) => /-600w\.webp$/.test(x.src) && x.fit === 'contain' && x.loaded), `07 投影的故事小卡：600w 縮圖、完整呈現（${m7.map((x) => x.src + ' ' + x.fit).join('；')}）`);
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n故事卡與閱讀卡：通過 ${passed} 項，失敗 ${fails.length} 項（截圖：${OUT}）`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
