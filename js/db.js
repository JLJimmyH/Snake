// 極簡 IndexedDB 包裝：notebooks(筆記本) / pages(頁面樹) / docs(頁面內容) / blobs(圖片) / meta(設定)
const DB_NAME = 'snake-note';
const DB_VERSION = 1;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('pages', { keyPath: 'id' }).createIndex('notebookId', 'notebookId');
      db.createObjectStore('docs', { keyPath: 'pageId' });
      for (const store of ['blobs', 'meta', 'notebooks']) db.createObjectStore(store);
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
    req.onblocked = () => reject(new Error('請關閉其他舊版筆記分頁，再重新整理'));
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// changes / savedChanges：不相等就是有尚未存到 Drive 的變更
export function newNotebook(id, name, extra = {}) {
  return { id, name, created: Date.now(), lastPage: null, changes: 0, savedChanges: 0, drive: null, ...extra };
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 多個 store 的單一 transaction；fn 回傳的值在 commit 後 resolve
async function transaction(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  getAll: (store) => run(store, 'readonly', s => s.getAll()),
  put: (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key))),
  // Atomic read/modify/write, used to merge offline snapshots from multiple tabs.
  // fn 回傳 undefined 代表不寫入（例如紀錄已被別的分頁刪除）。
  update: async (store, key, fn) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      const request = objectStore.get(key);
      let value;
      request.onsuccess = () => {
        try {
          value = fn(request.result);
          if (value !== undefined) objectStore.put(value, key);
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  keys: store => run(store, 'readonly', s => s.getAllKeys()),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const pagesOf = notebookId => run('pages', 'readonly', s => s.index('notebookId').getAll(notebookId));

const imageIds = docs => new Set(docs.flatMap(d => d.items.filter(i => i.type === 'image').map(i => i.blobId)));

// 一本筆記本的頁面、內容與圖片，在同一個 transaction 讀出（匯出／存到 Drive 用）
export function readNotebook(notebookId) {
  return transaction(['pages', 'docs', 'blobs'], 'readonly', tx => {
    const out = { pages: [], docs: [], blobs: new Map() };
    const pages = tx.objectStore('pages').index('notebookId').getAll(notebookId);
    pages.onsuccess = () => {
      out.pages = pages.result;
      for (const page of pages.result) {
        const doc = tx.objectStore('docs').get(page.id);
        doc.onsuccess = () => {
          if (!doc.result) return;
          out.docs.push(doc.result);
          for (const id of imageIds([doc.result])) {
            const blob = tx.objectStore('blobs').get(id);
            blob.onsuccess = () => { if (blob.result) out.blobs.set(id, blob.result); };
          }
        };
      }
    };
    return out;
  });
}

function putContent(tx, notebook, { pages, docs, blobs }) {
  tx.objectStore('notebooks').put(notebook, notebook.id);
  for (const page of pages) tx.objectStore('pages').put({ ...page, notebookId: notebook.id });
  for (const doc of docs) tx.objectStore('docs').put(doc);
  for (const [id, blob] of blobs) tx.objectStore('blobs').put(blob, id);
}

// 刪掉一本筆記本的頁面、內容與圖片（不含筆記本紀錄本身）。刪除的請求都發出後才呼叫 then，
// 之後發出的寫入一定排在刪除後面，同樣 ID 的新內容不會被刪掉。
function removeContent(tx, notebookId, then = () => {}) {
  const pages = tx.objectStore('pages').index('notebookId').getAll(notebookId);
  pages.onsuccess = () => {
    let left = pages.result.length;
    if (!left) then();
    for (const page of pages.result) {
      const doc = tx.objectStore('docs').get(page.id);
      doc.onsuccess = () => {
        for (const id of imageIds(doc.result ? [doc.result] : [])) tx.objectStore('blobs').delete(id);
        tx.objectStore('docs').delete(page.id);
        tx.objectStore('pages').delete(page.id);
        if (!--left) then();
      };
    }
  };
}

const ALL = ['notebooks', 'pages', 'docs', 'blobs'];

// 匯入或從 Drive 開啟：筆記本與全部內容一次寫入，不會只寫一半
export function addNotebook(notebook, content) {
  return transaction(ALL, 'readwrite', tx => putContent(tx, notebook, content));
}

// 從 Drive 或檔案同步：舊內容換成新內容，同一個 transaction（先刪後寫，同樣的 ID 會留下新的）。
// changes：只在筆記本的 changes 還是這個值時才換（期間有新的編輯就放棄，回傳 false）
export async function replaceNotebook(notebook, content, changes) {
  let done = true;
  await transaction(ALL, 'readwrite', tx => {
    const write = () => removeContent(tx, notebook.id, () => putContent(tx, notebook, content));
    if (changes === undefined) return write();
    const request = tx.objectStore('notebooks').get(notebook.id);
    request.onsuccess = () => { if (request.result?.changes === changes) write(); else done = false; };
  });
  return done;
}

// 關閉筆記本：移除本機的頁面、內容與圖片（Drive 上的檔案不受影響）
export function deleteNotebook(notebookId) {
  return transaction(ALL, 'readwrite', tx => { removeContent(tx, notebookId); tx.objectStore('notebooks').delete(notebookId); });
}
