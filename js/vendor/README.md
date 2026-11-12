# 第三方函式庫（已打包、固定版本）

為了讓網站在學校網路（常封鎖 CDN）也能運作，GitHub Pages 直接提供這兩個檔案，不在執行時從 CDN 載入。

| 檔案 | 來源套件 | 授權 |
|---|---|---|
| `supabase-js-2.45.4.js` | `@supabase/supabase-js@2.45.4`（含相依套件） | MIT（Copyright (c) 2020 Supabase） |
| `qrcode-1.5.4.js` | `qrcode@1.5.4` | MIT（Copyright (c) 2012 Ryan Day） |

重新產生（需要 Node.js）：

```bash
cd tests/e2e && npm install && npm run vendor
```
