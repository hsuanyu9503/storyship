# Phase 5｜上線準備與整堂課驗收

## 0. 開發基準與依賴

* 開始時核對遠端：Phase 4 PR #6 **已合併**；`main` = `216fd68c7ee6721d2e2af37916c9cf7b46981af9`（合併 commit，內容與上一輪審查版本 `3385b50f1c69ca28ad2f1c5f6b6781248e1272da` 完全相同，`git diff 3385b50 216fd68` 為空）。
* Phase 5 分支 `claude/phase5-acceptance` 由最新 `main` 建立，**不依賴任何未合併的 PR**。
* 教學順序、40 分鐘設計不變；沒有新增作答、投票、評分、排名或自動分類。
* **沒有資料庫變更**：`supabase/` 與 Phase 4 完全相同（`upgrade.sql` 不變）。

## 1. 範圍

| 項目 | 內容 |
|---|---|
| Phase 4 R1 | 修正公開成功後的草稿同步（兩台教師裝置），05、07 競態測試 |
| 新發現的缺陷 | 04 → 03 → 04 時學生停在 03 畫面（真實 Realtime 下重現）；教師平板觸控目標過小 |
| 整堂課回歸 | 00～07 與結束流程；05 之後學生答案與快照不被改寫 |
| D2 | 跨鎖逾時的真實並行讀取（資料庫兩個連線） |
| Supabase | 隔離的本機 Supabase（官方映像檔）：PostgREST、GoTrue、Realtime、權限、安裝／升級／回復 |
| 觸控與投影 | 瀏覽器模擬平板與手機的觸控操作；16:9 投影上限內容量測 |
| 文件 | 本文件、`REVIEW_HANDOFF_PHASE5.md`、`DEPLOY.md` G 節、`TEACHER_CHECKLIST.md` |

## 2. R1：公開成功後草稿沒有跟上另一台裝置

**原因**（`js/teacher/results.js`）：公開成功後在 `busy` 仍設定時呼叫 `refresh()`，`onLive()` 因 `busy` 略過該環節；
`syncVer` 沒有更新成「這次送出且已確認」的版本。之後另一台裝置公開 C，這台讀到 C 時判斷「本機有修改（`ver ≠ syncVer`）」而保留 B，
一直顯示「有尚未公開的變更」，之後的輪詢也不會收斂。

**修正**（小範圍，沒有改動整套狀態管理）：

* 公開成功（`r.ok`）時：若送出後沒有本機修改（`ver === sentVer`），把 `syncVer` 設為送出的版本；記下伺服器回傳的 `rev` 為 `minRev`。
* 公開期間若已改成 D：`ver ≠ sentVer`，不更新 `syncVer` → D 保留、不自動公開、不被清除。
* STALE、網路錯誤與結果不明（回應遺失）：**不**當成成功；只在之後的讀取確實讀到伺服器是 B 時才同步。網路錯誤的提示改為「無法確認是否已公開；恢復連線後會依伺服器的內容顯示」，不自動重送。
* refresh 失敗與公開失敗分開：`sync.refresh()` 失敗時只標示離線、繼續輪詢；同步判斷忽略比 `minRev` 舊的狀態，避免讀取失敗或舊讀取把草稿倒回公開前的內容。
* `busy` 清除後立即補做一次同步（`syncPhase`），不依賴下一次輪詢恰巧讀到 B。
* 「最新版本預覽完成後才能公開」維持不變。

**證據**：`tests/e2e/e2e.js` 的「Phase 5 R1」區塊（05、07 各 5 個情境），以讀取閘門控制順序：攔截裝置一的 `session_state` 讀取，
在公開請求的**伺服器回應送回瀏覽器之前**切換閘門，確定下一次讀取就是公開後的 refresh，之後的輪詢被擋住直到測試放行（不靠固定等待時間）。

| 情境 | 修正前（`216fd68`） | 修正後 |
|---|---|---|
| (1) 裝置一公開 B 成功、無修改；裝置二在裝置一下次輪詢前公開 C | ❌ 05、07 都停在 B，顯示「有尚未公開的變更」（放行後讀取 4～5 次仍未收斂） | ✅ 跟著變成 C、顯示一致 |
| (2) 公開 B 在途時改成 D，之後裝置二公開 C | ✅（舊版也保留 D） | ✅ D 保留、未自動公開 |
| (3) 公開請求沒有到伺服器 | ✅ | ✅ 保留 B、標示未公開、不重送 |
| (4) 伺服器已寫入 B、回應遺失（結果不明） | ❌ 05、07 之後都不再跟著另一台的 C | ✅ 讀到 B 才顯示一致，之後跟著 C、不重送 |
| (5) 公開成功但之後的讀取失敗 | ✅ | ✅ 不倒回、不重送，恢復後收斂 |

修正前的結果：`SOFT_FAIL=1` 執行於 `216fd68`＋新測試（只加測試，未改程式）。

## 3. 新發現並修正的缺陷

### 3-1 04 → 03 → 04 時學生停在 03 畫面（嚴重度：高，影響上課）

* **重現**：教師在 04 按「← 上一環節」回到 03，學生畫面切到 03 後，教師再按「進入第四環節」。學生端收到 phase 04
  （`student_state` 回應正確），但畫面停在「老師已結束個人分類」，需要每台平板各自重新整理。
* **怎麼發現**：在真實 Realtime 下執行 e2e 時失敗。shim 沒有 Realtime（3 秒輪詢），學生常常錯過回到 03 的那一瞬間，所以過去的測試沒有抓到。
* **原因**（`js/student/main.js` `renderState`）：03 的分支在「卸載不屬於目前畫面的小組工作區」之前就 return；
  回到 04 時舊的小組工作區仍存在且 key 相同，不會重新掛上畫面（它的同步迴圈也一直在背景執行）。
* **修正**：計算畫面後，先卸載不屬於目前畫面的個人／小組工作區。
* **回歸測試**：e2e 在 04 → 03 時等每位學生都確實顯示 03 畫面後才再前進，再確認每位都回到「共同分類」。
  修正前在 shim 上也穩定失敗（`DIAG waitText「共同分類」逾時；畫面：…老師已結束個人分類…`），修正後通過。

### 3-2 教師平板的觸控目標過小（嚴重度：中）

* 05 面板的「放左側」等 `.small` 按鈕只有 27px 高、「▶」翻頁鈕 24px 寬（建議至少 44px）。
* **修正**（`css/app.css`）：`@media (pointer: coarse)` 時按鈕、選單最小 44×44px，勾選列至少 44px 高；字級不變，桌機不受影響。
* **測試**：`tests/e2e/touch.js` 量測每個控制項的大小、可見性與是否被遮住；修正後所有量測的控制項都 ≥ 44px。

## 4. 整堂課回歸（00～07、結束）

既有的 `tests/e2e/e2e.js` 涵蓋建立場次、學生加入、重新整理、斷線重連、個人分類、共同分類、正式提交、教師結束保存、
離開個人作答的確認（取消不寫入）、05／06／07、返回與再次進入、兩台教師裝置、預覽反序、公開在途修改、STALE、網路恢復，
以及 Phase 3 的操作鎖、操作世代、刪除結果重送。本輪新增：

* **學生答案與快照不被改寫**：進入 05 時記錄個人答案、個人快照、小組分類與歸屬、所有小組快照的指紋；
  經過 05→06→07→返回→再進入→以真實按鈕「結束場次」後逐位元組比對。
* **04 → 03 → 04**（見 3-1）。
* 05／07 綁定快照、新快照不自動替換：沿用 `tests/db/tests_results.sql`（重新開放→再提交→返回 05 仍是原快照）。

## 5. D2：跨鎖逾時的真實並行讀取

定義（`docs/REVIEW_PHASE3.md` 第三輪「D2 邊界」）：三個版本（`board_rev`、`lock_rev`、`state_rev`）都相同、只有操作鎖逾時時，兩個讀取回應的排序。

`tests/db/race_d2.sh`（已加入 `npm run test:race`）用**兩個真實資料庫連線**製造重疊的交易（不是延遲前端回應）：

1. R1 在鎖逾時**之前**開始交易（`now()` 固定），停頓到逾時之後才執行 `student_group_board`，最後才回來；R2 在逾時後開始並先完成。
   → 兩個回應三個版本相同；R1 仍列出鎖、R2 沒有；`R1.read_now < R2.read_now`；依前端 `adopt()` 的規則（`js/student/group.js` 第 142–147 行，測試中逐字對照）晚到的 R1 被丟棄。
2. R1 停頓期間組員續約（`lock_rev` 不變）→ 仍以 `read_now` 採用較新的讀取。
3. 跨越逾時前後的 12 次讀取：每次回應的鎖清單都與它自己的 `read_now` 一致。

## 6. Supabase 驗證（隔離的本機 Supabase，不是正式專案）

`tests/supabase/`：以 Docker 啟動 Supabase 官方 self-hosting 的元件——`supabase/postgres:15.8.1.060`（Supabase 的角色與**預設權限**）、
GoTrue `v2.177.0`、PostgREST `v12.2.3`、Realtime `v2.34.47`，加上取代 Kong 的小閘道（要求 `apikey`，路由 `/rest/v1`、`/auth/v1`、`/realtime/v1`）。
密鑰每次隨機產生在 **repository 之外**的狀態目錄（預設 `~/.cache/storyship-sbtest`，可用 `SB_STATE_DIR` 指定；指向 repo 內會被拒絕），不寫入 repo、不輸出到畫面。測試閘道與 shim 只監聽 `127.0.0.1`，且只供應網站本身的檔案（見第十節）。所有 SQL 以 `postgres` 角色（與 SQL Editor 相同，非超級使用者）執行。
權限測試只用 anon key 與 GoTrue 簽發的使用者 JWT；**service_role 沒有用於任何權限判斷**。

與正式 Supabase 的差異：沒有 Kong（以閘道代替）、本機 Realtime 因測試主機沒有 IPv6 而把 HTTP listener 的 `socket_opts` 由 `:inet6` 改為 `:inet`（`tests/supabase/init/realtime-runtime.exs`，其餘與映像檔相同）、版本可能與雲端不同。

結果見第八節。

## 7. 實體裝置人工驗收表（尚未執行）

以下只在瀏覽器中模擬過（`tests/e2e/touch.js`、`e2e.js`、`layout.js`），**沒有在實體平板、手機或投影機上執行**。上線前請在教室實測：

| # | 裝置 | 操作 | 預期 | 結果 |
|---|---|---|---|---|
| 1 | 教師 iPad 橫向 | 05：放左側、放右側、全部揭露、每頁 1 類、▶ 翻頁、放大此側、公開、放棄變更 | 每個按鈕一次點中；不需縮放；不需要滑鼠移過 | ☐ |
| 2 | 教師 iPad 直向 | 同上，07：選分類、顯示理由、選類型、揭露要素、公開 | 同上 | ☐ |
| 3 | 學生 iPad | 03：拖曳故事、點「移動」再點分類、上下捲動故事清單 | 捲動不會誤移故事；拖曳與點選都能移動 | ☐ |
| 4 | 學生 iPad | 03／04：點名稱、理由欄輸入中文（注音） | 鍵盤彈出時輸入框不被擋住；選字不會中斷 | ☐ |
| 5 | 學生 iPad | 03 連點「完成」 | 只完成一次、沒有錯誤訊息 | ☐ |
| 6 | 學生 iPad | 關閉 Wi-Fi 移動一張故事，再打開 | 顯示「尚未儲存」，恢復後自動補存 | ☐ |
| 7 | 投影機（16:9） | 05 雙組、長理由；改「放大此側」＋每頁 1 類 | 文字可從教室後排讀到；沒有被切掉 | ☐ |
| 8 | 投影機（16:9） | 07 顯示 300 字理由＋句型鷹架 | 可讀、沒有被切掉 | ☐ |
| 9 | 全班 | 04 → 03 → 04 | 所有學生平板自動回到小組畫面 | ☐ |
| 10 | 兩台教師裝置 | A 公開後 B 公開，回到 A | A 自動顯示 B 的內容、「投影與預覽一致」 | ☐ |
| 11 | 學校網路 | 教師端右上角 | 「即時連線」或「輪詢同步」；若被封鎖 WebSocket，仍可上課 | ☐ |

## 8. 實際執行的測試（2026-11-13，本機，最後一版程式）

環境：PostgreSQL 16、Node 22、Playwright Chromium（headless）；Docker 29（本機 Supabase）。
`shim`＝`tests/e2e/shim.js` 模擬 API、沒有 Realtime；「本機 Supabase」＝第六節的真實 GoTrue／PostgREST／Realtime。
**都不是**正式雲端 Supabase、實體平板或投影機。

| 指令 | 環境 | 結果 |
|---|---|---|
| `npm run test:unit` | Node | 25／25 通過 |
| `npm run test:db` | PostgreSQL＋Supabase 角色模擬 | 324 項通過 |
| `npm run test:race` | PostgreSQL 多連線 | 16 情境通過（既有 13＋D2 3） |
| `npm run test:upgrade` | PostgreSQL＋git | 24 項通過 |
| `npm run test:concurrency` | PostgreSQL＋pgbench | 通過 |
| `node tests/e2e/layout.js` | shim（靜態檔） | 45 項通過 |
| `node tests/e2e/touch.js` | shim | 39 項通過（所有量測的觸控目標 ≥ 44px） |
| `node tests/e2e/e2e.js` | shim | 245 項，**連續 3 次**全數通過 |
| `bash tests/supabase/run.sh` | 本機 Supabase | 65 項通過：全新安裝＋重複執行（verify 17 項）；API 53 項（權限、錯誤格式、跨場次、公開 API、Realtime 通知、結束後快照不變）；Phase 3＋上課中資料（停在 06）升級、資料與快照不變、舊版 06 揭露保留且不擴大、重複升級、回復到 Phase 3、再升級 |
| `bash tests/supabase/e2e_real.sh` | 本機 Supabase | Realtime 中斷與恢復 7 項、`touch.js` 39 項、完整 `e2e.js` 245 項，全數通過 |

修正前的結果（只加入新測試、未改程式）：

| 缺陷 | 修正前 | 紀錄 |
|---|---|---|
| R1 | `216fd68`：05、07 的情境 (1) 與 (4) 失敗（共 5 項 NOT OK） | `SOFT_FAIL=1` 執行 |
| 04 → 03 → 04 | shim 上穩定失敗（學生停在 03）；在本機 Supabase 上首先發現 | — |
| 觸控目標 | 「放左側」56×27px、「▶」24×44px | `touch.js` 附註 |

### 本輪未執行／無法執行

| 項目 | 原因 | 待執行步驟 |
|---|---|---|
| 正式（雲端）Supabase 專案 | 本環境沒有測試專案與憑證；不得碰正式場次 | 建立**另一個**測試專案 → `DEPLOY.md` A 節安裝或以 `upgrade.sql` 升級 → `verify.sql` 17 列 true → 以兩個教師帳號與一台學生裝置依 `PHASE5.md` 第七節操作 |
| 實體平板、手機、投影機 | 沒有實體裝置 | `PHASE5.md` 第七節人工驗收表 |
| iOS Safari、注音輸入法 | Playwright 只用 Chromium 模擬 | 第七節第 3～6 項 |
| 學校網路（WebSocket 被封鎖時） | 只以本機閘道模擬封鎖 | 第七節第 11 項 |

## 9. 仍可能影響上課的已知限制

| 嚴重度 | 項目 | 重現／說明 |
|---|---|---|
| 中 | 05 雙組並排且兩側都揭露很長的理由時投影放不下 | 預覽會提醒；需改用「放大此側」＋每頁 1 類或聚焦（Phase 4 設計，未改變） |
| 低 | Realtime 連線時，同一位學生的另一個分頁最慢 15 秒才同步個人分類 | 同一台平板開兩個分頁才會發生；個人分類的一般儲存刻意不送 Broadcast |
| 未知 | 實體裝置與正式 Supabase 的行為 | 見第八節「未執行」；**在完成第七節之前，不宣稱可正式上線** |

## 10. 獨立複檢的回應（Phase 5 複檢，`bf92116`）

| # | 嚴重度 | 項目 | 在 `bf92116` 上重現？ | 修正 | 測試 |
|---|---|---|---|---|---|
| F1 | P2 | 本機測試閘道不經驗證即可下載測試密鑰，且監聽不限 loopback | ✅ 重現：假 repository root 中的 `tests/supabase/.state/env` → HTTP 200；可從非 loopback 位址（192.0.2.2）連線。**`tests/e2e/shim.js` 有相同問題**（一併修正） | 兩個伺服器改用共用的 `tests/lib/static-site.js`：只供應 `index.html`、`join.html`、`teacher.html`、`projector.html` 與 `js/`、`css/`、`assets/`；拒絕其他路徑、任何以「.」開頭的路徑段、`..`、NUL、反斜線、解碼失敗、符號連結跳出根目錄；以 `path.relative` 判斷真正的目錄邊界；`config.js` 一律由伺服器產生。只監聽 `127.0.0.1`。密鑰移到 repo 之外（`tests/supabase/state_dir.sh`，指向 repo 內時拒絕且不建立目錄） | `tests/unit/static_servers.test.mjs`（8 項，納入 `npm run test:unit`）：16 種越界／編碼／隱藏／密鑰路徑都是 403／404 且回應不含內容；網站檔案仍 200；API 無有效 apikey 為 401；從非 loopback 位址連不上；密鑰目錄不能在 repo 內。修正前 4 項失敗、修正後全過 |
| D2 補強 | 建議 | 排序判斷在測試中另寫一份 | — | 判斷移到 `js/lib/board-order.js`（`isOlderBoard`）；`js/student/group.js` 的 `adopt()` 與 `tests/db/race_d2.sh` 都呼叫它 | unit 1 項；`race_d2.sh` 3 情境 |

沒有證據顯示正式 Supabase 的任何密鑰外洩：這個閘道只在本機測試使用，密鑰每次隨機產生、測試結束即刪除容器；複檢前的測試在本機容器中執行。
複檢後重新執行的測試結果見第十一節。

## 11. 複檢修正後重新執行的測試（2026-11-13，本機）

| 指令 | 環境 | 結果 |
|---|---|---|
| `npm run test:unit` | Node | 34／34 通過（新增 `static_servers.test.mjs` 8 項、`isOlderBoard` 1 項） |
| `npm run test:db` | PostgreSQL | 324 項通過 |
| `npm run test:race` | PostgreSQL 多連線 | 16 情境通過（D2 改以 `isOlderBoard` 判斷） |
| `npm run test:upgrade` | PostgreSQL＋git | 24 項通過 |
| `npm run test:concurrency` | PostgreSQL＋pgbench | 通過 |
| `node tests/e2e/e2e.js` | shim（已改用 `static-site.js`、只監聽 loopback） | 245 項通過 |
| `node tests/e2e/layout.js`、`touch.js` | shim | 45、39 項通過 |
| `bash tests/supabase/run.sh` | 本機 Supabase（密鑰在 repo 之外） | 65 項通過 |
| `bash tests/supabase/e2e_real.sh` | 本機 Supabase | Realtime 7、touch 39、完整 e2e 245，全數通過 |

執行後確認 repository 內沒有建立 `tests/supabase/.state`。正式雲端 Supabase、實體裝置、學校網路仍未驗證（第七、八節）。
