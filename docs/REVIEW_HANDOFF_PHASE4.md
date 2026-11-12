# 交接報告：請協助複檢 Phase 4（05 成果比較、06 揭露、07 對照）

> 給複檢者：請以「找出錯誤」為目標。以下宣稱都可用檔案與指令驗證；若與程式碼不一致，以程式碼為準並指出差異。
> 作者回報的測試數字**不是**你的測試結果。

## 1. 版本

| 項目 | 內容 |
|---|---|
| Repo | `github.com/hsuanyu9503/storyship` |
| base | `main` = `89299afeeaa697e89429284a48fbf3de6c7d1d24`（PR #5 合併；內容與 `28c9ed6` 相同） |
| head | 分支 `claude/phase4-results`（完整 SHA 見 PR 說明） |
| 依賴 | 不依賴任何未合併的 PR |

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
| `app.disclose_genres(session, disc, idx)` | 06／07 的類型揭露紀錄（只增加、驗證索引） |
| `teacher_preview_compare／match` | 唯讀預覽（`stable`；`app.teacher_session_ro`） |
| `teacher_publish_compare／match` | 公開：版本檢查、限定環節、寫入 `projection` 與 `stage_ctl` |
| `teacher_set_stage` | 新增：拒絕 `compare`／`match`、05／07 依 `stage_ctl` 重建、06 揭露紀錄 |

**JS**：`js/teacher/results.js`（`requestPreview` 第 50 行、`publish` 第 68 行、`panel05` 第 150 行、`panel07` 第 209 行、`onLive` 第 261 行）；
`js/lib/render-projection.js`（`compare` 第 91 行、`match` 第 119 行）；`js/teacher/main.js` 第 258 行（06 揭露紀錄合併）。

## 4. 公開資料格式（`session_state.projection`，投影端唯一讀取的內容）

```json
{"screen":"compare","title":"分類成果大公開","story":{"title":"故事 A"} | null,
 "sides":[{"side":"left","group":"第 1 組","number":1,"kind":"submitted|locked","complete":true,
           "total":2,"page":0,"pages":1,"focus":false,"unplaced_count":0,
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
```

教師的選擇（`session_state.stage_ctl`，只有教師可讀）：

```json
{"05":{"left":"<snapshot>","right":"<snapshot>","story":"<card>","reasons":{"left":["<cat>"],"right":[]},
       "page":{"left":0,"right":0},"focus":{"left":null,"right":null}},
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
| 快速連續公開 | 前端一次一個請求；期間的點擊合併為「完成後以最新選擇再公開一次」（e2e：連按三次，投影停在最後一次） |
| 預覽回應反序 | 序號，舊的忽略 |
| 公開後出現新快照 | 不自動更換；教師端提示，由教師決定（db：重新開放→再提交→返回 05 仍是原快照） |
| 05／07 與學生寫入 | Phase 4 函式只讀快照；公開時鎖 sessions（NO KEY UPDATE）→ session_state（FOR UPDATE），與 Phase 3 協定一致 |

## 7. 測試（作者在本機執行；結果見 PHASE4.md 第十一節：unit 22、db 310、race 13、upgrade 22、concurrency 通過、e2e 160 連續 3 次）

`npm run test:unit`、`test:db`、`test:race`、`test:upgrade`、`test:concurrency`、`tests/e2e`。
環境：PostgreSQL 16、Node 22、Playwright Chromium（headless）、`tests/e2e/shim.js` 模擬 Supabase API（無 Realtime）。

## 8. 建議複檢重點

1. **白名單是否完整**：`compare_build`／`match_build` 的輸出是否可能夾帶未揭露的理由、要素、教師補充或 ID（例如 `cat_label` 的 `label` 來源、`card_pub`）。
2. **驗證是否有漏洞**：`ids_subset`、`uuid_or_null`、要素索引的檢查（含非整數、負數、字串數字、`null`）；`p_ctl` 夾帶多餘欄位時是否被正規化掉。
3. **`teacher_set_stage` 的重建**：返回 05／07 時，若當時綁定的快照已不存在（場次中的快照不會被刪除，但請確認）是否會讓切換失敗。
4. **06 揭露紀錄**：`disclose_genres` 只增加；06 的投影內容仍由教師端產生——是否可能藉 06 的 `ctl.revealed` 以外的欄位提前公開其他類型？
5. **前端狀態**：`results.js` 的 `onLive`／`isDirty` 在另一台裝置公開、或自己公開失敗時，草稿與「尚未公開」標示是否正確。
6. **舊格式快照**：`snapshot_norm` 與 `results-model.normalizeSnapshot` 的排序是否完全一致（教師端列出的分類與投影的順序）。
7. **效能**：`compare_build` 在分類多、故事多時的查詢成本（目前為 jsonb 逐項處理）。

## 9. 尚未驗證

正式 Supabase（PostgREST、雙教師 JWT、預設 ACL、Realtime）、實體平板觸控、實際投影機可讀性、D2 跨鎖逾時的真實並行讀取。
