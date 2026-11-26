// 學生全螢幕狀態：學生端回報（順序、重試、合併）與教師端顯示、退出提醒
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFsReporter } from '../../js/student/fs-report.js';
import { fsStatus, createExitWatcher, exitMessage } from '../../js/lib/fs-status.js';

// 模擬伺服器：只接受更大的序號
function fakeServer() {
  const s = { seq: null, state: null, calls: [], fail: 0, hold: null };
  s.send = async (state, seq) => {
    s.calls.push([state, seq]);
    if (s.hold) await s.hold;
    if (s.fail > 0) { s.fail--; throw Object.assign(new Error('net'), { code: 'NETWORK' }); }
    if (s.seq != null && seq <= s.seq) return { accepted: false, reason: 'STALE', state: s.state, seq: s.seq };
    s.seq = seq; s.state = state; return { accepted: true, state, seq };
  };
  return s;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function harness(srv, state = { v: 'on' }, t0 = 1000) {
  let clock = t0; let stored = 0; const timers = [];
  const rep = createFsReporter({ send: srv.send, getState: () => state.v, loadSeq: () => stored, saveSeq: (v) => { stored = v; },
    now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  return { rep, timers, advance: (ms) => { clock += ms; }, get stored() { return stored; }, set stored(v) { stored = v; } };
}

test('序號遞增：同一毫秒內多次回報仍遞增；重新整理（新的回報器）後接續本機序號', async () => {
  const srv = fakeServer(); const H = harness(srv);
  H.rep.report('on'); await tick(); H.rep.report('off'); await tick(); H.rep.report('on'); await tick();
  const seqs = srv.calls.map((c) => c[1]);
  assert.deepEqual(seqs, [1000, 1001, 1002]);
  assert.equal(srv.state, 'on');
});

test('送出中又改變：只再送最新的狀態（不送中間的舊狀態）', async () => {
  const srv = fakeServer(); let release; srv.hold = new Promise((r) => { release = r; });
  const st = { v: 'on' }; const H = harness(srv, st);
  H.rep.report('on'); H.rep.report('off'); H.rep.report('on'); H.rep.report('off');
  srv.hold = null; release(); await tick(); await tick(); await tick();
  assert.deepEqual(srv.calls.map((c) => c[0]), ['on', 'off']);
  assert.equal(srv.state, 'off');
});

test('網路失敗：以 1、2、4 秒退避重試，最後送出最新狀態', async () => {
  const srv = fakeServer(); srv.fail = 3; const H = harness(srv);
  H.rep.report('off'); await tick();
  for (let i = 0; i < 3; i++) { const t = H.timers.shift(); assert.equal(t.ms, [1000, 2000, 4000][i]); t.fn(); await tick(); }
  assert.equal(srv.state, 'off'); assert.equal(H.rep.pending, false);
});

test('本機序號遺失（伺服器序號較大）：採用伺服器序號重新回報目前狀態', async () => {
  const srv = fakeServer(); srv.seq = 5000; srv.state = 'on';
  const st = { v: 'off' }; const H = harness(srv, st, 1000);
  H.rep.report('off'); await tick(); await tick();
  assert.equal(srv.state, 'off'); assert.equal(srv.seq, 5001);
});

test('重新連線：以目前狀態與新的序號重新回報；停止後不再送出', async () => {
  const srv = fakeServer(); const st = { v: 'on' }; const H = harness(srv, st);
  H.rep.report(); await tick();
  st.v = 'off'; H.advance(10); H.rep.resync(); await tick();
  assert.equal(srv.state, 'off');
  H.rep.stop(); H.rep.report('on'); await tick();
  assert.equal(srv.state, 'off');
});

test('教師端顯示：顏色與文字；離線改為待確認；未回報、不支援、未允許', () => {
  assert.deepEqual(fsStatus({ fs_state: 'active' }, true), { key: 'active', text: '全螢幕中', cls: 'fs-on' });
  assert.equal(fsStatus({ fs_state: 'exited' }, true).text, '已退出全螢幕');
  assert.equal(fsStatus({ fs_state: 'exited' }, true).cls, 'fs-off');
  assert.equal(fsStatus({ fs_state: 'none' }, true).text, '尚未進入全螢幕');
  assert.equal(fsStatus({ fs_state: 'denied' }, true).text, '尚未進入全螢幕（瀏覽器未允許）');
  assert.equal(fsStatus({ fs_state: 'unsupported' }, true).text, '裝置不支援全螢幕');
  assert.equal(fsStatus({ fs_state: 'active' }, false).text, '連線中斷／狀態待確認');
  assert.equal(fsStatus({ fs_state: null }, true).text, '狀態待確認（尚未回報）');
  assert.equal(fsStatus({}, true).key, 'unknown');
  assert.equal(fsStatus({ fs_state: 'stale' }, true).key, 'unknown');
});

test('退出提醒：第一次讀取不提醒歷史；次數增加才提醒一次；重讀不重複；移出再回來不誤判', () => {
  const w = createExitWatcher(); const g = () => '第 3 組';
  const p = (id, n, st = 'exited', seat = 12) => ({ id, status: 'active', fs_exits: n, fs_state: st, seat_no: seat });
  assert.deepEqual(w([p('a', 2), p('b', 0, 'active', 5)], g), []);               // 教師端開啟時已有退出紀錄：不提醒
  assert.deepEqual(w([p('a', 2), p('b', 0, 'active', 5)], g), []);               // 輪詢：不變
  assert.deepEqual(w([p('a', 3), p('b', 0, 'active', 5)], g).map((x) => x.label), ['第 3 組・12 號']);
  assert.deepEqual(w([p('a', 3), p('b', 0, 'active', 5)], g), []);               // 重讀：不重複
  assert.deepEqual(w([p('b', 0, 'active', 5)], g), []);                         // a 暫時不見
  assert.deepEqual(w([p('a', 3), p('b', 0, 'active', 5)], g), []);               // 回來：不是新事件
  assert.deepEqual(w([p('a', 3), p('b', 1, 'active', 5), p('c', 0, 'none', 7)], g).map((x) => [x.label, x.back]), [['第 3 組・5 號', true]]);
});

test('提醒文字：單一學生、多位彙整、超過四位', () => {
  const L = (s, back = false) => ({ label: `第 1 組・${s} 號`, back });
  assert.equal(exitMessage([L(12)]), '第 1 組・12 號退出全螢幕');
  assert.equal(exitMessage([L(5), L(7, true)]), '2 位學生退出全螢幕：第 1 組・5 號、第 1 組・7 號（已返回）');
  assert.match(exitMessage([1, 2, 3, 4, 5].map((n) => L(n))), /^5 位學生退出全螢幕：.*4 號 等$/);
  assert.equal(exitMessage([]), '');
});
