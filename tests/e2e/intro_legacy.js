// 第 01 環節複查第二輪 P1：舊場次（舊版可只公布一部就進入「故事世界的交會」）在新版教師端按下一步／上一步
//   從正常課程入口建立場次並啟動 01，再把場次狀態寫成舊版的交會畫面（模擬升級前就停在那裡的場次），重新整理教師端後操作。
//   需要：setup_story_db.sh 的 sf_story（正式教材）與對應 shim（PORT=8789）。瀏覽器模擬（Playwright Chromium）。
//   每一步檢查：投影 API 回應（整份 projection）、投影畫面文字、圖片網址與替代文字、頁面標題都沒有尚未公布的作品的
//   作品名、主角姓名、揭曉文、圖片檔名、替代文字，以及提到該主角的比較題字詞。
const { chromium } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const T_EMAIL = process.env.E2E_EMAIL || 't1@example.com';
const T_PASS = process.env.E2E_PASSWORD || 'pass';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/intro-source.json'), 'utf8'));
const [S1, S2] = SRC.stories;
const WORDS = [[S1.title, S1.name_before, S1.name_after, S1.reveal_text, 'conan', '新一'], [S2.title, S2.name_before, S2.name_after, S2.reveal_text, 'chihiro', '千尋']];
const IMG = ['assets/intro/conan-1600.webp', 'assets/intro/chihiro-1600.webp'];
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(80); } return false; }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const T = await (await browser.newContext({ viewport: { width: 1366, height: 1024 } })).newPage();
  T.on('pageerror', (e) => errors.push('teacher: ' + e.message));
  await T.goto(BASE + '/teacher.html');
  await T.fill('input[type=email]', T_EMAIL); await T.fill('input[type=password]', T_PASS); await T.click('button[type=submit]');
  await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
  const home = T.url();

  async function legacySession(seen, label) {
    await T.goto(home); await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    const code = (await T.textContent('.code b')).trim();
    const SID = (await pg.query('select id from public.sessions where join_code = $1', [code])).rows[0].id;
    const href = await T.getAttribute('a:has-text("開啟投影")', 'href');
    await T.click('text=啟動第一環節：走進故事世界 →');
    await until(async () => (await pg.query('select phase from public.session_state where session_id = $1', [SID])).rows[0].phase === '01');
    // 舊版的交會畫面（舊版 introProjection 的格式）：只列出已公布的故事；seen 為 null 時不寫入（一般新場次）
    if (seen) {
    const proj = { screen: 'intro', view: 'crossroads', ctl: { view: 'crossroads', index: seen.length ? seen[seen.length - 1] : 0, clues: 3, revealed: seen.length > 0, seen },
      stories: seen.map((i) => ({ title: [S1, S2][i].title, image_url: IMG[i] })) };
    await pg.query("update public.session_state set projection = $2, sub = '01-04', rev = rev + 1 where session_id = $1", [SID, proj]);
    await T.reload();
    }
    await T.waitForSelector('.intro-next', { timeout: 15000 });
    const P = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    P.on('pageerror', (e) => errors.push('projector: ' + e.message));
    const bodies = [];
    P.on('response', async (r) => { if (r.url().includes('/rpc/projector_state')) { try { bodies.push(await r.text()); } catch { /* 關閉 */ } } });
    await P.goto(href.startsWith('http') ? href : new URL(href, BASE + '/teacher.html').href);
    await until(() => P.evaluate(() => document.querySelector('.stage')?.dataset.screen === 'intro'));
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const proj0 = async () => (await pg.query('select projection from public.session_state where session_id = $1', [SID])).rows[0].projection;
    const visible = () => P.evaluate(() => { const st = document.querySelector('.stage');
      return [st.innerText, document.title, ...[...st.querySelectorAll('img')].flatMap((i) => [i.getAttribute('src') || '', i.getAttribute('srcset') || '', i.alt])].join('\n'); });
    const check = async (hidden, what) => {   // hidden：尚未公布的故事索引
      await sleep(400);
      const pj = JSON.stringify(await proj0()); const api = bodies[bodies.length - 1] || ''; const vis = await visible();
      const bad = hidden.flatMap((k) => WORDS[k].filter((w) => pj.includes(w) || api.includes(w) || vis.includes(w)));
      ok(bad.length === 0, `${label}・${what}：整份投影資料、API 回應、畫面、圖片與替代文字都沒有未公布作品的內容${bad.length ? '（出現：' + bad.join('、') + '）' : ''}`);
    };
    const next = async () => { await sleep(750); const r0 = await rev(); await T.locator('.intro-next').click(); await until(async () => (await rev()) === r0 + 1, 8000); await until(async () => bodies.length && JSON.stringify(await proj0()) === JSON.stringify(JSON.parse(bodies[bodies.length - 1]).projection), 5000); };
    const back = async () => { const r0 = await rev(); await T.locator('.intro-back').click(); await until(async () => (await rev()) === r0 + 1, 8000); await until(async () => bodies.length && JSON.stringify(await proj0()) === JSON.stringify(JSON.parse(bodies[bodies.length - 1]).projection), 5000); };
    const label2 = async () => (await T.locator('.intro-next').innerText()).trim();
    return { SID, P, rev, proj0, check, next, back, label2 };
  }

  try {
    // ---------- seen=[0]：只公布柯南 ----------
    {
      const L = '舊場次 seen=[0]';
      const s = await legacySession([0], L);
      await s.check([1], '交會畫面（只有柯南）');
      ok((await s.label2()) === '進入神祕故事二 →', `${L}：教師主要按鈕為「進入神祕故事二」（${await s.label2()}）`);
      await s.next();
      let c = (await s.proj0()).ctl;
      ok(c.view === 'story' && c.index === 1 && c.clues === 0 && c.revealed === false && JSON.stringify(c.seen) === '[0]', `${L}：下一步 → 神祕故事二的中性猜題頁（線索 0），保留已公布紀錄 seen=[0]`);
      ok(await until(() => s.P.evaluate(() => document.body.innerText.includes('神祕故事二') && document.body.innerText.includes('線索 0 / 3'))), `${L}：投影顯示神祕故事二、線索 0 / 3`);
      await s.check([1], '神祕故事二 線索 0');
      for (let k = 1; k <= 3; k++) { await s.next(); await s.check([1], `神祕故事二 線索 ${k}`); }
      ok((await s.label2()) === '公布作品 →', `${L}：三條線索後由老師按「公布作品」`);
      await s.next();
      c = (await s.proj0()).ctl;
      ok(c.revealed && JSON.stringify(c.seen) === '[0,1]' && (await s.proj0()).story.title === S2.title, `${L}：老師公布後才出現《${S2.title}》，seen=[0,1]`);
      await s.next();
      const cp = await s.proj0();
      ok(cp.view === 'compare' && JSON.stringify(cp.prompts) === JSON.stringify(SRC.compare_prompts) && cp.stories.length === 2, `${L}：兩部都公布後才送出原定比較題`);
      await s.next();
      ok(JSON.stringify((await s.proj0()).prompts) === JSON.stringify([...SRC.compare_prompts, SRC.naming_prompt]), `${L}：命名提問`);
      await s.next();
      ok((await s.proj0()).view === 'bridge', `${L}：轉場`);
      await s.next();
      ok(await until(async () => (await pg.query('select phase from public.session_state where session_id = $1', [s.SID])).rows[0].phase === '02', 8000), `${L}：轉場後進入 02`);
      await s.P.context().close();
    }
    // ---------- seen=[0]：上一步 ----------
    {
      const L = '舊場次 seen=[0]（上一步）';
      const s = await legacySession([0], L);
      await s.back();
      const c = (await s.proj0()).ctl;
      ok(c.view === 'story' && c.index === 0 && c.revealed === true && JSON.stringify(c.seen) === '[0]', `${L}：返回柯南的揭曉頁，seen 仍是 [0]`);
      await s.check([1], '返回後');
      await s.back();
      ok((await s.proj0()).ctl.revealed === false, `${L}：再返回收起柯南的答案`);
      await s.check([0, 1], '再返回後');
      await s.P.context().close();
    }
    // ---------- seen=[1]：只公布千尋 ----------
    {
      const L = '舊場次 seen=[1]';
      const s = await legacySession([1], L);
      await s.check([0], '交會畫面（只有千尋）');
      ok((await s.label2()) === '進入神祕故事一 →', `${L}：教師主要按鈕為「進入神祕故事一」`);
      await s.next();
      const c = (await s.proj0()).ctl;
      ok(c.view === 'story' && c.index === 0 && c.clues === 0 && !c.revealed && JSON.stringify(c.seen) === '[1]', `${L}：下一步 → 神祕故事一（線索 0），seen=[1]`);
      for (let k = 0; k <= 3; k++) { await s.check([0], `神祕故事一 線索 ${k}`); if (k < 3) await s.next(); }
      await s.next();
      ok((await s.proj0()).story.title === S1.title, `${L}：公布《${S1.title}》`);
      ok((await s.label2()) === `${SRC.compare_title} →`, `${L}：補完第一則後下一步就是「${SRC.compare_title}」（不必再猜第二則）`);
      await s.next();
      const cp = await s.proj0();
      ok(cp.view === 'compare' && JSON.stringify(cp.prompts) === JSON.stringify(SRC.compare_prompts), `${L}：直接進入比較題`);
      // 第三輪：比較頁按上一步 → 回到剛才的柯南揭曉頁（不是千尋）；再上一步 → 柯南三條線索、收起柯南，千尋仍為已公布
      await s.back();
      let pj = await s.proj0();
      ok(pj.view === 'story' && pj.story.index === 0 && pj.story.title === S1.title && pj.story.name_after === S1.name_after && JSON.stringify(pj.ctl.seen) === '[0,1]',
        `${L}：比較頁按上一步 → 回到剛才公布的《${S1.title}》揭曉頁（投影資料）`);
      ok(await until(() => s.P.evaluate((t) => document.body.innerText.includes(t) && document.body.innerText.includes('神祕故事一'), `《${S1.title}》`)), `${L}：投影畫面顯示《${S1.title}》揭曉頁`);
      ok((await s.label2()) === `${SRC.compare_title} →`, `${L}：教師端主要按鈕回到「${SRC.compare_title}」`);
      await s.back();
      pj = await s.proj0();
      ok(pj.view === 'story' && pj.story.index === 0 && pj.story.clues.length === 3 && !pj.story.title && JSON.stringify(pj.ctl.seen) === '[1]',
        `${L}：再上一步 → 柯南的三條線索、收起柯南答案，seen=[1]（千尋仍為已公布）`);
      await s.check([0], '收起柯南後');
      ok((await s.label2()) === '公布作品 →', `${L}：教師端主要按鈕為「公布作品」`);
      await s.P.context().close();
    }
    // ---------- 第三輪：一般新場次（不寫入舊狀態）柯南 → 千尋 → 比較，上一步仍回到千尋 ----------
    {
      const L = '一般新場次';
      const s = await legacySession(null, L);
      for (let i = 0; i < 11; i++) await s.next();   // 開始、柯南三條＋公布、進入故事二、三條＋公布、比較
      let pj = await s.proj0();
      ok(pj.view === 'compare' && JSON.stringify(pj.ctl.seen) === '[0,1]', `${L}：依序公布柯南、千尋後進入比較`);
      await s.back();
      pj = await s.proj0();
      ok(pj.view === 'story' && pj.story.index === 1 && pj.story.title === S2.title, `${L}：比較頁上一步 → 《${S2.title}》揭曉頁`);
      ok(await until(() => s.P.evaluate((t) => document.body.innerText.includes(t), `《${S2.title}》`)), `${L}：投影畫面顯示《${S2.title}》揭曉頁`);
      await s.back();
      pj = await s.proj0();
      ok(pj.view === 'story' && pj.story.index === 1 && pj.story.clues.length === 3 && !pj.story.title && JSON.stringify(pj.ctl.seen) === '[0]', `${L}：再上一步 → 千尋的三條線索（收起答案）`);
      await s.check([1], '收起千尋後');
      await s.P.context().close();
    }
    // ---------- seen=[]：沒有任何公布 ----------
    {
      const L = '舊場次 seen=[]';
      const s = await legacySession([], L);
      await s.check([0, 1], '交會畫面（空）');
      await s.next();
      const c = (await s.proj0()).ctl;
      ok(c.view === 'story' && c.index === 0 && c.clues === 0 && !c.revealed, `${L}：下一步 → 神祕故事一（線索 0）`);
      await s.check([0, 1], '神祕故事一 線索 0');
      await s.P.context().close();
    }
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n01 舊場次前進／返回：通過 ${passed} 項，失敗 ${fails.length} 項`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
