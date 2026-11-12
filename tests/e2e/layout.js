// 候選 B：投影版面在「合法上限」的內容下是否會被裁切（實際量測每個內容元素是否完整落在可視範圍內）
//   上限：分類名稱 30 字、共同特色 300 字（group_update_category）、每組最多 20 個分類、本場素材全部故事（8 張）
//   用真正的 render-projection.js 與 css/app.css 繪製；需要 shim.js（或任何靜態伺服器）在 BASE 提供專案檔案。
//   用法：node layout.js（MUST_FIT 情境被裁切、或裁切未被教師預覽偵測到即失敗；LAYOUT_REPORT=1 只列出結果）
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8787';
const OUT = path.join(__dirname, '.cache/shots');

const NAME30 = '主角都很勇敢而且最後都學到一件很重要的事情的那一類好聽的故事們';
const name = (i) => (i + NAME30).slice(0, 30);
const REASON300 = ('這些故事的主角一開始都遇到困難，後來靠著自己的勇氣和朋友的幫忙解決問題，最後都學到了重要的道理，所以我們把它們分在一起。').repeat(6).slice(0, 300);
const TITLES = ['小紅帽與森林裡的大野狼', '會說話的魔法掃帚', '博物館失竊的寶物之謎', '沙漠探險隊與綠洲', '古代皇宮裡的小書僮', '月亮上的兔子工廠', '消失的第十三號車廂', '海底王國的珍珠項鍊'];
const card = (t, tracked = false) => ({ title: t, image_url: null, tracked });

function cats(n, { cardsPer = 2, reason = 'shown' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    label: name(i + 1), unnamed: false,
    cards: TITLES.slice((i * cardsPer) % 8, (i * cardsPer) % 8 + cardsPer).map((t, k) => card(t, i === 0 && k === 0)),
    reason_state: reason, ...(reason === 'shown' ? { reason: REASON300 } : {}),
  }));
}
function side(s, categories, extra = {}) {
  return { side: s, group: s === 'left' ? '第 1 組' : '第 2 組', number: s === 'left' ? 1 : 2, kind: 'submitted', complete: true,
    total: 20, page: 0, pages: 5, focus: false, unplaced_count: 0, track: { where: NAME30, unplaced: false }, categories, ...extra };
}
const compare = (sides, zoom = false) => ({ screen: 'compare', title: '分類成果大公開', story: { title: TITLES[0] }, zoom, sides });
const match = (cardsN, reason, scaffold = true) => ({
  screen: 'match', title: '小小故事分類師', group: { group: '第 1 組', number: 1, kind: 'submitted', complete: true },
  category: { label: NAME30, unnamed: false, cards: TITLES.slice(0, cardsN).map((t) => card(t)), reason_state: reason ? 'shown' : 'hidden', ...(reason ? { reason: REASON300 } : {}) },
  genre: { name: '偵探小說', visual_url: null, elements: [0, 1, 2].map((i) => ({ slot: i, revealed: true, label: ['神祕案件', '尋找線索', '推理解謎'][i], icon: '❓', highlight: i === 0 })) },
  scaffold,
});

const SCENARIOS = {
  '05 雙組・每頁 4 類・全部揭露理由（上限）': compare([side('left', cats(4)), side('right', cats(4))]),
  '05 雙組・每頁 4 類・理由未揭露': compare([side('left', cats(4, { reason: 'hidden' })), side('right', cats(4, { reason: 'hidden' }))]),
  '05 雙組・每頁 2 類・全部揭露理由': compare([side('left', cats(2)), side('right', cats(2))]),
  '05 雙組・每頁 1 類・揭露理由＋8 張故事': compare([side('left', cats(1, { cardsPer: 8 })), side('right', cats(1, { cardsPer: 8 }))]),
  '05 雙組・聚焦一類＋8 張故事＋理由': compare([side('left', cats(1, { cardsPer: 8 }), { focus: true }), side('right', cats(1, { cardsPer: 8 }), { focus: true })]),
  '05 單組・每頁 4 類・全部揭露理由': compare([side('left', cats(4))]),
  '05 單組・聚焦一類＋8 張故事＋理由': compare([side('left', cats(1, { cardsPer: 8 }), { focus: true })]),
  // 修正後教師可用的方式（不縮小字級）：放大單側＋每頁 1～2 類／聚焦
  '05 放大單側・每頁 1 類・理由＋8 張故事': compare([side('left', cats(1, { cardsPer: 8 }), { per: 1 })], true),
  '05 放大單側・聚焦一類・理由＋8 張故事': compare([side('left', cats(1, { cardsPer: 8 }), { focus: true })], true),
  '05 放大單側・每頁 2 類・理由（每類 2 張）': compare([side('left', cats(2), { per: 2 })], true),
  '05 雙組・每頁 2 類・理由未揭露（每類 4 張）': compare([side('left', cats(2, { cardsPer: 4, reason: 'hidden' })), side('right', cats(2, { cardsPer: 4, reason: 'hidden' }))]),
  '05 雙組・每頁 1 類・理由未揭露＋8 張故事': compare([side('left', cats(1, { cardsPer: 8, reason: 'hidden' })), side('right', cats(1, { cardsPer: 8, reason: 'hidden' }))]),
  '07 8 張故事＋理由＋句型鷹架': match(8, true),
  '07 8 張故事＋理由（句型鷹架關閉）': match(8, true, false),
  '07 8 張故事＋句型鷹架（理由未顯示）': match(8, false),
};

const MUST_FIT = new Set(['05 放大單側・每頁 1 類・理由＋8 張故事', '05 放大單側・聚焦一類・理由＋8 張故事',
  '05 雙組・每頁 1 類・理由未揭露＋8 張故事', '05 雙組・每頁 2 類・理由未揭露（每類 4 張）',
  '07 8 張故事＋理由＋句型鷹架', '07 8 張故事＋理由（句型鷹架關閉）', '07 8 張故事＋句型鷹架（理由未顯示）']);

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const [w, hgt] of [[1920, 1080], [1280, 720], [1024, 768]]) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt } });
    await page.goto(BASE + '/projector.html');
    for (const [label, projection] of Object.entries(SCENARIOS)) {
      const r = await page.evaluate(async (projection) => {
        const { renderProjection } = await import('/js/lib/render-projection.js');
        const wrap = document.createElement('div'); wrap.className = 'stage-wrap';
        wrap.append(renderProjection({ projection, status: 'active' }, { showQr: false }));
        document.body.replaceChildren(wrap);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const stage = wrap.querySelector('.stage').getBoundingClientRect();
        // 內容元素：每一個都要完整落在投影範圍與所有會裁切的祖先範圍內
        const sel = '.st-match-reason, .st-cat-name, .st-chip-card, .st-cat-reason, .st-match-card, .st-match-el, .st-scaffold, .st-side-track, .st-match-gname, .st-cmp-track';
        const clipped = [];
        for (const el of wrap.querySelectorAll(sel)) {
          const b = el.getBoundingClientRect();
          let box = { top: stage.top, bottom: stage.bottom, left: stage.left, right: stage.right };
          for (let a = el.parentElement; a && a !== wrap; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') {
              const r = a.getBoundingClientRect();
              box = { top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom), left: Math.max(box.left, r.left), right: Math.min(box.right, r.right) };
            }
          }
          if (b.bottom > box.bottom + 1 || b.top < box.top - 1 || b.right > box.right + 1 || b.left < box.left - 1 || el.scrollHeight > el.clientHeight + 2) {
            clipped.push(`${el.className}「${el.textContent.slice(0, 12)}…」`);
          }
        }
        const fonts = [...wrap.querySelectorAll('.st-cat-reason, .st-chip-card, .st-match-card')].map((e) => parseFloat(getComputedStyle(e).fontSize));
        // 教師預覽使用的同一個偵測（js/teacher/results.js fitCheck）
        const st = wrap.querySelector('.stage');
        const detected = [st, ...st.querySelectorAll('.st-cats, .st-side, .st-match-left, .st-match-right, .st-cmp-body, .st-match-body')]
          .some((e) => e.scrollHeight > e.clientHeight + 2);
        return { clipped, detected, minFontPx: fonts.length ? Math.min(...fonts) : null, stageW: stage.width };
      }, projection);
      results.push({ size: `${w}x${hgt}`, label, ...r });
      if (w === 1920) await page.screenshot({ path: path.join(OUT, `layout-${label.replace(/[^\w一-鿿]+/g, '_')}.png`) });
    }
    await page.close();
  }
  await browser.close();
  // 判定：MUST_FIT（教師可選的「保證放得下」方式）必須完整可見；
  //       其他情境若被裁切，教師預覽的偵測必須抓到（顯示「放不下」提醒）
  let bad = 0;
  for (const r of results) {
    const must = MUST_FIT.has(r.label);
    const clipped = r.clipped.length > 0;
    const okk = must ? !clipped : (!clipped || r.detected) && r.detected === clipped;
    if (!okk) bad++;
    console.log(`${okk ? 'ok' : 'FAIL'} - ${r.size} ${r.label}：${clipped ? `會裁切 ${r.clipped.length} 個元素（${r.detected ? '教師預覽會提醒' : '教師預覽沒有偵測到！'}）` : '完整可見'}`
      + `${must ? '［必須完整］' : ''}（最小字級 ${r.minFontPx?.toFixed(1)}px）`);
  }
  if (bad && !process.env.LAYOUT_REPORT) process.exitCode = 1;
})();
