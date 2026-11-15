// 標楷體試排的對照截圖（瀏覽器實測：Playwright Chromium）。用 font-fixture.html 的固定畫面，左右同內容、同尺寸。
//   BASE：提供專案根目錄的靜態伺服器（例如在專案資料夾執行 python3 -m http.server 8791）。OUT：輸出資料夾。
//   每張截圖另記錄實際使用的字型（Chrome DevTools Protocol：CSS.getPlatformFontsForNode）。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8791';
const OUT = process.env.OUT || path.join(__dirname, '.cache/font-shots');
fs.mkdirSync(OUT, { recursive: true });
const PLAN = {
  clues2: { sel: '.st-clue2-body', sizes: [[1920, 1080], [1366, 768], [1024, 768], [390, 844]] },
  names: { sel: '.st-names', sizes: [[1920, 1080], [1366, 768], [1024, 768], [390, 844]] },
  reveal2: { sel: '.st-reveal2-desc', sizes: [[1920, 1080], [1024, 768]] },
  card04: { sel: '.sr-reading p', sizes: [[1024, 768], [768, 1024], [390, 844]] },
  teacher: { sel: '.intro-next', sizes: [[1366, 1024], [1024, 768], [390, 844]] },
};
(async () => {
  const browser = await chromium.launch();
  const fonts = {};
  for (const [screen, { sel, sizes }] of Object.entries(PLAN)) {
    for (const [w, h] of sizes) {
      for (const font of ['default', 'kai']) {
        const p = await browser.newPage({ viewport: { width: w, height: h } });
        await p.goto(`${BASE}/font-fixture.html?screen=${screen}&font=${font}`);
        await p.waitForFunction(() => document.documentElement.dataset.ready === '1');
        await p.evaluate(() => document.fonts.ready);
        await p.waitForTimeout(screen === 'card04' ? 800 : 500);
        await p.evaluate(() => [...document.images].every((i) => i.complete)).catch(() => {});
        await p.waitForTimeout(300);
        await p.screenshot({ path: path.join(OUT, `${screen}-${w}x${h}-${font}.png`) });
        try {
          const cdp = await p.context().newCDPSession(p); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
          const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
          const { fonts: f } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          fonts[`${screen}-${w}x${h}-${font}`] = f.map((x) => `${x.familyName}（${x.glyphCount}）`).join('、');
        } catch (e) { fonts[`${screen}-${w}x${h}-${font}`] = '無法取得'; }
        await p.close();
      }
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'fonts.json'), JSON.stringify(fonts, null, 1));
  console.log(JSON.stringify(fonts, null, 1));
})();
