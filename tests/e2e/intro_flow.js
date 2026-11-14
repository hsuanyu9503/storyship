// 第 01 環節「走進故事世界」：從正常課程入口（教師登入 → 建立場次 → 開啟投影 → 學生加入 → 啟動第一環節）走完整個猜作品活動
//   需要：tests/e2e/setup_story_db.sh 建立的 sf_story（已套用 intro_materials_v1.sql 與 story_cards_v1.sql）與對應的 shim（PORT=8789）。
//   瀏覽器模擬（Playwright Chromium），不是實體投影機或平板。
//   檢查：
//     1. 文案與 Word 原稿（docs/intro-source.json）逐字相同：開場語、線索、揭曉說明、比較提問、命名提問、轉場文字
//     2. 兩則故事都逐條揭露三條線索（已出現的保留）；第三條後停留，直到按「公布作品」；不自動前進
//     3. 揭曉前：投影 API 回應、投影畫面文字、頁面標題、圖片網址與替代文字、學生端都沒有作品名稱、角色名字或圖片
//     4. 公布後：圖片、作品名稱、名字變化、揭曉說明正確配對；圖片為 WebP、替代文字正確、版位固定不推動文字
//     5. 上一步：從揭曉返回時圖片與答案一起收起；再前進內容正確；跨故事返回；返回開場
//     6. 觸控連點只前進一步；鍵盤（→／PageDown、←／PageUp）
//     7. 16:9（1920×1080、1366×768、1280×720）、4:3（1024×768）與窄螢幕（768×1024、390×844）：線索、圖片、文字都完整可讀；教師按鈕可操作
//     8. 比較 → 命名 → 轉場 → 進入 02 → 03 故事卡分類仍可使用（八張卡、移動、閱讀卡）
const { chromium, devices } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const T_EMAIL = process.env.E2E_EMAIL || 't1@example.com';
const T_PASS = process.env.E2E_PASSWORD || 'pass';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
const OUT = path.join(__dirname, '.cache/intro');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const SRC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/intro-source.json'), 'utf8'));
const [S1, S2] = SRC.stories;
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch { /* 重畫中 */ } await sleep(120); } return false; }
// 會洩漏答案的字（作品名稱、角色名字、圖片檔名）
const LEAK1 = ['名偵探柯南', '柯南', '工藤', '新一', 'conan'];
const LEAK2 = ['神隱少女', '神隱', '千尋', '荻野', '小千', 'chihiro'];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ---------- 正常課程入口 ----------
    const tc = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true });
    const T = await tc.newPage(); T.on('pageerror', (e) => errors.push('teacher: ' + e.message));
    await T.goto(BASE + '/teacher.html');
    await T.fill('input[type=email]', T_EMAIL); await T.fill('input[type=password]', T_PASS); await T.click('button[type=submit]');
    await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    const code = (await T.textContent('.code b')).trim();
    const SID = (await pg.query('select id from public.sessions where join_code = $1', [code])).rows[0].id;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const projHref = await T.getAttribute('a:has-text("開啟投影")', 'href');
    const pc = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const P = await pc.newPage(); P.on('pageerror', (e) => errors.push('projector: ' + e.message));
    const bodies = []; const imgReq = [];
    P.on('response', async (r) => { if (r.url().includes('/rpc/projector_state')) { try { bodies.push(await r.text()); } catch { /* 關閉 */ } } });
    P.on('request', (r) => { if (/\/assets\/intro\//.test(r.url())) imgReq.push(r.url().replace(/^.*\/assets\/intro\//, '')); });
    await P.goto(projHref.startsWith('http') ? projHref : new URL(projHref, BASE + '/teacher.html').href);
    await P.waitForFunction(() => document.body.innerText.includes('各組加入狀態'));
    const sc = await browser.newContext({ ...devices['iPad Mini'] });
    const S = await sc.newPage(); S.on('pageerror', (e) => errors.push('student: ' + e.message));
    await S.goto(`${BASE}/join.html?code=${code}`);
    await S.waitForSelector('.s-group'); await S.locator('.s-group:has(.n:text-is("1"))').tap(); await S.locator('dialog button:has-text("確認加入")').tap();
    await S.waitForFunction(() => document.body.innerText.includes('已加入第 1 組'));

    // 畫面狀態
    const view = () => P.evaluate(() => {
      const st = document.querySelector('.stage');
      return { text: st.innerText, title: document.title, screen: st.dataset.screen,
        imgs: [...st.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src') || '', srcset: i.getAttribute('srcset') || '', cur: (i.currentSrc || '').replace(/^.*\/assets\/intro\//, ''), alt: i.alt,
          loaded: i.complete && i.naturalWidth > 0 })),
        labels: [...st.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')),
        clues: [...st.querySelectorAll('.st-clue2:not(.pending)')].map((li) => ({ label: li.querySelector('.st-clue2-label').innerText, body: li.querySelector('.st-clue2-body').innerText })),
        pending: st.querySelectorAll('.st-clue2.pending').length };
    });
    const noLeak = async (words, label) => {
      const v = await view(); const last = bodies[bodies.length - 1] || '';
      const hay = [v.text, v.title, ...v.imgs.flatMap((i) => [i.src, i.srcset, i.alt]), ...v.labels].join('\n');
      const st = await S.evaluate(() => document.body.innerText + document.title);
      const bad = words.filter((w) => hay.includes(w) || last.includes(w) || st.includes(w));
      ok(bad.length === 0, `${label}：投影畫面、頁面標題、圖片網址與替代文字、投影 API 回應、學生端都沒有答案${bad.length ? '（出現：' + bad.join('、') + '）' : ''}`);
    };
    const btn = (re) => T.locator('.intro-btns button').filter({ hasText: re });
    const nextBtn = () => T.locator('.intro-next');
    const nextLabel = async () => (await nextBtn().innerText()).trim();
    async function step(expectRevDelta = 1) {
      const r0 = await rev(); const b0 = bodies.length;
      await nextBtn().tap();
      await until(async () => (await rev()) === r0 + expectRevDelta && bodies.length > b0, 8000);
      await until(async () => (await view()).screen === 'intro', 4000);
      await sleep(250);
    }
    async function back() {
      const r0 = await rev(); const b0 = bodies.length;
      await T.locator('.intro-back').tap();
      await until(async () => (await rev()) === r0 + 1 && bodies.length > b0, 8000);
      await sleep(250);
    }
    const shot = (n) => P.screenshot({ path: path.join(OUT, n + '.png') });

    // ---------- 開場 ----------
    await T.click('text=啟動第一環節：走進故事世界 →');
    await until(async () => (await view()).text.includes(SRC.opening), 10000);
    let v = await view();
    ok(v.text.includes(SRC.unit_title) && v.text.includes(SRC.opening), `開場：單元名稱「${SRC.unit_title}」與開場語（與原稿相同）`);
    await noLeak([...LEAK1, ...LEAK2], '開場');
    ok(await until(async () => (await S.innerText('body')).includes('請觀看前方投影'), 10000), '開場：學生端顯示觀看投影');
    ok(imgReq.length === 0, `開場：沒有下載任何揭曉圖（${imgReq.length}）`);
    await shot('01-open');
    ok((await nextLabel()).startsWith('開始：神祕故事一'), `教師主要按鈕：「${await nextLabel()}」`);
    ok(await T.locator('.intro-back').isDisabled(), '開場時「上一步」不可用（已是第一步）');

    // ---------- 兩則故事 ----------
    for (const [si, s, leak, other] of [[0, S1, LEAK1, LEAK2], [1, S2, LEAK2, []]]) {
      const name = s.neutral;
      if (si === 0) await step(); else await step();
      v = await view();
      ok(v.text.includes(name) && v.text.includes('線索 0 / 3') && v.clues.length === 0 && v.pending === 3, `${name}：從尚未揭露線索的狀態開始（三個空白位置、只顯示中性名稱）`);
      await noLeak([...leak, ...other], `${name} 線索 0`);
      for (let k = 0; k < 3; k++) {
        ok((await nextLabel()) === '顯示下一條線索 →', `${name}：按鈕為「顯示下一條線索」（第 ${k + 1} 條前）`);
        await step();
        v = await view();
        const want = s.clues.slice(0, k + 1);
        ok(v.clues.length === k + 1 && v.pending === 2 - k && want.every((c, j) => v.clues[j].body === c.body && v.clues[j].label === `線索${c.no}\n${c.label}`.replace('\n', '') || v.clues[j].label.replace(/\s+/g, '') === `線索${c.no}${c.label}`),
          `${name}：顯示第 ${k + 1} 條線索「${s.clues[k].label}」，前面的線索保留（內文與原稿相同）`);
        await noLeak([...leak, ...other], `${name} 線索 ${k + 1}`);
        if (si === 1 && k === 2) await shot('02-story2-clues3');
        if (si === 0 && k === 2) await shot('02-story1-clues3');
      }
      ok((await nextLabel()) === '公布作品 →', `${name}：第三條出現後，下一步是「公布作品」`);
      const r0 = await rev();
      await sleep(3000);
      v = await view();
      ok((await rev()) === r0 && v.clues.length === 3 && !v.imgs.length, `${name}：第三條後停留可討論的畫面（3 秒內沒有自動前進、沒有圖片）`);
      // 觸控連點：只前進一步
      const r1 = await rev();
      const box = await nextBtn().boundingBox();
      await T.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await T.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await until(async () => (await view()).imgs.length > 0, 8000);
      await sleep(1200);
      ok((await rev()) === r1 + 1, `${name}：「公布作品」連點兩下只前進一步（版本 ${r1} → ${await rev()}）`);
      await until(async () => (await view()).imgs.every((i) => i.loaded), 8000);
      v = await view();
      const img = v.imgs[0] || {};
      const file = si === 0 ? 'conan' : 'chihiro';
      ok(v.imgs.length === 1 && img.loaded && new RegExp(`^${file}-(960|1600)\\.webp$`).test(img.cur) && img.alt.includes(`《${s.title}》`),
        `${name} 公布：作品圖 ${img.cur}（WebP）、替代文字「${img.alt}」`);
      ok(v.text.includes(`《${s.title}》`) && v.text.replace(/\s+/g, '').includes(`${s.name_before}→${s.name_after}`) && v.text.includes(s.reveal_text),
        `${name} 公布：《${s.title}》、${s.name_before} → ${s.name_after}、揭曉說明（與原稿相同）`);
      ok(s.clues.every((c) => v.text.includes(c.body)), `${name} 公布：三條線索仍在畫面上供對照`);
      if (other.length) await noLeak(other, `${name} 公布後（另一則尚未公布）`);
      await shot(si === 0 ? '03-reveal-conan' : '05-reveal-chihiro');
      // 圖片版位固定：圖片框比例 16:9，圖片完整呈現在框內
      const g = await P.evaluate(() => { const b = document.querySelector('.st-reveal2-img .st-visual').getBoundingClientRect(); const i = document.querySelector('.st-reveal2-img img').getBoundingClientRect();
        return { ratio: b.width / b.height, inside: i.left >= b.left - .5 && i.right <= b.right + .5 && i.top >= b.top - .5 && i.bottom <= b.bottom + .5 }; });
      ok(Math.abs(g.ratio - 16 / 9) < 0.01 && g.inside, `${name} 公布：圖片框 16:9（${g.ratio.toFixed(3)}），圖片完整在框內`);
      // 返回：圖片與答案一起收起，再前進內容正確
      await back();
      v = await view();
      ok(v.imgs.length === 0 && v.clues.length === 3 && !v.text.includes(s.title) && !v.text.includes(s.name_after), `${name}：從揭曉按「上一步」→ 回到三條線索，圖片與答案一起收起`);
      await noLeak([...leak, ...other], `${name} 返回猜題`);
      ok((await nextLabel()) === '公布作品 →', `${name}：返回後下一步仍是「公布作品」`);
      // 鍵盤：→ 再次公布
      await T.locator('h2').first().click();   // 焦點不在輸入欄位
      const r2 = await rev();
      await T.keyboard.press('ArrowRight');
      await until(async () => (await rev()) === r2 + 1, 8000);
      await until(async () => (await view()).imgs.some((i) => i.loaded), 8000);
      v = await view();
      ok(v.text.includes(`《${s.title}》`) && v.text.replace(/\s+/g, '').includes(`${s.name_before}→${s.name_after}`) && v.imgs[0]?.alt.includes(s.title),
        `${name}：鍵盤 → 再次公布，圖片與名字仍正確配對`);
      if (si === 1) {
        // 跨故事返回：從神祕故事二的開頭按上一步回到故事一的揭曉
        await back(); await back(); await back(); await back();
        v = await view();
        ok(v.text.includes('神祕故事二') && v.clues.length === 0 && v.imgs.length === 0, '神祕故事二：連按上一步回到「線索 0」');
        await T.locator('h2').first().click();
        const r3 = await rev(); await T.keyboard.press('PageUp');
        await until(async () => (await rev()) === r3 + 1, 8000); await sleep(300);
        await until(async () => (await view()).imgs.some((i) => i.loaded), 8000);
        v = await view();
        ok(v.text.includes('神祕故事一') && v.text.includes(`《${S1.title}》`) && v.imgs[0]?.alt.includes(S1.title) && !v.text.includes(S2.title),
          '鍵盤 PageUp：從神祕故事二開頭返回神祕故事一的揭曉（柯南圖、柯南名字）');
        await T.keyboard.press('PageDown'); await until(async () => (await view()).text.includes('神祕故事二'), 8000);
        for (let k = 0; k < 4; k++) await step();
        v = await view();
        ok(v.text.includes(`《${S2.title}》`) && v.imgs[0]?.alt.includes(S2.title) && !v.text.includes(S1.title), '再次前進：神祕故事二重新逐條揭露並公布，配對正確');
      }
      ok((await nextLabel()) === (si === 0 ? '進入神祕故事二 →' : `${SRC.compare_title} →`), `${name} 公布後由老師決定何時繼續（按鈕：「${await nextLabel()}」）`);
    }

    // ---------- 尺寸：最長線索、揭曉、窄螢幕 ----------
    const measure = () => P.evaluate(() => {
      const st = document.querySelector('.stage'); const sr = st.getBoundingClientRect();
      const narrow = innerWidth <= innerHeight;
      const els = [...st.querySelectorAll('.st-clue2-body, .st-clue2-label, .st-reveal2-title, .st-names, .st-reveal2-desc, .st-clue-recap li, .st-visual, .st-ic-prompt, .st-ic-title, .st-intro-opening, .st-title, .st-chip')];
      const bad = [];
      for (const el of els) {
        const b = el.getBoundingClientRect();
        let box = narrow ? { top: -1e9, bottom: 1e9, left: 0, right: innerWidth } : { top: sr.top, bottom: sr.bottom, left: sr.left, right: sr.right };
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') { const r = a.getBoundingClientRect(); if (a === document.documentElement) continue;
            box = { top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom), left: Math.max(box.left, r.left), right: Math.min(box.right, r.right) }; }
        }
        if (b.width && (b.bottom > box.bottom + 1 || b.top < box.top - 1 || b.right > box.right + 1 || b.left < box.left - 1 || el.scrollHeight > el.clientHeight + 2))
          bad.push(el.className + '「' + el.textContent.slice(0, 10) + '」');
      }
      const fonts = [...st.querySelectorAll('.st-clue2-body')].map((e) => parseFloat(getComputedStyle(e).fontSize));
      return { bad, minClue: fonts.length ? Math.min(...fonts) : null, hscroll: document.documentElement.scrollWidth > innerWidth + 1, docH: document.documentElement.scrollHeight, vh: innerHeight };
    });
    const SIZES = [[1920, 1080], [1366, 768], [1280, 720], [1024, 768], [768, 1024], [390, 844]];
    async function checkSizes(label, shotName) {
      for (const [w, hh] of SIZES) {
        await P.setViewportSize({ width: w, height: hh }); await sleep(350);
        const m = await measure();
        ok(m.bad.length === 0 && !m.hscroll && (m.minClue == null || m.minClue >= (w <= hh ? 19.9 : 0)),
          `${w}x${hh} ${label}：全部文字與圖片完整可讀${m.bad.length ? '（被裁切：' + m.bad.join('；') + '）' : ''}${m.minClue ? `，線索字級 ${m.minClue.toFixed(1)}px` : ''}${w <= hh ? `，頁面高 ${m.docH}px 可捲動` : ''}`);
        if (shotName && (w === 1366 || w === 390)) await P.screenshot({ path: path.join(OUT, `${shotName}-${w}x${hh}.png`), fullPage: true });
      }
      await P.setViewportSize({ width: 1920, height: 1080 }); await sleep(300);
    }
    // 目前在神祕故事二已公布 → 回到三條線索（最長線索在這一則）量測猜題畫面，再前進量測揭曉
    await back();
    await checkSizes('神祕故事二・三條線索（最長線索）', 'size-story2-clues');
    await T.locator('h2').first().click(); await T.keyboard.press('ArrowRight');
    await until(async () => (await view()).imgs.some((i) => i.loaded), 8000);
    await checkSizes('神祕故事二・公布', 'size-story2-reveal');

    // ---------- 比較、命名、轉場 ----------
    await step();
    await until(async () => (await view()).text.includes(SRC.compare_title), 8000);
    v = await view();
    ok(v.text.includes(SRC.compare_title) && SRC.compare_prompts.every((q) => v.text.includes(q)) && !v.text.includes(SRC.naming_prompt), '兩個故事放在一起：先顯示比較提問（命名提問尚未出現）');
    ok([S1, S2].every((s) => v.text.includes(`《${s.title}》`) && v.text.replace(/\s+/g, '').includes(`${s.name_before}→${s.name_after}`)), '兩個故事放在一起：同時呈現兩組名字變化（與原稿相同）');
    await until(async () => (await view()).imgs.every((i) => i.loaded), 8000);
    v = await view();
    ok(v.imgs.length === 2 && v.imgs[0].alt.includes(S1.title) && v.imgs[1].alt.includes(S2.title), '兩個故事放在一起：兩張圖依序對應兩部作品');
    await shot('06-compare');
    ok((await nextLabel()) === '下一個提問 →', '比較畫面：下一步是「下一個提問」');
    await step();
    v = await view();
    ok(v.text.includes(SRC.naming_prompt) && SRC.compare_prompts.every((q) => v.text.includes(q)), '命名提問出現（比較提問保留），開放討論');
    await checkSizes('兩個故事放在一起＋命名提問', 'size-compare');
    await shot('07-naming');
    ok((await nextLabel()) === `${SRC.bridge_title} →`, `下一步：「${SRC.bridge_title}」`);
    await step();
    v = await view();
    ok(v.text.includes(SRC.bridge_title) && v.text.includes(SRC.bridge_text), '轉場：「接下來，換你分類」與原稿轉場文字');
    await checkSizes('轉場', null);
    await shot('08-bridge');
    ok((await nextLabel()).includes('進入下一環節：分類任務啟動'), `轉場後主要按鈕：「${await nextLabel()}」`);
    await back();
    ok((await view()).text.includes(SRC.naming_prompt), '轉場按上一步回到命名提問');
    await step();

    // ---------- 教師按鈕：各種寬度可操作 ----------
    for (const [w, hh] of [[1366, 1024], [1024, 768], [768, 1024], [390, 844]]) {
      await T.setViewportSize({ width: w, height: hh }); await sleep(300);
      await nextBtn().scrollIntoViewIfNeeded();
      const m = await T.evaluate(() => ['.intro-next', '.intro-back'].map((s) => { const el = document.querySelector(s); const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { w: Math.round(b.width), h: Math.round(b.height), vis: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth, hit: Boolean(hit && el.contains(hit)) }; }));
      ok(m.every((x) => x.vis && x.hit && x.h >= 44 && x.w >= 44) && await T.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `教師端 ${w}x${hh}：「下一步」與「上一步」可見、未被遮住、≥44px（${m.map((x) => `${x.w}×${x.h}`).join('、')}）`);
      if (w === 390 || w === 1366) await T.screenshot({ path: path.join(OUT, `teacher-${w}x${hh}.png`) });
    }
    await T.setViewportSize({ width: 1366, height: 1024 });

    // ---------- 進入 02 → 03：既有的故事卡分類仍可使用 ----------
    await nextBtn().tap();
    await until(async () => (await view()).text.includes('仔細觀察故事的共同特色'), 10000);
    ok(true, '轉場後進入 02「分類任務啟動」（原有課程順序）');
    await T.click('button:has-text("開放第三環節：我的故事分類")');
    ok(await until(() => S.evaluate(() => document.querySelectorAll('.sc-read').length === 8), 15000), '03：學生看板有八張故事卡');
    await S.locator('.bd-add').tap(); await S.waitForSelector('.bd-cat');
    await S.locator('.sc:has(.sc-title:text-is("神奇柑仔店")) .sc-grip').tap(); await S.waitForSelector('.bd-movebar:not([hidden])');
    await S.locator('.bd-cat .bd-cat-n').first().tap();
    ok(await until(async () => (await S.textContent('.bd-count')) === '已分類 1 / 8', 6000), '03：點選移動把故事放進分類');
    await S.locator('.sc:has(.sc-title:text-is("寶可夢")) .sc-read').tap();
    await S.waitForSelector('dialog.reader[open]');
    await S.locator('dialog.reader[open] .sr-front .sr-flip').tap();
    ok(await until(() => S.evaluate(() => document.querySelector('.sr-card')?.dataset.side === 'back'), 3000), '03：故事卡閱讀卡可開啟並翻面');
    await S.locator('dialog.reader[open] .sr-close').tap();
    ok(errors.length === 0, `頁面沒有 JavaScript 錯誤（${errors.join(' | ') || '無'}）`);
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  console.log(`\n第 01 環節：通過 ${passed} 項，失敗 ${fails.length} 項（截圖：${OUT}）`);
  if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
})();
