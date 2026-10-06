# 待辦

## 🔴 資料安全（建議優先）
- [ ] `navigator.storage.persist()`：避免瀏覽器空間不足時清掉資料
- [ ] PWA（manifest + service worker）：可加到主畫面、離線開啟，避開 iOS Safari 7 天清除
- [ ] 匯出／匯入備份（全部筆記含圖片打包成一個檔）

## 🟠 編輯
- [ ] 筆壓控制粗細（觸控筆）
- [ ] 文字格式：粗體、標題、條列、字級、顏色
- [ ] 選取後複製／貼上、群組縮放
- [ ] 圖片旋轉、裁切
- [ ] 切換頁面後保留復原紀錄

## 🟡 頁面分類（Notion）
- [ ] 側欄拖曳排序／拖曳換層級
- [ ] 頁面 emoji 圖示
- [ ] 全文搜尋
- [ ] 複製頁面、頁面範本

## 🟢 介面
- [ ] 手機工具列太長（顏色/粗細要往右滑）→ 浮動工具列或收合
- [ ] 紙張背景：點格／橫線／空白
- [ ] 深色模式
- [ ] 文字工具點空白一定新增文字框，想取消編輯時有點干擾

## ⚪ 長期
- [ ] 雲端同步＋帳號（需要後端）
- [ ] 清理沒被引用的圖片 blob
- [ ] 大量筆跡（數千條）效能測試

## ⚠️ 待實機驗證
- [ ] iPad + Apple Pencil（防誤觸、局部擦除手感）
- [ ] Android Chrome


## 🚧 協作第一版實作進度（2026-10-06，供 agent 接手）

### 使用者授權與範圍
- 使用者授權繼續實作，要求將進度與接手事項記錄於此。
- 使用者尚未建立／使用 Supabase；先完成本機可驗證版本，不要求在聊天提供金鑰、不自動部署。
- 正式架構：Supabase Auth + Postgres/Storage + 同源 Node WebSocket + Yjs；保留原 Python 單機模式。
- 第一版不同物件／欄位可以共同修改；同一文字框逐字 CRDT 編輯留待下一階段。

### 已完成並驗證
- [x] package.json/lockfile，Yjs、ws、Supabase SDK 與 esbuild；npm install 與 build 成功。
- [x] collaboration/model.js：獨立物件／欄位 Y.Map、baseline diff、避免刪除未見遠端物件。
- [x] collaboration/server.mjs：同源 HTTP/WebSocket、Supabase token 驗證、ACL、寫入後 ack、暫時筆跡、訊息與資料大小限制。
- [x] collaboration/store.mjs：DemoStore 序列化持久化；正式模式使用呼叫者 JWT 與 RLS，不使用 service-role。
- [x] 示範模式必須 COLLAB_DEMO=1，僅綁定／接受 loopback host/source；不能公開部署或當作真正身份驗證。
- [x] js/collaboration.js + UI：Google OAuth 接線、本機示範身份、複製頁面、指定 email 分享、owner/editor/viewer、協作清單。
- [x] Board：遠端增量渲染、書寫中預覽、唯讀、本人 Yjs undo/redo，保留自己的 view。
- [x] IndexedDB 按帳號＋頁面隔離、待同步內容、原子合併多分頁快取；先圖片上傳再提交引用。
- [x] supabase/schema.sql：Postgres tables/RLS 與 private bucket/Storage policies 已撰寫（尚未真實 Supabase 驗收）。
- [x] 原本 Python 單機 smoke 通過，回到本機時原筆記保留。
- [x] Node 模型／ACL／HTTP+WS／持久化／模式限制／拒絕 private key／Host 防護皆通過，共 6 tests。
- [x] tests/browser_smoke.py 雙／三帳號瀏覽器驗證：即時預覽、同時畫、本人 undo/redo、離線重連、圖片跨帳號下載、文字、reload、viewer 唯讀。
- [x] 同一帳號兩分頁離線各修改，全部關閉再重開後兩份修改皆保留並同步。
- [x] README 與 collaboration/README.md：本機體驗、建立 Supabase、Google OAuth、單 instance 部署、測試與限制。

### 仍需外部前提／後續工作
- [ ] 使用者建立 Supabase 專案，執行 schema.sql，設定 Google OAuth provider、redirect URLs 與 public publishable key。
- [ ] 真實專案驗證 Supabase RLS／Storage／Google 登入；本機測試不能代替正式驗收。
- [ ] 部署單一 Node instance（HTTPS + WebSocket 同源），設定正確 PUBLIC_ORIGIN，COLLAB_DEMO=0。
- [ ] 同一文字框改成 Y.Text 與編輯器 binding，目前同一欄位並行修改會確定性選其中一個值，請輪流輸入。
- [ ] 分享移除／雲端 rename/delete／分享連結／跨頁分類同步 UI。
- [ ] PWA/離線 app shell；目前只支援已載入畫布的離線編輯。
- [ ] 更新日誌 compaction、配額、垃圾圖片清理、壓力測試；多 instance 需要共享房間同步，不能直接水平擴充。

### 接手指令與狀態
```bash
cd /workspace/note-mvp
npm ci
npm run build
npm test
COLLAB_DEMO=1 PORT=8001 PUBLIC_ORIGIN=http://127.0.0.1:8001 npm start
# 另一個 terminal，已有 Python Playwright 和 /usr/bin/chromium 時：
python tests/browser_smoke.py
```
- 工作區有未提交功能變更，請先 git status，不要覆蓋或 reset。沒有建立 PR，也未部署外部服務。
- npm cache 如遇 HOME 權限問題可用 --cache /tmp/note-mvp-npm-cache。
- 協作服務測試 port 8001（session 71056），原 Python server port 8000（session 20077）。只有停止自己啟動的服務才能換版，不要誤殺其他程序。
- 最終 Node 6 tests 皆通過；browser_smoke 9 項通過；git diff --check 通過。Supabase／Google 真實服務尚未建立，因此正式驗收仍待外部設定。
- 正式 URL/publishable key 透過忽略的 .env 或部署環境變數設定；Google secret 只設於 Supabase，不可放前端/Git/聊天。
- 詳細部署說明 collaboration/README.md；測試資料 .local-data、bundle collab-assets、node_modules、.env 都已忽略。


### GitHub Pages 發布（使用者已授權直接推送）
- Pages 為單機靜態版，可測頁面、筆跡、文字、圖片、復原／重做及 IndexedDB 持久化。
- 新增「協作說明」：未啟用後端時明確顯示資料僅存本機，不顯示假的登入／分享按鈕。
- Pages 無法運行 Node WebSocket、Google 登入與 Supabase 協作；這些須另部署正式服務。
- 單機 smoke、Pages /note-mvp/ 子路徑與協作說明 UI、6 個 Node tests 驗證通過。使用者授權直接推到 origin/main；不包含 .env、node_modules、.local-data 或生成 bundle。
