// 投影內容產生器（純函式，可在 Node 測試）。
// 原則：只把「教師已核准公開」的資料放進回傳物件；未公開的線索與答案不會出現在投影資料中。
import { TEXT } from './phases.js';

export function joinProjection() {
  return { screen: 'join' };
}

// 第一環節
// intro: { view: 'open'|'story'|'crossroads', index, clues, revealed, seen: [已揭曉故事的 index] }
export function introInitial() {
  return { view: 'open', index: 0, clues: 0, revealed: false, seen: [] };
}

export function introSub(intro) {
  if (intro.view === 'open') return '01-01';
  if (intro.view === 'crossroads') return '01-04';
  return intro.revealed ? '01-03' : '01-02';
}

export function introProjection(stories, intro) {
  const base = { screen: 'intro', ctl: { ...intro, seen: [...(intro.seen || [])] } };
  if (intro.view === 'open') return { ...base, view: 'open', total: stories.length };
  if (intro.view === 'crossroads') {
    return {
      ...base,
      view: 'crossroads',
      stories: (intro.seen || [])
        .filter((i) => stories[i])
        .map((i) => ({ title: stories[i].title, image_url: stories[i].image_url || null })),
    };
  }
  const s = stories[intro.index];
  if (!s) return { ...base, view: 'open', total: stories.length };
  const clues = (s.clues || []).slice(0, Math.max(0, intro.clues)).map((c) => ({
    kind: c.kind, label: c.label, body: c.body, image_url: c.image_url || null,
  }));
  const story = {
    index: intro.index,
    total: stories.length,
    clue_total: (s.clues || []).length,
    background_url: s.background_url || null,
    clues,
  };
  if (intro.revealed) {
    story.title = s.title;
    story.reveal_text = s.reveal_text;
    story.image_url = s.image_url || null;
  }
  return { ...base, view: 'story', story };
}

// 教師端操作（回傳新的 intro 狀態，不修改原物件）
export const introOps = {
  start: (stories, st) => ({ ...st, view: 'story', index: 0, clues: 0, revealed: false }),
  nextClue: (stories, st) => {
    const max = (stories[st.index]?.clues || []).length;
    return { ...st, view: 'story', clues: Math.min(max, st.clues + 1) };
  },
  prevClue: (stories, st) => ({ ...st, view: 'story', clues: Math.max(0, st.clues - 1), revealed: false }),
  reveal: (stories, st) => ({
    ...st, view: 'story', revealed: true,
    clues: (stories[st.index]?.clues || []).length,
    seen: [...new Set([...(st.seen || []), st.index])].sort((a, b) => a - b),
  }),
  nextStory: (stories, st) => (st.index + 1 < stories.length
    ? { ...st, view: 'story', index: st.index + 1, clues: 0, revealed: false }
    : st),
  prevStory: (stories, st) => (st.index > 0
    ? { ...st, view: 'story', index: st.index - 1, clues: 0, revealed: (st.seen || []).includes(st.index - 1) }
    : st),
  crossroads: (stories, st) => ({ ...st, view: 'crossroads' }),
};

export function taskProjection() {
  return { screen: 'task', title: TEXT.activity, text: TEXT.task };
}

// 04 後段：教師切換的整理提醒（同一環節的子畫面）
export function groupWrapProjection() {
  return { screen: 'instruction', title: '整理並提交', text: TEXT.groupWrap };
}

export function instructionProjection(phaseId) {
  if (phaseId === '03') return { screen: 'instruction', title: '我的故事分類', text: '', items: TEXT.personalSteps };
  if (phaseId === '04') return { screen: 'instruction', title: TEXT.groupTitle, text: '', items: TEXT.groupSteps };
  return { screen: 'instruction', title: '', text: '' };
}

// 第五、七環節：尚未公開任何成果時的等待畫面（不含任何小組資料）。
// 成果畫面（screen: compare／match）只能由伺服器依白名單產生（teacher_publish_compare／teacher_publish_match）。
export function placeholderProjection(title, sub) {
  return sub ? { screen: 'placeholder', title, sub } : { screen: 'placeholder', title };
}

// 第六環節
// genre: { view: 'recap'|'teaser'|'genre'|'overview', index, revealed: [已公開 index] }
export function genreInitial() {
  return { view: 'recap', index: 0, revealed: [] };
}

export function genreSub(g) {
  return g.view === 'recap' ? '06-01' : g.view === 'overview' ? '06-03' : '06-02';
}

function genrePublic(x) {
  return { name: x.name, visual_url: x.visual_url || null,
           elements: (x.elements || []).slice(0, 3).map((e) => ({ label: e.label, icon: e.icon || '' })) };
}

export function genreProjection(genres, g) {
  const ctl = { ...g, revealed: [...(g.revealed || [])] };
  if (g.view === 'recap') return { screen: 'genre', view: 'recap', items: TEXT.recapItems, ctl };
  if (g.view === 'overview') {
    // 總覽只顯示已公開的類型；未公開者以「？」卡呈現
    return {
      screen: 'genre', view: 'overview', ctl,
      genres: genres.map((x, i) => (ctl.revealed.includes(i) ? genrePublic(x) : null)),
    };
  }
  const isOpen = ctl.revealed.includes(g.index) && g.view === 'genre';
  return {
    screen: 'genre', view: isOpen ? 'genre' : 'teaser', ctl,
    index: g.index, total: genres.length,
    genre: isOpen ? genrePublic(genres[g.index]) : null,
  };
}

export const genreOps = {
  recap: (genres, g) => ({ ...g, view: 'recap' }),
  goto: (genres, g, i) => {
    const index = Math.max(0, Math.min(genres.length - 1, i));
    return { ...g, index, view: (g.revealed || []).includes(index) ? 'genre' : 'teaser' };
  },
  reveal: (genres, g) => ({
    ...g, view: 'genre',
    revealed: [...new Set([...(g.revealed || []), g.index])].sort((a, b) => a - b),
  }),
  overview: (genres, g) => ({ ...g, view: 'overview' }),
};

export function endProjection() {
  return { screen: 'end', line1: TEXT.endLine1, line2: TEXT.endLine2 };
}

// 各環節進入時的預設投影
export function defaultProjection(phaseId, content) {
  switch (phaseId) {
    case '00': return { sub: '00', projection: joinProjection() };
    case '01': {
      const st = introInitial();
      return { sub: introSub(st), projection: introProjection(content.intro || [], st) };
    }
    case '02': return { sub: '02', projection: taskProjection() };
    case '03':
    case '04': return { sub: phaseId, projection: instructionProjection(phaseId) };
    case '05': return { sub: '05', projection: placeholderProjection('分類成果大公開', '比一比：兩組的分類有什麼不同？') };
    case '06': {
      const g = genreInitial();
      return { sub: genreSub(g), projection: genreProjection(content.genres || [], g) };
    }
    case '07': return { sub: '07', projection: placeholderProjection('小小故事分類師', '我們的分類，和哪一種小說比較接近？') };
    case '99': return { sub: '99', projection: endProjection() };
    default: return { sub: '', projection: {} };
  }
}
