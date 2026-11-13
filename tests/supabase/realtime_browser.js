// 真實 Realtime（本機 Supabase）的中斷與恢復：教師、投影、學生三端在瀏覽器中
//   1. Realtime 正常：教師端顯示「即時連線」，切換環節後投影與學生很快更新
//   2. 閘道切斷並拒絕 WebSocket（模擬學校網路封鎖）：教師端改顯示「輪詢同步」，三端仍靠輪詢同步
//   3. 恢復：重新連上 Realtime（「即時連線」），之後的變更仍正確同步
// 由 tests/supabase/e2e_real.sh 呼叫（需要 BASE、E2E_EMAIL、E2E_PASSWORD、GATEWAY_PID）
const { chromium } = require(require.resolve('playwright', { paths: [__dirname + '/../e2e'] }));
const BASE = process.env.BASE; const PID = Number(process.env.GATEWAY_PID);
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p) => p.evaluate(() => document.body.innerText);
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return Date.now() - t0; } catch { /* */ } await sleep(200); } return -1; }

(async () => {
  const b = await chromium.launch();
  try {
    const T = await (await b.newContext({ viewport: { width: 1366, height: 1000 } })).newPage();
    await T.goto(BASE + '/teacher.html');
    await T.fill('input[type=email]', process.env.E2E_EMAIL); await T.fill('input[type=password]', process.env.E2E_PASSWORD);
    await T.click('button[type=submit]');
    await T.waitForFunction(() => document.body.innerText.includes('建立教學場次'), null, { timeout: 20000 });
    await T.click('text=建立（六組）');
    await T.waitForFunction(() => document.body.innerText.includes('開放新學生加入'), null, { timeout: 20000 });
    const code = (await T.textContent('.code b')).trim();
    const P = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await P.goto(await T.getAttribute('a:has-text("開啟投影")', 'href'));
    const S = await (await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true })).newPage();
    await S.goto(BASE + '/join.html?code=' + code);
    await S.waitForSelector('.s-group');
    await S.click('.s-group:has(.n:text-is("1"))'); await S.click('dialog button:has-text("確認加入")');
    await S.waitForFunction(() => document.body.innerText.includes('已加入第 1 組'), null, { timeout: 15000 });
    const conn = () => T.textContent('.conn');
    ok(await waitFor(async () => (await conn()).includes('即時連線'), 30000) >= 0, 'Realtime 正常：教師端顯示「即時連線」');
    await sleep(2000);
    // 1. Realtime 正常時切換環節
    const sBefore = await text(S);
    await T.click('button:has-text("下一環節 →")');
    const tP = await waitFor(async () => !(await text(P)).includes('各組加入狀態'), 20000);
    const tS = await waitFor(async () => (await text(S)) !== sBefore, 20000);
    ok(tP >= 0 && tS >= 0, `Realtime 正常：切換環節後投影 ${tP}ms、學生 ${tS}ms 更新`);
    // 2. 封鎖 Realtime
    process.kill(PID, 'SIGUSR1');
    ok(await waitFor(async () => (await conn()).includes('輪詢同步') || (await conn()).includes('離線'), 30000) >= 0, 'Realtime 中斷：教師端改顯示「輪詢同步」');
    const before = await text(P);
    await T.click('button:has-text("下一環節 →")');
    const tP2 = await waitFor(async () => (await text(P)) !== before, 25000);
    ok(tP2 >= 0, `Realtime 中斷時，投影仍靠輪詢在 ${tP2}ms 內更新`);
    // 3. 恢復
    process.kill(PID, 'SIGUSR2');
    ok(await waitFor(async () => (await conn()).includes('即時連線'), 60000) >= 0, 'Realtime 恢復：教師端重新顯示「即時連線」');
    const before3 = await text(P);
    await T.click('button:has-text("下一環節 →")');
    const tP3 = await waitFor(async () => (await text(P)) !== before3, 20000);
    ok(tP3 >= 0, `恢復後切換環節，投影 ${tP3}ms 更新`);
    const phT = await T.textContent('.pill'); const phS = await text(S);
    ok(phT.includes('03') && await waitFor(async () => (await text(S)).includes('已分類'), 20000) >= 0, '恢復後教師在 03、學生端出現個人分類畫面（同一個環節）');
  } catch (e) { fails.push('例外：' + e.message); console.log(e.stack); }
  await b.close();
  console.log(`\nRealtime 中斷與恢復：通過 ${passed} 項，失敗 ${fails.length} 項`);
  process.exit(fails.length ? 1 : 0);
})();
