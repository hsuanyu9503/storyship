// 分類工作區資料模型（個人分類與 Phase 3 小組共用）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../js/lib/board-model.js';

const cards = 'ABCDEFGH'.split('').map((x) => ({ id: 'card-' + x, title: '故事 ' + x }));

test('新增分類：暫時名稱「分類 N」，名稱欄位保持空白，數量不限於五組', () => {
  let d = M.emptyBoard();
  for (let i = 0; i < 7; i++) d = M.addCategory(d).data;
  assert.equal(d.categories.length, 7);
  assert.deepEqual(d.categories.map((c) => c.no), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(d.categories.every((c) => c.name === ''));
  assert.equal(M.displayName(d.categories[1]), '分類 2');
  assert.equal(new Set(d.categories.map((c) => c.id)).size, 7, 'id 不重複');
  for (const c of d.categories) assert.match(c.id, /^[A-Za-z0-9_-]{1,40}$/, '符合伺服器格式');
});

test('刪除後再新增，暫時編號不重複', () => {
  let d = M.addCategory(M.addCategory(M.emptyBoard()).data).data;
  d = M.deleteCategory(d, d.categories[0].id);
  d = M.addCategory(d).data;
  assert.deepEqual(d.categories.map((c) => c.no), [2, 3]);
});

test('移動故事：一張卡只有一個歸屬，可在分類間移動、移回未分類', () => {
  let r = M.addCategory(M.emptyBoard()); const a = r.id;
  r = M.addCategory(r.data); const b = r.id;
  let d = r.data;
  d = M.moveCard(d, 'card-A', a);
  d = M.moveCard(d, 'card-B', a);
  assert.equal(M.placedCount(d, cards), 2);
  d = M.moveCard(d, 'card-A', b);
  assert.deepEqual(M.cardsIn(d, cards, a).map((c) => c.id), ['card-B']);
  assert.deepEqual(M.cardsIn(d, cards, b).map((c) => c.id), ['card-A']);
  assert.equal(M.placedCount(d, cards), 2, '移動不改變已分類數量');
  d = M.moveCard(d, 'card-A', null);
  assert.equal(M.placedCount(d, cards), 1);
  assert.ok(M.unplacedCards(d, cards).some((c) => c.id === 'card-A'));
  assert.equal(M.moveCard(d, 'card-C', 'no-such-cat'), d, '移到不存在的分類被忽略');
});

test('刪除分類：其中的故事回到未分類，其他分類不受影響', () => {
  let r = M.addCategory(M.emptyBoard()); const a = r.id;
  r = M.addCategory(r.data); const b = r.id;
  let d = M.moveCard(M.moveCard(M.moveCard(r.data, 'card-A', a), 'card-B', a), 'card-C', b);
  d = M.deleteCategory(d, a);
  assert.equal(d.categories.length, 1);
  assert.equal(M.placedCount(d, cards), 1);
  assert.deepEqual(M.cardsIn(d, cards, b).map((c) => c.id), ['card-C']);
  assert.equal(M.unplacedCards(d, cards).length, 7);
});

test('提交檢查：未分類張數、未命名分類（「分類 N」不算命名）、空分類不擋提交', () => {
  let r = M.addCategory(M.emptyBoard()); const a = r.id;
  r = M.addCategory(r.data); const b = r.id;
  r = M.addCategory(r.data);           // 空分類
  let d = r.data;
  for (const c of cards.slice(0, 6)) d = M.moveCard(d, c.id, a);
  let p = M.problems(d, cards);
  assert.equal(p.unplaced, 2);
  assert.deepEqual(M.problemMessages(p), ['還有 2 張故事尚未分類。', '請為分類 1 取一個名稱。']);
  for (const c of cards.slice(6)) d = M.moveCard(d, c.id, b);
  d = M.renameCategory(d, a, '會魔法');
  d = M.renameCategory(d, b, '分類 2');
  p = M.problems(d, cards);
  assert.deepEqual(M.problemMessages(p), ['請為分類 2 取一個名稱。'], '原樣保留暫時名稱不算命名');
  d = M.renameCategory(d, b, '  尋找寶物 ');
  p = M.problems(d, cards);
  assert.ok(p.complete, '空分類不影響完成');
  assert.equal(M.stripEmpty(d, cards).categories.length, 2, '提交時排除空分類');
});

test('名稱長度上限 30 字（繁體中文）', () => {
  const r = M.addCategory(M.emptyBoard());
  const d = M.renameCategory(r.data, r.id, '很'.repeat(40));
  assert.equal(d.categories[0].name.length, M.MAX_NAME);
});

test('normalize：去除不存在的故事與分類、重複 id', () => {
  const d = M.normalize({ categories: [{ id: 'c1', no: 1, name: 'x' }, { id: 'c1', no: 2 }],
    placements: { 'card-A': 'c1', 'card-Z': 'c1', 'card-B': 'gone' } }, cards);
  assert.equal(d.categories.length, 1);
  assert.deepEqual(d.placements, { 'card-A': 'c1' });
  assert.deepEqual(M.normalize(null, cards), M.emptyBoard());
});

test('sameBoard：忽略歸屬順序與名稱前後空白', () => {
  const a = { categories: [{ id: 'c1', no: 1, name: '冒險 ' }], placements: { x: 'c1', y: 'c1' } };
  const b = { categories: [{ id: 'c1', no: 1, name: '冒險' }], placements: { y: 'c1', x: 'c1' } };
  assert.ok(M.sameBoard(a, b));
  assert.ok(!M.sameBoard(a, { ...b, placements: { x: 'c1' } }));
});

test('所有操作都不修改原本的資料（避免畫面與待儲存資料互相影響）', () => {
  const r = M.addCategory(M.emptyBoard());
  const before = JSON.stringify(r.data);
  M.moveCard(r.data, 'card-A', r.id);
  M.renameCategory(r.data, r.id, 'x');
  M.deleteCategory(r.data, r.id);
  assert.equal(JSON.stringify(r.data), before);
});

test('小組：共同特色（理由）— 有效分類缺少理由時不能提交，並指出分類', () => {
  let r = M.addCategory(M.emptyBoard(), () => '11111111-1111-4111-8111-111111111111'); const a = r.id;
  r = M.addCategory(r.data, () => '22222222-2222-4222-8222-222222222222'); const b = r.id;
  r = M.addCategory(r.data, () => '33333333-3333-4333-8333-333333333333');   // 空分類
  let d = r.data;
  assert.equal(a, '11111111-1111-4111-8111-111111111111', '可注入 UUID 產生器（小組分類 id）');
  for (const c of cards.slice(0, 4)) d = M.moveCard(d, c.id, a);
  for (const c of cards.slice(4)) d = M.moveCard(d, c.id, b);
  d = M.renameCategory(M.renameCategory(d, a, '會魔法'), b, '找答案');
  let p = M.problems(d, cards, { requireReason: true });
  assert.deepEqual(M.problemMessages(p), ['請寫下「會魔法」的共同特色。', '請寫下「找答案」的共同特色。']);
  assert.ok(M.problems(d, cards).complete, '個人分類不檢查理由');
  d = M.setReason(M.setReason(d, a, '都有魔法'), b, '  ');
  p = M.problems(d, cards, { requireReason: true });
  assert.deepEqual(M.problemMessages(p), ['請寫下「找答案」的共同特色。'], '只有空白不算填寫');
  d = M.setReason(d, b, '主角都在找答案');
  assert.ok(M.problems(d, cards, { requireReason: true }).complete, '空分類不需要理由');
  assert.equal(M.setReason(d, a, '字'.repeat(200)).categories[0].reason.length, M.MAX_REASON);
});

test('小組：normalize 保留理由；sameBoard 會比較理由', () => {
  const d = M.normalize({ categories: [{ id: 'x', no: 1, name: 'n', reason: '原因' }], placements: {} }, cards);
  assert.equal(d.categories[0].reason, '原因');
  assert.ok(!M.sameBoard(d, M.setReason(d, 'x', '別的原因')));
});
