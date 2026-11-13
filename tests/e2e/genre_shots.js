// 小說類型教材：第 06／07 實際畫面截圖＋圖片載入紀錄（需要 shim，資料庫已套用 genre_materials_v1.sql）
//   投影 1600×900、1920×1080：06 五種類型（直式）、06 總覽、07 五種類型（橫式）
//   教師平板（iPad 橫向／直向，裝置像素比 2）：06、07 面板與預覽
// 每個畫面記錄瀏覽器實際選用的圖片檔（currentSrc）與下載過的類型圖片，檢查：只下載需要的圖、06 直式、07 橫式、WebP、沒有水平捲動。
const { chromium, devices } = require('playwright');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:8787';
const OUT = path.join(__dirname, '.cache/genre-shots'); fs.mkdirSync(OUT, { recursive: true });
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_e2e' });
const SLUGS = ['fantasy', 'detective', 'historical', 'adventure', 'wuxia'];
let passed = 0; const fails = []; const log = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ANON = ''; let TT = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(fn + ': ' + t); return t ? JSON.parse(t) : null;
}
const imgState = (page) => page.evaluate(() => {
  const im = document.querySelector('.stage .st-visual img');
  return im ? { loaded: im.complete && im.naturalWidth > 0, src: (im.currentSrc || '').replace(/^.*\/assets\/genres\//, ''), box: Math.round(im.getBoundingClientRect().width), dpr: devicePixelRatio } : null;
});
async function settle(page, ms = 15000) {
  const t = Date.now() + ms;
  while (Date.now() < t) { const s = await imgState(page); if (s?.loaded) { await sleep(350); return s; } await sleep(150); }
  return imgState(page);
}

(async () => {
  const browser = await chromium.launch();
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;
    const cr = await api('teacher_create_session', { p_title: '小說類型教材', p_group_count: 2 }, TT);
    const SID = cr.session_id;
    const pk = (await pg.query('select projector_key from public.sessions where id = $1', [SID])).rows[0].projector_key;
    const rev = async () => (await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev;
    const stage = async (phase, sub, proj) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: sub, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: true }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    // 一組學生提交一個分類（07 需要成果）
    const tok = require('crypto').createHash('sha256').update('shots' + SID).digest('hex');
    await api('student_join', { p_code: cr.join_code, p_token: tok, p_group_number: 1 });
    await stage('04', '04', { screen: 'instruction' });
    const cat = '7d000000-0000-4000-8000-000000000001';
    await api('group_add_category', { p_session: SID, p_token: tok, p_category: cat });
    await api('group_update_category', { p_session: SID, p_token: tok, p_category: cat, p_field: 'name', p_value: '主角都要面對困難', p_expected_rev: 1 });
    await api('group_update_category', { p_session: SID, p_token: tok, p_category: cat, p_field: 'reason', p_value: '這些故事的主角都遇到危險，最後想辦法解決。', p_expected_rev: 1 });
    const cards = (await pg.query(`select id from public.story_cards order by sort_order limit 4`)).rows;
    for (const c of cards) await api('group_move_card', { p_session: SID, p_token: tok, p_card: c.id, p_category: cat, p_expected_rev: 0 });

    for (const [w, hgt] of [[1600, 900], [1920, 1080]]) {
      const pc = await browser.newContext({ viewport: { width: w, height: hgt } });
      const P = await pc.newPage();
      const got = [];
      P.on('response', (r) => { if (r.url().includes('/assets/genres/')) got.push({ f: r.url().replace(/^.*\/assets\/genres\//, ''), type: r.headers()['content-type'] || '', bytes: Number(r.headers()['content-length'] || 0) }); });
      await P.goto(`${BASE}/projector.html?s=${SID}&k=${pk}`);
      for (let i = 0; i < 5; i++) {
        const before = got.length;
        await stage('06', '06-02', { screen: 'genre', view: 'genre', ctl: { view: 'genre', index: i, reveal: true } });
        await P.waitForFunction((n) => document.body.innerText.includes(n), ['奇幻', '偵探', '歷史', '冒險', '武俠'][i], { timeout: 15000 });
        const s = await settle(P);
        const fetched = got.slice(before).map((x) => x.f);
        log.push({ view: `06 ${SLUGS[i]}`, size: `${w}×${hgt}`, chosen: s?.src, boxCssPx: s?.box, fetched: fetched.join(' ') });
        ok(s?.loaded && new RegExp(`^${SLUGS[i]}-portrait(-600w)?\\.webp$`).test(s.src) && fetched.every((f) => f.startsWith(`${SLUGS[i]}-portrait`)),
          `投影 ${w}×${hgt}｜06 ${SLUGS[i]}：直式（選用 ${s?.src}，圖片框 ${s?.box}px；下載 ${fetched.join('、') || '（快取）'}）`);
        await P.screenshot({ path: path.join(OUT, `projector-${w}-06-${SLUGS[i]}.png`) });
      }
      await stage('06', '06-03', { screen: 'genre', view: 'overview', ctl: { view: 'overview', index: 0 } });
      await P.waitForFunction(() => document.body.innerText.includes('小說類型總覽'), null, { timeout: 15000 }); await sleep(400);
      await P.screenshot({ path: path.join(OUT, `projector-${w}-06-overview.png`) });
      await stage('07', '07', { screen: 'placeholder', title: '小小故事分類師' });
      const snap = (await pg.query(`select id from public.group_snapshots where session_id = $1 order by created_at desc limit 1`, [SID])).rows[0].id;
      for (let i = 0; i < 5; i++) {
        const before = got.length;
        const r = await api('teacher_publish_match', { p_session: SID, p_ctl: { snapshot: snap, category: cat, show_reason: true, genre: i, elements: [0, 1], highlights: [0], scaffold: true }, p_expected_rev: await rev() }, TT);
        if (!r.ok) throw new Error(JSON.stringify(r));
        await P.waitForFunction((n) => document.querySelector('.st-match-gname')?.textContent === n, ['奇幻', '偵探', '歷史', '冒險', '武俠'][i], { timeout: 15000 });
        const s = await settle(P);
        const fetched = got.slice(before).map((x) => x.f);
        log.push({ view: `07 ${SLUGS[i]}`, size: `${w}×${hgt}`, chosen: s?.src, boxCssPx: s?.box, fetched: fetched.join(' ') });
        ok(s?.loaded && new RegExp(`^${SLUGS[i]}-landscape(-960w)?\\.webp$`).test(s.src) && fetched.every((f) => f.startsWith(`${SLUGS[i]}-landscape`)),
          `投影 ${w}×${hgt}｜07 ${SLUGS[i]}：橫式（選用 ${s?.src}，圖片框 ${s?.box}px；下載 ${fetched.join('、') || '（快取）'}）`);
        await P.screenshot({ path: path.join(OUT, `projector-${w}-07-${SLUGS[i]}.png`) });
      }
      ok(got.every((x) => x.type.includes('image/webp')), `投影 ${w}×${hgt}：所有類型圖片都是 WebP（共 ${got.length} 次下載）`);
      ok(new Set(got.map((x) => x.f)).size === got.length, `投影 ${w}×${hgt}：同一張圖沒有重複下載`);
      await pc.close();
    }

    // 教師平板（iPad，DPR 2）：06、07
    await stage('06', '06-02', { screen: 'genre', view: 'genre', ctl: { view: 'genre', index: 2, reveal: true } });
    for (const [dev, orient] of [['iPad (gen 7) landscape', 'landscape'], ['iPad (gen 7)', 'portrait']]) {
      const tc = await browser.newContext({ ...devices[dev] });
      const T = await tc.newPage();
      const got = [];
      T.on('response', (r) => { if (r.url().includes('/assets/genres/')) got.push(r.url().replace(/^.*\/assets\/genres\//, '')); });
      await T.goto(`${BASE}/teacher.html#/s/${SID}`);
      await T.waitForSelector('input[type=email], .genre-pick, .rs-grid, .step', { timeout: 15000 });
      if (await T.locator('input[type=email]').count()) {
        await T.fill('input[type=email]', process.env.E2E_EMAIL || 't1@example.com'); await T.fill('input[type=password]', process.env.E2E_PASSWORD || 'pass'); await T.click('button[type=submit]');
      }
      await T.waitForSelector('.genre-pick', { timeout: 15000 });
      await T.locator('button.genre-btn:has-text("3. 歷史")').click();
      await sleep(1500);
      const imgs = await T.evaluate(() => [...document.querySelectorAll('.previews .st-visual img')].map((im) => ({ src: (im.currentSrc || '').replace(/^.*\/assets\/genres\//, ''), w: Math.round(im.getBoundingClientRect().width), ok: im.complete && im.naturalWidth > 0 })));
      log.push({ view: '教師 06 預覽', size: orient, chosen: imgs.map((x) => `${x.src}（${x.w}px）`).join('、'), fetched: got.join(' ') });
      ok(imgs.length >= 1 && imgs.every((x) => x.ok && /^historical-portrait/.test(x.src)) && await T.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `教師平板 ${orient}｜06：預覽與投影中的圖都是直式（${imgs.map((x) => `${x.src} ${x.w}px`).join('、')}）、沒有水平捲動`);
      ok((await T.textContent('body')).includes('教師補充') && (await T.textContent('body')).includes('赤壁圖片為情境插畫'), `教師平板 ${orient}｜06：教師補充可見`);
      await T.screenshot({ path: path.join(OUT, `teacher-ipad-${orient}-06.png`), fullPage: true });
      await tc.close();
    }
    await stage('07', '07', { screen: 'placeholder' });
    for (const [dev, orient] of [['iPad (gen 7) landscape', 'landscape'], ['iPad (gen 7)', 'portrait']]) {
      const tc = await browser.newContext({ ...devices[dev] });
      const T = await tc.newPage();
      await T.goto(`${BASE}/teacher.html#/s/${SID}`);
      await T.waitForSelector('input[type=email], .rs-grid, .genre-pick', { timeout: 15000 });
      if (await T.locator('input[type=email]').count()) {
        await T.fill('input[type=email]', process.env.E2E_EMAIL || 't1@example.com'); await T.fill('input[type=password]', process.env.E2E_PASSWORD || 'pass'); await T.click('button[type=submit]');
      }
      await T.waitForSelector('.genre-pick', { timeout: 15000 });
      await sleep(2500);
      const imgs = await T.evaluate(() => [...document.querySelectorAll('.previews .st-visual img')].map((im) => ({ src: (im.currentSrc || '').replace(/^.*\/assets\/genres\//, ''), w: Math.round(im.getBoundingClientRect().width) })));
      log.push({ view: '教師 07 預覽', size: orient, chosen: imgs.map((x) => `${x.src}（${x.w}px）`).join('、') });
      ok(imgs.length >= 1 && imgs.every((x) => /-landscape/.test(x.src)) && await T.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `教師平板 ${orient}｜07：預覽與投影中的圖都是橫式（${imgs.map((x) => `${x.src} ${x.w}px`).join('、')}）、沒有水平捲動`);
      await T.screenshot({ path: path.join(OUT, `teacher-ipad-${orient}-07.png`), fullPage: true });
      await tc.close();
    }
  } catch (e) { console.error(e.stack || e.message); fails.push('例外：' + e.message); }
  await pg.end().catch(() => {});
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'image-selection.json'), JSON.stringify(log, null, 2));
  console.log(`\n小說類型畫面：通過 ${passed} 項，失敗 ${fails.length} 項（截圖與圖片選用紀錄：${OUT}）`);
  if (fails.length) process.exitCode = 1;
})();
