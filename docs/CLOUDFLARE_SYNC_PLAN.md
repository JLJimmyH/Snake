# Cloudflare 即時同步計畫

狀態：**已確認方向，尚未建置**（2026-10-07）。實作前先完成「第 0 階段」的帳號檢查。

## 已確認的決定

| 項目 | 決定 |
|---|---|
| 同步方式 | 真的同時寫：Yjs 即時同步，可分享給其他人 |
| 後端 | Cloudflare：Workers + Durable Objects + D1 + R2，不再使用 Supabase 與 Node 伺服器 |
| 網站 | 搬到 Cloudflare（Worker 靜態檔案），與 API 同網域 |
| 圖片 | 存 R2，**每人上限 1 GB** |
| Drive | 個人（本機／Drive）筆記本照舊；同步筆記本可「另存備份到 Drive」與匯出 zip |
| 訪客連結 | 不需帳號；**只開放單頁**；**等候室預設關閉**；訪客可上傳圖片，**每個連結上限 50 MB**，計入建立者的 1 GB |

尚未決定：網域（`*.workers.dev` 或自有網域）。

## 第 0 階段檢查結果（2026-10-07，唯讀）

| 項目 | 結果 | 影響 |
|---|---|---|
| Workers 方案 | **Free**（沒有 Workers Paid 訂閱） | 開發與試用足夠；正式開放前升級 Paid |
| 網域 | `g6n4f.com`（active，Free 方案） | 可用子網域，例如 `note.g6n4f.com` |
| R2 | **尚未啟用**（API 回應要求先在 Dashboard 啟用） | 需在 Dashboard 啟用 R2，通常要綁付款方式 |
| D1 | 已有 4 個資料庫（Free 上限 10） | 還能再建 |
| Workers | 已有 5 個 Worker（Free 上限 100） | `14f-api` 是使用者的 Home Assistant 用途，與本專案無關，不要動 |

## 架構

```
瀏覽器 ── HTTPS ──▶ Worker（單一）
  │                  ├ 靜態檔案（app）                     免費、不限次數
  │                  ├ /api/session         Google 登入 → session cookie
  │                  ├ /api/notebooks…      清單、成員、訪客連結 ──▶ D1
  │                  ├ /api/notebooks/:id/blobs/:hash  圖片、配額 ──▶ R2 + D1
  └── WebSocket ───▶ └ /api/notebooks/:id/ws ──▶ Durable Object「NotebookRoom」
                                                  ├ 每頁一個 Y.Doc + 頁面樹一個 Y.Doc
                                                  ├ 自己的 SQLite：更新紀錄、快照、分享前保護快照
                                                  └ 轉發更新／筆跡預覽／在線名單，驗證內容與權限
```

### 筆記本類型

| 類型 | 存放 | 即時同步 | 分享 |
|---|---|---|---|
| 僅本機 | IndexedDB | ✗ | ✗ |
| Drive | IndexedDB＋使用者 Drive 的 zip | ✗（手動 ⟳ 同步） | ✗ |
| **同步** | Cloudflare；IndexedDB 為離線快取 | ✓ | 成員＋訪客連結 |

轉換：本機／Drive 筆記本「開啟同步」→ 上傳成同步筆記本（圖片需在配額內）；Drive 檔案保留為最後備份。同步筆記本可「另存備份到 Drive」「匯出 zip」「下載為本機筆記本」。

## 資料模型

### Yjs（每本一個 Durable Object）

- `tree`：`Y.Map pages`，pageId → `Y.Map { title, parentId, order }`。頁面展開狀態、畫布視角只存各自裝置。
- `page:<pageId>`：沿用 [collaboration/model.js](../collaboration/model.js) 的 `items` 結構（itemId → `Y.Map` 欄位＋order）。

**每頁獨立一個 Y.Doc**：訪客只拿得到被分享那頁；打開大筆記本時只載入正在看的頁。

### Durable Object SQLite

| 表 | 欄位 | 說明 |
|---|---|---|
| `updates` | doc_id, seq, data | 每筆更新；壓縮後刪除 |
| `snapshots` | doc_id, part, data | `Y.encodeStateAsUpdate` 快照，**切成 ≤ 1 MB 的列**（單列上限 2 MB） |
| `guards` | id, doc_id, link_id, reason, created_at, part, data | 建立／停止訪客連結時的保護快照，供「還原到分享前」 |

壓縮用 Alarm 觸發（例如某個 doc 累積 500 筆更新），不用計時器，才能休眠。

### D1

```sql
users       (id TEXT PRIMARY KEY,         -- Google sub
             email TEXT UNIQUE, name TEXT, image_bytes INTEGER DEFAULT 0, created_at)
notebooks   (id TEXT PRIMARY KEY, owner_id, name, created_at, updated_at, deleted_at)
members     (notebook_id, email, role CHECK (role IN ('editor','viewer')), added_at,
             PRIMARY KEY (notebook_id, email))
blobs       (notebook_id, hash, size, type, charged_user_id, link_id, created_at, unreferenced_at,
             PRIMARY KEY (notebook_id, hash))
share_links (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, notebook_id, page_id,
             role CHECK (role IN ('editor','viewer')), waiting_room INTEGER DEFAULT 0,
             max_guests INTEGER DEFAULT 10, image_bytes INTEGER DEFAULT 0,
             image_limit INTEGER DEFAULT 52428800, created_by, created_at, expires_at, revoked_at)
```

## 登入與權限

### 成員

1. 前端用 Google「Sign in with Google」取得 ID token（沿用 `js/drive-config.js` 的 Client ID，只需 openid／email）。
2. `POST /api/session`：Worker 以 Google JWKS 驗證簽章、`aud`、`iss`、`exp`、`email_verified`，upsert `users`。
3. 回傳 HMAC 簽章的 session cookie（HttpOnly、Secure、SameSite=Lax，7 天滑動續期）。所有寫入與 WebSocket 都檢查 Origin。

角色：擁有者（分享、刪除）、可編輯、唯讀。唯讀由伺服器擋。變更或移除成員時，Worker 通知 NotebookRoom 斷開該成員的連線。

### 訪客連結

1. 擁有者在某一頁選「分享臨時連結」，設定權限、期限（1 小時／24 小時／7 天，最長 7 天）、等候室（預設關）。
2. 產生 `https://<網域>/s/<128-bit 隨機碼>`；D1 只存 SHA-256。
3. 訪客開啟 → 輸入暱稱 → `POST /api/links/<token>/join` → 檢查未過期、未撤銷、人數未滿 → 發訪客 cookie（期限為連結到期與 12 小時取較早者）。
4. 等候室開啟時，NotebookRoom 先把訪客放在等候清單，擁有者按「允許」才送資料。
5. 訪客 WebSocket 只能訂閱 `page:<該頁>`，看不到頁面樹和其他頁；不能分享或改權限；資料只放記憶體，不寫離線快取。
6. 撤銷或到期：NotebookRoom 立即關閉該連結的所有連線（每則訊息也檢查期限）。
7. **建立與停止分享時各存一份保護快照**，擁有者可「還原到分享前」。保留最近 10 份或 30 天。
8. 在線名單顯示「小明（訪客）」。

## 同步協定

一條 WebSocket 連一本筆記本，以 `doc` 欄位區分頁面（沿用現有 auth／sync／update／ack／preview／presence）：

| 方向 | 訊息 |
|---|---|
| 客→伺 | `sub {doc, vector}`、`unsub {doc}`、`update {doc, data, version}`、`preview {doc, item}` |
| 伺→客 | `sync {doc, data, vector, role}`、`update {doc, data}`、`ack {doc, version, vector}`、`preview {doc, peer, item}`、`presence {doc, people}`、`waiting {guests}`、`error` |

- 更新先寫 SQLite 再轉發、再回 ack；伺服器驗證物件格式（沿用 `validateDocument` 規則）與每頁大小上限。
- 筆跡預覽降為每秒約 10 次，只轉發不儲存。
- 使用 WebSocket Hibernation API：空檔休眠不計運算時間。
- 前端沿用 [js/collaboration.js](../js/collaboration.js) 的離線快取、state vector 補送、多分頁合併邏輯。

## 圖片

1. 前端壓縮（沿用 `prepareImage`）→ SHA-256 → `PUT /api/notebooks/:id/blobs/:hash`。
2. Worker 檢查角色；同一本已有此雜湊就直接成功、不重複計費。
3. 配額：`UPDATE users SET image_bytes = image_bytes + ? WHERE id = ? AND image_bytes + ? <= 1073741824 RETURNING`；訪客另外檢查 `share_links.image_bytes + size <= image_limit`，並同樣計入建立者。
4. 寫入 R2 `nb/<notebookId>/<hash>`，再寫 D1 `blobs`。
5. 讀取：檢查成員身分；訪客只能讀該頁引用的圖片（向 NotebookRoom 確認）。回應 `Cache-Control: private, max-age=31536000, immutable`，前端也存 IndexedDB。
6. 回收：NotebookRoom 的 Alarm 定期比對所有頁面與保護快照引用的雜湊；未被引用超過 30 天才刪 R2 並退回配額。刪除筆記本 → 刪除全部圖片並退回配額。

## 上限

| 項目 | 上限 |
|---|---|
| 每人圖片 | 1 GB |
| 單張圖片（壓縮後） | 10 MB |
| 每頁 Yjs 資料 | 10 MB |
| 每本 Yjs 資料 | 50 MB |
| 單筆更新 | 2 MB |
| 每本成員 | 50 人 |
| 每個訪客連結 | 10 位同時在線、圖片 50 MB、最長 7 天 |
| 訊息頻率 | 每連線每秒 80 則（沿用現有） |

## 費用（官方價格，2026-10 查詢，USD）

| | Workers Free（$0） | Workers Paid（$5／月） |
|---|---|---|
| Worker 請求 | 10 萬／天；CPU 10 ms／次 | 含 1000 萬／月，+$0.30／百萬 |
| 靜態檔案 | 免費、不限 | 同左 |
| DO 請求（WebSocket 收到 20 則算 1 次） | 10 萬／天 | 含 100 萬／月，+$0.15／百萬 |
| DO 運算 | 13,000 GB-s／天 | 含 40 萬 GB-s／月，+$12.50／百萬 GB-s |
| DO SQLite 寫入／儲存 | 10 萬列／天；帳號共 5 GB | 含 5000 萬列；含 5 GB，+$0.20／GB-月 |
| D1 | 10 萬列寫入／天；單庫 500 MB | 含 5000 萬列；單庫 10 GB |
| R2 | 10 GB、Class A 100 萬、Class B 1000 萬／月免費 | 之後 $0.015／GB-月、$4.50／百萬 A、$0.36／百萬 B |
| 流量 | 免費 | 免費 |

估算（1 人畫 1 小時 ≈ 1,800 次 DO 請求、1,200 列寫入、最壞 450 GB-s）：

| 規模 | 方案 | 每月 |
|---|---|---|
| 你＋5～10 人，每天約 20 小時 | Free | **$0** |
| 100 人，每月 1,000 小時，圖片 30 GB | Paid | **約 $5.5** |
| 1,000 人全部用滿 1 GB，每月 10,000 小時 | Paid | **約 $25～50**（R2 約 $15；DO 運算最壞約 $29，休眠後應遠低於此） |

訪客連結的流量與成員相同，圖片受連結上限與建立者配額約束，不改變上表量級。

建議：開發與小範圍試用用 Free；開放給其他人前升級 Paid（Free 的每日額度用完會直接失敗）。R2 啟用通常需要先綁付款方式。初期採邀請制（允許名單）防止陌生人註冊塞圖片。

## 實作階段

| 階段 | 內容 | 驗收 |
|---|---|---|
| **0. 前置** | 使用者執行 `wrangler login`；唯讀檢查方案、網域、R2；決定網域；Google Console 加新來源；R2 綁付款方式 | 檢查結果記錄於本文件 |
| **1. 骨架** | Worker＋靜態檔案、wrangler 設定、D1 schema、Sign in with Google、session cookie、允許名單；部署到測試網址 | 登入／登出、未登入被擋、Origin 檢查 |
| **2. NotebookRoom** | 每頁 Y.Doc、協定、驗證、持久化與分塊快照、Alarm 壓縮、Hibernation | 兩個客戶端同時寫、斷線補送、重啟後資料仍在、超過上限被拒 |
| **3. 前端同步筆記本** | main.js 抽出「筆記本來源」介面（本機／同步兩種實作）；移植同步客戶端；離線快取；在線名單與筆跡預覽 | 既有 smoke tests 全過＋兩個瀏覽器即時同步 |
| **4. 圖片** | R2 上傳下載、配額、去重、回收 | 超過 1 GB 被拒、同圖不重複計費、刪除後退回配額 |
| **5. 成員分享** | 以 email 分享、改權限、移除成員、「分享給我的」清單 | 唯讀被擋、移除後立即斷線 |
| **6. 訪客連結** | 建立／撤銷／期限、暱稱加入、只看單頁、等候室選項、50 MB 上限、保護快照與「還原到分享前」 | 訪客看不到其他頁、撤銷立即斷線、到期失效、還原成功 |
| **7. 轉換與 Drive** | 開啟同步、另存備份到 Drive、下載為本機筆記本 | 轉換前後內容與圖片一致 |
| **8. 搬家與清理** | 移除 Supabase、Node 伺服器與單頁協作；改寫隱私權政策與文件；GitHub Pages 加搬家提示；升級 Paid 後正式開放 | 舊網址提示正確、文件更新 |

測試：Worker／DO 單元與整合測試用 `@cloudflare/vitest-pool-workers`；瀏覽器情境沿用 Playwright smoke tests，對 `wrangler dev` 執行。

## 風險與注意事項

- **搬家後本機筆記本不會跟過去**（IndexedDB 依網域分開）：舊網址保留並提示「先存到 Drive 或匯出 zip，再到新網址開啟」。Drive 上的筆記本因為同一 Client ID，新網址仍能開啟。
- **資料保管責任轉移**：使用者內容改存在你的 Cloudflare，隱私權政策要說明保存、刪除與分享；需提供刪除帳號時清除筆記本與圖片的流程。
- **訪客連結外流**：預設有期限、可撤銷、人數上限；敏感討論可開等候室。
- **沒有版本歷史**：只有訪客連結的保護快照可還原；成員誤刪仍無法回復（日後可擴充為定期快照）。
- **Free 方案每次請求 10 ms CPU**：登入驗證與 D1 查詢應足夠，若不足就提早升級 Paid。
- **DO 單一實例記憶體 128 MB**：靠每頁／每本 Yjs 上限與分頁載入控制。
- **同一文字框同時打字**：沿用現有行為，以最後寫入為準，不是逐字合併。
