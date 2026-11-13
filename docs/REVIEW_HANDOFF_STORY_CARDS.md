# 複檢交接：第 03、04 環節故事卡正式教材與雙面閱讀卡

## 1. 版本與範圍

| 項目 | 內容 |
|---|---|
| base | `main` = `df6fcd8d75c393c052633bb7b56bc3175a5b324f`（PR #8 合併；內容＝小說類型教材最後受檢版本 `f565267`，兩者樹相同） |
| 分支 | `claude/epic-franklin-c9v5yl`（舊的 Phase 3 分支已合併到 main，依規則從最新 main 重新開始；舊提交都已在 main 中） |
| head | 見 PR 說明（本文件在 head 之前提交，不寫自己的 SHA） |

範圍：第 03、04 環節的故事卡內容、圖片與閱讀介面。**沒有修改**學生分類、快照、操作鎖、儲存佇列、版本檢查、提交、解鎖與交易規則；
小說類型教材與 06／07 的投影規則不變（只把 06／07 的圖片框程式抽成共用模組，行為相同）。

## 2. 附件與來源

* `分類用故事卡.zip`：8 張圖片＋`小卡故事分類小卡_八部作品最新版.docx`。已取得並使用（原檔在 `source-assets/stories/`）。
* `動物方城市_正反面樣張.html`：視覺參考。正式介面沒有放入樣張的頁面標題、說明與檢視模式選單。

## 3. 變更檔案

| 檔案 | 內容 |
|---|---|
| `assets/stories/story-NN.webp`、`story-NN-600w.webp` | 16 張 WebP（閱讀圖寬 1200、縮圖寬 600，q85） |
| `source-assets/stories/` | 8 張原始圖與 Word 原稿（網站不使用；`tests/lib/static-site.js` 的測試伺服器也不提供） |
| `tools/story_images.py`、`docs/story-assets.csv` | 可重複的轉檔工具與素材對照表（尺寸、位元組、壓縮設定、PSNR、SHA-256） |
| `tools/story_text.py`、`docs/story-cards-source.json` | 直接讀 docx 抽出正式文字（不改寫）；JSON 為抽出結果，測試與 SQL 都由它產生／比對 |
| `supabase/migrations/002_rpc.sql` | `story_cards.elements jsonb not null default '[]'`＋陣列檢查；`student_cards` 多回傳 `elements` |
| `supabase/checks/verify.sql` | 檢查 16 加上 `story_cards.elements`（仍是 17 列） |
| `supabase/upgrade/upgrade.sql` | 重新產生 |
| `supabase/content/story_cards_v1.sql`、`..._rollback.sql` | 正式教材更新與回復（交易、順序與上課預檢、備份、預期筆數） |
| `js/lib/visual.js` | 由 `render-projection.js` 抽出的圖片框（行為不變），新增 `retryButton` 選項與 `visualAlive()` |
| `js/lib/story.js` | 故事圖片來源、編號、段落、元素；雙面閱讀卡 `openStoryReader` |
| `js/lib/board-view.js` | 看板小卡（編號、縮圖、名稱、「閱讀」）；縮圖跨重畫沿用；閱讀改用新閱讀卡；選取移動時不開啟閱讀卡 |
| `js/lib/render-projection.js` | 改用 `visual.js`；07 投影的故事小卡用 600w 縮圖 |
| `css/app.css` | 看板小卡、`.st-visual.story`、閱讀卡（翻面、平面化、減少動態效果）、07 小卡 `object-fit: contain` |
| `tests/db/story_cards.sh`（`run.sh` 會執行）、`tests/db/upgrade_bundle.sh` 第 9 節 | 教材腳本與升級 |
| `tests/e2e/story_reader.js`、`story_shots.js`、`setup_story_db.sh` | 瀏覽器驗證、截圖與錄影 |
| `tests/unit/story.test.mjs`、`tests/supabase/run.sh`、`api_test.mjs` | 單元測試；真實 PostgREST 檢查 |
| `docs/STORY_CARDS.md`、`docs/DEPLOY.md`（A-2 第 6 列、D、I 節）、`docs/TESTING.md`、`README.md`、`docs/screenshots/stories/` | 文件與截圖 |

## 4. 設計重點與可能的風險

1. **資料相容**：只加欄位（有預設值），`student_cards` 只多一個鍵；舊網站不讀 `elements`。教材腳本依 slug 一對一更新，id／slug／sort_order 不變，所以以 id 記錄的分類、提交與快照都不受影響。
2. **名稱在顯示時才讀取**：舊場次成果會顯示新名稱與圖片（分類不變）；已公開的 05／07 投影保留舊名稱直到重新公開。這是共用素材的既有設計，未改變。
3. **閱讀是本機狀態**：閱讀卡由 `openStoryReader` 建立，不呼叫 `onChange`、不取得操作鎖、不送出請求（測試以請求紀錄與 `groups.board_rev` 確認）。
4. **巢狀按鈕**：看板縮圖在「閱讀」按鈕裡，所以縮圖的替代框不放重新載入按鈕（`retryButton: false`），仍會自動重試；閱讀卡的大圖有按鈕。
5. **縮圖跨重畫沿用**：看板每次同步都會重畫；每張卡的圖片框存在 `thumbs` Map 中、重畫時移到新位置（不重新下載、不閃爍）。圖片框已被釋放（`visualAlive` 為 false）時才重建。
6. **翻面**：動畫中的再次翻面會被忽略（`busy`，在 transitionend 或 550ms 保險計時後解除）；結束後加 `.flat` 去除 3D 變形，隱藏面 `visibility: hidden`＋`inert`。
7. **焦點限制**：`showModal()` 本身讓頁面其他部分 inert，但 Chromium 允許 Tab 移到瀏覽器介面；另加 Tab／Shift+Tab 循環（只在可見、非 inert 的按鈕與閱讀區之間）。
8. **summary 清空**：原稿沒有摘要；舊版「方案 C」小卡的摘要列已移除。教師端若有地方顯示摘要，會是空字串（目前沒有）。

## 5. 建議複檢重點

1. 原稿抽取規則（`tools/story_text.py`）是否正確處理 05 套用標籤樣式的段落與空段落；資料庫內容是否逐字等於原稿。
2. 教材腳本的守門條件、備份只寫一次、回復逐欄位還原；與小說類型教材腳本互不影響。
3. 閱讀卡在快速連點、Escape、點背景關閉、翻面中關閉時的狀態；隱藏面是否真的不可聚焦。
4. 看板縮圖重用（`thumbs`）在小組同步重畫、拖曳中延後重畫、唯讀切換時是否正確；被移除的卡（例如教師檢視關閉）是否釋放。
5. 選取移動時點閱讀入口＝放到該區（既有行為），是否會讓學生困惑。

## 6. 實際執行的測試（2026-11-13，本機；觸控皆為 Playwright 模擬）

| 指令 | 結果 | 備註 |
|---|---|---|
| `npm run test:unit` | 41 通過 | 含新的 `story.test.mjs`（5 項） |
| `npm run test:db` | 340 項 ok，全部通過 | 含 `story_cards.sh` 8 項 |
| `npm run test:race`／`test:upgrade`／`test:concurrency` | 16／28／通過 | upgrade 含第 9 節（從已部署的 df6fcd8＋停在 04 的場次升級、再套用教材） |
| `tests/e2e/e2e.js`（shim，佔位故事 A～H） | 258 通過 | 舊資料相容路徑（沒有元素、沒有圖片） |
| `layout.js`／`touch.js` | 80／39 通過 | |
| `genre_shots.js`／`genre_visual_lifecycle.js`／`genre_image_retry.js` | 30／56／26 通過 | 圖片框抽成 `visual.js` 後的回歸 |
| `tests/e2e/story_reader.js`（sf_story） | 109 通過 | 最後一次在 3:2 圖片裁切修正之後執行 |
| `tests/supabase/run.sh`（本機 Supabase 堆疊） | 72 項 ok，全部通過 | 含故事卡教材腳本與 3 項真實 PostgREST 檢查 |
| `tests/supabase/e2e_real.sh` | Realtime 7、touch 39、e2e 258 通過 | |

在 3:2 圖片修正（只改 `.st-visual.story img` 的 CSS 與 `story_reader.js`）之後重新執行的是 `story_reader.js`、`story_shots.js` 與 Supabase 兩套；
其餘套件是在修正之前執行（佔位資料沒有故事圖片，不經過該 CSS）。

開發中發現並修正（測試已涵蓋）：

* Tab 可以把焦點移出對話框（Chromium 允許移到瀏覽器介面）→ 加上 Tab 循環。
* 3:2 的《神奇柑仔店》在 16:9 外框中被上下裁切（圖片元素取自身高度，外框 overflow 裁掉）→ 圖片絕對定位填滿外框再 contain；測試改為量測實際畫出的區域。

## 7. 尚未驗證

* 實體平板、手機、互動白板；觸控結果都是 Playwright 模擬（hasTouch）。只測 Chromium，沒有測 Safari（含 iOS 的 `inert`、`backface-visibility` 與 `srcset` 選擇）與 Firefox。
* 正式 Supabase 專案（升級與教材腳本只在本機隔離的資料庫與本機 Supabase 堆疊執行）。
* 螢幕閱讀器（VoiceOver／TalkBack）的實際朗讀；只以 `inert`、`aria-hidden`、`aria-labelledby` 的屬性檢查。
* 真實不穩網路下的圖片載入（以 404 模擬）。
* 新網站＋未升級資料庫、舊網站＋新資料庫的混搭。
