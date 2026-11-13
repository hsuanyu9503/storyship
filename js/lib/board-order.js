// 小組看板讀取回應的新舊判斷（js/student/group.js adopt() 使用；tests/db/race_d2.sh 以真實並行讀取的回應直接驗證此函式）
//   三個版本（board_rev 小組內容、lock_rev 操作鎖、state_rev 環節／暫停）來自同一個資料快照，較新的快照沒有任何一個會變小。
//   三個版本都相同時（例如只有操作鎖逾時）：以讀取交易的時間 read_now 排序；它與伺服器過濾逾時鎖所用的 now() 是同一個值。
// cur：目前採用的回應（{board_rev, lock_rev, state_rev, read_now}）；next：新到的回應。回傳 true＝next 比 cur 舊，應忽略。
export function isOlderBoard(cur, next) {
  if (!cur) return false;
  const lock = next.lock_rev ?? 0; const state = next.state_rev ?? 0;
  if (next.board_rev < cur.board_rev || lock < cur.lock_rev || state < cur.state_rev) return true;
  return next.board_rev === cur.board_rev && lock === cur.lock_rev && state === cur.state_rev && (next.read_now ?? 0) < cur.read_now;
}
