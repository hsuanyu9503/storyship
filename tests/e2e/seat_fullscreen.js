// 座號加入、確認加入後進入全螢幕、全黑遮罩、打字與全螢幕（2026-11-26）
//   從正常學生入口（join.html?code=…）操作；教師端從正常教師入口登入並建立場次。
//   瀏覽器模擬：Playwright Chromium（headless）的 Fullscreen API、觸控模擬、CDP 的輸入法組字（Input.imeSetComposition）。
//   「Esc 或系統退出全螢幕」以 document.exitFullscreen() 模擬；虛擬鍵盤以 CDP 縮小可視區域模擬。不是實體平板。
//   需要：setup_story_db.sh 的 sf_story 與對應 shim（PORT=8789）。
const { chromium } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const SHOTS = process.env.SHOTS || path.join(__dirname, '.cache/seat-fullscreen');
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(80); } return false; }
let ANON = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) { const e = new Error(fn + ': ' + t); try { e.code = JSON.parse(t).message; } catch { /* */ } throw e; } return t ? JSON.parse(t) : null;
}
// 學生端狀態（遮罩、提示、全螢幕、焦點）
const st = (p) => p.evaluate(() => {
  const d = document.querySelector('dialog.fsx');
  const a = document.activeElement;
  return { inFs: Boolean(document.fullscreenElement), overlay: Boolean(d?.open), overlays: document.querySelectorAll('dialog.fsx').length,
    note: Boolean(document.querySelector('.fsx-note:not([hidden])')), info: Boolean(document.querySelector('.fsx-info:not([hidden])')),
    msg: d?.querySelector('.fsx-msg')?.textContent || '', btn: d?.querySelector('.fsx-btn')?.textContent || '',
    err: d && !d.querySelector('.fsx-err').hidden ? d.querySelector('.fsx-err').textContent : '',
    alt: Boolean(d && !d.querySelector('.fsx-alt').hidden), focusCls: a?.className || a?.tagName || '',
    value: a && 'value' in a ? a.value : null, caret: a && 'selectionStart' in a ? a.selectionStart : null,
    marker: window.__marker || null };
});
// 遮罩只顯示文字與按鈕、整個可視區域都被黑色遮住（四角與中央點到的都是遮罩）
const covered = (p) => p.evaluate(() => {
  const d = document.querySelector('dialog.fsx'); if (!d?.open) return false;
  const W = innerWidth; const H = innerHeight;
  const pts = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3], [W / 2, H * 0.15], [W / 2, H * 0.85]];
  const bg = getComputedStyle(d).backgroundColor;
  return pts.every(([x, y]) => d.contains(document.elementFromPoint(x, y))) && bg === 'rgb(0, 0, 0)';
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;

    // ---------- 教師端：正常入口登入並建立場次 ----------
    const Tctx = await browser.newContext({ viewport: { width: 1366, height: 1024 } });
    const T = await Tctx.newPage(); T.on('pageerror', (e) => errors.push('teacher: ' + e.message));
    await T.goto(BASE + '/teacher.html');
    await T.fill('input[type=email]', process.env.E2E_EMAIL || 't1@example.com'); await T.fill('input[type=password]', process.env.E2E_PASSWORD || 'pass');
    await T.click('button[type=submit]');
    await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    const CODE = (await T.textContent('.code b')).trim();
    const SID = (await pg.query('select id from public.sessions where join_code = $1', [CODE])).rows[0].id;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, proj) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: false }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    const seatOf = async (token) => (await pg.query("select seat_no from public.participants where session_id = $1 and token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex')", [SID, token])).rows[0]?.seat_no;
    const roster = () => T.evaluate(() => [...document.querySelectorAll('.roster-group')].map((g) => ({ g: g.querySelector('.roster-head b').textContent, seats: [...g.querySelectorAll('.seat')].map((x) => x.textContent) })));

    async function newStudent(init, vp = { width: 1024, height: 768 }) {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: true });
      if (init) await ctx.addInitScript(init);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push('student: ' + e.message));
      await p.goto(`${BASE}/join.html?code=${CODE}`);
      return p;
    }
    async function joinUI(p, seat, group) {
      await p.waitForSelector('.s-seat');
      await p.locator('.s-seat').fill(String(seat));
      await p.locator(`.s-group:has(.n:text-is("${group}"))`).tap();
      await p.locator('.s-join-go').tap();
      await p.locator('dialog.dialog button:has-text("確認加入")').tap();
    }
    const token = (p) => p.evaluate((c) => JSON.parse(localStorage.getItem('sf.token.' + c)), CODE);

    // ======================================================================
    // 1. 座號表單：必填、格式錯誤保留輸入與已選組別；加入 → 確認加入 → 全螢幕
    // ======================================================================
    const A = await newStudent();
    await A.waitForSelector('.s-seat');
    const seatAttrs = await A.evaluate(() => { const i = document.querySelector('.s-seat'); return { inputmode: i.inputMode, pattern: i.pattern, label: document.querySelector('label[for=seat]').textContent }; });
    ok(seatAttrs.inputmode === 'numeric' && seatAttrs.pattern === '[0-9]*' && seatAttrs.label.includes('座號'), `座號欄位：數字鍵盤提示（inputmode=${seatAttrs.inputmode}、pattern=${seatAttrs.pattern}）、標籤「${seatAttrs.label}」`);
    await A.locator('.s-join-go').tap();
    let errs = await A.evaluate(() => [...document.querySelectorAll('.s-field-error:not([hidden])')].map((e) => e.textContent));
    ok(errs.includes('請先輸入座號。') && errs.includes('請選擇你的組別。') && !(await A.locator('dialog.dialog').count()), `空白：顯示「${errs.join('」「')}」，沒有送出`);
    await A.screenshot({ path: path.join(SHOTS, 'join-errors-1024x768.png') });
    await A.locator(`.s-group:has(.n:text-is("2"))`).tap();
    await A.locator('.s-seat').fill('3a');
    await A.locator('.s-join-go').tap();
    let f = await A.evaluate(() => ({ seat: document.querySelector('.s-seat').value, g: [...document.querySelectorAll('.s-group[aria-pressed=true] .n')].map((x) => x.textContent),
      err: [...document.querySelectorAll('.s-field-error:not([hidden])')].map((e) => e.textContent), focus: document.activeElement?.id }));
    ok(f.seat === '3a' && f.g.join() === '2' && f.err.join() === '座號只能填數字，例如 5。' && f.focus === 'seat', `格式錯誤「3a」：訊息「${f.err}」，輸入內容與已選第 2 組保留，焦點回到座號`);
    ok(await A.getAttribute('.s-seat', 'maxlength') === '3', '座號欄位最多 3 位數（1～999）');
    for (const [v, want] of [['0', '座號請輸入 1～999 的整數，例如 5。'], ['00', '座號請輸入 1～999 的整數，例如 5。'], ['-3', '座號只能填數字，例如 5。'], ['5.', '座號只能填數字，例如 5。']]) {
      await A.locator('.s-seat').fill(v); await A.locator('.s-join-go').tap();
      const e = await A.evaluate(() => document.querySelector('.s-field-error:not([hidden])')?.textContent);
      ok(e === want, `座號「${v}」：${e}`);
    }
    await A.locator('.s-seat').fill('１２');   // 全形數字（中文輸入法）也接受
    await A.screenshot({ path: path.join(SHOTS, 'join-filled-1024x768.png') });
    await A.locator('.s-join-go').tap();
    await A.waitForSelector('dialog.dialog');
    const dlgText = await A.textContent('dialog.dialog');
    ok(dlgText.includes('確認加入第 2 組') && dlgText.includes('座號 12 號'), `確認視窗：「${dlgText.replace(/\s+/g, ' ').trim()}」`);
    await A.screenshot({ path: path.join(SHOTS, 'join-confirm-1024x768.png') });
    await A.locator('dialog.dialog button:has-text("確認加入")').tap();
    ok(await until(async () => (await st(A)).inFs), '按「確認加入」：進入全螢幕（同一次點擊請求）');
    ok(await until(() => A.evaluate(() => document.body.innerText.includes('第 2 組・12 號'))), '加入後：學生端顯示「第 2 組・12 號」');
    const tokA = await token(A);
    ok(await seatOf(tokA) === 12, '資料庫：座號 12 與學生紀錄一起保存');
    let s = await st(A);
    ok(s.inFs && !s.overlay, '全螢幕中沒有遮罩');

    // 同組第二位學生（座號 5），以及另一組
    const B = await newStudent(); await joinUI(B, 5, 2);
    await until(async () => (await st(B)).inFs);
    const C2 = await newStudent(); await joinUI(C2, 7, 1);
    await until(async () => (await st(C2)).inFs);
    ok(await until(async () => { const r = await roster(); return r.find((x) => x.g === '第 2 組')?.seats.join() === '5 號,12 號' && r.find((x) => x.g === '第 1 組')?.seats.join() === '7 號'; }),
      `教師端連線管理：第 2 組「5 號、12 號」（依座號排序）、第 1 組「7 號」：${JSON.stringify(await roster())}`);

    // ======================================================================
    // 2. 打字：03 分類名稱、04 分類名稱與共同特色（注音組字、選字、修改、收起鍵盤）
    // ======================================================================
    await A.evaluate(() => { window.__marker = 'no-reload'; });
    const cdp = await A.context().newCDPSession(A);
    const ime = async (comp, commit) => {
      for (let i = 1; i <= comp.length; i++) { await cdp.send('Input.imeSetComposition', { text: comp.slice(0, i), selectionStart: i, selectionEnd: i }); await sleep(50); }
      await cdp.send('Input.insertText', { text: commit }); await sleep(80);
    };
    await stage('03', { screen: 'instruction' });
    await A.waitForSelector('.bd-add:not([hidden])', { timeout: 15000 });
    await A.locator('.bd-add:not([hidden])').tap(); await A.waitForSelector('.bd-cat .bd-name:visible');
    await A.locator('.bd-cat .bd-name:visible').first().tap();
    s = await st(A); ok(s.inFs && !s.overlay && !s.note, '03 點分類名稱欄位：仍在全螢幕、沒有遮罩');
    await ime('ㄇㄛˊ', '魔'); await ime('ㄈㄚˇ', '法');
    s = await st(A); ok(s.inFs && !s.overlay && s.value === '魔法', `03 注音組字與選字「${s.value}」：仍在全螢幕`);
    await A.keyboard.press('ArrowLeft'); await ime('ㄉㄚˋ', '大');
    s = await st(A); ok(s.inFs && s.value === '魔大法' && s.caret === 2, `03 移動游標插入（修改）：「${s.value}」，游標 ${s.caret}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 400, deviceScaleFactor: 1, mobile: false }); await sleep(500);
    s = await st(A); ok(s.inFs && !s.overlay && !s.note && s.value === '魔大法', '虛擬鍵盤（可視區域縮成 1024×400）：不顯示遮罩，文字保留');
    await cdp.send('Emulation.clearDeviceMetricsOverride'); await sleep(300);
    await A.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('resize')); }); await sleep(300);
    s = await st(A); ok(s.inFs && !s.overlay, '視窗暫時失去焦點（blur）、resize：不顯示遮罩');
    await A.keyboard.press('Enter'); await sleep(900);
    s = await st(A); ok(s.inFs && !s.overlay, 'Enter 完成輸入（收起鍵盤）：仍在全螢幕');
    ok(await A.evaluate(() => document.querySelector('.bd-cat .bd-name:not([hidden])')?.value) === '魔大法', '分類名稱已保存在畫面上「魔大法」');

    // ======================================================================
    // 3. 打字中退出全螢幕（模擬 iPad：叫出鍵盤／打字時由系統退出）：不立即擋住；
    //    完成輸入的那一下操作（點其他地方、按 Enter）直接重新進入全螢幕，不出現遮罩；
    //    不是由使用者操作離開欄位（例如系統收起鍵盤）時才顯示遮罩
    // ======================================================================
    await A.evaluate(() => { window.__overlayEver = 0; new MutationObserver(() => { if (document.querySelector('dialog.fsx')?.open) window.__overlayEver++; })
      .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] }); });
    const overlayEver = () => A.evaluate(() => window.__overlayEver);
    const resetEver = () => A.evaluate(() => { window.__overlayEver = 0; });
    await A.locator('.bd-add:not([hidden])').tap(); await sleep(600);
    await A.locator('.bd-cat .bd-name:visible').nth(1).tap();
    await ime('ㄕㄨˇ', '鼠');
    await A.evaluate(() => document.exitFullscreen()); await sleep(400);
    s = await st(A);
    ok(!s.inFs && !s.overlay && s.note && s.focusCls.includes('bd-name') && s.value === '鼠', `打字中退出：沒有立即顯示遮罩、焦點仍在欄位（「${s.value}」）、上方顯示「完成輸入後，請回到全螢幕」`);
    await ime('ㄅㄠˇ', '寶');
    s = await st(A); ok(s.value === '鼠寶' && s.caret === 2 && !s.overlay, `繼續輸入不被打斷：「${s.value}」，游標 ${s.caret}`);
    await A.screenshot({ path: path.join(SHOTS, 'typing-exit-note-1024x768.png') });
    await A.locator('.bd-hint, .bd-col-title').first().tap();   // 點其他地方（完成輸入、收起鍵盤）
    ok(await until(async () => (await st(A)).inFs), '完成輸入（點其他地方）：自動回到全螢幕');
    s = await st(A); ok(!s.overlay && !s.note && await overlayEver() === 0, '完成輸入時沒有出現黑色遮罩，小提示也收起');
    // 按 Enter 完成分類名稱
    await A.locator('.bd-cat .bd-name:visible').nth(1).tap(); await A.keyboard.press('End');
    await A.evaluate(() => document.exitFullscreen()); await sleep(300);
    await ime('ㄓ', '之');
    await A.keyboard.press('Enter');
    ok(await until(async () => (await st(A)).inFs), '打字中退出後按 Enter 完成：自動回到全螢幕');
    ok(await overlayEver() === 0, '按 Enter 完成時也沒有出現遮罩');
    // 從分類名稱移到共同特色以外的另一個欄位（03 只有名稱欄位）：不是使用者操作離開（系統收起鍵盤）→ 顯示遮罩
    await A.locator('.bd-cat .bd-name:visible').first().tap(); await A.keyboard.press('End');
    await A.evaluate(() => document.exitFullscreen()); await sleep(300);
    await ime('ㄨㄤˊ', '王');
    // 模擬系統自行收起鍵盤（不是學生的操作）：Chromium 的使用者操作授權約 5 秒後失效；Playwright 的 evaluate 會帶使用者操作，
    // 所以等待期間不呼叫 evaluate，最後以 CDP（userGesture: false）讓欄位失去焦點
    await sleep(5500);
    const noAct = await cdp.send('Runtime.evaluate', { expression: 'navigator.userActivation ? navigator.userActivation.isActive : false', userGesture: false, returnByValue: true });
    ok(noAct.result.value === false, '此時沒有使用者操作授權');
    await cdp.send('Runtime.evaluate', { expression: 'document.activeElement.blur()', userGesture: false });
    ok(await until(async () => (await st(A)).overlay), '不是由使用者操作離開欄位：顯示黑色遮罩');
    ok(await covered(A), '遮罩是不透明黑色，覆蓋整個可視區域（四角、上下都點到遮罩）');
    s = await st(A); ok(s.msg === '請回到全螢幕，繼續活動' && s.btn === '回到全螢幕' && !s.err && !s.alt, `遮罩只有「${s.msg}」與按鈕「${s.btn}」`);
    await A.locator('.fsx-btn').tap();
    ok(await until(async () => { const x = await st(A); return x.inFs && !x.overlay; }), '按「回到全螢幕」：回到全螢幕、遮罩消失');
    ok(await A.evaluate(() => [...document.querySelectorAll('.bd-cat .bd-name:not([hidden])')].map((i) => i.value).join('|')) === '魔大法王|鼠寶之', '返回後兩個分類名稱都在（「魔大法王」「鼠寶之」）');
    ok(await until(async () => JSON.stringify((await pg.query("select data from public.personal_boards pb join public.participants p on p.id = pb.participant_id where p.session_id = $1 and p.seat_no = 12", [SID])).rows[0].data.categories.map((c) => c.name)) === '["魔大法王","鼠寶之"]'),
      '伺服器已保存分類名稱「魔大法王」「鼠寶之」');

    // ======================================================================
    // 4. 開著故事卡（翻到背面）退出 → 遮罩在閱讀卡之上、背景不能操作 → 鍵盤返回；連續三次（鍵盤、觸控、滑鼠）
    // ======================================================================
    await A.locator('.bd-left .sc-read').first().tap(); await A.waitForSelector('dialog.reader[open]');
    await A.locator('dialog.reader[open] .sr-front .sr-flip').tap();
    await until(() => A.evaluate(() => document.querySelector('.sr-card')?.dataset.side === 'back'), 3000);
    const readerTitle = await A.textContent('dialog.reader[open] .sr-back .sr-title');
    for (const [i, how] of [[1, '鍵盤 Enter'], [2, '觸控'], [3, '滑鼠']]) {
      await A.evaluate(() => document.exitFullscreen());
      ok(await until(async () => (await st(A)).overlay), `第 ${i} 次退出（閱讀卡開著）：顯示遮罩`);
      s = await st(A);
      ok(await covered(A) && s.overlays === 1, `第 ${i} 次：遮罩蓋住閱讀卡與整個畫面，只有一個遮罩（${s.overlays}）`);
      // 背景不能操作：點閱讀卡的翻面按鈕位置、按 Tab、按 Esc
      const flipBox = await A.locator('dialog.reader[open] .sr-back .sr-flip').boundingBox().catch(() => null);
      if (flipBox) await A.mouse.click(flipBox.x + flipBox.width / 2, flipBox.y + flipBox.height / 2);
      for (let k = 0; k < 4; k++) await A.keyboard.press('Tab');
      await A.keyboard.press('Escape'); await sleep(200);
      const bg = await A.evaluate(() => ({ side: document.querySelector('.sr-card')?.dataset.side, readerOpen: Boolean(document.querySelector('dialog.reader[open]')),
        focusInOverlay: document.querySelector('dialog.fsx').contains(document.activeElement) || document.activeElement === document.body }));
      s = await st(A);
      ok(s.overlay && bg.side === 'back' && bg.readerOpen && bg.focusInOverlay, `第 ${i} 次：點擊、Tab、Esc 都無法操作背景（閱讀卡仍在背面、焦點在遮罩內）`);
      if (i === 1) await A.screenshot({ path: path.join(SHOTS, 'overlay-over-reader-1024x768.png') });
      if (how === '鍵盤 Enter') { await A.locator('.fsx-btn').focus(); await A.keyboard.press('Enter'); }
      else if (how === '觸控') await A.locator('.fsx-btn').tap();
      else await A.locator('.fsx-btn').click();
      ok(await until(async () => { const x = await st(A); return x.inFs && !x.overlay; }), `第 ${i} 次以${how}返回：全螢幕、遮罩消失`);
      const after = await A.evaluate(() => ({ side: document.querySelector('.sr-card')?.dataset.side, title: document.querySelector('dialog.reader[open] .sr-back .sr-title')?.textContent, marker: window.__marker }));
      ok(after.side === 'back' && after.title === readerTitle && after.marker === 'no-reload', `第 ${i} 次返回後：閱讀卡《${after.title}》仍在背面，頁面沒有重新載入`);
    }
    await A.keyboard.press('Escape'); await A.waitForSelector('dialog.reader[open]', { state: 'detached', timeout: 3000 }).catch(() => {});

    // ======================================================================
    // 5. 遮罩期間教師切換環節：同步照常，返回後顯示最新環節（04 小組）
    // ======================================================================
    await A.evaluate(() => document.exitFullscreen());
    await until(async () => (await st(A)).overlay);
    await stage('04', { screen: 'instruction' });
    ok(await until(() => A.evaluate(() => Boolean(document.querySelector('.gw-panel-body')))), '遮罩期間教師切換到 04：遮罩下方已同步為小組工作區');
    s = await st(A); ok(s.overlay && s.overlays === 1, '切換環節後遮罩仍在最上層（沒有重複建立）');
    await A.locator('.fsx-btn').tap();
    ok(await until(async () => { const x = await st(A); return x.inFs && !x.overlay; }), '返回後：看到 04 小組工作區');
    // 04：分類名稱與共同特色
    await A.waitForSelector('.bd-add:not([hidden])', { timeout: 15000 });
    await A.locator('.bd-add:not([hidden])').tap(); await A.waitForSelector('.bd-cat .bd-reason:visible'); await sleep(600);
    await A.locator('.bd-cat .bd-name:visible').first().tap(); await ime('ㄑㄧˊ', '奇'); await ime('ㄏㄨㄢˋ', '幻');
    await A.locator('.bd-cat .bd-reason:visible').first().tap(); await ime('ㄧㄡˇ', '有'); await ime('ㄇㄛˊ', '魔'); await A.keyboard.press('ArrowLeft'); await ime('ㄅㄨˋ', '不');
    s = await st(A); ok(s.inFs && !s.overlay && s.value === '有不魔' && s.caret === 2, `04 共同特色：組字、選字、修改「${s.value}」游標 ${s.caret}，仍在全螢幕`);
    // 編輯共同特色時退出 → 繼續輸入 → 點其他地方完成 → 自動回到全螢幕 → 文字保留
    await A.evaluate(() => document.exitFullscreen()); await sleep(300);
    s = await st(A); ok(!s.overlay && s.note && s.value === '有不魔', '04 編輯共同特色時退出：不擋住輸入');
    await A.keyboard.press('End'); await ime('ㄈㄚˇ', '法');
    await resetEver();
    await A.locator('.bd-col-title:visible').first().tap();
    ok(await until(async () => (await st(A)).inFs) && await overlayEver() === 0, '04 完成輸入（點其他地方）：自動回到全螢幕，沒有出現遮罩');
    const g04 = await A.evaluate(() => ({ name: document.querySelector('.bd-cat .bd-name:not([hidden])')?.value || document.querySelector('.bd-cat .bd-name-ro')?.textContent, reason: document.querySelector('.bd-cat .bd-reason:not([hidden])')?.value || document.querySelector('.bd-cat .bd-reason-ro')?.textContent }));
    ok(g04.name === '奇幻' && g04.reason === '有不魔法', `04 返回後：分類名稱「${g04.name}」、共同特色「${g04.reason}」`);
    ok(await until(async () => (await pg.query("select reason from public.group_categories gc join public.groups g on g.id = gc.group_id where g.session_id = $1 and g.number = 2 and gc.name = '奇幻'", [SID])).rows[0]?.reason === '有不魔法'),
      '伺服器已保存 04 的共同特色「有不魔法」');
    await A.screenshot({ path: path.join(SHOTS, 'group-04-fullscreen-1024x768.png') });

    // ======================================================================
    // 6. 重新整理、斷線重連：同一個座號；重新整理後顯示遮罩（需重新進入全螢幕）
    // ======================================================================
    await A.reload();
    ok(await until(async () => (await st(A)).overlay), '重新整理：已加入的學生直接顯示黑色遮罩（瀏覽器重新整理會離開全螢幕）');
    await A.locator('.fsx-btn').tap();
    ok(await until(async () => (await st(A)).inFs && !(await st(A)).overlay), '重新整理後按「回到全螢幕」：恢復');
    ok(await until(() => A.evaluate(() => document.body.innerText.includes('第 2 組・12 號') || Boolean(document.querySelector('.gw-panel-body')))), '重新整理後恢復同一個身分（第 2 組、小組工作區）');
    ok(await seatOf(tokA) === 12, '重新整理後資料庫座號仍為 12');
    await A.context().setOffline(true); await sleep(2500);
    await A.context().setOffline(false);
    ok(await until(() => A.evaluate(() => document.querySelector('.netbar')?.hidden !== false), 15000), '斷線後重新連線：連線提示消失');
    ok(await seatOf(tokA) === 12 && (await st(A)).inFs, '斷線重連後：座號仍為 12、仍在全螢幕');
    await T.reload(); await T.waitForSelector('.roster-group', { timeout: 15000 });
    ok(await until(async () => (await roster()).find((x) => x.g === '第 2 組')?.seats.join() === '5 號,12 號'), '教師端重新整理後：第 2 組仍顯示「5 號、12 號」');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-roster-1366x1024.png'), fullPage: true });

    // ======================================================================
    // 7. 加入失敗：保留座號與組別；重試成功
    // ======================================================================
    const D = await newStudent();
    await D.waitForSelector('.s-seat');
    await D.locator('.s-seat').fill('21'); await D.locator('.s-group:has(.n:text-is("3"))').tap();
    // (a) 網路中斷時按確認加入
    await D.locator('.s-join-go').tap();
    await D.context().setOffline(true);
    await D.locator('dialog.dialog button:has-text("確認加入")').tap();
    ok(await until(() => D.evaluate(() => document.body.innerText.includes('無法連線'))), '加入失敗（網路中斷）：顯示「無法連線」與重試');
    await D.screenshot({ path: path.join(SHOTS, 'join-failed-offline-1024x768.png') });
    await D.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await sleep(300);
    s = await st(D); ok(!s.overlay, '加入失敗：尚未加入，不顯示遮罩');
    await D.context().setOffline(false);
    await D.locator('button:has-text("重試")').tap();
    await D.waitForSelector('.s-seat');
    f = await D.evaluate(() => ({ seat: document.querySelector('.s-seat')?.value, g: [...document.querySelectorAll('.s-group[aria-pressed=true] .n')].map((x) => x.textContent).join() }));
    ok(f.seat === '21' && f.g === '3', `網路恢復後重試：保留座號「${f.seat}」與第 ${f.g} 組`);
    // (b) 老師暫停加入
    await api('teacher_update_session', { p_session: SID, p_join_open: false }, TT);
    await D.locator('.s-join-go').tap(); await D.locator('dialog.dialog button:has-text("確認加入")').tap();
    ok(await until(() => D.evaluate(() => document.body.innerText.includes('暫停加入'))), '加入失敗（老師暫停加入）：顯示「老師目前暫停加入」與重新檢查');
    await D.screenshot({ path: path.join(SHOTS, 'join-failed-closed-1024x768.png') });
    ok(await seatOf(await token(D)) === undefined, '加入失敗：沒有建立學生紀錄');
    await api('teacher_update_session', { p_session: SID, p_join_open: true }, TT);
    await D.locator('button:has-text("重新檢查")').tap();
    await D.waitForSelector('.s-seat');
    f = await D.evaluate(() => ({ seat: document.querySelector('.s-seat')?.value, g: [...document.querySelectorAll('.s-group[aria-pressed=true] .n')].map((x) => x.textContent).join() }));
    ok(f.seat === '21' && f.g === '3', `重新開放後：保留座號「${f.seat}」與第 ${f.g} 組`);
    await D.locator('.s-join-go').tap(); await D.locator('dialog.dialog button:has-text("確認加入")').tap();
    ok(await until(async () => (await seatOf(await token(D))) === 21), '重試加入成功：座號 21 已保存');
    ok(await until(async () => (await st(D)).inFs && !(await st(D)).overlay), '重試加入成功：進入全螢幕');

    // ======================================================================
    // 8. 全螢幕請求被拒絕：保留已加入的身分，顯示黑底提示與重試；連續失敗後可先以一般畫面繼續
    // ======================================================================
    const deny = () => { window.__deny = true; const orig = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...a) { return window.__deny ? Promise.reject(new TypeError('Permissions check failed')) : orig.apply(this, a); }; };
    const E = await newStudent(deny);
    await joinUI(E, 30, 4);
    ok(await until(async () => (await st(E)).overlay), '全螢幕被拒絕：加入成功後顯示黑色遮罩');
    s = await st(E);
    ok(s.err === '瀏覽器沒有允許全螢幕，請再按一次「回到全螢幕」。' && !s.alt, `遮罩說明：「${s.err}」`);
    const tokE = await token(E);
    ok(await seatOf(tokE) === 30, '全螢幕被拒絕：已加入的學生紀錄（座號 30）保留');
    await E.screenshot({ path: path.join(SHOTS, 'overlay-denied-1024x768.png') });
    await E.locator('.fsx-btn').tap(); await sleep(400);
    s = await st(E); ok(s.overlay && s.alt && s.err.includes('請舉手告訴老師'), `再試一次仍被拒絕：「${s.err}」，出現「先以一般畫面繼續」`);
    await E.evaluate(() => { window.__deny = false; });
    await E.locator('.fsx-btn').tap();
    ok(await until(async () => { const x = await st(E); return x.inFs && !x.overlay; }), '瀏覽器允許後按「回到全螢幕」：進入全螢幕');
    // 一直被拒絕：先以一般畫面繼續
    const F = await newStudent(deny);
    await joinUI(F, 31, 4);
    await until(async () => (await st(F)).overlay);
    await F.locator('.fsx-btn').tap(); await sleep(300);
    await F.locator('.fsx-alt').tap();
    s = await st(F); ok(!s.overlay && !s.inFs, '連續被拒絕後按「先以一般畫面繼續」：遮罩收起');
    ok(await until(() => F.evaluate(() => Boolean(document.querySelector('.gw-panel-body')) && document.body.innerText.includes('第 4 組'))), '以一般畫面繼續：可看到活動畫面（第 4 組的小組工作區）');

    // ======================================================================
    // 9. 瀏覽器不支援全螢幕：不顯示遮罩（避免無法解除），顯示說明，活動照常
    // ======================================================================
    const G = await newStudent(() => {
      for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) delete Element.prototype[k];
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    });
    await joinUI(G, 40, 5);
    ok(await until(() => G.evaluate(() => Boolean(document.querySelector('.gw-panel-body')) && document.body.innerText.includes('第 5 組'))) && await seatOf(await token(G)) === 40, '不支援全螢幕：仍可加入（第 5 組，座號 40）');
    s = await st(G); ok(!s.overlay && s.info, '不支援全螢幕：沒有遮罩，上方顯示「這台裝置的瀏覽器不支援全螢幕，活動將以一般畫面進行。」');
    await G.screenshot({ path: path.join(SHOTS, 'unsupported-1024x768.png') });

    // ======================================================================
    // 10. 舊資料（沒有座號）、重複座號、權限
    // ======================================================================
    const legacyTok = 'f'.repeat(48);
    await api('student_join', { p_code: CODE, p_token: legacyTok, p_group_number: 6 });   // 舊版前端：三個參數、沒有座號
    const dupTok = 'e'.repeat(48);
    await api('student_join', { p_code: CODE, p_token: dupTok, p_group_number: 6, p_seat_no: 12 });   // 與 A 相同座號
    await T.evaluate(() => {}); await sleep(200);
    ok(await until(async () => { const g6 = (await roster()).find((x) => x.g === '第 6 組'); return g6 && g6.seats.join() === '12 號,未填座號（組內第 1 位）'; }, 15000),
      `舊資料沒有座號：教師端顯示「未填座號（組內第 1 位）」，沒有空白或 undefined；重複座號照常加入：${JSON.stringify((await roster()).find((x) => x.g === '第 6 組'))}`);
    await T.screenshot({ path: path.join(SHOTS, 'teacher-roster-legacy-1366x1024.png'), fullPage: true });
    const html = await T.evaluate(() => document.body.innerText);
    ok(!/undefined|null 號|NaN/.test(html), '教師端畫面沒有 undefined／null／NaN');
    let e1 = null; try { await api('student_join', { p_code: CODE, p_token: 'd'.repeat(48), p_group_number: 6, p_seat_no: 0 }); } catch (e) { e1 = e.code; }
    let e2 = null; try { await api('student_join', { p_code: CODE, p_token: 'd'.repeat(48), p_group_number: 6, p_seat_no: 1000 }); } catch (e) { e2 = e.code; }
    ok(e1 === 'INVALID_SEAT' && e2 === 'INVALID_SEAT', `伺服器也檢查座號範圍（0、1000 → ${e1}、${e2}）`);
    const resumed = await api('student_join', { p_code: CODE, p_token: tokA, p_group_number: 5, p_seat_no: 99 });
    ok(resumed.resumed === true && resumed.seat_no === 12 && await seatOf(tokA) === 12, '已加入的裝置再次加入（不同座號、不同組）：恢復原身分，座號仍為 12');
    const legacyFix = await api('student_join', { p_code: CODE, p_token: legacyTok, p_group_number: 6, p_seat_no: 8 });
    ok(legacyFix.resumed === true && legacyFix.seat_no === 8, '舊資料沒有座號的裝置重新加入時：補上座號 8');
    const direct = await fetch(`${BASE}/rest/v1/participants?session_id=eq.${SID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + ANON }, body: JSON.stringify({ seat_no: 1 }) });
    ok(!direct.ok, `學生（anon）不能直接修改座號（HTTP ${direct.status}）`);
    const directT = await fetch(`${BASE}/rest/v1/participants?session_id=eq.${SID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + TT }, body: JSON.stringify({ seat_no: 1 }) });
    ok(!directT.ok && (await pg.query('select count(*) from public.participants where session_id = $1 and seat_no = 1', [SID])).rows[0].count === '0', `教師也不能直接改寫座號（HTTP ${directT.status}），只能讀取`);

    // ======================================================================
    // 11. 教師端各成員清單：02 加入狀態、03 個人分類、04 小組進度
    // ======================================================================
    await stage('02', { screen: 'task' });
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.ready-cell')].some((c) => [...c.querySelectorAll('.seat-n')].map((x) => x.textContent).join('、') === '5 號、12 號'))), '教師端 02：各組加入狀態顯示座號（第 2 組「5 號、12 號」）');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-02-1366x1024.png') });
    await stage('03', { screen: 'instruction' });
    await until(() => T.evaluate(() => Boolean(document.querySelector('.pp-row'))));
    await T.locator('.pp-row:has-text("第 2 組")').click();
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.pp-people tbody tr td:first-child')].map((x) => x.textContent).join() === '5 號,12 號')), '教師端 03 個人分類：第 2 組成員為「5 號」「12 號」');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-03-1366x1024.png') });
    await stage('04', { screen: 'instruction' });
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.gp-members')].some((c) => [...c.querySelectorAll('.seat-n')].map((x) => x.textContent).join('、') === '5 號、12 號'))), '教師端 04 小組進度：第 2 組「5 號、12 號」');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-04-1366x1024.png') });

    // ======================================================================
    // 12. 遮罩期間結束活動：返回後顯示結束畫面
    // ======================================================================
    await B.evaluate(() => document.exitFullscreen());
    await until(async () => (await st(B)).overlay);
    await api('teacher_end_session', { p_session: SID }, TT);
    ok(await until(() => B.evaluate(() => document.querySelector('main')?.innerText.includes('每一種分類，都從觀察開始'))), '遮罩期間教師結束活動：遮罩下方已更新為結束畫面');
    await B.locator('.fsx-btn').tap();
    ok(await until(async () => (await st(B)).inFs && !(await st(B)).overlay), '結束後返回全螢幕：遮罩消失');
    const endText = await B.evaluate(() => document.querySelector('main')?.innerText || '');
    ok(endText.includes('每一種分類，都從觀察開始'), `返回後顯示結束畫面：「${endText.replace(/\s+/g, ' ').slice(0, 60)}」`);
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n座號與全螢幕：通過 ${passed} 項，失敗 ${fails.length} 項（截圖：${SHOTS}）`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
