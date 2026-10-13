// 自動同步到 Google Drive：有變更停手 DELAY 後上傳（一直在改最多等 MAX_WAIT），回到分頁與每分鐘檢查
// Drive 上有沒有別台裝置存的新版本。兩邊都改過就以頁為單位合併（notebook-core 的 mergeNotebook），再傳回 Drive。
// 筆記本紀錄的 drive = { accountId, email, fileId, revision（上次同步時 Drive 的版本）, base（那一版的快照）, at（上次同步時間）}
import { db } from './db.js';
import { packNotebook, readZip, snapshot, sameSnapshot, mergeNotebook, fileName, nameFromFile } from './notebook-core.js';

const DELAY = 10000;
const MAX_WAIT = 120000;
export const driveDirty = nb => !!nb.drive && nb.changes !== nb.savedChanges;

// 狀態（每本筆記本）：idle、saving、paused（要連線 Google）、conflict（兩邊都改過、又沒有上次同步的快照）、missing、account、error
// store.read(id)：{ nb, content（檔案 ID）, changes }；store.merge(id, theirs, options)：合併進這台並回傳結果，見 notebook-ui
export function createDriveSync({ drive, store, onState, toast }) {
  const states = new Map();
  const timers = new Map();  // 筆記本 id → { timer, since }

  const set = (id, state, message = '') => { states.set(id, { state, message }); onState(); };
  const status = id => states.get(id) ?? { state: 'idle', message: '' };

  // 有變更就排一次上傳；連續變更停手 DELAY 後才傳，但最多等 MAX_WAIT
  function schedule(id, delay = DELAY) {
    if (!id) return;
    const now = Date.now(), pending = timers.get(id);
    clearTimeout(pending?.timer);
    const since = pending?.since ?? now;
    timers.set(id, { since, timer: setTimeout(() => { timers.delete(id); sync(id); }, Math.max(0, Math.min(delay, since + MAX_WAIT - now))) });
  }

  // 同步一次：Drive 上有新版本就合併進來，這台有變更就上傳。
  // force：'local' 用這台的內容覆蓋 Drive、'remote' 用 Drive 的內容取代這台（conflict 時讓使用者選）
  async function sync(id, { force = null } = {}) {
    if (!id) return;
    clearTimeout(timers.get(id)?.timer); timers.delete(id);
    const nb = await db.get('notebooks', id);
    if (!nb?.drive) return;
    if (!drive.connected) return set(id, 'paused');
    if (nb.drive.accountId !== drive.account.id) {
      return set(id, 'account', `這本筆記本存在 ${nb.drive.email} 的 Drive；請先中斷 Google 連線，再用該帳號連線（目前是 ${drive.account.email}）`);
    }
    try {
      // 同一本在好幾個分頁開著：排隊，不會同時上傳
      await navigator.locks.request('drive:' + id, () => run(id, force));
    } catch (error) {
      if (error.auth) set(id, 'paused');
      else set(id, 'error', error.message || '同步失敗，本機筆記仍保留');
    }
  }

  async function run(id, force) {
    const nb = await db.get('notebooks', id);
    if (!nb?.drive) return;
    const { fileId } = nb.drive;
    let remote;
    try { remote = await drive.file(fileId); }
    catch (error) { if (error.status === 404) return set(id, 'missing', 'Drive 上的檔案已刪除或無法存取'); throw error; }
    if (remote.trashed) return set(id, 'missing', 'Drive 上的檔案已移到垃圾桶，請先到 Drive 還原');

    let base = nb.drive.base, expected = remote.headRevisionId, content, changes;
    if (remote.headRevisionId !== nb.drive.revision && force !== 'local') {
      // Drive 上有別台裝置存的新版本
      set(id, 'saving');
      const { file, data } = await drive.download(fileId);
      // 筆記本名稱以 Drive 上的檔名為準（使用者可能在 Drive 直接改名）
      const theirs = { ...await readZip(data), name: nameFromFile(file.name) };
      const result = await store.merge(id, theirs, { base, dirty: driveDirty, takeTheirs: force === 'remote' });
      if (result === 'busy') { schedule(id, 3000); return set(id, 'idle'); }
      if (result === 'conflict') return set(id, 'conflict');
      expected = file.headRevisionId; base = snapshot(theirs);
      if (result.conflicts) toast(`有 ${result.conflicts} 頁在兩台裝置都改過，另一台的版本存成「（衝突副本）」頁面`);
      else if (result.applied) toast('已載入其他裝置在 Drive 上的變更');
      if (sameSnapshot(snapshot(result.content), base)) {
        await saved(id, { savedChanges: result.changes }, { revision: expected, base });
        return set(id, 'idle');
      }
      ({ content, changes } = result);
    } else {
      if (!driveDirty(nb) && force !== 'local') return set(id, 'idle');
      ({ content, changes } = await store.read(id));
    }

    set(id, 'saving');
    const file = await drive.upload({ id: fileId, name: fileName(content.name), blob: await packNotebook(content) });
    await saved(id, { savedChanges: changes }, { revision: file.headRevisionId, base: snapshot(content) });
    // 檢查 Drive 之後、上傳完成之前，別台裝置可能也存了一版，被這次上傳蓋在下面。
    // 把那一版合併後再傳一次；這台的紀錄停在剛剛那版，下一輪會像一般的新版本一樣把合併結果載入。
    const previous = base ? await drive.previousRevision(fileId, file.headRevisionId).catch(() => null) : null;
    if (previous && previous !== expected) {
      const theirs = await readZip(await drive.revisionData(fileId, previous));
      const merged = mergeNotebook(base, content, theirs).content;
      await drive.upload({ id: fileId, name: fileName(merged.name), blob: await packNotebook(merged) });
      schedule(id, 0);
    }
    set(id, 'idle');
  }

  const saved = (id, top, link) => db.update('notebooks', id, latest => latest?.drive && { ...latest, ...top, drive: { ...latest.drive, ...link, at: Date.now() } });

  return { status, schedule, sync };
}
