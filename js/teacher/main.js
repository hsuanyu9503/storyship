// B｜教師主控端：控制教學環節、內容揭露與學生連線。
import { makeClient, configured, rpc, errorText } from '../lib/api.js';
import { createSync } from '../lib/sync.js';
import { h, mount, toast, confirmDialog } from '../lib/dom.js';
import { PHASES, phaseById, nextPhase, prevPhase, totalMinutes } from '../lib/phases.js';
import * as P from '../lib/projection.js';
import { renderProjection } from '../lib/render-projection.js';
import { qrDataUrl, joinUrl } from '../lib/qr.js';

const root = document.getElementById('app');
const client = configured ? makeClient('teacher') : null;
const ONLINE_MS = 40000;

const S = {
  user: null,
  session: null,      // sessions 資料列（含 projector_key）
  content: { cards: [], intro: [], genres: [] },
  state: null,        // session_state
  pub: null,          // projector_state（＝投影端實際看到的內容）
  groups: [],
  people: [],
  personal: { boards: 0, submitted: 0, snapshots: 0 },
  sync: null,
  genrePreview: null, // 第六環節：教師私下預覽中的類型 index（不同步）
  busy: false,
};

// ======================================================================
// 進入點與路由
// ======================================================================
async function boot() {
  if (!configured) {
    return mount(root, h('div.card.narrow', h('h1', '尚未設定資料庫連線'),
      h('p', '請編輯 config.js，填入 Supabase 專案網址與 anon（publishable）key。詳見 docs/DEPLOY.md。')));
  }
  const { data } = await client.auth.getSession();
  S.user = data.session?.user || null;
  client.auth.onAuthStateChange((_e, sess) => {
    const u = sess?.user || null;
    if ((u?.id || null) !== (S.user?.id || null)) { S.user = u; route(); }
  });
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  S.sync?.stop(); S.sync = null;
  if (!S.user) return viewLogin();
  let ok = false;
  try { ok = await rpc(client, 'is_teacher'); } catch (e) { return mount(root, h('div.card.narrow', h('p.error', errorText(e)))); }
  if (!ok) {
    return mount(root, h('div.card.narrow', h('h1', '此帳號尚未設為教師'),
      h('p', '請在 Supabase SQL Editor 執行 supabase/setup/add_teacher.sql，把此帳號加入教師白名單。'),
      h('p.muted', S.user.email),
      h('button', { onclick: () => client.auth.signOut() }, '登出')));
  }
  const m = location.hash.match(/^#\/s\/([0-9a-f-]{36})/);
  if (m) return viewConsole(m[1]);
  return viewSessions();
}

// ======================================================================
// 登入
// ======================================================================
function viewLogin(err) {
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: '密碼', autocomplete: 'current-password' });
  const submit = async (e) => {
    e.preventDefault();
    const { error } = await client.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) viewLogin('登入失敗：' + error.message);
  };
  mount(root, h('form.card.narrow', { onsubmit: submit },
    h('h1', '故事找朋友｜教師登入'), email, pass,
    h('button.primary', { type: 'submit' }, '登入'),
    err ? h('p.error', err) : null));
}

// ======================================================================
// 場次列表
// ======================================================================
async function viewSessions() {
  const { data, error } = await client.from('sessions')
    .select('id,title,join_code,status,created_at,ended_at').order('created_at', { ascending: false });
  if (error) return mount(root, h('div.card.narrow', h('p.error', error.message)));
  const title = h('input', { value: '故事找朋友', maxlength: 40 });
  const create = async () => {
    try {
      const r = await rpc(client, 'teacher_create_session', { p_title: title.value, p_group_count: 6 });
      location.hash = '#/s/' + r.session_id;
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const purge = async () => {
    try { const r = await rpc(client, 'teacher_purge_expired'); toast(`已清除 ${r.deleted} 個過期場次`); viewSessions(); }
    catch (e) { toast(errorText(e), 'error'); }
  };
  mount(root, h('div.page',
    h('header.topbar', h('strong', '故事找朋友｜教師主控端'), h('span.spacer'),
      h('span.muted', S.user.email), h('button', { onclick: () => client.auth.signOut() }, '登出')),
    h('section.card', h('h2', '建立教學場次'),
      h('div.row', title, h('button.primary', { onclick: create }, '建立（六組）')),
      h('p.muted', `課程：00 課前準備＋七個環節，共 ${totalMinutes()} 分鐘（時間為建議值，不會自動切換）。`)),
    h('section.card', h('h2', '我的場次'),
      data.length === 0 ? h('p.muted', '尚無場次') :
      h('table.tbl', h('thead', h('tr', h('th', '名稱'), h('th', '代碼'), h('th', '狀態'), h('th', '建立時間'), h('th', ''))),
        h('tbody', data.map((s) => h('tr',
          h('td', s.title), h('td.mono', s.join_code), h('td', s.status === 'active' ? '進行中' : '已結束'),
          h('td', new Date(s.created_at).toLocaleString()),
          h('td.actions',
            h('a.btn', { href: '#/s/' + s.id }, '開啟'),
            h('button.danger', { onclick: async () => {
              if (!await confirmDialog({ title: '刪除場次？', body: '此場次所有學生成果都會永久刪除。', buttons: [{ label: '取消', value: false }, { label: '永久刪除', value: true, danger: true }] })) return;
              try { await rpc(client, 'teacher_delete_session', { p_session: s.id }); viewSessions(); } catch (e) { toast(errorText(e), 'error'); }
            } }, '刪除'))))))),
    h('section.card', h('h2', '資料保存'),
      h('p.muted', '已結束的場次會保留設定的天數（預設 30 天）。'),
      h('button', { onclick: purge }, '清除已過保留期限的場次'))));
}

// ======================================================================
// 主控台
// ======================================================================
async function viewConsole(sessionId) {
  mount(root, h('div.page', h('p.muted', '載入中…')));
  const { data: session, error } = await client.from('sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error || !session) {
    return mount(root, h('div.card.narrow', h('p.error', '找不到場次或沒有權限。'), h('a.btn', { href: '#' }, '返回')));
  }
  S.session = session;
  await loadContent(session.content_set_id);

  const els = {
    head: h('div'), steps: h('nav.steps'), panel: h('section.card.panel'),
    live: h('div.preview-box'), draft: h('div.preview-box'), draftWrap: h('div'), roster: h('section.card'),
  };
  S.els = els;
  mount(root, h('div.page.console',
    els.head,
    h('div.console-grid',
      h('aside', els.steps),
      h('main', els.panel, els.roster),
      h('aside.previews',
        h('div.preview-label.live', '● 投影中（全班看到的畫面）'), els.live,
        els.draftWrap))));

  S.sync = createSync({
    client,
    topic: 'lesson:' + sessionId,
    fastMs: 5000,
    slowMs: 10000,
    load: () => loadLive(sessionId),
    onStatus: () => { if (S.state) renderHead(); },
    onData: (d, err) => { if (err) return toast(errorText(err), 'error'); renderAll(); },
  });
}

async function loadContent(setId) {
  const [cards, intro, genres] = await Promise.all([
    client.from('story_cards').select('*').eq('content_set_id', setId).order('sort_order'),
    client.from('intro_stories').select('*, intro_clues(*)').eq('content_set_id', setId).order('sort_order'),
    client.from('genres').select('*').eq('content_set_id', setId).order('sort_order'),
  ]);
  S.content = {
    cards: cards.data || [],
    intro: (intro.data || []).map((s) => ({ ...s, clues: (s.intro_clues || []).sort((a, b) => a.sort_order - b.sort_order) })),
    genres: genres.data || [],
  };
}

async function loadLive(sessionId) {
  const [pub, st, groups, people, boards, snaps] = await Promise.all([
    rpc(client, 'projector_state', { p_session: sessionId, p_key: null }),
    client.from('session_state').select('*').eq('session_id', sessionId).single(),
    client.from('groups').select('*').eq('session_id', sessionId).order('number'),
    client.from('participants').select('id,group_id,seat_label,status,joined_at,last_seen_at').eq('session_id', sessionId).order('joined_at'),
    client.from('personal_boards').select('participant_id,submitted_at').eq('session_id', sessionId),
    client.from('personal_snapshots').select('participant_id,is_complete').eq('session_id', sessionId),
  ]);
  for (const r of [st, groups, people, boards, snaps]) if (r.error) throw Object.assign(new Error(r.error.message), { code: 'NETWORK' });
  S.pub = pub;
  S.state = st.data;
  S.groups = groups.data;
  S.people = people.data;
  S.personal = {
    boards: boards.data.length,
    submitted: boards.data.filter((b) => b.submitted_at).length,
    snapshots: snaps.data.length,
    incomplete: new Set(snaps.data.filter((s) => !s.is_complete).map((s) => s.participant_id)),
    submittedSet: new Set(boards.data.filter((b) => b.submitted_at).map((b) => b.participant_id)),
  };
  const sess = await client.from('sessions').select('*').eq('id', sessionId).single();
  if (!sess.error) S.session = sess.data;
  return true;
}

// ----------------------------------------------------------------------
// 發布（唯一會改變投影的動作）
// ----------------------------------------------------------------------
function rememberProjection(phase, sub, projection) {
  try { localStorage.setItem(`sf.last.${S.session.id}.${phase}`, JSON.stringify({ sub, projection })); } catch { /* ignore */ }
}
function recallProjection(phase) {
  try { return JSON.parse(localStorage.getItem(`sf.last.${S.session.id}.${phase}`)); } catch { return null; }
}

async function publish(phase, sub, projection, { lock = false } = {}) {
  if (S.busy) return false;
  S.busy = true;
  try {
    const r = await rpc(client, 'teacher_set_stage', {
      p_session: S.session.id, p_phase: phase, p_sub: sub, p_projection: projection,
      p_expected_rev: S.state.rev, p_lock_unsubmitted: lock,
    });
    if (!r.ok && r.code === 'STALE') { toast('狀態已在其他裝置變更，已重新載入。', 'warn'); await S.sync.refresh(); return false; }
    if (!r.ok && r.code === 'UNSUBMITTED_GROUPS') {
      S.busy = false;
      const go = await confirmDialog({
        title: '仍有小組尚未提交',
        body: `第 ${r.groups.join('、')} 組尚未提交小組成果。`,
        buttons: [{ label: '繼續等待', value: false },
                  { label: '鎖定目前已儲存的成果並前往', value: true, primary: true }],
      });
      return go ? publish(phase, sub, projection, { lock: true }) : false;
    }
    if (!r.ok) { toast('操作失敗：' + r.code, 'error'); return false; }
    rememberProjection(phase, sub, projection);
    S.sync.ping('state');
    await S.sync.refresh();
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  } finally {
    S.busy = false;
  }
}

async function goPhase(phase) {
  if (!phase) return;
  const remembered = recallProjection(phase);
  const def = P.defaultProjection(phase, S.content);
  const { sub, projection } = remembered || def;
  await publish(phase, sub, projection);
}

async function setFlags(flags) {
  try {
    await rpc(client, 'teacher_set_flags', { p_session: S.session.id, ...flags });
    S.sync.ping('state'); S.sync.refresh();
  } catch (e) { toast(errorText(e), 'error'); }
}

// ======================================================================
// 畫面
// ======================================================================
// 只在相關資料改變時重畫各區塊，避免輪詢時打斷教師操作或讓 QR 閃爍
const keys = {};
function changed(name, value) {
  const k = JSON.stringify(value);
  if (keys[name] === k) return false;
  keys[name] = k;
  return true;
}

function renderAll(force = false) {
  if (force) for (const k of Object.keys(keys)) delete keys[k];
  const st = S.state;
  if (changed('head', [st.rev, S.session.status, S.session.join_open, S.sync?.status])) renderHead();
  if (changed('steps', [st.phase, S.session.status])) renderSteps();
  if (changed('panel', [st.rev, S.session.join_open, S.session.status, S.genrePreview,
    S.groups.map((g) => [g.status, g.board_rev]), S.people.length, onlineCount(S.people),
    S.personal.boards, S.personal.submitted])) renderPanel();
  if (changed('previews', [S.pub?.rev, S.genrePreview, st.phase])) renderPreviews();
  renderRoster();
}

function onlineCount(list) {
  const now = Date.now();
  return list.filter((p) => p.status === 'active' && now - new Date(p.last_seen_at).getTime() < ONLINE_MS).length;
}

function projectorLink() {
  const u = new URL('projector.html', location.href);
  u.hash = ''; u.search = '';
  u.searchParams.set('s', S.session.id);
  u.searchParams.set('k', S.session.projector_key);
  return u.toString();
}

function renderHead() {
  if (!S.els || !S.state) return;
  const st = S.sync?.status || {};
  const ph = phaseById(S.state.phase);
  const ended = S.session.status === 'ended';
  mount(S.els.head, h('header.topbar',
    h('a.btn', { href: '#' }, '← 場次'),
    h('strong', S.session.title),
    h('span.code', '代碼 ', h('b.mono', S.session.join_code)),
    h('span.pill', `目前：${ph?.id} ${ph?.name}`),
    ended ? h('span.pill.warn', '場次已結束') : null,
    h('span.spacer'),
    h('span.conn' + (st.online === false ? '.bad' : st.realtime ? '.good' : '.mid'),
      st.online === false ? '離線' : st.realtime ? '即時連線' : '輪詢同步'),
    h('label.toggle', h('input', { type: 'checkbox', checked: S.state.focus_mode,
      onchange: (e) => setFlags({ p_focus_mode: e.target.checked }) }), '學生專注模式'),
    h('label.toggle', h('input', { type: 'checkbox', checked: S.state.editing_paused,
      onchange: (e) => setFlags({ p_editing_paused: e.target.checked }) }), '暫停全班編輯'),
    h('a.btn.primary', { href: projectorLink(), target: 'sf-projector', rel: 'noopener' }, '開啟投影'),
    ended ? null : h('button.danger', { onclick: endSession }, '結束場次')));
}

async function endSession() {
  const ok = await confirmDialog({ title: '結束此場次？', body: '結束後學生無法再加入或修改，成果會保留。',
    buttons: [{ label: '取消', value: false }, { label: '結束場次', value: true, danger: true }] });
  if (!ok) return;
  try { await rpc(client, 'teacher_end_session', { p_session: S.session.id }); S.sync.ping('state'); S.sync.refresh(); }
  catch (e) { toast(errorText(e), 'error'); }
}

function renderSteps() {
  const cur = S.state.phase;
  mount(S.els.steps,
    PHASES.map((p) => h('button.step' + (p.id === cur ? '.current' : ''), {
      type: 'button', disabled: S.session.status === 'ended',
      onclick: async () => {
        if (p.id === cur) return;
        const ok = await confirmDialog({ title: `切換到 ${p.id}｜${p.name}？`,
          body: '投影端與學生端會同步切換。已儲存的成果不會被清除。' });
        if (ok) goPhase(p.id);
      },
    }, h('span.step-id', p.id), h('span.step-name', p.name), p.minutes ? h('span.step-min', p.minutes + "'") : null)),
    h('div.step-nav',
      h('button', { disabled: !prevPhase(cur), onclick: () => goPhase(prevPhase(cur)) }, '← 上一環節'),
      h('button.primary', { disabled: !nextPhase(cur), onclick: () => goPhase(nextPhase(cur)) }, '下一環節 →')));
}

function renderPreviews() {
  S.els.live.replaceChildren(renderProjection(S.pub, { showQr: false }));
  if (S.state.phase === '06' && S.genrePreview != null) {
    const g = S.genrePreview;
    const draft = P.genreProjection(S.content.genres, P.genreOps.reveal(S.content.genres, { ...ctl06(), index: g, view: 'genre' }));
    S.els.draft.replaceChildren(renderProjection({ ...S.pub, projection: draft }, { showQr: false }));
    mount(S.els.draftWrap, h('div.preview-label.draft', '○ 預覽（僅教師可見，尚未公開）'), S.els.draft);
  } else {
    S.els.draftWrap.replaceChildren();
  }
}

// ----------------------------------------------------------------------
// 各環節控制面板
// ----------------------------------------------------------------------
function renderPanel() {
  const ph = S.state.phase;
  const panel = PANELS[ph] || (() => h('p', '—'));
  const p = phaseById(ph);
  mount(S.els.panel, h('h2', `${p.id}｜${p.name}`, p.minutes ? h('small.muted', `　建議 ${p.minutes} 分鐘`) : null), panel());
}

const ctl01 = () => (S.pub?.projection?.screen === 'intro' && S.pub.projection.ctl) || P.introInitial();
const ctl06 = () => (S.pub?.projection?.screen === 'genre' && S.pub.projection.ctl) || P.genreInitial();

function intro(op) {
  const next = P.introOps[op](S.content.intro, ctl01());
  publish('01', P.introSub(next), P.introProjection(S.content.intro, next));
}
function genre(op, arg) {
  const next = P.genreOps[op](S.content.genres, ctl06(), arg);
  publish('06', P.genreSub(next), P.genreProjection(S.content.genres, next));
}

const PANELS = {
  '00': () => {
    const url = joinUrl(S.session.join_code);
    const qr = h('div.qr-box', '產生中…');
    qrDataUrl(url, 320).then((src) => qr.replaceChildren(src ? h('img', { src, alt: 'QR Code' }) : h('span.muted', 'QR 無法載入（請檢查網路），可改用網址加入')));
    const total = S.people.filter((p) => p.status === 'active').length;
    return h('div',
      h('div.row.top',
        qr,
        h('div',
          h('p', '學生加入網址：'), h('p.mono.small', url),
          h('div.row', h('button', { onclick: () => navigator.clipboard?.writeText(url).then(() => toast('已複製')) }, '複製網址')),
          h('p', `已加入：${total} 人（在線 ${onlineCount(S.people)} 人）`),
          h('label.toggle.big', h('input', { type: 'checkbox', checked: S.session.join_open,
            onchange: async (e) => { try { await rpc(client, 'teacher_update_session', { p_session: S.session.id, p_join_open: e.target.checked }); S.sync.ping('state'); S.sync.refresh(); } catch (er) { toast(errorText(er), 'error'); } } }),
            '開放新學生加入'))),
      h('div.row', h('button.primary.big', { onclick: () => goPhase('01') }, '啟動第一環節：走進故事世界 →')));
  },

  '01': () => {
    const c = ctl01();
    const stories = S.content.intro;
    const s = stories[c.index];
    return h('div',
      h('div.btn-grid',
        h('button', { onclick: () => intro('start') }, '開啟故事探索'),
        h('button', { onclick: () => intro('prevClue'), disabled: c.view !== 'story' || c.clues === 0 }, '← 上一個線索'),
        h('button.primary', { onclick: () => intro('nextClue'), disabled: c.view !== 'story' || !s || c.clues >= s.clues.length }, '下一個線索 →'),
        h('button.primary', { onclick: () => intro('reveal'), disabled: c.view !== 'story' || c.revealed }, '揭曉故事'),
        h('button', { onclick: () => intro('prevStory'), disabled: c.view !== 'story' || c.index === 0 }, '← 上一個故事'),
        h('button', { onclick: () => intro('nextStory'), disabled: c.view !== 'story' || c.index >= stories.length - 1 }, '下一個故事 →'),
        h('button', { onclick: () => intro('crossroads'), disabled: (c.seen || []).length === 0 }, '顯示故事交會畫面'),
        h('button.primary', { onclick: () => goPhase('02') }, '進入下一環節 →')),
      h('h3', '教師預覽（含未公開內容，不會投影）'),
      h('div.intro-preview', stories.map((st, i) => h('div.intro-story' + (i === c.index && c.view === 'story' ? '.current' : ''),
        h('div.intro-title', `故事 ${i + 1}：`, h('b', st.title),
          (c.seen || []).includes(i) ? h('span.tag.pub', '已揭曉') : h('span.tag', '未揭曉')),
        h('ol', st.clues.map((cl, j) => h('li',
          (i === c.index && c.view === 'story' && j < c.clues) || (c.seen || []).includes(i) ? h('span.tag.pub', '已公開') : h('span.tag', '未公開'),
          ` ${cl.label}：${cl.body}`)))))));
  },

  '02': () => {
    const active = S.people.filter((p) => p.status === 'active');
    const onScreenQr = S.pub?.projection?.screen === 'join';
    return h('div',
      h('p', `已連線：${onlineCount(S.people)} / ${active.length} 人`),
      h('div.ready-row', S.groups.map((g) => {
        const m = active.filter((p) => p.group_id === g.id);
        return h('div.ready-cell' + (m.length ? '.ok' : ''), h('b', g.name), h('span', `${onlineCount(m)}/${m.length} 在線`));
      })),
      h('div.btn-grid',
        onScreenQr
          ? h('button', { onclick: () => publish('02', '02', P.taskProjection()) }, '返回任務說明')
          : h('button', { onclick: () => publish('02', '02-qr', P.joinProjection()) }, '投影重新顯示 QR Code（補加入）'),
        h('button', { onclick: () => setFlags({ p_focus_mode: !S.state.focus_mode }) },
          S.state.focus_mode ? '關閉學生專注模式' : '開啟學生專注模式'),
        h('button.primary', { onclick: () => goPhase('03') }, '開放第三環節：我的故事分類 →')),
      h('p.muted', '提醒：網頁無法遠端強制學生裝置全螢幕；學生按「進入探索模式」時會在支援的瀏覽器請求全螢幕，不支援時自動使用網站專注模式。'));
  },

  '03': () => {
    const active = S.people.filter((p) => p.status === 'active');
    return h('div',
      h('p', `個人分類：已開始 ${S.personal.boards} 人、已提交 ${S.personal.submitted} 人 / 共 ${active.length} 人`),
      h('p.muted', '進入第四環節時，系統會為每位學生建立唯讀快照（未完成者也保留已儲存部分，並標示未完成）。'),
      h('p.muted', '（學生個人分類操作畫面將於 Phase 2 完成。）'),
      h('button.primary', { onclick: () => goPhase('04') }, '進入第四環節：小組共作 →'));
  },

  '04': () => h('div',
    h('table.tbl', h('thead', h('tr', h('th', '組別'), h('th', '狀態'), h('th', '版本'), h('th', ''))),
      h('tbody', S.groups.map((g) => h('tr',
        h('td', g.name),
        h('td', { open: '編輯中', submitted: '已提交', locked: '已鎖定' }[g.status]),
        h('td.mono', g.board_rev),
        h('td', g.status !== 'open' ? h('button', { onclick: async () => {
          try { await rpc(client, 'teacher_unlock_group', { p_group: g.id }); toast(`${g.name} 已重新開放`); S.sync.refresh(); }
          catch (e) { toast(errorText(e), 'error'); } } }, '單組解鎖') : null))))),
    h('p.muted', '（小組共同編輯畫面與單組檢視將於 Phase 3 完成；資料庫端的同步、衝突保護與提交已完成並通過 tests/db 測試。）'),
    h('button.primary', { onclick: () => goPhase('05') }, '結束共同分類，進入成果公開 →')),

  '05': () => h('div', h('p.muted', '雙組並排比較、故事追蹤與理由揭露將於 Phase 4 完成。'),
    h('button.primary', { onclick: () => goPhase('06') }, '進入第六環節 →')),

  '06': () => {
    const c = ctl06();
    const gs = S.content.genres;
    const pv = S.genrePreview;
    return h('div',
      h('div.btn-grid',
        h('button', { onclick: () => genre('recap') }, '06-01 分類背後的祕密'),
        h('button', { onclick: () => genre('overview') }, '06-03 顯示五種類型總覽'),
        h('button.primary', { onclick: () => goPhase('07') }, '進入第七環節 →')),
      h('h3', '選擇小說類型（點選＝私下預覽，不會投影）'),
      h('div.genre-pick', gs.map((g, i) => h('button.genre-btn' + (pv === i ? '.sel' : '') + ((c.revealed || []).includes(i) ? '.pub' : ''),
        { onclick: () => { S.genrePreview = i; renderAll(); } },
        `${i + 1}. ${g.name}`, (c.revealed || []).includes(i) ? ' ✓' : ''))),
      pv != null ? h('div.genre-detail',
        h('div', h('b', gs[pv].name), '：', gs[pv].elements.map((e) => e.label).join('、')),
        gs[pv].teacher_notes ? h('p.muted', '教師補充：' + gs[pv].teacher_notes) : null,
        h('div.row',
          h('button', { onclick: () => genre('goto', pv) }, '投影「即將揭開」畫面'),
          h('button.primary', { onclick: () => { const n = P.genreOps.reveal(gs, P.genreOps.goto(gs, c, pv)); publish('06', P.genreSub(n), P.genreProjection(gs, n)); } }, '揭開小說世界'))) : null);
  },

  '07': () => h('div', h('p.muted', '原始分類與小說類型要素對照、句型鷹架將於 Phase 4 完成。'),
    h('button.primary', { onclick: () => goPhase('99') }, '顯示結束畫面 →')),

  '99': () => h('div', h('p', '投影顯示結束畫面。'),
    S.session.status === 'ended' ? h('p.muted', '場次已結束。') : h('button.danger', { onclick: endSession }, '結束場次（學生不能再修改）')),
};

// ----------------------------------------------------------------------
// 連線管理（各組人數、在線狀態、調整組別）
// ----------------------------------------------------------------------
let rosterKey = '';
function renderRoster() {
  const key = JSON.stringify([S.groups.map((g) => [g.id, g.capacity, g.name]), S.people.map((p) => [p.id, p.group_id, p.status, Math.floor((Date.now() - new Date(p.last_seen_at)) / ONLINE_MS)]),
    S.personal.snapshots, S.personal.submitted]);
  if (key === rosterKey || S.els.roster.contains(document.activeElement)) return;
  rosterKey = key;
  const now = Date.now();
  mount(S.els.roster, h('h2', '連線管理'),
    h('div.roster', S.groups.map((g) => {
      const members = S.people.filter((p) => p.group_id === g.id && p.status === 'active');
      return h('div.roster-group',
        h('div.roster-head', h('b', g.name), h('span', `${onlineCount(members)}/${members.length} 在線`),
          h('label.small', '上限 ', h('input.cap', { type: 'number', min: 0, max: 40, value: g.capacity ?? '', placeholder: '不限',
            onchange: async (e) => { try { await rpc(client, 'teacher_set_group', { p_session: S.session.id, p_number: g.number, p_capacity: Number(e.target.value) || 0 }); S.sync.refresh(); } catch (er) { toast(errorText(er), 'error'); } } }))),
        members.length === 0 ? h('p.muted.small', '尚無學生') :
        h('ul.members', members.map((p) => h('li',
          h('span.dot' + (now - new Date(p.last_seen_at) < ONLINE_MS ? '.on' : '')),
          h('span.seat', p.seat_label),
          S.personal.submittedSet?.has(p.id) ? h('span.tag.pub', '個人已提交') : null,
          S.personal.incomplete?.has(p.id) ? h('span.tag.warn', '個人未完成') : null,
          h('select.small', { onchange: async (e) => {
            try { await rpc(client, 'teacher_move_participant', { p_participant: p.id, p_group_number: Number(e.target.value) }); S.sync.ping('roster'); S.sync.refresh(); } catch (er) { toast(errorText(er), 'error'); }
          } }, S.groups.map((x) => h('option', { value: x.number, selected: x.id === g.id }, '移到' + x.name))),
          h('button.small', { onclick: async () => {
            if (!await confirmDialog({ title: `移出 ${p.seat_label}？`, body: '該裝置的資料會保留；學生可在開放加入時重新選組。' })) return;
            try { await rpc(client, 'teacher_remove_participant', { p_participant: p.id }); S.sync.refresh(); } catch (er) { toast(errorText(er), 'error'); }
          } }, '移出')))));
    })));
}

boot();
