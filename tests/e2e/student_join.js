// 測試共用：學生從正常入口加入（輸入座號 → 選擇組別 → 加入 → 確認加入）
//   assumeFullscreen：給「不測全螢幕」的測試使用的瀏覽器替身（addInitScript）。瀏覽器回報一直在全螢幕，
//   因此重新整理、離線等情境不會出現黑色遮罩擋住操作。全螢幕與遮罩本身由 seat_fullscreen.js 測試（不使用替身）。
exports.assumeFullscreen = () => {
  Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get() { return this.documentElement; } });
  Element.prototype.requestFullscreen = function () { return Promise.resolve(); };
};
let n = 0;
exports.nextSeat = () => ++n;
// p：Playwright 頁面；group：組別號碼；opts.tap：觸控；opts.seat：指定座號（預設依序 1、2、3…）
exports.joinGroup = async (p, group, { tap = false, seat } = {}) => {
  const s = seat ?? exports.nextSeat();
  await p.waitForSelector('.s-seat');
  await p.locator('.s-seat').fill(String(s));
  const g = p.locator(`.s-group:has(.n:text-is("${group}"))`);
  if (tap) await g.tap(); else await g.click();
  const go = p.locator('.s-join-go');
  if (tap) await go.tap(); else await go.click();
  const ok = p.locator('dialog button:has-text("確認加入")');
  if (tap) await ok.tap(); else await ok.click();
  return s;
};
