// C｜學生端（平板）：極簡、只呈現當下任務所需資訊。
import { makeClient, configured, rpc, errorText } from '../lib/api.js';
import { createSync } from '../lib/sync.js';
import { h, mount, confirmDialog, toast } from '../lib/dom.js';
import { STUDENT_VIEW, STUDENT_TEXT, TEXT } from '../lib/phases.js';
import { createPersonal } from './personal.js';
import { beginFullscreen, setRequired, fsSupported, fsReportState, onFsChange } from './fullscreen.js';
import { createFsReporter } from './fs-report.js';
import { parseSeat, seatText } from '../lib/seat.js';
import { createGroup } from './group.js';

const root = document.getElementById('app');
const client = configured ? makeClient('student') : null;
const params = new URLSearchParams(location.search);
let code = (params.get('code') || '').trim().toUpperCase();
let sync = null;
let lastKey = '';
let personal = null;   // 03 個人分類工作區（保持同一個實體，避免同步時打斷操作）
let group = null;      // 04 小組共作工作區（同上；換組或換場次時才重建）
let explore = false;   // 學生已加入（探索模式：網站專注模式＋全螢幕）
let fsReporter = null;  // 全螢幕狀態回報（教師端小組成員清單）
let joinForm = { seat: '', group: null };   // 選組畫面的輸入（加入失敗或格式錯誤時保留）

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

// ---------- 選擇組別：輸入座號 → 選擇組別 → 加入 → 確認加入（同一次點擊請求全螢幕） ----------
const seatKey = (c) => 'sf.seat.' + c;
async function chooseGroup(note) {
  setRequired(false);
  let info;
  try { info = await rpc(client, 'student_lookup', { p_code: code }); }
  catch (e) { return screenMsg('無法連線', errorText(e), h('button.s-big', { onclick: () => chooseGroup(note) }, '重試')); }
  if (!info) return askCode('找不到這個活動代碼，或活動已結束。');
  if (!info.join_open) {
    return screenMsg(info.title, '老師目前暫停加入，請舉手告訴老師。', h('button.s-big', { onclick: () => chooseGroup() }, '重新檢查'));
  }
  if (!joinForm.seat) joinForm.seat = storeGet(seatKey(code)) || '';
  const seatErr = h('p.s-error.s-field-error', { id: 'seat-error', hidden: true, role: 'alert' });
  const groupErr = h('p.s-error.s-field-error', { id: 'group-error', hidden: true, role: 'alert' });
  const seat = h('input.s-input.s-seat', { id: 'seat', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 3,
    enterkeyhint: 'next', autocomplete: 'off', placeholder: '例如 5', value: joinForm.seat, 'aria-describedby': 'seat-error', 'aria-required': 'true' });
  const showErr = (el, input, text) => { el.textContent = text || ''; el.hidden = !text; if (input) input.setAttribute('aria-invalid', text ? 'true' : 'false'); };
  seat.addEventListener('input', () => { joinForm.seat = seat.value; if (!seatErr.hidden && !parseSeat(seat.value).error) showErr(seatErr, seat, ''); });
  seat.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); seat.blur(); } });
  const groupBtns = info.groups.map((g) => {
    const full = g.capacity != null && g.count >= g.capacity;
    const b = h('button.s-group', { type: 'button', disabled: full, 'aria-pressed': String(joinForm.group === g.number),
      onclick: () => { joinForm.group = g.number; groupBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); showErr(groupErr, null, ''); } },
      h('span.n', g.number), h('span.l', full ? '已滿' : g.name));
    if (full && joinForm.group === g.number) joinForm.group = null;
    return b;
  });
  const submit = () => {
    const r = parseSeat(seat.value);
    const g = info.groups.find((x) => x.number === joinForm.group);
    showErr(seatErr, seat, r.error || '');
    showErr(groupErr, null, g ? '' : '請選擇你的組別。');
    if (r.error) { seat.focus(); return; }
    if (!g) return;
    joinGroup(g, r.value);
  };
  shell(h('div.s-center.s-join',
    h('div.s-logo', info.title),
    h('h1', '輸入座號，選擇組別'),
    note ? h('p.s-error', { role: 'alert' }, note) : null,
    h('div.s-field', h('label.s-label', { for: 'seat' }, '座號（必填）'), seat, seatErr),
    h('div.s-field', h('span.s-label', '組別'), h('div.s-groups', { role: 'group', 'aria-label': '組別' }, groupBtns), groupErr),
    h('button.primary.s-big.s-join-go', { type: 'button', onclick: submit }, '加入')));
}

async function joinGroup(g, seatNo) {
  let fs = null;
  // 「確認加入」的點擊事件中同步請求全螢幕（不等網路回應，避免失去瀏覽器要求的使用者操作授權）
  const ok = await confirmDialog({ title: `確認加入${g.name}？`, body: `座號 ${seatNo} 號。加入後如需換組，請告訴老師。`,
    buttons: [{ label: '重新選擇', value: false },
              { label: '確認加入', value: true, primary: true, onSelect: () => { fs = beginFullscreen(); } }] });
  if (!ok) return;
  storeSet(seatKey(code), String(seatNo));
  let r;
  try {
    r = await rpc(client, 'student_join', { p_code: code, p_token: tokenFor(code), p_group_number: g.number, p_seat_no: seatNo });
  } catch (e) {
    await fs;
    return chooseGroup(errorText(e));   // 座號與已選組別保留在 joinForm
  }
  const fsr = await fs;
  storeSet(sessionKey(code), { session_id: r.session_id });
  if (r.resumed && r.seat_no != null && Number(r.seat_no) !== seatNo) toast(`這台裝置已用 ${r.seat_no} 號加入，沿用原本的座號與組別。`, 'info', 5000);
  joinForm = { seat: '', group: null };
  // 加入成功：之後只要不在全螢幕就顯示黑色遮罩；全螢幕請求被拒絕時，遮罩直接顯示原因並可重試
  setRequired(true, { failedRequest: Boolean(fsr && !fsr.ok && !fsr.unsupported) });
  runSession(r.session_id);
  sync.ping('roster');   // 通知教師端與投影端更新人數
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
  fsReporter?.stop();
  explore = true;
  setRequired(true);   // 已加入（含重新整理、斷線重連後恢復）：退出全螢幕時顯示黑色遮罩
  const token = tokenFor(code);
  const seqKey = 'sf.fsseq.' + code;
  fsReporter = createFsReporter({
    getState: fsReportState,
    send: (state, seq) => rpc(client, 'student_report_fullscreen', { p_session: sessionId, p_token: token, p_state: state, p_seq: seq }),
    loadSeq: () => storeGet(seqKey), saveSeq: (v) => storeSet(seqKey, v),
    onAccepted: () => sync?.ping('fullscreen'),   // 通知教師端立即重新讀取
  });
  let wasOnline = true;
  sync = createSync({
    client,
    topic: 'lesson:' + sessionId,
    load: () => rpc(client, 'student_state', { p_session: sessionId, p_token: token }),
    onStatus: ({ online }) => {
      netBar.hidden = online;
      if (online && !wasOnline) fsReporter?.resync();   // 重新連線：先回報當下的全螢幕狀態
      wasOnline = online;
    },
    onData: (st, err) => {
      if (err) {
        if (err.code === 'NOT_JOINED') { try { localStorage.removeItem(sessionKey(code)); } catch { /* 隱私模式 */ } sync.stop(); fsReporter?.stop(); explore = false; return chooseGroup(); }
        return;
      }
      renderState(sessionId, token, st);
    },
  });
  fsReporter.report();   // 加入、重新整理後：回報當下狀態
}
// 全螢幕狀態改變（進入、退出、請求未被允許）：回報
onFsChange((state) => fsReporter?.report(state));
addEventListener('online', () => fsReporter?.resync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fsReporter?.resync(); });   // 回到前景：背景期間的回報可能遺失

function renderState(sessionId, token, st) {
  if (st.removed) {
    setRequired(false);   // 已被移出：不再要求全螢幕
    fsReporter?.stop(); fsReporter = null;
    if (personal) { personal.destroy(); personal = null; }
    if (group) { group.destroy(); group = null; }
    const k = 'removed';
    if (lastKey === k) return; lastKey = k;
    return screenMsg('已離開小組', '老師已將你移出小組。', st.join_open
      ? h('button.s-big.primary', { onclick: () => { sync.stop(); lastKey = ''; explore = false; chooseGroup(); } }, '重新選擇組別') : null);
  }
  document.body.classList.toggle('focus-mode', Boolean(st.state.focus_mode) || explore);
  const view = st.session.status === 'ended' ? 'end' : STUDENT_VIEW[st.state.phase] || 'watch';
  // 不屬於目前畫面的工作區一律先卸載（04 → 03 → 04 時要重新掛上小組工作區，不能沿用已被換掉的那一個；Phase 5）
  if (view !== 'personal' && personal) { personal.destroy(); personal = null; }
  if (view !== 'group' && group) { group.destroy(); group = null; }

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

  // 04：小組共作工作區同樣自行處理後續更新；即時資料更新時不卸載畫面（閱讀視窗、捲動位置、輸入中的文字都保留）
  if (view === 'group') {
    const gkey = sessionId + ':' + st.me.group_number;
    if (!group || group.key !== gkey) {
      group?.destroy();
      group = createGroup({ client, sessionId, token, groupNumber: st.me.group_number,
        onPing: (ev) => { if (ev) sync.ping(ev); sync.refresh(); } });
      lastKey = 'group';
      shell(group.el);
    }
    group.update(st);
    return;
  }
  // 只有影響畫面的欄位改變才重畫，避免打斷學生操作
  const key = [view, st.state.phase, st.me.group_number, st.me.seat_label, st.me.seat_no, st.state.focus_mode, explore,
               st.can.personal_edit, st.can.group_edit, st.state.editing_paused].join('|');
  if (key === lastKey) return;
  lastKey = key;

  const header = h('header.s-header', h('span.s-title', TEXT.activity),
    h('span.s-me', `${st.me.group_name}・${seatText(st.me)}`));

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
      h('p.s-lead.muted', fsSupported() ? '已進入探索模式（全螢幕），請等待老師開始。' : '這台裝置不支援全螢幕，已以一般畫面進入探索模式，請等待老師開始。'),
      h('p.s-note', '平板建議橫向使用')));
  }
}

start();
