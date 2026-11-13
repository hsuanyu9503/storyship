# 交接報告：請協助複檢 Phase 4（05 成果比較、06 揭露、07 對照）

> 給複檢者：請以「找出錯誤」為目標。以下宣稱都可用檔案與指令驗證；若與程式碼不一致，以程式碼為準並指出差異。
> 作者回報的測試數字**不是**你的測試結果。

## 1. 版本

| 項目 | 內容 |
|---|---|
| Repo | `github.com/hsuanyu9503/storyship` |
| base | `main` = `89299afeeaa697e89429284a48fbf3de6c7d1d24`（PR #5 合併；內容與 `28c9ed6` 相同） |
| 上一輪複檢的 head | `97af137a9b08b0ddeeac0460b111943d5b1e3f83`（報告 `PHASE4_REVIEW_97af137.md`） |
| 本輪 head | 分支 `claude/phase4-results`（完整 SHA 見 PR 說明；本輪修正只有一個 commit，疊在 97af137 之上） |
| 依賴 | 不依賴任何未合併的 PR |


## 1a. 本輪修正（對 97af137 複檢的 F1、F2、F3 與候選 A、B）

| 項目 | 原因 | 修正 | 主要位置 |
|---|---|---|---|
| F1 類型名稱 vs 要素 | `app.disclose_genres` 把 06 的完整揭露與 07 的類型索引合併成同一個 `genres` 陣列；06 的投影由教師端產生，前端再把它併入 `revealed`，總覽於是帶出全部要素 | 揭露紀錄改為 `{"revealed":{"<類型>":[要素]}}`；06 投影改由伺服器產生（教師端只送畫面種類與位置，`ctl.revealed`／`genres`／`genre` 一律忽略）；只有 `ctl.reveal:true`（「揭開小說世界」）才完整揭露；07 只記錄當次公開的要素；舊格式只視為名稱 | `002_rpc.sql` 第 189 行起（`teacher_set_stage`）、第 1166–1280 行（`disc_map`、`genre_at`、`disc_add`、`genre_build`、`disc_from_legacy`）、第 1326 行（`teacher_publish_match`）；`main.js` 第 254、398、498 行；`projection.js` 第 130 行；`render-projection.js` 第 160 行；`results-model.js` 第 153 行 |
| F2 離開 03 的確認 | `goPhase` 的 06 分支在 `confirmEndPersonal` 之前 `return` | 共同的離開確認移到所有目的環節專屬邏輯之前 | `main.js` 第 254–265 行（確認在第 258 行，06 分支在第 261 行） |
| F3 預覽與選擇 | 預覽只靠序號、`isDirty` 只比較選擇（預覽未回來時可公開尚未預覽的選擇、也會顯示「一致」）；另有「公開在途時的點擊會在完成後以最新選擇自動再公開」的程式路徑（公開鈕在途時已停用，介面上按不到；仍一併移除） | 草稿版本 `ver`；預覽回應只在版本相符時採用；版本不符時舊預覽標示過期、公開鈕停用；公開固定送出的選擇、移除自動再公開；「一致」同時比較選擇、預覽版本、預覽內容＝投影內容；預覽錯誤可重試 | `results.js` 第 43、46、65、90、159、300、315 行；`results-model.js` 第 165 行 |
| 候選 A | 確認為真實缺陷：Phase 3 停在 06（投影由舊教師端產生）時升級，進入 07 後 `disclosure` 仍是 `{}`，無 localStorage 的裝置返回 06 會遺失已揭開的類型（以 97af137 的升級檔重跑同一情境確認） | `app.disc_from_legacy`：離開舊版 genre 投影前，把其中 `ctl.revealed` 的類型記為完整揭露（這些類型當時已完整顯示） | `002_rpc.sql` 第 1264 行；`upgrade_bundle.sh` 第 6 節 |
| 候選 B | 確認為真實缺陷：合法上限內容（名稱 30 字、理由 300 字、8 張故事）在 05 雙組每頁 4 類時有 26 個元素被裁切；連每頁 1 類、聚焦也會裁切；07 顯示理由時理由被裁切 | 05：教師可選每頁 4／2／1 類、「放大此側」（投影只放該側、全寬；另一側不進投影資料）；07：理由改為橫跨全寬的列、故事較多時改為名稱標籤；字級都不變。教師預覽量到放不下時提醒 | `002_rpc.sql` 第 1045、1079 行；`results.js` 第 207、285 行；`render-projection.js` 第 96、144 行；`tests/e2e/layout.js` |

不變的部分：原始個人／小組分類與快照不改寫；公開成果仍綁定 snapshot ID；教師身分、場次擁有權、跨場次 ID 驗證、
Phase 3 的鎖順序（sessions → session_state）、版本檢查、操作世代與刪除結果重送都未改動；沒有放寬 RLS、RPC 權限或公開白名單
（新函式全在 `app` schema，`003_security.sql` 的 `revoke execute on all functions in schema app` 涵蓋；verify 第 17 項另外檢查 `app.genre_build` 不開放給 anon／authenticated）。

## 2. 變更檔案

| 檔案 | 內容 |
|---|---|
| `supabase/migrations/002_rpc.sql` | 新欄位 `session_state.stage_ctl`、`disclosure`（第 34–35 行）；`teacher_set_stage` 拒絕前端自組 `compare`／`match`、返回 05／07 時依 `stage_ctl` 重建、06 揭露紀錄（第 141 行起）；Phase 4 函式（第 921 行起） |
| `supabase/migrations/003_security.sql` | 四個新 RPC 只授權給 `authenticated` |
| `supabase/checks/verify.sql` | 第 16、17 項 |
| `supabase/upgrade/upgrade.sql` | 由 `build.sh` 重新產生 |
| `supabase/rollback/phase4_to_phase3.sql` | 新增 |
| `js/teacher/results.js` | 新增：05／07 教師面板、預覽、公開、快照選取 |
| `js/lib/results-model.js` | 新增：教師端選擇（ctl）與快照清單的純函式 |
| `js/lib/render-projection.js` | 新增 `compare`、`match` 畫面；`placeholder` 文字 |
| `js/lib/projection.js` | 05／07 等待畫面 |
| `js/teacher/main.js` | 接上 results.js；06 揭露紀錄合併（`goPhase`、`ctl06`）；快照清單含內容；素材類型排序加 `slug` |
| `js/lib/api.js` | `SAME_GROUP` 錯誤訊息 |
| `css/app.css` | 投影 05／07 版面、教師面板 |
| `tests/db/tests_results.sql`（新增）、`tests/db/run.sh`、`tests/db/upgrade_bundle.sh` | Phase 4 資料庫測試、升級測試 |
| `tests/unit/results-model.test.mjs`（新增） | 純函式測試 |
| `tests/e2e/e2e.js` | 05／06／07 流程、兩台教師裝置、N1 網路重送補測 |
| `docs/*` | PHASE4.md（新增）、本文件、README、ARCHITECTURE、DEPLOY、TESTING |

## 3. 重要入口

**SQL**（`supabase/migrations/002_rpc.sql`）

| 函式 | 作用 |
|---|---|
| `app.snapshot_norm(data, set)` | 快照正規化（相容 Phase 1／2 與 3 格式），以 placements 決定歸屬 |
| `app.snapshot_for(session, snapshot)` | 驗證快照屬於該場次，回傳組別與正規化內容 |
| `app.compare_build(session, ctl)` | 05 的驗證＋白名單投影；回傳 `{ctl, projection}` |
| `app.match_build(session, ctl)` | 07 的驗證＋白名單投影 |
| `app.disc_map(disc)` | 讀取揭露紀錄（相容舊格式 `genres`，只算名稱） |
| `app.disc_add(session, disc, idx, els)` | 加入揭露（只增加；`els` 為 null＝全部要素） |
| `app.genre_build(session, req, disc)` | 06 的投影（伺服器產生，依揭露紀錄） |
| `app.disc_from_legacy(session, disc, proj)` | 升級相容：舊版 06 投影中已完整揭開的類型 |
| `teacher_preview_compare／match` | 唯讀預覽（`stable`；`app.teacher_session_ro`） |
| `teacher_publish_compare／match` | 公開：版本檢查、限定環節、寫入 `projection` 與 `stage_ctl` |
| `teacher_set_stage` | 新增：拒絕 `compare`／`match`、05／07 依 `stage_ctl` 重建、06 投影由伺服器產生並記錄揭露 |

**JS**：`js/teacher/results.js`（`previewReady` 第 43 行、`isConsistent` 第 46 行、`requestPreview` 第 65 行、`publish` 第 90 行、`statusBar` 第 159 行、`fitCheck` 第 285 行、`previewNode` 第 300 行、`onLive` 第 315 行）；
`js/lib/render-projection.js`（`compare` 第 91 行、`match` 第 119 行、06 總覽第 154 行）；`js/teacher/main.js`（`goPhase` 第 254 行、`ctl06` 第 398 行）。

## 4. 公開資料格式（`session_state.projection`，投影端唯一讀取的內容）

```json
{"screen":"compare","title":"分類成果大公開","story":{"title":"故事 A"} | null,"zoom":false,
 "sides":[{"side":"left","group":"第 1 組","number":1,"kind":"submitted|locked","complete":true,
           "total":2,"page":0,"pages":1,"per":4,"focus":false,"unplaced_count":0,
           "track":{"where":"分類名稱","unplaced":false} | {"where":null,"unplaced":true} | null,
           "categories":[{"label":"會魔法的故事","unnamed":false,
                          "cards":[{"title":"故事 A","image_url":null,"tracked":true}],
                          "reason_state":"hidden|shown|empty","reason":"（只有 shown 時才有）"}]}]}

{"screen":"match","title":"小小故事分類師",
 "group":{"group":"第 1 組","number":1,"kind":"submitted","complete":true} | null,
 "category":{"label":"…","unnamed":false,"cards":[{"title":"…","image_url":null}],"reason_state":"hidden|shown|empty","reason":"…"} | null,
 "genre":{"name":"偵探小說","visual_url":null,
          "elements":[{"slot":0,"revealed":true,"label":"神祕案件","icon":"❓","highlight":true},{"slot":1,"revealed":false}]} | null,
 "scaffold":true}

{"screen":"genre","view":"overview","ctl":{"view":"overview","index":0,"revealed":[2]},
 "genres":[null,{"name":"偵探小說","visual_url":null,"elements":[{"label":"神祕案件","icon":"❓"},{"hidden":true},{"hidden":true}]},
           {"name":"歷史小說","visual_url":null,"elements":[…三個…]},null,null]}
```

揭露紀錄（`session_state.disclosure`，只有教師可讀）：`{"revealed":{"1":[0],"2":[0,1,2]}}`

教師的選擇（`session_state.stage_ctl`，只有教師可讀）：

```json
{"05":{"left":"<snapshot>","right":"<snapshot>","story":"<card>","reasons":{"left":["<cat>"],"right":[]},
       "page":{"left":0,"right":0},"focus":{"left":null,"right":null},
       "per":{"left":4,"right":4},"zoom":null},
 "07":{"snapshot":"<snapshot>","category":"<cat>","show_reason":false,"genre":1,"elements":[0],"highlights":[0],"scaffold":true}}
```

## 5. 權限邊界

* anon（學生、投影）：不能執行任何 `teacher_*`，不能讀 `group_snapshots`、`session_state`；投影只經由 `projector_state` 取得 `projection`。
* authenticated 但非場次擁有者：`FORBIDDEN`；RLS 讀不到 `session_state`（含 `stage_ctl`）。
* 所有 ID 都在伺服器端驗證歸屬（快照→場次、分類→該側快照、故事→本場素材、類型與要素索引範圍）。

## 6. 競態處理

| 情境 | 處理 |
|---|---|
| 兩台教師裝置同時公開 | `session_state.rev` 版本檢查，過期回 `STALE`（e2e：攔截延遲裝置 1 的請求，裝置 2 先公開） |
| 快速連續公開 | 前端一次一個請求；公開在途時公開鈕停用；在途時的修改**不會**自動公開（e2e：公開 G 在途時改成 H，H 未公開） |
| 預覽回應反序／延遲／失敗 | 草稿版本；只採用目前版本的回應；版本不符時不能公開（e2e：延遲、反序、舊請求失敗後才到、失敗後重試、在途時快速改選） |
| 公開後出現新快照 | 不自動更換；教師端提示，由教師決定（db：重新開放→再提交→返回 05 仍是原快照） |
| 05／07 與學生寫入 | Phase 4 函式只讀快照；公開時鎖 sessions（NO KEY UPDATE）→ session_state（FOR UPDATE），與 Phase 3 協定一致 |

## 7. 測試（作者在本機執行；結果見 PHASE4.md 第十一節）

`npm run test:unit`、`test:db`、`test:race`、`test:upgrade`、`test:concurrency`、`tests/e2e`。
環境：PostgreSQL 16、Node 22、Playwright Chromium（headless）、`tests/e2e/shim.js` 模擬 Supabase API（無 Realtime）。

## 8. 建議複檢重點

1. **白名單是否完整**：`compare_build`／`match_build` 的輸出是否可能夾帶未揭露的理由、要素、教師補充或 ID（例如 `cat_label` 的 `label` 來源、`card_pub`）。
2. **驗證是否有漏洞**：`ids_subset`、`uuid_or_null`、要素索引的檢查（含非整數、負數、字串數字、`null`）；`p_ctl` 夾帶多餘欄位時是否被正規化掉。
3. **`teacher_set_stage` 的重建**：返回 05／07 時，若當時綁定的快照已不存在（場次中的快照不會被刪除，但請確認）是否會讓切換失敗。
4. **06 揭露**：`genre_build` 是否還有任何教師端欄位會影響投影內容（`items` 只在 recap 使用並限制長度與數量）；`disc_from_legacy` 只在目前投影是 `screen:"genre"` 時才讀 `ctl.revealed`——伺服器產生的投影中它只列出已完整揭露的類型，請確認無法藉此擴大。
5. **前端狀態**：`results.js` 的 `syncVer`／`onLive` 在另一台裝置公開、自己公開失敗、公開在途時修改再改回原值等情況下，草稿與標示是否正確。
8. **版面偵測**：`fitCheck` 以 `scrollHeight > clientHeight` 判斷；教師預覽與投影的寬度不同，以 `cqw` 字級等比縮放——是否有字型換行差異造成預覽放得下、投影放不下。
6. **舊格式快照**：`snapshot_norm` 與 `results-model.normalizeSnapshot` 的排序是否完全一致（教師端列出的分類與投影的順序）。
7. **效能**：`compare_build` 在分類多、故事多時的查詢成本（目前為 jsonb 逐項處理）。

## 9. 尚未驗證

正式 Supabase（PostgREST、雙教師 JWT、預設 ACL、Realtime）、實體平板觸控、實際投影機可讀性、D2 跨鎖逾時的真實並行讀取。
