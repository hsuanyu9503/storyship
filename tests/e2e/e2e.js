// 三端端對端測試：教師主控、投影、兩台學生平板（不同瀏覽器 context＝不同裝置）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8787';
const OUT = path.join(__dirname, '.cache/shots');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const externalRequests = [];
let lastOk = '';
function ok(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed++; lastOk = msg; console.log('ok -', msg); }

async function ctx(browser, opts = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  // 封鎖所有外部網路請求：確認網站不依賴任何 CDN（學校網路常封鎖）
  await c.route((url) => !url.href.startsWith(BASE) && !url.href.startsWith(BASE.replace('http', 'ws')), (r) => { externalRequests.push(r.request().url()); r.abort(); });
  if (process.env.DEBUG_RPC) {
    c.on('response', async (r) => {
      const u = r.url();
      if (!u.includes('/rpc/group_') && !u.includes(process.env.DEBUG_RPC)) return;
      let b = ''; try { b = (await r.text()).slice(0, 160); } catch { /* ignore */ }
      console.log('RPC', u.split('/rpc/')[1], r.status(), (r.request().postData() || '').slice(0, 120), '→', b);
    });
  }
  return c;
}
const text = (page) => page.evaluate(() => document.body.innerText);
async function waitText(page, s, ms = 12000) {
  await page.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: ms });
}
async function waitNoText(page, s, ms = 12000) {
  await page.waitForFunction((s) => !document.body.innerText.includes(s), s, { timeout: ms });
}

// ---------- Phase 2：分類工作區操作 ----------
const grip = (page, title) => page.locator(`.sc:has(.sc-title:text-is("${title}")) .sc-grip`);
const cat = (page, i) => page.locator('.bd-cat').nth(i);
const countText = (page) => page.textContent('.bd-count');
async function waitCount(page, n, total = 8) {
  await page.waitForFunction((s) => document.querySelector('.bd-count')?.textContent === s, `已分類 ${n} / ${total}`, { timeout: 8000 });
}
function center(b, dy) { return [b.x + b.width / 2, b.y + (dy ?? b.height / 2)]; }
// 滑鼠拖曳（桌面）
async function mouseDrag(page, from, to) {
  const [x0, y0] = center(await from.boundingBox());
  const [x1, y1] = center(await to.boundingBox(), 30);
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await page.waitForTimeout(16); }
  await page.mouse.up();
}
// 真實觸控事件拖曳（平板手指；經由 Chrome DevTools Protocol 產生 touch → pointer 事件）
async function touchDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const [x0, y0] = center(await from.boundingBox());
  const [x1, y1] = center(await to.boundingBox(), 30);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= 14; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 14, y: y0 + (y1 - y0) * i / 14 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
// 點選移動：點把手（觸控 tap）→ 點目標區域
async function tapMove(page, title, target) {
  await grip(page, title).tap();
  try { await page.waitForSelector('.bd-movebar:not([hidden])', { timeout: 4000 }); }
  catch (e) {
    const g = grip(page, title);
    const bb = await g.boundingBox().catch(() => null);
    const info = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { at: el?.className + ' / ' + el?.closest('.sc')?.textContent, bd: document.querySelector('.bd')?.className,
               dialogs: document.querySelectorAll('dialog').length, ev: (window.__ev || []).slice(-12) };
    }, bb ? [bb.x + bb.width / 2, bb.y + bb.height / 2] : [0, 0]);
    console.log('DIAG tapMove', title, JSON.stringify(bb), JSON.stringify(info));
    throw e;
  }
  const t = target === 'unplaced' ? page.locator('.bd-left .bd-col-title') : target.locator('.bd-cat-head .bd-cat-n');
  await t.tap();
}
async function boardState(page) {
  return page.evaluate(() => ({
    unplaced: [...document.querySelectorAll('.bd-left .sc-title')].map((e) => e.textContent),
    cats: [...document.querySelectorAll('.bd-cat')].map((c) => ({
      name: c.querySelector('.bd-name').value, ph: c.querySelector('.bd-name').placeholder,
      cards: [...c.querySelectorAll('.sc-title')].map((e) => e.textContent) })),
  }));
}
// 確認某元素完整位於視窗內（不被遮擋、不需縮放）
async function inViewport(page, sel) {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return Boolean(r) && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && r.width > 0;
  }, sel);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ---------- 教師登入、建立場次 ----------
    const tc = await ctx(browser, { viewport: { width: 1366, height: 1000 } });
    const teacher = await tc.newPage();
    teacher.on('pageerror', (e) => errors.push('teacher: ' + e.message));
    await teacher.goto(BASE + '/teacher.html');
    await teacher.fill('input[type=email]', 't1@example.com');
    await teacher.fill('input[type=password]', 'pass');
    await teacher.click('button[type=submit]');
    await waitText(teacher, '建立教學場次');
    await teacher.click('text=建立（六組）');
    await waitText(teacher, '開放新學生加入');
    const code = (await teacher.textContent('.code b')).trim();
    ok(/^[A-Z0-9]{6}$/.test(code), '教師建立場次並取得活動代碼 ' + code);

    // ---------- 投影端 ----------
    const projHref = await teacher.getAttribute('a:has-text("開啟投影")', 'href');
    const pc = await ctx(browser, { viewport: { width: 1600, height: 900 } });
    const proj = await pc.newPage();
    proj.on('pageerror', (e) => errors.push('projector: ' + e.message));
    await proj.goto(projHref);
    await waitText(proj, '各組加入狀態');
    await proj.waitForSelector('.st-qr img', { timeout: 10000 });
    ok((await text(proj)).includes(code), '投影端顯示活動代碼與 QR Code');
    const qrSrc = await proj.getAttribute('.st-qr img', 'src');
    ok(qrSrc.startsWith('data:image/png'), 'QR Code 已產生');
    ok(!(await text(proj)).includes('故事 A'), '00 投影不顯示故事卡');
    await proj.screenshot({ path: path.join(OUT, 'p00-join.png') });

    // 錯誤金鑰
    const bad = await pc.newPage();
    await bad.goto(projHref.replace(/k=[0-9a-f]+/, 'k=deadbeef'));
    await waitText(bad, '沒有權限');
    ok(true, '錯誤投影金鑰無法讀取投影');
    await bad.close();

    // ---------- 兩位學生（iPad 橫向） ----------
    const join = projHref.replace(/projector\.html.*/, 'join.html?code=' + code);
    const students = [];
    for (const [i, grp] of [[1, 1], [2, 1], [3, 2]]) {
      const sc = await ctx(browser, { viewport: { width: 1180, height: 820 }, hasTouch: true });
      await sc.addInitScript(() => { window.__ev = []; for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'click'])
        document.addEventListener(t, (e) => window.__ev.push(t + ':' + (e.target.className || e.target.tagName)), true); });
      const s = await sc.newPage();
      s.on('pageerror', (e) => errors.push('student' + i + ': ' + e.message));
      await s.goto(join);
      await waitText(s, '請選擇你的組別');
      await s.click(`.s-group:has(.n:text-is("${grp}"))`);
      await s.click('dialog button:has-text("確認加入")');
      await waitText(s, '已加入第 ' + grp + ' 組');
      students.push({ page: s, grp });
    }
    ok(true, '三位學生（第 1 組兩位、第 2 組一位）掃碼加入');
    await students[0].page.screenshot({ path: path.join(OUT, 's00-wait.png') });
    await proj.waitForFunction(() => [...document.querySelectorAll('.st-group-count')].map((e) => e.textContent).join(',').startsWith('2 人,1 人'), null, { timeout: 12000 });
    ok(true, '投影端各組人數即時更新（2 人、1 人）');

    // 重新整理恢復身分
    await students[0].page.reload();
    await waitText(students[0].page, '已加入第 1 組');
    const seat0 = await students[0].page.textContent('.s-me');
    ok(seat0.includes('1 號'), '學生重新整理後恢復同一場次與組別（' + seat0 + '）');
    ok(seat0 !== (await students[1].page.textContent('.s-me')), '同組兩位學生有各自的匿名身分');

    // ---------- 01 ----------
    await teacher.click('text=啟動第一環節：走進故事世界 →');
    await waitText(proj, '故事世界的入口');
    for (const s of students) await waitText(s.page, '請觀看前方投影，跟著老師探索故事世界。');
    ok(true, '01：投影與學生端同步切換');
    await teacher.click('text=開啟故事探索');
    await waitText(proj, '這是什麼故事呢？');
    await teacher.click('text=下一個線索 →');
    await waitText(proj, '背景線索');
    const pt = await text(proj);
    ok(!pt.includes('人物線索') && !pt.includes('神祕故事一（佔位名稱）'), '01：只公開第一個線索，故事名稱未揭曉');
    ok((await text(teacher)).includes('神祕故事一（佔位名稱）'), '01：教師端可預覽未公開的故事名稱');
    await teacher.click('text=揭曉故事');
    await waitText(proj, '神祕故事一（佔位名稱）');
    ok(true, '01：揭曉故事後投影顯示名稱');
    await proj.screenshot({ path: path.join(OUT, 'p01-reveal.png') });

    // ---------- 02 ----------
    await teacher.click('button:has-text("進入下一環節 →")');
    await waitText(proj, '仔細觀察故事的共同特色');
    ok(!/奇幻|偵探|歷史小說|冒險小說|武俠/.test(await text(proj)), '02：不提前顯示五種小說類型');
    await waitText(students[0].page, '進入探索模式');
    await students[0].page.click('text=進入探索模式');
    await waitText(students[0].page, '已進入探索模式');
    ok(true, '02：學生進入探索模式（不支援全螢幕時仍可參與）');
    await teacher.click('text=投影重新顯示 QR Code（補加入）');
    await waitText(proj, '各組加入狀態');
    ok(true, '02：教師可重新投影 QR Code');
    await teacher.click('text=返回任務說明');
    await waitText(proj, '仔細觀察故事的共同特色');

    // ---------- 03｜我的故事分類（Phase 2） ----------
    const [s0, s1, s2] = students.map((x) => x.page);   // s0、s1 同為第 1 組；s2 為第 2 組
    await teacher.click('text=開放第三環節：我的故事分類 →');
    await waitText(s0, '尚未分類（8）');
    ok((await s0.locator('.bd-left .sc').count()) === 8, '03：學生端左側顯示 8 張故事卡（圖片佔位＋名稱＋摘要）');
    ok((await s0.locator('.bd-cat').count()) === 0 && (await text(s0)).includes('新增分類，將有共同特色的故事放在一起。'), '03：右側分類區初始為空白，只有一句提示');
    ok(!(await s0.locator('.bd-movebar').isVisible()) && !(await s0.locator('.bd-notice').isVisible()), '03：正常狀態下沒有多餘的提示列');
    const st0 = await text(s0);
    ok(!/奇幻|偵探|歷史小說|冒險小說|武俠/.test(st0) && !/\d+ 號/.test(st0) && !st0.includes('組員'), '03：學生畫面不顯示小說類型、座號或組員');
    await waitText(proj, '找出共同特色');
    const p03 = await text(proj);
    ok(p03.includes('我的故事分類') && p03.includes('閱讀故事') && p03.includes('建立自己的分類') && !/奇幻|偵探|武俠/.test(p03), '03：投影顯示任務引導，不顯示小說類型');
    await s0.screenshot({ path: path.join(OUT, 's03-start.png') });

    // 閱讀詳細故事：不改變分類
    await s0.locator('.sc:has(.sc-title:text-is("故事 C")) .sc-read').tap();
    await s0.waitForSelector('dialog.reader[open]');
    ok((await s0.textContent('dialog.reader')).includes('硯生'), '03：點故事卡內容開啟詳細介紹（長文）');
    await s0.screenshot({ path: path.join(OUT, 's03-reader.png') });
    await s0.click('dialog.reader button:has-text("關閉")');
    ok((await s0.locator('dialog.reader').count()) === 0 && (await countText(s0)) === '已分類 0 / 8', '03：關閉閱讀視窗後回到原畫面，分類沒有改變');

    // 新增分類（先分組，再命名）
    for (let i = 0; i < 3; i++) await s0.click('.bd-add');
    let bs = await boardState(s0);
    ok(bs.cats.length === 3 && bs.cats.map((c) => c.ph).join() === '分類 1,分類 2,分類 3' && bs.cats.every((c) => c.name === ''),
      '03：新增三個分類，顯示暫時名稱「分類 1～3」（名稱欄位仍為空）');

    // 三種移動方式
    await mouseDrag(s0, grip(s0, '故事 A'), cat(s0, 0));
    await waitCount(s0, 1);
    ok((await boardState(s0)).cats[0].cards.includes('故事 A'), '03：滑鼠拖曳：未分類 → 分類 1');
    await touchDrag(s0, grip(s0, '故事 B'), cat(s0, 0));
    await waitCount(s0, 2);
    ok((await boardState(s0)).cats[0].cards.includes('故事 B'), '03：觸控拖曳（手指）：未分類 → 分類 1');
    await tapMove(s0, '故事 C', cat(s0, 1));
    await waitCount(s0, 3);
    ok((await boardState(s0)).cats[1].cards.includes('故事 C'), '03：點選移動（點「移動」→ 點分類 2）');
    await tapMove(s0, '故事 A', cat(s0, 1));
    await s0.waitForTimeout(200);
    bs = await boardState(s0);
    ok(bs.cats[1].cards.join() === '故事 A,故事 C' && !bs.cats[0].cards.includes('故事 A') && (await countText(s0)) === '已分類 3 / 8',
      '03：在不同分類間移動；原位置移除、已分類數量不變');
    await touchDrag(s0, grip(s0, '故事 C'), s0.locator('.bd-left'));
    await waitCount(s0, 2);
    ok((await boardState(s0)).unplaced.includes('故事 C'), '03：拖回尚未分類區');
    await tapMove(s0, '故事 B', 'unplaced');
    await waitCount(s0, 1);
    ok((await boardState(s0)).unplaced.includes('故事 B'), '03：點選移動回尚未分類區');
    // 點閱讀不會誤觸移動
    await s0.locator('.bd-cat .sc-read').first().tap();
    await s0.waitForSelector('dialog.reader[open]');
    await s0.click('dialog.reader button:has-text("關閉")');
    ok((await countText(s0)) === '已分類 1 / 8' && (await s0.locator('.bd-movebar:not([hidden])').count()) === 0, '03：已分類的故事可重新閱讀，且不會觸發移動');

    // 刪除含故事的分類：確認後故事回到未分類
    await tapMove(s0, '故事 D', cat(s0, 2));
    await waitCount(s0, 2);
    await cat(s0, 2).locator('.bd-del').click();
    await waitText(s0, '裡面的 1 張故事會回到「尚未分類」');
    await s0.click('dialog button:has-text("刪除分類")');
    await waitCount(s0, 1);
    bs = await boardState(s0);
    ok(bs.cats.length === 2 && bs.unplaced.includes('故事 D') && bs.cats[1].cards.join() === '故事 A', '03：刪除分類後故事回到未分類，其他分類不受影響');

    // 快速連續移動多張故事（不等待），重新整理後與畫面一致
    const fast = ['故事 B', '故事 C', '故事 D', '故事 E', '故事 F', '故事 G'];
    for (const [i, t] of fast.entries()) await tapMove(s0, t, cat(s0, i % 2));
    await waitCount(s0, 7);
    // 繁體中文命名（含輸入法組字事件）
    const cdp = await s0.context().newCDPSession(s0);
    await cat(s0, 0).locator('.bd-name').tap();
    await cdp.send('Input.imeSetComposition', { text: 'ㄇㄛˊ', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.imeSetComposition', { text: '魔', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '會魔法' });
    await cdp.detach();
    await cat(s0, 1).locator('.bd-name').tap();
    await s0.keyboard.insertText('尋找');
    await s0.keyboard.insertText('祕密');
    await s0.locator('.bd-name').nth(1).press('Enter');
    const before = await boardState(s0);
    ok(before.cats[0].name === '會魔法' && before.cats[1].name === '尋找祕密', '03：直接在分類上輸入繁體中文名稱（含輸入法組字）');
    await s0.waitForTimeout(1500);   // 名稱延遲儲存
    await s0.reload();
    await waitText(s0, '已分類 7 / 8');
    ok(JSON.stringify(await boardState(s0)) === JSON.stringify(before), '03：重新整理後分類、故事位置、名稱完全恢復（快速操作沒有錯亂）');

    // 資料隔離：同組另一位學生是自己的空白分類
    await waitText(s1, '尚未分類（8）');
    ok((await s1.locator('.bd-cat').count()) === 0 && !(await text(s1)).includes('會魔法'), '03：同組學生看不到也不受另一位的分類影響');
    await s1.click('.bd-add');
    await tapMove(s1, '故事 H', cat(s1, 0));
    await waitCount(s1, 1);
    await s0.waitForTimeout(3500);
    ok(!(await boardState(s0)).cats.some((c) => c.cards.includes('故事 H')), '03：學生 B 的操作不影響學生 A');

    // 同一位學生開第二個分頁：不互相覆蓋
    const s0b = await s0.context().newPage();
    s0b.on('pageerror', (e) => errors.push('student1-tab2: ' + e.message));
    await s0b.goto(s0.url());
    await waitText(s0b, '已分類 7 / 8');
    await tapMove(s0b, '故事 H', cat(s0b, 1));
    await waitCount(s0b, 8);
    await waitCount(s0, 8);
    ok((await boardState(s0)).cats[1].cards.includes('故事 H'), '03：同一學生的第二個分頁修改後，第一個分頁同步到最新版本（不會用舊資料覆蓋）');
    await s0b.close();

    // 提交前檢查
    await tapMove(s0, '故事 H', 'unplaced');
    await waitCount(s0, 7);
    await s0.click('.pb-done');
    await waitText(s0, '還有 1 張故事尚未分類。');
    ok(true, '03：尚有故事未分類時不能提交，並提示張數');
    await s0.click('.bd-add');
    await tapMove(s0, '故事 H', cat(s0, 2));
    await waitCount(s0, 8);
    await s0.click('.pb-done');
    await waitText(s0, '請為分類 3 取一個名稱。');
    ok(!(await text(s0)).includes('已完成個人分類'), '03：有分類未命名時提示「請為分類 3 取一個名稱」');
    await s0.click('.bd-add');   // 空分類：提交時自動排除
    await cat(s0, 2).locator('.bd-name').fill('勇敢面對挑戰');
    await s0.click('.pb-done');
    await waitText(s0, '✓ 已完成個人分類');
    ok((await s0.locator('.sc-grip').count()) === 0 && (await s0.locator('.bd-cat').count()) === 3 && !(await s0.locator('.bd-add').isVisible())
      && !(await s0.locator('.bd-movebar').isVisible()) && !(await s0.locator('.bd-del').first().isVisible()), '03：提交成功後唯讀顯示成果（空分類已排除，沒有編輯控制項）');
    await s0.screenshot({ path: path.join(OUT, 's03-submitted.png') });
    await waitText(teacher, '已完成個人分類');
    await teacher.waitForFunction(() => /已完成個人分類\s*1/.test(document.querySelector('.pp-summary')?.innerText || ''), null, { timeout: 12000 });
    ok(true, '03：教師端完成人數即時更新（1 人）');

    // 繼續修改 → 重新提交
    await s0.click('button:has-text("繼續修改")');
    await s0.waitForSelector('.pb-done');
    ok((await s0.locator('.sc-grip').count()) === 8, '03：教師結束前可「繼續修改」');
    await s0.click('.pb-done');
    await waitText(s0, '✓ 已完成個人分類');
    ok(true, '03：重新提交後再次完成');

    // 教師檢視個人成果（不投影）
    await teacher.click('.pp-row:has-text("第 1 組")');
    await teacher.waitForSelector('.pp-people');
    const detail = await teacher.textContent('.pp-people');
    ok(detail.includes('8 / 8') && detail.includes('已完成') && detail.includes('1 / 8'), '03：教師展開小組看到每位學生的已分類數量與完成狀態');
    await teacher.locator('.pp-people button:has-text("查看")').first().click();
    await teacher.waitForSelector('dialog.wide .bd');
    ok((await teacher.textContent('dialog.wide')).includes('會魔法'), '03：教師可查看學生個人分類內容');
    await teacher.screenshot({ path: path.join(OUT, 't03-progress.png') });
    await proj.waitForTimeout(3500);
    ok(!(await text(proj)).includes('會魔法'), '03：教師查看時投影端不會出現個人成果');
    await teacher.click('dialog.wide button:has-text("關閉")');

    // 網路中斷：顯示未儲存，恢復後自動補存
    await s1.context().setOffline(true);
    await tapMove(s1, '故事 A', cat(s1, 0));
    await waitText(s1, '尚未儲存');
    await s1.click('.pb-done');
    await waitText(s1, '還有 6 張故事尚未分類。');
    ok(!(await text(s1)).includes('已完成個人分類'), '03：離線時顯示「尚未儲存」，不會誤顯示完成');
    await s1.context().setOffline(false);
    await waitNoText(s1, '尚未儲存', 20000);
    await s1.reload();
    await waitText(s1, '已分類 2 / 8');
    ok((await boardState(s1)).cats[0].cards.join() === '故事 A,故事 H', '03：網路恢復後自動儲存，重新整理仍是最新資料、身分不變');

    // 暫停／恢復
    await teacher.click('button:has-text("暫停個人分類")');
    await waitText(s1, '老師暫停了編輯');
    ok((await s1.locator('.sc-grip').count()) === 0 && !(await s1.locator('.bd-add').isVisible()) && !(await s1.locator('.bd-name').first().isVisible()), '03：暫停時學生不能修改（沒有移動、新增、命名欄位）');
    await s1.locator('.sc-read').first().tap();
    await s1.waitForSelector('dialog.reader[open]');
    await s1.click('dialog.reader button:has-text("關閉")');
    ok(true, '03：暫停時仍可閱讀故事');
    await teacher.click('button:has-text("恢復個人分類")');
    await waitNoText(s1, '老師暫停了編輯');
    await s1.waitForSelector('.sc-grip');
    ok((await countText(s1)) === '已分類 2 / 8', '03：恢復後回到原有成果繼續操作');

    // 版面：橫向雙欄、直向、分類增加後完成按鈕仍可見
    const l = await s2.evaluate(() => { const a = document.querySelector('.bd-left').getBoundingClientRect(); const b = document.querySelector('.bd-right').getBoundingClientRect(); return [a.width, b.width, a.top === b.top]; });
    ok(l[2] && l[0] / (l[0] + l[1]) > 0.36 && l[0] / (l[0] + l[1]) < 0.44, `03：橫向平板左右雙區（左側約 ${Math.round(l[0] / (l[0] + l[1]) * 100)}%）`);
    for (let i = 0; i < 9; i++) await s2.click('.bd-add');
    ok(await inViewport(s2, '.pb-done'), '03：分類增加到 9 組後，完成按鈕仍完整可見');
    await s2.screenshot({ path: path.join(OUT, 's03-many-landscape.png') });
    await s2.setViewportSize({ width: 820, height: 1180 });
    await s2.waitForTimeout(300);
    const pt2 = await s2.evaluate(() => { const a = document.querySelector('.bd-left').getBoundingClientRect(); const b = document.querySelector('.bd-right').getBoundingClientRect(); return a.bottom <= b.top + 1 && document.documentElement.scrollWidth <= innerWidth; });
    ok(pt2 && await inViewport(s2, '.pb-done'), '03：直向平板改為上下配置，不需縮放，完成按鈕可見');
    await tapMove(s2, '故事 E', cat(s2, 0));
    await waitCount(s2, 1);
    ok(true, '03：直向平板可正常點選移動');
    await s2.screenshot({ path: path.join(OUT, 's03-portrait.png') });
    await s2.setViewportSize({ width: 1180, height: 820 });

    // 結束個人分類：顯示未完成人數 → 返回等待 → 確認結束
    await teacher.click('button:has-text("結束個人分類，進入第四環節 →")');
    await waitText(teacher, '還有 2 位學生尚未完成個人分類');
    await teacher.click('dialog button:has-text("返回等待")');
    await teacher.waitForTimeout(500);
    ok((await teacher.textContent('.pill')).includes('03'), '03：選「返回等待」環節不變');
    await teacher.click('button:has-text("結束個人分類，進入第四環節 →")');
    await waitText(teacher, '還有 2 位學生尚未完成個人分類');
    await teacher.click('dialog button:has-text("確認結束，進入第四環節")');
    await waitText(s0, '第 1 組｜共同分類');
    ok(true, '03 → 04：教師確認後結束個人分類（未完成者不阻止進入下一環節）');

    // 返回 03 不會解除鎖定，也不會重設小組工作區
    await teacher.click('button:has-text("← 上一環節")');
    await waitText(s1, '老師已結束個人分類，你的成果已保存。');
    ok((await s1.locator('.sc-grip').count()) === 0 && (await countText(s1)) === '已分類 2 / 8', '返回 03：學生無法修改，看到的是已鎖定的成果');
    ok((await text(teacher)).includes('個人分類已結束'), '返回 03：教師端顯示個人分類已鎖定');
    await teacher.click('button:has-text("進入第四環節：小組共作 →")');

    // ---------- 04｜小組共作（Phase 3） ----------
    const G = '.gw-main';
    const gGrip = (p, t) => p.locator(`${G} .sc:has(.sc-title:text-is("${t}")) .sc-grip`);
    const gCat = (p, i) => p.locator(`${G} .bd-cat`).nth(i);
    const gCount = (p) => p.textContent(`${G} .bd-count`);
    async function gWaitCount(p, n) {
      await p.waitForFunction((s) => document.querySelector('.gw-main .bd-count')?.textContent === s, `已分類 ${n} / 8`, { timeout: 12000 });
    }
    async function gTapMove(p, title, target) {
      await gGrip(p, title).tap();
      await p.waitForSelector('.gw-main .bd-movebar:not([hidden])');
      const t = target === 'unplaced' ? p.locator(`${G} .bd-left .bd-col-title`) : target.locator('.bd-cat-head .bd-cat-n');
      await t.tap();
    }
    // 小組工作區的實際內容（用來比對各裝置是否一致）
    const gState = (p) => p.evaluate(() => {
      const m = document.querySelector('.gw-main');
      return JSON.stringify({
        unplaced: [...m.querySelectorAll('.bd-left .sc-title')].map((e) => e.textContent).sort(),
        cats: [...m.querySelectorAll('.bd-cat')].map((c) => ({
          name: c.querySelector('.bd-name').value, ph: c.querySelector('.bd-name').placeholder,
          reason: c.querySelector('.bd-reason').value,
          cards: [...c.querySelectorAll('.sc-title')].map((e) => e.textContent).sort() })),
      });
    });
    // 等到所有裝置的畫面完全相同（且符合 pred）才回傳
    async function converge(pages, pred = () => true, ms = 12000) {
      const until = Date.now() + ms;
      let last = [];
      while (Date.now() < until) {
        last = await Promise.all(pages.map(gState));
        if (last.every((x) => x === last[0]) && pred(JSON.parse(last[0]))) return last[0];
        await pages[0].waitForTimeout(300);
      }
      throw new Error('FAIL: 裝置間不一致（上一步：' + lastOk + '）\n' + last.join('\n'));
    }

    await waitText(s0, '第 1 組｜共同分類');
    await waitText(s1, '第 1 組｜共同分類');
    await waitText(proj, '一起幫故事找朋友');
    const p04 = await text(proj);
    ok(p04.includes('分享自己原本的分類想法') && p04.includes('共同建立分類並說明理由') && !p04.includes('會魔法') && !/奇幻|偵探|武俠/.test(p04),
      '04：投影顯示三步驟任務引導，不顯示任何個人或小組成果');
    ok((await s0.locator(`${G} .bd-cat`).count()) === 0 && (await gCount(s0)) === '已分類 0 / 8', '04：小組工作區從空白開始（不匯入個人分類）');
    const rail = await s0.evaluate(() => document.querySelector('.gw-panel').getBoundingClientRect().width);
    ok(!(await s0.locator('.gw-panel.open').count()) && rail >= 48 && rail <= 56, `04：左側個人面板預設收合（${Math.round(rail)}px）`);
    const t04 = await text(s0);
    ok(!/\d+ 號/.test(t04) && !t04.includes('組員：') && !t04.includes('排行'), '04：學生畫面沒有座號、組員清單或排行');

    // 補加入的第四位組員（第 1 組、04 才加入）：沒有個人快照，仍可共作
    const s3c = await ctx(browser, { viewport: { width: 1180, height: 820 }, hasTouch: true });
    const s3 = await s3c.newPage();
    s3.on('pageerror', (e) => errors.push('student4: ' + e.message));
    await s3.goto(join);
    await waitText(s3, '請選擇你的組別');
    await s3.click('.s-group:has(.n:text-is("1"))');
    await s3.click('dialog button:has-text("確認加入")');
    await waitText(s3, '第 1 組｜共同分類');
    await s3.click('.gw-toggle');
    await waitText(s3, '尚無個人分類紀錄');
    ok(true, '04：補加入的學生可直接進入小組共作，個人面板顯示「尚無個人分類紀錄」');
    await s3.click('.gw-toggle');

    // 個人參考面板：本人的原始分類、唯讀、可閱讀、只影響自己的畫面
    await s0.click('.gw-toggle');
    await waitText(s0, '會魔法');
    const pw = await s0.evaluate(() => [document.querySelector('.gw-panel').getBoundingClientRect().width, innerWidth]);
    ok(pw[0] / pw[1] > 0.26 && pw[0] / pw[1] < 0.32, `04：展開後個人面板約占 ${Math.round(pw[0] / pw[1] * 100)}%`);
    ok((await s0.locator('.gw-panel .sc-grip').count()) === 0 && (await s0.locator('.gw-panel .bd-add:visible').count()) === 0
      && (await s0.locator('.gw-panel input:visible, .gw-panel textarea:visible').count()) === 0, '04：個人面板唯讀（不能移動、新增、命名）');
    await s0.locator('.gw-panel .sc-read').first().click();
    await s0.waitForSelector('dialog.reader[open]');
    await s0.click('dialog.reader button:has-text("關閉")');
    ok(true, '04：可從個人面板重新閱讀故事');
    await s1.click('.gw-toggle');
    await waitText(s1, '個人分類尚未完成');
    ok(!(await s1.textContent('.gw-panel')).includes('會魔法'), '04：同組另一位學生看到的是自己的（未完成）個人分類，不是別人的');
    await s1.click('.gw-toggle');
    await s0.waitForTimeout(500);
    ok(await s0.locator('.gw-panel.open').count() === 1, '04：其他組員的面板操作不影響自己');
    ok(await inViewport(s0, '.gw-main .pb-done'), '04：面板展開時右側仍可操作，完成按鈕可見');
    await s0.screenshot({ path: path.join(OUT, 's04-panel-open.png') });

    // 新增分類、移動故事：三台裝置同步
    await s0.click(`${G} .bd-add`);
    await s1.click(`${G} .bd-add`);
    await s3.click(`${G} .bd-add`);
    await converge([s0, s1, s3], (x) => x.cats.length === 3);
    const st3 = JSON.parse(await gState(s0));
    ok(st3.cats.length === 3 && new Set(st3.cats.map((c) => c.ph)).size === 3, '04：三人同時新增分類，三個都保留且暫時名稱不重複（各裝置一致）');
    await gTapMove(s1, '故事 A', gCat(s1, 0));
    await touchDrag(s0, gGrip(s0, '故事 B'), gCat(s0, 0));
    await mouseDrag(s3, gGrip(s3, '故事 C'), gCat(s3, 1));
    let cs = JSON.parse(await converge([s0, s1, s3], (x) => x.cats[1]?.cards.length === 1 && x.cats[0].cards.length === 2));
    ok(cs.cats[0].cards.join() === '故事 A,故事 B' && cs.cats[1].cards.join() === '故事 C', '04：點選、觸控拖曳、滑鼠拖曳的移動都同步到全組');

    // 名稱與共同特色：中文輸入、同步、欄位鎖
    await gCat(s0, 0).locator('.bd-name').tap();
    const cdp0 = await s0.context().newCDPSession(s0);
    await cdp0.send('Input.imeSetComposition', { text: 'ㄇㄛˊ', selectionStart: 3, selectionEnd: 3 });
    await cdp0.send('Input.insertText', { text: '會魔法的故事' });
    await cdp0.detach();
    await gCat(s1, 0).locator('.bd-reason').tap();
    await s1.keyboard.insertText('主角都');
    await s0.waitForFunction(() => document.querySelectorAll('.gw-main .bd-cat')[0]?.querySelector('.bd-reason')?.readOnly, null, { timeout: 12000 });
    ok((await s0.locator(`${G} .bd-cat >> nth=0 >> .bd-lock:visible`).count()) >= 1, '04：組員輸入共同特色時，該欄位顯示「組員輸入中…」並暫時不能輸入');
    ok(await gCat(s0, 0).locator('.bd-name').evaluate((e) => !e.readOnly && document.activeElement === e), '04：同一分類的名稱仍可由另一位組員同時編輯（欄位級保護）');
    await s0.screenshot({ path: path.join(OUT, 's04-editing-lock.png') });
    // 輸入中，其他人移動故事：文字與焦點不受影響
    await gTapMove(s3, '故事 D', gCat(s3, 1));
    await s1.waitForFunction(() => document.querySelectorAll('.gw-main .bd-cat')[1]?.textContent.includes('故事 D'), null, { timeout: 12000 });
    ok(await gCat(s1, 0).locator('.bd-reason').evaluate((e) => document.activeElement === e && e.value === '主角都'),
      '04：輸入共同特色時，組員移動故事不會讓文字消失或鍵盤關閉');
    await s1.keyboard.insertText('有神奇的力量');
    await s0.locator(`${G} .bd-name`).first().press('Enter');
    await gCat(s1, 0).locator('.bd-reason').blur();
    await s1.waitForTimeout(300);
    cs = JSON.parse(await converge([s0, s1, s3], (x) => x.cats[0].reason === '主角都有神奇的力量' && x.cats[0].name === '會魔法的故事'));
    ok(cs.cats[0].name === '會魔法的故事' && cs.cats[0].reason === '主角都有神奇的力量', '04：分類名稱與共同特色同步到全組');
    await s0.waitForFunction(() => ![...document.querySelectorAll('.gw-main .bd-lock')].some((e) => !e.hidden), null, { timeout: 8000 });
    ok(true, '04：輸入完成後欄位鎖解除（其他裝置數秒內可再編輯）');

    // 故事卡操作權：A 選取故事 E 時，B 不能動 E，但可以動其他故事
    await gGrip(s0, '故事 E').tap();
    await s1.waitForSelector(`${G} .sc:has(.sc-title:text-is("故事 E")) .sc-grip-locked`, { timeout: 12000 });
    ok(true, '04：組員選取故事時，其他裝置該卡顯示「組員操作中」');
    await gTapMove(s1, '故事 F', gCat(s1, 2));
    await gWaitCount(s1, 5);
    ok(true, '04：同時間其他故事卡仍可正常操作');
    await s0.click(`${G} .bd-movebar button:has-text("取消")`);
    await s1.waitForSelector(`${G} .sc:has(.sc-title:text-is("故事 E")) .sc-grip:not(.sc-grip-locked)`, { timeout: 12000 });
    ok(true, '04：取消選取後操作權釋放');

    // 兩人同時移動同一張故事 → 結果只有一個，所有裝置一致
    await Promise.all([gTapMove(s0, '故事 G', gCat(s0, 0)), gTapMove(s3, '故事 G', gCat(s3, 2))]);
    cs = JSON.parse(await converge([s0, s1, s3]));
    const gIn = cs.cats.filter((c) => c.cards.includes('故事 G')).length + (cs.unplaced.includes('故事 G') ? 1 : 0);
    ok(gIn === 1, '04：兩人同時移動同一張故事 → 只存在一個位置，三台裝置一致');
    await s1.waitForTimeout(6500);   // 超過一次續約週期
    ok((await s1.locator(`${G} .sc-grip-locked`).count()) === 0, '04：移動完成後不會繼續佔用該卡的操作權');

    // 閱讀中，其他組員移動故事：閱讀視窗不會被關閉
    await s1.locator(`${G} .bd-left .sc-read`).first().click();
    await s1.waitForSelector('dialog.reader[open]');
    const beforeR = JSON.parse(await gState(s0)).cats[1].cards.length;
    await gTapMove(s0, JSON.parse(await gState(s0)).unplaced[0], gCat(s0, 1));
    await s1.waitForFunction((n) => document.querySelectorAll('.gw-main .bd-cat')[1]?.querySelectorAll('.sc').length === n, beforeR + 1, { timeout: 12000 });
    ok((await s1.locator('dialog.reader[open]').count()) === 1, '04：閱讀故事時，組員的操作同步進來也不會關閉閱讀視窗');
    await s1.click('dialog.reader button:has-text("關閉")');
    await gTapMove(s0, JSON.parse(await gState(s0)).cats[1].cards.slice(-1)[0], 'unplaced');
    await converge([s0, s1, s3], (x) => x.cats[1].cards.length === beforeR);

    // ---------- 複檢 F1／F5／F2：以攔截回應製造交錯（記錄實際送出的請求） ----------
    const deferred = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
    const body = (req) => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    const placeOf = (st, title) => { const i = st.cats.findIndex((c) => c.cards.includes(title)); return i; };

    // F1：A 的移動已寫入、但回應遺失；B 再把同一張卡移到別處；A 重送必須沿用原本的版本號 → 不得覆蓋 B
    if (!process.env.SKIP_F1) {
      const T = JSON.parse(await gState(s0)).cats[0].cards[0];
      const tCard = (await s0.evaluate((t) => [...document.querySelectorAll('.gw-main .sc')].find((e) => e.querySelector('.sc-title').textContent === t)?.dataset.card, T));
      const sent = []; const bDone = deferred(); let n = 0;
      await s0.route('**/rest/v1/rpc/group_move_card', async (route) => {
        const b = body(route.request());
        if (b.p_card !== tCard) return route.continue();
        sent.push(b.p_expected_rev); n++;
        if (n === 1) { await route.fetch(); return route.abort('failed'); }   // 伺服器已寫入，回應遺失
        if (!bDone.done) return route.abort('failed');                        // B 完成前的重送都失敗（A 持續重試）
        return route.continue();
      });
      await gTapMove(s0, T, gCat(s0, 1));
      await s1.waitForFunction((t) => document.querySelectorAll('.gw-main .bd-cat')[1]?.textContent.includes(t), T, { timeout: 12000 });
      await s1.waitForSelector(`${G} .sc:has(.sc-title:text-is("${T}")) .sc-grip:not(.sc-grip-locked)`, { timeout: 12000 });
      await gTapMove(s1, T, gCat(s1, 2));
      await s1.waitForFunction((t) => document.querySelectorAll('.gw-main .bd-cat')[2]?.textContent.includes(t), T, { timeout: 12000 });
      // 確認 A 已經讀到 B 的結果（A 的伺服器資料中，該卡版本已前進），之後才讓 A 的重送成功
      await s0.waitForTimeout(3500);
      bDone.done = true;
      await s0.waitForFunction(() => !document.querySelector('.gw-main .bd-status')?.textContent, null, { timeout: 25000 });
      await s0.waitForTimeout(2500);
      const fin = JSON.parse(await converge([s0, s1, s3], () => true, 20000));
      await s0.unroute('**/rest/v1/rpc/group_move_card');
      ok(sent.length >= 2 && sent.every((v) => v === sent[0]), `複檢 F1：重送沿用第一次的版本號（共 ${sent.length} 次，版本 ${[...new Set(sent)].join('、')}）`);
      ok(sent.length <= 8, `複檢 F1：寫入持續失敗時以退避重試，沒有重送風暴（${sent.length} 次）`);
      ok(placeOf(fin, T) === 2, '複檢 F1：遺失回應後的重送沒有覆蓋組員之後的移動（最後是 B 的結果）');
    }

    // F5：A 的成功回應延遲，期間 B 又移動同一張卡、A 也讀到新狀態；舊回應到達後畫面不得倒退
    if (!process.env.SKIP_F5) {
      const T = JSON.parse(await gState(s0)).cats[2].cards[0];
      const tCard = (await s0.evaluate((t) => [...document.querySelectorAll('.gw-main .sc')].find((e) => e.querySelector('.sc-title').textContent === t)?.dataset.card, T));
      const release = deferred(); const committed = deferred();
      await s0.route('**/rest/v1/rpc/group_move_card', async (route) => {
        if (body(route.request()).p_card !== tCard) return route.continue();
        const resp = await route.fetch(); committed.res();
        await release.p; return route.fulfill({ response: resp });
      });
      await gTapMove(s0, T, gCat(s0, 1));
      await committed.p;
      await s1.waitForFunction((t) => document.querySelectorAll('.gw-main .bd-cat')[1]?.textContent.includes(t), T, { timeout: 12000 });
      await s1.waitForSelector(`${G} .sc:has(.sc-title:text-is("${T}")) .sc-grip:not(.sc-grip-locked)`, { timeout: 12000 });
      await gTapMove(s1, T, gCat(s1, 0));
      await converge([s1, s3], (x) => placeOf(x, T) === 0);
      await s0.waitForTimeout(2500);          // A 的輪詢讀到 B 的結果（A 的操作仍在等待回應）
      // 舊回應放行後，延遲 A 接下來的讀取，才能觀察舊回應本身是否讓畫面倒退
      await s0.route('**/rest/v1/rpc/student_group_board', async (route) => { await new Promise((r) => setTimeout(r, 2500)); return route.continue().catch(() => {}); });
      release.res();
      await s0.waitForTimeout(600);           // 舊回應已處理、延遲的讀取尚未回來
      const st5 = JSON.parse(await gState(s0));
      await s0.unroute('**/rest/v1/rpc/group_move_card');
      await s0.unroute('**/rest/v1/rpc/student_group_board', { behavior: 'wait' });
      ok(placeOf(st5, T) === 0, '複檢 F5：延遲到達的舊回應沒有讓畫面倒退回舊位置');
      const f5 = JSON.parse(await converge([s0, s1, s3]));
      ok(placeOf(f5, T) === 0, '複檢 F5：最後全組一致為較新的結果');
    }

    // F2：A 以為持有欄位鎖（攔截為假成功），B 修改同一名稱；A 的舊文字被拒絕後，不得在沒有新輸入時再次送出
    if (!process.env.SKIP_F2) {
      const aUpdates = []; const bDone = deferred();
      await s0.route('**/rest/v1/rpc/group_lock', (route) => {
        const b = body(route.request());
        if (String(b.p_target || '').startsWith('name:')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"expires_at":"2099-01-01T00:00:00Z"}' });
        return route.continue();
      });
      await s0.route('**/rest/v1/rpc/group_update_category', async (route) => {
        const b = body(route.request());
        aUpdates.push(b.p_value);
        if (b.p_value === '甲的名稱') await bDone.p;   // 等 B 改完才送到伺服器 → 得到 STALE
        return route.continue();
      });
      await gCat(s0, 2).locator('.bd-name').tap();
      await s0.keyboard.insertText('甲的名稱');
      await s0.waitForTimeout(1000);                   // 送出（被攔住）
      await gCat(s1, 2).locator('.bd-name').tap();
      await s1.keyboard.insertText('乙的名稱');
      await gCat(s1, 2).locator('.bd-name').blur();
      await converge([s1, s3], (x) => x.cats[2].name === '乙的名稱');
      bDone.res();
      await waitText(s0, '你剛才的文字：「甲的名稱」');
      await s0.waitForTimeout(3000);                   // 觀察是否有自動重送
      const after = JSON.parse(await converge([s0, s1, s3]));
      await s0.unroute('**/rest/v1/rpc/group_update_category');
      await s0.unroute('**/rest/v1/rpc/group_lock');
      ok(aUpdates.filter((v) => v === '甲的名稱').length === 1, `複檢 F2：衝突後沒有自動重送被拒絕的舊文字（送出 ${aUpdates.length} 次）`);
      ok(after.cats[2].name === '乙的名稱', '複檢 F2：組員的新名稱保留，並提示學生自己剛才輸入的文字');
    }

    // 刪除分類：他人正在輸入該分類時不能刪除；刪除後故事回到未分類
    await gCat(s1, 2).locator('.bd-name').tap();
    await s0.waitForFunction(() => document.querySelectorAll('.gw-main .bd-cat')[2]?.querySelector('.bd-del')?.disabled, null, { timeout: 12000 });
    ok(true, '04：組員正在輸入的分類不能刪除');
    await gCat(s1, 2).locator('.bd-name').blur();
    await s0.waitForFunction(() => !document.querySelectorAll('.gw-main .bd-cat')[2]?.querySelector('.bd-del')?.disabled, null, { timeout: 12000 });
    const before3 = JSON.parse(await gState(s0)).cats[2].cards;
    await gCat(s0, 2).locator('.bd-del').click();
    await waitText(s0, '刪除「');
    await s0.click('dialog button:has-text("刪除分類")');
    cs = JSON.parse(await converge([s0, s1, s3], (x) => x.cats.length === 2));
    ok(cs.cats.length === 2 && before3.every((t) => cs.unplaced.includes(t)), '04：刪除分類後其中故事回到未分類（全組同步）');

    // 重新整理：恢復最新共同成果，不重設工作區
    await s1.reload();
    await waitText(s1, '第 1 組｜共同分類');
    await converge([s0, s1, s3]);
    ok(true, '04：重新整理後恢復最新小組成果（不重新建立工作區）');

    // 離線：暫停修改；恢復後繼續
    await s3c.setOffline(true);
    await waitText(s3, '連線中斷，重新連線後即可繼續共作。', 20000);
    ok((await s3.locator(`${G} .sc-grip`).count()) === 0, '04：離線時暫停共同修改（仍可閱讀）');
    await gTapMove(s0, '故事 H', gCat(s0, 1));
    await s3c.setOffline(false);
    await waitNoText(s3, '連線中斷', 20000);
    await converge([s0, s1, s3]);
    ok((await s3.locator(`${G} .sc-grip`).count()) > 0, '04：恢復連線後取得最新資料並可繼續共作');

    // 不同組資料隔離
    ok((await s2.locator(`${G} .bd-cat`).count()) === 0 && !(await text(s2)).includes('會魔法的故事'), '04：第二組看不到第一組的成果');

    // 教師端監控與檢視（不投影）
    await teacher.waitForFunction(() => /第 1 組[\s\S]*編輯中/.test(document.querySelector('.gp-table')?.innerText || ''), null, { timeout: 12000 });
    await teacher.click('.gp-table tr:has-text("第 1 組") button:has-text("查看")');
    await teacher.waitForSelector('dialog.wide .bd');
    ok((await teacher.textContent('dialog.wide')).includes('主角都有神奇的力量'), '04：教師可查看指定小組的分類名稱與共同特色');
    await teacher.screenshot({ path: path.join(OUT, 't04-view.png') });
    await teacher.click('dialog.wide button:has-text("關閉")');
    await proj.waitForTimeout(2500);
    ok(!(await text(proj)).includes('會魔法的故事'), '04：教師查看時投影不變');

    // 提交前檢查
    await s0.click(`${G} .pb-done`);
    await waitText(s0, '張故事尚未分類');
    ok(true, '04：尚有故事未分類時不能提交');
    const un = JSON.parse(await gState(s0)).unplaced;
    for (const t of un) await gTapMove(s0, t, gCat(s0, 1));
    await gWaitCount(s0, 8);
    await s0.click(`${G} .pb-done`);
    await waitText(s0, '請為分類 2 取一個名稱。');
    await waitText(s0, '請寫下「分類 2」的共同特色。');
    ok(true, '04：未命名、缺少共同特色時不能提交，並指出是哪個分類');
    await gCat(s3, 1).locator('.bd-name').fill('勇敢面對挑戰');
    await gCat(s3, 1).locator('.bd-reason').fill('主角都要克服困難');
    await gCat(s3, 1).locator('.bd-reason').blur();
    await converge([s0, s1, s3], (x) => x.cats[1].reason === '主角都要克服困難' && x.cats[1].name === '勇敢面對挑戰');
    // 組員正在輸入時提交 → 提示等待
    await gCat(s1, 0).locator('.bd-name').tap();
    await s0.waitForFunction(() => document.querySelectorAll('.gw-main .bd-cat')[0]?.querySelector('.bd-name')?.readOnly, null, { timeout: 12000 });
    await s0.click(`${G} .pb-done`);
    await s0.click('dialog button:has-text("確認提交")');
    await waitText(s0, '組員正在輸入或移動故事');
    ok(true, '04：組員還在輸入時不能提交（避免遺漏內容）');
    await gCat(s1, 0).locator('.bd-name').blur();
    await s0.waitForFunction(() => !document.querySelectorAll('.gw-main .bd-cat')[0]?.querySelector('.bd-name')?.readOnly, null, { timeout: 12000 });
    await s0.click(`${G} .pb-done`);
    await waitText(s0, '確定完成小組分類？');
    ok((await text(s0)).includes('提交後，全組將暫停編輯。'), '04：提交前顯示確認對話框');
    await s0.click('dialog button:has-text("確認提交")');
    for (const p of [s0, s1, s3]) await waitText(p, '小組分類已完成。');
    ok((await s1.locator(`${G} .sc-grip`).count()) === 0 && !(await s1.locator(`${G} .bd-add`).isVisible())
      && !(await s3.locator(`${G} .bd-reason`).first().isVisible()), '04：提交後全組同步為唯讀');
    await s1.locator(`${G} .sc-read`).first().click();
    await s1.waitForSelector('dialog.reader[open]');
    await s1.click('dialog.reader button:has-text("關閉")');
    ok(true, '04：提交後仍可閱讀故事、查看成果');
    await s0.screenshot({ path: path.join(OUT, 's04-submitted.png') });

    // 教師重新開放第 1 組（不影響第 2 組）→ 再次提交
    await teacher.waitForFunction(() => /第 1 組[\s\S]*已提交/.test(document.querySelector('.gp-table')?.innerText || ''), null, { timeout: 12000 });
    await teacher.click('.gp-table tr:has-text("第 1 組") button:has-text("重新開放")');
    await teacher.click('dialog button:has-text("重新開放")');
    await s1.waitForSelector(`${G} .sc-grip`, { timeout: 12000 });
    ok((await s2.locator(`${G} .bd-cat`).count()) === 0, '04：重新開放第 1 組後可再編輯，第 2 組不受影響');
    await gCat(s1, 1).locator('.bd-reason').fill('主角都要勇敢克服困難');
    await gCat(s1, 1).locator('.bd-reason').blur();
    await converge([s0, s1, s3], (x) => x.cats[1].reason === '主角都要勇敢克服困難');
    await s3.waitForFunction(() => ![...document.querySelectorAll('.gw-main .bd-lock')].some((e) => !e.hidden), null, { timeout: 8000 });
    await s3.click(`${G} .pb-done`);
    await s3.click('dialog button:has-text("確認提交")');
    for (const p of [s0, s1, s3]) await waitText(p, '小組分類已完成。');
    ok(true, '04：重新開放後再次提交');

    // 暫停全班編輯（已提交的組不受影響）
    await teacher.click('button:has-text("暫停全班編輯")');
    await waitText(s2, '老師暫停了編輯');
    ok((await s2.locator(`${G} .sc-grip`).count()) === 0, '04：暫停時學生不能修改');
    await teacher.click('button:has-text("恢復全班編輯")');
    await s2.waitForSelector(`${G} .sc-grip`, { timeout: 12000 });
    ok((await text(s0)).includes('小組分類已完成。'), '04：恢復後未提交的組可編輯，已提交的組維持已提交');
    await s2.click(`${G} .bd-add`);
    await gTapMove(s2, '故事 A', gCat(s2, 0));
    await gWaitCount(s2, 1);

    // 版面：直向平板（個人面板為抽屜）
    await s3.setViewportSize({ width: 820, height: 1180 });
    await s3.waitForTimeout(300);
    await s3.click('.gw-toggle');
    const drawer = await s3.evaluate(() => getComputedStyle(document.querySelector('.gw-panel')).position);
    ok(drawer === 'fixed' && (await s3.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), '04：直向平板時個人面板為滑出式抽屜，不需縮放');
    await s3.screenshot({ path: path.join(OUT, 's04-portrait-drawer.png') });
    await s3.click('.gw-backdrop', { position: { x: 760, y: 600 } });
    await s3.screenshot({ path: path.join(OUT, 's04-portrait.png') });
    await s3.setViewportSize({ width: 1180, height: 820 });

    // ---------- 04 → 05（結束共同分類） ----------
    await teacher.waitForFunction(() => /第 2 組\s*1\/8/.test(document.querySelector('.gp-table')?.innerText || ''), null, { timeout: 15000 });
    ok(true, '04：教師端進度依實際資料更新（第 2 組 1/8）');
    await teacher.click('text=結束共同分類，進入第五環節 →');
    await waitText(teacher, '仍有小組尚未提交');
    const dt = await teacher.textContent('dialog');
    ok(dt.includes('第 1 組：已提交') && dt.includes('第 2 組：編輯中（已分類 1/8'), '05 前：顯示各組提交狀態與進度 ' + (dt.includes('第 2 組：編輯中') ? '' : dt));
    await teacher.click('text=繼續等待');
    await teacher.waitForTimeout(500);
    ok((await teacher.textContent('.pill')).includes('04'), '05 前：選擇「繼續等待」時環節不變');
    await teacher.click('text=結束共同分類，進入第五環節 →');
    await waitText(teacher, '仍有小組尚未提交');
    await teacher.click('text=確認結束，保存各組目前成果');
    await waitText(proj, '分類成果大公開');
    ok((await teacher.textContent('.pill')).includes('05'), '05：教師確認後結束共同分類，進入第五環節');
    await s3c.close();

    // ---------- 06：私下預覽不影響投影 ----------
    await teacher.click('text=進入第六環節 →');
    await waitText(proj, '分類背後的祕密');
    await teacher.click('button.genre-btn:has-text("3. 歷史小說")');
    await waitText(teacher, '預覽（僅教師可見，尚未公開）');
    await proj.waitForTimeout(6000); // 超過輪詢週期
    ok(!(await text(proj)).includes('歷史小說'), '06：教師私下預覽時，投影畫面不改變');
    await teacher.click('text=揭開小說世界');
    await waitText(proj, '歷史小說');
    const g = await text(proj);
    ok(g.includes('歷史時代') && g.includes('真實背景') && g.includes('虛構故事'), '06：名稱與三個要素同時揭露');
    ok(!g.includes('教師補充'), '06：教師補充資料不投影');
    await proj.screenshot({ path: path.join(OUT, 'p06-genre.png') });
    await teacher.click('text=06-03 顯示五種類型總覽');
    await waitText(proj, '小說類型總覽');
    ok(!(await text(proj)).includes('奇幻小說'), '06：總覽中未公開的類型以「？」呈現');

    // ---------- 返回上一環節 ----------
    await teacher.click('button:has-text("← 上一環節")');
    await waitText(proj, '分類成果大公開');
    await teacher.click('button:has-text("下一環節 →")');
    await waitText(proj, '小說類型總覽');
    ok(true, '返回上一環節再前進，投影恢復先前的畫面狀態');

    // ---------- 07 → 結束 ----------
    await teacher.click('button:has-text("下一環節 →")');
    await waitText(proj, '小小故事分類師');
    await teacher.click('text=顯示結束畫面 →');
    await waitText(proj, '每一種分類，都從觀察開始。');
    await waitText(students[1].page, '每一種分類，都從觀察開始。');
    ok(true, '結束畫面三端同步');

    // 教師以平板尺寸操作（重要按鈕不被遮擋）
    await teacher.setViewportSize({ width: 1024, height: 768 });
    await teacher.screenshot({ path: path.join(OUT, 't99-tablet.png') });
    // 學生直向
    await students[2].page.setViewportSize({ width: 820, height: 1180 });
    await students[2].page.screenshot({ path: path.join(OUT, 's99-portrait.png') });

    ok(errors.length === 0, '沒有任何前端執行錯誤 ' + errors.join(' | '));
    ok(externalRequests.length === 0, '沒有任何外部（CDN）請求 ' + externalRequests.join(' '));
    console.log(`\n全部通過：${passed} 項`);
  } catch (e) {
    console.error(e.message);
    console.error('page errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
