// 分類工作區的資料模型（純函式、不碰 DOM，可在 Node 測試）。
// 個人分類與 Phase 3 小組分類共用同一套格式：
//   data = { categories: [{ id, no, name, reason? }], placements: { <cardId>: <categoryId> } }
//   * reason：小組分類的「共同特色／理由」（個人分類不使用）
//   * no：暫時名稱「分類 N」的編號（只供顯示，名稱欄位仍是空字串）
//   * placements 是物件，一張卡只會有一個歸屬；沒有出現＝尚未分類
// 所有函式都回傳新物件，不修改傳入的資料。

export const MAX_CATEGORIES = 30;
export const MAX_NAME = 30;
export const MAX_REASON = 120;   // 一至兩句（伺服器上限 300 字）

export function emptyBoard() {
  return { categories: [], placements: {} };
}

// 整理來源資料：去除不存在的故事或分類的歸屬（例如素材被調整後）
export function normalize(data, cards) {
  const cats = Array.isArray(data?.categories) ? data.categories : [];
  const ids = new Set();
  const categories = [];
  for (const c of cats) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id)) continue;
    ids.add(c.id);
    const cat = { id: c.id, no: Number(c.no) || categories.length + 1, name: String(c.name ?? '') };
    if (c.reason != null) cat.reason = String(c.reason);
    if (c.nameRev != null) cat.nameRev = c.nameRev;        // 小組：名稱、理由的伺服器版本（畫面用來記住基準）
    if (c.reasonRev != null) cat.reasonRev = c.reasonRev;
    categories.push(cat);
  }
  const cardIds = new Set((cards || []).map((c) => c.id));
  const placements = {};
  for (const [card, cat] of Object.entries(data?.placements || {})) {
    if (cardIds.has(card) && ids.has(cat)) placements[card] = cat;
  }
  return { categories, placements };
}

export function tempName(cat) {
  return `分類 ${cat.no}`;
}

// 空白或未修改的「分類 N」都不算正式命名（與伺服器 app.is_temp_name 一致）
export function isTempName(name) {
  const s = String(name ?? '').trim();
  return s === '' || /^分類\s*[0-9０-９]+$/.test(s);
}

export function displayName(cat) {
  return isTempName(cat.name) ? tempName(cat) : cat.name.trim();
}

function newId(existing) {
  for (;;) {
    const id = 'c' + Math.random().toString(36).slice(2, 9);
    if (!existing.has(id)) return id;
  }
}

// makeId：小組分類傳入 UUID 產生器（伺服器以此作為分類 id 與操作識別碼）；個人分類使用短 id
export function addCategory(data, makeId = null, max = MAX_CATEGORIES) {
  if (data.categories.length >= max) return { data, id: null };
  const id = makeId ? makeId() : newId(new Set(data.categories.map((c) => c.id)));
  const no = data.categories.reduce((m, c) => Math.max(m, c.no), 0) + 1;
  return { data: { ...data, categories: [...data.categories, { id, no, name: '' }] }, id };
}

// categoryId 為 null＝移回尚未分類
export function moveCard(data, cardId, categoryId) {
  const placements = { ...data.placements };
  if (categoryId == null) delete placements[cardId];
  else {
    if (!data.categories.some((c) => c.id === categoryId)) return data;
    placements[cardId] = categoryId;
  }
  return { ...data, placements };
}

export function renameCategory(data, categoryId, name) {
  const v = String(name ?? '').slice(0, MAX_NAME);
  return { ...data, categories: data.categories.map((c) => (c.id === categoryId ? { ...c, name: v } : c)) };
}

export function setReason(data, categoryId, text) {
  const v = String(text ?? '').slice(0, MAX_REASON);
  return { ...data, categories: data.categories.map((c) => (c.id === categoryId ? { ...c, reason: v } : c)) };
}

// 刪除分類：其中的故事回到尚未分類，不影響其他分類
export function deleteCategory(data, categoryId) {
  const placements = {};
  for (const [card, cat] of Object.entries(data.placements)) if (cat !== categoryId) placements[card] = cat;
  return { categories: data.categories.filter((c) => c.id !== categoryId), placements };
}

export function cardsIn(data, cards, categoryId) {
  return cards.filter((c) => data.placements[c.id] === categoryId);
}

export function unplacedCards(data, cards) {
  const ids = new Set(data.categories.map((c) => c.id));
  return cards.filter((c) => !ids.has(data.placements[c.id]));
}

export function placedCount(data, cards) {
  return cards.length - unplacedCards(data, cards).length;
}

// 提交時排除沒有故事的分類（空分類不影響完成，也不需要學生理解）
export function stripEmpty(data, cards) {
  const used = new Set(cards.map((c) => data.placements[c.id]).filter(Boolean));
  return { ...data, categories: data.categories.filter((c) => used.has(c.id)) };
}

// 完整性檢查：只檢查是否完成，不判斷分類內容對錯
//   requireReason：小組分類另需每個有效分類都寫了共同特色
export function problems(data, cards, { requireReason = false } = {}) {
  const unplaced = unplacedCards(data, cards).length;
  const used = data.categories.filter((c) => cardsIn(data, cards, c.id).length > 0);
  const unnamed = used.filter((c) => isTempName(c.name));
  const noReason = requireReason ? used.filter((c) => String(c.reason ?? '').trim() === '') : [];
  return { total: cards.length, unplaced, unnamed, noReason,
           complete: unplaced === 0 && unnamed.length === 0 && noReason.length === 0 };
}

export function problemMessages(p) {
  const out = [];
  if (p.unplaced > 0) out.push(`還有 ${p.unplaced} 張故事尚未分類。`);
  for (const c of p.unnamed) out.push(`請為${tempName(c)} 取一個名稱。`);
  for (const c of p.noReason || []) out.push(`請寫下「${displayName(c)}」的共同特色。`);
  return out;
}

// 兩份資料是否相同（用於判斷是否還有未儲存的變更）
export function sameBoard(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(d) {
  return { c: (d?.categories || []).map((c) => [c.id, c.no, String(c.name ?? '').trim(), String(c.reason ?? '').trim()]),
           p: Object.entries(d?.placements || {}).sort(([x], [y]) => (x < y ? -1 : 1)) };
}
