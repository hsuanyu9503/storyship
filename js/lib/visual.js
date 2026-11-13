// 圖片框（投影的小說類型圖、第 03／04 環節的故事卡圖共用）。
//   由 render-projection.js 抽出（2026-11 故事卡教材），行為不變：先量寬度再設定 srcset／sizes、有限次數的自動重試、
//   online 時重試、手動重試、小框改用圖示按鈕、離開畫面後確定釋放（計時器、online 監聽、ResizeObserver）。
import { h } from './dom.js';

// 圖片框：比例由版位決定（slot＝portrait 3:4、landscape 16:9），圖片以完整呈現的方式置中（不裁切、不拉伸）。
//   * 有多個尺寸時，先量到圖片框實際寬度再設定 srcset／sizes：教師的小預覽與投影各自選用適當尺寸，瀏覽器另依裝置像素比選擇。
//     量到之前不設定來源，因此不會先下載一張用不到的大圖；只有目前畫面上的這一張會被下載（不預載其他類型）。
//   * 載入中顯示「圖片載入中…」；沒有圖片時顯示描述文字（替代框）。
//   * 載入失敗（複檢 F1）：投影端只在公開版本改變時重繪，所以圖片要自己恢復——
//     顯示替代框與「重新載入圖片」按鈕，並自動重試（2、6、15 秒後，共 3 次）；瀏覽器回到線上時再重試（最多 2 次）。
//     每次重試用新的 <img>，舊 <img> 的事件一律忽略。圖片框離開畫面（例如切換類型）後，計時器、online 監聽與 ResizeObserver 全部釋放。
const RETRY_DELAYS = [2000, 6000, 15000];
const ONLINE_RETRIES = 2;
const liveBoxes = new Set();
//   清理（複檢 F2）：離開畫面的圖片框一定會被釋放——建立新圖片框時清一次，另有一個只在還有圖片框時才存在的計時器，
//   每秒清一次（畫面停在等待／總覽等沒有圖片的畫面時也會清）；所有圖片框都釋放後計時器即停止。
//   還沒掛上畫面的圖片框有 5 秒寬限（建立後立即插入是正常流程），所以最晚約 6 秒內釋放。
const GRACE_MS = 5000;
const SWEEP_MS = 1000;
let sweepTimer = null;
function sweepBoxes() {
  const now = Date.now();
  for (const c of liveBoxes) if (!c.box.isConnected && (c.attached || now - c.created >= GRACE_MS)) c.dispose();
}
function scheduleSweep() {
  if (sweepTimer || !liveBoxes.size) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; sweepBoxes(); scheduleSweep(); }, SWEEP_MS);
}
// 測試與教師端用：目前保留的圖片框數、重新載入某個範圍內失敗的圖片（每個失敗的框只發一個請求）
export function visualBoxCount() { return liveBoxes.size; }
export function retryVisuals(root) {
  let n = 0;
  for (const c of liveBoxes) if (c.failed && !c.disposed && c.box.isConnected && root.contains(c.box)) { c.retry(); n++; }
  return n;
}
const notify = (box, failed) => box.dispatchEvent(new CustomEvent('st-visual', { bubbles: true, detail: { failed } }));
const controllers = new WeakMap();
// 圖片框是否仍有效（尚未釋放）：重複使用同一個圖片框（例如看板重畫時）前先確認
export function visualAlive(box) { const c = controllers.get(box); return Boolean(c && !c.disposed); }
// visualBox(url, alt, { slot, sources, retryButton })
//   slot：CSS 版位（portrait／landscape／story），決定比例
//   sources：[{ url, w }]（由小到大）或 null（只有單一來源）
//   retryButton：false 時替代框不放「重新載入圖片」按鈕（例如圖片框位於另一個按鈕裡面時；仍會自動重試）
export function visualBox(url, alt, { slot = 'landscape', sources = null, retryButton = true } = {}) {
  sweepBoxes();
  const box = h(`div.st-visual.${slot}`);
  if (!url) {
    box.classList.add('missing'); box.setAttribute('role', 'img'); box.setAttribute('aria-label', alt);
    box.append(h('div.st-visual-fallback', h('span.st-visual-alt', alt)));
    return box;
  }
  const set = sources && sources.length ? sources : null;
  const c = { box, created: Date.now(), attached: false, width: 0, img: null, timer: null, ro: null, auto: 0, online: 0, failed: false, disposed: false };
  const wait = h('span.st-visual-wait', '圖片載入中…');
  const btn = h('button.st-visual-retry', { type: 'button', title: '重新載入圖片', 'aria-label': '重新載入圖片', onclick: (e) => { e.stopPropagation(); c.retry(); } },
    h('span.st-visual-retry-text', '重新載入圖片'), h('span.st-visual-retry-icon', { 'aria-hidden': 'true' }, '↻'));
  const fallback = h('div.st-visual-fallback', h('span.st-visual-alt', alt), retryButton ? btn : null);
  // 圖片框太小（例如 07 左側內容很多、橫式圖被壓到最矮）放不下完整按鈕時，改成只有圖示的 44×44 圓形按鈕，
  // 描述文字改為僅供螢幕閱讀器；不縮小字級或觸控尺寸（複檢 87f1853 F1）。尺寸改變時重新判斷。
  const fit = () => {
    if (!retryButton || !c.failed || !box.isConnected) return;
    box.classList.remove('compact');
    const b = btn.getBoundingClientRect(); const r = box.getBoundingClientRect();
    if (b.width > 0 && (b.left < r.left + 1 || b.right > r.right - 1 || b.top < r.top + 1 || b.bottom > r.bottom - 1)) box.classList.add('compact');
  };
  c.retry = () => { if (c.disposed || !c.failed) return; clearTimeout(c.timer); load(); };
  const onOnline = () => { if (c.failed && c.online < ONLINE_RETRIES && box.isConnected) { c.online++; c.retry(); } };
  c.dispose = () => {
    if (c.disposed) return;
    c.disposed = true; c.failed = false; clearTimeout(c.timer); c.ro?.disconnect(); c.ro = null; window.removeEventListener('online', onOnline); liveBoxes.delete(c);
  };
  function load() {
    if (c.disposed) return;
    const wasFailed = box.classList.contains('failed');
    c.failed = false;
    fallback.remove();
    box.classList.remove('missing', 'failed', 'compact'); box.classList.add('loading');
    if (wasFailed) notify(box, false);   // 重試中：教師端的「重新載入預覽圖片」先隱藏，失敗時再出現
    const img = h('img', { alt, decoding: 'async', fetchpriority: 'high' });
    img.addEventListener('load', () => {
      if (c.img !== img) return;
      box.classList.remove('loading', 'missing', 'failed');
      window.removeEventListener('online', onOnline);
      if (!c.disposed) notify(box, false);
    });
    img.addEventListener('error', () => {
      if (c.img !== img) return;
      if (c.disposed) return;
      if (!box.isConnected && c.attached) { c.dispose(); return; }
      c.failed = true;
      box.classList.remove('loading'); box.classList.add('missing', 'failed');
      box.append(fallback);
      fit();
      notify(box, true);
      window.addEventListener('online', onOnline);
      if (c.auto < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[c.auto++];
        c.timer = setTimeout(() => { if (c.disposed) return; if (!box.isConnected) { c.dispose(); return; } load(); }, delay);
      }
    });
    if (set) { img.sizes = c.width + 'px'; img.srcset = set.map((x) => `${x.url} ${x.w}w`).join(', '); img.src = set[0].url; }
    else img.src = url;
    c.img?.remove();
    c.img = img;
    box.prepend(img);
  }
  box.classList.add('loading');
  box.append(wait);
  liveBoxes.add(c);
  controllers.set(box, c);
  scheduleSweep();
  if (!set || typeof ResizeObserver === 'undefined') { c.attached = true; load(); return box; }
  c.ro = new ResizeObserver((entries) => {
    if (c.disposed) return;
    if (!box.isConnected) { if (c.attached) c.dispose(); return; }
    c.attached = true;
    const w = Math.round(entries[0].contentRect.width);
    if (!w) return;
    if (!c.img) { c.width = w; load(); return; }
    if (c.failed) fit();
    // 寬度改變（例如投影切換全螢幕）時更新 sizes；失敗中的圖片不更新，以免瀏覽器自行重新請求
    if (Math.abs(w - c.width) > 1 && !c.failed) { c.width = w; c.img.sizes = w + 'px'; }
  });
  c.ro.observe(box);
  return box;
}
