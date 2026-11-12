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
| 3 | `supabase/migrations/003_security.sql` | RLS 與權限 | 是（重跑 002 後建議一併重跑） |
| 4 | `supabase/seed/001_placeholder_content.sql` | 佔位素材（故事 A～H、兩個探索故事、五種小說類型） | 是（以 slug 更新，不會重複新增） |

每個檔案執行後應顯示 `Success. No rows returned`。

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
3. GitHub repo → **Settings → Pages → Build and deployment**：Source 選 *Deploy from a branch*，Branch 選 `main`、資料夾 `/ (root)`。
4. 約一分鐘後網站位於 `https://<帳號>.github.io/storyship/`。

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
6. 下課時按「結束場次」：學生不能再修改，所有成果保留。

### 常見狀況

| 狀況 | 處理 |
|---|---|
| 學生選錯組 | 主控台「連線管理」→ 該學生的「移到第 N 組」 |
| 學生換了平板或清除瀏覽資料 | 會被視為新學生重新選組；舊的紀錄可在連線管理「移出」 |
| 遲到學生 | 02 環節「投影重新顯示 QR Code」；或在 00 確認「開放新學生加入」為開啟 |
| 某組已提交但想修改 | 04 環節表格中的「單組解鎖」 |
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
| `story_cards` | `image_url`（故事卡圖片） |
| `intro_stories` | `background_url`（情境背景）、`image_url`（故事代表圖片） |
| `intro_clues` | `image_url`（人物／物件插畫） |
| `genres` | `visual_url`（小說類型主視覺）；`elements[].icon`（要素圖示） |

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
