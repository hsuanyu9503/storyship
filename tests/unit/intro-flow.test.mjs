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

// ---------- 複查第二輪 P1：舊場次按「下一步」不得讓比較題提前透露未公布的主角 ----------
const S1 = SRC.stories[0];
// 一部作品的所有答案字詞（作品名、主角兩個名字、揭曉文、圖片檔名、替代文字），以及比較題中提到該部主角的字
const answerWords = (k) => {
  const s = SRC.stories[k];
  return [s.title, s.name_before, s.name_after, s.reveal_text, k ? 'chihiro' : 'conan', `《${s.title}》揭曉圖`, k ? '千尋' : '新一'];
};
const leaks = (pj, k) => answerWords(k).filter((w) => JSON.stringify(pj).includes(w));
function revealByNext(st) {   // 從線索 0 逐條顯示三條並公布，每一步都檢查投影
  const steps = [];
  for (let i = 0; i < 4; i++) { st = P.introNext(stories, st, text); steps.push(st); }
  return steps;
}
test('第二輪 P1：seen=[0] 的交會畫面按下一步 → 神祕故事二的中性猜題頁（線索 0）；公布前整份投影都沒有千尋相關內容；公布後才進入比較', () => {
  let st = P.introNext(stories, { view: 'crossroads', index: 0, clues: 0, revealed: false, seen: [0] }, text);
  assert.deepEqual([st.view, st.index, st.clues, st.revealed, st.seen], ['story', 1, 0, false, [0]]);
  assert.equal(P.introNextLabel(stories, { view: 'crossroads', seen: [0] }, text), '進入神祕故事二');
  let pj = P.introProjection(stories, st, text);
  assert.equal(pj.story.neutral, '神祕故事二');
  assert.deepEqual(leaks(pj, 1), []);
  const steps = revealByNext(st);
  for (const x of steps.slice(0, 3)) assert.deepEqual(leaks(P.introProjection(stories, x, text), 1), [], `線索 ${x.clues}`);
  st = steps[3];
  assert.equal(st.revealed, true); assert.deepEqual(st.seen, [0, 1]);
  st = P.introNext(stories, st, text);
  pj = P.introProjection(stories, st, text);
  assert.equal(st.view, 'compare'); assert.deepEqual(pj.prompts, SRC.compare_prompts);
  assert.deepEqual(pj.stories.map((s) => s.title), [S1.title, S2.title]);
});
test('第二輪 P1：seen=[1] → 神祕故事一（線索 0）；公布前沒有柯南相關內容；補完第一則後直接進入比較，不必再猜第二則', () => {
  let st = P.introNext(stories, { view: 'crossroads', index: 1, clues: 3, revealed: true, seen: [1] }, text);
  assert.deepEqual([st.view, st.index, st.clues, st.revealed, st.seen], ['story', 0, 0, false, [1]]);
  assert.deepEqual(leaks(P.introProjection(stories, st, text), 0), []);
  const steps = revealByNext(st);
  for (const x of steps.slice(0, 3)) assert.deepEqual(leaks(P.introProjection(stories, x, text), 0), [], `線索 ${x.clues}`);
  st = steps[3];
  assert.deepEqual(st.seen, [0, 1]);
  assert.equal(P.introNextLabel(stories, st, text), SRC.compare_title);
  st = P.introNext(stories, st, text);
  assert.equal(st.view, 'compare');
  assert.deepEqual(P.introProjection(stories, st, text).prompts, SRC.compare_prompts);
});
test('第二輪 P1：seen=[] → 神祕故事一（線索 0），兩部都沒有答案', () => {
  const st = P.introNext(stories, { view: 'crossroads', index: 0, clues: 0, revealed: false, seen: [] }, text);
  assert.deepEqual([st.view, st.index, st.clues, st.revealed, st.seen], ['story', 0, 0, false, []]);
  const pj = P.introProjection(stories, st, text);
  assert.deepEqual([...leaks(pj, 0), ...leaks(pj, 1)], []);
});
test('第二輪 P1：舊的不完整 compare 狀態（seen=[0]，step 0 與 1）重新產生投影：只有柯南，沒有比較題、命名題與千尋相關內容；下一步進入神祕故事二', () => {
  for (const step of [0, 1]) {
    const st = { view: 'compare', index: 1, clues: 0, revealed: false, seen: [0], step };
    const pj = P.introProjection(stories, st, text);
    assert.deepEqual(pj.prompts, []);
    assert.deepEqual(pj.stories.map((s) => s.title), [S1.title]);
    assert.deepEqual(leaks(pj, 1), []);
    const n = P.introNext(stories, st, text);
    assert.deepEqual([n.view, n.index, n.clues], ['story', 1, 0]);
  }
});
test('第二輪 P1：兩部都已公布的比較題照常送出；比較 → 命名 → 轉場；舊 crossroads（兩部皆公布）也照常進入比較', () => {
  const seq = walk();
  assert.deepEqual(P.introProjection(stories, seq[11], text).prompts, SRC.compare_prompts);
  assert.deepEqual(P.introProjection(stories, seq[12], text).prompts, [...SRC.compare_prompts, SRC.naming_prompt]);
  assert.equal(seq[13].view, 'bridge');
  const c = P.introNext(stories, { view: 'crossroads', index: 1, clues: 3, revealed: true, seen: [0, 1] }, text);
  assert.deepEqual([c.view, c.step], ['compare', 0]);
  assert.deepEqual(P.introProjection(stories, c, text).prompts, SRC.compare_prompts);
});
test('第二輪 P1：舊狀態前進後按上一步仍不會公布未公布的作品', () => {
  const st = P.introNext(stories, { view: 'crossroads', seen: [0] }, text);   // 神祕故事二，線索 0
  const b = P.introBack(stories, st, text);                                   // 回到柯南揭曉（已公布）
  assert.deepEqual([b.index, b.revealed, b.seen], [0, true, [0]]);
  assert.deepEqual(leaks(P.introProjection(stories, b, text), 1), []);
  const st1 = P.introNext(stories, { view: 'crossroads', seen: [1] }, text);  // 神祕故事一，線索 0
  const b1 = P.introBack(stories, st1, text);                                 // 已在第一則開頭 → 開場
  assert.equal(b1.view, 'open');
  assert.deepEqual([...leaks(P.introProjection(stories, b1, text), 0), ...leaks(P.introProjection(stories, b1, text), 1)], []);
});

// ---------- 複查第三輪：比較頁返回到「進入比較前剛揭曉的那一則」，不是編號最大的一則 ----------
const fwd = (st, k = 1) => { for (let i = 0; i < k; i++) st = P.introNext(stories, st, text); return st; };
test('第三輪 案例 1：舊場次 seen=[1] 補猜並公布柯南 → 比較 → 上一步回到柯南揭曉；再上一步回到柯南三條線索並收起柯南，千尋仍為已公布', () => {
  let st = fwd({ view: 'crossroads', index: 1, clues: 3, revealed: true, seen: [1], step: 0 });   // 神祕故事一 線索 0
  assert.deepEqual([st.view, st.index, st.clues], ['story', 0, 0]);
  st = fwd(st, 4);                                                                                    // 三條線索＋公布柯南
  assert.deepEqual([st.index, st.revealed, st.seen], [0, true, [0, 1]]);
  st = fwd(st);                                                                                       // 進入比較
  assert.equal(st.view, 'compare');
  const b1 = P.introBack(stories, st, text);
  assert.deepEqual([b1.view, b1.index, b1.clues, b1.revealed, b1.seen], ['story', 0, 3, true, [0, 1]]);
  const pj1 = P.introProjection(stories, b1, text);
  assert.equal(pj1.story.title, S1.title); assert.equal(pj1.story.name_after, S1.name_after);
  assert.ok(!JSON.stringify(pj1).includes(S2.name_before), '柯南揭曉頁不含千尋的資料');
  const b2 = P.introBack(stories, b1, text);
  assert.deepEqual([b2.view, b2.index, b2.clues, b2.revealed, b2.seen], ['story', 0, 3, false, [1]]);
  const pj2 = P.introProjection(stories, b2, text);
  assert.equal(pj2.story.title, undefined);
  assert.deepEqual(leaks(pj2, 0), []);
});
test('第三輪 案例 2：一般新場次（柯南 → 千尋 → 比較）返回仍是千尋揭曉，再返回為千尋三條線索', () => {
  const seq = walk();
  const b1 = P.introBack(stories, seq[11], text);
  assert.deepEqual([b1.index, b1.revealed, b1.clues], [1, true, 3]);
  const b2 = P.introBack(stories, b1, text);
  assert.deepEqual([b2.index, b2.revealed, b2.clues, b2.seen], [1, false, 3, [0]]);
});
test('第三輪 案例 3：命名提問 → 上一步回到比較提問 → 再上一步回到剛才揭曉的作品（反向舊場次＝柯南；一般＝千尋）', () => {
  let st = fwd(fwd({ view: 'crossroads', index: 1, clues: 3, revealed: true, seen: [1], step: 0 }, 5), 2);   // 柯南公布 → 比較 → 命名
  assert.deepEqual([st.view, st.step], ['compare', 1]);
  let b = P.introBack(stories, st, text);
  assert.deepEqual([b.view, b.step], ['compare', 0]);
  b = P.introBack(stories, b, text);
  assert.deepEqual([b.view, b.index, b.revealed], ['story', 0, true]);
  const seq = walk();
  let c = P.introBack(stories, P.introBack(stories, seq[12], text), text);
  assert.deepEqual([c.view, c.index, c.revealed], ['story', 1, true]);
  // 轉場 → 上一步 → 命名 → 比較 → 柯南（反向舊場次）
  st = fwd(st);                                                                                        // 轉場
  assert.equal(st.view, 'bridge');
  b = P.introBack(stories, P.introBack(stories, P.introBack(stories, st, text), text), text);
  assert.deepEqual([b.view, b.index], ['story', 0]);
});
test('第三輪 案例 4：index 缺失、越界或指向未公布作品時沿用安全返回（seen 中編號最大的已公布作品）；不新增 seen；沒有有效紀錄回開場；比較題仍只在兩部都公布後', () => {
  for (const [index, seen, want] of [[undefined, [0, 1], 1], [7, [0, 1], 1], [-1, [1], 1], [1, [0], 0], [0, [1], 1], ['x', [0], 0]]) {
    const b = P.introBack(stories, { view: 'compare', step: 0, clues: 3, revealed: true, index, seen }, text);
    assert.deepEqual([b.view, b.index, b.revealed], ['story', want, true], `index ${index} seen ${JSON.stringify(seen)}`);
    assert.deepEqual(b.seen, [...seen].sort(), '不新增 seen');
    if (seen.length === 1) assert.deepEqual(leaks(P.introProjection(stories, b, text), 1 - seen[0]), [], '不公布另一部');
  }
  for (const seen of [[], [9], undefined]) {
    assert.equal(P.introBack(stories, { view: 'compare', step: 0, index: 0, seen }, text).view, 'open');
  }
  const partial = P.introProjection(stories, { view: 'compare', step: 1, index: 0, seen: [0] }, text);
  assert.deepEqual(partial.prompts, []);
});
