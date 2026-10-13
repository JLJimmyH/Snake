# 從零設定 Google Drive 筆記本儲存

這份文件寫給網站管理者。你設定一次後，其他使用者只要按「存到 Drive」，就能授權把筆記本存到**他們自己的**硬碟，不必每個人建立 Google Cloud 專案。

每本筆記本在 Drive 上就是 `SnakeNote` 資料夾裡的一個 `<筆記本名稱>.zip` 檔（內含頁面、內容與圖片）。資料夾在第一次存檔時自動建立；「從 Drive 開啟」只列出這個資料夾裡的筆記本。自己在 Drive 手動建立的同名資料夾，網站因 `drive.file` 權限看不到，會另外建立一個。

存到 Drive 之後會自動同步：停手約 10 秒自動上傳；回到分頁時與每分鐘檢查 Drive 上有沒有別台裝置存的新版本，有就合併進來。兩台裝置改了不同頁會自動合併；改到同一頁時，這台的版本留著，另一台的另存成「（衝突副本）」頁面。要留備份，使用「另存副本到 Drive」。

目前網址：https://jljimmyh.github.io/Snake/

本功能可在 GitHub Pages 運作，不需要 Supabase 或 Node 後端；只是 Google 授權約一小時過期，過期後要再按一次儲存重新連線。部署到自己的 Cloudflare 網域（見第 8 節）就能長期保持登入，背景自動同步不會中斷。Google OAuth／Drive 真實帳號尚未在本開發環境驗收；請完成下列設定後，先用測試帳號驗證。

## 目前的設定（要改東西從這裡進）

Google Cloud 專案 ID：`note-510807`（第 1～4 節已做完，以下直接開到對應頁面）

| 要改什麼 | 網址 |
| --- | --- |
| 用戶端：JavaScript 來源、redirect URI、Client secret（第 4、8 節） | https://console.cloud.google.com/auth/clients?project=note-510807 |
| 對象：測試使用者、Testing／In production（第 3、7 節） | https://console.cloud.google.com/auth/audience?project=note-510807 |
| 資料存取：`drive.file` 權限（第 3 節） | https://console.cloud.google.com/auth/scopes?project=note-510807 |
| 品牌：應用名稱、首頁、隱私權政策（第 7 節） | https://console.cloud.google.com/auth/branding?project=note-510807 |
| Google Drive API 啟用狀態（第 2 節） | https://console.cloud.google.com/apis/library/drive.googleapis.com?project=note-510807 |

Client ID 寫在 `js/drive-config.js`（GitHub Pages）與 `wrangler.jsonc` 的 `GOOGLE_CLIENT_ID`（Cloudflare），兩邊要一致。

## 你需要什麼

- 一個你能管理的 Google 帳號。
- 能修改此網站程式並部署的權限。
- 要測試的 Google 帳號 email。

網站只需要 **OAuth Client ID（用戶端 ID）**，這是公開識別碼，可以放在前端程式。
**不要填 Client secret（用戶端密鑰）、API key 或 service account key。** 這個前端流程不使用它們，也不要把它們貼進聊天或 Git。

## 1. 建立 Google Cloud 專案

1. 開啟 https://console.cloud.google.com/ 並登入。
2. 點畫面上方的專案選單 →「新增專案／New project」。
3. 專案名稱可填 `Snake Note`。如果沒有組織，選「無組織」。
4. 建立後，確認上方目前選取的是剛建立的專案。

建立專案／使用 Drive API 本身通常不需要為此功能啟用付費服務；使用者上傳的檔案占用自己的 Drive 空間。若控制台要求帳務，先確認沒有誤選其他付費產品。

## 2. 啟用 Google Drive API

1. 左側「API 和服務」→「程式庫／Library」。
2. 搜尋 `Google Drive API`。
3. 開啟並按「啟用／Enable」。

官方 API 頁面：https://console.cloud.google.com/apis/library/drive.googleapis.com

## 3. 設定 OAuth 同意畫面

Google 控制台可能顯示「Google Auth Platform」，或在「API 和服務」下面顯示「OAuth 同意畫面」。以下依欄位名稱對照即可。

1. 開啟 Google Auth Platform →「開始使用／Get started」。
2. **應用程式名稱／App name**：填 `Snake Note` 或你想給使用者看到的產品名稱。
3. **使用者支援電子郵件／User support email**：選你的管理者 email。
4. **對象／Audience**：一般個人帳號選 **外部／External**。Internal 只適用特定 Workspace 組織。
5. **開發人員聯絡資料／Developer contact information**：填你能收信的 email。
6. 同意必要條款並完成基本設定。
7. 在 **Audience／對象** 找「測試使用者／Test users」，加入你自己的 Google email，以及協助測試者的 email。
8. 第一階段保持 **Testing／測試中**，不要急著發布到所有人。

在 **Data Access／資料存取**（舊介面可能叫 Scopes／範圍）加入：

```
https://www.googleapis.com/auth/drive.file
```

這個權限讓程式管理經由此應用建立或授權的 Drive 檔案，不是讀取整個硬碟。不要改選完整 `drive` 權限。

Google 介面的欄位／選單可能調整。若頁面要求品牌首頁、隱私權政策或已驗證網域，請填實際公開的文件與你能驗證的網域；不要填不存在的政策網址。Testing 階段與正式發布的要求可能不同。

## 4. 建立網頁用 OAuth Client ID

1. Google Auth Platform → **Clients／用戶端** →「建立用戶端」。
   舊介面可用：API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID。
2. **應用程式類型／Application type** 選 **Web application／網頁應用程式**。
3. 名稱填 `Snake Note Web`。
4. 在 **Authorized JavaScript origins／已授權的 JavaScript 來源** 加入：

```
https://jljimmyh.github.io
```

注意：**沒有 `/Snake/`，也沒有尾端 `/`**。Origin 只包含通訊協定、網域和必要的 port。

若要在自己的電腦測試，可另外加入實際使用的來源，例如：

```
http://localhost:8040
http://127.0.0.1:8040
```

5. 本版本使用 Google Identity Services 的 **彈出式 access-token 流程**，**不需要新增 Authorized redirect URIs**。
6. 建立後複製 **Client ID**，它的格式類似：

```
1234567890-abcdefgh.apps.googleusercontent.com
```

Google 可能同時顯示 Client secret；本專案不用它，請不要填到網站。

## 5. 設定網站的 Client ID

修改儲存庫的 `js/drive-config.js`：

```js
export const GOOGLE_DRIVE_CLIENT_ID = '你的公開 Client ID.apps.googleusercontent.com';
```

把實際完整 Client ID 放進字串，不要重複加上結尾。提交並等 Pages 部署完成。

## 6. 先在自己的瀏覽器測試

1. 開啟網站，寫幾筆、加一張小圖片。
2. 按上方 **☁ 存到 Drive**（或點左上角筆記本名稱 → **儲存到 Drive**）。彈出視窗必須由你點擊觸發。
3. 選擇已加入測試使用者的 Google 帳號，閱讀並接受 Drive 授權。
4. 等畫面顯示 **已儲存到…的 Drive**，按鈕變成 **☁ 已存到 Drive**。
5. 到該帳號的 Google Drive，應可看到 `SnakeNote` 資料夾，裡面有 `我的筆記.zip`。
6. 換一個瀏覽器（或無痕視窗），點筆記本名稱 → **從 Drive 開啟…**，確認能開啟並看到相同內容與圖片。
7. 在其中一邊加一頁並寫字，等按鈕變成「已儲存」；回到另一邊（切換分頁或按「立即同步」），應看到新的頁面。
8. 兩邊同時改同一頁再各自同步，後同步的那邊應多出一頁「（衝突副本）」，兩邊寫的內容都還在。

zip 檔可以下載後解壓縮查看，但請勿手動修改裡面的檔案；格式不正確時網站會拒絕開啟，不會影響已開啟的筆記本。

access token 只保存在記憶體，關閉網站後不會保留，下次儲存時需要重新連線（第 8 節的 Cloudflare 版本不用）。

## 7. 正式開放給所有人之前

1. 確認存到 Drive、從 Drive 開啟、圖片、另存副本、重新授權都成功。
2. 準備真實的網站首頁、隱私權政策與支援聯絡方式。說明：筆記存於 IndexedDB／使用者 Drive、哪些權限會被使用、如何斷開及刪除資料。
3. 在 Google Auth Platform 的 Audience 依介面切換到 Production／正式發布，並完成控制台要求的品牌、網域或應用驗證。
4. `drive.file` 屬較窄的權限，但不能保證不需要任何 Google 驗證；以該專案控制台顯示的要求為準。
5. 不要僅因 OAuth Client ID 已建立，就宣稱應用已正式發布。

未來搬到自己的 Cloudflare 網域時，在同一用戶端新增實際來源，例如 `https://notes.example.com`，再更新網站／隱私文件；不需要為每位使用者建立 Client ID。**盡量沿用同一 Google Cloud 專案／應用身分**，換成完全不同的應用可能無法讀取原本 drive.file 授權下的檔案。

## 常見問題

### `origin_mismatch`／不允許的來源

確認來源是 `https://jljimmyh.github.io`，沒有路徑；本機 port 必須吻合。修改 Google 設定後可能需要等待傳播，稍後重新整理再試。

### `access_denied`／測試中只有部分使用者能登入

確認登入帳號已加入 Test users，且對象設為 External。不要用「任何人都可登入」來繞過尚未完成的正式發布要求。

### 視窗沒打開或被關閉

允許網站彈出視窗，等待 Google 登入元件載入後，直接點連線。內嵌瀏覽器可能限制 OAuth；可改用 Chrome／Safari 的一般瀏覽器開啟網站。

### Drive API 被停用／403

確認是在同一 Google Cloud 專案啟用 Drive API，也確認帳號有空間且授權包含 drive.file。不要額外提供完整 Drive 權限或管理員密鑰來修復。

### 授權過期

再按一次「儲存到 Drive」，會重新開啟 Google 授權視窗。本機筆記本仍保留。授權只暫存在記憶體，不保證網站關閉後繼續上傳。

### 換另一個 Google 帳號

點筆記本名稱 →「中斷 Google 連線」，下次連線時再選另一個帳號。每本筆記本會記住它存在哪個帳號，不能用其他帳號覆寫；要存到另一個帳號，先連上該帳號，再用「另存副本到 Drive」。

### 另一台裝置找不到筆記

點筆記本名稱 →「從 Drive 開啟…」，用同一個 Google 帳號連線。只會列出由本網站存到 Drive 的筆記本；自己上傳到 Drive 的 zip 看不到，請下載後用「匯入 zip…」。開啟後兩台裝置會自動同步，但不是即時的：上傳要停手約 10 秒，另一台最慢一分鐘內（或切回分頁時）才會看到。

### 出現「（衝突副本）」頁面

兩台裝置在同步之前都改了同一頁的內容。這台的版本留在原本的頁面，另一台的版本存成「（衝突副本）」，看過後把要的內容搬回原頁、刪掉副本即可。只改到不同頁，或一邊只改標題、一邊只改內容，都會自動合併，不會產生副本。

### 「Drive 上的檔案被別台裝置改過，這台也有變更」

只會出現在舊版網站存過、還沒用新版同步過的筆記本（沒有上次同步的紀錄，無法判斷哪邊改了什麼）。選「用這台覆蓋」或「載入 Drive 的內容」；被覆蓋的內容通常仍可在 Drive 檔案的「管理版本」找回。處理一次之後就會自動合併。

### 如何撤銷授權

「中斷 Google 連線」只清除此頁的 access token，不刪 Drive 檔案。要撤銷應用權限，請至 Google 帳號 → 安全性 → 第三方應用程式與服務，找到此應用並移除存取權。

## 8. 部署到自己的 Cloudflare 網域（長期保持登入）

GitHub Pages 只能用 Google 給的短期 access token。部署成 Cloudflare Worker（`worker/index.js`、`wrangler.jsonc`）之後，Worker 幫瀏覽器保存 Google 的 refresh token：

- 連線 Google 時整頁跳到 Google 授權，回來後 refresh token 以 AES-GCM 加密存進 HttpOnly cookie（網頁程式讀不到）。
- 需要時瀏覽器向 `/api/google/token` 換新的 access token，重新整理、隔天打開都不用再登入。
- Worker 不存任何資料，也不經手筆記內容；筆記仍由瀏覽器直接傳到 Google Drive。

目前 `sync` 分支的測試站是 `https://snake-dev.g6n4f.com`。

### Google Cloud 設定（同一個 OAuth Client）

1. Google Auth Platform → Clients → 開啟網站用的那個 Web client。
2. **Authorized JavaScript origins** 加入 `https://snake-dev.g6n4f.com`。
3. **Authorized redirect URIs** 加入 `https://snake-dev.g6n4f.com/api/google/callback`。
4. 需要 **Client secret**。Google 只在建立當下顯示一次；看不到就在同一頁按「Add secret」新增一組，複製下來（只用在下一步，不要貼到聊天或 Git）。
5. 發布狀態維持 **Testing** 時，Google 發的 refresh token **7 天後失效**，到時要重新連線。要長期登入，需切到 **In production**（`drive.file` 是非敏感權限，一般不需要安全評估，但要填好首頁、隱私權政策與已驗證的網域）。

### Cloudflare 設定

在專案資料夾執行（`wrangler` 已登入同一個 Cloudflare 帳號）：

```
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

貼上 Client secret（輸入時不會顯示）。另一個 secret `SESSION_KEY` 是加密 cookie 用的隨機字串，部署時已設定；換掉它會讓所有人的登入失效，需要重新連線。

部署：`npx wrangler deploy`（會先跑 `scripts/site.mjs`，只把 index.html、privacy.html、css、js 複製到 `dist/` 上傳）。

### 跟 GitHub Pages 的資料是分開的

瀏覽器的本機資料依網址分開存：`snake-dev.g6n4f.com` 看不到 `jljimmyh.github.io/Snake/` 裡的本機筆記本。要帶過去，先在舊網址存到 Drive，再到新網址「從 Drive 開啟」。

## 9. 共用頁面（即時協作）

只在 Cloudflare 版本有。在左側頁面的「⋯」選「共用此頁…」：

1. 這一頁另存成 `SnakeNote/共用頁面/<頁面名稱>.zip`，筆記本裡的這一頁連到它（圖示變成 👥）。
2. 共用視窗跟 Google 的一樣：輸入 email、選編輯者／檢視者後傳送，Google 會寄信給對方（信裡有開啟連結）；也能改權限、移除、設定「知道連結的任何人」、複製連結。
3. 對方打開連結 → 登入 Google → 第一次要在 Google 檔案選擇器選取這個檔案（`drive.file` 權限只看得到 app 自己建立的檔案，別人共用來的要選過一次）→ 進入同一頁。
4. 同一頁的人即時看到彼此的筆跡、游標（附名字）、選取的物件與正在編輯的文字框；頂列有在線的人。

背後：每個共用檔案在 Cloudflare 有一間房間（Durable Object，`worker/room.js`），負責轉發與暫存；誰能進來每 10 分鐘用那個人自己的 Google 授權問 Drive 一次（`files.get` 的 `capabilities`）。在線的編輯者之一定時把內容寫回 Drive 檔案。圖片暫存在房間裡，每頁上限 50 MB。

### Google 檔案選擇器（Picker）設定

讓被邀請的人能開啟別人共用的檔案，要設定一次：

1. 啟用 Google Picker API：https://console.cloud.google.com/apis/library/picker.googleapis.com
2. 建立 API 金鑰：https://console.cloud.google.com/apis/credentials →「建立憑證」→「API 金鑰」。
   - 應用程式限制：網站，加入 `https://snake-dev.g6n4f.com/*` 與 `https://docs.google.com/*`（少了後者 Picker 會說金鑰無效）。
   - API 限制：只勾 Google Picker API。
3. 把金鑰填進 `js/drive-config.js` 的 `GOOGLE_PICKER_KEY`（公開金鑰，可以放在前端），重新部署。

`GOOGLE_APP_ID` 是 Cloud 專案編號（Client ID 開頭那串數字）。

### 本機測試

`tests/live_smoke.py` 在 `wrangler dev` 裡跑真正的 Worker 與 Durable Object，Google 用 `tests/fake_drive.py` 模擬：Alice 共用、用 email 邀請 Bob，Bob 開連結、選檔案、兩邊同時畫、看到對方游標與選取，最後檢查寫回 Drive。需要 Node（`npx wrangler`）。

## 官方參考

- Google 檔案選擇器：https://developers.google.com/workspace/drive/picker/guides/overview
- Drive 共用權限：https://developers.google.com/workspace/drive/api/guides/manage-sharing

- 伺服器端授權碼流程（refresh token）：https://developers.google.com/identity/protocols/oauth2/web-server

- OAuth 用戶端設定：https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid
- 前端 token 流程：https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Drive 權限：https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive 上傳（resumable upload）：https://developers.google.com/workspace/drive/api/guides/manage-uploads


## 檔案限制

- 一本筆記本最大 100 MB，單張圖片最大 20 MB。
- 沒有版本歷史；要保留某個時間點，請用「另存副本到 Drive」或「匯出 zip」。
- 舊版的「筆記 MVP 版本歷史」資料夾不再使用，網站不會讀取或刪除它，可自行在 Drive 刪除。
