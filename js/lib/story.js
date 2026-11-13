// 第 03／04 環節的故事卡：圖片來源、編號、段落，以及雙面閱讀卡（03 個人、04 小組、教師檢視共用）。
//
// 圖片：assets/stories/story-NN.webp（閱讀圖，寬 1200）與 story-NN-600w.webp（看板縮圖，寬 600）。
//   看板小卡與閱讀卡都先量到圖片框寬度才設定 srcset／sizes（visual.js），瀏覽器依實際顯示寬度與裝置像素比選擇；
//   看板只會下載縮圖，閱讀卡打開時才下載該張的閱讀圖，不預載其他故事的大圖。其他網址（舊資料）只有單一來源。
//
// 閱讀卡（openStoryReader）：
//   * 一次只顯示一面：正面＝編號、完整圖片、名稱、「翻面閱讀」；背面＝編號、名稱、故事介紹、故事元素、「翻回圖片」。
//     不提供整張卡點一下就翻面（避免選字、捲動與觸控時誤翻）。每次打開都從正面開始。
//   * 翻面動畫：perspective＋rotateY＋backface-visibility（約 400ms）。動畫結束後把兩面都改回平面（不留 3D 變形），
//     文字不會模糊；隱藏的那一面設定 inert（不能聚焦、螢幕閱讀器不重複讀取）。動畫進行中再按翻面會被忽略，
//     所以狀態與畫面一定一致。prefers-reduced-motion 時立即切換。
//   * 對話框（<dialog> showModal）：焦點限制在對話框內、Escape 關閉、關閉後焦點回到開啟它的「閱讀」按鈕（不捲動看板）。
//   * 翻面、閱讀與捲動都是這台裝置自己的介面狀態：不寫入小組資料、不送出任何請求，其他組員的畫面不受影響。
import { h } from './dom.js';
import { visualBox } from './visual.js';

const RE = /^(assets\/stories\/story-\d{2})\.webp$/;
export function storySources(url) {
  const m = RE.exec(url || '');
  return m ? [{ url: `${m[1]}-600w.webp`, w: 600 }, { url, w: 1200 }] : null;
}
// 只需要一張小圖的地方（07 投影的故事小卡、拖曳中的影子）
export function storyThumb(url) {
  const m = RE.exec(url || '');
  return m ? `${m[1]}-600w.webp` : url || null;
}
export const storyNo = (i) => String(i + 1).padStart(2, '0');
export const storyAlt = (c) => c.image_alt || `《${c.title}》故事圖片`;
export function storyParagraphs(detail) {
  return String(detail || '').split(/\n+/).map((x) => x.trim() ? x : '').filter(Boolean);
}
export function storyElements(c) {
  return Array.isArray(c.elements) ? c.elements.filter((x) => typeof x === 'string' && x.trim()) : [];
}

// 看板小卡的圖片框（不放重新載入按鈕：圖片框位於「閱讀」按鈕裡，按鈕不能巢狀；仍會自動重試，閱讀卡的大圖有按鈕）
export function storyThumbBox(c) {
  return visualBox(c.image_url, storyAlt(c), { slot: 'story', sources: storySources(c.image_url), retryButton: false });
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLIP_MS = 400;

// 開啟閱讀卡。c：{ id, title, detail, elements, image_url, image_alt }；no：編號（"01"）；
// returnFocus()：關閉後要聚焦的元素（看板可能已重畫，所以在關閉時才取得）
export function openStoryReader(c, { no = '', returnFocus = null, onClose = null } = {}) {
  document.querySelectorAll('dialog.reader').forEach((d) => { d.close(); d.remove(); });
  const titleId = 'sr-title-' + Math.random().toString(36).slice(2, 8);
  const els = storyElements(c);
  const paras = storyParagraphs(c.detail);
  const noMark = () => (no ? h('span.sr-no', { 'aria-hidden': 'true' }, no) : null);
  const flipToBack = h('button.sr-flip', { type: 'button', 'data-to': 'back' }, '翻面閱讀 ', h('span', { 'aria-hidden': 'true' }, '↻'));
  const flipToFront = h('button.sr-flip', { type: 'button', 'data-to': 'front' }, '翻回圖片 ', h('span', { 'aria-hidden': 'true' }, '↻'));
  const reading = h('div.sr-reading', { tabindex: '0', 'aria-label': '故事介紹與故事元素（可捲動）' },
    h('h3', '故事介紹'),
    ...(paras.length ? paras.map((p) => h('p', p)) : [h('p.sr-empty', '（這張故事卡沒有介紹文字）')]),
    els.length ? h('section.sr-elements', h('h3', '值得留意的故事元素'), h('ul.sr-tags', els.map((x) => h('li', x)))) : null);
  const front = h('section.sr-face.sr-front', { 'aria-label': '正面' },
    h('div.sr-picture', visualBox(c.image_url, storyAlt(c), { slot: 'story', sources: storySources(c.image_url) })),
    h('div.sr-front-title', noMark(), h('div', h('div.sr-eyebrow', '故事分類小卡'), h('h2.sr-title', { id: titleId }, c.title))),
    h('footer.sr-foot', h('span', '先觀察圖片，再讀讀這個故事。'), flipToBack));
  const back = h('section.sr-face.sr-back', { 'aria-label': '背面' },
    h('header.sr-back-head', noMark(), h('h2.sr-title', c.title), h('span.sr-side', '故事背面')),
    reading,
    h('footer.sr-foot', h('span', '想一想：它和哪些故事有共同點？'), flipToFront));
  const flipper = h('div.sr-flipper', front, back);
  const card = h('div.sr-card.flat', { 'data-side': 'front' }, flipper);
  const close = h('button.sr-close', { type: 'button', 'aria-label': '關閉閱讀卡' }, '關閉 ', h('span', { 'aria-hidden': 'true' }, '✕'));
  const dlg = h('dialog.reader.sr', { 'aria-labelledby': titleId, 'data-card': c.id || '' },
    h('div.sr-bar', close), card);

  let busy = false; let timer = null;
  const faces = { front, back };
  const setInert = (side) => {
    for (const [k, f] of Object.entries(faces)) {
      const hidden = k !== side;
      f.inert = hidden;
      if (hidden) f.setAttribute('aria-hidden', 'true'); else f.removeAttribute('aria-hidden');
    }
  };
  setInert('front');
  const settle = () => {
    clearTimeout(timer); timer = null;
    busy = false;
    card.classList.add('flat');
  };
  function flip(to) {
    if (busy || card.dataset.side === to) return;
    setInert(to);
    if (reduceMotion()) {
      card.dataset.side = to;
      card.classList.add('flat');
    } else {
      busy = true;
      // 回到 3D 狀態（停在目前這一面，不顯示動畫），下一個畫格再轉到另一面
      flipper.style.transition = 'none';
      card.classList.remove('flat');
      void flipper.offsetWidth;
      flipper.style.transition = '';
      card.dataset.side = to;
      timer = setTimeout(settle, FLIP_MS + 150);   // transitionend 沒有觸發時（例如分頁在背景）的保險
    }
    (to === 'back' ? flipToFront : flipToBack).focus({ preventScroll: true });
    if (to === 'back') reading.scrollTop = 0;
  }
  flipper.addEventListener('transitionend', (e) => { if (e.target === flipper && e.propertyName === 'transform') settle(); });
  flipToBack.addEventListener('click', () => flip('back'));
  flipToFront.addEventListener('click', () => flip('front'));

  const done = () => {
    clearTimeout(timer);
    if (dlg.open) dlg.close();
    dlg.remove();
    const t = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
    if (t && t.isConnected) t.focus({ preventScroll: true });
    onClose?.();
  };
  // 焦點限制：Tab／Shift+Tab 在對話框內循環（瀏覽器預設可能把焦點移到網址列；隱藏面已 inert，不在循環內）
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...dlg.querySelectorAll('button, [tabindex="0"]')].filter((x) => !x.closest('[inert]') && !x.disabled && x.getClientRects().length);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === items.length - 1)) { e.preventDefault(); items[0].focus(); }
  });
  close.addEventListener('click', done);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(); });   // Escape
  dlg.addEventListener('click', (e) => { if (e.target === dlg) done(); });   // 點對話框外的背景
  document.body.append(dlg);
  dlg.showModal();
  flipToBack.focus({ preventScroll: true });
  return { dialog: dlg, flip, close: done, side: () => card.dataset.side };
}
