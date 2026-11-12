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

  placeholder: (p) => h('div.st-center', h('h1.st-title', p.title), h('p.st-sub.muted', '（此環節的展示功能將於 Phase 4 完成）')),

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
              h('ul', g.elements.map((e) => h('li', h('span.icon', e.icon), e.label))))
          : h('div.st-ov-card.hidden', h('div.st-ov-name', '？')))));
    }
    if (p.view === 'teaser' || !p.genre) {
      return h('div.st-center', h('span.st-chip', `小說世界 ${(p.index ?? 0) + 1} / ${p.total || 0}`),
        h('div.st-mystery', '？'), h('p.st-sub', '即將揭開下一個小說世界'));
    }
    const g = p.genre;
    return h('div.st-genre',
      media(g.visual_url, '小說類型主視覺', 'st-genre-visual'),
      h('div.st-genre-body',
        h('span.st-chip', `小說世界 ${(p.index ?? 0) + 1} / ${p.total || 0}`),
        h('h1.st-title.big', g.name),
        h('div.st-elements', g.elements.map((e) =>
          h('div.st-element', h('div.icon', e.icon || '◆'), h('div', e.label))))));
  },

  end: (p) => h('div.st-center.st-end', media(null, '結束畫面背景', 'st-bg'),
    h('div.st-overlay', h('h1.st-title.big', p.line1), h('p.st-lead', p.line2))),
};
