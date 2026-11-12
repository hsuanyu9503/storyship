// 04｜故事找朋友：小組共作（學生端控制器）
//
// 同步架構
//   * 伺服器是唯一的真實來源：畫面＝「伺服器最後確認的小組資料」＋「本機尚未確認的操作」（樂觀顯示）。
//   * 每個操作都是針對單一目標的 RPC（新增分類／移動故事／改名稱／改共同特色／刪除分類），
//     從不把整份本機資料覆蓋到伺服器；伺服器以各項目的版本號判斷是否過期。
//   * 本機操作依序送出（一次一個），操作失敗時直接丟棄該操作、重新讀取伺服器資料，畫面自動回到正確狀態。
//   * 讀取到的小組資料若版本（board_rev）比目前已知的舊，一律忽略：較晚到的舊回應不會讓畫面回溯。
//   * 重送安全：新增分類帶前端產生的 id（重送不會產生第二個、也不會重建已刪除的分類）；
//     移動／改字若伺服器已是相同結果，回傳成功但不重複寫入；刪除已不存在的分類視為完成。
//   * 即時通知（Realtime）只用來加速；收不到時每 2 秒輪詢一次。
//
// 操作保護
//   * 選取或拖曳故事卡時取得該卡的操作鎖；輸入名稱或共同特色時取得該欄位的操作鎖。
//     鎖由伺服器發給、15 秒逾時，持有期間每 5 秒續約；離線裝置的鎖會自動失效。
//   * 其他組員持有的鎖只會讓「那張卡／那個欄位」暫時不能操作，其餘照常。
//   * 離線時整個工作區暫停修改（仍可閱讀），重新連線後先讀取最新資料再繼續。
import { rpc, errorText } from '../lib/api.js';
import { createSync } from '../lib/sync.js';
import { h, confirmDialog } from '../lib/dom.js';
import * as M from '../lib/board-model.js';
import { createBoardView } from '../lib/board-view.js';

const TEXT_DEBOUNCE = 800;
const LOCK_RENEW_MS = 5000;
const SLOW_MS = 1500;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function createGroup({ client, sessionId, token, groupNumber, onPing }) {
  const el = h('div.gw-loading', h('div.s-center', h('p.s-lead', '載入小組工作區…')));
  let destroyed = false;
  let cards = null;
  let view = null;          // 右側：小組共同工作區
  let gsync = null;
  let lastSt = null;

  // 伺服器確認的資料
  let server = null;        // { board_rev, status, can_edit, paused, cats: Map, place: Map(cardId → {cat, rev}), locks }
  // 本機尚未確認的操作
  const queue = [];         // { type: add|move|delete|text|release, ... }
  const texts = new Map();  // 'name:<id>' / 'reason:<id>' → 本機目前輸入的內容（伺服器確認前）
  let sending = false;
  let offline = false;
  let retryTimer = null;
  let slowTimer = null;
  let slow = false;
  const textTimers = new Map();
  let held = null;          // 目前持有的操作鎖 target
  let renewTimer = null;
  let notice = null;        // 一次性提示
  let noticeTimer = null;
  let messages = [];        // 提交檢查訊息
  let submitting = false;
  let paintKey = '';

  // ---------- 左側：我的分類（唯讀） ----------
  const panel = h('aside.gw-panel');
  const panelBody = h('div.gw-panel-body', { hidden: true });
  const toggleBtn = h('button.gw-toggle', { type: 'button', 'aria-expanded': 'false', onclick: togglePanel }, '我的分類');
  const backdrop = h('div.gw-backdrop', { onclick: togglePanel });
  panel.append(toggleBtn, panelBody);
  const main = h('main.gw-main');
  function togglePanel() {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    panelBody.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.textContent = open ? '◀ 收合我的分類' : '我的分類';
  }

  async function init() {
    try {
      const [c, personal, board] = await Promise.all([
        rpc(client, 'student_cards', { p_session: sessionId, p_token: token }),
        rpc(client, 'student_personal', { p_session: sessionId, p_token: token }),
        rpc(client, 'student_group_board', { p_session: sessionId, p_token: token }),
      ]);
      if (destroyed) return;
      cards = c;
      // 個人參考面板：只讀本人的個人快照（沒有快照的補加入學生顯示「尚無個人分類紀錄」，不偽造）
      const snap = personal.snapshot;
      if (snap) {
        const pv = createBoardView({ cards, title: '我的分類（唯讀）', categoriesTitle: '我的分類', readOnly: true, variant: 'panel' });
        pv.setData(snap.data);
        if (!snap.is_complete) pv.setNotice(h('div.bd-notice', '個人分類尚未完成'));
        panelBody.append(pv.el);
      } else {
        panelBody.append(h('p.gw-empty', '尚無個人分類紀錄。'));
      }
      view = createBoardView({ cards, title: `${board.group_name}｜共同分類`, categoriesTitle: '小組分類',
        reasons: true, confirmEveryDelete: true, makeId: uuid, onChange, onGrab, onRelease, onFieldFocus, onFieldBlur });
      main.append(view.el);
      el.className = 'gw';
      el.replaceChildren(panel, backdrop, main);
      adopt(board, true);
      gsync = createSync({
        client, topic: 'group:' + board.group_id, fastMs: 2000, slowMs: 8000,
        load: () => rpc(client, 'student_group_board', { p_session: sessionId, p_token: token }),
        onStatus: ({ online }) => {
          const was = offline;
          offline = !online;
          if (was && !offline) { retryNow(); }
          paint(true);
        },
        onData: (b, err) => {
          if (err) { if (['NOT_AVAILABLE', 'REMOVED', 'NOT_JOINED'].includes(err.code)) onPing?.(); return; }
          if (offline) { offline = false; retryNow(); }
          adopt(b);
        },
      });
    } catch (e) {
      if (destroyed) return;
      el.replaceChildren(h('div.s-center', h('p.s-error', errorText(e)),
        h('button.s-big', { type: 'button', onclick: () => { el.replaceChildren(h('div.s-center', h('p.s-lead', '載入中…'))); init(); } }, '重試')));
    }
  }

  // ---------- 伺服器資料 ----------
  function adopt(b, first = false) {
    if (!first && server && b.board_rev < server.board_rev) return;   // 較舊的回應：忽略（畫面不回溯）
    const cats = new Map(b.categories.map((c) => [c.id, c]));
    const place = new Map(b.placements.map((p) => [p.card_id, { cat: p.category_id, rev: p.rev }]));
    server = { board_rev: b.board_rev, status: b.status, can_edit: b.can_edit, paused: b.paused, phase: b.phase,
               cats, place, locks: b.locks || [], problems: b.problems };
    // 伺服器已確認的文字：清除對應的本機暫存（欄位仍在輸入中的除外）
    for (const [key, v] of texts) {
      const [field, id] = key.split(':');
      const c = cats.get(id);
      const editing = view?.editingField();
      const active = editing && editing.categoryId === id && editing.field === field;
      if (!c) { texts.delete(key); continue; }
      if (!active && !queue.some((q) => q.type === 'text' && q.key === key) && !textTimers.has(key)
          && (c[field] ?? '') === v) texts.delete(key);
    }
    if (lastSt && !serverEditable()) dropPendingEdits();
    render();
  }

  // 伺服器允許編輯（04、未暫停、小組未提交／鎖定）
  function serverEditable() {
    return Boolean(server?.can_edit) && lastSt?.state?.phase === '04' && !lastSt?.state?.editing_paused;
  }
  // 目前可以操作＝伺服器允許＋連線中（離線時暫停修改，但保留尚未送出的操作）
  function canEdit() { return serverEditable() && !offline; }

  // 畫面資料＝伺服器資料＋尚未確認的操作
  function display() {
    const cats = [];
    for (const c of server.cats.values()) cats.push({ id: c.id, no: c.label_no, name: c.name, reason: c.reason });
    const placements = {};
    for (const [card, p] of server.place) if (p.cat) placements[card] = p.cat;
    let d = { categories: cats, placements };
    for (const op of queue) {
      if (op.type === 'add' && !d.categories.some((c) => c.id === op.id)) {
        const no = d.categories.reduce((m, c) => Math.max(m, c.no), 0) + 1;
        d = { ...d, categories: [...d.categories, { id: op.id, no, name: '', reason: '' }] };
      } else if (op.type === 'move') {
        d = M.moveCard(d, op.cardId, op.to);
      } else if (op.type === 'delete') {
        d = M.deleteCategory(d, op.id);
      }
    }
    for (const [key, v] of texts) {
      const [field, id] = key.split(':');
      d = field === 'name' ? M.renameCategory(d, id, v) : M.setReason(d, id, v);
    }
    return d;
  }

  function othersLocks() {
    return new Set((server?.locks || []).filter((l) => !l.mine).map((l) => l.target));
  }

  function render() {
    if (!view || !server) return;
    view.setLocks(othersLocks());
    view.setData(display());
    paint();
  }

  // ---------- 使用者操作 → 佇列 ----------
  function onChange(d, kind, info = {}) {
    if (!canEdit()) { render(); return; }
    messages = [];
    if (kind === 'add') {
      queue.push({ type: 'add', id: info.categoryId });
      if (info.cardId) {
        if (held === 'card:' + info.cardId) clearInterval(renewTimer);
        queue.push({ type: 'move', cardId: info.cardId, to: info.categoryId });
      }
    } else if (kind === 'move') {
      if (held === 'card:' + info.cardId) clearInterval(renewTimer);   // 移動送出後不再續約
      queue.push({ type: 'move', cardId: info.cardId, to: info.categoryId });
    } else if (kind === 'delete') {
      queue.push({ type: 'delete', id: info.categoryId });
    } else if (kind === 'rename' || kind === 'reason' || kind === 'rename-commit' || kind === 'reason-commit') {
      const field = kind.startsWith('rename') ? 'name' : 'reason';
      const id = info.categoryId;
      const cat = d.categories.find((c) => c.id === id);
      if (!cat) return;
      const key = field + ':' + id;
      texts.set(key, field === 'name' ? cat.name : (cat.reason || ''));
      clearTimeout(textTimers.get(key));
      if (kind.endsWith('-commit')) { textTimers.delete(key); queueText(key); }
      else textTimers.set(key, setTimeout(() => { textTimers.delete(key); queueText(key); }, TEXT_DEBOUNCE));
      paint();
      return;
    }
    render();
    pump();
  }

  function queueText(key) {
    if (!texts.has(key)) return;
    const [field, id] = key.split(':');
    const cur = server?.cats.get(id);
    // 與伺服器相同就不送
    if (cur && (cur[field] ?? '') === texts.get(key) && !queue.some((q) => q.key === key)) return;
    if (!queue.some((q) => q.type === 'text' && q.key === key && !q.sent)) queue.push({ type: 'text', key, field, id });
    pump();
  }

  function flushTexts() {
    for (const [key, t] of textTimers) { clearTimeout(t); textTimers.delete(key); queueText(key); }
  }

  function dropPendingEdits() {
    // 不能編輯（暫停、提交、鎖定）時，尚未送出的操作一律丟棄；畫面回到伺服器資料
    if (queue.length && !sending) queue.length = 0;
    for (const t of textTimers.values()) clearTimeout(t);
    textTimers.clear();
    if (!view?.editingField()) texts.clear();
  }

  // ---------- 依序送出 ----------
  async function pump() {
    if (sending || destroyed || !queue.length) return;
    if (!canEdit()) return;
    sending = true;
    const op = queue[0];
    op.sent = true;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { slow = true; paint(); }, SLOW_MS);
    let r = null;
    try {
      r = await send(op);
      queue.shift();
      settle(op, r);
    } catch (e) {
      if (e.code === 'NETWORK') {
        // 留在佇列前端，恢復連線後重送（重送是安全的，見檔案開頭說明）
        offline = true;
        op.sent = false;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(retryNow, 3000);
        sending = false;
        clearTimeout(slowTimer); slow = false;
        paint(true);
        return;
      }
      queue.shift();
      if (['PAUSED', 'SUBMITTED', 'NOT_AVAILABLE', 'SESSION_ENDED', 'REMOVED'].includes(e.code)) {
        queue.length = 0;
        onPing?.();
      } else {
        flash(errorText(e));
      }
    } finally {
      clearTimeout(slowTimer); slow = false;
    }
    sending = false;
    if (r?.board_rev && server) server.board_rev = Math.max(server.board_rev, r.board_rev);
    render();
    gsync?.refresh();
    if (queue.length) pump();
  }

  function retryNow() {
    clearTimeout(retryTimer); retryTimer = null;
    gsync?.refresh();
    pump();
  }

  function cardTitle(id) { return cards.find((c) => c.id === id)?.title || '這張故事'; }
  function catName(id) {
    const c = server.cats.get(id);
    return c ? M.displayName({ no: c.label_no, name: c.name }) : '這個分類';
  }

  async function send(op) {
    const base = { p_session: sessionId, p_token: token };
    if (op.type === 'add') return rpc(client, 'group_add_category', { ...base, p_category: op.id });
    if (op.type === 'move') {
      return rpc(client, 'group_move_card', { ...base, p_card: op.cardId, p_category: op.to,
        p_expected_rev: server.place.get(op.cardId)?.rev ?? 0 });
    }
    if (op.type === 'delete') return rpc(client, 'group_delete_category', { ...base, p_category: op.id });
    if (op.type === 'text') {
      const cur = server.cats.get(op.id);
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      op.value = texts.get(op.key) ?? (cur[op.field] ?? '');
      return rpc(client, 'group_update_category', { ...base, p_category: op.id, p_field: op.field, p_value: op.value,
        p_expected_rev: op.field === 'name' ? cur.name_rev : cur.reason_rev });
    }
    if (op.type === 'release') {
      return rpc(client, 'group_lock', { ...base, p_target: op.target, p_release: true }).catch((e) => {
        if (e.code === 'NETWORK') throw e; return { ok: true };
      });
    }
    return { ok: true };
  }

  // 依伺服器回應更新已確認資料；失敗的操作直接放棄（畫面會回到伺服器資料）
  function settle(op, r) {
    if (op.type === 'add') {
      if (r.ok) {
        if (!server.cats.has(op.id)) server.cats.set(op.id, { id: op.id, label_no: r.label_no, name: '', reason: '', name_rev: 1, reason_rev: 1 });
      } else if (r.code === 'DELETED') {
        dropFor(op.id);
      }
    } else if (op.type === 'move') {
      // 移動完成（無論成功與否）就不再持有這張卡的操作權：
      // 成功時伺服器已釋放；失敗時主動釋放。不可繼續續約，否則會一直鎖住這張卡。
      if (held === 'card:' + op.cardId) {
        holdRelease();
        if (!r.ok || r.unchanged) queue.push({ type: 'release', target: 'card:' + op.cardId });
      }
      if (r.ok) server.place.set(op.cardId, { cat: op.to, rev: r.rev });
      else if (r.code === 'STALE') {
        server.place.set(op.cardId, { cat: r.category_id, rev: r.rev });
        flash(`組員剛剛移動了「${cardTitle(op.cardId)}」，已更新為最新位置。`);
      } else if (r.code === 'LOCKED') flash(`組員正在移動「${cardTitle(op.cardId)}」，請稍後再試。`);
      else if (r.code === 'NOT_FOUND') flash('這個分類已被組員刪除，故事沒有移動。');
    } else if (op.type === 'delete') {
      if (r.ok || r.code === 'NOT_FOUND') {
        server.cats.delete(op.id);
        for (const [card, p] of server.place) if (p.cat === op.id) server.place.set(card, { cat: null, rev: p.rev + 1 });
        dropFor(op.id);
      } else if (r.code === 'LOCKED') flash(`組員正在編輯「${catName(op.id)}」，暫時不能刪除。`);
    } else if (op.type === 'text') {
      const cur = server.cats.get(op.id);
      if (r.ok) {
        if (cur) { cur[op.field] = op.value; cur[op.field + '_rev'] = r.rev; }
        if (texts.get(op.key) === op.value && !textTimers.has(op.key) && !isFocused(op.key)) texts.delete(op.key);
      } else {
        const mine = texts.get(op.key);
        texts.delete(op.key);
        if (r.code === 'STALE' && cur) { cur[op.field] = r.value; cur[op.field + '_rev'] = r.rev; }
        if (r.code === 'NOT_FOUND') flash('這個分類已被組員刪除。');
        else if (r.code === 'LOCKED') flash('組員正在輸入這個欄位，你的文字沒有送出：「' + mine + '」');
        else if (r.code === 'STALE') flash('組員已修改這個欄位，已顯示最新內容。你剛才的文字：「' + mine + '」');
        if (isFocused(op.key)) document.activeElement.blur();
      }
    }
  }

  function dropFor(catId) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if ((q.type === 'move' && q.to === catId) || (q.type === 'text' && q.id === catId) || (q.type === 'add' && q.id === catId)) queue.splice(i, 1);
    }
    for (const key of [...texts.keys()]) if (key.endsWith(':' + catId)) texts.delete(key);
  }

  function isFocused(key) {
    const f = view?.editingField();
    return Boolean(f) && key === f.field + ':' + f.categoryId;
  }

  // ---------- 操作鎖 ----------
  async function lock(target) {
    holdRelease();
    held = target;
    try {
      const r = await rpc(client, 'group_lock', { p_session: sessionId, p_token: token, p_target: target });
      if (held !== target) return r.ok;   // 期間已改持有其他目標
      if (!r.ok) { held = null; return false; }
      clearInterval(renewTimer);
      renewTimer = setInterval(async () => {
        if (held !== target) return;
        try {
          const rr = await rpc(client, 'group_lock', { p_session: sessionId, p_token: token, p_target: target });
          if (!rr.ok) lostLock(target);
        } catch (e) { if (e.code !== 'NETWORK') lostLock(target); }
      }, LOCK_RENEW_MS);
      return true;
    } catch (e) {
      if (held === target) held = null;
      return e.code === 'NETWORK' ? false : false;
    }
  }
  function holdRelease() { clearInterval(renewTimer); renewTimer = null; held = null; }
  function lostLock(target) {
    if (held !== target) return;
    holdRelease();
    if (target.startsWith('card:')) view.cancelGrab(target.slice(5));
  }
  function release(target) {
    if (held === target) holdRelease();
    queue.push({ type: 'release', target });
    pump();
  }

  async function onGrab(cardId) {
    if (!canEdit()) { view.cancelGrab(cardId); return; }
    const ok = await lock('card:' + cardId);
    if (!ok && held !== 'card:' + cardId) {
      view.cancelGrab(cardId);
      flash(`組員正在移動「${cardTitle(cardId)}」。`);
      gsync?.refresh();
    }
  }
  function onRelease(cardId) {
    // 放回原處或取消選取：釋放卡片鎖（移動成功時伺服器會自動釋放）
    if (held === 'card:' + cardId) release('card:' + cardId);
  }
  async function onFieldFocus(catId, field) {
    if (!canEdit()) return;
    const target = field + ':' + catId;
    const ok = await lock(target);
    if (!ok && held !== target && isFocused(target)) {
      document.activeElement.blur();
      flash('組員正在輸入這個欄位，請稍後再試。');
      gsync?.refresh();
    }
  }
  function onFieldBlur(catId, field) {
    const target = field + ':' + catId;
    flushTexts();
    if (held === target) release(target);   // 排在文字之後送出：先存文字再釋放
  }

  // ---------- 提示與畫面狀態 ----------
  function flash(msg) {
    notice = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; paint(true); }, 6000);
    paint(true);
  }

  function mode() {
    if (!server) return 'loading';
    if (server.status === 'submitted') return 'submitted';
    if (server.status === 'locked' || lastSt?.session?.status === 'ended') return 'locked';
    if (lastSt?.state?.editing_paused) return 'paused';
    if (offline) return 'offline';
    if (!canEdit()) return 'readonly';
    return 'edit';
  }

  function paint(force = false) {
    if (!view || !server) return;
    const m = mode();
    const key = JSON.stringify([m, slow, submitting, messages, notice, queue.length > 0]);
    if (!force && key === paintKey) return;
    paintKey = key;
    view.setReadOnly(m !== 'edit');
    view.setStatus(slow ? h('span.save-mid', '儲存中…') : null);
    let n = null;
    if (m === 'offline') n = h('div.bd-notice', '連線中斷，重新連線後即可繼續共作。');
    else if (m === 'paused') n = h('div.bd-notice', '老師暫停了編輯，請先看前方。（可以繼續閱讀故事）');
    else if (m === 'locked') n = h('div.bd-notice', '老師已結束共同分類，小組成果已保存。');
    else if (notice) n = h('div.bd-notice.info', notice);
    view.setNotice(n);
    if (m === 'edit') {
      view.setFooter(h('div.pb-foot',
        messages.length ? h('ul.pb-msgs', { role: 'alert' }, messages.map((x) => h('li', x))) : null,
        h('button.primary.s-big.pb-done', { type: 'button', disabled: submitting, onclick: submit },
          submitting ? '確認中…' : '完成小組分類')));
    } else if (m === 'submitted') {
      view.setFooter(h('div.pb-foot.done', h('p.pb-done-msg', '✓ 小組分類已完成。')));
    } else {
      view.setFooter(null);
    }
  }

  // ---------- 提交 ----------
  async function waitSaved(ms = 8000) {
    const until = Date.now() + ms;
    flushTexts();
    while ((queue.length || sending) && Date.now() < until && !offline) {
      pump();
      await new Promise((r) => setTimeout(r, 120));
    }
    return !queue.length && !sending && !offline;
  }

  async function submit() {
    if (submitting || !canEdit()) return;
    document.activeElement?.blur?.();
    messages = [];
    const prob = M.problems(display(), cards, { requireReason: true });
    if (!prob.complete) { messages = M.problemMessages(prob); paint(true); return; }
    const ok = await confirmDialog({ title: '確定完成小組分類？', body: '提交後，全組將暫停編輯。',
      buttons: [{ label: '返回修改', value: false }, { label: '確認提交', value: true, primary: true }] });
    if (!ok || !canEdit()) return;
    submitting = true;
    paint(true);
    try {
      if (!(await waitSaved())) { messages = ['資料尚未儲存成功，請確認網路連線。']; return; }
      const b = await rpc(client, 'student_group_board', { p_session: sessionId, p_token: token });
      adopt(b);
      const r = await rpc(client, 'group_submit', { p_session: sessionId, p_token: token, p_expected_board_rev: b.board_rev });
      if (r.ok || r.code === 'ALREADY_SUBMITTED') {
        onPing?.('group');
      } else if (r.code === 'STALE') {
        messages = ['組員剛剛有修改，請再確認一次後提交。'];
      } else if (r.code === 'EDITING') {
        messages = ['組員正在輸入或移動故事，請等他完成後再提交。'];
      } else if (r.code === 'INCOMPLETE') {
        const p = r.problems;
        messages = M.problemMessages({ unplaced: p.unplaced, unnamed: (p.unnamed_no || []).map((no) => ({ no })),
          noReason: (p.no_reason || []).map((id) => { const c = server.cats.get(id); return { no: c?.label_no, name: c?.name || '' }; }) });
      }
    } catch (e) {
      messages = [e.code === 'NETWORK' ? '資料尚未儲存成功，請確認網路連線。' : errorText(e)];
      if (e.code !== 'NETWORK') onPing?.();
    } finally {
      submitting = false;
      await gsync?.refresh();
      paint(true);
    }
  }

  // ---------- 由學生端同步迴圈呼叫（環節、暫停、提交狀態） ----------
  function update(st) {
    const prev = lastSt;
    lastSt = st;
    if (!view) return;
    if (!prev || prev.state.editing_paused !== st.state.editing_paused || prev.group?.status !== st.group?.status
        || prev.group?.board_rev !== st.group?.board_rev || prev.state.phase !== st.state.phase) gsync?.refresh();
    if (!serverEditable()) dropPendingEdits();
    paint(true);
    if (canEdit() && queue.length) pump();
  }

  const onHide = () => { if (document.visibilityState === 'hidden') flushTexts(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushTexts);

  init();

  return {
    el,
    key: sessionId + ':' + groupNumber,
    update,
    destroy() {
      destroyed = true;
      gsync?.stop();
      holdRelease();
      clearTimeout(retryTimer); clearTimeout(slowTimer); clearTimeout(noticeTimer);
      for (const t of textTimers.values()) clearTimeout(t);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushTexts);
      view?.destroy();
    },
  };
}
