// C｜學生端（平板）：極簡、只呈現當下任務所需資訊。
import { makeClient, configured, rpc, errorText } from '../lib/api.js';
import { createSync } from '../lib/sync.js';
import { h, mount, confirmDialog } from '../lib/dom.js';
import { STUDENT_VIEW, STUDENT_TEXT, TEXT } from '../lib/phases.js';
import { createPersonal } from './personal.js';
import { createBoardView } from '../lib/board-view.js';

const root = document.getElementById('app');
const client = configured ? makeClient('student') : null;
const params = new URLSearchParams(location.search);
let code = (params.get('code') || '').trim().toUpperCase();
let sync = null;
let lastKey = '';
let personal = null;   // 03 個人分類工作區（保持同一個實體，避免同步時打斷操作）
let explore = false;   // 學生已按下「進入探索模式」

// ---------- 匿名、可恢復的裝置識別 ----------
// 每個活動代碼一組隨機憑證，存在此裝置的 localStorage；伺服器只保存其雜湊值。
function storeGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隱私模式 */ } }
function tokenFor(c) {
  const k = 'sf.token.' + c;
  let t = storeGet(k);
  if (!t) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    t = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    storeSet(k, t);
  }
  return t;
}
const sessionKey = (c) => 'sf.session.' + c;

// ---------- 共用外框 ----------
const netBar = h('div.netbar', { hidden: true }, '網路連線中斷，正在重新連線…（已儲存的資料不會遺失）');
function shell(...content) {
  mount(root, netBar, h('main.st-shell', ...content));
}

function screenMsg(title, text, extra) {
  shell(h('div.s-center', h('div.s-logo', TEXT.activity), title ? h('h1', title) : null,
    text ? h('p.s-lead', text) : null, extra || null));
}

// ---------- 加入流程 ----------
function askCode(errMsg) {
  const input = h('input.s-input', { inputmode: 'latin', autocapitalize: 'characters', maxlength: 6,
                                     placeholder: '六碼活動代碼', value: code });
  const go = () => { code = input.value.trim().toUpperCase(); if (code) { history.replaceState(null, '', '?code=' + code); start(); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  screenMsg('加入活動', '請輸入老師提供的活動代碼', h('div.s-form', input,
    h('button.primary.s-big', { type: 'button', onclick: go }, '下一步'),
    errMsg ? h('p.s-error', errMsg) : null));
}

async function chooseGroup(note) {
  let info;
  try { info = await rpc(client, 'student_lookup', { p_code: code }); }
  catch (e) { return screenMsg('無法連線', errorText(e), h('button.s-big', { onclick: start }, '重試')); }
  if (!info) return askCode('找不到這個活動代碼，或活動已結束。');
  if (!info.join_open) {
    return screenMsg(info.title, '老師目前暫停加入，請舉手告訴老師。', h('button.s-big', { onclick: () => chooseGroup() }, '重新檢查'));
  }
  shell(h('div.s-center',
    h('div.s-logo', info.title),
    h('h1', '請選擇你的組別'),
    note ? h('p.s-error', note) : null,
    h('div.s-groups', info.groups.map((g) => {
      const full = g.capacity != null && g.count >= g.capacity;
      return h('button.s-group', { type: 'button', disabled: full, onclick: () => joinGroup(g) },
        h('span.n', g.number), h('span.l', full ? '已滿' : g.name));
    }))));
}

async function joinGroup(g) {
  const ok = await confirmDialog({ title: `確認加入${g.name}？`, body: '加入後如需換組，請告訴老師。',
    buttons: [{ label: '重新選擇', value: false }, { label: '確認加入', value: true, primary: true }] });
  if (!ok) return;
  try {
    const r = await rpc(client, 'student_join', { p_code: code, p_token: tokenFor(code), p_group_number: g.number });
    storeSet(sessionKey(code), { session_id: r.session_id });
    runSession(r.session_id);
    sync.ping('roster');   // 通知教師端與投影端更新人數
  } catch (e) {
    chooseGroup(errorText(e));
  }
}

async function start() {
  if (!configured) return screenMsg('尚未設定', '網站尚未設定資料庫連線，請告訴老師。');
  if (!code) return askCode();
  const saved = storeGet(sessionKey(code));
  if (saved?.session_id) return runSession(saved.session_id);
  try {
    // 先嘗試以既有憑證恢復（例如清除了 session 紀錄但憑證還在）
    const info = await rpc(client, 'student_lookup', { p_code: code });
    if (!info) return askCode('找不到這個活動代碼，或活動已結束。');
    try {
      await rpc(client, 'student_state', { p_session: info.session_id, p_token: tokenFor(code) });
      storeSet(sessionKey(code), { session_id: info.session_id });
      return runSession(info.session_id);
    } catch { /* 尚未加入 */ }
    chooseGroup();
  } catch (e) {
    screenMsg('無法連線', errorText(e), h('button.s-big', { onclick: start }, '重試'));
  }
}

// ---------- 上課中：依教師控制的環節顯示畫面 ----------
function runSession(sessionId) {
  sync?.stop();
  const token = tokenFor(code);
  sync = createSync({
    client,
    topic: 'lesson:' + sessionId,
    load: () => rpc(client, 'student_state', { p_session: sessionId, p_token: token }),
    onStatus: ({ online }) => { netBar.hidden = online; },
    onData: (st, err) => {
      if (err) {
        if (err.code === 'NOT_JOINED') { try { localStorage.removeItem(sessionKey(code)); } catch { /* 隱私模式 */ } sync.stop(); return chooseGroup(); }
        return;
      }
      renderState(sessionId, token, st);
    },
  });
}

function renderState(sessionId, token, st) {
  if (st.removed) {
    if (personal) { personal.destroy(); personal = null; }
    const k = 'removed';
    if (lastKey === k) return; lastKey = k;
    return screenMsg('已離開小組', '老師已將你移出小組。', st.join_open
      ? h('button.s-big.primary', { onclick: () => { sync.stop(); lastKey = ''; chooseGroup(); } }, '重新選擇組別') : null);
  }
  document.body.classList.toggle('focus-mode', Boolean(st.state.focus_mode) || explore);
  const view = st.session.status === 'ended' ? 'end' : STUDENT_VIEW[st.state.phase] || 'watch';

  // 03：分類工作區自行處理後續的狀態更新（暫停、提交、鎖定），不整頁重畫
  if (view === 'personal') {
    if (!personal || personal.sessionId !== sessionId) {
      personal?.destroy();
      personal = createPersonal({ client, sessionId, token, title: `${st.session.title}・我的故事分類`,
        onPing: (ev) => { if (ev) sync.ping(ev); sync.refresh(); } });
      lastKey = 'personal';
      shell(personal.el);
    }
    personal.update(st);
    return;
  }
  if (personal) { personal.destroy(); personal = null; }
  // 只有影響畫面的欄位改變才重畫，避免打斷學生操作
  const key = [view, st.state.phase, st.me.group_number, st.me.seat_label, st.state.focus_mode, explore,
               st.can.personal_edit, st.can.group_edit, st.state.editing_paused].join('|');
  if (key === lastKey) return;
  lastKey = key;

  const header = h('header.s-header', h('span.s-title', TEXT.activity),
    h('span.s-me', `${st.me.group_name}・${st.me.seat_label}`));

  if (view === 'wait') return shell(header, h('div.s-center', h('div.s-check', '✓'), h('h1', '已加入' + st.me.group_name), h('p.s-lead', STUDENT_TEXT.wait)));
  if (view === 'end') return shell(header, h('div.s-center', h('h1', TEXT.endLine1), h('p.s-lead', TEXT.endLine2)));
  if (view === 'watch') {
    return shell(header, h('div.s-center', h('div.s-eye', '👀'),
      h('p.s-lead', st.state.phase === '01' ? STUDENT_TEXT.watch01 : STUDENT_TEXT.watch)));
  }
  if (view === 'ready') {
    return shell(header, h('div.s-center',
      h('h1', TEXT.activity),
      h('p.s-lead', `你在${st.me.group_name}，已完成加入。`),
      explore
        ? h('p.s-lead.muted', '已進入探索模式，請等待老師開始。')
        : h('button.primary.s-big', { type: 'button', onclick: enterExplore }, '進入探索模式'),
      h('p.s-note', '平板建議橫向使用')));
  }
  if (view === 'group') {
    return shell(header, h('div.s-center', h('h1', '故事找朋友：小組共作'),
      h('p.s-lead', TEXT.group), h('p.s-note', '（小組共同編輯畫面將於 Phase 3 完成）')),
      myPersonalPanel(sessionId, token));
  }
}

async function enterExplore() {
  explore = true;
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch { /* 不支援時使用網站專注模式即可 */ }
  lastKey = '';
  sync?.refresh();
}

// 我的個人分類（唯讀快照）：預設收合，按鍵展開；可重新閱讀故事，不可修改。
// Phase 3 小組共作畫面左側會沿用此面板。
function myPersonalPanel(sessionId, token) {
  const body = h('div.mp-body', { hidden: true });
  let loaded = false;
  const btn = h('button.s-big', { type: 'button', 'aria-expanded': 'false', onclick: async () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '收合我的個人分類' : '查看我的個人分類';
    if (!open || loaded) return;
    body.replaceChildren(h('p.muted', '載入中…'));
    try {
      const [cards, p] = await Promise.all([
        rpc(client, 'student_cards', { p_session: sessionId, p_token: token }),
        rpc(client, 'student_personal', { p_session: sessionId, p_token: token }),
      ]);
      const snap = p.snapshot;
      const v = createBoardView({ cards, title: '我的個人分類（唯讀）', readOnly: true, embedded: true });
      v.setData(snap ? snap.data : p.data);
      if (snap && !snap.is_complete) v.setNotice(h('div.bd-notice', '老師結束個人分類時尚未完成，這是當時已儲存的部分。'));
      body.replaceChildren(v.el);
      loaded = true;
    } catch (e) {
      body.replaceChildren(h('p.s-error', errorText(e)));
    }
  } }, '查看我的個人分類');
  return h('section.mp', btn, body);
}

start();
