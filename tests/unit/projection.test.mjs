// 投影內容產生器測試：確認未公開的線索、故事名稱、小說類型不會進入投影資料。
// 執行：node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../js/lib/projection.js';
import { PHASES, PHASE_IDS, nextPhase, prevPhase, totalMinutes, STUDENT_VIEW } from '../../js/lib/phases.js';

const stories = [
  { title: '祕密一', reveal_text: '答案一', image_url: 'a.png', background_url: 'bg1.png',
    clues: [{ kind: 'background', label: '背景', body: '霧' }, { kind: 'character', label: '人物', body: '少女' }, { kind: 'plot', label: '情節', body: '鑰匙' }] },
  { title: '祕密二', reveal_text: '答案二', clues: [{ label: 'x', body: 'y' }] },
];
const genres = ['奇幻', '偵探', '歷史', '冒險', '武俠'].map((name, i) => ({
  name, teacher_notes: '教師補充' + i, elements: [{ label: name + '1' }, { label: name + '2' }, { label: name + '3' }, { label: '多的' }],
}));
const str = (o) => JSON.stringify(o);

test('環節定義：00～07＋結束，正式教學 40 分鐘', () => {
  assert.deepEqual(PHASE_IDS, ['00', '01', '02', '03', '04', '05', '06', '07', '99']);
  assert.equal(totalMinutes(), 40);
  assert.equal(nextPhase('00'), '01');
  assert.equal(prevPhase('00'), null);
  assert.equal(nextPhase('99'), null);
  for (const p of PHASES) assert.ok(STUDENT_VIEW[p.id], '每個環節都有學生畫面 ' + p.id);
  assert.equal(STUDENT_VIEW['01'], 'watch');
  assert.equal(STUDENT_VIEW['05'], 'watch');
});

test('01：線索逐步公開，揭曉前不含故事名稱', () => {
  let st = P.introOps.start(stories, P.introInitial());
  let pj = P.introProjection(stories, st);
  assert.equal(pj.story.clues.length, 0);
  assert.ok(!str(pj).includes('霧'));
  st = P.introOps.nextClue(stories, st);
  pj = P.introProjection(stories, st);
  assert.equal(pj.story.clues.length, 1);
  assert.ok(str(pj).includes('霧') && !str(pj).includes('少女'), '只公開第一個線索');
  assert.ok(!str(pj).includes('祕密一') && !str(pj).includes('答案一'), '揭曉前沒有故事名稱');
  assert.ok(!str(pj).includes('祕密二'), '不含其他故事');
  assert.equal(P.introSub(st), '01-02');
  st = P.introOps.reveal(stories, st);
  pj = P.introProjection(stories, st);
  assert.equal(pj.story.title, '祕密一');
  assert.equal(pj.story.clues.length, 3, '揭曉時顯示全部線索');
  assert.equal(P.introSub(st), '01-03');
  // 線索數上限
  for (let i = 0; i < 5; i++) st = P.introOps.nextClue(stories, st);
  assert.equal(st.clues, 3);
  st = P.introOps.nextStory(stories, st);
  pj = P.introProjection(stories, st);
  assert.ok(!str(pj).includes('祕密二'), '下一個故事尚未揭曉');
  st = P.introOps.crossroads(stories, st);
  pj = P.introProjection(stories, st);
  assert.equal(P.introSub(st), '01-04');
  assert.deepEqual(pj.stories.map((s) => s.title), ['祕密一'], '交會畫面只含已揭曉的故事');
});

test('01：故事數與線索數由資料決定', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ title: 'S' + i, clues: Array.from({ length: i + 1 }, () => ({ label: 'c', body: 'b' })) }));
  let st = P.introOps.start(many, P.introInitial());
  for (let i = 0; i < 3; i++) st = P.introOps.nextStory(many, st);
  assert.equal(st.index, 3);
  st = P.introOps.nextStory(many, st);
  assert.equal(st.index, 3, '不會超過最後一個故事');
  assert.equal(P.introProjection(many, st).story.clue_total, 4);
});

test('06：未揭開的類型不進入投影，三要素以外的資料不外流', () => {
  let g = P.genreInitial();
  assert.equal(P.genreSub(g), '06-01');
  g = P.genreOps.goto(genres, g, 2);
  let pj = P.genreProjection(genres, g);
  assert.equal(pj.view, 'teaser');
  assert.ok(!str(pj).includes('歷史'), '「即將揭開」畫面不含類型名稱');
  g = P.genreOps.reveal(genres, g);
  pj = P.genreProjection(genres, g);
  assert.equal(pj.genre.name, '歷史');
  assert.equal(pj.genre.elements.length, 3, '名稱與三個要素一起公開');
  assert.ok(!str(pj).includes('教師補充'), '教師補充資料不投影');
  assert.ok(!str(pj).includes('多的'), '只投影三個要素');
  g = P.genreOps.overview(genres, g);
  pj = P.genreProjection(genres, g);
  assert.equal(P.genreSub(g), '06-03');
  assert.equal(pj.genres.filter(Boolean).length, 1, '總覽只顯示已公開的類型');
  assert.ok(!str(pj).includes('奇幻') && !str(pj).includes('武俠'));
});

test('各環節預設投影不含小組資料或未公開內容', () => {
  const content = { intro: stories, genres };
  for (const id of PHASE_IDS) {
    const { sub, projection } = P.defaultProjection(id, content);
    assert.ok(sub, id + ' 有子畫面代碼');
    assert.ok(projection.screen, id + ' 有投影畫面');
    const s = str(projection);
    for (const secret of ['祕密一', '答案一', '霧', '奇幻', '教師補充']) assert.ok(!s.includes(secret), `${id} 不含「${secret}」`);
  }
  assert.ok(!str(P.taskProjection()).match(/奇幻|偵探|歷史|冒險|武俠/), '02 不提前顯示五種類型');
});
