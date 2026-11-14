# 部署與使用說明

部署分成兩個**獨立**的部分：

* **A. 資料庫（Supabase）**：只需設定一次。日後更新網站畫面**不需要**重跑 SQL。
* **B. 網站（GitHub Pages）**：每次推送程式碼就會更新。

---

## A. 資料庫設定（Supabase，一次性）

### A-1 建立專案

1. 到 <https://supabase.com> 建立免費帳號與新專案（Region 建議選 Northeast Asia (Tokyo) 或 Singapore）。
2. 記下 **Project Settings → API** 中的：
   * **Project URL**（例如 `https://abcd1234.supabase.co`）
   * **anon / publishable key**（可放在前端，**不是** `service_role` / secret key）

### A-2 執行 SQL（依序，各執行一次）

在 Supabase Dashboard → **SQL Editor** → New query，依序貼上整個檔案內容並按 Run：

| 順序 | 檔案 | 內容 | 可重複執行？ |
|---|---|---|---|
| 1 | `supabase/migrations/001_init.sql` | 資料表、內部函式、觸發器 | **否**（只執行一次） |
| 2 | `supabase/migrations/002_rpc.sql` | 所有 RPC | 是（日後修正函式時只需重跑此檔） |
| 3 | `supabase/migrations/003_security.sql` | RLS 與權限 | 是（重跑 002 後**一定要**重跑） |
| 4 | `supabase/seed/001_placeholder_content.sql` | 佔位素材（故事 A～H、兩個探索故事、五種小說類型的佔位文字） | 是（以 slug 更新，不會重複新增） |
| 5 | `supabase/content/genre_materials_v1.sql` | 小說類型正式教材（名稱、常見特色、教師補充、圖片；見 `docs/GENRE_MATERIALS.md`） | 是（結果相同） |
| 6 | `supabase/content/story_cards_v1.sql` | 第 03、04 環節的故事卡正式教材（八部作品的名稱、故事介紹、故事元素、圖片；見 `docs/STORY_CARDS.md`） | 是（結果相同） |
| 7 | `supabase/content/intro_materials_v1.sql` | 第 01 環節「走進故事世界」正式教材（兩則神祕故事的線索、揭曉、名字變化、揭曉圖與單元文案；見 `docs/INTRO_UNIT.md`） | 是（結果相同） |

每個檔案執行後應顯示 `Success. No rows returned`。最後執行 `supabase/checks/verify.sql`，每一列的 `ok` 都應為 `true`。

### A-3 建立教師帳號

1. Dashboard → **Authentication → Users → Add user → Create new user**，輸入教師 Email 與密碼，勾選 *Auto Confirm User*。
2. 開啟 `supabase/setup/add_teacher.sql`，把 `teacher@example.com` 改成該 Email，在 SQL Editor 執行。最後一行應列出該帳號。
3. 建議到 **Authentication → Providers → Email** 關閉 *Allow new users to sign up*（教師帳號都由管理者建立）。

### A-4 Realtime

不需要額外設定。資料庫以 `realtime.send()` 送出公開 Broadcast 訊號（不含教學內容）。
若 Realtime 不可用，網站會自動改用 2～5 秒輪詢，仍可正常上課（只是反應稍慢）。

---

## B. 網站部署（GitHub Pages）

1. 編輯 repo 根目錄的 `config.js`：

   ```js
   export const CONFIG = {
     SUPABASE_URL: 'https://abcd1234.supabase.co',
     SUPABASE_ANON_KEY: '你的 anon / publishable key',
   };
   ```

   > anon key 本來就設計為公開，安全由資料庫的 RLS 與 RPC 檢查負責。**絕對不要**放 `service_role` key。

2. 推送到 GitHub。
3. GitHub repo → **Settings → Pages → Build and deployment**：Source 選 **GitHub Actions**。
   之後每次推送到 `main`，`.github/workflows/pages.yml` 會執行 `tools/build_site.sh`，只發布網站需要的檔案：
   `index.html`、`join.html`、`teacher.html`、`projector.html`、`config.js`、`js/`、`css/`、`assets/`。
4. 約一分鐘後網站位於 `https://<帳號>.github.io/storyship/`（Actions 分頁可看到部署結果）。

> **不要再用 *Deploy from a branch*。** 這個 repo 有 `.nojekyll`，用分支發布時 GitHub 會原樣公開整個分支，
> 包括 `docs/intro-source.json`（第 01 環節的答案稿）、`docs/screenshots/`（揭曉截圖）、`source-assets/`（Word 原稿與原始圖）、
> `supabase/`、`tests/`。若之前用分支發布，改成 GitHub Actions 後這些網址會變成 404。
>
> **repo 本身是公開的**：即使網站不發布這些檔案，任何人仍可在 github.com 上的 repo 頁面讀到 `docs/`、`source-assets/` 等檔案。
> 若不希望學生在課前看到答案，需要另外決定（例如把 repo 改為私人：GitHub 免費方案的私人 repo 不能使用 Pages，需付費方案；
> 或把教材原稿移到其他私人位置）。這一點本專案沒有自行變更。

本機確認發布內容：`bash tools/build_site.sh`（輸出到 `_site/`，已列入 `.gitignore`），測試：`node tests/e2e/site_build.js`、`bash tests/e2e/site_build_safety.sh`。
打包腳本只會清理專案根目錄下、由它自己產生的 `_site`（有 `.storyship-site-build` 標記檔）；指定其他輸出位置時，
專案內的其他資料夾（例如 `assets`）、專案外已存在的資料夾與符號連結一律拒絕，不刪除也不覆寫。

**上線前的待辦（需要 repo 管理者）**：合併前到 Settings → Pages 把 Source 從「Deploy from a branch」改為「GitHub Actions」。
部署後確認：`https://<帳號>.github.io/storyship/docs/intro-source.json`、`.../source-assets/intro/`（Word 原稿）、
`.../docs/screenshots/intro/03-reveal-conan.webp` 都回傳 404，兩張揭曉圖（`assets/intro/conan-1600.webp`、`assets/intro/chihiro-1600.webp`）可以載入。

網站不需要建置步驟，也不從 CDN 載入任何程式（`js/vendor/` 已包含固定版本的 supabase-js 與 qrcode）。

### 本機預覽

```bash
python3 -m http.server 8080
```

然後開啟 <http://localhost:8080/>（需要 `config.js` 已設定）。

---

## C. 上課使用流程

1. 教師開啟 `…/teacher.html` 登入 → 建立場次（六組）→ 進入主控台。
2. 按「開啟投影」，把開啟的投影分頁拖到教室投影螢幕並按「全螢幕」。
   投影網址包含投影金鑰，只會顯示教師已公開的內容。
3. 學生用平板掃描投影上的 QR Code（或開啟 `…/join.html` 輸入六碼代碼）→ 選組 → 確認。
4. 教師在主控台左側依序切換環節；每個環節的按鈕只會改變「投影中」的畫面，「預覽」不會投影。
5. 03 個人分類：主控台顯示各組完成人數，可展開查看每位學生、暫停／恢復；按「結束個人分類，進入第四環節」時
   會顯示未完成人數，確認後所有個人分類鎖定並保存快照（之後返回 03 也不會解鎖）。
   04 小組共作：主控台顯示六組的已分類、分類數、理由完成與狀態；「查看」可看單組成果（不投影）；
   已提交的組可「重新開放」；「結束共同分類」時列出各組狀態，確認後未提交的組保存目前成果並停止編輯。
   05／07：所有選擇只改變教師端「預覽」，按「公開到投影」後全班才看到（步驟見 `PHASE4.md` 第八節）。
6. 下課時按「結束場次」：學生不能再修改，所有成果保留。

### 常見狀況

| 狀況 | 處理 |
|---|---|
| 學生選錯組 | 主控台「連線管理」→ 該學生的「移到第 N 組」 |
| 學生換了平板或清除瀏覽資料 | 會被視為新學生重新選組；舊的紀錄可在連線管理「移出」 |
| 遲到學生 | 02 環節「投影重新顯示 QR Code」；或在 00 確認「開放新學生加入」為開啟 |
| 某組已提交但想修改 | 04 環節表格中的「重新開放」（只限第四環節；先前的成果會保留） |
| 學生端顯示「組員操作中」／「組員輸入中…」 | 其他組員正在操作那張卡或那個欄位，等一下即可；最長 15 秒後自動解除 |
| 學生端顯示「連線中斷，重新連線後即可繼續共作」 | 網路恢復後自動讀取最新內容；離線期間不能修改小組成果 |
| 學生個人分類已提交但想修改 | 03 環節內學生可自己按「繼續修改」；教師結束個人分類後無法再修改 |
| 學生端顯示「尚未儲存」 | 網路恢復後會自動儲存；按「完成」前會確認已儲存 |
| 學生端顯示「網路連線中斷」 | 已儲存的資料不會遺失；網路恢復後自動重新讀取 |

---

## D. 更換正式素材

素材都在資料庫，網站程式不需修改：

* Dashboard → **Table Editor** 直接改 `story_cards`、`intro_stories`、`intro_clues`、`genres` 的文字與網址欄位；或
* 修改 `supabase/seed/001_placeholder_content.sql` 後重新執行。

圖片：放在 repo 的 `assets/` 資料夾（例如 `assets/story-a.png`），欄位填 `assets/story-a.png`；也可填完整網址。
欄位留空（null）時會顯示虛線佔位框。

| 資料表 | 圖片欄位 |
|---|---|
| `story_cards` | `image_url`（故事卡圖片；正式教材為 `assets/stories/story-NN.webp`，網站會自動使用同名的 `-600w` 縮圖）；`elements`（故事元素，字串陣列，例如 `["神奇零食","實現願望"]`；空陣列時背面不顯示元素區） |
| `intro_stories` | `background_url`（情境背景）、`image_url`（故事代表圖片） |
| `intro_clues` | `image_url`（人物／物件插畫） |
| `genres` | `visual_url`（06 直式主圖）、`visual_landscape_url`（07 橫式圖，可留空：留空時 07 改用直式主圖完整呈現）；`elements[].icon`（選用；沒有時顯示編號） |

故事卡數量、探索故事數量、每個故事的線索數量都可以任意增減。
**上課中請勿刪除故事卡**，否則該卡片的分類紀錄會一起刪除。

---

## E. 資料保存與清除

* 每個場次預設在「結束」後保留 30 天（`sessions.retention_days`，1～365）。
* 場次列表的「清除已過保留期限的場次」會刪除自己已過期的場次。
* 「刪除」會立即永久刪除該場次與所有學生成果。
* 網站不蒐集學生姓名；資料庫只存裝置憑證的雜湊值與「第 N 組・N 號」。

---

## F. 日後更新資料庫

### 最簡單的升級方式（任何已部署的版本都適用）

在 SQL Editor 貼上並執行 **`supabase/upgrade/upgrade.sql`** 一個檔案即可（內容＝002 → 003，包在單一交易中，最後自動執行檢查）。
執行中任何錯誤都會全部回復，不會留下半套狀態；可重複執行；不刪除、不修改任何既有資料。
結果表格的 `ok` 都應為 `true`（17 列）。檢查在 commit 之後執行：若出現 `false`，升級已完成、不會自動回復，請處理後重新執行。修改 002／003 之後，請執行 `bash supabase/upgrade/build.sh` 重新產生此檔。

### 從 Phase 3 升級到 Phase 4

同樣執行 **`supabase/upgrade/upgrade.sql`** 一次（17 列都應為 `true`），再把網站合併到 `main`，所有裝置重新整理。
新增欄位 `session_state.stage_ctl`、`session_state.disclosure`（`add column if not exists`），不修改既有資料或快照。
退回 Phase 3：Phase 3 版本（`89299af`）的 002 → 003 → `supabase/rollback/phase4_to_phase3.sql`。詳見 [`PHASE4.md`](PHASE4.md)。

### 從 Phase 2 升級到 Phase 3（已部署 Phase 2 的資料庫）

只新增一個資料表（`group_category_tombstones`），不修改、不刪除任何既有資料。在 SQL Editor 依序執行：

1. `supabase/migrations/002_rpc.sql`
2. `supabase/migrations/003_security.sql`（002 之後一定要執行）
3. `supabase/checks/verify.sql`：升級後檢查，每一列的 `ok` 都應為 `true`

然後把網站合併到 `main`，所有學生裝置重新整理一次。退回 Phase 2 的方式見 [`PHASE3.md`](PHASE3.md) 第二節。

### 從 Phase 1 升級到 Phase 2（已部署 Phase 1 的資料庫）

Phase 2 **沒有新增或修改資料表**，不會刪除任何資料。在 SQL Editor 依序執行：

1. `supabase/migrations/002_rpc.sql`
2. `supabase/migrations/003_security.sql`
3. （選用）`supabase/seed/001_placeholder_content.sql`：更新測試故事文字。**已換成正式素材時不要執行。**

然後把網站合併到 `main`，學生裝置重新整理一次。需要退回 Phase 1 時，依序執行 Phase 1 版本的 002、003，
再執行 `supabase/rollback/phase2_to_phase1.sql`（資料保留）。詳見 [`PHASE2.md`](PHASE2.md) 第二節。

### 一般原則

* 修正 RPC：只重跑 `002_rpc.sql` 與 `003_security.sql`。
* 新增資料表欄位：會提供新的 `004_….sql`，只需執行新檔案。
* **不要**重跑 `001_init.sql`（會因資料表已存在而失敗，不會刪除資料）。

---

## G. 上線順序、相容性與失敗恢復（Phase 5）

Phase 5 **沒有任何資料庫變更**（`supabase/` 與 Phase 4 完全相同），只更新網站（`js/teacher/results.js`、`css/app.css`）。

### 部署順序

1. **先資料庫**：在 SQL Editor 執行 `supabase/upgrade/upgrade.sql`（已是 Phase 4 的資料庫也可再執行一次，結果不變）→ 17 列都應為 `true`。
2. **再網站**：把 Phase 5 合併到 `main`，等 GitHub Pages 部署完成（約 1 分鐘）。
3. 所有教師、投影、學生裝置**重新整理**一次。
4. 用 `docs/TEACHER_CHECKLIST.md` 第二節做一次課前檢查。

**不要在上課中部署**。網站更新不影響資料，但上課中的裝置會在重新整理前繼續用舊版畫面。

### 相容性

| 資料庫 | 網站 | 可以上課？ |
|---|---|---|
| Phase 4（含本版） | Phase 5 | ✅ |
| Phase 4 | Phase 4 | ✅（沒有 Phase 5 的修正：兩台教師裝置公開後可能顯示錯誤的「尚未公開」；平板按鈕較小） |
| Phase 3 或更早 | Phase 5 | ❌ 05、07 無法公開（缺少 Phase 4 的函式）→ 先執行 `upgrade.sql` |

### 失敗恢復

| 狀況 | 處理 |
|---|---|
| `upgrade.sql` 執行中出錯 | 整個交易自動回復，資料庫維持原狀；修正原因後重新執行 |
| `upgrade.sql` 完成但檢查有 `false` | 升級已生效、不會自動回復；依該列名稱處理後重新執行 `upgrade.sql` |
| 網站更新後異常 | 在 GitHub 把 `main` 退回上一個合併（Revert）；**資料庫不需要動**（Phase 4 網站與同一個資料庫相容） |
| 需要退回 Phase 3 | 依 `docs/PHASE4.md` 第八節：Phase 3（`89299af`）的 002 → 003 → `supabase/rollback/phase4_to_phase3.sql`；資料與快照保留。網站也要同時退回 Phase 3 |

### 已在本機驗證的部分與尚未驗證的部分

* 在**隔離的本機 Supabase**（Supabase 官方 Postgres 映像檔、GoTrue、PostgREST、Realtime；`tests/supabase/`）驗證了：
  全新安裝、從 Phase 3＋上課中資料升級、重複執行、回復到 Phase 3、再升級；權限邊界與 Realtime 中斷恢復。
* **尚未在正式（雲端）Supabase 專案驗證**。正式專案上線前請在**另一個測試專案**依上面的順序執行一次，並完成 `docs/PHASE5.md` 第七節的人工驗收表。

---

## H. 小說類型正式教材（第 06、07 環節）

內容：五種類型的顯示名稱（奇幻、偵探、歷史、冒險、武俠）、常見特色、教師補充與直式／橫式圖片。對照見 [`GENRE_MATERIALS.md`](GENRE_MATERIALS.md)。

### 順序（請在沒有課堂時進行）

1. **資料庫結構**：SQL Editor 執行 `supabase/upgrade/upgrade.sql`（新增 `genres.visual_landscape_url`、`content_sets.genre_teacher_guide` 與圖片來源規則；可重複執行；17 列 `ok` 皆為 `true`）。
2. **網站**：合併到 `main`，等 GitHub Pages 部署完成（圖片檔 `assets/genres/*.webp` 隨網站一起部署）。
3. **教材**：SQL Editor 執行 `supabase/content/genre_materials_v1.sql`。最後的結果表應為五列（fantasy → wuxia），`ok` 都是 `true`。
4. 所有裝置重新整理；用教師端 06 私下預覽每一種類型，確認名稱、三項常見特色、圖片與教師補充。

建議依 1 → 2 → 3 的順序。依設計，新網站遇到尚未升級的資料庫時只是沒有橫式圖與教師共同補充（07 改用直式圖），舊網站遇到新資料庫也能顯示；但這兩種混搭**沒有以瀏覽器實測**，請不要在上課前留在混搭狀態。步驟 3 必須在步驟 1 之後（腳本會檢查）。

### 教材腳本的保護（任何一項不符合就整筆中止，資料庫不變）

* 只更新預設素材組中 slug 為 fantasy、detective、historical、adventure、wuxia 的五筆；不新增、不刪除、不改 id 與排序。
* 類型順序必須正好是 fantasy → detective → historical → adventure → wuxia（揭露紀錄以索引記錄，順序不同會錯置）。
* 有使用這份素材、2 小時內仍有動作的進行中場次時中止（可能正在上課）。確認沒有課堂後，可結束那些場次再執行，或把腳本開頭的 `allow_during_class` 改成 `true`。
* 第一次執行時把原本的內容備份到 `app.genre_material_backups`（前端讀不到）。

### 對既有場次的影響

* 素材由同一素材組的所有場次共用：更新後，所有場次的教師端與**之後**的投影都使用新教材。
* 不改寫任何場次的學生資料、快照、揭露紀錄或已保存的投影。已公開在投影上的舊文字會保留到教師重新切換或公開該畫面；
  返回 06／07 時伺服器依原本的選擇與揭露範圍（類型索引、已揭露的特色索引不變）以新教材重建。

### 回復

* 教材：SQL Editor 執行 `supabase/content/genre_materials_v1_rollback.sql`（還原到第一次執行教材腳本前的內容；同樣的保護）。
* 網站：GitHub 上 Revert 該次合併。新欄位保留不影響舊網站。
* **不要**重跑 `supabase/seed/001_placeholder_content.sql`（會把故事與類型改回佔位文字）。

---

## I. 故事卡正式教材（第 03、04 環節）

內容：八部作品的名稱、故事介紹（逐字取自 Word 原稿）、值得留意的故事元素與圖片；學生看板改為小型正面卡，點「閱讀」開啟雙面閱讀卡。
對照、圖片清單與待確認事項見 [`STORY_CARDS.md`](STORY_CARDS.md)。

### 順序（請在沒有課堂時進行）

1. **資料庫結構**：SQL Editor 執行 `supabase/upgrade/upgrade.sql`（新增 `story_cards.elements`，學生讀取時一併回傳；可重複執行；17 列 `ok` 皆為 `true`）。
2. **網站**：合併到 `main`，等 GitHub Pages 部署完成（`assets/stories/*.webp` 隨網站一起部署；`source-assets/` 是原始檔，網站不使用）。
3. **教材**：SQL Editor 執行 `supabase/content/story_cards_v1.sql`。最後的結果表應為八列（story-a → story-h），`ok` 都是 `true`。
4. 所有裝置重新整理；用學生端（或教師的小組看板）打開幾張故事，確認圖片、名稱、全文與元素。

依設計，新網站遇到尚未升級的資料庫時，閱讀卡背面只是沒有元素區；舊網站遇到新資料庫仍顯示原本的單面閱讀視窗。這兩種混搭**沒有以瀏覽器實測**，請不要在上課前留在混搭狀態。步驟 3 必須在步驟 1 之後（腳本會檢查）。

### 教材腳本的保護（任何一項不符合就整筆中止，資料庫不變）

* 只更新預設素材組中 slug 為 `story-a`～`story-h` 的八張故事卡（一對一：story-a → 01 神奇柑仔店 … story-h → 08 倚天屠龍記）；不新增、不刪除、不改 id、slug 與排序。
* 故事卡順序必須正好是 story-a → story-h（畫面上的編號 01～08 依這個順序）。
* 有使用這份素材、2 小時內仍有動作的進行中場次時中止。這只是**預檢**，不是維護鎖：檢查之後才開始的上課操作不會被擋下，所以請在沒有課堂時執行。
  確認沒有課堂後，可結束那些場次再執行，或把腳本開頭的 `allow_during_class` 改成 `true`。
* 第一次執行時把原本的內容備份到 `app.story_card_backups`（前端讀不到）。
* 不重新執行佔位 seed，也不會碰小說類型教材（`genres`）。

### 對既有場次與已保存成果的影響

* 分類、提交與快照都以故事 **id** 記錄，名稱與圖片在顯示時才讀取：更新後，舊場次的個人／小組成果、教師檢視與之後的 05／07 投影都會顯示新的作品名稱與圖片，分類內容不變。
* 不改寫任何場次的學生資料、快照或已保存的投影。已公開在投影上的 05／07 畫面保留舊名稱，直到教師重新公開。
* 原本的「故事 A～H」摘要（summary）會清空：正式教材沒有另寫摘要，看板只顯示編號、圖片與名稱。

### 回復

* 教材：SQL Editor 執行 `supabase/content/story_cards_v1_rollback.sql`（還原到第一次執行教材腳本前的內容；同樣的保護）。
* 網站：GitHub 上 Revert 該次合併。`elements` 欄位保留不影響舊網站。
* **不要**重跑 `supabase/seed/001_placeholder_content.sql`（會把故事與類型改回佔位文字）。

---

## J. 第 01 環節「走進故事世界」正式教材

內容與操作見 [`INTRO_UNIT.md`](INTRO_UNIT.md)。

### 順序（請在沒有課堂時進行）

1. **資料庫結構**：SQL Editor 執行 `supabase/upgrade/upgrade.sql`（新增 `intro_stories.name_before／name_after／image_alt` 與 `content_sets.intro_text`；可重複執行；17 列 `ok` 皆為 `true`）。
2. **網站**：合併到 `main`，等 GitHub Pages 部署完成（`assets/intro/*.webp` 隨網站一起部署）。
3. **教材**：SQL Editor 執行 `supabase/content/intro_materials_v1.sql`。結果表應為兩列（intro-1 名偵探柯南、intro-2 神隱少女），`ok` 都是 `true`。
4. 教師端重新整理；開一個測試場次走一次 01（不必有學生），確認線索、公布與上一步。

新網站遇到尚未執行步驟 3 的資料庫時，01 仍可操作（佔位文字、沒有名字變化與命名提問）；這個混搭**沒有以瀏覽器實測正式資料庫**，請不要在上課前留在混搭狀態。

### 教材腳本的保護（任何一項不符合就整筆中止，資料庫不變）

* 只更新預設素材組的 intro-1、intro-2 與各自 sort_order 1～3 的線索，以及素材組的 `intro_text`；不新增、不刪除、不改 id 與排序。
* 探索故事順序必須是 intro-1 → intro-2，每則正好三條線索。
* 有 2 小時內仍有動作的進行中場次時中止。這只是**預檢**，不是維護鎖，請在沒有課堂時執行（可改 `allow_during_class`）。
* 第一次執行時備份到 `app.intro_material_backups`（前端讀不到）。不碰故事卡、小說類型、場次與學生資料；不重跑佔位 seed。

### 對既有場次的影響

* 01 沒有學生資料。已公開在投影上的 01 畫面保留舊文字，直到教師再次操作 01；之後的操作都使用新教材。

### 回復

* 教材：SQL Editor 執行 `supabase/content/intro_materials_v1_rollback.sql`。
* 網站：GitHub 上 Revert 該次合併。新欄位保留不影響舊網站。
