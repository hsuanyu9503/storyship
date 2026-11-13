# 小說類型教材（第 06、07 環節）｜正式文字、圖片與相容策略

本文件是第 06、07 環節類型教材的對照表：最終文字、圖片對應、教師補充、圖片規格、資料庫與畫面的相容方式。
資料的唯一來源是 `supabase/content/genre_materials_v1.sql`；本文件與它不一致時以 SQL 為準。

## 1. 類型與常見特色（學生與投影看得到）

後半堂以「小說類型」為教學概念，卡片名稱不加「小說」二字。順序沿用既有排序（`sort_order`）；揭露紀錄以索引記錄類型，因此**不改排序**。

| 索引 | slug | 顯示名稱 | 常見特色一 | 常見特色二 | 常見特色三 | 直式主圖（06） | 橫式對照圖（07） |
|---|---|---|---|---|---|---|---|
| 0 | fantasy | 奇幻 | 不同於現實的時空 | 魔法或超自然力量 | 神祕奇異的事物 | `assets/genres/fantasy-portrait.webp` | `assets/genres/fantasy-landscape.webp` |
| 1 | detective | 偵探 | 離奇事件與謎團 | 敏銳觀察與分析 | 透過推理解開謎題 | `assets/genres/detective-portrait.webp` | `assets/genres/detective-landscape.webp` |
| 2 | historical | 歷史 | 歷史事件或人物 | 特定的歷史時期 | 當時的社會風貌 | `assets/genres/historical-portrait.webp` | `assets/genres/historical-landscape.webp` |
| 3 | adventure | 冒險 | 不尋常的冒險經歷 | 遭遇危險與困難 | 運用智慧克服困難 | `assets/genres/adventure-portrait.webp` | `assets/genres/adventure-landscape.webp` |
| 4 | wuxia | 武俠 | 多以古代為背景 | 俠客、門派或幫派 | 人物與群體間的恩怨 | `assets/genres/wuxia-portrait.webp` | `assets/genres/wuxia-landscape.webp` |

**偵探**的圖片來源檔名為「推理類型」，網站顯示名稱是「偵探」（slug `detective`）。

## 2. 用語

| 位置 | 用語 |
|---|---|
| 第 06 環節名稱 | 認識小說的五種類型（子步驟：分類背後的祕密／五種小說類型／小說類型總覽） |
| 類型總覽標題 | 小說類型總覽 |
| 三項特色的稱呼 | 常見特色（取代「核心要素」） |
| 06 揭開前的畫面 | 小說類型 N／5、「即將揭開下一種小說類型」 |
| 07 未揭露的特色 | 常見特色（尚未揭露） |
| 06 總覽中未揭露的特色 | 尚未揭露的特色 |
| 07 引導問句（等待畫面、尚未選類型時） | 我們觀察到的故事特色，和哪一種小說類型相近？ |
| 句型鷹架 | 我們把這些故事分在一起，是因為＿＿＿＿；這些特色和＿＿＿＿類型的故事很接近。 |
| 教師端按鈕 | 06-03 顯示小說類型總覽、揭開這個類型（名稱＋三項常見特色） |

只調整顯示文字；內部欄位（`elements`、`disclosure.revealed` 的要素索引等）不改名。前端文字集中在 `js/lib/phases.js`（`TEXT`）與 `js/lib/render-projection.js`；
伺服器產生的投影（`app.genre_build`、`app.match_build`）只輸出資料（名稱、特色、圖片），不輸出提示文字，所以前後端用語一致。

## 3. 教師專用補充（只在教師端顯示，不會投影或傳給學生）

存放位置：各類型的 `genres.teacher_notes`；共同部分在 `content_sets.genre_teacher_guide`（JSON：`intro`、`reminder`、`image_note`）。
兩者只有登入的教師可讀（RLS），不在 `projector_state`、學生 RPC 或任何公開回應中；網站的 JS 檔案也不含這些文字（GitHub Pages 上的程式碼是公開的）。

**共同引導**：剛才我們閱讀故事，從人物、情節和背景找出共同特色。這些特色，也能幫助我們認識小說的類型。今天要認識的是奇幻、偵探、歷史、冒險和武俠。這些特色不只會出現在小說裡，電影、動畫或其他故事中也可能看得到。

**共同提醒**：這三項是幫助我們觀察的常見特色，不是每個故事都必須全部符合。同一個故事，也可能具有不同類型的特色。

**圖片**：圖片只提供觀察線索，不能僅憑一張圖判定全部特色。

| 類型 | 提問 | 補充 |
|---|---|---|
| 奇幻 | 這個世界和現實有哪些不同？神奇力量如何運作？它讓故事發生什麼變化？ | 可延伸討論條件與限制，但短篇沒有交代時，不要求學生硬找答案。 |
| 偵探 | 主角注意到什麼？如何分析這些線索？根據什麼推理出答案？ | — |
| 歷史 | 故事與哪些歷史事件或人物有關？哪些細節呈現當時的生活？ | 只出現古裝或「很久以前」不足以判定；歷史小說可以結合史實與虛構。赤壁圖片為情境插畫，不是精確戰場復原。 |
| 冒險 | 主角遇到什麼不尋常的事？面臨哪些危險？如何想辦法克服？ | 圖卡呈現冒險途中的野營、分工與準備，不代表只要露營就屬於冒險類型。 |
| 武俠 | 有哪些人物或門派？他們之間有什麼恩怨？ | 「多以古代為背景」不是必然條件。武藝、俠義可延伸討論。 |

教師端顯示位置：06 面板上方「教師補充」（可展開）；06 點選類型後的詳細區；07 選擇類型後的「③ 常見特色」區與面板下方。

## 4. 圖片

### 4-1 來源與處理

* 使用者提供的附件 `小說類型圖卡.zip` 內含已轉好的 **10 張 WebP**（品質 82、原始尺寸、sRGB，無內嵌色彩設定檔）與「素材清單.csv」。**附件中沒有原始 PNG**；原始 PNG 的檔名與位元組數取自該 CSV。
* 壓縮檔先檢查路徑安全（無絕對路徑、`..`、符號連結）再解壓到獨立目錄。
* **主圖**：與附件**逐位元組相同**（不重新壓縮，避免二次失真）。直式 1086×1448（3:4）、橫式 1672×941（約 16:9，保留原比例，未拉伸、未裁切）。
* **小圖**：由主圖以 Lanczos 縮小（直式寬 600、橫式寬 960，高度等比），有損 WebP `quality=82, method=6`。
  與無損縮小比較的亮度 PSNR 為 32.3～35.8 dB；人工比對魔法陣、臉與手、腳印、船隊、營火、劍身，看不出差異，因此維持品質 82。
* 色彩：來源與輸出都沒有內嵌 ICC（瀏覽器以 sRGB 顯示）；轉檔未做色彩轉換。
* 網站只引用 WebP；不部署 PNG。使用者原檔未修改或刪除。
* 重現：`python3 -I tools/genre_images.py <附件解壓後的「小說類型圖卡_WebP」資料夾>`（需要 Pillow；輸出到 `assets/genres/`，清單寫到 `docs/genre-assets.csv`）。

### 4-2 素材清單（`docs/genre-assets.csv`）

壓縮比例＝相對於原始 PNG（位元組數取自附件 CSV）。

| 輸出檔名 | 原始檔名 | 尺寸 | 處理 | 位元組 | 約 | 壓縮比例 |
|---|---|---|---|---|---|---|
| `fantasy-portrait.webp` | 奇幻類型3：4.png | 1086×1448 | 附件 WebP（品質 82，未重新壓縮） | 358,462 | 350 KB | 88.8% |
| `fantasy-portrait-600w.webp` | 奇幻類型3：4.png | 600×800 | 縮小，quality=82 method=6 | 137,714 | 134 KB | 95.7% |
| `fantasy-landscape.webp` | 奇幻類型16：9.png | 1672×941 | 附件 WebP（品質 82，未重新壓縮） | 442,478 | 432 KB | 86.8% |
| `fantasy-landscape-960w.webp` | 奇幻類型16：9.png | 960×540 | 縮小，quality=82 method=6 | 179,946 | 176 KB | 94.6% |
| `detective-portrait.webp` | 推理類型3：4.png | 1086×1448 | 附件 WebP（品質 82，未重新壓縮） | 277,712 | 271 KB | 89.7% |
| `detective-portrait-600w.webp` | 推理類型3：4.png | 600×800 | 縮小，quality=82 method=6 | 107,738 | 105 KB | 96.0% |
| `detective-landscape.webp` | 推理類型16：9.png | 1672×941 | 附件 WebP（品質 82，未重新壓縮） | 348,706 | 341 KB | 87.9% |
| `detective-landscape-960w.webp` | 推理類型16：9.png | 960×540 | 縮小，quality=82 method=6 | 139,210 | 136 KB | 95.2% |
| `historical-portrait.webp` | 歷史類型3：4.png | 1086×1448 | 附件 WebP（品質 82，未重新壓縮） | 461,584 | 451 KB | 86.6% |
| `historical-portrait-600w.webp` | 歷史類型3：4.png | 600×800 | 縮小，quality=82 method=6 | 164,098 | 160 KB | 95.2% |
| `historical-landscape.webp` | 歷史類型16：9.png | 1672×941 | 附件 WebP（品質 82，未重新壓縮） | 494,106 | 483 KB | 85.8% |
| `historical-landscape-960w.webp` | 歷史類型16：9.png | 960×540 | 縮小，quality=82 method=6 | 187,796 | 183 KB | 94.6% |
| `adventure-portrait.webp` | 冒險類型3：4.png | 1086×1448 | 附件 WebP（品質 82，未重新壓縮） | 457,674 | 447 KB | 87.1% |
| `adventure-portrait-600w.webp` | 冒險類型3：4.png | 600×800 | 縮小，quality=82 method=6 | 170,652 | 167 KB | 95.2% |
| `adventure-landscape.webp` | 冒險類型16：9.png | 1672×941 | 附件 WebP（品質 82，未重新壓縮） | 518,514 | 506 KB | 85.8% |
| `adventure-landscape-960w.webp` | 冒險類型16：9.png | 960×540 | 縮小，quality=82 method=6 | 199,318 | 195 KB | 94.6% |
| `wuxia-portrait.webp` | 武俠類型3：4.png | 1086×1448 | 附件 WebP（品質 82，未重新壓縮） | 395,108 | 386 KB | 88.0% |
| `wuxia-portrait-600w.webp` | 武俠類型3：4.png | 600×800 | 縮小，quality=82 method=6 | 146,096 | 143 KB | 95.6% |
| `wuxia-landscape.webp` | 武俠類型16：9.png | 1672×941 | 附件 WebP（品質 82，未重新壓縮） | 450,376 | 440 KB | 86.9% |
| `wuxia-landscape-960w.webp` | 武俠類型16：9.png | 960×540 | 縮小，quality=82 method=6 | 178,064 | 174 KB | 94.8% |

主圖 271～506 KB、小圖 105～195 KB，都在目標範圍（主圖 250～600 KB、小圖 80～250 KB）內。

### 4-3 載入方式

* 06 用直式、07 用獨立的橫式圖（不是把直式圖裁成橫幅）。
* 圖片框比例固定（06：3:4；07：16:9，可用高度不足時整個框等比縮小），圖片以 `object-fit: contain` 完整呈現，不裁切、不拉伸；載入前框已佔好空間，版面不跳動。
* `srcset`／`sizes`：圖片框量到實際寬度後才設定（`sizes＝框寬 px`），瀏覽器依框寬與裝置像素比在小圖與主圖間選擇；
  教師的小預覽與投影各自選擇適當尺寸，高 DPI 裝置會選較大的圖。量到之前不設定來源，因此不會先下載用不到的大圖。
* 只下載目前畫面上的那一張；總覽不顯示圖片，切換類型時才載入下一張；不預載其他類型。
* 載入中顯示「圖片載入中…」；沒有圖片時顯示替代框與描述文字（`「名稱」類型情境插畫（觀察線索）`）。
* **載入失敗時自行恢復**（不需要重新公開或重新整理投影；投影端只在公開版本改變時重繪）：替代框保留描述文字與「重新載入圖片」按鈕；
  自動重試 3 次（2、6、15 秒後），瀏覽器回到線上時再重試（最多 2 次）；永久失敗時停止自動重試，只有按按鈕才再試一次。
  每次重試用新的 `<img>`，舊的回應不會覆蓋新的；圖片框離開畫面（例如切換類型）後，重試計時、online 監聽與 ResizeObserver 全部釋放。
  教師預覽與投影各自處理自己的失敗。
* 只對本專案的類型圖卡（`assets/genres/<slug>-<portrait|landscape>.webp`）產生 srcset；其他網址只用單一來源。

## 5. 資料庫與相容策略

| 項目 | 做法 |
|---|---|
| 新欄位 | `genres.visual_landscape_url`（07 橫式圖）、`content_sets.genre_teacher_guide`（教師共同補充）；`add column if not exists`，舊資料為 null。包含在 `supabase/upgrade/upgrade.sql` |
| 圖片來源規則 | `app.genre_visual`（SQL）與 `genreVisual`（JS，教師端私下預覽 06 用）相同：06 直式優先、07 橫式優先；缺一種時回退另一種；都沒有時為 null（顯示替代框）。預覽與公開呼叫同一個 SQL 函式 |
| 公開白名單 | 06／07 投影只多了 `visual_source`（portrait／landscape）；`teacher_notes`、`genre_teacher_guide` 不在任何公開回應 |
| 揭露規則 | 不變：未揭露的特色文字不在投影 API；圖卡本身是情境提示，**無法**隱藏圖中可見的所有線索 |
| 教材更新 | `supabase/content/genre_materials_v1.sql`：只更新預設素材組中 slug 相符的五筆；不新增、不刪除、不改 id 與 `sort_order`；順序不是 fantasy→wuxia 時中止；2 小時內有動作的進行中場次存在時中止；第一次執行時把原內容備份到 `app.genre_material_backups`（前端讀不到） |
| 回復 | `supabase/content/genre_materials_v1_rollback.sql`：從備份還原文字與圖片欄位（同樣的防護） |
| 既有場次 | 不改寫 `session_state` 的 projection、disclosure、stage_ctl 與快照。已公開在投影上的舊文字，要等教師重新切換或公開該畫面才會換成新版（返回 06／07 時伺服器依原本的選擇與揭露範圍以新教材重建） |
| 共用素材 | 同一素材組的所有場次共用這些教材；請在沒有課堂時更新 |
| 佔位 seed | 不修改、不需要重跑；全新安裝時在 seed 之後執行教材腳本 |
