# 交接報告：請協助複檢 Phase 5（上線準備與整堂課驗收）

> 給複檢者：請以「找出錯誤」為目標。以下宣稱都可用檔案與指令驗證；與程式碼不一致時以程式碼為準。
> 作者回報的測試數字**不是**你的測試結果。

## 1. 版本

| 項目 | 內容 |
|---|---|
| Repo | `github.com/hsuanyu9503/storyship` |
| base | `main` = `216fd68c7ee6721d2e2af37916c9cf7b46981af9`（Phase 4 PR #6 的合併 commit；內容＝`3385b50f1c69ca28ad2f1c5f6b6781248e1272da`） |
| head | 分支 `claude/phase5-acceptance`（完整 SHA 見 PR 說明） |
| 依賴 | **不依賴**任何未合併的 PR（Phase 4 已合併） |
| 資料庫 | **沒有變更**（`git diff 216fd68 -- supabase/` 為空）；`upgrade.sql` 與 Phase 4 相同 |

## 2. 變更檔案

| 檔案 | 內容 |
|---|---|
| `js/teacher/results.js` | R1：公開成功後的草稿同步（`minRev`、`sentVer`、`syncPhase`）；結果不明時的提示 |
| `js/student/main.js` | 新缺陷：04 → 03 → 04 時學生停在 03 畫面 |
| `css/app.css` | 觸控裝置（`pointer: coarse`）按鈕、選單、勾選列最小 44px |
| `tests/e2e/e2e.js` | R1 競態測試（05、07 各 5 情境）；04→03→04；學生答案與快照指紋；`E2E_EMAIL`／`E2E_PASSWORD`；`waitText` 逾時診斷 |
| `tests/e2e/touch.js`（新增） | 觸控與投影驗收（模擬 iPad、iPad Mini、Pixel 7） |
| `tests/db/race_d2.sh`（新增）、`package.json` | D2：兩個資料庫連線的真實並行讀取；加入 `test:race` |
| `tests/supabase/`（新增） | 隔離的本機 Supabase（Docker）：`up.sh`、`docker-compose.yml`、`gateway.js`、`run.sh`（安裝／升級／回復＋API）、`api_test.mjs`、`seed_phase3_live.mjs`、`upgrade_check.mjs`、`realtime_browser.js`、`e2e_real.sh` |
| `.gitignore` | `tests/supabase/.state/`（本機測試的隨機密鑰） |
| `docs/PHASE5.md`（新增）、`docs/REVIEW_HANDOFF_PHASE5.md`（本文件）、`docs/TEACHER_CHECKLIST.md`（新增）、`docs/DEPLOY.md`（G 節）、`docs/TESTING.md` | 文件 |

## 3. 入口

**JS**

| 位置 | 作用 |
|---|---|
| `js/teacher/results.js` 第 32 行 `minRev` | 本裝置公開成功、伺服器回傳的 `session_state.rev`；比它舊的讀取不用來同步草稿 |
| 第 93–122 行 `publish` | `sentVer` 固定送出的版本；`r.ok` 且之後沒有修改 → `syncVer = sentVer`；失敗、STALE、結果不明都不視為成功；finally 中 refresh 後補做 `syncPhase` |
| 第 125 行 `syncPhase` | 與伺服器相同 → 記為已同步；不同且沒有本機修改 → 跟著伺服器；狀態比 `minRev` 舊 → 不動 |
| 第 335 行 `onLive` | 每次讀取後對 05、07 呼叫 `syncPhase` |
| `js/student/main.js` 第 141 行 | 計算畫面後先卸載不屬於目前畫面的個人／小組工作區 |

**SQL**：沒有變更。

## 4. 已知風險與判斷

| 項目 | 說明 |
|---|---|
| `minRev` 與 `S.state.rev` 的比較 | 兩者都是 `session_state.rev`（bigint，經 PostgREST 為 JSON number）。另一台裝置的任何操作都會讓 rev 變大，所以只會延後、不會永遠阻擋同步 |
| 結果不明時不顯示「已公開」 | 改為讀取伺服器確認；若伺服器確實已寫入，下一次讀取即顯示一致 |
| 個人分類的一般儲存不送 Broadcast | 既有設計（避免全班每次拖曳都讓所有裝置重新讀取）；Realtime 連線時同一位學生的另一個分頁最慢 15 秒收斂（e2e 已依此設定等待時間，並在註解說明） |
| 04 → 03 → 04 | 修正後每次進入都重新建立工作區；04 內的即時更新仍沿用同一個實體（不會打斷輸入） |
| 本機 Supabase ≠ 正式 Supabase | 沒有 Kong（閘道代替）、Realtime 改 `:inet`、版本固定；見 `PHASE5.md` 第六節 |
| 觸控 | 只在 Chromium 模擬；iOS Safari 的捲動、鍵盤、選字行為**未驗證** |

## 5. 複檢步驟

```bash
npm run test:unit && npm run test:db && npm run test:race && npm run test:upgrade && npm run test:concurrency
```

```bash
cd tests/e2e && ./setup_db.sh && (DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_e2e node shim.js &) && node e2e.js && node touch.js && node layout.js
```

真實 PostgREST／GoTrue／Realtime（需要 Docker，可存取 Docker Hub）：

```bash
bash tests/supabase/run.sh
```

```bash
bash tests/supabase/e2e_real.sh
```

確認 R1 在修正前會失敗：在 base（`216fd68`）上只放入新的 `tests/e2e/e2e.js`，以 `SOFT_FAIL=1 node e2e.js` 執行（或 `git stash` 掉 `js/teacher/results.js` 的修改）。
確認 04→03→04 在修正前會失敗：同上，還原 `js/student/main.js`。

建議重點：

1. `syncPhase` 是否有讓「本機有修改的草稿」被伺服器覆蓋的路徑（特別是公開在途、STALE 之後、結果不明之後）。
2. `minRev` 是否可能在某些順序下讓同步永遠不發生（例如公開成功的回應 rev 大於之後所有讀取）。
3. 04 → 03 → 04 修正是否讓 04 內的即時更新重建工作區（不應該；`group.key` 相同時沿用）。
4. 44px 規則是否在桌機上意外生效（`pointer: coarse` 只在觸控為主要指標時成立）。

## 6. 尚未驗證

正式（雲端）Supabase 專案、實體平板與手機（iOS Safari、注音輸入、虛擬鍵盤）、實際投影機與教室後排可讀性、學校網路。
人工驗收表見 `PHASE5.md` 第七節。
