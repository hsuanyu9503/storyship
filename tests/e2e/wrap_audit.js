// 中文換行與裁切檢查（瀏覽器實測：Playwright Chromium）。用真正的繪製程式與 CSS，逐字量測每一行的位置。
//   檢查（每個文字區塊）：
//     orphan   末行只剩一個字（不計句末標點）
//     punct    行首出現逗號、句號等不該在行首的標點
//     names    名字變化（甲 → 乙）中姓名被拆開，或箭頭單獨一行
//     clip     內容被截掉：超出會裁切的祖先、投影畫面或視窗（可捲動的區域不算）
//     twoLine  按鈕／短標題變成兩行以上（只列出，供判斷）
//   範圍：投影端第 01 環節（開場、兩則故事三條線索、兩次公布、比較＋命名、轉場）、閱讀卡背面（八張）與正面標題、
//         看板小卡、學生端提示、教師端（真正的教師主控台：01 每一步的按鈕、環節列表）
//   全站預設為標楷體；FONT=old：在同樣的畫面改用改版前的字體（html.font-old）對照。OUT=輸出 JSON 路徑。
//   需要 sf_story 的 shim（PORT 8789）。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8789';
const FONT = process.env.FONT || 'kai';
const ROOT = path.join(__dirname, '../..');
const INTRO = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/intro-source.json'), 'utf8'));
const CARDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/story-cards-source.json'), 'utf8'));
const OUT = process.env.OUT || path.join(__dirname, `.cache/wrap-${FONT}.json`);
const SHOTS = process.env.SHOTS || '';   // 指定資料夾時另存截圖

// 頁面內：逐字量測行
const ANALYZE = () => {
  const NO_START = '，。、；：？！」』）》〉…—．,.;:?!)';
  const TRAIL = '，。、；：？！」』）》〉…．,.;:?!)';
  window.__lines = (el) => {
    const out = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; const r = document.createRange();
    while ((n = walker.nextNode())) {
      const t = n.textContent;
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) continue;
        r.setStart(n, i); r.setEnd(n, i + 1);
        const b = r.getClientRects()[0]; if (!b || !b.width) continue;
        out.push({ c: t[i], top: b.top, bottom: b.bottom, left: b.left, right: b.right, node: n });
      }
    }
    const lines = [];
    for (const ch of out) {
      const l = lines.find((x) => Math.abs(x.top - ch.top) < Math.max(3, (ch.bottom - ch.top) * 0.4));
      if (l) l.chars.push(ch); else lines.push({ top: ch.top, chars: [ch] });
    }
    lines.sort((a, b) => a.top - b.top);
    return lines.map((l) => l.chars.sort((a, b) => a.left - b.left));
  };
  window.__check = (el, kind, extra = {}) => {
    const lines = window.__lines(el);
    const text = lines.map((l) => l.map((c) => c.c).join(''));
    const issues = [];
    if (lines.length > 1) {
      const last = text[text.length - 1].replace(new RegExp('[' + TRAIL.replace(/[\]\\^-]/g, '\\$&') + ']+$'), '');
      if (last.length <= 1 && kind !== 'tag') issues.push({ type: 'orphan', detail: `末行只剩「${text[text.length - 1]}」` });
      text.slice(1).forEach((t, i) => { if (NO_START.includes(t[0])) issues.push({ type: 'punct', detail: `第 ${i + 2} 行以「${t[0]}」開頭` }); });
      if ((kind === 'button' || kind === 'title') && lines.length > 1) issues.push({ type: 'twoLine', detail: `${lines.length} 行：${text.join('／')}` });
      if (text.slice(1).some((t) => /^[→←↻✕]+$/.test(t))) issues.push({ type: 'orphan', detail: `符號單獨一行：${text.join('／')}` });
    }
    if (kind === 'names' && extra.names) {
      for (const nm of extra.names) {
        const idx = text.findIndex((t) => t.includes(nm));
        if (idx < 0) issues.push({ type: 'names', detail: `「${nm}」被拆到兩行：${text.join('／')}` });
      }
      if (text.some((t) => t === '→')) issues.push({ type: 'names', detail: `箭頭單獨一行：${text.join('／')}` });
    }
    // 裁切：元素超出會裁切的祖先（overflow 非 visible 且不可捲動）或視窗
    const b = el.getBoundingClientRect();
    // 頁面本身可以捲動時，視窗下緣不算裁切
    const docScroll = document.documentElement.scrollHeight > innerHeight + 1;
    let box = { top: docScroll ? -1e9 : 0, bottom: docScroll ? 1e9 : innerHeight, left: 0, right: innerWidth };
    let scrollable = false;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(auto|scroll)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1) { scrollable = true; break; }
      if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') {
        const r = a.getBoundingClientRect();
        box = { top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom), left: Math.max(box.left, r.left), right: Math.min(box.right, r.right) };
      }
    }
    if (b.width && !scrollable && (b.bottom > box.bottom + 1 || b.right > box.right + 1 || b.left < box.left - 1 || b.top < box.top - 1)) issues.push({ type: 'clip', detail: `超出可見範圍（${Math.round(b.bottom - box.bottom)}px）` });
    if (b.width && getComputedStyle(el).overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2) issues.push({ type: 'clip', detail: `內容高 ${el.scrollHeight}px > 可見 ${el.clientHeight}px` });
    return { kind, text: text.join('／'), lines: lines.length, issues };
  };
};

(async () => {
  const browser = await chromium.launch();
  const results = []; const fonts = {};
  const add = (screen, size, list) => { for (const x of list) results.push({ screen, size, ...x }); };
  async function newPage(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((f) => { if (f === 'old') document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('font-old')); }, FONT);
    const p = await ctx.newPage();
    return p;
  }
  // 實際使用的字型（Chrome DevTools Protocol）
  async function actualFont(p, sel, label) {
    try {
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) return;
      const { fonts: f } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      fonts[label] = f.map((x) => `${x.familyName}（${x.glyphCount} 字）`).join('、');
    } catch (e) { fonts[label] = '無法取得：' + e.message; }
  }
  const P = await import(path.join(ROOT, 'js/lib/projection.js'));
  const stories = INTRO.stories.map((s, i) => ({ title: s.title, reveal_text: s.reveal_text, name_before: s.name_before, name_after: s.name_after,
    image_url: i ? 'assets/intro/chihiro-1600.webp' : 'assets/intro/conan-1600.webp', image_alt: `《${s.title}》揭曉圖`, clues: s.clues }));
  const text = { opening: INTRO.opening, compare_title: INTRO.compare_title, compare_prompts: INTRO.compare_prompts, naming_prompt: INTRO.naming_prompt, bridge_title: INTRO.bridge_title, bridge_text: INTRO.bridge_text };
  const seq = [P.introInitial()]; for (let s = seq[0]; (s = P.introNext(stories, s, text));) seq.push(s);
  const SCREENS = { '開場': seq[0], '神祕故事一・三條線索': seq[4], '公布柯南': seq[5], '神祕故事二・三條線索': seq[9], '公布千尋': seq[10], '比較＋命名': seq[12], '轉場': seq[13] };
  const NAMES = INTRO.stories.flatMap((s) => [s.name_before, s.name_after]);

  // ---------- 投影端 ----------
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [1024, 768], [768, 1024], [390, 844]]) {
    const p = await newPage(w, h);
    await p.goto(BASE + '/projector.html');
    await p.evaluate(ANALYZE);
    for (const [name, st] of Object.entries(SCREENS)) {
      const proj = P.introProjection(stories, st, text);
      const r = await p.evaluate(async ({ proj, NAMES }) => {
        const { renderProjection } = await import('/js/lib/render-projection.js');
        const wrap = document.createElement('div'); wrap.className = 'stage-wrap';
        wrap.append(renderProjection({ projection: proj, status: 'active' }, { showQr: false }));
        document.body.replaceChildren(wrap);
        await document.fonts.ready; await new Promise((res) => setTimeout(res, 120));
        const out = [];
        const q = (sel, kind) => document.querySelectorAll(sel).forEach((el) => out.push({ sel, ...window.__check(el, kind, kind === 'names' ? { names: NAMES.filter((n) => el.textContent.includes(n)) } : {}) }));
        q('.st-title', 'title'); q('.st-intro-opening', 'para'); q('.st-clue2-label', 'title'); q('.st-clue2-body', 'para');
        q('.st-reveal2-title', 'title'); q('.st-names', 'names'); q('.st-reveal2-desc', 'para'); q('.st-clue-recap li span', 'para');
        q('.st-ic-title', 'title'); q('.st-ic-prompt', 'para'); q('.st-chip', 'button');
        return out;
      }, { proj, NAMES });
      add(`投影・${name}`, `${w}x${h}`, r);
      if (SHOTS && ['神祕故事二・三條線索', '比較＋命名', '公布千尋'].includes(name)) await p.screenshot({ path: path.join(SHOTS, `proj-${name}-${w}x${h}-${FONT}.png`) });
      if (w === 1920 && name === '神祕故事二・三條線索') await actualFont(p, '.st-clue2-body', '投影線索內文');
    }
    await p.context().close();
  }

  // ---------- 閱讀卡（八張背面）與看板小卡 ----------
  for (const [w, h] of [[1366, 1024], [1024, 768], [768, 1024], [390, 844]]) {
    const p = await newPage(w, h);
    await p.goto(BASE + '/join.html');
    await p.evaluate(ANALYZE);
    const cards = CARDS.map((c, i) => ({ id: 'c' + i, title: c.title, detail: c.paragraphs.join('\n'), elements: c.elements,
      image_url: `assets/stories/story-${c.no}.webp`, image_alt: `《${c.title}》故事情境圖` }));
    for (const c of cards) {
      const r = await p.evaluate(async (c) => {
        const { openStoryReader } = await import('/js/lib/story.js');
        document.querySelectorAll('dialog.reader').forEach((d) => d.remove());
        const rd = openStoryReader(c, { no: String(Number(c.id.slice(1)) + 1).padStart(2, '0') });
        const front = [];
        await document.fonts.ready;
        document.querySelectorAll('dialog.reader .sr-front .sr-title, dialog.reader .sr-front .sr-foot span, dialog.reader .sr-front .sr-flip').forEach((el) => front.push({ sel: 'front ' + el.className, ...window.__check(el, el.tagName === 'BUTTON' ? 'button' : 'title') }));
        rd.flip('back');
        await new Promise((res) => setTimeout(res, 650));
        const out = [...front];
        const q = (sel, kind) => document.querySelectorAll(sel).forEach((el) => out.push({ sel, ...window.__check(el, kind) }));
        q('dialog.reader .sr-back .sr-title', 'title'); q('dialog.reader .sr-reading p', 'para'); q('dialog.reader .sr-tags li', 'tag');
        q('dialog.reader .sr-back .sr-foot span', 'para'); q('dialog.reader .sr-back .sr-flip', 'button'); q('dialog.reader .sr-close', 'button');
        // 最後一行與按鈕可見（捲到最後）
        const rdg = document.querySelector('dialog.reader .sr-reading'); rdg.scrollTop = rdg.scrollHeight;
        const last = [...rdg.querySelectorAll('li, p')].pop().getBoundingClientRect(); const rr = rdg.getBoundingClientRect();
        const ok = last.bottom <= rr.bottom + 1;
        out.push({ sel: '捲到最後', kind: 'check', text: '', lines: 0, issues: ok ? [] : [{ type: 'clip', detail: '捲到最後仍看不到最後一行' }] });
        return out;
      }, c);
      add(`閱讀卡・${c.title}`, `${w}x${h}`, r);
      if (SHOTS && c.title === '動物方城市') await p.screenshot({ path: path.join(SHOTS, `reader-back-動物方城市-${w}x${h}-${FONT}.png`) });
      if (w === 1024 && c.title === '動物方城市') await actualFont(p, 'dialog.reader .sr-reading p', '閱讀卡內文');
    }
    const rb = await p.evaluate(async (cards) => {
      document.querySelectorAll('dialog.reader').forEach((d) => { d.close(); d.remove(); });
      const { createBoardView } = await import('/js/lib/board-view.js');
      const v = createBoardView({ cards, title: '我的故事分類' });
      document.body.replaceChildren(v.el); document.body.style.height = '100vh';
      await document.fonts.ready; await new Promise((res) => setTimeout(res, 200));
      const out = [];
      document.querySelectorAll('.sc-title').forEach((el) => out.push({ sel: '.sc-title', ...window.__check(el, 'title') }));
      document.querySelectorAll('.bd-add, .bd-col-title, .bd-hint').forEach((el) => out.push({ sel: el.className, ...window.__check(el, el.tagName === 'BUTTON' ? 'button' : 'title') }));
      return out;
    }, cards);
    add('學生看板', `${w}x${h}`, rb);
    await p.context().close();
  }

  // ---------- 教師端（真正的教師主控台） ----------
  {
    const p = await newPage(1366, 1024);
    const cfg = await (await fetch(BASE + '/config.js')).text();
    await p.goto(BASE + '/teacher.html');
    await p.fill('input[type=email]', 't1@example.com'); await p.fill('input[type=password]', 'pass'); await p.click('button[type=submit]');
    await p.waitForFunction(() => document.body.innerText.includes('建立教學場次'));
    await p.click('text=建立（六組）'); await p.waitForFunction(() => document.body.innerText.includes('開放新學生加入'));
    await p.click('text=啟動第一環節：走進故事世界 →'); await p.waitForSelector('.intro-next');
    await p.evaluate(ANALYZE);
    await actualFont(p, '.intro-next', '教師端按鈕');
    const labels = new Set();
    for (let i = 0; i < 14; i++) {
      for (const [w, h] of [[1366, 1024], [1024, 768], [768, 1024], [390, 844]]) {
        await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(120);
        const r = await p.evaluate(() => { const out = [];
          document.querySelectorAll('.intro-btns button, .row > button, .intro-now, .steps .step, .step-nav button, .s-head button, header button').forEach((el) => out.push({ sel: el.className || el.tagName, ...window.__check(el, el.tagName === 'BUTTON' ? 'button' : 'title') }));
          return out; });
        const lab = await p.locator('.intro-next').innerText();
        add(`教師端・01「${lab.trim()}」`, `${w}x${h}`, r.filter((x) => !labels.has(`${w}|${x.text}`)));
        r.forEach((x) => labels.add(`${w}|${x.text}`));
        if (SHOTS && i === 0) await p.screenshot({ path: path.join(SHOTS, `teacher-01-${w}x${h}-${FONT}.png`) });
      }
      await p.setViewportSize({ width: 1366, height: 1024 });
      const nx = p.locator('.intro-next'); if ((await nx.innerText()).includes('進入下一環節')) break;
      await p.waitForTimeout(750); await nx.click(); await p.waitForTimeout(500);
    }
    await p.context().close();
  }

  // ---------- 學生端提示 ----------
  for (const [w, h] of [[1024, 768], [768, 1024], [390, 844]]) {
    const p = await newPage(w, h);
    await p.goto(BASE + '/join.html'); await p.evaluate(ANALYZE);
    const r = await p.evaluate(async () => {
      const { h } = await import('/js/lib/dom.js'); const { STUDENT_TEXT, TEXT } = await import('/js/lib/phases.js');
      document.body.replaceChildren(h('div.s-center', h('p.s-lead', STUDENT_TEXT.watch01), h('p.s-lead', STUDENT_TEXT.watch), h('h1', TEXT.endLine1), h('p.s-lead', TEXT.endLine2)),
        h('div.fsr-box', h('div.fsr-inner', h('p.fsr-msg', '請回到全螢幕，繼續活動'), h('div.fsr-actions', h('button.primary.fsr-btn', '回到全螢幕'), h('button.fsr-continue', '繼續活動')))));
      await document.fonts.ready;
      const out = []; document.querySelectorAll('.s-lead, h1, .fsr-msg, .fsr-btn, .fsr-continue').forEach((el) => out.push({ sel: el.className || el.tagName, ...window.__check(el, el.tagName === 'BUTTON' ? 'button' : 'para') }));
      return out;
    });
    add('學生端提示', `${w}x${h}`, r);
    await p.context().close();
  }

  await browser.close();
  const issues = results.flatMap((r) => r.issues.map((i) => ({ screen: r.screen, size: r.size, sel: r.sel, text: r.text, ...i })));
  const count = (t) => issues.filter((i) => i.type === t).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ font: FONT, fonts, checked: results.length, issues }, null, 1));
  console.log(`字體：${FONT}；實際字型：${JSON.stringify(fonts)}`);
  console.log(`檢查 ${results.length} 個文字區塊：末行一字 ${count('orphan')}、行首標點 ${count('punct')}、名字拆開 ${count('names')}、裁切 ${count('clip')}、按鈕／標題兩行 ${count('twoLine')}`);
  for (const t of ['orphan', 'punct', 'names', 'clip']) for (const i of issues.filter((x) => x.type === t)) console.log(`  [${t}] ${i.screen} ${i.size} ${i.sel}：${i.detail}｜${i.text.slice(0, 60)}`);
  for (const i of issues.filter((x) => x.type === 'twoLine')) console.log(`  [twoLine] ${i.screen} ${i.size} ${i.sel}：${i.detail.slice(0, 80)}`);
  const hard = count('orphan') + count('punct') + count('names') + count('clip');
  console.log(hard ? `\n換行檢查：需要處理 ${hard} 項` : '\n換行檢查：沒有末行一字、行首標點、名字拆開或裁切');
  process.exitCode = hard ? 1 : 0;
})();
