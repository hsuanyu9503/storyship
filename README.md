# 故事找朋友｜國小六年級國語互動教學網站

「語文天地三」第三節（40 分鐘）的三端互動教學網站：

* **A｜投影端** `projector.html`：全班觀看，只顯示教師核准公開的內容。
* **B｜教師主控端** `teacher.html`：控制教學環節、學生權限、內容揭露與成果展示。
* **C｜學生端** `join.html`：每人一台平板，個人分類與小組即時協作。

技術：GitHub Pages（靜態網站，無建置步驟）＋ Supabase（PostgreSQL、RPC、Realtime）。

## 目前進度：Phase 2 個人分類

| 項目 | 狀態 |
|---|---|
| 三端路由與角色權限（教師登入＋白名單、投影金鑰、學生匿名裝置憑證） | ✅ |
| 00～07＋結束的教學狀態機（伺服器保存、教師控制、不自動切換） | ✅ |
| 教師主控與投影同步（預覽與公開分離） | ✅ |
| 六組加入、人數上限、暫停加入、換組、移出、在線狀態 | ✅ |
| 故事卡、探索故事、小說類型的資料驅動結構與圖片佔位 | ✅ |
| 個人分類、小組共作的資料庫與 RPC（版本檢查、操作鎖、提交、解鎖、快照） | ✅ 後端完成 |
| 03 學生個人分類工作區（閱讀、自由分類、拖曳與點選移動、命名、自動儲存、提交）（Phase 2） | ✅ |
| 03 教師進度、查看個人成果、暫停／恢復、結束並鎖定快照（Phase 2） | ✅ |
| 小組共作畫面（Phase 3） | ⏳ |
| 05 成果比較、07 分類與小說要素對照（Phase 4） | ⏳ |

驗證範圍與尚未在正式 Supabase 上驗證的項目，請見 [`docs/TESTING.md`](docs/TESTING.md)。

## 文件

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：架構、資料流、狀態機、資料模型、同步與衝突策略、規格檢查、已知限制
* [`docs/DEPLOY.md`](docs/DEPLOY.md)：Supabase 設定、GitHub Pages 部署、上課流程、更換素材、資料保存
* [`docs/TESTING.md`](docs/TESTING.md)：自動化測試、驗證結果、部署後手動驗收步驟
* [`docs/PHASE2.md`](docs/PHASE2.md)：Phase 2 交付說明（升級 SQL、測試結果、實機驗收清單、Phase 3 沿用說明）

## 目錄

```
index.html  teacher.html  projector.html  join.html
config.js               Supabase 連線設定（Project URL＋anon key；config.example.js 為範例）
css/app.css
js/lib/                 三端共用：API、同步、環節定義、投影產生與渲染、分類工作區（board-*）
js/teacher/ js/projector/ js/student/
js/vendor/              固定版本的 supabase-js、qrcode（不依賴 CDN）
assets/                 正式素材圖片
supabase/migrations/    資料庫（001 資料表、002 RPC、003 權限）
supabase/seed/          佔位教學素材
supabase/setup/         新增教師帳號
supabase/rollback/      退回前一版時使用
tests/unit/ tests/db/ tests/e2e/
```

## 快速測試

```bash
npm run test:unit
```

```bash
npm run test:db
```

```bash
npm run test:concurrency
```

```bash
npm run test:race
```

```bash
npm run test:upgrade
```
