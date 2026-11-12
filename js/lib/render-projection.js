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

  // 05／07 尚未公開任何內容時的等待畫面（不含任何成果資料）
  placeholder: (p) => h('div.st-center', h('h1.st-title', p.title), h('p.st-sub.muted', p.sub || '請看老師準備要展示的內容')),

  // 05：雙組比較。所有文字都是伺服器白名單產生的公開資料；未揭露的理由只有狀態、沒有內容。
  compare: (p) => {
    const sides = p.sides || [];
    if (!sides.length) {
      return h('div.st-center', h('h1.st-title', p.title || '分類成果大公開'), h('p.st-sub.muted', '老師正在準備要展示的成果'));
    }
    return h('div.st-compare' + (sides.length === 1 ? '.single' : ''),
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

  // 07：原始分類 ↔ 小說類型要素對照
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
                h('div.st-match-cards', c.cards.map((x) => h('div.st-match-card', media(x.image_url, x.title, 'st-match-img'), h('span', x.title)))),
                c.reason_state === 'shown' ? h('div.st-cat-reason', h('span.st-reason-label', '共同特色'), c.reason)
                  : c.reason_state === 'empty' ? h('div.st-cat-reason.empty', '（這一類沒有寫共同特色）') : null)
            : h('p.st-sub.muted', '老師正在選擇要對照的分類')),
        h('section.st-match-right',
          g ? h('div.st-match-genre',
                media(g.visual_url, g.name, 'st-match-visual'),
                h('div.st-match-gname', g.name),
                h('div.st-match-els', g.elements.map((e) => e.revealed
                  ? h('div.st-match-el' + (e.highlight ? '.hl' : ''), h('span.icon', e.icon || '◆'), h('span', e.label), e.highlight ? h('span.st-hl-tag', '相似') : null)
                  : h('div.st-match-el.hidden', h('span.icon', '？'), h('span', '核心要素')))))
            : h('div.st-match-genre.empty', h('div.st-mystery', '？'), h('p.st-sub', '這些故事和哪一種小說比較接近？')))),
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
