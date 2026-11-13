// 投影畫面渲染（投影端與教師端預覽共用同一份程式，確保「預覽＝實際投影」）。
// 只讀取 projector_state 回傳的公開資料。
import { h, media } from './dom.js';
import { qrDataUrl, joinUrl } from './qr.js';
import { TEXT } from './phases.js';

export function renderProjection(data, { showQr = true } = {}) {
  const p = data?.projection || {};
  const stage = h('div.stage', { 'data-screen': p.screen || 'none' });
  if (data?.status === 'ended' && p.screen !== 'end') {
    stage.append(h('div.st-center', h('h1.st-title', '活動已結束')));
    return stage;
  }
  const fn = SCREENS[p.screen] || SCREENS.none;
  stage.append(fn(p, data, { showQr }));
  return stage;
}

// ---------- 小說類型圖片（06 直式、07 橫式）----------
// 本專案的類型圖卡（assets/genres/<slug>-<portrait|landscape>.webp）另有較小版本：直式 600w、橫式 960w。
// 其他網址只有單一來源。
const VARIANT_W = { portrait: [600, 1086], landscape: [960, 1672] };
export function genreSources(url) {
  const m = /^(assets\/genres\/[a-z0-9-]+)-(portrait|landscape)\.webp$/.exec(url || '');
  if (!m) return null;
  const [small, full] = VARIANT_W[m[2]];
  return [{ url: `${m[1]}-${m[2]}-${small}w.webp`, w: small }, { url, w: full }];
}

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
function genreVisualBox(url, alt, slot) {
  sweepBoxes();
  const box = h(`div.st-visual.${slot}`);
  if (!url) {
    box.classList.add('missing'); box.setAttribute('role', 'img'); box.setAttribute('aria-label', alt);
    box.append(h('div.st-visual-fallback', h('span.st-visual-alt', alt)));
    return box;
  }
  const set = genreSources(url);
  const c = { box, created: Date.now(), attached: false, width: 0, img: null, timer: null, ro: null, auto: 0, online: 0, failed: false, disposed: false };
  const wait = h('span.st-visual-wait', '圖片載入中…');
  const btn = h('button.st-visual-retry', { type: 'button', title: '重新載入圖片', 'aria-label': '重新載入圖片', onclick: (e) => { e.stopPropagation(); c.retry(); } },
    h('span.st-visual-retry-text', '重新載入圖片'), h('span.st-visual-retry-icon', { 'aria-hidden': 'true' }, '↻'));
  const fallback = h('div.st-visual-fallback', h('span.st-visual-alt', alt), btn);
  // 圖片框太小（例如 07 左側內容很多、橫式圖被壓到最矮）放不下完整按鈕時，改成只有圖示的 44×44 圓形按鈕，
  // 描述文字改為僅供螢幕閱讀器；不縮小字級或觸控尺寸（複檢 87f1853 F1）。尺寸改變時重新判斷。
  const fit = () => {
    if (!c.failed || !box.isConnected) return;
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
const genreAlt = (name) => `「${name}」類型情境插畫（觀察線索）`;
// 常見特色前的標記：舊資料有圖示時沿用，否則用編號
const featureMark = (e, k) => e.icon || String(k + 1);

const SCREENS = {
  none: (p, d) => h('div.st-center', h('h1.st-title', d?.title || TEXT.activity)),

  join: (p, d, { showQr }) => {
    const url = d.join_code ? joinUrl(d.join_code) : '';
    const qr = h('div.st-qr', h('span.muted', 'QR Code 載入中…'));
    if (showQr && url) {
      qrDataUrl(url).then((src) => {
        qr.replaceChildren(src ? h('img', { src, alt: '加入活動 QR Code' })
                               : h('div.st-qr-fallback', '請在瀏覽器輸入下方網址'));
      });
    } else if (!showQr) {
      qr.replaceChildren(h('div.st-qr-fallback', 'QR'));
    }
    return h('div.st-join',
      h('div.st-join-left',
        h('h1.st-title', d.title || TEXT.activity),
        qr,
        h('div.st-code', h('span', '活動代碼'), h('strong', d.join_code || '------')),
        h('div.st-url', url),
        d.join_open ? null : h('div.st-badge.warn', '目前暫停加入')),
      h('div.st-join-right',
        h('h2', '各組加入狀態'),
        h('div.st-groups', (d.groups || []).map((g) =>
          h('div.st-group' + (g.count > 0 ? '.on' : ''),
            h('div.st-group-name', g.name), h('div.st-group-count', g.count + ' 人'))))));
  },

  intro: (p) => {
    if (p.view === 'open') {
      return h('div.st-center.st-intro-open',
        media(null, '情境背景', 'st-bg'),
        h('div.st-overlay', h('h1.st-title', '故事世界的入口'),
          h('p.st-sub', `有 ${p.total || 0} 個神祕的故事正在等待我們探索`)));
    }
    if (p.view === 'crossroads') {
      return h('div.st-crossroads',
        h('h1.st-title', '故事世界的交會'),
        h('div.st-cross-row', (p.stories || []).map((s) =>
          h('div.st-cross-card', media(s.image_url, '故事代表圖片'), h('div.st-cross-title', s.title)))),
        h('p.st-prompt', '這些故事有什麼共同的特色？'));
    }
    const s = p.story || {};
    return h('div.st-story',
      media(s.background_url, '情境背景', 'st-bg'),
      h('div.st-story-head',
        h('span.st-chip', `神祕故事 ${(s.index ?? 0) + 1} / ${s.total || 0}`),
        h('span.st-chip.light', `線索 ${(s.clues || []).length} / ${s.clue_total || 0}`)),
      h('div.st-clues', (s.clues || []).map((c) =>
        h('div.st-clue', media(c.image_url, c.label || '線索插畫', 'st-clue-img'),
          h('div.st-clue-label', c.label), h('div.st-clue-body', c.body)))),
      s.title
        ? h('div.st-reveal', media(s.image_url, '故事代表圖片', 'st-reveal-img'),
            h('div', h('div.st-reveal-title', s.title), h('div.st-reveal-text', s.reveal_text || '')))
        : h('div.st-guess', '這是什麼故事呢？'));
  },

  task: (p) => h('div.st-center',
    h('h1.st-title.big', p.title || TEXT.activity),
    h('p.st-lead', p.text),
    h('div.st-tips',
      h('div.st-tip', '① 閱讀故事卡'),
      h('div.st-tip', '② 新增分類，把故事放進去'),
      h('div.st-tip', '③ 幫每一類取名字'))),

  instruction: (p) => h('div.st-center', h('h1.st-title', p.title), p.text ? h('p.st-lead', p.text) : null,
    p.items?.length ? h('ol.st-steps', p.items.map((x) => h('li', x))) : null),

  // 05／07 尚未公開任何內容時的等待畫面（不含任何成果資料）
  placeholder: (p) => h('div.st-center', h('h1.st-title', p.title), h('p.st-sub.muted', p.sub || '請看老師準備要展示的內容')),

  // 05：雙組比較。所有文字都是伺服器白名單產生的公開資料；未揭露的理由只有狀態、沒有內容。
  compare: (p) => {
    const sides = p.sides || [];
    if (!sides.length) {
      return h('div.st-center', h('h1.st-title', p.title || '分類成果大公開'), h('p.st-sub.muted', '老師正在準備要展示的成果'));
    }
    return h('div.st-compare' + (sides.length === 1 ? '.single' : '') + (p.zoom ? '.zoom' : ''),
      h('div.st-cmp-head', h('h1.st-cmp-title', p.title || '分類成果大公開'),
        p.story ? h('span.st-cmp-track', '追蹤故事：', h('b', p.story.title)) : null),
      h('div.st-cmp-body', sides.map((sd) => h('section.st-side',
        h('div.st-side-head',
          h('span.st-side-group', sd.group),
          h('span.st-side-kind' + (sd.kind === 'submitted' ? '' : '.locked'), sd.kind === 'submitted' ? '小組正式提交' : '教師結束時保存（未正式提交）'),
          sd.pages > 1 && !sd.focus ? h('span.st-side-page', `第 ${sd.page + 1}／${sd.pages} 頁`) : null),
        sd.track ? h('div.st-side-track' + (sd.track.unplaced ? '.none' : ''),
          `「${p.story?.title || ''}」`, sd.track.unplaced ? '尚未分類' : h('span', '在「', h('b', sd.track.where), '」')) : null,
        sd.categories.length
          ? h('div.st-cats' + (sd.focus ? '.focus' : ''), sd.categories.map((c) => h('div.st-cat' + (c.cards.some((x) => x.tracked) ? '.has-track' : ''),
              h('div.st-cat-name', c.label, c.unnamed ? h('span.st-unnamed', '（未命名）') : null),
              h('div.st-cat-cards', c.cards.map((x) => h('span.st-chip-card' + (x.tracked ? '.tracked' : ''), x.title))),
              c.reason_state === 'shown' ? h('div.st-cat-reason', h('span.st-reason-label', '共同特色'), c.reason)
                : c.reason_state === 'empty' ? h('div.st-cat-reason.empty', '（這一類沒有寫共同特色）')
                : h('div.st-cat-reason.hidden', '共同特色：等一下揭曉')))
          )
          : h('p.st-sub.muted', '這一組沒有已分類的故事'),
        sd.unplaced_count ? h('div.st-side-unplaced', `尚未分類的故事：${sd.unplaced_count} 張`) : null))));
  },

  // 07：原始分類 ↔ 小說類型常見特色對照
  match: (p) => {
    const c = p.category; const g = p.genre;
    return h('div.st-match',
      h('div.st-match-head', h('h1.st-cmp-title', p.title || '小小故事分類師')),
      h('div.st-match-body',
        h('section.st-match-left',
          p.group ? h('div.st-side-head', h('span.st-side-group', p.group.group),
            h('span.st-side-kind' + (p.group.kind === 'submitted' ? '' : '.locked'), p.group.kind === 'submitted' ? '小組正式提交' : '教師結束時保存（未正式提交）')) : null,
          c ? h('div.st-match-cat',
                h('div.st-cat-name.big', c.label, c.unnamed ? h('span.st-unnamed', '（未命名）') : null),
                // 故事較多時改為名稱標籤（不放圖片，三欄排列），字級不變：顯示理由時超過 3 張、未顯示時超過 6 張
                c.cards.length > (c.reason_state === 'shown' ? 3 : 6)
                  ? h('div.st-cat-cards.st-match-chips', c.cards.map((x) => h('span.st-chip-card', x.title)))
                  : h('div.st-match-cards', c.cards.map((x) => h('div.st-match-card', media(x.image_url, x.title, 'st-match-img'), h('span', x.title)))),
                c.reason_state === 'empty' ? h('div.st-cat-reason.empty', '（這一類沒有寫共同特色）') : null)
            : h('p.st-sub.muted', '老師正在選擇要對照的分類')),
        h('section.st-match-right',
          g ? h('div.st-match-genre',
                genreVisualBox(g.visual_url, genreAlt(g.name), 'landscape'),
                h('div.st-match-gname', g.name),
                h('div.st-match-els', g.elements.map((e, k) => e.revealed
                  ? h('div.st-match-el' + (e.highlight ? '.hl' : ''), h('span.icon', featureMark(e, k)), h('span', e.label), e.highlight ? h('span.st-hl-tag', '相似') : null)
                  : h('div.st-match-el.hidden', h('span.icon', '？'), h('span', TEXT.featureHidden)))))
            : h('div.st-match-genre.empty', h('div.st-mystery', '？'), h('p.st-sub', TEXT.matchQuestion)))),
      // 共同特色（最多 300 字）放在左右對照下方、橫跨整個畫面，字級不變
      c && c.reason_state === 'shown' ? h('div.st-cat-reason.st-match-reason', h('span.st-reason-label', '共同特色'), c.reason) : null,
      p.scaffold ? h('div.st-scaffold', TEXT.scaffold) : null);
  },

  genre: (p) => {
    if (p.view === 'recap') {
      return h('div.st-center', h('h1.st-title', '分類背後的祕密'),
        h('p.st-lead', '我們剛才是根據什麼來分類故事的？'),
        h('div.st-tips', (p.items || []).map((x) => h('div.st-tip.big', x))));
    }
    if (p.view === 'overview') {
      return h('div.st-overview', h('h1.st-title', '小說類型總覽'),
        h('div.st-ov-row', (p.genres || []).map((g) => g
          ? h('div.st-ov-card', h('div.st-ov-name', g.name),
              h('ul', (g.elements || []).map((e) => (e && !e.hidden
                ? h('li', e.icon ? h('span.icon', e.icon) : null, e.label)
                : h('li.hidden', h('span.icon', '？'), TEXT.featureHiddenShort)))))
          : h('div.st-ov-card.hidden', h('div.st-ov-name', '？')))));
    }
    if (p.view === 'teaser' || !p.genre) {
      return h('div.st-center', h('span.st-chip', `小說類型 ${(p.index ?? 0) + 1}／${p.total || 0}`),
        h('div.st-mystery', '？'), h('p.st-sub', '即將揭開下一種小說類型'));
    }
    const g = p.genre;
    // 06：左側直式主圖（3:4，完整呈現）；右側類型名稱與三項常見特色（三列，由網站文字呈現）
    return h('div.st-genre',
      genreVisualBox(g.visual_url, genreAlt(g.name), 'portrait'),
      h('div.st-genre-body',
        h('span.st-chip', `小說類型 ${(p.index ?? 0) + 1}／${p.total || 0}`),
        h('h1.st-title.big', g.name),
        h('p.st-feature-head', '常見特色'),
        h('ol.st-features', g.elements.map((e, k) =>
          h('li.st-feature', h('span.st-feature-n', featureMark(e, k)), h('span.st-feature-t', e.label))))));
  },

  end: (p) => h('div.st-center.st-end', media(null, '結束畫面背景', 'st-bg'),
    h('div.st-overlay', h('h1.st-title.big', p.line1), h('p.st-lead', p.line2))),
};
