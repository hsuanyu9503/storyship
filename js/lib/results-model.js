// Phase 4：05／07 教師端的純函式（不碰 DOM，可在 Node 測試）。
// 注意：投影資料一律由伺服器產生（app.compare_build／app.match_build）；這裡只處理教師端的選擇（ctl）與清單。

// 快照排序：最新在前；時間相同時以 id 排序（穩定）
export function sortSnapshots(list) {
  return [...(list || [])].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : (a.created_at < b.created_at ? 1 : -1)));
}

export function snapshotsOf(list, groupId) {
  return sortSnapshots((list || []).filter((s) => s.group_id === groupId));
}

export function latestSnapshot(list, groupId) {
  return snapshotsOf(list, groupId)[0] || null;
}

// 已綁定的快照之後是否出現了較新的快照（提示教師可更新；不自動更換）
export function newerSnapshot(list, snapshotId) {
  const cur = (list || []).find((s) => s.id === snapshotId);
  if (!cur) return null;
  const latest = latestSnapshot(list, cur.group_id);
  return latest && latest.id !== cur.id ? latest : null;
}

export function kindLabel(kind) {
  return kind === 'submitted' ? '小組正式提交' : kind === 'locked' ? '教師結束時保存（未正式提交）' : '—';
}

// 快照內容正規化（與 SQL app.snapshot_norm 相同規則；相容 Phase 1／2 與 Phase 3 格式）：
// 以 placements 決定歸屬、只留有故事的分類、依 order → label_no → id 排序
export function normalizeSnapshot(data, cards) {
  const cardIds = new Set((cards || []).map((c) => c.id));
  const pl = Array.isArray(data?.placements) ? data.placements : [];
  const cats = Array.isArray(data?.categories) ? data.categories : [];
  const used = cats.filter((c) => pl.some((p) => p.category_id === c.id && cardIds.has(p.card_id)));
  used.sort((a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) || ((a.label_no ?? 0) - (b.label_no ?? 0)) || (a.id < b.id ? -1 : 1));
  const order = new Map((cards || []).map((c, i) => [c.id, i]));
  return used.map((c, i) => ({
    id: c.id, n: i + 1, label_no: c.label_no ?? 0, name: String(c.name ?? '').trim(), reason: String(c.reason ?? '').trim(),
    cards: pl.filter((p) => p.category_id === c.id && cardIds.has(p.card_id)).map((p) => p.card_id)
      .sort((x, y) => order.get(x) - order.get(y)),
  }));
}

// 給教師端閱讀用的 board 格式（board-view）
export function snapshotToBoard(data, cards) {
  const cats = normalizeSnapshot(data, cards);
  const placements = {};
  for (const c of cats) for (const id of c.cards) placements[id] = c.id;
  return { categories: cats.map((c) => ({ id: c.id, no: c.label_no || c.n, name: c.name, reason: c.reason })), placements };
}

// ---------- 05 的選擇 ----------
export function emptyCompare() {
  return { left: null, right: null, story: null, reasons: { left: [], right: [] }, page: { left: 0, right: 0 }, focus: { left: null, right: null },
           per: { left: 4, right: 4 }, zoom: null };
}

// 與伺服器回傳的 ctl 相同形狀，方便比較「是否有尚未公開的變更」
export function canonCompare(ctl) {
  const c = { ...emptyCompare(), ...(ctl || {}) };
  return {
    left: c.left || null, right: c.right || null, story: c.story || null,
    reasons: { left: [...(c.reasons?.left || [])].sort(), right: [...(c.reasons?.right || [])].sort() },
    page: { left: Number(c.page?.left) || 0, right: Number(c.page?.right) || 0 },
    focus: { left: c.focus?.left || null, right: c.focus?.right || null },
    per: { left: PER.includes(Number(c.per?.left)) ? Number(c.per.left) : 4, right: PER.includes(Number(c.per?.right)) ? Number(c.per.right) : 4 },
    zoom: (c.zoom === 'left' && c.left) || (c.zoom === 'right' && c.right) ? c.zoom : null,
  };
}

export function sameCompare(a, b) {
  return JSON.stringify(canonCompare(a)) === JSON.stringify(canonCompare(b));
}

// 某一側換成另一份快照時：該側的理由揭露、頁數、聚焦都重設（避免沿用另一組的分類 id）
export function setSide(ctl, side, snapshotId) {
  const c = canonCompare(ctl);
  c[side] = snapshotId;
  c.reasons[side] = []; c.page[side] = 0; c.focus[side] = null;
  return c;
}

// 每頁分類數（4／2／1）：內容較長時由教師改成較少，投影字級不變；改變時回到第一頁
export const PER = [4, 2, 1];
export function setPer(ctl, side, per) {
  const c = canonCompare(ctl);
  c.per[side] = PER.includes(per) ? per : 4;
  c.page[side] = 0;
  return c;
}

export function toggleReason(ctl, side, catId) {
  const c = canonCompare(ctl);
  const set = new Set(c.reasons[side]);
  if (set.has(catId)) set.delete(catId); else set.add(catId);
  c.reasons[side] = [...set].sort();
  return c;
}

// ---------- 07 的選擇 ----------
export function emptyMatch() {
  return { snapshot: null, category: null, show_reason: false, genre: null, elements: [], highlights: [], scaffold: false };
}

export function canonMatch(ctl) {
  const c = { ...emptyMatch(), ...(ctl || {}) };
  return {
    snapshot: c.snapshot || null, category: c.category || null, show_reason: Boolean(c.show_reason),
    genre: Number.isInteger(c.genre) ? c.genre : null,
    elements: [...new Set(c.elements || [])].sort((a, b) => a - b),
    highlights: [...new Set(c.highlights || [])].sort((a, b) => a - b),
    scaffold: Boolean(c.scaffold),
  };
}

export function sameMatch(a, b) {
  return JSON.stringify(canonMatch(a)) === JSON.stringify(canonMatch(b));
}

// 更換類型：清除上一種類型的要素揭露與相似標示（不錯套到下一種）
export function setGenre(ctl, genre) {
  const c = canonMatch(ctl);
  if (c.genre === genre) return c;
  return { ...c, genre, elements: [], highlights: [] };
}

// 更換快照或分類：分類必須屬於新的快照
export function setSnapshot(ctl, snapshotId) {
  const c = canonMatch(ctl);
  if (c.snapshot === snapshotId) return c;
  return { ...c, snapshot: snapshotId, category: null, show_reason: false };
}

export function toggleElement(ctl, i) {
  const c = canonMatch(ctl);
  if (c.elements.includes(i)) {
    // 收回要素時，一併取消它的相似標示（不能標示未揭露的要素）
    return { ...c, elements: c.elements.filter((x) => x !== i), highlights: c.highlights.filter((x) => x !== i) };
  }
  return { ...c, elements: [...c.elements, i].sort((a, b) => a - b) };
}

export function toggleHighlight(ctl, i) {
  const c = canonMatch(ctl);
  if (!c.elements.includes(i)) return c;
  const hl = c.highlights.includes(i) ? c.highlights.filter((x) => x !== i) : [...c.highlights, i].sort((a, b) => a - b);
  return { ...c, highlights: hl };
}

// 揭露紀錄 {"revealed":{"<類型索引>":[要素索引]}}：回傳「名稱已公開」的類型索引。
// 舊格式 {"genres":[…]} 只視為名稱已公開（與伺服器 app.disc_map 相同）。
export function disclosureMap(disc) {
  const m = {};
  for (const x of Array.isArray(disc?.genres) ? disc.genres : []) if (Number.isInteger(x)) m[x] = [];
  const r = disc?.revealed && typeof disc.revealed === 'object' && !Array.isArray(disc.revealed) ? disc.revealed : {};
  for (const [k, v] of Object.entries(r)) if (/^\d+$/.test(k)) m[Number(k)] = Array.isArray(v) ? v.filter(Number.isInteger) : [];
  return m;
}
export function disclosedGenres(disc) {
  return new Set(Object.keys(disclosureMap(disc)).map(Number));
}

// 鍵排序後的 JSON（比較預覽與投影內容是否相同，不受鍵順序影響）
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
