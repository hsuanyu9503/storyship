// 教師端：學生裝置回報的全螢幕狀態（participants.fs_state 等欄位，由 student_report_fullscreen 寫入）
//   顯示用語只描述裝置回報的狀態，不推定原因。
//   過期判定：沿用連線管理的在線判定（最後連線 40 秒內）。學生裝置在線時，狀態一改變就會回報（失敗會重試、重連後重送），
//   因此在線期間最後一次回報仍有效；超過在線時間就改為「連線中斷／狀態待確認」，不會一直顯示綠色。
import { seatText } from './seat.js';

export const FS_LABEL = {
  active: '全螢幕中',
  exited: '已退出全螢幕',
  none: '尚未進入全螢幕',
  denied: '尚未進入全螢幕（瀏覽器未允許）',
  unsupported: '裝置不支援全螢幕',
  stale: '連線中斷／狀態待確認',
  unknown: '狀態待確認（尚未回報）',
};

// online：沿用教師端的在線判定結果
export function fsStatus(p, online) {
  if (!online) return { key: 'stale', text: FS_LABEL.stale, cls: 'fs-stale' };
  const k = FS_LABEL[p?.fs_state] && !['stale', 'unknown'].includes(p.fs_state) ? p.fs_state : 'unknown';
  const cls = { active: 'fs-on', exited: 'fs-off', unsupported: 'fs-na' }[k] || 'fs-wait';
  return { key: k, text: FS_LABEL[k], cls };
}

// 退出提醒：fs_exits（「全螢幕中 → 已退出」次數，只增不減）比上次看到的大，才是新的退出事件。
//   第一次讀到名單（教師端開啟或重新整理）只記錄基準，不提醒歷史事件；輪詢、重送、重連重新讀取時次數不變，不會重複提醒。
export function createExitWatcher() {
  let seen = null;   // Map<participant id, fs_exits>
  return function check(people, groupName = () => '') {
    const fresh = [];
    const next = new Map();
    for (const p of people || []) {
      const n = Number(p.fs_exits) || 0;
      next.set(p.id, n);
      if (seen && p.status === 'active' && n > (seen.get(p.id) ?? n)) {
        fresh.push({ id: p.id, label: `${groupName(p)}・${seatText(p)}`, back: p.fs_state === 'active' });
      }
    }
    // 名單中暫時不見的學生（例如被移出）保留舊值，避免回來時把舊事件當成新的
    if (seen) for (const [id, n] of seen) if (!next.has(id)) next.set(id, n);
    seen = next;
    return fresh;
  };
}

// 多位學生短時間退出：彙整成一句
export function exitMessage(list) {
  if (!list.length) return '';
  const names = list.map((x) => x.label + (x.back ? '（已返回）' : ''));
  if (names.length === 1) return `${names[0]}退出全螢幕`;
  const shown = names.slice(0, 4).join('、');
  return `${names.length} 位學生退出全螢幕：${shown}${names.length > 4 ? ` 等` : ''}`;
}
