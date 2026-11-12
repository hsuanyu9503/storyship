// 03｜我的故事分類：學生端控制器（資料來源＝個人草稿 personal_boards）
//
// 儲存策略（避免舊資料覆蓋新資料）：
//   * 一次只送出一個儲存請求（序列化）；送出期間的新變更等上一個完成後再送最新版本，
//     因此較早的請求不可能晚於較新的請求寫入。
//   * 每次儲存都帶 p_expected_rev，伺服器版本不符時回傳 STALE（例如同一位學生開了兩個分頁），
//     此時改用伺服器上的最新資料，不覆寫。
//   * 尚未送達的變更暫存在 localStorage（含其基準版本）；重新整理後只有在伺服器版本仍等於
//     基準版本、且仍可編輯時才補送，否則丟棄（不會用離線的舊資料蓋掉新資料或已鎖定成果）。
//   * 提交前先確認最後一次修改已由伺服器確認，再以同一版本號提交；伺服器確認後才顯示完成。
import { rpc, errorText } from '../lib/api.js';
import { h } from '../lib/dom.js';
import * as M from '../lib/board-model.js';
import { createBoardView } from '../lib/board-view.js';

const RENAME_DEBOUNCE = 700;
const SLOW_SAVE_MS = 1500;

export function createPersonal({ client, sessionId, token, title, onPing }) {
  const el = h('div.pb', h('div.s-center', h('p.s-lead', '載入故事中…')));
  const draftKey = 'sf.draft.' + sessionId;

  let cards = null;
  let view = null;
  let destroyed = false;

  // 伺服器確認的狀態
  let rev = 0;
  let submitted = false;
  let locked = false;
  // 本機狀態
  let local = M.emptyBoard();
  let seq = 0;          // 本機變更計數
  let savedSeq = 0;     // 已由伺服器確認的變更計數
  let saving = null;    // 進行中的儲存 Promise
  let saveState = 'ok'; // ok | offline | error | blocked
  let slowTimer = null;
  let slow = false;
  let renameTimer = null;
  let retryTimer = null;
  let retryDelay = 2000;
  let submitting = false;
  let messages = [];    // 提交檢查訊息
  let notice = null;    // 一次性提示（例如另一個畫面更新）
  let lastSt = null;
  let reloading = false;
  let lockedShown = false;   // 已顯示伺服器鎖定後的成果
  let paintKey = '';

  // ---------- 本機暫存 ----------
  function readDraft() { try { return JSON.parse(localStorage.getItem(draftKey)); } catch { return null; } }
  function writeDraft() { try { localStorage.setItem(draftKey, JSON.stringify({ rev, data: local })); } catch { /* 隱私模式 */ } }
  function clearDraft() { try { localStorage.removeItem(draftKey); } catch { /* 隱私模式 */ } }

  const canEdit = () => Boolean(lastSt?.can?.personal_edit) && !submitted && !locked;
  const dirty = () => seq !== savedSeq;

  // ---------- 載入 ----------
  async function init() {
    try {
      const [c, p] = await Promise.all([
        rpc(client, 'student_cards', { p_session: sessionId, p_token: token }),
        rpc(client, 'student_personal', { p_session: sessionId, p_token: token }),
      ]);
      if (destroyed) return;
      cards = c;
      view = createBoardView({ cards, title, onChange });
      el.replaceChildren(view.el);
      adopt(p, { restoreDraft: true });
    } catch (e) {
      if (destroyed) return;
      el.replaceChildren(h('div.s-center', h('p.s-error', errorText(e)),
        h('button.s-big', { type: 'button', onclick: () => { el.replaceChildren(h('div.s-center', h('p.s-lead', '載入中…'))); init(); } }, '重試')));
    }
  }

  // 套用伺服器資料
  function adopt(p, { restoreDraft = false } = {}) {
    rev = p.rev;
    submitted = p.submitted;
    locked = p.locked;
    if (locked) lockedShown = true;
    const server = M.normalize(locked && p.snapshot ? p.snapshot.data : p.data, cards);
    local = server;
    seq = savedSeq = seq + 1;
    if (restoreDraft) {
      const d = readDraft();
      const usable = d && d.rev === p.rev && !p.submitted && !p.locked && lastSt?.can?.personal_edit;
      if (usable && !M.sameBoard(d.data, server)) {
        local = M.normalize(d.data, cards);
        seq++;
      } else clearDraft();
    } else if (!dirty()) clearDraft();
    view.setData(local);
    paint();
    if (dirty()) save();
  }

  async function reload(force = false) {
    if (reloading) return;
    reloading = true;
    try {
      const p = await rpc(client, 'student_personal', { p_session: sessionId, p_token: token });
      if (destroyed) return;
      if (force || (!dirty() && !saving && p.rev >= rev)) { lockedShown = p.locked; adopt(p); }
    } catch { /* 下次同步再試 */ } finally { reloading = false; }
  }

  // ---------- 使用者操作 ----------
  function onChange(d, kind) {
    if (!canEdit()) { view.setData(local); return; }
    const changed = !M.sameBoard(d, local);
    local = d;
    if (changed) { seq++; messages = []; writeDraft(); }
    clearTimeout(renameTimer);
    if (kind === 'rename') renameTimer = setTimeout(save, RENAME_DEBOUNCE);
    else save();
    paint();
  }

  let staleCount = 0;
  function save() {
    clearTimeout(renameTimer);
    if (saving) return saving;
    if (!dirty() || !canEdit() || destroyed) return Promise.resolve();
    const sendSeq = seq;
    const payload = local;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { slow = true; paint(); }, SLOW_SAVE_MS);
    saving = (async () => {
      try {
        const r = await rpc(client, 'student_save_personal',
          { p_session: sessionId, p_token: token, p_data: payload, p_expected_rev: rev });
        if (r.ok) {
          rev = r.rev;
          savedSeq = sendSeq;
          saveState = 'ok';
          retryDelay = 2000;
          if (!dirty()) clearDraft(); else writeDraft();
        } else if (r.code === 'STALE') {
          // 另一個分頁（或另一個畫面）已更新：以伺服器最新資料為準
          rev = r.rev;
          local = M.normalize(r.data, cards);
          seq = savedSeq = seq + 1;
          clearDraft();
          view.setData(local);
          saveState = 'ok';
          staleCount++;
          notice = '你的分類已在另一個畫面更新，已載入最新內容。';
        }
      } catch (e) {
        if (e.code === 'NETWORK') {
          saveState = 'offline';
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { retryTimer = null; save(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15000);
        } else if (['PAUSED', 'NOT_AVAILABLE', 'PERSONAL_LOCKED', 'SUBMITTED', 'SESSION_ENDED', 'REMOVED'].includes(e.code)) {
          // 權限已改變（教師暫停、結束個人分類等）：等待下一次狀態同步決定畫面
          saveState = 'blocked';
          onPing?.();
        } else {
          saveState = 'error';
          notice = errorText(e);
          reload();
        }
      } finally {
        clearTimeout(slowTimer);
        slow = false;
        saving = null;
        paint();
        if (dirty() && saveState === 'ok') save();
      }
    })();
    return saving;
  }

  // 等待所有變更都由伺服器確認（最多 timeoutMs）
  async function flush(timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (dirty()) {
      if (!canEdit() || Date.now() > until) return false;
      if (saveState !== 'ok') { clearTimeout(retryTimer); retryTimer = null; saveState = 'ok'; }
      const before = savedSeq;
      await save();
      if (saveState !== 'ok') return false;
      if (savedSeq === before && dirty()) return false;   // 沒有進展
    }
    return true;
  }

  async function submit() {
    if (submitting || !canEdit()) return;
    submitting = true;
    messages = [];
    paint();
    try {
      const cleaned = M.stripEmpty(local, cards);
      if (!M.sameBoard(cleaned, local)) { local = cleaned; seq++; view.setData(local); writeDraft(); }
      const prob = M.problems(local, cards);
      if (!prob.complete) { messages = M.problemMessages(prob); return; }
      const stale0 = staleCount;
      if (!(await flush())) { messages = ['資料尚未儲存成功，請確認網路連線。']; return; }
      if (staleCount !== stale0) { messages = ['資料已在另一個畫面更新，請確認後再按一次完成。']; return; }
      const r = await rpc(client, 'student_submit_personal', { p_session: sessionId, p_token: token, p_expected_rev: rev });
      if (r.ok) {
        rev = r.rev;
        submitted = true;
        clearDraft();
        onPing?.('personal');
      } else if (r.code === 'INCOMPLETE') {
        messages = M.problemMessages({ unplaced: r.problems.unplaced,
          unnamed: (r.problems.unnamed_no || []).map((no) => ({ no })) });
      } else if (r.code === 'STALE') {
        messages = ['資料已在另一個畫面更新，請確認後再按一次完成。'];
        await reload();
      }
    } catch (e) {
      messages = [e.code === 'NETWORK' ? '資料尚未儲存成功，請確認網路連線。' : errorText(e)];
      if (e.code !== 'NETWORK') onPing?.();
    } finally {
      submitting = false;
      paint();
    }
  }

  async function reopen() {
    if (submitting) return;
    submitting = true;
    paint();
    try {
      const r = await rpc(client, 'student_reopen_personal', { p_session: sessionId, p_token: token });
      rev = r.rev;
      submitted = false;
      onPing?.('personal');
    } catch (e) {
      notice = errorText(e);
    } finally {
      submitting = false;
      paint();
    }
  }

  // ---------- 畫面狀態 ----------
  function mode() {
    if (locked) return 'locked';
    if (lastSt?.session?.status === 'ended') return 'locked';
    if (submitted) return 'submitted';
    if (lastSt?.state?.editing_paused) return 'paused';
    if (!lastSt?.can?.personal_edit) return 'readonly';
    return 'edit';
  }

  function paint() {
    if (!view) return;
    const m = mode();
    const key = JSON.stringify([m, saveState, dirty(), slow, submitting, messages, notice,
      lastSt?.state?.phase, lastSt?.state?.editing_paused, lastSt?.session?.status]);
    if (key === paintKey) return;
    paintKey = key;
    view.setReadOnly(m !== 'edit');

    let status = null;
    if (saveState === 'offline' && dirty()) status = h('span.save-bad', '尚未儲存（網路恢復後會自動儲存）');
    else if (saveState === 'error') status = h('span.save-bad', '儲存失敗');
    else if (dirty() && m === 'paused') status = h('span.save-bad', '尚未儲存');
    else if (slow) status = h('span.save-mid', '儲存中…');
    view.setStatus(status);

    let n = null;
    if (m === 'locked') n = h('div.bd-notice', '老師已結束個人分類，你的成果已保存。');
    else if (m === 'paused') n = h('div.bd-notice', '老師暫停了編輯，請先看前方。（可以繼續閱讀故事）');
    else if (notice) n = h('div.bd-notice.info', notice, h('button.small', { type: 'button', onclick: () => { notice = null; paint(); } }, '知道了'));
    view.setNotice(n);

    if (m === 'edit') {
      view.setFooter(h('div.pb-foot',
        messages.length ? h('ul.pb-msgs', { role: 'alert' }, messages.map((x) => h('li', x))) : null,
        h('button.primary.s-big.pb-done', { type: 'button', disabled: submitting, onclick: submit },
          submitting ? '確認中…' : '完成個人分類')));
    } else if (m === 'submitted') {
      const canReopen = lastSt?.state?.phase === '03' && !lastSt?.state?.editing_paused && lastSt?.session?.status === 'active';
      view.setFooter(h('div.pb-foot.done',
        h('p.pb-done-msg', '✓ 已完成個人分類'),
        notice && !n ? h('p.s-error', notice) : null,
        canReopen ? h('button.s-big', { type: 'button', disabled: submitting, onclick: reopen }, '繼續修改') : null));
    } else {
      view.setFooter(null);
    }
  }

  // ---------- 由學生端同步迴圈呼叫 ----------
  function update(st) {
    const prevEdit = canEdit();
    lastSt = st;
    if (!view) return;
    const p = st.personal || {};
    if (p.locked && !lockedShown) {
      // 已鎖定：放棄未送達的本機變更，顯示伺服器保存的成果
      clearTimeout(renameTimer); clearTimeout(retryTimer);
      seq = savedSeq;
      clearDraft();
      locked = true;
      reload(true);
    } else if (p.rev !== rev || p.submitted !== submitted) {
      if (!dirty() && !saving && !view.isEditingName()) reload();
    }
    if (!prevEdit && canEdit() && dirty()) { saveState = 'ok'; save(); }
    paint();
  }

  const onOnline = () => { if (dirty()) { saveState = 'ok'; save(); } };
  const onHide = () => { if (dirty()) save(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);

  init();

  return {
    el,
    sessionId,
    update,
    destroy() {
      destroyed = true;
      clearTimeout(renameTimer); clearTimeout(retryTimer); clearTimeout(slowTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      view?.destroy();
    },
  };
}
