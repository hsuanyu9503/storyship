// 故事卡：圖片來源、編號、段落與元素（js/lib/story.js 的純函式；閱讀卡本身見 tests/e2e/story_reader.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storySources, storyThumb, storyNo, storyAlt, storyParagraphs, storyElements } from '../../js/lib/story.js';

test('正式故事圖：看板 600w、閱讀 1200 寬兩個來源；其他網址只有單一來源', () => {
  assert.deepEqual(storySources('assets/stories/story-04.webp'),
    [{ url: 'assets/stories/story-04-600w.webp', w: 600 }, { url: 'assets/stories/story-04.webp', w: 1200 }]);
  assert.equal(storySources('assets/story-a.png'), null);
  assert.equal(storySources(null), null);
  assert.equal(storySources('assets/stories/story-04-600w.webp'), null);
  assert.equal(storyThumb('assets/stories/story-01.webp'), 'assets/stories/story-01-600w.webp');
  assert.equal(storyThumb('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(storyThumb(null), null);
});

test('編號依素材順序補零；替代文字沿用資料，沒有時以名稱產生', () => {
  assert.deepEqual([0, 7, 9].map(storyNo), ['01', '08', '10']);
  assert.equal(storyAlt({ title: '寶可夢', image_alt: '《寶可夢》故事情境圖' }), '《寶可夢》故事情境圖');
  assert.equal(storyAlt({ title: '故事 A', image_alt: null }), '《故事 A》故事圖片');
});

test('段落：依換行分段、保留段內文字（含原稿的空白）、略過空段', () => {
  assert.deepEqual(storyParagraphs('第一段\n\n第二段， 有空白\n'), ['第一段', '第二段， 有空白']);
  assert.deepEqual(storyParagraphs(''), []);
  assert.deepEqual(storyParagraphs(null), []);
});

test('元素：只接受字串陣列；舊資料沒有元素時為空', () => {
  assert.deepEqual(storyElements({ elements: ['神奇零食', '', 3, '實現願望'] }), ['神奇零食', '實現願望']);
  assert.deepEqual(storyElements({}), []);
  assert.deepEqual(storyElements({ elements: '神奇零食' }), []);
});

test('原稿抽出的八張卡：編號 01～08、每張有段落與 4～5 個元素、不含「動物方程市」', () => {
  const src = JSON.parse(readFileSync(new URL('../../docs/story-cards-source.json', import.meta.url), 'utf8'));
  assert.deepEqual(src.map((c) => c.no), ['01', '02', '03', '04', '05', '06', '07', '08']);
  assert.deepEqual(src.map((c) => c.title), ['神奇柑仔店', '鬼滅之刃', '國家寶藏', '動物方城市', '北海小英雄', '寶可夢', '功夫熊貓', '倚天屠龍記']);
  for (const c of src) {
    assert.ok(c.paragraphs.length >= 1 && c.elements.length >= 4 && c.elements.length <= 5, c.title);
    assert.ok(!JSON.stringify(c).includes('動物方程市'));
  }
  // 原稿段落數（05 的介紹在原稿中套用標籤樣式，仍是兩段）
  assert.deepEqual(src.map((c) => c.paragraphs.length), [1, 3, 3, 3, 2, 2, 2, 3]);
});
