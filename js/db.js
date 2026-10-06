// 極簡 IndexedDB 包裝：pages(頁面樹) / docs(頁面內容) / blobs(圖片) / meta(設定)
const DB_NAME = 'note-mvp';
const DB_VERSION = 2;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'pageId' });
      for (const store of ['blobs', 'meta', 'versions', 'objects']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
    req.onblocked = () => reject(new Error('請關閉其他舊版筆記分頁，再重新整理'));
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const changesNotes = mode === 'readwrite' && ['pages', 'docs', 'blobs'].includes(store);
    const tx = db.transaction(changesNotes ? [store, 'meta'] : store, mode);
    const req = fn(tx.objectStore(store));
    if (changesNotes) {
      const meta = tx.objectStore('meta');
      const rev = meta.get('workspaceRevision');
      rev.onsuccess = () => meta.put((rev.result ?? 0) + 1, 'workspaceRevision');
    }
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


// Read pages, documents, their referenced images and revision in ONE transaction.
export async function snapshotWorkspace() {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['pages', 'docs', 'blobs', 'meta'], 'readonly');
    const pages = tx.objectStore('pages').getAll();
    const docs = tx.objectStore('docs').getAll();
    const revision = tx.objectStore('meta').get('workspaceRevision');
    const blobs = new Map();
    docs.onsuccess = () => {
      const pageIds = new Set(pages.result.map(p => p.id));
      for (const id of new Set(docs.result.filter(d => pageIds.has(d.pageId)).flatMap(d => d.items.filter(i => i.type === 'image').map(i => i.blobId)))) {
        const req = tx.objectStore('blobs').get(id);
        req.onsuccess = () => { if (req.result) blobs.set(id, req.result); };
      }
    };
    tx.oncomplete = () => resolve({ pages: pages.result, docs: docs.result, blobs, revision: revision.result ?? 0 });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Both protecting the old state and applying the restored state are atomic.
// A changed workspace revision aborts BEFORE any existing page is removed.
export async function commitHistory({ scope, expectedHead, records, head, restore, expectedRevision }) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const stores = restore ? ['versions', 'meta', 'pages', 'docs', 'blobs'] : ['versions', 'meta'];
    const tx = database.transaction(stores, 'readwrite');
    const meta = tx.objectStore('meta');
    const previous = meta.get('history:' + scope);
    const revision = meta.get('workspaceRevision');
    let failure;
    revision.onsuccess = () => {
      if ((previous.result?.head ?? null) !== expectedHead || (restore && (revision.result ?? 0) !== expectedRevision)) {
        failure = new Error('其他分頁已修改筆記或版本，請重新開啟版本歷史後再試'); tx.abort(); return;
      }
      for (const commit of records) tx.objectStore('versions').put({ scope, commit }, scope + ':' + commit.id);
      meta.put({ ...previous.result, head }, 'history:' + scope);
      if (restore) {
        tx.objectStore('pages').clear(); tx.objectStore('docs').clear();
        for (const page of restore.pages) tx.objectStore('pages').put(page);
        for (const doc of restore.docs) tx.objectStore('docs').put(doc);
        for (const [id, blob] of restore.blobs) tx.objectStore('blobs').put(blob, id);
        meta.put(restore.pages[0].id, 'lastPage');
        meta.put((revision.result ?? 0) + 1, 'workspaceRevision');
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure || tx.error);
    tx.onabort = () => reject(failure || tx.error);
  });
}
