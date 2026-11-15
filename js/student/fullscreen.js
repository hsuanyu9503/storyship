// 學生端：退出全螢幕時顯示「請回到全螢幕，繼續活動」與大按鈕「回到全螢幕」。
//   * 依瀏覽器實際的全螢幕狀態（document.fullscreenElement／webkitFullscreenElement 與 fullscreenchange 事件）判斷。
//   * 提示是獨立的浮層（支援時放在 top layer：popover），不重畫下面的活動畫面，所以作答、分組、卡片位置、翻面狀態都保留；
//     閱讀卡（<dialog>）開著時也會顯示在它上面。
//   * 只有學生曾經進入全螢幕（或按下「進入探索模式」）後才會出現；成功回到全螢幕後消失，再次退出會再出現。
//   * 瀏覽器拒絕或裝置不支援：提示改為說明文字與「繼續活動」，按下後收起，學生照常進行（之後若又進入再退出，提示會再出現）。
//   * 不搶走焦點（學生可能正在輸入分類名稱）；按鈕可用觸控、滑鼠、鍵盤（Tab 到按鈕後 Enter／空白鍵）操作。
import { h } from '../lib/dom.js';

const doc = document;
const fsElement = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;
export const fullscreenSupported = () => {
  const el = doc.documentElement;
  return Boolean((el.requestFullscreen || el.webkitRequestFullscreen) && (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true));
};

let wanted = false;        // 學生已選擇使用全螢幕（按過「進入探索模式」）
let dismissed = false;     // 請求失敗後學生選擇「繼續活動」
let box = null; let msg = null; let btn = null; let cont = null;
let busy = false;

export async function requestFs() {
  const el = doc.documentElement;
  if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
  else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  else throw new Error('UNSUPPORTED');
}

function build() {
  msg = h('p.fsr-msg', '請回到全螢幕，繼續活動');
  btn = h('button.primary.fsr-btn', { type: 'button', onclick: onReturn }, '回到全螢幕');
  cont = h('button.fsr-continue', { type: 'button', hidden: true, onclick: () => { dismissed = true; update(); } }, '繼續活動');
  box = h('div.fsr-box', { role: 'alert', 'aria-live': 'assertive' }, h('div.fsr-inner', msg, h('div.fsr-actions', btn, cont)));
  if ('popover' in HTMLElement.prototype) box.setAttribute('popover', 'manual');
  doc.body.append(box);
}
// 放置位置：有開啟中的強制回應對話框（例如閱讀卡 showModal）時，頁面其他部分都是 inert（不能點），
// 所以提示要放進該對話框裡；沒有時放在 body，並用 popover 放到最上層。
const modalOpen = () => [...doc.querySelectorAll('dialog[open]')].filter((d) => { try { return d.matches(':modal'); } catch { return true; } }).pop() || null;
function place() {
  const host = modalOpen() || doc.body;
  if (box.parentNode !== host) {
    if (box.hasAttribute('popover')) { try { if (box.matches(':popover-open')) box.hidePopover(); } catch { /* 忽略 */ } }
    host.append(box);
  }
  if (box.hasAttribute('popover')) {   // 放進對話框時也用 popover 顯示（在對話框之上；身為對話框的子元素，所以不是 inert）
    try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch { /* 不支援時以 z-index 顯示 */ }
  }
}
function show() {
  if (!box) build();
  box.hidden = false;
  place();
  doc.body.classList.add('fsr-out');
}
function hide() {
  if (!box) return;
  if (box.hasAttribute('popover')) { try { if (box.matches(':popover-open')) box.hidePopover(); } catch { /* 忽略 */ } }
  box.hidden = true;
  doc.body.classList.remove('fsr-out');
}
function setFailed(text) {
  if (!box) build();
  msg.textContent = text;
  btn.textContent = '再試一次';
  cont.hidden = false;
}
function setNormal() {
  if (!box) return;
  msg.textContent = '請回到全螢幕，繼續活動';
  btn.textContent = '回到全螢幕';
  cont.hidden = true;
}

export function update() {
  if (fsElement()) { dismissed = false; setNormal(); return hide(); }
  if (!wanted || dismissed) return hide();
  show();
}

async function onReturn() {
  if (busy) return;
  busy = true; btn.disabled = true;
  try {
    if (!fullscreenSupported()) throw new Error('UNSUPPORTED');
    await requestFs();
    // 成功與否以 fullscreenchange 為準；部分瀏覽器 resolve 時狀態已更新
    setTimeout(update, 0);
  } catch (e) {
    setFailed(fullscreenSupported()
      ? '瀏覽器沒有允許全螢幕。可以再試一次，或先繼續活動。'
      : '這台裝置或瀏覽器不支援全螢幕，請直接繼續活動。');
    show();
  } finally {
    busy = false; btn.disabled = false;
  }
}

// 學生按下「進入探索模式」：請求全螢幕；失敗時顯示說明，但學生仍可繼續活動
export async function enterFullscreen() {
  wanted = true; dismissed = false;
  if (!fullscreenSupported()) { setFailed('這台裝置或瀏覽器不支援全螢幕，請直接繼續活動。'); show(); return false; }
  try { await requestFs(); setNormal(); setTimeout(update, 0); return true; }
  catch { setFailed('瀏覽器沒有允許全螢幕。可以再試一次，或先繼續活動。'); show(); return false; }
}

// 提示顯示中，對話框開啟或關閉（閱讀卡關閉時連同裡面的提示一起移除）→ 重新放置
new MutationObserver(() => {
  if (box && !box.hidden && wanted && !dismissed && !fsElement()) { box.hidden = false; place(); }
}).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
doc.addEventListener('fullscreenchange', update);
doc.addEventListener('webkitfullscreenchange', update);
// 測試用：目前提示的狀態
export const fsState = () => ({ wanted, dismissed, shown: Boolean(box && !box.hidden), inFullscreen: Boolean(fsElement()) });
