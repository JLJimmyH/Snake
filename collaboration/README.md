# 協作第一版

原本 `python server.py` 仍是純本機版。協作模式改由 **Node 同時提供網頁、HTTP API 與 WebSocket**，用 Yjs 合併不同物件／欄位；瀏覽器仍會先本機顯示並保存在 IndexedDB。

## 不需要帳號的本機體驗

需要 Node 22 以上（本次驗證 Node 24.19.0）。

```bash
cd /workspace/note-mvp
npm ci
npm run build
COLLAB_DEMO=1 PORT=8001 PUBLIC_ORIGIN=http://127.0.0.1:8001 npm start
```

在自己的開發機器上開啟 port 8001 的網頁；雲端 onboarding 不提供 localhost 預覽。

1. 開兩個獨立瀏覽器 profile 或無痕視窗（分開的 IndexedDB）。
2. 第一個視窗新增本機頁面，點「協作」→「示範 Alice」→「將此頁複製到協作空間」。
3. 再點「協作」，在該頁按「分享」，輸入 `bob@example.test`，選「可編輯」。
4. 第二個視窗選「示範 Bob」，開啟該協作頁面。兩邊可同時畫，看到書寫中的預覽；放開筆後完成持久化同步。
5. 分享給 `eve@example.test` 並選「唯讀」，可驗證第三個視窗無法修改。

此模式 **沒有真正身份驗證**，只能綁定／接受 loopback 連線，示範帳號也只允許 `@example.test`。不要設定代理公開此模式。資料在忽略的 `.local-data/`，重新啟動 Node 後仍保留；不要把這些測試資料提交。

## 正式 Google 登入：Supabase 設定

Supabase 是提供登入、Postgres 資料庫與檔案儲存的服務；Yjs WebSocket 仍由此專案的 Node 服務提供。你需要建立 Supabase 專案與 Google OAuth 用戶端，不需要 service-role key。

1. 建立 Supabase 專案，在 SQL Editor 執行 `supabase/schema.sql`。這個腳本針對新專案執行一次，使用 transaction，建立頁面／分享成員／Yjs 更新表、RLS 與 private `note-images` bucket。
2. 在 Supabase Authentication 啟用 **Google** provider。依畫面提示，在 Google Cloud 建立 OAuth 網頁用戶端，將 Supabase 顯示的 callback URL 加到 Google 的 authorized redirect URIs；client secret 只輸入 Supabase 設定，不能放到前端、Git 或聊天。
3. 在 Supabase Authentication URL Configuration 設定正式 Site URL 及允許的 redirect URL。本站的 OAuth 返回網址為正式首頁 origin + pathname。
4. 從 Supabase 專案設定取得 Project URL 和 **publishable key**（舊專案可使用 public anon key）。兩者可在前端使用，不是管理員憑證。
5. 依 `.env.example` 建立忽略的 `.env`，或在部署平台安全設定環境變數：

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
PUBLIC_ORIGIN=https://YOUR_NOTE_DOMAIN
HOST=0.0.0.0
PORT=8000
COLLAB_DEMO=0
```

6. 部署 **單一 Node instance**：build command `npm ci && npm run build`，start command `npm start`。必須支援 WebSocket，提供 HTTPS，反向代理將同源 `/collab` 升級為 WebSocket，`PUBLIC_ORIGIN` 要精確等於對外 origin（不加尾端 `/`）。不要直接以 GitHub Pages 部署協作後端；原 GitHub Pages 網址仍只能用單機版。
7. 使用兩個真實 Google 帳號重跑流程：owner 複製頁面、分享對方完整 email、另一個帳號登入並開啟頁面，測試同時畫、圖片、重連、唯讀與非成員拒絕。

Node 驗證 Supabase 登入權杖；所有 Supabase 資料庫與 Storage 請求使用該使用者的 JWT，由 RLS 再次檢查權限。只有 owner 可以新增／修改分享。editor 不能分享，viewer 不能上傳圖片或提交更新。前端設定端點只接受 publishable／anon 公開金鑰；服務啟動時會拒絕 service-role／secret key。此版不寄 email；被邀請者登入指定帳號後會在清單看到頁面。owner 可再次分享同一 email 將其改為唯讀，目前沒有移除成員或刪除雲端頁面的 UI。

**Supabase schema、Storage policies 與 Google OAuth 尚未在真實專案驗證**；本機測試不能代替上述正式驗收。

## 儲存、同步與離線

- 複製本機頁面建立獨立協作副本，不覆蓋本機原稿，也不自動分享其子頁面。
- 每個物件有獨立 ID，欄位放在 Y.Map。不同人的筆跡和不同物件可同時編輯；同一欄位同時修改由 Yjs 確定性合併為其中一個值。**同一文字框目前不是逐字協作，請輪流輸入**；可後續改成 Y.Text 與編輯器 binding。
- 游標／畫布縮放只存在自己的裝置。正在畫的筆跡是暫時廣播，完成後才成為正式物件；不保證零延遲。
- 本機直接顯示，不等後端。更新合併後上傳，後端寫入成功才回 ack。圖片先上傳 private Storage，再送出引用。
- 載入中的畫布可離線編輯；IndexedDB 保存按帳號＋頁面隔離的 Yjs 快取，重連時依 state vector 補送，不用整頁覆蓋。多分頁離線快取使用原子合併。
- 未同步內容會阻止登出；離開頁面時仍保留在同一瀏覽器，使用同帳號重新開啟即可補送。清除瀏覽器資料可能移除尚未同步的內容。
- **尚未做 PWA／離線 app shell**，斷網後不能保證重新打開網站。離線功能針對已載入的畫布。
- 本人 undo/redo 使用 Yjs UndoManager，不會撤銷別人的操作。權限改為唯讀後，未同步的本機內容保留但不會被上傳。

## 驗證

```bash
npm run build
npm test
```

6 個 Node 測試涵蓋並行／離線物件合併、本人 undo、檔案持久化、owner/editor/viewer/非成員 ACL、HTTP/WebSocket 與私密檔案保護、本機模式禁止公開綁定、正式模式拒絕管理員／secret key。

協作示範服務運行於 port 8001 時，可用已安裝 Python Playwright 與 `/usr/bin/chromium` 執行：

```bash
python tests/browser_smoke.py
```

可用 `NOTE_TEST_ORIGIN` 指定同源測試網址。測試使用獨立 browser contexts、建立有唯一名稱的示範頁面，驗證即時預覽、同時畫、undo/redo、離線重連、圖片跨帳號載入、文字、reload、viewer 唯讀與返回本機。測試資料會留在示範儲存。

## 上線前限制

- 單一 Node instance；多 instance 需要共享房間傳輸／訂閱，不能直接水平擴充。
- 目前是 append-only Yjs 更新日誌，尚無 compact／配額／垃圾圖片清理。大型筆記與大量使用者須先補上這些機制及壓力測試。
- 已限制更新大小、單頁物件量、WebSocket 訊息速率與圖片 MIME；仍需按產品規模設計總配額、流量限制及監控。
- 尚無分享連結、移除成員 UI、雲端頁面 rename/delete、跨頁分類同步、多人游標、逐字文字協作、密碼登入或 Google Drive 備份。
- Google OAuth 與真實 Supabase RLS 必須在建立專案後驗收，目前不宣稱正式環境已上線。
