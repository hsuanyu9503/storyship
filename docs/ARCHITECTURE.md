# 架構規劃（Phase 1）

本文件對應開發規格第十八節「正式開發前的工作要求」第 1～7 項。

## 0. 既有程式碼檢查結果與採用的技術

接手時 repo 內已有 Phase 1 的**前端**（`index.html`、`teacher.html`、`projector.html`、`join.html`、`js/`、`css/`），
但前端呼叫的**資料庫、RPC、權限設定、文件與測試都不存在**（程式碼引用的 `supabase/setup/add_teacher.sql`、`docs/DEPLOY.md` 也不存在），
因此前端在任何環境都無法實際運作。前端中「後端已建立並測試」的文字並不成立。

本階段沿用既有前端架構，並補齊：

| 項目 | 採用 | 理由 |
|---|---|---|
| 前端 | 原生 ES Modules（無建置步驟），GitHub Pages 靜態部署 | 既有程式碼即為此架構；教師只需推上 GitHub 即可更新 |
| 資料庫與即時同步 | Supabase（PostgreSQL＋PostgREST RPC＋Realtime Broadcast） | 具持久化、伺服器原子操作與即時通知；免自架伺服器 |
| 教師登入 | Supabase Auth（Email＋密碼）＋`teachers` 白名單 | 學生不需帳號 |
| 學生身分 | 每台裝置的隨機憑證（localStorage），伺服器只存 SHA-256 | 不蒐集姓名，重新整理可恢復 |
| 第三方函式庫 | `js/vendor/` 內已打包的固定版本 supabase-js、qrcode | 學校網路常封鎖 CDN（原本從 esm.sh 載入） |

沒有引入其他服務（無 Edge Functions、無自架後端）。

## 1. 整體架構與三端資料流

```
                 ┌──────────────── Supabase ────────────────┐
 B 教師主控端 ──► │ teacher_* RPC（需登入＋白名單＋場次擁有者）│
 （登入）    ◄── │ RLS 唯讀：自己場次的所有資料              │
                 │                                          │
 A 投影端    ──► │ projector_state(場次, 投影金鑰)           │ ← 只回傳 session_state.projection
 （不登入）      │                                          │   （教師按下「公開」才寫入）
                 │                                          │
 C 學生端    ──► │ student_* / group_* RPC(場次, 裝置憑證)   │ ← 伺服器依「目前環節」判斷權限
 （不登入）      │                                          │
                 │ 資料變更 → realtime.send('lesson:<id>')   │ ── 只送「有變更」訊號，不含內容
                 └──────────────────────────────────────────┘
```

* **單一真實來源**：所有狀態都在資料庫；三端收到 Broadcast 訊號後重新呼叫 RPC 讀取。
* **Realtime 只是加速**：`js/lib/sync.js` 在 Realtime 連不上時自動改為 2～5 秒輪詢，回到前景或網路恢復時立即重讀。
  （端對端測試即在完全沒有 Realtime 的情況下執行，驗證輪詢備援。）
* **投影內容由教師端產生、伺服器保存**：教師端以 `js/lib/projection.js`（純函式）把「已核准公開」的資料組成
  `projection` 物件，經 `teacher_set_stage` 寫入；投影端只讀這份物件。未公開的線索、故事名稱、小說類型、
  教師補充資料都不會出現在其中（`tests/unit/projection.test.mjs` 驗證）。
* **教師預覽與公開分離**：預覽只存在教師端記憶體（例如 `S.genrePreview`），從不寫入資料庫。
  教師端右側「● 投影中」區塊渲染的是 `projector_state` 的回傳值（與投影端同一份程式 `render-projection.js`），
  「○ 預覽」區塊才是本機草稿。

## 2. 教學環節狀態機

伺服器狀態 `session_state`：`phase`、`sub`、`projection`、`rev`、`focus_mode`、`editing_paused`。
只有 `teacher_set_stage` 能改 `phase／sub／projection`，並以 `p_expected_rev` 做樂觀鎖（兩台教師裝置不會互相覆蓋）。
**倒數結束不會自動切換**，前端也沒有任何自動切換的計時器。

| 環節 | 學生畫面 | 學生權限（伺服器判斷） | 投影 `screen` | 子畫面 `sub` |
|---|---|---|---|---|
| 00 課前連線準備 | 已加入、等待 | 無 | `join`（QR、代碼、各組人數） | `00` |
| 01 走進故事世界 | 「請觀看前方投影…」 | 無（讀不到故事卡） | `intro` | `01-01`～`01-04` |
| 02 分類任務啟動 | 組別、進入探索模式 | 無 | `task`／`join`（補加入） | `02`、`02-qr` |
| 03 我的故事分類 | 個人分類 | `personal_edit` | `instruction` | `03` |
| 04 小組共作 | 個人快照（唯讀）＋小組工作區 | `group_edit`（該組 `open` 時） | `instruction` | `04` |
| 05 分類成果大公開 | 觀看 | 無 | Phase 4 | `05` |
| 06 揭開小說類型 | 觀看 | 無 | `genre` | `06-01`～`06-03` |
| 07 小小故事分類師 | 觀看 | 無 | Phase 4 | `07` |
| 99 課程結束 | 結束語 | 無 | `end` | `99` |

權限公式（`student_state.can`，每個寫入 RPC 也會再檢查一次）：

* `personal_edit = 場次進行中 ∧ phase = '03' ∧ ¬editing_paused ∧ 個人尚未提交`
* `group_edit = 場次進行中 ∧ phase = '04' ∧ ¬editing_paused ∧ 小組 status = 'open'`

環節切換的伺服器副作用（同一個交易內完成）：

| 轉換 | 副作用 |
|---|---|
| 從 ≤03 前往 ≥04 | 為每位學生寫入個人唯讀快照 `personal_snapshots`（未完成者保留已儲存部分並標示 `is_complete=false`） |
| 從 ≤04 前往 ≥05，且仍有 `open` 小組 | 回傳 `UNSUBMITTED_GROUPS`，**不切換**；教師選「鎖定」後才為這些組寫入 `locked` 快照並鎖定 |
| 前往 04 以外 | 清除所有小組操作鎖 |
| 任何轉換 | 不刪除任何成果資料 |
| 返回前一環節 | 只改 `phase`；已提交／已鎖定的小組維持唯讀，必須由教師「單組解鎖」 |

> 設計決定（Phase 2 起）：個人快照一旦建立，本場次的個人分類即鎖定。教師從 04 返回 03 時學生**不能**再修改，
> 再次進入 04 也**不覆寫**第一次的快照（Phase 1 原本採「最新草稿」，依 Phase 2 規格改變）。
> 小組共作的任何 RPC 都不寫入個人資料表，因此「個人成果不被小組共作覆蓋」由資料結構保證。

教師端會記住每個環節最後公開的畫面（`localStorage`），返回時恢復該畫面。

## 3. 資料模型

```
content_sets ─┬─ story_cards          第三、四環節故事卡（title, summary, detail, image_url）
              ├─ intro_stories ── intro_clues   第一環節（故事數、線索數皆不限）
              └─ genres               五種小說類型（elements: [{label, icon}], visual_url, teacher_notes）

sessions ─┬─ session_state            教師控制的課堂狀態＋已公開投影內容
          ├─ groups ─┬─ group_categories   小組分類（name, reason 各有版本號）
          │          ├─ group_placements   故事歸屬（每張卡一列，各有版本號；無資料列＝未分類）
          │          ├─ group_locks        短暫操作鎖（15 秒逾時）
          │          └─ group_snapshots    提交／鎖定時的成果快照（解鎖不刪除）
          └─ participants ─┬─ personal_boards     個人分類草稿（JSON＋版本號）
                           └─ personal_snapshots  第四環節開始時的唯讀快照
```

* 個人草稿格式：`{"categories":[{"id":"c1","no":1,"name":"會魔法"}],"placements":{"<卡片uuid>":"c1"}}`。
  伺服器 `app.normalize_personal` 檢查格式、卡片是否屬於本場素材、分類 id 是否存在。
* 小組資料正規化成多列，讓「移動卡片」「改名稱」「改理由」各自做版本檢查，不同組員可同時改不同欄位。
* 一張故事卡在一份成果中只有一個歸屬：個人是 JSON 物件的單一值，小組是 `(group_id, card_id)` 主鍵。
* 刪除分類：其中故事的 `category_id` 設為 null（回到未分類區），不會刪除故事。
* 暫時名稱「分類 N」只是顯示用（`no`／`label_no`），**名稱欄位仍為空**，提交時要求有效分類（至少有一張卡）都有名稱。
* 素材全部資料驅動：前端沒有寫死故事數量、線索數量或圖片位置；`*_url` 為空時顯示佔位框。

## 4. 即時同步與衝突保護策略

| 情境 | 機制 |
|---|---|
| 同組多人寫入 | 每個 `group_*` RPC 先以 `FOR SHARE` 讀 `session_state`、再 `SELECT … FOR UPDATE` 鎖住該組 `groups` 列，同組寫入在伺服器依序執行（Phase 3 起統一此鎖定順序，見 `PHASE3.md`） |
| 重送同一操作 | 新增分類帶前端 UUID（重送回傳原結果、已刪除的不重建）；移動／改字已是相同結果時回傳 `unchanged` |
| 教師暫停／結束時同時有學生操作 | 教師以 `FOR UPDATE` 鎖 `session_state`：進行中的學生操作先完成並被快照包含，之後的被拒絕 |
| 兩人同時移動同一張卡 | `group_move_card(…, p_expected_rev)`：版本不符回傳 `STALE`＋最新歸屬；拖曳期間可持有 `card:<id>` 鎖，他人移動回傳 `LOCKED` |
| 兩人同時改同一名稱／理由 | 進入輸入框時取得 `name:<id>`／`reason:<id>` 鎖；他人寫入回傳 `LOCKED`；另以 `name_rev`／`reason_rev` 拒絕舊版本 |
| 操作中途斷線 | 鎖 15 秒逾時（前端需每 5 秒續約）；逾時後斷線者的舊版本寫入仍因版本不符被拒絕，不會回溯 |
| 多人先後提交 | `group_submit(p_expected_board_rev)`：必須基於最新版本，且資料完整；提交後全組 `SUBMITTED` |
| 重新整理 | 所有資料都在伺服器，重新讀取 `student_group_board` 即恢復 |
| 個人分類多分頁 | `student_save_personal(p_expected_rev)` 拒絕舊版本，回傳最新資料 |
| 個人分類快速連續操作 | 前端序列化儲存（一次一個請求，永遠送最新整份資料）；未送達變更暫存於 localStorage，含基準版本 |
| 教師結束個人分類時同時有學生儲存 | 學生寫入以 `FOR SHARE` 讀 `session_state`，教師切換以 `FOR UPDATE` 鎖同一列，兩者依序執行（`tests/db/race_snapshot.sh`） |
| 教師兩台裝置 | `teacher_set_stage(p_expected_rev)` |

鎖與版本都在伺服器判斷，前端無法假造。`tests/db/concurrency.sh` 以 12 個真實資料庫連線、六組同時操作
1,800 次驗證：每張卡、每個分類名稱的版本號都等於成功次數（沒有遺失更新），且確實產生並拒絕了數百次衝突。

即時通知：`lesson:<場次>`（環節、名單、小組狀態變更）與 `group:<小組>`（小組工作區變更、鎖）。
正常同步時前端保持安靜，只有衝突、離線、儲存失敗才提示（Phase 3 實作畫面時遵守）。

## 5. 三端共用元件與專屬畫面

| 共用（`js/lib/`） | 用途 |
|---|---|
| `api.js` | Supabase 連線、RPC 包裝、錯誤代碼轉中文 |
| `sync.js` | Broadcast 訊號＋輪詢備援的同步迴圈 |
| `phases.js` | 環節定義、學生畫面對照、固定教學文字 |
| `projection.js` | 投影內容產生器（純函式，可測試） |
| `render-projection.js` | 投影畫面渲染（投影端與教師端預覽共用，確保預覽＝實際投影） |
| `dom.js` | 極簡 DOM 工具、圖片佔位、對話框 |
| `qr.js` | QR Code 與加入網址 |

| 專屬 | 檔案 |
|---|---|
| B 教師主控端 | `teacher.html`、`js/teacher/main.js` |
| A 投影端 | `projector.html`、`js/projector/main.js` |
| C 學生端 | `join.html`、`js/student/main.js` |

| 分類工作區（Phase 2） | 檔案 |
|---|---|
| 資料模型（純函式，個人與小組共用） | `js/lib/board-model.js` |
| 畫面元件：故事卡、閱讀視窗、未分類區、分類群組、拖曳／點選移動、命名 | `js/lib/board-view.js` |
| 03 學生端控制器（自動儲存、提交、鎖定） | `js/student/personal.js` |

| 04 學生端控制器（操作佇列、樂觀顯示、操作鎖、離線） | `js/student/group.js` |

Phase 3 小組共作沿用 `board-model.js`、`board-view.js`，只替換資料來源與 `onChange` 的處理（見 `PHASE3.md` 第四節）。

## 6. 資料庫與部署需求

* Supabase 專案一個（免費方案即可）；執行 `supabase/migrations/001～003` 與 `supabase/seed/001`。
* Realtime 使用資料庫端 `realtime.send()`（Broadcast from Database），公開頻道，不需額外設定 Publication。
* GitHub Pages：從 repo 根目錄部署；`config.js` 填入 Project URL 與 anon／publishable key（可公開）。
* 詳見 [`DEPLOY.md`](DEPLOY.md)。

## 7. 規格檢查：衝突與建議

| # | 發現 | 處理／建議 |
|---|---|---|
| 1 | 7.4 允許暫時名稱「分類 1」，7.5 又要求「每個有效分類都有名稱」 | 暫時名稱只是顯示，名稱欄位仍為空；提交時要求命名。空分類（沒有卡片）不擋提交 |
| 2 | 03 只有 5 分鐘，8 張故事＋閱讀詳細介紹，平均每張不到 40 秒 | 建議正式素材 6～8 張、摘要一行、詳細介紹 100 字內；教師可延長時間（不會自動切換） |
| 3 | 規格要求「教師可遠端進入全螢幕」的期待 | 瀏覽器不允許遠端強制全螢幕；學生按「進入探索模式」時請求全螢幕（iPad Safari 支援程度依版本而定，iPhone 不支援元素全螢幕），失敗即使用網站專注模式，不影響參與 |
| 4 | 投影「加入狀態」人數在環節不變時不會更新（原前端以 `rev` 判斷是否重畫） | 已修正：`projector_state.rev` 納入名單資訊 |
| 5 | Realtime 連不上時，重連回呼不斷延後輪詢，導致三端完全不同步（原 `sync.js` 的錯誤） | 已修正並以端對端測試驗證（測試中沒有 Realtime） |
| 6 | 原前端從 esm.sh CDN 載入 supabase-js；學校網路封鎖 CDN 時整個網站無法使用 | 改為 `js/vendor/` 內的固定版本 |
| 7 | 從 04 返回 03 後再進 04，個人快照應保留哪一份？ | Phase 2 起：保留第一次快照，且返回 03 不解鎖（依 Phase 2 規格） |
| 8 | 05 需要「不公開其他組即時分類」與「展示正式成果」 | Phase 4 的 05 將只讀取 `group_snapshots`（提交或鎖定當下的版本），不讀即時工作區；資料表已就緒 |
| 9 | 規格的 07 結束畫面另外設為 `99 課程結束`，不計入時間 | 已在環節列表中；教師可選擇是否使用 |
| 10 | 教師按「結束場次」時若仍在 03／04 | 自動保存個人快照並鎖定未提交小組，避免成果遺失 |

## 8. 已知限制與後續待完成

**已完成並驗證（本機 PostgreSQL＋模擬 Supabase API，見 [`TESTING.md`](TESTING.md)）**：
三端路由與角色權限、00～07 狀態機、教師主控與投影同步、六組加入與連線管理、素材資料結構與佔位、
個人與小組分類的資料庫設計與全部 RPC（含衝突保護、提交、解鎖、快照）。

**尚未在正式 Supabase 上驗證**（本環境無法連到 Supabase；部署後請依 `TESTING.md` 第三節手動驗收）：
* Realtime Broadcast（`realtime.send`）是否即時送達——即使失敗，輪詢備援仍會在數秒內同步。
* PostgREST 對 RPC 具名參數的呼叫（本機以相容的小伺服器模擬）。
* Supabase 內建角色的預設權限是否被 `003_security.sql` 完整收回（本機以模擬角色驗證）。

**安全上的取捨**：
* 投影金鑰放在投影網址中；拿到連結的人只能看到「已公開」的投影內容。
* Realtime 頻道為公開頻道，知道場次 id 的人可收到／送出「有變更」訊號，最多只會讓各端多讀一次，不會取得資料。
* 學生憑證存在瀏覽器；清除網站資料或換瀏覽器會被視為新學生（教師可在連線管理移出重複的人）。

**後續 Phase**：
* Phase 2：學生個人分類操作畫面（拖曳／點選移動、命名、自動儲存、提交）、教師進度與鎖定。✅ 已完成（`PHASE2.md`）。
* Phase 3：小組共作畫面（左側個人快照面板、右側共同工作區、鎖的取得與續約、衝突提示）、教師單組檢視。✅ 已完成（`PHASE3.md`）。
* Phase 4：05 雙組比較與故事追蹤、07 分類與小說要素對照、句型鷹架（投影資料格式與教師端控制）。
* Phase 5：全流程實機多人測試、版面優化、正式素材整合。
