// Phase 4：05／07 教師端選擇與快照清單（純函式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../js/lib/results-model.js';
import * as P from '../../js/lib/projection.js';

const cards = 'ABCD'.split('').map((x) => ({ id: 'k' + x, title: '故事 ' + x }));

test('快照排序穩定：最新在前，時間相同以 id 排序；較新快照提示', () => {
  const list = [
    { id: 'a', group_id: 'g1', kind: 'submitted', created_at: '2026-11-12T01:00:00Z' },
    { id: 'c', group_id: 'g1', kind: 'locked', created_at: '2026-11-12T02:00:00Z' },
    { id: 'b', group_id: 'g1', kind: 'submitted', created_at: '2026-11-12T02:00:00Z' },
    { id: 'z', group_id: 'g2', kind: 'locked', created_at: '2026-11-12T03:00:00Z' },
  ];
  assert.deepEqual(R.snapshotsOf(list, 'g1').map((s) => s.id), ['c', 'b', 'a']);
  assert.equal(R.latestSnapshot(list, 'g1').id, 'c');
  assert.equal(R.latestSnapshot(list, 'g3'), null);
  assert.equal(R.newerSnapshot(list, 'a').id, 'c', '綁定舊快照時提示有新版本');
  assert.equal(R.newerSnapshot(list, 'c'), null);
  assert.equal(R.kindLabel('submitted'), '小組正式提交');
  assert.match(R.kindLabel('locked'), /未正式提交/);
});

test('快照正規化：相容 Phase 1／2 與 Phase 3 格式，只留有故事的分類', () => {
  const p3 = { categories: [{ id: 'x', order: 2, label_no: 5, name: '第二', reason: 'r2', cards: ['kB'] }, { id: 'y', order: 1, label_no: 3, name: '第一', reason: '', cards: ['kA'] }],
               placements: [{ card_id: 'kA', category_id: 'y' }, { card_id: 'kB', category_id: 'x' }, { card_id: 'kC', category_id: null }] };
  assert.deepEqual(R.normalizeSnapshot(p3, cards).map((c) => [c.id, c.cards]), [['y', ['kA']], ['x', ['kB']]]);
  const p1 = { categories: [{ id: 'o', label_no: 2, name: '舊', reason: 'old', name_rev: 1 }, { id: 'e', label_no: 1, name: '', reason: '' }],
               placements: [{ card_id: 'kD', category_id: 'o', rev: 1 }, { card_id: 'kA', category_id: 'o', rev: 2 }] };
  const n1 = R.normalizeSnapshot(p1, cards);
  assert.equal(n1.length, 1, '空分類不列出');
  assert.deepEqual(n1[0].cards, ['kA', 'kD'], '故事依素材順序');
  const b = R.snapshotToBoard(p1, cards);
  assert.deepEqual(b.placements, { kA: 'o', kD: 'o' });
  assert.equal(R.normalizeSnapshot(null, cards).length, 0, '沒有資料不會出錯');
});

test('05：換一側的快照會重設該側的揭露、頁數、聚焦；比較是否有未公開變更', () => {
  let c = R.emptyCompare();
  c = R.setSide(c, 'left', 's1');
  c = R.toggleReason(c, 'left', 'cat1');
  c = { ...c, page: { left: 1, right: 0 }, focus: { left: 'cat1', right: null } };
  const pub = R.canonCompare(c);
  assert.ok(R.sameCompare(c, pub));
  assert.ok(R.sameCompare({ ...c, reasons: { left: ['b', 'a'], right: [] } }, { ...c, reasons: { left: ['a', 'b'], right: [] } }), '揭露順序不影響');
  const c2 = R.setSide(c, 'left', 's2');
  assert.deepEqual([c2.reasons.left, c2.page.left, c2.focus.left], [[], 0, null]);
  assert.ok(!R.sameCompare(c2, pub));
  assert.deepEqual(R.toggleReason(R.toggleReason(c, 'left', 'z'), 'left', 'z').reasons.left, ['cat1']);
});

test('07：更換類型清除要素揭露與相似標示；收回要素一併取消標示；不能標示未揭露的要素', () => {
  let m = R.setGenre(R.emptyMatch(), 1);
  m = R.toggleElement(m, 0);
  m = R.toggleElement(m, 2);
  m = R.toggleHighlight(m, 2);
  assert.deepEqual([m.elements, m.highlights], [[0, 2], [2]]);
  assert.deepEqual(R.toggleHighlight(m, 1).highlights, [2], '未揭露的要素不能標示');
  assert.deepEqual(R.toggleElement(m, 2).highlights, [], '收回要素時取消其標示');
  const m2 = R.setGenre(m, 3);
  assert.deepEqual([m2.genre, m2.elements, m2.highlights], [3, [], []], '換類型不殘留上一種的標示');
  assert.deepEqual(R.setGenre(m, 1).elements, [0, 2], '選同一類型不重設');
  const m3 = R.setSnapshot({ ...m, category: 'c1', show_reason: true }, 's9');
  assert.deepEqual([m3.snapshot, m3.category, m3.show_reason], ['s9', null, false], '換快照時清除分類（分類必須屬於新快照）');
  assert.equal(R.setGenre(m, null).genre, null, '允許不選類型');
});

test('05／07 未公開時的投影只有等待畫面，不含任何成果欄位', () => {
  const p5 = P.defaultProjection('05', {}).projection;
  const p7 = P.defaultProjection('07', {}).projection;
  assert.equal(p5.screen, 'placeholder');
  assert.equal(p7.screen, 'placeholder');
  for (const p of [p5, p7]) assert.deepEqual(Object.keys(p).sort(), ['screen', 'sub', 'title']);
});
