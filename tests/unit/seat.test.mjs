// 學生座號：輸入檢查與教師端顯示（js/lib/seat.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeat, seatText, bySeat } from '../../js/lib/seat.js';

test('座號輸入：正整數 1～999，接受全形數字與前後空白', () => {
  assert.deepEqual(parseSeat('5'), { value: 5 });
  assert.deepEqual(parseSeat(' 12 '), { value: 12 });
  assert.deepEqual(parseSeat('０５'), { value: 5 });
  assert.deepEqual(parseSeat('999'), { value: 999 });
  assert.equal(parseSeat('').error, '請先輸入座號。');
  assert.equal(parseSeat('   ').error, '請先輸入座號。');
  assert.equal(parseSeat(null).error, '請先輸入座號。');
  for (const bad of ['3a', '-3', '5.', '1e2', '五', '+4']) assert.equal(parseSeat(bad).error, '座號只能填數字，例如 5。', bad);
  for (const bad of ['0', '00', '1000']) assert.equal(parseSeat(bad).error, '座號請輸入 1～999 的整數，例如 5。', bad);
});

test('教師端顯示：有座號顯示「N 號」；舊資料沒有座號時顯示可辨識的說明，不會出現空白或 undefined', () => {
  assert.equal(seatText({ seat_no: 5, seat_label: '2 號' }), '5 號');
  assert.equal(seatText({ seat_no: '12' }), '12 號');
  assert.equal(seatText({ seat_no: null, seat_label: '3 號' }), '未填座號（組內第 3 位）');
  assert.equal(seatText({ seat_label: '1 號' }), '未填座號（組內第 1 位）');
  assert.equal(seatText({ seat_no: null, seat_label: null }), '未填座號');
  assert.equal(seatText({}), '未填座號');
  assert.equal(seatText(undefined), '未填座號');
  for (const p of [{}, { seat_no: 0 }, { seat_no: 'x' }, { seat_label: '' }]) assert.doesNotMatch(seatText(p), /undefined|null|NaN/);
});

test('成員排序：依座號，沒有座號的排在後面（依加入時間）', () => {
  const list = [{ seat_no: 12, joined_at: '1' }, { seat_no: null, joined_at: '2' }, { seat_no: 5, joined_at: '3' }, { seat_no: null, joined_at: '0' }];
  assert.deepEqual(list.slice().sort(bySeat).map((p) => `${p.seat_no}:${p.joined_at}`), ['5:3', '12:1', 'null:0', 'null:2']);
});
