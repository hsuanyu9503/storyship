// 教師端查看學生全螢幕狀態（2026-11-26）
//   從正常教師入口（teacher.html 登入、建立場次）與學生入口（join.html：座號 → 組別 → 確認加入）操作。
//   瀏覽器模擬：Playwright Chromium（headless）Fullscreen API、觸控模擬、CDP 輸入法組字與可視區域縮小、離線模擬。
//   「Esc 或系統退出全螢幕」以 document.exitFullscreen() 模擬。「超過在線時間」以把資料庫的最後連線時間往前調模擬（不實際等 40 秒）。
//   需要：setup_story_db.sh 的 sf_story 與對應 shim（PORT=8789）。
const { chromium } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const SHOTS = process.env.SHOTS || path.join(__dirname, '.cache/fs-status');
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(100); } return false; }
let ANON = '';
async function rpcRaw(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
  return { ok: r.ok, status: r.status, body: j };
}
async function api(fn, args, token) { const r = await rpcRaw(fn, args, token); if (!r.ok) { const e = new Error(fn + ': ' + JSON.stringify(r.body)); e.code = r.body?.message; throw e; } return r.body; }
const login = async (email) => (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ email, password: 'pass' }) })).json()).access_token;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const TT = await login('t1@example.com');

    // ---------- 教師端：正常入口 ----------
    const T = await (await browser.newContext({ viewport: { width: 1366, height: 1024 } })).newPage();
    T.on('pageerror', (e) => errors.push('teacher: ' + e.message));
    // 記錄教師端出現過的每一則退出提醒（文字改變就記一筆）
    await T.addInitScript(() => {
      window.__alerts = [];
      new MutationObserver(() => {
        const el = document.querySelector('.fs-alert');
        if (el && !el.hidden && el.textContent && el.textContent !== window.__lastAlert) { window.__lastAlert = el.textContent; window.__alerts.push(el.textContent); }
        if (el && el.hidden) window.__lastAlert = '';
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });   // 初始化時還沒有 <html>
    });
    await T.goto(BASE + '/teacher.html');
    await T.fill('input[type=email]', 't1@example.com'); await T.fill('input[type=password]', 'pass'); await T.click('button[type=submit]');
    await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    const CODE = (await T.textContent('.code b')).trim();
    const SID = (await pg.query('select id from public.sessions where join_code = $1', [CODE])).rows[0].id;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, proj) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: false }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    const alerts = () => T.evaluate(() => window.__alerts.slice());
    // 教師端連線管理：每位學生 { 組別, 座號, 狀態鍵, 狀態文字, 時間 }
    const roster = () => T.evaluate(() => [...document.querySelectorAll('.roster-group')].flatMap((g) => [...g.querySelectorAll('.members li')].map((li) => ({
      g: g.querySelector('.roster-head b').textContent, seat: li.querySelector('.seat').textContent,
      fs: li.querySelector('.fs-tag')?.dataset.fs, text: li.querySelector('.fs-tag')?.textContent, time: li.querySelector('.fs-time')?.textContent,
      color: li.querySelector('.fs-tag') && getComputedStyle(li.querySelector('.fs-tag')).color }))));
    const rowOf = async (g, seat) => (await roster()).find((x) => x.g === g && x.seat === seat);
    const fsIs = (g, seat, key) => until(async () => (await rowOf(g, seat))?.fs === key, 15000);
    const db = async (seatNo) => (await pg.query('select fs_state, fs_seq, fs_exits, fs_ever from public.participants where session_id = $1 and seat_no = $2', [SID, seatNo])).rows[0];

    async function student(seat, group, init) {
      const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
      if (init) await ctx.addInitScript(init);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`student ${seat}: ` + e.message));
      await p.goto(`${BASE}/join.html?code=${CODE}`);
      await p.waitForSelector('.s-seat');
      await p.locator('.s-seat').fill(String(seat));
      await p.locator(`.s-group:has(.n:text-is("${group}"))`).tap();
      await p.locator('.s-join-go').tap();
      await p.locator('dialog.dialog button:has-text("確認加入")').tap();
      await p.waitForFunction((c) => { try { return Boolean(JSON.parse(localStorage.getItem('sf.session.' + c))?.session_id); } catch { return false; } }, CODE, { timeout: 15000 });   // 加入成功
      return p;
    }
    const sfs = (p) => p.evaluate(() => ({ inFs: Boolean(document.fullscreenElement), overlay: Boolean(document.querySelector('dialog.fsx')?.open), value: document.activeElement?.value ?? null }));
    const tokenOf = (p) => p.evaluate((c) => JSON.parse(localStorage.getItem('sf.token.' + c)), CODE);

    // ======================================================================
    // 1. 加入並進入全螢幕：教師端顯示正確組別、座號與綠色「全螢幕中」
    // ======================================================================
    const rev0 = await rev();
    const A = await student(12, 2);
    const B = await student(5, 2);
    const C = await student(7, 1);
    ok(await fsIs('第 2 組', '12 號', 'active') && await fsIs('第 2 組', '5 號', 'active') && await fsIs('第 1 組', '7 號', 'active'),
      '三位學生加入並進入全螢幕：教師端第 2 組 12 號、5 號與第 1 組 7 號都顯示「全螢幕中」');
    let r = await rowOf('第 2 組', '12 號');
    ok(r.text === '全螢幕中' && r.color === 'rgb(23, 96, 58)' && /^更新 \d\d:\d\d:\d\d$/.test(r.time), `綠色文字「${r.text}」（${r.color}）與最後更新時間「${r.time}」`);
    ok(await rev() === rev0, `全螢幕回報不推進課程操作版本（rev ${rev0} 不變）`);
    await sleep(1500);
    ok((await alerts()).length === 0, '加入時沒有任何退出提醒');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-all-active-1366x1024.png'), fullPage: true });

    // ======================================================================
    // 2. 手動退出：學生端黑底提示；教師端紅色並提醒一次；返回後綠色
    // ======================================================================
    await A.evaluate(() => document.exitFullscreen());
    ok(await until(async () => (await sfs(A)).overlay), '學生 12 號退出：學生端出現黑底提示');
    ok(await fsIs('第 2 組', '12 號', 'exited'), '教師端：第 2 組 12 號變成「已退出全螢幕」');
    r = await rowOf('第 2 組', '12 號');
    ok(r.text === '已退出全螢幕' && r.color === 'rgb(163, 32, 32)', `紅色文字「${r.text}」（${r.color}）`);
    ok(await until(async () => (await alerts()).includes('第 2 組・12 號退出全螢幕')), `教師端提醒「第 2 組・12 號退出全螢幕」（${JSON.stringify(await alerts())}）`);
    await T.screenshot({ path: path.join(SHOTS, 'teacher-exited-alert-1366x1024.png') });
    const alertBox = await T.evaluate(() => { const e = document.querySelector('.fs-alert'); return { pe: getComputedStyle(e).pointerEvents, dialog: document.querySelectorAll('dialog[open]').length, focus: document.activeElement?.tagName }; });
    ok(alertBox.pe === 'none' && alertBox.dialog === 0 && alertBox.focus !== 'DIV', '提醒不接收點擊、不是對話框、不搶焦點（不打斷教師操作）');
    await T.click('text=開啟投影').catch(() => {});   // 提醒顯示時仍可操作（點擊不被擋住）
    await A.locator('.fsx-btn').tap();
    ok(await fsIs('第 2 組', '12 號', 'active'), '學生返回全螢幕：教師端恢復綠色「全螢幕中」');
    ok((await db(12)).fs_exits === 1, '資料庫：退出次數 1');
    await sleep(4000);   // 經過數次輪詢
    ok((await alerts()).filter((x) => x.includes('12 號')).length === 1, '同一次退出只提醒一次（經過多次輪詢後仍只有一則）');

    // ======================================================================
    // 3. 打字、中文選字、可視區域縮小：依實際全螢幕狀態，不誤報
    // ======================================================================
    await stage('03', { screen: 'instruction' });
    await A.waitForSelector('.bd-add:not([hidden])', { timeout: 15000 });
    await A.locator('.bd-add:not([hidden])').tap(); await A.waitForSelector('.bd-cat .bd-name:visible');
    const cdp = await A.context().newCDPSession(A);
    const ime = async (comp, commit) => { for (let i = 1; i <= comp.length; i++) { await cdp.send('Input.imeSetComposition', { text: comp.slice(0, i), selectionStart: i, selectionEnd: i }); await sleep(40); } await cdp.send('Input.insertText', { text: commit }); await sleep(60); };
    const seqBefore = (await db(12)).fs_seq;
    await A.locator('.bd-cat .bd-name:visible').first().tap();
    await ime('ㄇㄛˊ', '魔'); await ime('ㄈㄚˇ', '法'); await A.keyboard.press('ArrowLeft'); await ime('ㄉㄚˋ', '大');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 400, deviceScaleFactor: 1, mobile: false }); await sleep(600);
    await cdp.send('Emulation.clearDeviceMetricsOverride'); await sleep(300);
    await A.keyboard.press('Enter'); await sleep(2500);
    ok((await db(12)).fs_seq === seqBefore && (await db(12)).fs_state === 'active', '打字、注音組字與選字、可視區域縮小（虛擬鍵盤）：沒有送出任何狀態變更（序號不變、仍是全螢幕中）');
    ok((await rowOf('第 2 組', '12 號')).fs === 'active' && (await alerts()).length === 1, '教師端仍為綠色，沒有新的提醒');
    // 打字中裝置確實退出（模擬 iPad）：如實回報已退出；完成輸入自動返回後恢復綠色
    await A.locator('.bd-cat .bd-name:visible').first().tap(); await A.keyboard.press('End');
    await A.evaluate(() => document.exitFullscreen()); await sleep(200);
    await ime('ㄨㄤˊ', '王');
    ok(await fsIs('第 2 組', '12 號', 'exited'), '打字中裝置確實退出全螢幕：教師端如實顯示「已退出全螢幕」');
    ok(!(await sfs(A)).overlay, '學生端打字中不顯示遮罩（沿用原本行為）');
    await A.locator('.bd-col-title:visible').first().tap();
    ok(await until(async () => (await sfs(A)).inFs) && await fsIs('第 2 組', '12 號', 'active'), '完成輸入後自動返回：學生端全螢幕、教師端恢復綠色');

    // ======================================================================
    // 4. 重複、延遲、順序顛倒的回報：狀態不倒退、不重複提醒
    // ======================================================================
    const tokA = await tokenOf(A);
    const cur = await db(12);
    const exitsBefore = cur.fs_exits;
    const alertsBefore = (await alerts()).length;
    let x = await api('student_report_fullscreen', { p_session: SID, p_token: tokA, p_state: 'off', p_seq: Number(cur.fs_seq) - 5000 });
    ok(x.accepted === false && x.reason === 'STALE' && x.state === 'active', '延遲送達的舊「已退出」（序號較小）：被忽略，仍是全螢幕中');
    x = await api('student_report_fullscreen', { p_session: SID, p_token: tokA, p_state: 'on', p_seq: Number(cur.fs_seq) });
    ok(x.accepted === false && x.reason === 'STALE', '重送同一個序號：被忽略');
    const s1 = Number(cur.fs_seq) + 2000; const s2 = Number(cur.fs_seq) + 1000;
    x = await api('student_report_fullscreen', { p_session: SID, p_token: tokA, p_state: 'on', p_seq: s1 });
    const y = await api('student_report_fullscreen', { p_session: SID, p_token: tokA, p_state: 'off', p_seq: s2 });
    ok(x.accepted && !y.accepted && (await db(12)).fs_state === 'active', '順序顛倒（新的「全螢幕中」先到、舊的「已退出」後到）：維持全螢幕中');
    await sleep(4000);
    ok((await db(12)).fs_exits === exitsBefore && (await alerts()).length === alertsBefore && (await rowOf('第 2 組', '12 號')).fs === 'active', '沒有狀態倒退，也沒有多出提醒');
    // 本機序號比伺服器小（例如本機紀錄被清除）：學生端採用伺服器序號重新回報，下一次退出仍會被接受
    await A.evaluate((c) => localStorage.setItem('sf.fsseq.' + c, '1'), CODE);
    await A.evaluate(() => document.exitFullscreen());
    ok(await fsIs('第 2 組', '12 號', 'exited'), '本機序號紀錄遺失後退出：仍能正確回報「已退出」');
    await A.locator('.fsx-btn').tap();
    ok(await fsIs('第 2 組', '12 號', 'active'), '返回後恢復綠色');

    // ======================================================================
    // 5. 斷線、關閉頁面、重新整理、重新連線
    // ======================================================================
    // (a) 斷線：超過在線時間 → 待確認；斷線期間退出 → 重連後回報、提醒一次；返回 → 綠色
    await A.context().setOffline(true);
    await sleep(500);
    await pg.query("update public.participants set last_seen_at = now() - interval '60 seconds' where session_id = $1 and seat_no = 12", [SID]);
    ok(await fsIs('第 2 組', '12 號', 'stale'), '學生斷線且超過在線時間（40 秒）：教師端改為灰色「連線中斷／狀態待確認」，不再顯示綠色');
    r = await rowOf('第 2 組', '12 號');
    ok(r.text === '連線中斷／狀態待確認' && /^最後回報 /.test(r.time), `待確認時顯示最後回報時間「${r.time}」`);
    await T.screenshot({ path: path.join(SHOTS, 'teacher-stale-1366x1024.png') });
    const nAlerts = (await alerts()).length;
    await A.evaluate(() => document.exitFullscreen());   // 斷線中退出：回報送不出去（重試）
    await sleep(1500);
    ok((await db(12)).fs_state === 'active', '斷線期間的回報尚未送達（資料庫仍是上一次的狀態）');
    await A.context().setOffline(false);
    ok(await fsIs('第 2 組', '12 號', 'exited'), '重新連線：學生端先回報當下狀態，教師端顯示「已退出全螢幕」');
    ok(await until(async () => (await alerts()).length === nAlerts + 1), '重新連線後的退出提醒一次');
    await A.locator('.fsx-btn').tap();
    ok(await fsIs('第 2 組', '12 號', 'active'), '返回全螢幕：恢復綠色');
    // (b) 關閉頁面
    await B.context().close();
    await pg.query("update public.participants set last_seen_at = now() - interval '60 seconds' where session_id = $1 and seat_no = 5", [SID]);
    ok(await fsIs('第 2 組', '5 號', 'stale'), '學生 5 號關閉頁面（超過在線時間）：待確認');
    // (c) 重新整理：瀏覽器離開全螢幕 → 回報已退出 → 黑底提示 → 返回 → 綠色
    await C.reload();
    ok(await until(async () => (await sfs(C)).overlay), '學生 7 號重新整理：黑底提示');
    ok(await fsIs('第 1 組', '7 號', 'exited'), '重新整理後：教師端「已退出全螢幕」（重新整理會離開全螢幕）');
    await C.locator('.fsx-btn').tap();
    ok(await fsIs('第 1 組', '7 號', 'active'), '重新整理後返回：綠色');

    // ======================================================================
    // 6. 多位學生短時間退出：彙整成一則提醒；教師端刷新後不重複提醒歷史事件
    // ======================================================================
    const D = await student(21, 3); const E = await student(30, 4);
    await fsIs('第 3 組', '21 號', 'active'); await fsIs('第 4 組', '30 號', 'active');
    const n0 = (await alerts()).length;
    await Promise.all([C, D, E].map((p) => p.evaluate(() => document.exitFullscreen())));
    ok(await fsIs('第 1 組', '7 號', 'exited') && await fsIs('第 3 組', '21 號', 'exited') && await fsIs('第 4 組', '30 號', 'exited'), '三位不同組的學生同時退出：教師端三人都顯示已退出');
    await sleep(1500);
    const multi = (await alerts()).slice(n0);
    ok(multi.length >= 1 && multi[multi.length - 1].startsWith('3 位學生退出全螢幕：') && ['第 1 組・7 號', '第 3 組・21 號', '第 4 組・30 號'].every((t) => multi[multi.length - 1].includes(t)),
      `彙整提醒：「${multi[multi.length - 1]}」`);
    ok(multi.length <= 2, `短時間內的退出彙整成一則（實際更新 ${multi.length} 次文字）`);
    await T.screenshot({ path: path.join(SHOTS, 'teacher-multi-alert-1366x1024.png') });
    await T.reload(); await T.waitForSelector('.roster-group', { timeout: 15000 });
    await sleep(4000);
    ok((await alerts()).length === 0, '教師端重新整理：不重複提醒歷史退出事件');
    ok(await fsIs('第 1 組', '7 號', 'exited') && await fsIs('第 3 組', '21 號', 'exited') && await fsIs('第 2 組', '12 號', 'active'), '教師端重新整理後：每位學生的組別、座號與狀態對應正確');
    for (const p of [C, D, E]) await p.locator('.fsx-btn').tap();
    ok(await fsIs('第 1 組', '7 號', 'active') && await fsIs('第 3 組', '21 號', 'active') && await fsIs('第 4 組', '30 號', 'active'), '三人返回：都恢復綠色');
    await sleep(1500);
    ok((await alerts()).length === 0, '返回不會產生提醒');

    // ======================================================================
    // 7. 尚未進入、請求未被允許、不支援、舊資料
    // ======================================================================
    const deny = () => { window.__deny = true; const orig = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...a) { return window.__deny ? Promise.reject(new TypeError('denied')) : orig.apply(this, a); }; };
    const F = await student(31, 4, deny);
    ok(await fsIs('第 4 組', '31 號', 'denied'), '加入時全螢幕被拒絕：教師端「尚未進入全螢幕（瀏覽器未允許）」，不是「已退出」');
    await F.reload();
    ok(await fsIs('第 4 組', '31 號', 'none'), '從未進入全螢幕的學生重新整理：「尚未進入全螢幕」');
    await sleep(1200);
    ok(!(await alerts()).some((t) => t.includes('31 號')), '從未進入全螢幕：不會提醒退出');
    await F.evaluate(() => { window.__deny = false; });
    await F.locator('.fsx-btn').tap();
    ok(await fsIs('第 4 組', '31 號', 'active'), '允許後進入全螢幕：綠色');
    const G = await student(40, 5, () => { for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) delete Element.prototype[k]; Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false }); });
    ok(await fsIs('第 5 組', '40 號', 'unsupported'), '裝置不支援：教師端「裝置不支援全螢幕」');
    void G;
    await api('student_join', { p_code: CODE, p_token: 'f'.repeat(48), p_group_number: 6 });   // 舊版前端：沒有座號、不回報
    ok(await until(async () => { const g6 = await rowOf('第 6 組', '未填座號（組內第 1 位）'); return g6?.fs === 'unknown' && g6.text === '狀態待確認（尚未回報）'; }),
      '舊資料沒有座號、沒有回報：顯示「未填座號（組內第 1 位）」與「狀態待確認（尚未回報）」');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-states-1366x1024.png'), fullPage: true });
    const txt = await T.evaluate(() => document.body.innerText);
    ok(!/undefined|null|NaN/.test(txt), '教師端沒有 undefined／null／NaN');

    // ======================================================================
    // 8. 其他成員清單（02 加入狀態、03 個人分類、04 小組進度）
    // ======================================================================
    await stage('02', { screen: 'task' });
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.ready-cell')].some((c) => [...c.querySelectorAll('.seat-fs')].map((s) => s.querySelector('.seat-n').textContent + ':' + s.querySelector('.fs-tag').dataset.fs).join() === '5 號:stale,12 號:active'))),
      '02 各組加入狀態：第 2 組「5 號（待確認）、12 號（全螢幕中）」');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-02-1366x1024.png') });
    await stage('03', { screen: 'instruction' });
    await until(() => T.evaluate(() => Boolean(document.querySelector('.pp-row'))));
    await T.locator('.pp-row:has-text("第 2 組")').click();
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.pp-people tbody tr')].map((tr) => tr.children[0].textContent + ':' + tr.querySelector('.fs-tag')?.dataset.fs).join() === '5 號:stale,12 號:active')),
      '03 個人分類成員表：第 2 組 5 號待確認、12 號全螢幕中（含更新時間欄）');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-03-1366x1024.png') });
    await stage('04', { screen: 'instruction' });
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.gp-members')].some((c) => c.textContent.includes('12 號') && c.textContent.includes('全螢幕中')))), '04 小組進度：成員座號旁顯示狀態');
    await A.evaluate(() => document.exitFullscreen());
    ok(await until(() => T.evaluate(() => [...document.querySelectorAll('.gp-members .seat-fs')].some((s) => s.querySelector('.seat-n').textContent === '12 號' && s.querySelector('.fs-tag').dataset.fs === 'exited'))), '04 小組進度：12 號退出後立即顯示已退出');
    await T.screenshot({ path: path.join(SHOTS, 'teacher-04-1366x1024.png') });
    await A.locator('.fsx-btn').tap();
    await fsIs('第 2 組', '12 號', 'active');

    // ======================================================================
    // 9. 權限：學生只能更新自己目前場次；教師只能讀自己的場次
    // ======================================================================
    const other = await api('teacher_create_session', { p_title: '另一個場次', p_group_count: 2 }, TT);
    let e = await rpcRaw('student_report_fullscreen', { p_session: other.session_id, p_token: tokA, p_state: 'off', p_seq: Date.now() + 99999 });
    ok(!e.ok && e.body?.message === 'NOT_JOINED', `學生不能回報其他場次的狀態（${e.body?.message}）`);
    e = await rpcRaw('student_report_fullscreen', { p_session: SID, p_token: 'a'.repeat(48), p_state: 'off', p_seq: Date.now() + 99999 });
    ok(!e.ok && e.body?.message === 'NOT_JOINED', '未加入的裝置不能回報');
    e = await rpcRaw('student_report_fullscreen', { p_session: SID, p_token: tokA, p_state: 'hacked', p_seq: Date.now() + 99999 });
    ok(!e.ok && e.body?.message === 'BAD_DATA', '不合法的狀態值被拒絕');
    ok((await db(12)).fs_state === 'active', '以上請求都沒有改動 12 號的狀態');
    const anonRead = await fetch(`${BASE}/rest/v1/participants?select=fs_state&session_id=eq.${SID}`, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } });
    ok(!anonRead.ok || (await anonRead.json()).length === 0, `學生（anon）不能直接讀取全螢幕狀態（HTTP ${anonRead.status}）`);
    const anonWrite = await fetch(`${BASE}/rest/v1/participants?session_id=eq.${SID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + ANON }, body: JSON.stringify({ fs_state: 'active' }) });
    ok(!anonWrite.ok, `學生不能直接改寫全螢幕狀態（HTTP ${anonWrite.status}）`);
    const tWrite = await fetch(`${BASE}/rest/v1/participants?session_id=eq.${SID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + TT }, body: JSON.stringify({ fs_state: 'active' }) });
    ok(!tWrite.ok, `教師不能直接改寫全螢幕狀態（HTTP ${tWrite.status}）`);
    await pg.query("insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', 't2@example.com') on conflict do nothing");
    await pg.query("insert into public.teachers values ('22222222-2222-2222-2222-222222222222', 't2@example.com') on conflict do nothing");
    const T2 = await login('t2@example.com');
    const t2read = await fetch(`${BASE}/rest/v1/participants?select=id,fs_state,seat_no&session_id=eq.${SID}`, { headers: { apikey: ANON, Authorization: 'Bearer ' + T2 } });
    const t2rows = t2read.ok ? await t2read.json() : [];
    ok(t2rows.length === 0, `其他教師讀不到這個場次的學生與全螢幕狀態（${t2rows.length} 筆）`);
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n教師端全螢幕狀態：通過 ${passed} 項，失敗 ${fails.length} 項（截圖：${SHOTS}）`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
