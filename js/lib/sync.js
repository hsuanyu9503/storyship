// 同步迴圈：Realtime Broadcast 只傳「有變更」的訊號，真正資料一律由 RPC 重新讀取。
// Realtime 中斷時自動改用較密集的輪詢，恢復連線或回到前景時立即重新讀取。
// 因此即使 Realtime 不可用，三端仍會在數秒內同步（不會只是前端模擬）。
export function createSync({ client, topic, load, onData, onStatus,
                             fastMs = 3000, slowMs = 15000 }) {
  let channel = null;
  let realtimeUp = false;
  let online = true;
  let timer = null;
  let inflight = null;
  let pending = false;
  let stopped = false;
  let debounce = null;
  const queued = [];   // 訂閱完成前要送出的通知

  function setStatus() {
    onStatus?.({ online, realtime: realtimeUp });
  }

  async function refresh() {
    if (stopped) return;
    if (inflight) { pending = true; return inflight; }
    inflight = (async () => {
      try {
        const data = await load();
        if (!online) { online = true; setStatus(); }
        onData(data);
      } catch (e) {
        if (e?.code === 'NETWORK') { if (online) { online = false; setStatus(); } }
        else onData(null, e);
      } finally {
        inflight = null;
        schedule();
        if (pending) { pending = false; refresh(); }
      }
    })();
    return inflight;
  }

  // onlyEarlier：只在新的時間更早時才重設計時器。
  // Realtime 連不上時，supabase-js 會反覆重試並觸發狀態回呼；若每次都重設計時器，
  // 輪詢會被無限延後（例如學校網路封鎖 WebSocket 時三端完全不同步）。
  let dueAt = 0;
  function schedule(onlyEarlier = false) {
    if (stopped) return;
    const delay = realtimeUp && online ? slowMs : fastMs;
    const due = Date.now() + delay;
    if (onlyEarlier && timer && dueAt <= due) return;
    clearTimeout(timer);
    dueAt = due;
    timer = setTimeout(() => { timer = null; refresh(); }, delay);
  }

  function poke() {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  }

  if (client && topic) {
    channel = client.channel(topic, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: '*' }, poke);
    channel.subscribe((status) => {
      const up = status === 'SUBSCRIBED';
      if (up !== realtimeUp) { realtimeUp = up; setStatus(); }
      if (up) { poke(); while (queued.length) channel.send(queued.shift()).catch(() => {}); }
      else schedule(true);   // Realtime 中斷：改用密集輪詢（不延後已排定的讀取）
    });
  }

  const onVisible = () => { if (document.visibilityState === 'visible') poke(); };
  const onOnline = () => poke();
  const onOffline = () => { if (online) { online = false; setStatus(); } schedule(true); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  refresh();

  return {
    refresh,
    // 本端完成寫入後通知其他裝置（資料庫端也會送出通知，兩者擇一到達即可）
    ping(event = 'changed', payload = {}) {
      const msg = { type: 'broadcast', event, payload };
      if (channel && realtimeUp) channel.send(msg).catch(() => {});
      else if (channel && queued.length < 5) queued.push(msg);
    },
    stop() {
      stopped = true;
      clearTimeout(timer); clearTimeout(debounce);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (channel) client.removeChannel(channel);
    },
    get status() { return { online, realtime: realtimeUp }; },
  };
}
