// 投影內容產生器（純函式，可在 Node 測試）。
// 原則：只把「教師已核准公開」的資料放進回傳物件；未公開的線索與答案不會出現在投影資料中。
import { TEXT } from './phases.js';

export function joinProjection() {
  return { screen: 'join' };
}

// 第一環節「走進故事世界」：老師一步一步操作的猜作品活動。
// intro: { view: 'open'|'story'|'compare'|'bridge'|'crossroads'(舊), index, clues, revealed, seen: [已公布故事的 index], step }
//   open     開場：單元名稱與開場語（只有中性名稱「神祕故事一」，不含作品資訊）
//   story    神祕故事：clues＝已顯示的線索數；revealed＝已公布作品（作品名稱、名字變化、揭曉圖與說明只在這之後放進投影）
//   compare  兩個故事放在一起：step 0＝名字變化＋比較提問；step 1＝再加上命名提問
//   bridge   轉場：接到第 02、03 環節的故事卡分類
// 文案（text）來自 content_sets.intro_text（教師可讀，由教師端放進投影）；舊資料沒有時使用 INTRO_DEFAULT。
const NUMS = '一二三四五六七八九十';
export const introNo = (i) => NUMS[i] || String(i + 1);
export const introNeutral = (i) => `神祕故事${introNo(i)}`;
export const INTRO_DEFAULT = {
  opening: null,   // null：顯示「有 N 個神祕的故事正在等待我們探索」
  compare_title: '兩個故事放在一起',
  compare_prompts: ['這些故事有什麼共同的特色？'],
  naming_prompt: null,
  bridge_title: null,
  bridge_text: null,
};
export function introText(t) {
  const x = t && typeof t === 'object' ? t : {};
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v : d);
  return {
    opening: str(x.opening, INTRO_DEFAULT.opening),
    compare_title: str(x.compare_title, INTRO_DEFAULT.compare_title),
    compare_prompts: Array.isArray(x.compare_prompts) && x.compare_prompts.some((v) => typeof v === 'string' && v.trim())
      ? x.compare_prompts.filter((v) => typeof v === 'string' && v.trim()) : INTRO_DEFAULT.compare_prompts,
    naming_prompt: str(x.naming_prompt, INTRO_DEFAULT.naming_prompt),
    bridge_title: str(x.bridge_title, INTRO_DEFAULT.bridge_title),
    bridge_text: str(x.bridge_text, INTRO_DEFAULT.bridge_text),
  };
}
export function introInitial() {
  return { view: 'open', index: 0, clues: 0, revealed: false, seen: [], step: 0 };
}

export function introSub(intro) {
  if (intro.view === 'open') return '01-01';
  if (intro.view === 'crossroads' || intro.view === 'compare') return '01-04';
  if (intro.view === 'bridge') return '01-05';
  return intro.revealed ? '01-03' : '01-02';
}

// 已公布的故事（只計算仍存在的索引）、尚未公布的第一則
const validSeen = (stories, st) => [...new Set((st.seen || []).filter((i) => Number.isInteger(i) && i >= 0 && i < stories.length))].sort((a, b) => a - b);
const firstUnrevealed = (stories, st) => { const seen = validSeen(stories, st); for (let i = 0; i < stories.length; i++) if (!seen.includes(i)) return i; return -1; };
const allRevealed = (stories, st) => stories.length > 0 && firstUnrevealed(stories, st) === -1;
const namesOf = (s) => (s.name_before && s.name_after ? { name_before: s.name_before, name_after: s.name_after } : {});
export function introProjection(stories, intro, text) {
  const T = introText(text);
  const base = { screen: 'intro', ctl: { ...intro, seen: [...(intro.seen || [])] } };
  if (intro.view === 'open') return { ...base, view: 'open', total: stories.length, title: '走進故事世界', opening: T.opening };
  if (intro.view === 'crossroads') {
    return {
      ...base,
      view: 'crossroads',
      stories: (intro.seen || [])
        .filter((i) => stories[i])
        .map((i) => ({ title: stories[i].title, image_url: stories[i].image_url || null })),
    };
  }
  if (intro.view === 'compare') {
    // 只放已公布的故事。比較提問與命名提問會提到兩部作品的主角（例如「新一」「千尋」），
    // 所以只有兩部都已公布時才放進投影（複查第二輪 P1）；舊的、不完整的 compare 狀態只顯示已公布的名字變化，不放提問。
    const shown = validSeen(stories, intro);
    const complete = allRevealed(stories, intro);
    const prompts = complete ? [...T.compare_prompts] : [];
    if (complete && (intro.step || 0) >= 1 && T.naming_prompt) prompts.push(T.naming_prompt);
    return { ...base, view: 'compare', title: T.compare_title, prompts,
      stories: shown.map((i) => ({ title: stories[i].title, image_url: stories[i].image_url || null,
        image_alt: stories[i].image_alt || `《${stories[i].title}》揭曉圖`, ...namesOf(stories[i]) })) };
  }
  if (intro.view === 'bridge') return { ...base, view: 'bridge', title: T.bridge_title || TEXT.activity, text: T.bridge_text || TEXT.task };
  const s = stories[intro.index];
  if (!s) return { ...base, view: 'open', total: stories.length, title: '走進故事世界', opening: T.opening };
  const clues = (s.clues || []).slice(0, Math.max(0, intro.clues)).map((c, k) => ({
    no: introNo(k), kind: c.kind, label: c.label, body: c.body, image_url: c.image_url || null,
  }));
  const story = {
    index: intro.index,
    total: stories.length,
    neutral: introNeutral(intro.index),
    clue_total: (s.clues || []).length,
    background_url: s.background_url || null,
    clues,
  };
  if (intro.revealed) {
    story.title = s.title;
    story.reveal_text = s.reveal_text;
    story.image_url = s.image_url || null;
    story.image_alt = s.image_alt || `《${s.title}》揭曉圖`;
    Object.assign(story, namesOf(s));
  }
  return { ...base, view: 'story', story };
}

// 教師端：一次只前進／後退一步（純函式，不修改原物件）。到了最後一步 next 回傳 null。
const lastStep = (T) => (T.naming_prompt ? 1 : 0);
const markSeen = (st, i, on) => {
  const set = new Set(st.seen || []);
  if (on) set.add(i); else set.delete(i);
  return [...set].sort((a, b) => a - b);
};
export function introNext(stories, st, text) {
  const T = introText(text);
  const n = (i) => (stories[i]?.clues || []).length;
  if (st.view === 'open') {
    return stories.length ? { ...st, view: 'story', index: 0, clues: 0, revealed: false, step: 0 } : null;
  }
  if (st.view === 'story') {
    if (st.clues < n(st.index)) return { ...st, clues: st.clues + 1 };
    if (!st.revealed) return { ...st, revealed: true, clues: n(st.index), seen: markSeen({ seen: validSeen(stories, st) }, st.index, true) };
    // 已公布：前往尚未公布的第一則（正常流程＝下一則）；全部都已公布才進入比較
    const u = firstUnrevealed(stories, st);
    if (u >= 0) return { ...st, index: u, clues: 0, revealed: false, seen: validSeen(stories, st) };
    return { ...st, view: 'compare', step: 0, seen: validSeen(stories, st) };
  }
  if (st.view === 'compare' || st.view === 'crossroads') {
    // 舊場次可能只公布了一部就進入交會畫面：先回到尚未公布的那一則的中性猜題頁（線索從零開始），保留已公布的紀錄
    const u = firstUnrevealed(stories, st);
    if (u >= 0) return { ...st, view: 'story', index: u, clues: 0, revealed: false, step: 0, seen: validSeen(stories, st) };
    const step = st.view === 'compare' ? st.step || 0 : -1;
    if (step < lastStep(T)) return { ...st, view: 'compare', step: step + 1 };
    return { ...st, view: 'bridge' };
  }
  return null;   // bridge：接下來由「進入下一環節」前往 02
}
// 返回只會「收起」，不會新增已公布的故事（複查 P1）：
//   * 比較／舊版交會畫面返回時，回到進入比較頁之前揭曉的那一則（狀態中的 index）；index 無效時才用 seen 中編號最大的一則；
//     舊場次可能只公布了第一則就進入交會畫面（seen: [0]），此時回到第一則的揭曉頁，第二則保持未公布。
//     沒有任何有效的已公布紀錄時，回到中性的開場畫面。
//   * 從某一則的開頭返回前一則時，前一則只有在 seen 中才顯示為已公布；否則停在它的三條線索（未公布）。
export function introBack(stories, st, text) {
  const T = introText(text);
  const n = (i) => (stories[i]?.clues || []).length;
  const seen = validSeen(stories, st);
  if (st.view === 'bridge') return { ...st, view: 'compare', step: lastStep(T) };
  if (st.view === 'compare' || st.view === 'crossroads') {
    if ((st.step || 0) > 0 && st.view === 'compare') return { ...st, step: st.step - 1 };
    if (!seen.length) return { ...introInitial() };
    // 回到進入比較頁之前的那一則揭曉頁（複查第三輪）：introNext 進入比較時保留 index＝剛才揭曉的故事。
    // 舊場次可能先公布第二則、再補公布第一則，所以不能用「編號最大的已公布故事」推算公布順序。
    // index 缺失、越界或指向未公布的故事時（例如舊版交會狀態），才改用 seen 中編號最大的一則（安全：一定是已公布的）。
    const from = Number.isInteger(st.index) && seen.includes(st.index) ? st.index : Math.max(...seen);
    return { ...st, view: 'story', index: from, clues: n(from), revealed: true, seen, step: 0 };
  }
  if (st.view === 'story') {
    if (st.revealed) return { ...st, revealed: false, seen: markSeen({ seen }, st.index, false) };   // 收起作品圖與答案
    if (st.clues > 0) return { ...st, clues: st.clues - 1 };
    if (st.index > 0) {
      const prev = st.index - 1;
      return { ...st, index: prev, clues: n(prev), revealed: seen.includes(prev), seen };
    }
    return { ...st, view: 'open', clues: 0, revealed: false, seen };
  }
  return null;   // open：已在第一步
}
// 主要按鈕的文字（教師端）：下一步會做什麼
export function introNextLabel(stories, st, text) {
  const n = (i) => (stories[i]?.clues || []).length;
  if (st.view === 'open') return '開始：' + introNeutral(0);
  if (st.view === 'story') {
    if (st.clues < n(st.index)) return '顯示下一條線索';
    if (!st.revealed) return '公布作品';
    const u = firstUnrevealed(stories, st);
    if (u >= 0) return '進入' + introNeutral(u);
    return introText(text).compare_title;
  }
  if (st.view === 'compare' || st.view === 'crossroads') {
    const u = firstUnrevealed(stories, st);
    if (u >= 0) return '進入' + introNeutral(u);
    const T = introText(text);
    return (st.view === 'compare' ? st.step || 0 : -1) < lastStep(T) ? '下一個提問' : (T.bridge_title || '轉場：準備分類');
  }
  return null;
}

// 舊版教師端操作（保留給舊的投影狀態與既有測試；新的教師端只使用 introNext／introBack）
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

// 類型圖片的來源選擇：與伺服器 app.genre_visual 完全相同（06＝直式優先、07＝橫式優先；缺圖時互相回退）
export function genreVisual(x, prefer) {
  const p = (x?.visual_url || '').trim(); const l = (x?.visual_landscape_url || '').trim();
  if (prefer === 'landscape' && l) return { visual_url: l, visual_source: 'landscape' };
  if (p) return { visual_url: p, visual_source: 'portrait' };
  if (l) return { visual_url: l, visual_source: 'landscape' };
  return { visual_url: null, visual_source: null };
}

// 06 公開資料（教師端私下預覽用；公開時由伺服器 app.genre_build 產生同樣的內容）
function genrePublic(x) {
  return { name: x.name, elements: (x.elements || []).slice(0, 3).map((e) => ({ label: e.label, icon: e.icon || '' })),
           ...genreVisual(x, 'portrait') };
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

// 明確的「揭開小說世界」：伺服器只在 ctl.reveal 為 true 時才把該類型（名稱＋全部要素）加入揭露紀錄
export function genreRevealProjection(genres, g) {
  const p = genreProjection(genres, g);
  return { ...p, ctl: { ...p.ctl, reveal: true } };
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
      return { sub: introSub(st), projection: introProjection(content.intro || [], st, content.introText) };
    }
    case '02': return { sub: '02', projection: taskProjection() };
    case '03':
    case '04': return { sub: phaseId, projection: instructionProjection(phaseId) };
    case '05': return { sub: '05', projection: placeholderProjection('分類成果大公開', '比一比：兩組的分類有什麼不同？') };
    case '06': {
      const g = genreInitial();
      return { sub: genreSub(g), projection: genreProjection(content.genres || [], g) };
    }
    case '07': return { sub: '07', projection: placeholderProjection('小小故事分類師', TEXT.matchQuestion) };
    case '99': return { sub: '99', projection: endProjection() };
    default: return { sub: '', projection: {} };
  }
}
