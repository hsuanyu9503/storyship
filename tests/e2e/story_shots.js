// 故事卡畫面截圖與翻面錄影（瀏覽器模擬：Playwright Chromium；不是實體平板）
//   輸出到 tests/e2e/.cache/story-shots/：看板與閱讀卡正反面（1366×1024、1024×768、768×1024，像素比 2）、04 小組看板、
//   翻面錄影（1024×768，WebM）。docs/screenshots/stories/ 由這些輸出轉成 WebP。
//   需要 sf_story 與對應的 shim（見 story_reader.js 的說明）。
const { chromium } = require('playwright');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const pg = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:pg@127.0.0.1/sf_story' });
const OUT = path.join(__dirname, '.cache/story-shots');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ANON = '';
async function api(fn, args, token) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (token || ANON) }, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(fn + ': ' + t); return t ? JSON.parse(t) : null;
}
(async () => {
  const browser = await chromium.launch();
  let n = 0;
  try {
    const cfg = await (await fetch(BASE + '/config.js')).text();
    ANON = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']*)'/) || [])[1] || '';
    const TT = (await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: process.env.E2E_EMAIL || 't1@example.com', password: process.env.E2E_PASSWORD || 'pass' }) })).json()).access_token;
    const cr = await api('teacher_create_session', { p_title: '故事卡截圖', p_group_count: 2 }, TT);
    const SID = cr.session_id;
    const rev = async () => Number((await pg.query('select rev from public.session_state where session_id = $1', [SID])).rows[0].rev);
    const stage = async (phase, lock) => { const r = await api('teacher_set_stage', { p_session: SID, p_phase: phase, p_sub: phase, p_projection: { screen: 'instruction' }, p_expected_rev: await rev(), p_lock_unsubmitted: lock }, TT); if (!r.ok) throw new Error(JSON.stringify(r)); };
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/join.html?code=${cr.join_code}`);
    await p.waitForSelector('.s-group'); await p.locator('.s-group:has(.n:text-is("1"))').tap(); await p.locator('dialog button:has-text("確認加入")').tap();
    await p.waitForFunction(() => document.body.innerText.includes('已加入第 1 組'), null, { timeout: 12000 });
    await stage('03', false);
    await p.waitForSelector('.sc-grip', { timeout: 15000 });
    const settle = () => p.waitForFunction(() => [...document.querySelectorAll('.st-visual img')].every((i) => i.complete && i.naturalWidth), null, { timeout: 15000 }).catch(() => {});
    const shot = async (name) => { await settle(); await sleep(250); await p.screenshot({ path: path.join(OUT, name + '.png') }); n++; };
    // 先分好兩張，看板上同時有未分類與已分類的小卡
    await p.click('.bd-add'); await p.waitForSelector('.bd-cat');
    for (const t of ['神奇柑仔店', '寶可夢']) {
      await p.locator(`.sc:has(.sc-title:text-is("${t}")) .sc-grip`).tap(); await p.waitForSelector('.bd-movebar:not([hidden])');
      await p.locator('.bd-cat .bd-cat-n').first().tap(); await sleep(500);
    }
    for (const [w, h] of [[1366, 1024], [1024, 768], [768, 1024]]) {
      await p.setViewportSize({ width: w, height: h }); await sleep(400);
      await shot(`board-03-${w}x${h}`);
      await p.locator('.sc:has(.sc-title:text-is("動物方城市")) .sc-read').tap();
      await p.waitForSelector('dialog.reader[open]');
      await shot(`reader-front-${w}x${h}`);
      await p.locator('dialog.reader[open] .sr-front .sr-flip').tap();
      await p.waitForFunction(() => document.querySelector('.sr-card')?.classList.contains('flat'), null, { timeout: 3000 });
      await shot(`reader-back-${w}x${h}`);
      await p.locator('dialog.reader[open] .sr-close').tap(); await sleep(300);
    }
    // 3:2 的《神奇柑仔店》正面（左右留白）
    await p.setViewportSize({ width: 1024, height: 768 });
    await p.locator('.sc:has(.sc-title:text-is("神奇柑仔店")) .sc-read').tap(); await p.waitForSelector('dialog.reader[open]');
    await shot('reader-front-01-3x2-1024x768');
    await p.locator('dialog.reader[open] .sr-close').tap();
    // 04 小組看板
    await stage('04', true);
    await p.setViewportSize({ width: 1366, height: 1024 });
    await p.waitForSelector('.gw-main .sc-read', { timeout: 15000 }); await sleep(1200);
    await shot('board-04-1366x1024');
    await ctx.close();

    // 翻面錄影（像素比 1）
    const vctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, storageState: undefined,
      recordVideo: { dir: OUT, size: { width: 1024, height: 768 } } });
    await vctx.addCookies([]);
    const v = await vctx.newPage();
    await v.goto(`${BASE}/join.html?code=${cr.join_code}`);
    await v.waitForSelector('.s-group'); await v.locator('.s-group:has(.n:text-is("2"))').tap(); await v.locator('dialog button:has-text("確認加入")').tap();
    await v.waitForSelector('.gw-main .sc-read', { timeout: 15000 }); await sleep(1500);
    await v.locator('.gw-main .sc:has(.sc-title:text-is("北海小英雄")) .sc-read').tap();
    await v.waitForSelector('dialog.reader[open]'); await sleep(1400);
    await v.locator('dialog.reader[open] .sr-front .sr-flip').tap(); await sleep(1600);
    await v.evaluate(() => document.querySelector('dialog.reader[open] .sr-reading').scrollTo({ top: 400, behavior: 'smooth' })); await sleep(1300);
    await v.locator('dialog.reader[open] .sr-back .sr-flip').tap(); await sleep(1500);
    await v.locator('dialog.reader[open] .sr-close').tap(); await sleep(900);
    const vid = await v.video().path();
    await vctx.close();
    fs.renameSync(vid, path.join(OUT, 'flip-1024x768.webm'));
    console.log(`故事卡截圖：${n} 張；錄影 flip-1024x768.webm（${OUT}）`);
  } catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
  await pg.end().catch(() => {});
  await browser.close();
})();
