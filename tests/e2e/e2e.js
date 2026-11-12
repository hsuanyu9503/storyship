// 三端端對端測試：教師主控、投影、兩台學生平板（不同瀏覽器 context＝不同裝置）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8787';
const OUT = path.join(__dirname, '.cache/shots');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const externalRequests = [];
function ok(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('ok -', msg); }

async function ctx(browser, opts = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  // 封鎖所有外部網路請求：確認網站不依賴任何 CDN（學校網路常封鎖）
  await c.route((url) => !url.href.startsWith(BASE) && !url.href.startsWith(BASE.replace('http', 'ws')), (r) => { externalRequests.push(r.request().url()); r.abort(); });
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
    await waitText(s0, '查看我的個人分類');
    ok(true, '03 → 04：教師確認後結束個人分類（未完成者不阻止進入下一環節）');

    // 04：唯讀個人成果面板（預設收合）
    ok(!(await text(s0)).includes('會魔法'), '04：個人成果面板預設收合');
    await s0.click('text=查看我的個人分類');
    await waitText(s0, '會魔法');
    ok((await s0.locator('.mp .sc-grip').count()) === 0, '04：可展開查看自己的個人分類（唯讀）');
    await s1.click('text=查看我的個人分類');
    await waitText(s1, '當時已儲存的部分');
    ok(true, '04：未完成學生的快照標示未完成，保留已儲存部分');

    // 返回 03 不會解除鎖定
    await teacher.click('button:has-text("← 上一環節")');
    await waitText(s1, '老師已結束個人分類，你的成果已保存。');
    ok((await s1.locator('.sc-grip').count()) === 0 && (await countText(s1)) === '已分類 2 / 8', '返回 03：學生無法修改，看到的是已鎖定的成果');
    ok((await text(teacher)).includes('個人分類已結束'), '返回 03：教師端顯示個人分類已鎖定');
    await teacher.click('button:has-text("進入第四環節：小組共作 →")');
    await waitText(s0, '查看我的個人分類');

    // ---------- 04 → 05（未提交確認） ----------
    // （已於 03 段落進入 04）
    await waitText(proj, '分享自己的分類想法');
    await waitText(students[2].page, '故事找朋友：小組共作');
    ok(true, '04：投影只顯示任務說明，學生端同步');
    await teacher.click('text=結束共同分類，進入成果公開 →');
    await waitText(teacher, '仍有小組尚未提交');
    await teacher.click('text=繼續等待');
    await teacher.waitForTimeout(500);
    ok((await teacher.textContent('.pill')).includes('04'), '05 前：選擇「繼續等待」時環節不變');
    await teacher.click('text=結束共同分類，進入成果公開 →');
    await waitText(teacher, '仍有小組尚未提交');
    await teacher.click('text=鎖定目前已儲存的成果並前往');
    await waitText(proj, '分類成果大公開');
    ok((await teacher.textContent('.pill')).includes('05'), '05：教師確認鎖定未提交組別後才前往');

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
