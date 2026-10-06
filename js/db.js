// 極簡 IndexedDB 包裝：pages(頁面樹) / docs(頁面內容) / blobs(圖片) / meta(設定)
const DB_NAME = 'note-mvp';
const DB_VERSION = 1;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('pages', { keyPath: 'id' });
      db.createObjectStore('docs', { keyPath: 'pageId' });
      db.createObjectStore('blobs');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  getAll: (store) => run(store, 'readonly', s => s.getAll()),
  put: (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key))),
  // Atomic read/modify/write, used to merge offline snapshots from multiple tabs.
  update: async (store, key, fn) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      const request = objectStore.get(key);
      request.onsuccess = () => {
        try { objectStore.put(fn(request.result), key); }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
