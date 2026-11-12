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

    // ---------- 03 ----------
    await teacher.click('text=開放第三環節：我的故事分類 →');
    await waitText(students[0].page, '故事 H');
    ok((await students[0].page.locator('.s-card').count()) === 8, '03：學生端讀到 8 張故事卡');
    await students[0].page.screenshot({ path: path.join(OUT, 's03-cards.png') });

    // ---------- 04 → 05（未提交確認） ----------
    await teacher.click('text=進入第四環節：小組共作 →');
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
