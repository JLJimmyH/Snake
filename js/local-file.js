// 同步到本機檔案（File System Access API，只有電腦版 Chrome／Edge）：一本筆記本對應一個 zip，
// 有變更停手 DELAY 後整本覆寫。檔案控制代碼存在 IndexedDB meta 'localFile:<筆記本 id>'；
// 筆記本紀錄的 local = { fileName, lastModified（上次寫入或讀取時檔案的時間）, savedChanges, at（上次同步時間）}
import { db } from './db.js';

export const localSupported = typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';
const DELAY = 5000;
const ZIP = [{ description: '筆記本', accept: { 'application/zip': ['.zip'] } }];
const key = id => 'localFile:' + id;
export const handleOf = id => db.get('meta', key(id));
export const setHandle = (id, handle) => db.put('meta', handle, key(id));
export const dropHandle = id => db.del('meta', key(id));
export const localDirty = nb => !!nb.local && nb.changes !== nb.local.savedChanges;

// 使用者按取消回傳 null
const cancelled = error => { if (error?.name === 'AbortError') return null; throw error; };
export const pickSave = name => window.showSaveFilePicker({ suggestedName: name, types: ZIP }).catch(cancelled);
export const pickOpen = () => window.showOpenFilePicker({ types: ZIP }).then(([handle]) => handle, cancelled);

// 有讀寫權限就回傳 true；ask 要在使用者點擊的當下才能跳出瀏覽器的詢問
async function writable(handle, ask) {
  const mode = { mode: 'readwrite' };
  if (!handle.queryPermission || await handle.queryPermission(mode) === 'granted') return true;
  if (!ask) return false;
  try { return await handle.requestPermission(mode) === 'granted'; } catch { return false; }
}

// 開啟檔案只拿到讀取權限：趁還在點擊的當下要寫入權限，要不到就等第一次寫入時顯示「繼續同步」
export const allowWrite = handle => writable(handle, true);

// 同步狀態（每本筆記本）：idle、saving、paused（要重新授權）、conflict（檔案在別處被改過，這台也有變更）、missing（檔案不見了）、error
// pack(nb) 回傳 zip Blob；load(nb, file) 用檔案內容取代這本筆記本；flush() 先把畫布存進 IndexedDB
export function createLocalSync({ current, flush, pack, load, onState }) {
  const states = new Map();
  let timer = null;

  const set = (id, state, message = '') => { states.set(id, { state, message }); onState(); };
  const status = id => states.get(id) ?? { state: 'idle', message: '' };

  // 有變更就排一次寫入；連續變更只會在停手 DELAY 後寫一次
  function schedule(delay = DELAY) {
    clearTimeout(timer);
    timer = setTimeout(() => sync(current()), delay);
  }

  // 寫入檔案。force：不管有沒有變更、檔案有沒有被別處改過都覆寫（使用者選「用這台覆蓋」或剛選好檔案）
  async function sync(id, { force = false, ask = false } = {}) {
    clearTimeout(timer);
    await flush();
    let nb = await db.get('notebooks', id);
    if (!nb?.local || (!force && !localDirty(nb))) return;
    const handle = await handleOf(id);
    if (!handle) return set(id, 'missing');
    if (!await writable(handle, ask)) return set(id, 'paused');
    // 同一本在好幾個分頁開著：排隊寫，不會同時覆寫
    try {
      await navigator.locks.request(key(id), async () => {
        nb = await db.get('notebooks', id);
        if (!nb?.local || (!force && !localDirty(nb))) return;
        let file;
        try { file = await handle.getFile(); } catch (error) { if (error.name === 'NotFoundError' && !force) return set(id, 'missing'); }
        if (!force && file && nb.local.lastModified && file.lastModified !== nb.local.lastModified) return set(id, 'conflict');
        set(id, 'saving');
        const changes = nb.changes;
        const writer = await handle.createWritable();
        await writer.write(await pack(nb));
        await writer.close();
        const { lastModified } = await handle.getFile();
        await db.update('notebooks', id, latest => latest?.local && { ...latest, local: { ...latest.local, savedChanges: changes, lastModified, at: Date.now() } });
        set(id, 'idle');
        if (localDirty(await db.get('notebooks', id))) schedule();
      });
    } catch (error) {
      set(id, 'error', error.message);
    }
  }

  // 檔案在別處被改過（例如 OneDrive 從另一台電腦同步過來）：這台沒有變更就直接載入，兩邊都改過就等使用者決定
  async function check(id, { ask = false } = {}) {
    const nb = await db.get('notebooks', id);
    if (!nb?.local) return;
    const handle = await handleOf(id);
    if (!handle) return set(id, 'missing');
    if (!await writable(handle, ask)) return set(id, 'paused');
    let file;
    try { file = await handle.getFile(); } catch { return set(id, 'missing'); }
    if (file.lastModified === nb.local.lastModified) {
      set(id, 'idle');
      if (localDirty(nb)) schedule(0);
      return;
    }
    await flush();
    if (localDirty(await db.get('notebooks', id))) return set(id, 'conflict');
    await load(nb, file);
    set(id, 'idle');
    return true;
  }

  return { status, schedule, sync, check };
}
