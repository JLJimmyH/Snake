# 筆記 MVP

OneNote 式的無限畫布（手寫／打字／圖片／雙指縮放），加上 Notion 式的無限層級頁面樹。
純靜態網頁，資料存在瀏覽器 IndexedDB。

## 👉 直接使用

**https://jljimmyh.github.io/note-mvp/**

手機、平板、電腦用瀏覽器打開就能用，不用安裝。

> **資料存在哪？** 筆記只存在你自己這台裝置的瀏覽器裡，不會上傳。
> 重開機還在；但換瀏覽器／換裝置看不到，清除瀏覽器資料或用無痕模式會消失。
> iPhone / iPad 的 Safari 若超過 7 天沒開這個網站，資料可能被系統清除。

## 本機開發

```
python server.py        # 預設 port 8000
```

電腦開 `http://localhost:8000`，手機（同一個 Wi-Fi）開終端機印出的 `http://<電腦IP>:8000`。

## 結構

| 檔案 | 職責 |
| --- | --- |
| `index.html` | 版面：側欄頁面樹、標題列、工具列、畫布 |
| `css/style.css` | 樣式，`< 768px` 時側欄變成抽屜 |
| `js/db.js` | IndexedDB 包裝：`pages` / `docs` / `blobs` / `meta` |
| `js/board.js` | 畫布引擎：指標事件、手勢、筆跡、文字、圖片、橡皮擦、復原 |
| `js/main.js` | 頁面樹 CRUD、工具列、自動儲存、快捷鍵 |
| `server.py` | 區網測試伺服器（正確 MIME、關閉快取） |

## 資料模型

```js
page = { id, parentId, title, order, open }          // 樹狀分類（Notion）
doc  = { pageId, view: {x, y, s}, items: [...] }      // 每頁一張無限畫布（OneNote）
item = { id, type: 'stroke', tool, color, width, pts: [[x, y], ...] }
     | { id, type: 'text',  x, y, size, text }
     | { id, type: 'image', x, y, w, h, blobId }     // 圖片本體在 blobs store
```

所有座標都是「世界座標」，畫面以 `translate(x,y) scale(s)` 呈現。
`items` 視為不可變（修改前先複製），所以復原只要保存陣列快照。

## 觸控規則

- 單指：依工具書寫／擦除／打字；偵測到觸控筆後自動改成「單指移動畫面」（工具列可切換）
- 雙指：縮放＋平移，會取消剛開始的那一筆
- 觸控筆書寫中會忽略手掌觸控
- 桌機：滾輪平移、Ctrl+滾輪縮放、中鍵拖曳平移；V/P/H/E/T 切工具，Ctrl+Z / Ctrl+Y
