// A｜投影端：只顯示教師核准公開的內容，不呈現任何管理資訊。
import { makeClient, configured, rpc, errorText } from '../lib/api.js';
import { createSync } from '../lib/sync.js';
import { renderProjection } from '../lib/render-projection.js';
import { h, mount } from '../lib/dom.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const sessionId = params.get('s');
const key = params.get('k');

function message(text) {
  mount(root, h('div.stage-wrap', h('div.stage', h('div.st-center', h('p.st-lead', text)))));
}

if (!configured) {
  message('尚未設定 Supabase 連線（config.js）。');
} else if (!sessionId || !key) {
  message('請由教師主控端按「開啟投影」取得投影連結。');
} else {
  const client = makeClient('projector');
  let lastRev = null;
  const netBadge = h('div.net-badge', { hidden: true }, '連線中斷，重新連線中…');
  const fsBtn = h('button.fs-btn', { type: 'button', onclick: () => document.documentElement.requestFullscreen?.().catch(() => {}) }, '全螢幕');
  const wrap = h('div.stage-wrap');
  mount(root, wrap, netBadge, fsBtn);
  document.addEventListener('fullscreenchange', () => { fsBtn.hidden = Boolean(document.fullscreenElement); });

  createSync({
    client,
    topic: 'lesson:' + sessionId,
    fastMs: 2000,
    slowMs: 10000,
    load: () => rpc(client, 'projector_state', { p_session: sessionId, p_key: key }),
    onStatus: ({ online }) => { netBadge.hidden = online; },
    onData: (data, err) => {
      if (err) { message(errorText(err)); lastRev = null; return; }
      if (!data || data.rev === lastRev) return;
      lastRev = data.rev;
      document.title = (data.title || '故事找朋友') + '｜投影';
      wrap.replaceChildren(renderProjection(data));
    },
  });
}
