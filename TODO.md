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

## 🚧 畫布編輯功能更新（使用者授權，進行中）
- [x] 筆／螢光筆自訂顏色、連續大小滑桿，調整時預覽實際螢幕直徑。
- [x] 選中的單條／多條筆跡：8 方向獨立縮放、旋轉；變形寫回點座標，支援儲存、擦除與 undo／協作同步。
- [x] 畫布 Ctrl/Cmd+V 貼上純文字或圖片；保留文字輸入框正常貼上，唯讀不能新增。
- [x] tests/editor_smoke.py：顏色／小數大小／預覽、分別沿 X/Y 縮放、旋轉、undo/redo/reload、真實系統剪貼簿 Ctrl+V 文字/PNG、文字框內貼上與原物件保留通過。單機 smoke 與 9 項協作回歸也通過。
- 延續先前使用者已授權的 main/Pages 發布流程，完成驗證後推送；正式協作仍未部署。

- 本輪測試服務：Python port 8010（session 57003），Node demo port 8011（session 28936）。
- 可重跑 NOTE_TEST_ORIGIN=http://127.0.0.1:8010 python tests/editor_smoke.py；協作測試用同一變數設為 port 8011。
- 新增圖片貼上測試使用瀏覽器 canvas 產生有效 PNG 寫入系統 clipboard，再真實 Ctrl+V；不依賴固定 base64 範例圖。


## 🚧 筆刷工具列整合（2026-10-06）
- [x] 筆／螢光筆工具列改為單一顏色按鈕，展開色盤內含常用色與自訂色，選色狀態共用。
- [x] 移除筆／螢光筆重複的粗細預設按鈕，大小只保留滑桿與筆點預覽；橡皮擦保留原有粗細選擇。
- [x] 桌機 1280px／手機 390px 色盤、常用與自訂色同步、唯一大小滑桿及筆點預覽檢查通過；原 tests/editor_smoke.py 通過。色盤與大小預覽互斥，避免重疊。完成後推送 main。


## 🚧 畫布拖曳與點選分離（2026-10-06）
- [x] 選取工具直接拖曳任何物件（含已選取物件）都只移動畫布，移除直接拖移物件分支。
- [x] 點一下物件於放開時才選取並顯示把手；只有拖把手才能改變物件尺寸／旋轉。文字編輯改由文字工具點選。
- [x] tests/pan_selection_smoke.py 驗證筆跡／文字／圖片未選與已選拖曳都只改 view、點選顯框、把手縮放／undo、真實觸控拖曳、文字工具編輯皆通過。tests/editor_smoke.py 回歸通過，build／diff check 通過，延續既有授權推送 main。

- 此輪本機測試 port 8030（session 40184）；網路 sandbox 需要核准後才能啟動伺服器／執行瀏覽器測試。

## 🚧 Google Drive 版本歷史（已授權實作，2026-10-06）
- 目標：Pages 直接使用，本機先保存；手動建立不可變版本、查看差異、還原為新版本、Drive 個人長期備份。不做自動合併或即時多人編輯。
- [x] 本機版本引擎：一致快照、SHA-256 內容去重、增量與定期快照、圖片完整性、原子還原。
- [x] 帳號隔離：本機／各 Drive 帳號各有版本分支，連線不自動上傳本機內容，必須明確建立並備份。
- [x] Drive：GIS token OAuth、drive.file、不可覆寫版本、上傳物件後發布版本、重試不重複、雲端分歧提示。
- [x] UI：建立版本、歷史、文字與物件差異預覽、還原確認、狀態與錯誤。
- [x] Google Cloud OAuth 新手逐步文件（origin、Client ID、測試帳號、常見錯誤、正式發布）。
- [x] 單元／瀏覽器／Drive mock 失敗情境測試、編輯回歸與更新文件。
- 發布：依既有授權將本次功能提交並推送 main；接手時以 git log 與 origin/main 確認發布狀態。
- 真實 Google OAuth 與 Drive 驗收需要使用者建立 Cloud 專案與公開 Client ID；不可假稱已實測雲端。

- 本機還原／保護版本／圖片完整性與跨分頁 revision 防護已通過 browser 測試；12 個 Node tests 通過。Google API mock 上傳／重試／跨裝置還原／分歧與帳號隔離皆通過。
- 此輪 Python 測試網站 port 8040（session 54539），Drive 模擬測試 tests/history_smoke.py 不使用真實 Google 憑證。

- 最終驗證：12 個 Node tests、6 組版本／Drive mock 瀏覽器情境、3 組編輯 smoke、9 組協作 smoke 全數通過；build 與 diff check 通過。
- OAuth 教學：docs/GOOGLE_DRIVE_SETUP.md。公開 Client ID 尚未設定，可先從 UI 輸入驗證；真實 OAuth／Drive、Pages 上線仍待外部驗收。
- 版本視窗在 390px 手機與 1280px 桌機檢查通過，無橫向溢出。

## Google OAuth 網頁用戶端設定
- [x] 將使用者提供的網頁 OAuth 公開 Client ID 設為網站預設值；新使用者不必自行設定 Google Cloud。
- [ ] 使用者確認 Google Console 的 JavaScript origin、drive.file 與測試帳號，實際登入及備份驗收。
- 不包含 client secret；OAuth 尚未完成真實帳號驗收。

## 隱私權政策頁面
- [x] 新增 privacy.html，說明本機與 Drive 資料、授權用途、保留與刪除、第三方服務及聯絡管道；版本視窗加入連結。
- Google 品牌設定政策網址：https://jljimmyh.github.io/note-mvp/privacy.html
- 發布後由使用者填入 Google Console；正式發布及 Google 驗證狀態以控制台為準。

## 🐛 已選取物件可拖曳移動（2026-10-06）
- [x] 修正上一輪把「拖曳已選取物件」也改成移動畫布的誤解：拖曳空白處／未選取物件＝移動畫布；點一下＝選取；在選取框內拖曳＝移動已選取物件（多選一起移動），可 undo。
- [x] tests/pan_selection_smoke.py 改為驗證已選取物件拖曳會移動物件、畫布不動，並新增觸控點選後拖曳移動文字的情境。
- [x] 本機 Chrome headless 以 CDP 觸控／滑鼠事件驗證筆跡、文字、圖片三種物件皆通過；圖片把手縮放與雙指縮放不受影響。
