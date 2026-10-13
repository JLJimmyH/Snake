# 協作的 Yjs 模型

`model.js` 是共用頁即時協作的資料模型，瀏覽器（`js/collaboration.js`）與 Cloudflare 房間（`worker/room.js`）共用：
每個物件一個 `Y.Map`（欄位各自合併），`publish()` 只送出跟上次畫面不同的部分，不會刪掉自己還沒看到的遠端物件。

整體架構與設定見 `docs/GOOGLE_DRIVE_SETUP.md` 第 9 節。舊的 Node＋Supabase 協作伺服器已在 2026-10-13 移除。
