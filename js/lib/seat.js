// 學生座號：學生在選擇組別時輸入（1～999 的整數），教師端以「5 號」顯示。
//   舊場次的學生沒有座號（seat_no 為 null）：顯示「未填座號（組內第 N 位）」，N 是組內加入順序（舊版 seat_label）。
export const SEAT_MAX = 999;

// 學生輸入的座號：允許全形數字與前後空白（「０５」→ 5）；回傳 { value } 或 { error }
export function parseSeat(raw) {
  const s = String(raw ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  if (!s) return { error: '請先輸入座號。' };
  if (!/^\d+$/.test(s)) return { error: '座號只能填數字，例如 5。' };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > SEAT_MAX) return { error: `座號請輸入 1～${SEAT_MAX} 的整數，例如 5。` };
  return { value: n };
}

export function hasSeat(p) {
  const n = Number(p?.seat_no);
  return p?.seat_no != null && Number.isInteger(n) && n > 0;
}

export function seatText(p) {
  if (hasSeat(p)) return `${Number(p.seat_no)} 號`;
  const order = String(p?.seat_label ?? '').match(/\d+/)?.[0];
  return order ? `未填座號（組內第 ${order} 位）` : '未填座號';
}

// 依座號排序；沒有座號的排在後面（依加入時間）
export function bySeat(a, b) {
  const x = hasSeat(a) ? Number(a.seat_no) : Infinity; const y = hasSeat(b) ? Number(b.seat_no) : Infinity;
  if (x !== y) return x - y;
  return String(a.joined_at || '').localeCompare(String(b.joined_at || ''));
}
