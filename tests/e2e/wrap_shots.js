// 換行修正前後對照截圖：用同一份資料，在 BASE（修正前或修正後的網站）繪製出問題的畫面。OUT：輸出資料夾，TAG：檔名後綴。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const OUT = process.env.OUT; const TAG = process.env.TAG || 'after';
const ROOT = path.join(__dirname, '../..');
const INTRO = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/intro-source.json'), 'utf8'));
const CARDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/story-cards-source.json'), 'utf8'));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const P = await import(path.join(ROOT, 'js/lib/projection.js'));
  const stories = INTRO.stories.map((s, i) => ({ title: s.title, reveal_text: s.reveal_text, name_before: s.name_before, name_after: s.name_after,
    image_url: i ? 'assets/intro/chihiro-1600.webp' : 'assets/intro/conan-1600.webp', image_alt: `《${s.title}》揭曉圖`, clues: s.clues }));
  const text = { opening: INTRO.opening, compare_title: INTRO.compare_title, compare_prompts: INTRO.compare_prompts, naming_prompt: INTRO.naming_prompt, bridge_title: INTRO.bridge_title, bridge_text: INTRO.bridge_text };
  const seq = [P.introInitial()]; for (let s = seq[0]; (s = P.introNext(stories, s, text));) seq.push(s);
  const browser = await chromium.launch();
  const proj = [['proj-opening', seq[0], 1920, 1080], ['proj-reveal-conan', seq[5], 1366, 768], ['proj-clues1', seq[4], 390, 844], ['proj-names', seq[12], 1920, 1080]];
  for (const [name, st, w, h] of proj) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.goto(BASE + '/projector.html');
    await p.evaluate(async (pj) => { const { renderProjection } = await import('/js/lib/render-projection.js');
      const wrap = document.createElement('div'); wrap.className = 'stage-wrap'; wrap.append(renderProjection({ projection: pj, status: 'active' }, { showQr: false }));
      document.body.replaceChildren(wrap); await document.fonts.ready; await new Promise((r) => setTimeout(r, 900)); }, P.introProjection(stories, st, text));
    await p.screenshot({ path: path.join(OUT, `${name}-${w}x${h}-${TAG}.png`), fullPage: true }); await p.close();
  }
  for (const [no, w, h] of [[3, 1366, 1024], [2, 390, 844], [6, 1024, 768]]) {
    const c = CARDS[no - 1];
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.goto(BASE + '/join.html');
    await p.evaluate(async (c) => { const { openStoryReader } = await import('/js/lib/story.js');
      const r = openStoryReader({ id: 'x', title: c.title, detail: c.paragraphs.join('\n'), elements: c.elements, image_url: `assets/stories/story-${c.no}.webp` }, { no: c.no });
      r.flip('back'); await new Promise((res) => setTimeout(res, 800)); }, c);
    await p.screenshot({ path: path.join(OUT, `reader-${c.no}-${w}x${h}-${TAG}.png`) }); await p.close();
  }
  await browser.close();
})();
