// 小說類型圖片：來源選擇（與伺服器 app.genre_visual 相同）與縮圖對應
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genreVisual } from '../../js/lib/projection.js';

const both = { visual_url: 'assets/genres/wuxia-portrait.webp', visual_landscape_url: 'assets/genres/wuxia-landscape.webp' };
test('06 直式優先、07 橫式優先；缺圖時互相回退；都沒有為 null（與 SQL app.genre_visual 相同）', () => {
  assert.deepEqual(genreVisual(both, 'portrait'), { visual_url: both.visual_url, visual_source: 'portrait' });
  assert.deepEqual(genreVisual(both, 'landscape'), { visual_url: both.visual_landscape_url, visual_source: 'landscape' });
  assert.deepEqual(genreVisual({ visual_url: 'a.png' }, 'landscape'), { visual_url: 'a.png', visual_source: 'portrait' });   // 舊資料：只有 visual_url
  assert.deepEqual(genreVisual({ visual_landscape_url: 'b.webp' }, 'portrait'), { visual_url: 'b.webp', visual_source: 'landscape' });
  assert.deepEqual(genreVisual({ visual_url: '  ', visual_landscape_url: null }, 'portrait'), { visual_url: null, visual_source: null });
  assert.deepEqual(genreVisual(null, 'portrait'), { visual_url: null, visual_source: null });
});

test('縮圖對應：只對本專案的類型圖卡產生 srcset；其他網址只用單一來源', async () => {
  globalThis.document ??= undefined;   // render-projection 只在繪製時用到 DOM
  const { genreSources } = await import('../../js/lib/render-projection.js');
  assert.deepEqual(genreSources('assets/genres/detective-portrait.webp'),
    [{ url: 'assets/genres/detective-portrait-600w.webp', w: 600 }, { url: 'assets/genres/detective-portrait.webp', w: 1086 }]);
  assert.deepEqual(genreSources('assets/genres/detective-landscape.webp'),
    [{ url: 'assets/genres/detective-landscape-960w.webp', w: 960 }, { url: 'assets/genres/detective-landscape.webp', w: 1672 }]);
  for (const u of [null, '', 'assets/story-a.png', 'https://x.example/assets/genres/a-portrait.webp', 'assets/genres/a-portrait.png', 'assets/genres/../x-portrait.webp'])
    assert.equal(genreSources(u), null, String(u));
});
