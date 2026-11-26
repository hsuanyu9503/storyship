// 學生端：把全螢幕狀態回報給伺服器（教師端在小組成員清單顯示）
//   * 狀態來自 fullscreen.js 的 fsReportState()（依瀏覽器實際狀態）；只在狀態改變、加入／重新整理後、斷線重連後回報。
//   * 每次回報帶遞增序號（觀察到狀態的當下產生）：max(現在時間毫秒, 上一個序號＋1)，記在本機，重新整理後仍遞增。
//     伺服器只接受更大的序號，所以重送、延遲送達、順序顛倒的回報不會讓狀態倒退。
//   * 只保留「最新」要回報的狀態：送出中又改變時，送完後接著送最新的（舊的不再送）。
//   * 失敗時以 1、2、4…最多 15 秒重試；重新連線時立即以「目前」狀態重新回報（新的序號），避免教師端停在舊狀態。
//   * 伺服器的序號比本機大（例如本機紀錄被清除）：採用伺服器的序號後重新回報目前狀態。
export function createFsReporter({ send, getState, loadSeq = () => 0, saveSeq = () => {}, onAccepted = () => {},
                                   now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let want = null;        // { state, seq }：最新要回報的狀態
  let acked = 0;          // 伺服器已處理（接受或判定過期）的最大序號
  let sending = false;
  let timer = null;
  let backoff = 1000;
  let stopped = false;

  function nextSeq() {
    const s = Math.max(Math.floor(now()), (Number(loadSeq()) || 0) + 1);
    saveSeq(s);
    return s;
  }
  function report(state = getState()) {
    if (stopped) return;
    want = { state, seq: nextSeq() };
    if (timer) { clearTimer(timer); timer = null; }
    flush();
  }
  async function flush() {
    if (stopped || sending || !want || want.seq <= acked) return;
    sending = true;
    const w = want;
    let retry = false;
    try {
      const r = await send(w.state, w.seq);
      backoff = 1000;
      acked = Math.max(acked, w.seq);
      if (r?.accepted) onAccepted(r);
      else if (r?.reason === 'STALE' && Number(r.seq) >= w.seq && want === w) {
        // 伺服器已有更大的序號（本機序號紀錄遺失）：沿用伺服器序號，重新回報目前狀態
        saveSeq(Number(r.seq));
        want = { state: getState(), seq: nextSeq() };
      } else if (r?.reason === 'INACTIVE') stopped = true;   // 已被移出或場次已結束
    } catch (e) {
      if (e?.code === 'NOT_JOINED' || e?.code === 'INVALID_TOKEN' || e?.code === 'BAD_DATA') stopped = true;
      else retry = true;
    } finally {
      sending = false;
    }
    if (stopped) return;
    if (retry) {
      timer = setTimer(() => { timer = null; flush(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    } else if (want && want.seq > acked) flush();
  }
  return {
    report,
    // 重新連線、回到前景：以目前狀態重新回報（新的序號）
    resync() { report(getState()); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    get pending() { return Boolean(want && want.seq > acked); },
  };
}
