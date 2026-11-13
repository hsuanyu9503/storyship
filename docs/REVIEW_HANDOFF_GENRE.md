# 交接報告：請協助複檢「小說類型教材」整合（第 06、07 環節）

> 給複檢者：請以「找出錯誤」為目標。本文件的測試數字是作者在本機執行的結果，不是你的驗證結果；與程式碼不一致時以程式碼為準。

## 1. 版本與範圍

| 項目 | 內容 |
|---|---|
| Repo | `github.com/hsuanyu9503/storyship` |
| base | `main` = `6405692bbdd5e968d1a6bc56bf207e0fad36f7fd`（PR #7 合併；內容＝上一輪審查版本 `cf4859c378f08c13266723985c01eec1b9f93207`，`git diff` 為空） |
| head | 分支 `claude/genre-materials`（完整 SHA 見 PR 說明） |
| 依賴 | 不依賴任何未合併的 PR |
| 範圍 | 只整合第 06、07 的類型教材與用語；學生分類、快照、操作鎖、交易規則都沒有修改 |

另外修正一個既有的版面缺陷：07 左側 8 張故事的卡片會超出面板、被句型鷹架或理由列蓋住（在 `6405692` 上以新的版面檢查重現）；Phase 5 的版面檢查只比對會裁切的祖先，沒有偵測「超出面板、被其他區塊蓋住」，已補上。

## 2. 附件

`小說類型圖卡.zip`：12 個項目（10 張 WebP、`README.txt`、`素材清單.csv`），路徑安全（無絕對路徑、`..`、符號連結）。
**附件中是已轉好的 WebP（品質 82、原始尺寸、sRGB），沒有原始 PNG**；原始 PNG 檔名與位元組數取自附件的 CSV。
主圖直接使用附件檔案（逐位元組相同）；小圖由本專案的 `tools/genre_images.py` 產生。五類對應已逐張目視確認（推理→detective）。

## 3. 變更檔案

| 檔案 | 內容 |
|---|---|
| `assets/genres/*.webp`（20 張） | 五類 × 直式／橫式 × 主圖／小圖 |
| `tools/genre_images.py`、`docs/genre-assets.csv` | 可重現的轉檔工具與素材清單 |
| `supabase/migrations/002_rpc.sql` | 第 40–41 行：`genres.visual_landscape_url`、`content_sets.genre_teacher_guide`；第 1186 行 `app.genre_visual`；第 1149 行（07 `match_build`）、第 1276 行（06 `genre_build`）改用它 |
| `supabase/content/genre_materials_v1.sql`（新增）、`genre_materials_v1_rollback.sql`（新增） | 教材更新與回復（依 slug、有防護與備份） |
| `supabase/checks/verify.sql` | 第 16 項加入兩個新欄位與 `app.genre_visual` 的權限（仍為 17 列） |
| `supabase/upgrade/upgrade.sql` | 由 `build.sh` 重新產生 |
| `supabase/rollback/phase4_to_phase3.sql` | 加入 `app.genre_visual` |
| `js/lib/phases.js` | 06 名稱、子步驟、`scaffold`、`matchQuestion`、`featureHidden`、`featureHiddenShort` |
| `js/lib/projection.js` | 第 107 行 `genreVisual`（與 SQL 相同規則）；06 私下預覽用 |
| `js/lib/render-projection.js` | 第 23 行 `genreSources`、第 34 行 `genreVisualBox`（srcset／sizes、載入中、替代框）；06 三列常見特色；07 橫式圖、未揭露提示、引導問句；07 左側故事較多時改為三欄名稱標籤 |
| `js/teacher/main.js` | 第 174 行讀取教師共同補充；第 179 行 `teacherGuide`；06 面板用語與教師補充 |
| `js/teacher/results.js` | 07「常見特色」用語、所選類型的教師補充 |
| `css/app.css` | `.st-visual`（3:4／16:9、contain）、06 三列、07 圖片區、總覽、教師補充樣式 |
| `tests/db/genre_materials.sh`（新增）、`tests/db/run.sh`、`tests/db/upgrade_bundle.sh`（第 8 節） | 資料庫與升級測試 |
| `tests/unit/genre-visual.test.mjs`（新增） | 圖片來源規則、縮圖對應 |
| `tests/e2e/e2e.js`、`setup_db.sh`、`touch.js`、`layout.js`、`genre_shots.js`（新增） | 新文字、圖片與網路檢查、版面量測（加入「超出面板／重疊」偵測）、截圖 |
| `tests/supabase/run.sh`、`api_test.mjs`、`e2e_real.sh` | 真實堆疊上套用教材腳本並檢查教師補充權限 |
| `docs/GENRE_MATERIALS.md`（新增）、`docs/DEPLOY.md`（A-2、D、H 節）、`docs/TESTING.md`、`README.md`、`docs/screenshots/genre/`（11 張 WebP 截圖） | 文件 |

## 4. 設計重點與可能的風險

| 項目 | 說明 |
|---|---|
| 排序與索引 | 揭露紀錄與 07 的選擇以「類型索引」記錄。教材腳本不改 `sort_order`；順序不是 fantasy→wuxia 時整筆中止 |
| 共用素材 | 同一素材組的所有場次共用；腳本在 2 小時內有動作的進行中場次存在時中止 |
| 已保存的投影 | 不改寫 `session_state`；舊文字保留到教師重新切換或公開（db 測試以雜湊確認） |
| 預覽＝公開 | 07 預覽與公開呼叫同一個 `app.match_build`；06 公開由 `app.genre_build` 產生，教師端私下預覽用 JS `genreVisual`（規則相同，unit 測試逐條對照） |
| 教師補充 | 只在 `genres.teacher_notes`、`content_sets.genre_teacher_guide`（教師 RLS）；不在 JS 原始碼、不在公開回應 |
| 圖片揭露 | 未揭露的特色文字不在投影 API；但圖卡本身可能透露線索——這是教材設計（情境提示），不是程式能隱藏的 |
| srcset 時機 | 圖片框量到寬度後才設定來源。`ResizeObserver` 不可用時退回單一 `src`（主圖） |
| 07 版面上限 | 「30 字分類名稱＋8 張故事＋300 字理由＋句型鷹架」同時達上限時放不下：教師預覽會提醒；關閉句型鷹架即完整可見。150 字理由＋4 張故事＋句型鷹架完整可見 |
| 混搭 | 新網站＋未升級資料庫、舊網站＋新資料庫：依設計可顯示，**未以瀏覽器實測** |

## 5. 建議複檢重點

1. `genre_materials_v1.sql` 的防護：順序檢查、進行中場次判斷（`updated_at` 2 小時）、`row_count <> 5` 時是否真的整筆回復；備份只寫一次；`app.genre_material_backups` 權限。
2. `app.genre_visual` 與 `genreVisual` 是否完全一致（空白字串、null、只有一種圖）。
3. 公開回應（`projector_state`、`teacher_preview_*` 的 projection）是否可能夾帶 `teacher_notes`、`genre_teacher_guide` 或未揭露的特色。
4. `genreVisualBox`：srcset 在 `sizes` 之後設定、`ResizeObserver` 在元素被移除後是否有殘留、錯誤處理是否會重試。
5. 07 左側卡片的切換門檻（顯示理由時 >3、未顯示時 >6 改為名稱標籤）是否在實際教室投影可讀。

## 6. 實際執行的測試

2026-11-13，本機（PostgreSQL 16、Node 22、Playwright Chromium headless、Docker 29）。「shim」＝`tests/e2e/shim.js`（沒有 Realtime）；
「本機 Supabase」＝`tests/supabase/` 的 Supabase 官方 Postgres 映像檔＋GoTrue＋PostgREST＋Realtime。**都不是正式雲端專案或實體裝置。**

| 指令 | 環境 | 結果 |
|---|---|---|
| `npm run test:unit` | Node | 36／36 通過（新增 `genre-visual.test.mjs` 2 項） |
| `npm run test:db` | PostgreSQL | 324 項＋`genre_materials.sh` 8 項，全數通過 |
| `npm run test:race` | PostgreSQL 多連線 | 16 情境通過 |
| `npm run test:upgrade` | PostgreSQL＋git | 26 項通過（新增：從已部署的 `6405692`＋停在 07 的場次升級、套用教材後返回 07 重建） |
| `npm run test:concurrency` | PostgreSQL＋pgbench | 通過 |
| `node tests/e2e/layout.js` | shim | 80 項通過（20 種內容 × 1920×1080、1600×900、1280×720、1024×768） |
| `node tests/e2e/touch.js` | shim | 39 項通過 |
| `node tests/e2e/e2e.js` | shim | 258 項，連續 2 次通過 |
| `node tests/e2e/genre_shots.js` | shim | 30 項通過（五類 06 直式／07 橫式，投影 1600×900、1920×1080；教師 iPad 橫向／直向） |
| `bash tests/supabase/run.sh` | 本機 Supabase | 68 項通過（含以 postgres 角色套用教材腳本、教師補充只有教師可讀） |
| `bash tests/supabase/e2e_real.sh` | 本機 Supabase | Realtime 中斷與恢復 7、touch 39、完整 e2e 258，全數通過 |

修正前的證據：07 左側卡片超出面板——在 `6405692` 上以新的 `layout.js` 執行，三個 07 上限情境都判定被裁切（含「理由未顯示」時第三列卡片被句型鷹架蓋住）。

圖片選用（`genre_shots.js` 的紀錄）：投影 1600×900 時 06 圖片框 564px → 選 600w；1920×1080 時 677px → 選主圖；07 橫式框 360～434px → 選 960w；
教師 iPad（裝置像素比 2）橫向 368px → 主圖、直向 273px → 600w。每個畫面只下載目前類型的一張圖，全部是 `image/webp`，沒有重複下載。

## 7. 尚未驗證

正式（雲端）Supabase 專案上執行升級與教材腳本、實體平板與手機、實際投影機的色彩與可讀性（包含圖片色彩在投影機上的呈現）、學校網路下的圖片載入時間、iOS Safari 的 srcset 選擇。

## 8. 獨立複檢的回應（`5892a30`）

| # | 嚴重度 | 項目 | 在 `5892a30` 上重現？ | 修正 | 測試 |
|---|---|---|---|---|---|
| F1 | P2 | 圖片短暫載入失敗後，連線恢復也無法在同一個公開版本下重試 | ✅ 重現（06、07 都停在替代框；沒有重試按鈕） | `js/lib/render-projection.js` `genreVisualBox`：失敗時保留替代框與「重新載入圖片」按鈕；自動重試 3 次（2、6、15 秒後）；`online` 事件時重試（最多 2 次）；每次重試用新的 `<img>`，舊 `<img>` 的事件忽略；永久失敗時停止自動重試 | `tests/e2e/genre_image_retry.js` 16 項：在 `5892a30` 上 6 項失敗（06／07 恢復、重試按鈕、手動重試、ResizeObserver 釋放、教師預覽恢復），修正後全過 |
| 補強 1 | 待驗證 | ResizeObserver 沒有清理 | ✅（建立 4、disconnect 0） | 圖片框離開畫面時（ResizeObserver 回報或建立新圖片框時的掃描）釋放計時器、`online` 監聽與 ResizeObserver | 連續切換 10 次：建立 14、disconnect 13、畫面上 1 |
| 補強 2 | 已知限制 | 07 四項同時達上限放不下 | — | 不變：教師預覽提醒、關閉句型鷹架即完整可見（`layout.js`） | — |
| 補強 3 | 說明 | 2 小時檢查不是維護鎖 | — | 不變；`DEPLOY.md` H 節已要求在沒有課堂時更新。腳本中的檢查是預檢，不保證與授課操作並行時的原子性 | — |

`genre_image_retry.js` 涵蓋：06 第一次失敗→自動恢復（rev 不變）、07 第一次失敗→`online` 恢復（rev 不變）、永久 404 的上限（30 秒內 4 次）與停止、手動重試一次只多一個請求、
重試期間切換類型後舊圖不再請求且不覆蓋新圖、成功的圖不重複下載、教師預覽與投影各自恢復、ResizeObserver 釋放。

複檢修正後重新執行（2026-11-13，本機；只修改 JS／CSS，資料庫測試未重跑）：unit 36、`layout.js` 80、`touch.js` 39、`genre_shots.js` 30、`genre_image_retry.js` 16、
`e2e.js`（shim）258、`tests/supabase/e2e_real.sh`（本機 Supabase：Realtime 7、touch 39、e2e 258），全數通過。

## 9. 第二次獨立複檢的回應（`ebe6ba3`）

| # | 嚴重度 | 項目 | 在 `ebe6ba3` 上重現？ | 修正 | 測試 |
|---|---|---|---|---|---|
| F1 | P2 | 重試按鈕在教師縮小預覽中只有約 38×10px、字級 4.6px，並覆蓋觸控 44px 規則 | ✅ 重現（1366×1024 觸控、預覽欄 356px：38.2×9.8px、4.628px、`min-height: 0`） | `css/app.css`：按鈕字級下限 15px、觸控裝置至少 44px，空間不夠時描述文字讓位、按鈕不縮；教師端 `.previews` 內不顯示這顆按鈕，改在預覽下方顯示一般大小的「重新載入預覽圖片」（`js/teacher/main.js`，以 `st-visual` 事件更新；`retryVisuals()` 只重試教師端自己失敗的圖，每個框一個請求） | `genre_visual_lifecycle.js` A 部分（投影觸控 1024×768／1600×900／1920×1080，06 直式、07 橫式：≥44px、字級 ≥15px、完整在圖片框與投影內；自動重試用完後點一下只多一個請求）；`genre_image_retry.js` 第 8 項（真正的教師主控台，觸控 1366×1024、1024×768：預覽內小按鈕不顯示、下方按鈕 159×44px、點一下每個失敗預覽圖只多一個請求、投影端不受影響） |
| F2 | P3 | 第一次 ResizeObserver 回呼前就被替換的圖片框，停在無圖畫面時永不釋放 | ✅ 重現（同一工作內重繪 20 次後停在等待畫面 7 秒：建立 20、disconnect 1） | `js/lib/render-projection.js`：只在還有圖片框時存在的每秒掃描計時器（全部釋放後停止）；未掛上畫面的寬限 5 秒（`>=`）；dispose 後所有回呼（計時器、RO、load／error）都不再有副作用；手動、online、計時器三種重試共用 `c.retry()`，失敗狀態才會發請求，不會同時發兩個 | `genre_visual_lifecycle.js` B 部分：快速重繪 20 次後 7 秒內全部釋放（20／20）、被取代的框不發請求、建立後從未掛上的框寬限後釋放、請求中移除（成功／失敗）都釋放且失敗後不再重試 |

修正前對照：`probe_f1f2_before_after.log`（同一支只用兩版共有選擇器的探測程式分別在 `ebe6ba3` 與修正後執行）。新測試直接拿到 `ebe6ba3` 執行時，因依賴新增的 `.failed` 類別／`visualBoxCount()` 而在前置步驟就失敗，不能當作對照，故另附探測紀錄。

修正後重新執行（2026-11-13，本機；只修改 JS／CSS／測試／文件，資料庫測試未重跑）：unit 36、`layout.js` 80、`touch.js` 39、`genre_shots.js` 30、
`genre_visual_lifecycle.js` 32、`genre_image_retry.js` 26、`e2e.js`（shim）258，全數通過。本機 Supabase（`tests/supabase/e2e_real.sh`）：Realtime 7、touch 39、e2e 258，全數通過。

## 10. 第三次獨立複檢的回應（`87f1853`）

| # | 嚴重度 | 項目 | 在 `87f1853` 上重現？ | 修正 | 測試 |
|---|---|---|---|---|---|
| F1 | P3 | 07 極端內容下，投影的重試按鈕超出被壓矮的橫式圖片框而被裁切 | ✅ 重現（1024×768：按鈕 122×44px、圖片框 109×61px；1600×900、1920×1080，有／無句型鷹架共 6 個情境都超出） | `js/lib/render-projection.js` `fit()`：失敗時與框尺寸改變時量測完整按鈕是否落在框內，放不下就加上 `.compact`，改為只有圖示「↻」的 44×44 圓形按鈕（`aria-label`「重新載入圖片」），描述文字保留給螢幕閱讀器；不縮小字級或觸控尺寸。另外，重試開始時也發出 `st-visual` 事件，教師端的「重新載入預覽圖片」在重試中先隱藏 | `genre_visual_lifecycle.js` A 部分新增 07 極端內容（8 張故事＋30 字名稱＋300 字特色，有／無句型鷹架）× 3 種尺寸，並加上「不與其他內容重疊」「中心點可點中」「aria-label」檢查：共 56 項全過；同一支測試在 `87f1853` 上 12 項失敗（6 項極端情境超出圖片框，另 6 項是舊版沒有 `aria-label`） |

修正後重新執行（2026-11-13，本機；只修改 JS／CSS／測試／文件）：unit 36、`layout.js` 80、`touch.js` 39、`genre_shots.js` 30、`genre_visual_lifecycle.js` 56、
`genre_image_retry.js` 26、`e2e.js`（shim）258，全數通過。這一輪沒有重跑資料庫類測試與本機 Supabase（`e2e_real.sh`）；後者最後一次是在 `87f1853` 執行（全部通過）。
