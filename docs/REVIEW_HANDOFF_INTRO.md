# 複查交接：第 01 環節「走進故事世界」複查修正

## 1. 版本

| 項目 | commit |
|---|---|
| 受檢（修正前） | `cc8e4fa97721f783d9766321530e32a204e91188` |
| 修正 | `50aed21`（P1、P2 鍵盤、P2 回復、快速雙點）、`b6afbca`（發布範圍）、本文件所在的提交（測試等待、文件） |
| 修正後 head | 見交付訊息（本文件在 head 之前提交，不寫自己的 SHA；`git log cc8e4fa..origin/claude/epic-franklin-c9v5yl`） |

開始時核對：`HEAD` 與 `origin/claude/epic-franklin-c9v5yl` 都是 `cc8e4fa`，沒有後續提交，四項問題都仍存在。
定稿的投影文案、兩張揭曉圖與 01 → 02 → 03 的順序都沒有改。沒有合併、沒有部署、沒有在正式資料庫執行 SQL。

## 2. 結果總覽

### 已修正並驗證

| # | 問題 | 修正位置（修正後的行號） | 修正前重現 | 修正後 |
|---|---|---|---|---|
| P1 | 舊場次 `{view:'crossroads', seen:[0]}` 按上一步會公布第二則 | `js/lib/projection.js:124-152`（`validSeen`、`introBack`）：比較／交會返回時回到 `seen` 中實際已公布的最後一則；沒有有效紀錄回到開場；從後一則開頭返回時前一則只在 `seen` 中才顯示答案；返回不增加 `seen` | `tests/unit/intro-flow.test.mjs` 新增 6 項，在 `cc8e4fa` 的 `projection.js` 上 4 項失敗 | 12／12 通過 |
| P2 | 轉場頁按 → 或 PageDown 停在 01 | `js/teacher/main.js:424-459`：主要按鈕、鍵盤、簡報筆共用 `intro('next')`；轉場頁（`introNext` 回傳 null 且 `view === 'bridge'`）才 `goPhase('02')`；主要按鈕第 498 行改用同一動作。保留 `S.busy`、`e.repeat`、輸入欄位與對話框的保護 | `tests/e2e/intro_keys.js` 在 `cc8e4fa` 上：PageDown 與 → 兩組各 4 項失敗（停在 01，版本不變） | 全部通過：只用 PageDown（另一組只用 →）走 13 步到轉場，再按一次 → 教師端與投影端都是 02，版本只 +1，之後再按不變 |
| P2 | 回復腳本在線索多出第 4 條時仍成功 | `supabase/content/intro_materials_v1_rollback.sql:21-27`：寫入前比對兩則的完整線索序號，必須恰好是 intro-1:1,2,3、intro-2:1,2,3；否則「線索不符」整筆中止 | `tests/db/intro_materials.sh` 第 6 節在 `cc8e4fa` 的回復腳本上失敗（回復成功提交，留下舊故事＋第 4 條） | 第 6 節全過：多一條、錯置（第二則 2→5）、缺少（第一則沒有第 3 條）都中止且資料不變（故事、全部線索含第 4 條、`intro_text`）；恢復正常結構後完整回復 |
| 風險 2 | 快速雙點會略過揭曉頁 | `js/teacher/main.js:432-450`：前進成功後 0.7 秒冷卻（`S.introHold`），期間「下一步」被忽略、主要按鈕停用；由轉場頁進入 02 後 0.7 秒內 `goPhase` 被忽略（第 273 行，`S.navHold`） | **可重現**：`cc8e4fa` 上第一下「公布作品」完成刷新用 90ms，第二下在第一下後 150ms 送出 → 版本 6 → 8，直接進入神祕故事二（跳過揭曉頁）；另外鍵盤兩下間隔 100ms 也前進兩步 | 同一情境（刷新 88ms、第二下 149ms）：只公布一次、停在柯南揭曉頁；之後的有意操作（約 2 秒後）可前進到神祕故事二；鍵盤兩下間隔 100ms 只前進一步 |
| 風險 1 | 答案稿隨網站公開 | 新增 `tools/build_site.sh`（允許清單）、`.github/workflows/pages.yml`（只發布 `_site`）；`docs/DEPLOY.md:59-74` 改為 Source「GitHub Actions」並說明風險 | 本機設定確認：DEPLOY.md 原本是「Deploy from a branch」＋根目錄，repo 有 `.nojekyll`，會原樣公開 `docs/intro-source.json`、`docs/screenshots/intro/`、`source-assets/intro/` | `tests/e2e/site_build.js` 14 項：產物只有 4 個頁面、`config.js`、`js/`、`css/`、`assets/`；文字檔沒有答案；答案稿、Word 原稿、揭曉截圖、SQL 網址皆 404；兩張揭曉圖與 repo 逐位元組相同並在 1920×1080、1024×768 實際載入 |

### 未能重現

* 無（四項問題與兩項風險都在 `cc8e4fa` 上重現）。

### 尚未執行／無法在本環境確認

* **正式站狀態**：這個工作環境連不到 `hsuanyu9503.github.io`（代理拒絕連線），無法確認正式站目前用哪種發布方式、答案稿網址是否可讀。
  GitHub Pages 的 Source 設定只能由 repo 擁有者在 Settings 變更；合併 `.github/workflows/pages.yml` 之後，仍需手動把 Source 改為「GitHub Actions」，否則分支發布會繼續公開所有檔案。
* **repo 本身是公開的**（`list_repos` 顯示 visibility: public）：即使網站不發布，`docs/`、`source-assets/` 仍可在 github.com 讀到。是否改為私人或移出原稿，需要使用者決定，本次沒有變更。
* workflow 本身沒有在 GitHub Actions 上實際執行過（分支尚未合併到 main）；只在本機執行 `tools/build_site.sh` 與其測試。
* 實體簡報筆、實體平板的雙點間隔與按鍵行為未實測（皆為 Playwright Chromium 模擬）。
* 本機 Supabase 堆疊（Docker）在本輪沒有重跑（修改不涉及資料庫結構與權限；`supabase/upgrade/upgrade.sql` 未變）。

## 3. 已知限制（本次修正帶來的取捨）

* 冷卻 0.7 秒：老師在 0.7 秒內連續按「下一步」，第二下會被忽略（按鈕顯示停用）。上一步不受影響。
* 由轉場頁進入 02 後 0.7 秒內，環節切換按鈕的點擊會被忽略，且沒有額外提示（`intro_flow.js` 為此在進入 03 前等待 0.8 秒）。

## 4. 測試步驟與實際結果（2026-11-14，本機隔離環境）

```bash
npm run test:unit                                  # 53 通過（intro-flow 12 項，其中 P1 新增 6 項）
bash tests/db/intro_materials.sh                   # 9 項 ok（第 6 節為回復完整性）
npm run test:db                                    # 349 項 ok
npm run test:upgrade                               # 30 項 ok
cd tests/e2e
node site_build.js                                 # 14 通過（不需要資料庫）
./setup_db.sh && node e2e.js                       # 259 通過（需要 sf_e2e 的 shim：PORT 8787）
./setup_story_db.sh
PORT=8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node shim.js &
BASE=http://localhost:8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node intro_keys.js     # 16 通過
BASE=http://localhost:8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node intro_flow.js     # 101 通過
BASE=http://localhost:8789 DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_story node story_reader.js   # 109 通過
```

重現修正前的結果：把 `cc8e4fa` 簽出到另一個資料夾，用 `ROOT=<該資料夾> PORT=8790` 啟動 shim，
執行 `BASE=http://localhost:8790 node intro_keys.js`（12 項失敗）；單元測試與回復測試則以 `git show cc8e4fa:<檔案>` 暫時換回舊檔案執行。

快速雙點測試的點擊方式：`page.touchscreen.tap` 在主要按鈕中心點擊第一下，輪詢到伺服器版本 +1 且按鈕文字已換掉（約 90ms），
再於同一座標送出第二下，第二下距第一下約 150ms（上限設定 `DOUBLE_MS=300`，可用環境變數調整）。

---

# 第二輪複查修正（基準 `75f7775647743c22570a66c8e6162ade0d625f9d`）

開始時核對：`HEAD`＝`origin/claude/epic-franklin-c9v5yl`＝`75f7775`，沒有後續提交；兩項問題都可重現。
修正提交：`ace3e6c`（程式與測試）、本段文件所在的提交（文件）。修正後 head 見交付訊息。沒有變更 Pages 設定、合併、部署或操作正式資料庫。

## 已修正並驗證（本輪實際執行）

| # | 問題 | 修正位置（修正後行號） | 修正前（`75f7775`） | 修正後 |
|---|---|---|---|---|
| P1 | 舊場次 `crossroads`、`seen=[0]` 按下一步，比較題（提到「新一」「千尋」）提前投影 | `js/lib/projection.js:52-54`（`validSeen`、`firstUnrevealed`、`allRevealed`）、`:69-78`（compare 只在兩部都公布時放比較題與命名題）、`:111-135`（`introNext`：交會／比較／揭曉後先前往尚未公布的第一則，線索從 0 開始，保留 seen）、`:163-180`（按鈕文字） | 以正式教材執行：seen=[0]／[1]／[] 下一步都進入 compare，prompts 含「新一最怕誰認出他？千尋為什麼要記住自己的真名？」。單元測試新增 6 項中 5 項失敗；`intro_legacy.js` 在 75f7775 上 6 項失敗（投影出現「千尋」） | 單元測試 18／18（intro-flow）；`intro_legacy.js` 32／32 |
| P2 | `tools/build_site.sh` 在檢查前遞迴刪除輸出目錄 | `tools/build_site.sh:1-57`（第 21-44 行：所有檢查在刪除／寫入前；只清理專案的 `_site` 且需空或有標記檔；專案內其他路徑、專案外既有路徑、符號連結一律拒絕；相對路徑依呼叫時目錄解析、上層以實體路徑核對） | 拋棄式副本中：15／19 失敗，例如傳 `assets` 時副本的 `assets` 被刪（標記檔消失）、既有資料夾與符號連結目標被覆寫 | `site_build_safety.sh` 19／19；`site_build.js` 14／14（產物多一個空的標記檔 `.storyship-site-build`） |

`intro_legacy.js` 的檢查方式：從正常教師入口建立場次並啟動 01，把 `session_state.projection` 寫成舊版交會畫面（舊版格式），
重新整理教師端後只用畫面上的按鈕操作；每一步讀取資料庫中的整份投影、投影端最後一份 API 回應、投影畫面文字、圖片 src／srcset／alt，
確認沒有未公布那一部的作品名、兩個主角姓名、揭曉文、圖片檔名與比較題中的主角字（新一／千尋）。

## 本輪實際執行的測試與結果（2026-11-14，本機隔離環境）

| 指令 | 結果 |
|---|---|
| `npm run test:unit` | 59 通過、0 失敗 |
| `bash tests/e2e/site_build_safety.sh` | 19 通過 |
| `node tests/e2e/site_build.js` | 14 通過 |
| `node tests/e2e/intro_legacy.js`（sf_story） | 32 通過 |
| `node tests/e2e/intro_flow.js`（正常新場次全流程，含上一步、比較 → 命名 → 轉場 → 02 → 03） | 101 通過 |
| `node tests/e2e/intro_keys.js`（鍵盤全程、轉場頁進入 02、快速雙點） | 16 通過 |
| `node tests/e2e/e2e.js`（佔位資料全課程，教師預覽含答案的檢查在內） | 259 通過 |

重現修正前：`git worktree add <資料夾> 75f7775`，`ROOT=<資料夾> PORT=8790 node tests/e2e/shim.js`，
`BASE=http://localhost:8790 node tests/e2e/intro_legacy.js`；打包：`bash tests/e2e/site_build_safety.sh <75f7775 的 build_site.sh>`（只在拋棄式副本中執行）。

## 失敗

* 無（本輪最後一次執行）。開發中 `intro_legacy.js` 第一次執行有 1 項失敗：返回後太早讀取投影端的 API 回應（仍是上一次輪詢的結果）；
  測試改為等待 API 回應與資料庫一致後再檢查，產品程式沒有變更。

## 未執行

* 資料庫類測試（`test:db`、`test:upgrade`、race、concurrency）與本機 Supabase 堆疊：本輪沒有修改 SQL、遷移或權限。
* 實體投影機、平板、簡報筆；Safari、Firefox。
* 正式站：本環境連不到 `hsuanyu9503.github.io`。

## 上線待辦（需要 repo 管理者，本輪未變更）

1. **合併前**：Settings → Pages 把 Source 從「Deploy from a branch（main／根目錄）」改為「GitHub Actions」。
2. 部署後確認：`docs/intro-source.json`、`source-assets/intro/` 的 Word 原稿、`docs/screenshots/intro/03-reveal-conan.webp` 皆回傳 404；
   `assets/intro/conan-1600.webp`、`assets/intro/chihiro-1600.webp` 可以載入。
3. repo 本身是公開的：`docs/`、`source-assets/` 仍可在 github.com 讀到，是否處理由使用者決定。
