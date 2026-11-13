# 測試與驗收

## 1. 自動化測試

| 指令 | 內容 | 需要 |
|---|---|---|
| `npm run test:unit` | 投影內容產生器、分類資料模型、05／07 教師端選擇、揭露紀錄讀取、每頁分類數（25 項） | Node.js 20+ |
| `npm run test:db` | 資料庫行為：權限、加入、狀態機、個人分類、小組共作（冪等、衝突、提交、重新開放、結束保存、隔離）、保留清除、null 版本號、鎖版本、刪除重送、05／06／07 公開與權限、06 類型名稱與要素分開揭露（`tests_disclosure.sql`，直接檢查 `projector_state` 原始 JSON）（324 項） | PostgreSQL 15+ 與 `psql` |
| `npm run test:race` | 真實連線的競態：個人快照 2 情境＋小組 11 情境（學生加入 vs. 刪除場次、教師結束／暫停 vs. 學生操作、同時提交、移入 vs. 刪除、同時新增、提交 vs. 教師暫停的死結、換組／移出 vs. 進行中的編輯）＋D2 跨鎖逾時的並行讀取 3 情境（`race_d2.sh`，Phase 5） | PostgreSQL＋Node |
| `npm run test:upgrade` | Phase 1 → 2、Phase 2 → 3、Phase 3 → 4 升級（含上課中資料）、Phase 3 停在 06 時升級、已執行 97af137 升級檔後再升級、升級空窗、單一交易升級檔（原子性）、升級後檢查、回復、再升級，資料不變 | PostgreSQL＋git |
| `npm run test:concurrency` | 12 個連線、六組同時移動卡片與改名稱 1,800 次，驗證沒有遺失更新；六組同時提交 | PostgreSQL＋`pgbench` |
| `tests/e2e`（見下） | 瀏覽器端對端：教師、投影、五位獨立學生（第 1 組四位含補加入者）完整走過 00→99，含 03 個人分類與 04 小組共作全流程，以攔截回應製造的交錯測試，以及 05→06→07 的公開流程、兩台教師裝置競爭、離開 03 的共同確認、預覽版本綁定（延遲、反序、失敗、重試、公開在途時修改）、類型揭露範圍（見 PHASE4.md 第十一節） | 上述＋Playwright |
| `tests/e2e/touch.js` | 觸控與投影驗收（Phase 5）：模擬 iPad／iPad Mini／Pixel 7 的 tap、觸控滑動、螢幕鍵盤（視窗變矮）、連點、斷線；教師平板 05／07 每個控制項的可見性、遮擋與觸控目標大小；以真實流程建立上限內容並量測 16:9 投影 | shim 或真實堆疊＋Playwright |
| `bash tests/supabase/run.sh` | 隔離的本機 Supabase（Docker：Supabase 官方 Postgres、GoTrue、PostgREST、Realtime）：全新安裝、重複執行、真實 PostgREST 的 API 與權限（anon、場次擁有者、另一位教師、未列入白名單者、跨場次）、Realtime 通知；從 Phase 3＋上課中資料（停在 06）升級、重複升級、回復、再升級 | Docker（可存取 Docker Hub）＋Node＋psql |
| `bash tests/supabase/e2e_real.sh` | 在上述真實堆疊上執行 `realtime_browser.js`（Realtime 中斷與恢復）、`touch.js`、完整 `e2e.js` | 同上＋Playwright |
| `tests/e2e/layout.js` | 投影版面在合法上限內容下的實際量測（05 雙組／單組／聚焦／放大單側、07 故事＋理由＋句型鷹架；1920×1080、1280×720、1024×768）：教師可選的方式必須完整可見，其他被裁切的情況必須被教師預覽偵測到 | shim 或任何靜態伺服器＋Playwright |

### 資料庫測試如何模擬 Supabase

`tests/db/supabase_stub.sql` 建立 Supabase 的 `anon`、`authenticated` 角色、`auth.uid()` 與 `realtime.send()`，
接著執行**與正式部署完全相同**的 `supabase/migrations/*.sql` 與 seed（並重跑 002／003／seed 驗證可重複執行）。
測試以 `set role anon`／`set role authenticated` 實際切換角色呼叫 RPC，因此 RLS 與函式授權都是真實生效的。

### 端對端測試

```bash
cd tests/e2e
npm install
npm run bundle
./setup_db.sh                       # 建立 sf_e2e 資料庫與教師 t1@example.com（密碼 pass）
DATABASE_URL=postgres://postgres:<密碼>@127.0.0.1/sf_e2e npm run shim &   # 本機模擬 Supabase API
npm test
```

`shim.js` 是**僅供測試**的小伺服器：把 supabase-js 的 RPC／資料表請求轉成 SQL，以 anon／authenticated 角色在真實 PostgreSQL 執行，
並以 JWT 模擬教師登入。它**不提供 Realtime**，所以端對端測試同時驗證了輪詢備援；
測試也封鎖所有外部網路請求，確認網站不依賴 CDN。截圖存在 `tests/e2e/.cache/shots/`。
`e2e.js` 也會用 `pg` 直接**讀取**資料庫（`DATABASE_URL`，只讀）來檢查 `personal_closed_at`、快照數與公開內容。

`e2e.js` 的教師帳號可用 `E2E_EMAIL`、`E2E_PASSWORD` 指定（預設為 shim 的 `t1@example.com`／`pass`）。

**本機 Supabase 的密鑰**：`tests/supabase/up.sh` 每次隨機產生 JWT secret、資料庫密碼與 anon／service_role key，寫在
`tests/supabase/.state/env`（已列入 `.gitignore`），不輸出到畫面。權限測試只使用 anon key 與 GoTrue 簽發的使用者 JWT。

**確認新測試在修正前會失敗**：`SOFT_FAIL=1 node e2e.js` 讓失敗只記錄、不中止，最後列出所有未通過項；
`SKIP_F3=1`、`SKIP_B=1` 等可略過個別區塊。做法：`git worktree add <dir> <舊版本>`，把新的 `e2e.js` 複製進去，
以 `ROOT=<dir> node shim.js` 提供舊版網站，再以 `SOFT_FAIL=1` 執行。

## 2. Phase 1 驗證結果（2026-11-12）

> Phase 2、Phase 3 的測試結果與驗收清單見 [`PHASE2.md`](PHASE2.md)、[`PHASE3.md`](PHASE3.md) 第六、七節；Phase 3 獨立複檢的回應與修正見 [`REVIEW_PHASE3.md`](REVIEW_PHASE3.md)。下表為 Phase 1 當時的狀態，Phase 2 後已更新的項目標示於表後。

| 規格第十六節測試案例 | 狀態 | 驗證方式 |
|---|---|---|
| 1. 六組加入同一教學場次 | ✅ | db、e2e |
| 2. 同組多人，個人分類彼此獨立 | ✅（資料庫） | db：同組兩人各自儲存、各自讀取 |
| 3. 同組學生看到共同分類最新結果 | ✅（資料庫） | db：第二、三台裝置讀到最新 `board_rev` |
| 4. 兩人同時移動同張故事卡 | ✅（資料庫） | db＋concurrency：只有一人成功，另一人收到 `STALE`＋最新歸屬 |
| 5. 兩人同時修改同一理由 | ✅（資料庫） | db：欄位鎖 `LOCKED`、逾時後舊版本 `STALE` |
| 6. 刪除分類時故事回到未分類 | ✅（資料庫） | db |
| 7. 重新整理後分類仍存在 | ✅ 身分恢復（e2e）／資料保存（db） | 分類畫面於 Phase 2、3 |
| 8. 暫時離線後資料不回溯 | ✅（資料庫） | db：鎖逾時後舊版本寫入被拒絕；e2e：無 Realtime 時輪詢同步 |
| 9. 提交後不可繼續編輯 | ✅（資料庫） | db：個人與小組 |
| 10. 解鎖指定組不影響其他組 | ✅（資料庫） | db |
| 11. 教師私下預覽時投影不改變 | ✅ | e2e：06 預覽後等待超過輪詢週期，投影不變 |
| 12. 第五環節展示不修改分類資料 | ✅（Phase 4） | db：預覽、公開、揭露、追蹤後小組／個人資料與快照雜湊不變 |
| 13. 第六環節不提前顯示未公開類型 | ✅ | unit、e2e |
| 14. 返回上一環節不清除成果 | ✅ | db：05→04 成果與快照仍在、鎖定不被繞過；e2e：畫面恢復 |
| 15. 不同尺寸操作按鈕不被遮擋 | ⏳ 部分 | e2e 截圖：教師 1024×768、學生直向 820×1180；分類畫面於 Phase 2、3 |
| 16. 不支援全螢幕仍可參與 | ✅ | e2e（headless 瀏覽器全螢幕請求失敗後仍進入探索模式） |
| 17. 學生無法繞過狀態存取他組或未公開內容 | ✅ | db：anon 不能讀任何資料表；01 讀不到故事卡；跨組操作 `NOT_FOUND`；e2e：錯誤投影金鑰被拒絕 |
| 18. 六組同時參與仍穩定 | ✅（資料庫） | concurrency：12 連線 1,800 次操作，平均 4 ms |

「✅（資料庫）」表示伺服器端行為已驗證；學生操作畫面在後續 Phase 完成後，需再以實機驗證一次。

**Phase 2 更新**：第 2、6、7、8、9、15、17 項的個人分類部分已有學生操作畫面，並以 e2e 驗證（見 `PHASE2.md`）；
小組部分（第 3、4、5、10 項的畫面）於 Phase 3 完成。

## 3. 部署後的手動驗收（Phase 1）

本機測試無法連到真正的 Supabase，**部署後請以實機完成以下步驟**，才能確認 Realtime 與正式權限設定：

準備：1 台教師裝置（平板或筆電）、1 台投影用電腦、至少 3 台學生裝置（建議 2 台同組）。

| # | 步驟 | 預期結果 |
|---|---|---|
| 1 | 教師登入 → 建立場次 | 出現六碼代碼；連線狀態顯示「即時連線」（若顯示「輪詢同步」代表 Realtime 未連上，仍可使用） |
| 2 | 開啟投影 → 全螢幕 | 顯示 QR Code、代碼、六組 0 人 |
| 3 | 3 台學生掃 QR → 選組 → 確認 | 投影人數在 1～3 秒內更新（輪詢模式約 2 秒） |
| 4 | 一台學生重新整理 | 直接回到「已加入第 N 組」，座號不變 |
| 5 | 教師關閉「開放新學生加入」，用第 4 台裝置掃碼 | 顯示「老師已暫停加入」 |
| 6 | 主控台把一位學生移到別組 | 該學生畫面在數秒內顯示新組別 |
| 7 | 啟動 01 → 開啟故事探索 → 下一個線索 | 投影只出現第一個線索；教師端看得到故事名稱；學生端只顯示「請觀看前方投影…」 |
| 8 | 揭曉故事 → 交會畫面 → 02 | 投影同步；學生端出現「進入探索模式」 |
| 9 | 學生按「進入探索模式」 | 支援的瀏覽器進入全螢幕；不支援時仍顯示「已進入探索模式」 |
| 10 | 開放 03 | 學生端出現故事卡 |
| 11 | 04 → 結束共同分類 | 跳出「仍有小組尚未提交」；選「繼續等待」環節不變；選「鎖定…」後進入 05 |
| 12 | 06：點選「3. 歷史小說」 | 右側出現「預覽」，投影不變 |
| 13 | 按「揭開小說世界」 | 投影同時顯示名稱與三個要素 |
| 14 | 上一環節 → 下一環節 | 投影回到離開前的畫面 |
| 15 | 結束場次 | 學生端顯示結束；再掃 QR 顯示找不到活動 |
| 16 | 權限抽查：在學生裝置的瀏覽器開發者工具執行 `fetch('<Project URL>/rest/v1/story_cards', {headers:{apikey:'<anon key>'}}).then(r=>r.status)` | 回傳 401 或 403（不能直接讀素材） |

全部符合即通過 Phase 1 驗收：**教師端切換環節時，投影端與學生端依權限同步變更**。
