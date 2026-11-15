// 字體試排（標楷體）：只在網址加上 ?font=kai 時啟用，正式版仍使用現行字體。
//   ?font=kai      這台裝置的教師端、學生端、投影端都改用標楷體試排（記在這台裝置的瀏覽器，換頁後仍有效）
//   ?font=default  取消試排，回到現行字體
// 啟用時右下角顯示小標籤「標楷體試排」，避免和正式版混淆。不影響任何資料或其他裝置。
const KEY = 'sf.fontPreview';
let mode = null;
try {
  const q = new URLSearchParams(location.search).get('font');
  if (q === 'kai') localStorage.setItem(KEY, 'kai');
  else if (q === 'default') localStorage.removeItem(KEY);
  mode = q === 'kai' ? 'kai' : q === 'default' ? null : localStorage.getItem(KEY);
} catch { /* 隱私模式等無法使用 localStorage：只看網址參數 */
  mode = new URLSearchParams(location.search).get('font') === 'kai' ? 'kai' : null;
}
if (mode === 'kai') {
  document.documentElement.classList.add('font-kai');
  const tag = () => {
    if (document.querySelector('.font-preview-tag')) return;
    const t = document.createElement('div');
    t.className = 'font-preview-tag';
    t.textContent = '標楷體試排（網址加 ?font=default 取消）';
    t.setAttribute('aria-hidden', 'true');
    document.body.append(t);
  };
  if (document.body) tag(); else document.addEventListener('DOMContentLoaded', tag);
}
export const fontPreview = mode;
