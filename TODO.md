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
- [x] 深色模式、畫布顏色
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
- Google 品牌設定政策網址：https://jljimmyh.github.io/Snake/privacy.html
- 發布後由使用者填入 Google Console；正式發布及 Google 驗證狀態以控制台為準。

## 🐛 已選取物件可拖曳移動（2026-10-06）
- [x] 修正上一輪把「拖曳已選取物件」也改成移動畫布的誤解：拖曳空白處／未選取物件＝移動畫布；點一下＝選取；在選取框內拖曳＝移動已選取物件（多選一起移動），可 undo。
- [x] tests/pan_selection_smoke.py 改為驗證已選取物件拖曳會移動物件、畫布不動，並新增觸控點選後拖曳移動文字的情境。
- [x] 本機 Chrome headless 以 CDP 觸控／滑鼠事件驗證筆跡、文字、圖片三種物件皆通過；圖片把手縮放與雙指縮放不受影響。

## ✨ 疊放物件再點一下選下一層（2026-10-06）
- [x] 在已選取的物件上再點一下（沒拖曳），改選該點下一層的物件，到最底層後回到最上層；選到後拖曳只移動該層物件。
- [x] 選取框在螢幕上至少 44px：細筆跡的把手原本擠在一起，觸控點框內會被瀏覽器吸附到把手（變成縮放而非選下一層／移動）。
- [x] tests/pan_selection_smoke.py 新增圖片／筆跡／圖片三層疊放的循環點選與拖曳情境。
- [x] 本機 Chrome headless 以 CDP 觸控／滑鼠驗證：三層循環點選、選到底層後拖曳只移動該層、細筆跡從中間拖曳＝移動、右側把手仍可拉長。

## 🐛 點選順序跟畫面疊放一致（2026-10-06）
- [x] 畫面分層繪製（圖片層 < 筆跡層 < 文字層），但點選原本照建立順序，例如後加的圖片會被先點中，雖然它畫在筆跡底下。改成依 DOM 順序（＝實際疊放順序）由上到下點選，遠端協作改動造成的同層順序變化也會一致。
- [x] tests/pan_selection_smoke.py 疊放情境加入「最先建立但在最上層」的文字，驗證點選順序：文字 > 筆跡 > 前圖 > 後圖。
- [x] 本機 Chrome headless 以 CDP 觸控／滑鼠驗證通過。

## ✨ 縮放手感與畫面導覽（2026-10-06）
- [x] Ctrl+滾輪：滑鼠一格（deltaY≈100）原本一次跳到 272%／37%，改成每次事件最多約 10%；觸控板捏合的小 delta 仍照原比例跟手。
- [x] 縮放控制從工具列移到畫布右下角浮動導覽列：－／百分比（回到 100%）／＋（整數比例）、顯示全部內容、小地圖開關。工具列因此短一點。
- [x] 小地圖（js/minimap.js）：範圍＝內容＋目前畫面；筆跡、圖片縮圖、文字灰條；內容太小時畫圓點標記；點一下跳過去、拖畫面框平移（拖曳中比例尺固定）。桌機預設開、手機預設收，記在 localStorage。
- [x] 畫面裡看不到任何物件時顯示「回到內容」，點擊或 Shift+1 以 300ms 動畫縮放到全部內容（最多 100%，尊重 prefers-reduced-motion）；Shift+0 回到 100%、M 開關小地圖。
- [x] tests/navigation_smoke.py：滾輪縮放幅度、按鈕比例、小地圖點擊／拖曳、顯示全部、提示出現與消失、開關記憶。
- [x] 本機 Chrome headless 以 CDP 在 1280×900 與 390×844 驗證同樣情境通過；本機沒有 Python Playwright，navigation_smoke.py 尚未實際執行。

## ✨ 筆記本取代版本歷史（2026-10-06）
- 原因：版本歷史把每筆筆跡／文字各存成一個 Drive 檔案，Drive 上檔案太多、上傳請求上千次。改成「一本筆記本 = 一個 zip 檔」，沒有版本歷史，要備份就另存副本。
- [x] 側欄左上角筆記本選單：切換、新增、重新命名、關閉；狀態顯示 僅本機／未儲存到 Drive／已存到 Drive。每個瀏覽器分頁各自記住開著哪本。
- [x] IndexedDB v3：新增 notebooks，pages 加 notebookId 索引；既有頁面遷移到「我的筆記」，lastPage 跟著搬。版本歷史（versions／objects 與相關 meta）依使用者決定直接刪除。
- [x] zip 格式（js/notebook-core.js，fflate 0.8.2 放 js/vendor/）：manifest／pages／docs／images；匯入一律驗證、依宣告大小擋 zip bomb、頁面與圖片 ID 全部換新（同一檔開兩次或副本不會互相覆蓋）。
- [x] Drive：存到 Drive（覆寫對應檔案、檔名＝筆記本名稱.zip、改名下次儲存同步）、另存副本（目前筆記本仍對應原檔）、從 Drive 開啟（已開啟就切換）。儲存前比對 headRevisionId，被其他裝置改過要確認；不能用其他帳號覆寫。resumable upload。
- [x] 只移動畫面、展開收合頁面不算變更；內容、頁面增刪改名、筆記本改名才標記未儲存。
- [x] 關閉：未存到 Drive 的變更與僅本機筆記本都要確認；最後一本關掉自動建一本空的；本機頁面、內容、圖片一併移除，Drive 檔案不動。
- [x] 測試：tests/notebook-core.test.mjs（8 個）、tests/notebook_smoke.py（遷移、多本切換、匯出匯入、Drive mock 儲存／衝突／副本／跨裝置／帳號／關閉）通過；navigation_smoke、pan_selection_smoke 回歸通過。
- editor_smoke.py 在本機 Windows Chrome headless 第 40 行失敗（items[0] 不是筆跡），改動前的 HEAD 也一樣失敗，與本次無關，待查。
- collaboration.test.mjs 需要先 npm install（yjs／ws），本輪未執行。
- [ ] 真實 Google 帳號驗收：存到 Drive、從 Drive 開啟、resumable upload 的 CORS（Location header）。
- 本輪 Python 測試網站 port 8040；Playwright 裝在暫存 venv，以本機 Chrome 執行。

## ✨ 深色模式與畫布顏色（2026-10-07）
- [x] 頂列右側「外觀」按鈕（月亮圖示）：主題 跟隨系統／淺色／深色；畫布顏色 自動（跟著主題）／白／米黃／淺灰藍／深灰／黑板綠＋自訂顏色。存在這台裝置的 localStorage（theme、canvasColor），不寫進筆記本或 zip，其他分頁即時跟著換。
- [x] index.html 開頭先套用 data-theme，避免深色模式載入時閃白。CSS 寫死的白底／灰色改成變數（--surface、--chip、--icon、--press、--on-accent）。
- [x] 畫布上的文字、格點、選取框顏色跟著「畫布」深淺，不跟主題（深色介面也能配白紙）。
- [x] js/color.js：深色畫布上對比不到 3 的筆跡（黑筆、深紫等）以反轉 HSL 明度顯示，淺色畫布上幾乎看不到的（白筆）也反轉；只改顯示，資料不變。螢光筆保持原色，深色畫布改用 screen 混色。小地圖、筆刷大小預覽同步。
- [x] tests/appearance_smoke.py：主題切換、畫布顏色、筆跡顯示色、自訂色、重新整理保留、跟隨系統。navigation／pan_selection／notebook smoke 與 notebook-core 8 個 Node tests 回歸通過。
- [x] 文字框 Markdown 的 `.md-code` 背景在深色畫布改用淺色半透明。

## 🎨 配色改成 VS Code／ATOM 風格（2026-10-07）
- [x] 拿掉 OneNote 紫：淺色預設 VS Code Light Modern，深色預設 ATOM（UARTPro 的配色，主色用 One Dark 藍），另有 One Light、VS Code Dark Modern 可選。
- [x] 外觀面板只有一個「主題」列表：跟隨系統（VS Code ↔ ATOM）＋四個主題，卡片標示淺色／深色系列；localStorage 的 theme 存 'system' 或主題名稱，舊版的 light／dark＋lightPalette／darkPalette 載入時自動轉換。畫布「自動」用主題的 --canvas-auto。
- [x] 新 token：--accent-fill（按鈕底色）、--selected（側欄目前頁面）、--danger、--shadow、--canvas-auto；套索／選取框底色改用 color-mix，不再寫死紫色 rgba。
- [x] 側欄目前頁面改成中性底色＋左側主色細線；補上 :focus-visible 外框；Toast 改成跟主題的浮層樣式；theme-color meta 跟著主題的 --surface。
- [x] 畫布上的選取色固定藍（淺色畫布 #0078d4、深色畫布 #4daafc），小地圖畫面框同色；筆的紫色色票改 #9333ea。

## 🤖 AI 整理筆記（2026-10-07 決定）
目標：讓 AI 協助整理目前這頁。AI 不直接改原始資料，而是回傳「操作清單」（ops），由 app 驗證後套用，可以復原。

### 第 1 階段：複製 JSON 給 ChatGPT／Claude 貼上（不需要後端）
- [x] js/ai-core.js：精簡匯出（文字框完整；筆跡只給外框、顏色、是否螢光筆，不給座標；圖片只給外框，不給 blobId）、一個物件一行的 JSON、提示詞、解析回覆（容許 ```json 包起來或前後有說明）、套用 ops（update／move／add／delete，有錯就整批不套用，最多列 5 個錯誤）、變更摘要。
- [x] Board.toPNG：內容範圍（area＝內容外框＋24px）畫成 PNG，最長邊 2400px、最多放大 2 倍；文字畫顯示出來的文字並裁在文字框內。複製到剪貼簿，不行就下載。
- [x] 頂列 ✨「AI 整理」按鈕＋對話框：填要求（可不填）→ 複製給 AI／複製截圖 → 貼回回覆，貼上就顯示變更摘要（刪除筆跡／圖片會特別提示）→ 套用（Board.replaceItems，一次復原就能還原）。
- [x] 複製之後這頁又被改過，套用前 confirm；唯讀頁面不能套用。鍵盤快捷鍵與貼上改成「任何 dialog 開著就不處理」。
- [x] tests/ai-core.test.mjs（5 個）、tests/ai_smoke.py（複製、截圖、錯誤回覆、摘要、套用、復原重做、過期確認、重新整理保留）通過；其他 smoke 與 notebook-core 回歸通過。
- 已知：新增的文字框不會自動避開既有物件，靠提示詞要求 AI 不要重疊；AI 不能新增圖片或改筆跡。
- [ ] 真實 ChatGPT／Claude 試用：提示詞是否夠清楚、回覆格式是否穩定，再依結果調整提示詞。

### 改成「區域匯出＋插入元件」（2026-10-07）
原本整頁匯出、AI 回 ops 改原物件；改成只交出框選的一塊，AI 回傳新元件，使用者自己決定放哪裡，原本的內容不動，方便對照。上面第 1 階段的 ops／replaceItems 已移除。
- [x] ai-core：exportRegion（座標以區域左上角為原點、不給 id；筆跡給 RDP 簡化後的點，全部超過 4000 點才退回外框）、提示詞改成「產生新內容」、回覆格式 {"items":[…]}（text、stroke；不能新增圖片），驗證有錯整批不收；placeItems 整組平移到點的位置；replyItems 判斷貼上的文字是不是 AI 回覆。
- [x] Board：exportArea／contentBounds／toPNG 可以只算指定物件；insertItems（一次復原）；pickPoint／cancelPick 等使用者點畫布。
- [x] 入口：選取後按 ✨ 或在選取範圍按右鍵「提取給 AI 分析」（點到物件會先選它，空白處＝整頁）。放回：對話框「點畫布放上去」（虛線框預覽，Esc 取消，回覆留著可以再放）、畫布上 Ctrl+V、右鍵「在這裡貼上 AI 回覆」。
- 已知：觸控裝置沒有右鍵，用 ✨ 按鈕；放置預覽框的文字大小是粗估。
- [ ] 真實 ChatGPT／Claude 試用：看 AI 畫出來的筆跡（底線、框線、箭頭）是否堪用。
- [x] 右鍵改成複製（2026-10-07）：拿掉「提取給 AI 分析」「在這裡貼上 AI 回覆」，貼上一律 Ctrl+V。選取範圍或物件上按右鍵＝「複製（N 個物件）」，空白處＝「複製全部」；Ctrl+C 也能複製選取的物件。複製內容是同一套 {"items":[…]} JSON（筆跡不簡化、附一行 note 說明格式），貼到別頁或直接貼給 AI 都行。圖片帶 blob id，貼上時圖檔載不到就略過。
- [x] ✨ 對話框只負責複製（2026-10-07）：上方顯示要交出去的內容截圖（預覽和「複製截圖」共用同一張），一個選填的要求欄位、「複製給 AI」「複製截圖」。拿掉貼回回覆、摘要、點畫布放置（Board.pickPoint）；AI 的回覆由使用者在畫布上 Ctrl+V。

### 第 2 階段：網址／MCP 給 agent（等 Cloudflare 同步，見 docs/CLOUDFLARE_SYNC_PLAN.md）
- [ ] 沿用訪客連結發「AI 權杖」：只限單頁、有期限、可撤銷，寫入計在建立者名下。
- [ ] REST：`GET /api/ai/<token>`（精簡 JSON＋說明）、`POST /api/ai/<token>/ops`（同第 1 階段的 ops，經 Durable Object 即時推到開著的畫面）。給能跑 curl 的 agent（Claude Code 等）。
- [ ] 遠端 MCP：同一個 Worker 用 Agents SDK `McpAgent`，網址 `/mcp/<token>`；工具 list_pages、get_page、get_page_image、apply_ops、create_page。給 ChatGPT connector／claude.ai custom connector。
- [ ] 本機／Drive 筆記本的「暫時 MCP」：分頁開著時以 WebSocket 連到 Durable Object，MCP 呼叫轉給瀏覽器執行，關分頁就失效，資料不上傳保存。
- [ ] 實作前再查：ChatGPT connector 開放的方案、是否接受不驗證／權杖放網址。
- [ ] 安全：筆記內容可能夾帶提示詞注入；寫入一律驗證；刪除先標記、使用者確認才真刪。

## 🚧 Cloudflare 即時同步（已規劃，待使用者確認開工）
- 完整計畫：docs/CLOUDFLARE_SYNC_PLAN.md（架構、資料表、協定、上限、費用、階段與驗收）。**使用者確認前不要開始建置。**
- 決定：真的同時寫＋分享給其他人；Cloudflare Workers＋Durable Objects（一本一個 DO，每頁一個 Y.Doc）＋D1＋R2；網站搬到 Cloudflare；圖片存 R2、每人 1 GB；個人筆記本照舊存 Drive，同步筆記本可另存備份到 Drive；移除 Supabase、Node 伺服器與單頁協作。
- 訪客連結：不需帳號、只開放單頁、等候室預設關閉、可上傳圖片（每個連結 50 MB，計入建立者配額）、建立／停止分享時存保護快照可「還原到分享前」。
- [x] 第 0 階段唯讀檢查：Workers Free、網域 g6n4f.com、R2 未啟用、D1 4 個、Workers 5 個（14f-api 是使用者的 Home Assistant 用途，不要動）。
- [ ] 使用者：Dashboard 啟用 R2（需綁付款方式）。
- [ ] 使用者：決定網址（建議 note.g6n4f.com）。
- [ ] 第 1 階段：Worker＋靜態檔案、D1 schema、Sign in with Google、session cookie、允許名單；部署到測試網址。Google Console 加新來源。
- [ ] 第 2 階段：NotebookRoom（每頁 Y.Doc、協定、驗證、分塊快照、Alarm 壓縮、Hibernation）。
- [ ] 第 3 階段：前端同步筆記本（筆記本來源介面、同步客戶端、離線快取、在線名單、筆跡預覽）。
- [ ] 第 4 階段：R2 圖片、1 GB 配額、去重、回收。
- [ ] 第 5 階段：成員分享（email、權限、移除、分享給我的）。
- [ ] 第 6 階段：訪客連結（期限、撤銷、單頁、等候室、50 MB、保護快照）。
- [ ] 第 7 階段：開啟同步、另存備份到 Drive、下載為本機筆記本。
- [ ] 第 8 階段：搬家與清理（移除 Supabase／Node／單頁協作、隱私權政策、GitHub Pages 搬家提示、升級 Paid 後正式開放）。
- 工具：已安裝 Cloudflare Claude 外掛與 cf CLI（使用者這台電腦）；換電腦要重新 `claude plugin marketplace add cloudflare/skills`、`claude plugin install cloudflare@cloudflare`、`npm install -g cf`、`cf auth login`。專案有 wrangler 設定後改用 wrangler。
