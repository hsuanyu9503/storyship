// 學生端全螢幕（2026-11-26 改版）
//
// 何時要求全螢幕：學生按「確認加入」組別時，在同一次點擊中請求全螢幕（瀏覽器要求由使用者操作觸發，不能等網路回應後再請求）。
// 加入成功後（含重新整理、斷線重連後恢復身分），只要瀏覽器實際不在全螢幕，就顯示全黑遮罩：
//   「請回到全螢幕，繼續活動」＋按鈕「回到全螢幕」。只有實際進入全螢幕（document.fullscreenElement）後遮罩才消失。
//
// 判斷依據：只看瀏覽器的全螢幕狀態（fullscreenElement／webkitFullscreenElement 與 fullscreenchange 事件）。
//   視窗大小改變、虛擬鍵盤出現、頁面暫時失去焦點都不會被當成退出全螢幕（不監聽 resize、blur、visualViewport）。
//
// 遮罩：<dialog> 以 showModal() 開啟，放在瀏覽器最上層（top layer），蓋住活動、卡片、導覽與其他對話框（例如閱讀卡）；
//   其餘頁面成為 inert，滑鼠、觸控、鍵盤都無法操作背景。Esc 不能關閉；被其他對話框蓋過或被瀏覽器關閉時會重新放到最上層。
//   遮罩只建立一次，事件監聽只註冊一次；退出／返回反覆操作不會累積。
//   遮罩不重畫下面的活動畫面：作答、卡片位置、閱讀卡翻面狀態、尚未送出的文字都保留；資料同步照常進行，返回後看到最新環節。
//
// 正在打字時退出全螢幕（iPad：iPadOS 的 Safari 與 Chrome 都用 WebKit，叫出虛擬鍵盤或打字時由系統退出全螢幕）：
//   焦點在文字欄位時不立即顯示遮罩（避免打斷注音組字、讓輸入框失去焦點，形成「回到全螢幕 → 一打字又被退出」的循環），
//   改在畫面上方顯示不擋操作的小提示「完成輸入後，請回到全螢幕」。
//   學生完成輸入的那一下操作（點其他地方、按 Enter 離開分類名稱）本身就是使用者操作：在那個事件中直接重新請求全螢幕，
//   成功就不顯示遮罩；不是由使用者操作離開（例如系統收起鍵盤）或瀏覽器拒絕時，才顯示黑色遮罩與「回到全螢幕」。
//
// 請求失敗：遮罩顯示原因，按鈕可重試；連續失敗兩次後，另外提供「先以一般畫面繼續」（並請學生舉手告訴老師），避免被困住。
// 瀏覽器完全不支援全螢幕（例如 iPhone 的 Safari）：不顯示遮罩，只在畫面上方顯示說明，活動以一般畫面進行。
import { h } from '../lib/dom.js';

const doc = document;
const fsElement = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;
export const fsActive = () => Boolean(fsElement());
export function fsSupported() {
  const el = doc.documentElement;
  const api = Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return api && enabled !== false;
}

const MSG = '請回到全螢幕，繼續活動';
const DENIED = '瀏覽器沒有允許全螢幕，請再按一次「回到全螢幕」。';
const DENIED_AGAIN = '仍無法進入全螢幕。請舉手告訴老師；需要時可先以一般畫面繼續。';
const UNSUPPORTED = '這台裝置的瀏覽器不支援全螢幕，活動將以一般畫面進行。';

let required = false;   // 學生已加入活動：退出全螢幕時要顯示遮罩
let bypass = false;     // 連續失敗後學生選擇「先以一般畫面繼續」（下次成功進入全螢幕後恢復）
let failed = 0;         // 連續請求失敗次數
let busy = false;
let deferred = false;   // 打字中退出：遮罩延後到離開文字欄位
let reraising = false;
let autoPending = false;   // 完成輸入時自動重新進入全螢幕的請求進行中（期間不顯示遮罩）
let dlg = null; let msgEl = null; let errEl = null; let btn = null; let alt = null;
let note = null; let info = null; let infoShown = false;

// 在使用者操作（點擊、按鍵）的事件處理中「同步」呼叫：瀏覽器只在使用者操作當下允許進入全螢幕
export function requestFs() {
  try {
    const el = doc.documentElement;
    if (fsElement()) return Promise.resolve();
    if (!fsSupported()) return Promise.reject(Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' }));
    const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
    return Promise.resolve(r).then(() => {
      // 部分瀏覽器（舊版 webkit）沒有回傳 Promise：以 fullscreenchange 為準，稍候確認
      if (fsElement()) return;
      return new Promise((ok, no) => setTimeout(() => (fsElement() ? ok() : no(new Error('DENIED'))), 400));
    });
  } catch (e) { return Promise.reject(e); }
}

// 文字欄位（分類名稱、共同特色、活動代碼、座號…）是否正在編輯
function editing() { return isEditable(doc.activeElement); }
function isEditable(a) {
  if (!a || a.nodeType !== 1 || a === doc.body || (dlg && dlg.contains(a)) || (note && note.contains(a))) return false;
  if (a.isContentEditable) return true;
  if (a.tagName === 'TEXTAREA') return !a.readOnly && !a.disabled;
  if (a.tagName === 'INPUT') return !a.readOnly && !a.disabled && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(a.type);
  return false;
}

function build() {
  if (dlg) return;
  msgEl = h('p.fsx-msg', MSG);
  errEl = h('p.fsx-err', { hidden: true });
  btn = h('button.fsx-btn', { type: 'button', onclick: onReturn }, '回到全螢幕');
  alt = h('button.fsx-alt', { type: 'button', hidden: true, onclick: () => { bypass = true; update(); } }, '先以一般畫面繼續');
  dlg = h('dialog.fsx', { 'aria-labelledby': 'fsx-msg' }, msgEl, btn, errEl, alt);
  msgEl.id = 'fsx-msg';
  dlg.addEventListener('cancel', (e) => e.preventDefault());           // Esc 不能關閉遮罩
  dlg.addEventListener('close', () => { if (!reraising && shouldBlock()) queueMicrotask(open); });   // 被瀏覽器關閉時重新開啟
  note = h('div.fsx-note', { role: 'status', hidden: true }, h('span', '完成輸入後，請回到全螢幕'),
    h('button', { type: 'button', onclick: onReturn }, '回到全螢幕'));
  info = h('div.fsx-info', { role: 'status', hidden: true }, h('span', UNSUPPORTED),
    h('button', { type: 'button', 'aria-label': '關閉說明', onclick: () => { info.hidden = true; } }, '知道了'));
  doc.body.append(dlg, note, info);
}

const shouldBlock = () => required && !bypass && fsSupported() && !fsActive() && !deferred;

function open() {
  if (!dlg) build();
  if (!shouldBlock()) return;
  if (dlg.open) return;
  try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
}
// 其他對話框（確認視窗、閱讀卡）在遮罩之後開啟：把遮罩重新放到最上層（關閉後再以 showModal 開啟，成為最上層的對話框）
function raise() {
  if (!dlg?.open) return;
  reraising = true;
  try { dlg.close(); } finally { reraising = false; }
  open();
}

function setError(text) {
  errEl.textContent = text || '';
  errEl.hidden = !text;
  alt.hidden = failed < 2;
}

// ---------- 回報給教師端：依瀏覽器實際狀態（on／off），加上請求未被允許（denied）與裝置不支援（unsupported） ----------
//   虛擬鍵盤、視窗大小、輸入框焦點都不影響（只看 fullscreenElement）；打字中延後遮罩時，實際不在全螢幕就回報 typing。
export function fsReportState() {
  if (!fsSupported()) return 'unsupported';
  if (fsActive()) return 'on';
  if (failed > 0) return 'denied';
  // 打字中不在全螢幕（遮罩延後、或完成輸入時正在自動重新進入）：教師端照樣顯示已退出，但不提醒
  return deferred || autoPending ? 'typing' : 'off';
}
const listeners = new Set();
let lastReported = null;
export function onFsChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify() {
  const st = fsReportState();
  if (st === lastReported) return;
  lastReported = st;
  for (const cb of listeners) { try { cb(st); } catch { /* 回報失敗不影響遮罩 */ } }
}

export function update() {
  try { render(); } finally { notify(); }
}
function render() {
  if (!dlg) build();
  if (fsActive()) { failed = 0; bypass = false; deferred = false; setError(''); }
  // 不支援全螢幕：不擋畫面，只顯示說明
  if (!required || fsSupported()) info.hidden = true;
  else if (!infoShown) { info.hidden = false; infoShown = true; }   // 只顯示一次；按「知道了」收起
  if (!required || bypass || !fsSupported() || fsActive()) {
    deferred = false; note.hidden = true;
    if (dlg.open) { reraising = true; try { dlg.close(); } finally { reraising = false; } }
    return;
  }
  if (autoPending) return;   // 自動重新進入中：等結果
  // 不在全螢幕：正在打字時延後，否則顯示遮罩
  if (!dlg.open && editing()) { deferred = true; note.hidden = false; return; }
  deferred = false; note.hidden = true;
  open();
}

async function onReturn() {
  if (busy) return;
  busy = true; btn.disabled = true;
  const p = requestFs();   // 同步請求（在點擊事件中）
  try {
    await p;
    failed = 0;
  } catch (e) {
    failed += 1;
    setError(fsSupported() ? (failed >= 2 ? DENIED_AGAIN : DENIED) : '');
  } finally {
    busy = false; btn.disabled = false;
    deferred = false;
    update();
  }
}

// 「確認加入」的點擊事件中同步呼叫：開始請求全螢幕，回傳結果（不會丟出錯誤）
export function beginFullscreen() {
  return requestFs().then(() => ({ ok: true }), (e) => ({ ok: false, unsupported: !fsSupported(), error: e }));
}

// 學生加入活動（或恢復身分）後開啟；離開活動（被移出、回到選組）時關閉
export function setRequired(on, { failedRequest = false } = {}) {
  required = Boolean(on);
  if (!required) { bypass = false; failed = 0; }
  if (failedRequest && fsSupported() && !fsActive()) { failed = Math.max(failed, 1); if (!dlg) build(); setError(DENIED); }
  update();
}

// 完成輸入：在離開欄位的使用者操作中同步請求全螢幕（瀏覽器只在使用者操作當下允許）；失敗才顯示遮罩
function autoReturn() {
  if (!deferred || autoPending) return;
  deferred = false; note.hidden = true; autoPending = true;
  const done = () => { autoPending = false; update(); };
  requestFs().then(done, done);
}
// 離開文字欄位：移到另一個文字欄位（例如分類名稱 → 共同特色）時繼續延後
doc.addEventListener('focusout', (e) => {
  if (!deferred || autoPending) return;
  if (isEditable(e.relatedTarget)) return;
  autoReturn();
}, true);
// iPad 點空白處不一定會讓輸入框失去焦點：打字中延後時，點文字欄位以外的地方就視為完成輸入（先讓欄位失去焦點、照常儲存）
function onTapOutside(e) {
  if (!deferred || autoPending) return;
  const t = e.target;
  if (isEditable(t) || (t.closest && t.closest('.fsx-note, label'))) return;
  const a = doc.activeElement;
  if (a && a !== doc.body && isEditable(a)) a.blur();   // 觸發 focusout → autoReturn（同一個使用者操作中）
  if (deferred) autoReturn();
}
doc.addEventListener('pointerup', onTapOutside, true);
doc.addEventListener('touchend', onTapOutside, true);
doc.addEventListener('fullscreenchange', update);
doc.addEventListener('webkitfullscreenchange', update);
addEventListener('pageshow', update);
// 遮罩顯示中又開啟其他對話框：把遮罩放回最上層
//   只看這次變動中「新開啟」的其他對話框（DOM 順序不等於最上層的順序，不能用掃描判斷）
const isOpenDialog = (n) => n.nodeType === 1 && n !== dlg && ((n.tagName === 'DIALOG' && n.open) || n.querySelector?.('dialog[open]'));
new MutationObserver((records) => {
  if (!dlg?.open) return;
  if (records.some((r) => (r.type === 'attributes' && r.target !== dlg && r.target.tagName === 'DIALOG' && r.target.open)
                       || (r.type === 'childList' && [...r.addedNodes].some(isOpenDialog)))) raise();
})
  .observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });

// 測試用：目前狀態
export const fsState = () => ({ required, bypass, failed, deferred, inFullscreen: fsActive(), supported: fsSupported(),
  shown: Boolean(dlg?.open), note: Boolean(note && !note.hidden), info: Boolean(info && !info.hidden),
  error: errEl && !errEl.hidden ? errEl.textContent : '', alt: Boolean(alt && !alt.hidden) });
