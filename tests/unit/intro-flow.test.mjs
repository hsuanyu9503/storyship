// 第 01 環節：一步一步的前進／後退、揭曉時機、文案（純函式；畫面與真實流程見 tests/e2e/intro_flow.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../js/lib/projection.js';

const SRC = JSON.parse(readFileSync(new URL('../../docs/intro-source.json', import.meta.url), 'utf8'));
const stories = SRC.stories.map((s, i) => ({ title: s.title, reveal_text: s.reveal_text, name_before: s.name_before, name_after: s.name_after,
  image_url: i ? 'assets/intro/chihiro-1600.webp' : 'assets/intro/conan-1600.webp', image_alt: `《${s.title}》揭曉圖`,
  clues: s.clues.map((c) => ({ kind: 'other', label: c.label, body: c.body })) }));
const text = { opening: SRC.opening, compare_title: SRC.compare_title, compare_prompts: SRC.compare_prompts, naming_prompt: SRC.naming_prompt,
  bridge_title: SRC.bridge_title, bridge_text: SRC.bridge_text };
const key = (s) => JSON.stringify([s.view, s.index, s.clues, s.revealed, s.step || 0, s.seen]);
function walk() {
  const seq = [P.introInitial()];
  for (let s = seq[0]; (s = P.introNext(stories, s, text));) seq.push(s);
  return seq;
}

test('完整流程：開場 → 故事一三條線索 → 公布 → 故事二三條線索 → 公布 → 比較 → 命名 → 轉場（每次一步）', () => {
  const seq = walk();
  const desc = seq.map((s) => s.view === 'story' ? `${s.index}:${s.clues}${s.revealed ? 'R' : ''}` : s.view + (s.view === 'compare' ? s.step : ''));
  assert.deepEqual(desc, ['open', '0:0', '0:1', '0:2', '0:3', '0:3R', '1:0', '1:1', '1:2', '1:3', '1:3R', 'compare0', 'compare1', 'bridge']);
  const labels = seq.map((s) => P.introNextLabel(stories, s, text));
  assert.deepEqual(labels, ['開始：神祕故事一', '顯示下一條線索', '顯示下一條線索', '顯示下一條線索', '公布作品', '進入神祕故事二',
    '顯示下一條線索', '顯示下一條線索', '顯示下一條線索', '公布作品', '兩個故事放在一起', '下一個提問', '接下來，換你分類', null]);
  assert.deepEqual(seq.map(P.introSub), ['01-01', '01-02', '01-02', '01-02', '01-02', '01-03', '01-02', '01-02', '01-02', '01-02', '01-03', '01-04', '01-04', '01-05']);
});

test('上一步剛好撤銷下一步（每一個狀態都成立）；開場沒有上一步、轉場沒有下一步', () => {
  const seq = walk();
  for (let i = 1; i < seq.length; i++) assert.equal(key(P.introBack(stories, seq[i], text)), key(seq[i - 1]), `第 ${i} 步`);
  assert.equal(P.introBack(stories, seq[0], text), null);
  assert.equal(P.introNext(stories, seq[seq.length - 1], text), null);
});

test('揭曉前的投影不含作品名稱、名字、圖片與替代文字；公布後才有，且兩則配對正確', () => {
  const leak = [/柯南|工藤|新一|conan/, /神隱|千尋|荻野|小千|chihiro/];
  for (const s of walk()) {
    const pj = P.introProjection(stories, s, text);
    const str = JSON.stringify(pj);
    for (let k = 0; k < 2; k++) {
      const shown = (s.seen || []).includes(k);
      if (!shown) assert.ok(!leak[k].test(str), `${P.introSub(s)} ${s.index}:${s.clues}：第 ${k + 1} 則未公布卻出現答案`);
    }
    if (s.view === 'story') {
      assert.equal(pj.story.neutral, ['神祕故事一', '神祕故事二'][s.index]);
      assert.equal(pj.story.clues.length, s.clues);
      assert.equal(pj.story.clue_total, 3);
      if (s.revealed) {
        assert.equal(pj.story.title, SRC.stories[s.index].title);
        assert.equal(`${pj.story.name_before} → ${pj.story.name_after}`, `${SRC.stories[s.index].name_before} → ${SRC.stories[s.index].name_after}`);
        assert.equal(pj.story.image_url, s.index ? 'assets/intro/chihiro-1600.webp' : 'assets/intro/conan-1600.webp');
        assert.ok(pj.story.image_alt.includes(SRC.stories[s.index].title));
      } else {
        for (const k of ['title', 'name_before', 'name_after', 'image_url', 'image_alt', 'reveal_text']) assert.equal(pj.story[k], undefined, k);
      }
    }
  }
});

test('從揭曉返回：圖片與答案一起收起；跨故事返回時前一則恢復為已公布', () => {
  const seq = walk();
  const revealed1 = seq[5]; const back1 = P.introBack(stories, revealed1, text);
  assert.equal(P.introProjection(stories, back1, text).story.title, undefined);
  assert.deepEqual(back1.seen, []);
  const s2start = seq[6]; const back2 = P.introBack(stories, s2start, text);
  const pj = P.introProjection(stories, back2, text);
  assert.equal(pj.story.title, '名偵探柯南'); assert.equal(pj.story.name_after, '江戶川柯南');
});

test('文案與原稿相同；比較畫面先一個提問、下一步才加上命名提問；轉場文字', () => {
  const seq = walk();
  const open = P.introProjection(stories, seq[0], text);
  assert.equal(open.title, '走進故事世界'); assert.equal(open.opening, SRC.opening);
  const c0 = P.introProjection(stories, seq[11], text); const c1 = P.introProjection(stories, seq[12], text);
  assert.deepEqual(c0.prompts, SRC.compare_prompts);
  assert.deepEqual(c1.prompts, [...SRC.compare_prompts, SRC.naming_prompt]);
  assert.deepEqual(c1.stories.map((s) => `《${s.title}》　${s.name_before} → ${s.name_after}`), SRC.compare_lines);
  const br = P.introProjection(stories, seq[13], text);
  assert.equal(br.title, SRC.bridge_title); assert.equal(br.text, SRC.bridge_text);
  // 線索文字逐字相同
  const st = P.introProjection(stories, seq[9], text).story;
  assert.deepEqual(st.clues.map((c) => [c.no, c.label, c.body]), SRC.stories[1].clues.map((c) => [c.no, c.label, c.body]));
});

test('舊資料（沒有 intro_text、沒有名字欄位）：預設開場語與比較提問，沒有命名步驟；仍可走完', () => {
  const old = [{ title: 'A', reveal_text: 'x', clues: [{ label: 'l', body: 'b' }] }, { title: 'B', reveal_text: 'y', clues: [{ label: 'l2', body: 'b2' }] }];
  let s = P.introInitial(); const views = [];
  while (s) { views.push(s.view + (s.view === 'compare' ? s.step : '')); s = P.introNext(old, s, null); }
  assert.deepEqual(views, ['open', 'story', 'story', 'story', 'story', 'story', 'story', 'compare0', 'bridge']);
  assert.equal(P.introProjection(old, P.introInitial(), null).opening, null);
  const c = P.introProjection(old, { view: 'compare', seen: [0, 1], step: 0 }, null);
  assert.deepEqual(c.prompts, ['這些故事有什麼共同的特色？']);
  assert.equal(c.stories[0].name_before, undefined);
});

// ---------- 複查 P1：舊場次（舊版允許只公布第一則就進入「交會」）按上一步不得提前公布 ----------
const S2 = SRC.stories[1];
const leak2 = (pj) => {
  const str = JSON.stringify(pj);
  return [S2.title, S2.name_before, S2.name_after, S2.reveal_text, 'chihiro', '《神隱少女》揭曉圖'].filter((w) => str.includes(w));
};
test('P1：{view: crossroads, seen: [0]} 返回 → 柯南的揭曉頁；第二則仍未公布，投影資料沒有第二部的任何答案', () => {
  const legacy = { view: 'crossroads', index: 1, clues: 0, revealed: false, seen: [0], step: 0 };
  const b = P.introBack(stories, legacy, text);
  assert.equal(b.view, 'story'); assert.equal(b.index, 0); assert.equal(b.revealed, true); assert.deepEqual(b.seen, [0]);
  const pj = P.introProjection(stories, b, text);
  assert.equal(pj.story.title, '名偵探柯南');
  assert.deepEqual(leak2(pj), []);
  const b2 = P.introBack(stories, b, text);   // 再返回：收起柯南的答案
  assert.equal(b2.revealed, false); assert.deepEqual(b2.seen, []);
  assert.ok(!/柯南|工藤|新一|conan/.test(JSON.stringify(P.introProjection(stories, b2, text))));
  assert.deepEqual(leak2(P.introProjection(stories, legacy, text)), []);   // 交會畫面本身也只含柯南
});
test('P1：沒有有效的已公布紀錄（seen 為空、只有不存在的索引、缺少 seen）→ 回到中性的開場，不公布任何作品', () => {
  for (const seen of [[], [5], [-1, 'x'], undefined]) {
    const b = P.introBack(stories, { view: 'crossroads', index: 0, clues: 3, revealed: false, seen }, text);
    assert.equal(b.view, 'open', JSON.stringify(seen));
    assert.ok(!/柯南|工藤|新一|神隱|千尋|荻野|小千|conan|chihiro/.test(JSON.stringify(P.introProjection(stories, b, text))), JSON.stringify(seen));
  }
});
test('P1：只公布第二則的舊狀態 → 回到第二則揭曉頁；第一則不被公布', () => {
  const b = P.introBack(stories, { view: 'crossroads', index: 1, clues: 3, revealed: true, seen: [1] }, text);
  assert.equal(b.index, 1); assert.equal(b.revealed, true); assert.deepEqual(b.seen, [1]);
  assert.ok(!/柯南|工藤|conan/.test(JSON.stringify(P.introProjection(stories, b, text))));
});
test('P1：從第二則開頭返回，前一則只有已公布時才顯示答案（舊版可略過公布直接下一則）', () => {
  const b = P.introBack(stories, { view: 'story', index: 1, clues: 0, revealed: false, seen: [] }, text);
  assert.equal(b.index, 0); assert.equal(b.clues, 3); assert.equal(b.revealed, false); assert.deepEqual(b.seen, []);
  assert.equal(P.introProjection(stories, b, text).story.title, undefined);
});
test('P1：返回操作從不增加 seen（所有可達狀態與舊狀態）', () => {
  const states = [...walk(), { view: 'crossroads', seen: [0] }, { view: 'crossroads', seen: [1] }, { view: 'crossroads', seen: [] },
    { view: 'story', index: 1, clues: 0, revealed: false, seen: [] }, { view: 'compare', step: 0, seen: [0] }];
  for (const s of states) {
    const b = P.introBack(stories, { index: 0, clues: 0, revealed: false, step: 0, ...s }, text);
    if (!b) continue;
    const before = new Set((s.seen || []).filter((i) => i >= 0 && i < 2));
    assert.ok((b.seen || []).every((i) => before.has(i)), `${JSON.stringify(s)} → ${JSON.stringify(b.seen)}`);
  }
});
test('P1：新版正常流程不變——兩部都已公布時，比較頁返回第二部揭曉頁，再返回收起第二部答案', () => {
  const seq = walk();
  const b1 = P.introBack(stories, seq[11], text);
  assert.equal(b1.index, 1); assert.equal(b1.revealed, true); assert.deepEqual(b1.seen, [0, 1]);
  assert.equal(P.introProjection(stories, b1, text).story.title, '神隱少女');
  const b2 = P.introBack(stories, b1, text);
  assert.equal(b2.index, 1); assert.equal(b2.clues, 3); assert.equal(b2.revealed, false); assert.deepEqual(b2.seen, [0]);
  assert.deepEqual(leak2(P.introProjection(stories, b2, text)), []);
});
