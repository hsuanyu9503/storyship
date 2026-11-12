// QR Code：使用專案內的 qrcode 套件（js/vendor）；載入失敗時回傳 null，畫面改顯示網址與活動代碼。
let lib = null;

export async function qrDataUrl(text, size = 512) {
  try {
    if (!lib) {
      const mod = await import('../vendor/qrcode-1.5.4.js');
      lib = mod.default || mod;
    }
    return await lib.toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: 'M' });
  } catch (e) {
    console.warn('QR 產生失敗', e);
    return null;
  }
}

// 學生加入網址：與目前頁面同一目錄下的 join.html
export function joinUrl(code) {
  const u = new URL('join.html', location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('code', code);
  return u.toString();
}
