# 從零設定 Google Drive 版本備份

這份文件寫給網站管理者。你設定一次後，其他使用者只要按「連結 Google Drive」，就能授權把版本存到**他們自己的**硬碟，不必每個人建立 Google Cloud 專案。

目前網址：https://jljimmyh.github.io/note-mvp/

本功能可在 GitHub Pages 運作，不需要 Supabase 或 Node 後端。Google OAuth／Drive 真實帳號尚未在本開發環境驗收；請完成下列設定後，先用測試帳號驗證。

## 你需要什麼

- 一個你能管理的 Google 帳號。
- 能修改此網站程式並部署的權限。
- 要測試的 Google 帳號 email。

網站只需要 **OAuth Client ID（用戶端 ID）**，這是公開識別碼，可以放在前端程式。
**不要填 Client secret（用戶端密鑰）、API key 或 service account key。** 這個前端流程不使用它們，也不要把它們貼進聊天或 Git。

## 1. 建立 Google Cloud 專案

1. 開啟 https://console.cloud.google.com/ 並登入。
2. 點畫面上方的專案選單 →「新增專案／New project」。
3. 專案名稱可填 `Note MVP`。如果沒有組織，選「無組織」。
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
2. **應用程式名稱／App name**：填 `筆記 MVP` 或你想給使用者看到的產品名稱。
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
3. 名稱填 `Note MVP Web`。
4. 在 **Authorized JavaScript origins／已授權的 JavaScript 來源** 加入：

```
https://jljimmyh.github.io
```

注意：**沒有 `/note-mvp/`，也沒有尾端 `/`**。Origin 只包含通訊協定、網域和必要的 port。

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

## 5. 先在自己的瀏覽器測試

1. 等新版 Pages 完成部署，開啟網站。
2. 點上方 **版本 / Drive**。
3. 展開 **Google Drive 連線設定**。
4. 將 Client ID 貼到欄位，按 **儲存設定**。
5. 等待「設定已保存」，再按 **連結 Google Drive**。彈出視窗必須由你點擊觸發。
6. 選擇已加入測試使用者的 Google 帳號，閱讀並接受 Drive 授權。
7. 確認畫面顯示正確的 Google email。連線成功不會自動上傳筆記。
8. 寫幾筆、加一張小圖片，再開「版本 / Drive」，填備註，按 **建立並備份到 Drive**。
9. 等畫面明確顯示 **已備份至…的 Drive**。
10. 到該帳號的 Google Drive，應可看到 **筆記 MVP 版本歷史** 資料夾。

資料夾包含應用程式專用的版本索引與內容檔案。請勿手動改檔案內容或刪除個別圖片／版本依賴，否則歷史版本可能無法還原。版本驗證失敗時網站會拒絕還原，不會覆蓋本機筆記。

介面保存的 Client ID 只在目前瀏覽器生效；關閉網站後 access token 不會保留，下次需要重新連線。

## 6. 讓所有使用者共用網站設定

你確認測試成功後，修改儲存庫的 `js/drive-config.js`：

```js
export const GOOGLE_DRIVE_CLIENT_ID = '你的公開 Client ID.apps.googleusercontent.com';
```

把實際完整 Client ID 放進字串，不要重複加上結尾。提交與部署後，其他人不必自己填 Client ID。

若你先前在瀏覽器儲存過另一個 Client ID，可在設定面板確認目前值。網站預設設定會在重新整理後優先套用。

## 7. 正式開放給所有人之前

1. 確認 Google Drive 連結、圖片上傳、歷史下載、還原、重新授權都成功。
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

按「連結 Google Drive」重新授權，再按「上傳目前分支／重試」。本機版本仍保留。授權只暫存在記憶體，不保證網站關閉後繼續上傳。

### 換另一個 Google 帳號

先中斷連結，再選另一個帳號。各帳號有獨立版本分支。連線／讀取歷史不會上傳本機資料；按「建立並備份」才會把當前筆記送到選定帳號。

### 另一台裝置找不到筆記

在同一應用、使用同一 Google 帳號連線後按「讀取雲端歷史」，選版本預覽再還原。此版是手動版本管理，不是即時跨裝置同步。

### 多份分歧版本

代表不同裝置或分頁各自建立了分支。系統會保留全部歷史，不選擇性覆寫。先預覽，選需要的版本還原；還原也會產生新版本。

### 如何撤銷授權

「中斷連結」只清除此頁的 access token，不刪 Drive 檔案。要撤銷應用權限，請至 Google 帳號 → 安全性 → 第三方應用程式與服務，找到此應用並移除存取權。

## 官方參考

- OAuth 用戶端設定：https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid
- 前端 token 流程：https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Drive 權限：https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive 上傳與預先產生 ID：https://developers.google.com/workspace/drive/api/guides/manage-uploads


## 檔案與版本限制

目前不會自動清除歷史。內容雜湊讓一般重試與連續版本可重用相同圖片；若兩台裝置同時首次上傳完全相同內容，Drive 不提供唯一鍵限制，實體檔案可能有副本，但版本清單會按版本 ID 去重，也不會覆寫任何版本。暫時不要手動清理個別檔案；自動垃圾清理留待後續版本。
