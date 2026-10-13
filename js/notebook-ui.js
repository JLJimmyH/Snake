import { db, uid, newNotebook, readNotebook, addNotebook, replaceNotebook, deleteNotebook } from './db.js';
import { packNotebook, unpackNotebook, readZip, toFile, fromFile, snapshot, sameSnapshot, mergeNotebook, cleanName, fileName, nameFromFile } from './notebook-core.js';
import { DriveClient, loadGoogleIdentity } from './drive.js';
import { createDriveSync, driveDirty } from './drive-sync.js';
import { GOOGLE_DRIVE_CLIENT_ID } from './drive-config.js';
import { setupShare } from './share-ui.js';
import { localSupported, createLocalSync, localDirty, handleOf, setHandle, dropHandle, pickSave, pickOpen, allowWrite } from './local-file.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const unsaved = nb => driveDirty(nb) || localDirty(nb);
const byCreated = (a, b) => a.created - b.created;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
const TROUBLE = ['paused', 'conflict', 'missing', 'error'];
const DRIVE_TROUBLE = ['conflict', 'missing', 'account', 'error'];
const CHECK_EVERY = 60000;
const GOOGLE_RESULT = { denied: '已取消 Google 授權', error: 'Google 授權失敗，請再試一次', scope: '要勾選「Drive 檔案」權限才能同步，請再連線一次' };

// 筆記本：選單（切換、新增、開啟、重新命名、關閉）＋「儲存與同步」視窗（Drive、本機檔案、副本）＋頂列的儲存按鈕。
// persist：把畫布存進 IndexedDB 但不結束文字編輯（背景自動同步用）；flush：連編輯中的文字框一起存（使用者按下動作時用）
// idle：使用者現在沒在畫、沒在打字，可以換掉畫布內容；refresh：筆記本內容被同步換掉後，重新載入頁面樹與目前這頁
export function setupNotebooks({ current, switchTo, create, flush, persist, idle, refresh, showMenu, toast }) {
  const drive = new DriveClient(GOOGLE_DRIVE_CLIENT_ID);
  if (GOOGLE_DRIVE_CLIENT_ID) loadGoogleIdentity().catch(error => toast(error.message));
  const dialog = $('#drive-dialog');
  const syncDialog = $('#sync-dialog');
  const button = $('#sync-button');
  let busy = false;
  let resuming = true; // 載入時正在恢復 Google 連線
  let shown = null;    // 上次畫出來的目前筆記本；點擊當下要同步判斷（Google 登入視窗、檔案權限都要在點擊當下開）
  let checked = null;  // 已經檢查過本機檔案與 Drive 的筆記本 id
  let lastCheck = 0;

  const local = createLocalSync({ current, flush: persist, pack: packFile, load: loadLocal, onState: () => render() });
  const driveSync = createDriveSync({ drive, store: { read: readFile, merge }, onState: () => render(), toast });
  const share = setupShare({ drive, withDrive: (task, intent) => withDrive(task, intent), run: task => run(task), toast, switchTo });
  const trouble = nb => !!nb.local && TROUBLE.includes(local.status(nb.id).state) || !!nb.drive && DRIVE_TROUBLE.includes(driveSync.status(nb.id).state);

  async function render() {
    const id = current();
    const nb = id && await db.get('notebooks', id);
    if (!nb) return;
    shown = nb;
    $('#nb-name').textContent = nb.name;
    $('#nb-button').title = `${nb.name}：點一下切換筆記本`;
    $('#nb-dirty').hidden = !unsaved(nb);
    const warn = trouble(nb), linked = nb.drive || nb.local;
    const label = warn ? '同步需要處理' : !linked ? '儲存與同步（目前只存在這個瀏覽器）' : unsaved(nb) ? '儲存 (Ctrl+S)' : '已儲存';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.classList.toggle('on', !warn && unsaved(nb));
    button.classList.toggle('warn', warn);
    button.disabled = busy;
    if (syncDialog.open) renderSync(nb);
    // 打開或切換到有同步的筆記本：檔案或 Drive 在別處被改過就載入
    if (nb.id !== checked) {
      checked = nb.id;
      if (nb.local) local.check(nb.id);
      if (nb.drive && !resuming) driveSync.sync(nb.id);
    }
  }

  async function run(task) {
    if (busy) { toast('上一個動作還在進行中'); return; }
    busy = true; render();
    try { await task(); } catch (error) { toast(error.message || '操作失敗，本機筆記仍保留'); }
    finally { busy = false; render(); }
  }

  // Google 登入視窗必須在使用者點擊的當下開啟（在任何 await 之前）。
  // 網站有 Worker 時改成整頁跳到 Google 授權，回來後由 afterGoogle 接著做 intent 那件事。
  function withDrive(task, intent) {
    if (busy) { toast('上一個動作還在進行中'); return; }
    if (resuming && !drive.connected) { toast('正在連線 Google，請稍候'); return; }
    if (!drive.connected && drive.server) {
      run(async () => {
        await flush();
        try { sessionStorage.setItem('afterGoogle', JSON.stringify({ intent, notebook: current() })); } catch { /* ignore */ }
        await drive.connect();
      });
      return;
    }
    let connection = null;
    if (!drive.connected) {
      try { connection = drive.connect(); } catch (error) { toast(error.message); return; }
    }
    run(async () => { if (connection) await connection; await task(); });
  }

  async function pack(nb, name = nb.name) {
    await flush();
    return packNotebook({ name, ...await readNotebook(nb.id) });
  }

  // ---------- 同步共用：本機內容 ↔ 檔案內容（檔案 ID，見 notebook-core 的 toFile／fromFile）----------
  async function readFile(id) {
    await persist();
    const nb = await db.get('notebooks', id);
    return { nb, content: toFile({ name: nb.name, ...await readNotebook(id) }, nb.fileIds), changes: nb.changes };
  }

  async function packFile(id) {
    const { content } = await readFile(id);
    return { blob: await packNotebook(content), base: snapshot(content) };
  }

  // 這台裝置上其他筆記本用掉的頁面與圖片 ID
  async function usedIds(mine = { pages: [], blobs: new Map() }) {
    const used = new Set([...await db.keys('pages'), ...await db.keys('blobs')]);
    for (const page of mine.pages) used.delete(page.id);
    for (const id of mine.blobs.keys()) used.delete(id);
    return used;
  }

  // 用檔案內容取代這台的筆記本。使用者正在畫或打字、或期間有新的編輯就放棄，回傳 null（稍後再試）。
  // source：內容從哪裡來（'drive'／'local'），另一個同步的地方要跟著更新；patch(changes)：要一起寫進筆記本紀錄的欄位
  async function adopt(nb, content, source, patch = () => ({})) {
    if (!idle()) return null;
    const mine = await readNotebook(nb.id);
    const { content: next, ids } = fromFile(content, nb.fileIds, await usedIds(mine));
    // 展開狀態與畫面位置是各台裝置自己的
    const open = new Map(mine.pages.map(p => [p.id, p.open])), views = new Map(mine.docs.map(d => [d.pageId, d.view]));
    next.pages = next.pages.map(p => open.has(p.id) ? { ...p, open: open.get(p.id) } : p);
    next.docs = next.docs.map(d => views.has(d.pageId) ? { ...d, view: views.get(d.pageId) } : d);
    const changes = nb.changes + 1;
    const record = { ...nb, ...patch(changes), name: content.name, fileIds: ids, changes, lastPage: next.pages.some(p => p.id === nb.lastPage) ? nb.lastPage : null };
    if (!idle() || !await replaceNotebook(record, next, nb.changes)) return null;
    await refresh(nb.id);
    if (record.local && source !== 'local') local.schedule();
    if (record.drive && source !== 'drive') driveSync.schedule(nb.id);
    return record;
  }

  // 把另一邊（Drive 或本機檔案）的內容合併進這台：這台沒有變更就直接用另一邊的；
  // 兩邊都改過就以頁為單位合併，要有上次同步的快照 base，沒有就回傳 'conflict' 讓使用者選。
  // 回傳 { content（合併結果，檔案 ID）, changes, applied（這台的內容有沒有換）, conflicts }，或 'busy'、'conflict'
  async function merge(id, theirs, { base, dirty, takeTheirs = false, source = 'drive', patch }) {
    const { nb, content: mine, changes } = await readFile(id);
    let content = theirs, conflicts = 0;
    if (!takeTheirs && dirty(nb)) {
      if (!base) return 'conflict';
      ({ content, conflicts } = mergeNotebook(base, mine, theirs));
    }
    if (sameSnapshot(snapshot(content), snapshot(mine))) return { content, changes, applied: false, conflicts };
    const record = await adopt(nb, content, source, patch);
    return record ? { content, changes: record.changes, applied: true, conflicts } : 'busy';
  }

  // 檔案內容 → 一本新的筆記本（保留檔案 ID，撞到這台其他筆記本的才換）
  async function addFromFile(theirs, link) {
    const id = uid();
    const { content, ids } = fromFile(theirs, {}, await usedIds());
    await addNotebook(newNotebook(id, theirs.name, { fileIds: ids, ...link }), content);
    return id;
  }

  // ---------- Google Drive ----------
  // 第一次存到 Drive（或原本的檔案不見了）：在 SnakeNote 資料夾建立新檔，之後自動同步
  const link = () => withDrive(async () => {
    const id = current();
    const { content, changes } = await readFile(id);
    toast('正在儲存到 Drive…');
    const file = await drive.upload({ name: fileName(content.name), blob: await packNotebook(content) });
    const account = drive.account;
    await db.update('notebooks', id, latest => latest && { ...latest, savedChanges: changes,
      drive: { accountId: account.id, email: account.email, fileId: file.id, revision: file.headRevisionId, base: snapshot(content), at: Date.now() } });
    driveSync.sync(id);
    toast(`已儲存到 ${account.email} 的 Drive，之後的變更會自動同步`);
  }, 'link');

  // 立即同步（頂列按鈕、Ctrl+S、視窗裡的按鈕）；force 見 drive-sync
  const syncNow = (force = null) => withDrive(async () => {
    const id = current();
    await flush();
    await driveSync.sync(id, { force });
    const { state, message } = driveSync.status(id);
    if (state === 'idle') toast(`已和 ${drive.account.email} 的 Drive 同步`);
    else if (message) toast(message);
  }, 'sync');

  const takeDrive = () => {
    if (!confirm(`會用 Drive 上的內容取代這台裝置上的「${shown.name}」，這台還沒同步的變更會消失。\n\n確定要載入嗎？`)) return;
    syncNow('remote');
  };

  // 另存副本：在 Drive 建立新檔當備份，目前的筆記本仍對應原本的檔案
  const saveCopy = () => withDrive(async () => {
    const nb = await db.get('notebooks', current());
    const name = prompt('副本名稱（會在 Drive 建立新檔案；目前的筆記本不受影響）', `${nb.name} 備份 ${today()}`);
    if (name === null) return;
    toast('正在上傳副本到 Drive…');
    await drive.upload({ name: fileName(name), blob: await pack(nb, name) });
    toast(`已在 ${drive.account.email} 的 Drive 建立「${cleanName(name)}」`);
  }, 'copy');

  const openDrive = () => withDrive(async () => {
    $('#drive-account').textContent = `已連結：${drive.account.email}`;
    const list = $('#drive-files');
    list.replaceChildren(el('p', '讀取中…', 'drive-muted'));
    dialog.showModal();
    let files;
    try { files = await drive.list(); }
    catch (error) { list.replaceChildren(el('p', error.message, 'drive-muted')); return; }
    const open = await db.getAll('notebooks');
    list.replaceChildren();
    if (!files.length) list.append(el('p', '這個帳號 Drive 的 SnakeNote 資料夾還沒有筆記本。先用「存到 Drive」儲存一本吧。', 'drive-muted'));
    for (const file of files) {
      const row = el('div', undefined, 'drive-file');
      const info = el('div');
      const opened = open.some(nb => nb.drive?.fileId === file.id && nb.drive.accountId === drive.account.id);
      info.append(el('strong', nameFromFile(file.name)), el('small', `${new Date(file.modifiedTime).toLocaleString()} · ${size(Number(file.size ?? 0))}${opened ? ' · 已開啟' : ''}`));
      const button = el('button', opened ? '切換' : '開啟', 'chip');
      button.onclick = () => run(() => openFile(file));
      row.append(info, button);
      list.append(row);
    }
  }, 'open');

  async function openFile(file) {
    const account = drive.account;
    const existing = (await db.getAll('notebooks')).find(nb => nb.drive?.fileId === file.id && nb.drive.accountId === account.id);
    if (existing) { dialog.close(); await switchTo(existing.id); return; }
    toast('正在從 Drive 下載…');
    const { file: meta, data } = await drive.download(file.id);
    const theirs = { ...await readZip(data), name: nameFromFile(meta.name) };
    const id = await addFromFile(theirs, {
      drive: { accountId: account.id, email: account.email, fileId: meta.id, revision: meta.headRevisionId, base: snapshot(theirs), at: Date.now() },
    });
    dialog.close();
    await switchTo(id);
    toast(`已開啟「${theirs.name}」，之後的變更會自動同步`);
  }

  function disconnect() {
    drive.disconnect(); dialog.close(); render();
    if (shown?.drive) driveSync.sync(shown.id);  // 顯示「要連線 Google」
    toast('已中斷 Google 連線，本機與 Drive 上的筆記本都會保留');
  }

  // 載入時恢復 Google 連線（網站有 Worker 才做得到）；剛從 Google 授權回來就接著做原本要做的事
  async function afterGoogle() {
    const result = /^#google=(\w+)$/.exec(location.hash)?.[1];
    if (result) history.replaceState(null, '', location.pathname + location.search);
    if (GOOGLE_RESULT[result]) toast(GOOGLE_RESULT[result]);
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('afterGoogle')); sessionStorage.removeItem('afterGoogle'); } catch { /* ignore */ }
    const ok = await drive.resume();
    resuming = false;
    await render();
    if (!ok) { if (shown?.drive) driveSync.sync(shown.id); return; }  // 顯示「要連線 Google」
    if (result === 'ok') toast(`已連線 ${drive.account.email} 的 Google Drive`);
    if (pending?.notebook === current()) {
      if (pending.intent === 'link' && !shown?.drive) return link();
      if (pending.intent === 'open') return openDrive();
      if (pending.intent === 'copy') return saveCopy();
    }
    if (pending?.intent) share.resume(pending.intent);
    if (shown?.drive) driveSync.sync(shown.id);
  }

  // ---------- 本機檔案 ----------
  // 同一個檔案只能對應一本筆記本
  async function linkedTo(handle, except = null) {
    for (const nb of await db.getAll('notebooks')) {
      if (!nb.local || nb.id === except) continue;
      const other = await handleOf(nb.id);
      if (other && await other.isSameEntry(handle)) return nb;
    }
    return null;
  }

  // 選擇（或重新選擇）要同步的檔案，馬上寫一次
  const linkLocal = () => {
    const nb = shown;
    run(async () => {
      const handle = await pickSave(fileName(nb.name));
      if (!handle) return;
      const other = await linkedTo(handle, nb.id);
      if (other) throw new Error(`「${other.name}」已經同步到這個檔案，請換一個檔名`);
      await setHandle(nb.id, handle);
      await db.update('notebooks', nb.id, latest => latest && { ...latest, local: { fileName: handle.name, lastModified: null, savedChanges: null, at: null } });
      await local.sync(nb.id, { force: true });
      if (local.status(nb.id).state === 'idle') toast(`已同步到「${handle.name}」，之後的變更會自動存進去`);
    });
  };

  const unlinkLocal = () => run(async () => {
    const id = current();
    await dropHandle(id);
    await db.update('notebooks', id, latest => latest && { ...latest, local: null });
    toast('已停止同步到本機檔案，檔案本身保留');
  });

  // 開啟本機的 zip：支援的瀏覽器會一直同步回這個檔案；不支援的只能匯入一份複本
  const openLocal = () => {
    if (!localSupported) { $('#nb-import').click(); return; }
    run(async () => {
      const handle = await pickOpen();
      if (!handle) return;
      const other = await linkedTo(handle);
      if (other) { await switchTo(other.id); return; }
      const file = await handle.getFile();
      const theirs = { ...await readZip(file), name: nameFromFile(file.name) };
      const id = await addFromFile(theirs, { local: { fileName: file.name, lastModified: file.lastModified, savedChanges: 0, at: Date.now(), base: snapshot(theirs) } });
      await setHandle(id, handle);
      await allowWrite(handle);
      await switchTo(id);
      toast(`已開啟「${nameFromFile(file.name)}」，之後的變更會自動存回這個檔案`);
    });
  };

  // 本機檔案在別處被改過（例如雲端硬碟從另一台電腦同步過來）：合併進這台。
  // 回傳 'loaded'（檔案就是合併結果）、'write'（合併結果要寫回檔案）、'busy' 或 'conflict'
  async function loadLocal(nb, file, takeTheirs = false) {
    const theirs = await readZip(file);
    const base = snapshot(theirs), mark = { lastModified: file.lastModified, base, at: Date.now() };
    const result = await merge(nb.id, theirs, { base: nb.local.base, dirty: localDirty, takeTheirs, source: 'local' });
    if (typeof result === 'string') return result;
    const clean = sameSnapshot(snapshot(result.content), base);
    await db.update('notebooks', nb.id, latest => latest?.local && { ...latest, local: { ...latest.local, ...mark, savedChanges: clean ? result.changes : latest.local.savedChanges } });
    if (result.conflicts) toast(`有 ${result.conflicts} 頁在兩邊都改過，檔案裡的版本存成「（衝突副本）」頁面`);
    else if (result.applied) toast(`已載入「${file.name}」的最新內容`);
    return clean ? 'loaded' : 'write';
  }

  const takeLocal = () => run(async () => {
    const nb = await db.get('notebooks', current());
    if (!confirm(`會用「${nb.local.fileName}」的內容取代這台裝置上的「${nb.name}」，這台還沒存進檔案的變更會消失。\n\n確定要載入嗎？`)) return;
    const handle = await handleOf(nb.id);
    if (await loadLocal(nb, await handle.getFile(), true) === 'busy') toast('正在編輯，請稍後再試');
    local.check(nb.id);
  });

  const exportZip = () => run(async () => {
    const nb = await db.get('notebooks', current());
    const url = URL.createObjectURL(await pack(nb));
    const link = el('a');
    link.href = url; link.download = fileName(nb.name).replace(/[\\/:*?"<>|]/g, '_');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  $('#nb-import').addEventListener('change', event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    run(async () => {
      const content = await unpackNotebook(file);
      const id = uid();
      await addNotebook(newNotebook(id, nameFromFile(file.name)), content);
      await switchTo(id);
      toast(`已匯入「${nameFromFile(file.name)}」（只存在這個瀏覽器）`);
    });
  });

  // ---------- 儲存與同步視窗 ----------
  function place(section, title, status, actions) {
    const row = el('div', undefined, 'sync-actions');
    for (const a of actions) {
      const b = el('button', a.label, a.primary ? 'collab-primary' : 'chip');
      b.addEventListener('click', a.run);
      row.append(b);
    }
    section.replaceChildren(el('h3', title), el('p', status, 'sync-status'), row);
  }

  function renderSync(nb) {
    $('#sync-name').textContent = nb.name;
    $('#sync-warn').hidden = !!(nb.drive || nb.local);
    if (!nb.drive) place($('#sync-drive'), '☁ Google Drive', '未連結', [{ label: '存到 Drive', primary: true, run: link }]);
    else {
      const { state, message } = driveSync.status(nb.id), email = nb.drive.email;
      const [status, actions] = {
        saving: [`${email} · 同步中…`, []],
        paused: [`${email} · 要連線 Google 才能自動同步`, [{ label: '連線 Google', primary: true, run: () => syncNow() }]],
        conflict: [`${email} · ⚠ Drive 上的檔案被別台裝置改過，這台也有變更`, [{ label: '用這台覆蓋', primary: true, run: () => syncNow('local') }, { label: '載入 Drive 的內容', run: takeDrive }]],
        missing: [`${email} · ⚠ ${message}`, [{ label: '重新存到 Drive', primary: true, run: link }]],
        account: [`⚠ ${message}`, []],
        error: [`${email} · ⚠ ${message}`, [{ label: '重試', primary: true, run: () => syncNow() }]],
      }[state] ?? [`${email} · ${driveDirty(nb) ? '等待同步…' : nb.drive.at ? `${clock(nb.drive.at)} 已自動同步` : '已同步'}`, [{ label: '立即同步', run: () => syncNow() }]];
      place($('#sync-drive'), '☁ Google Drive', status, actions);
    }

    $('#sync-local').hidden = !localSupported;
    if (localSupported) {
      if (!nb.local) place($('#sync-local'), '💾 本機檔案', '未連結', [{ label: '選擇檔案…', primary: true, run: linkLocal }]);
      else {
        const { state, message } = local.status(nb.id), name = nb.local.fileName;
        const stop = { label: '停止同步', run: unlinkLocal };
        const [status, actions] = {
          saving: [`${name} · 同步中…`, []],
          paused: [`${name} · ⚠ 要允許存取檔案才能繼續`, [{ label: '繼續同步', primary: true, run: () => local.check(nb.id, { ask: true }) }]],
          conflict: [`${name} · ⚠ 檔案在別處被改過，這台也有變更`, [{ label: '用這台覆蓋', primary: true, run: () => local.sync(nb.id, { force: true, ask: true }) }, { label: '載入檔案內容', run: takeLocal }]],
          missing: [`${name} · ⚠ 找不到檔案`, [{ label: '重新選擇…', primary: true, run: linkLocal }]],
          error: [`${name} · ⚠ ${message}`, [{ label: '重試', primary: true, run: () => local.sync(nb.id, { force: true, ask: true }) }]],
        }[state] ?? [`${name} · ${localDirty(nb) ? '等待同步…' : nb.local.at ? `${clock(nb.local.at)} 已自動同步` : '已同步'}`, []];
        place($('#sync-local'), '💾 本機檔案', status, [...actions, stop]);
      }
    }

    const links = $('#sync-links');
    const copy = el('button', '另存副本到 Drive', 'link-btn'), zip = el('button', '下載 zip', 'link-btn');
    copy.addEventListener('click', saveCopy);
    zip.addEventListener('click', exportZip);
    links.replaceChildren(copy, ' · ', zip);
    const foot = $('#sync-foot'), privacy = el('a', '隱私權政策');
    privacy.href = 'privacy.html'; privacy.target = '_blank'; privacy.rel = 'noopener';
    if (drive.connected) {
      const off = el('button', `中斷 Google 連線（${drive.account.email}）`, 'link-btn');
      off.addEventListener('click', () => { syncDialog.close(); disconnect(); });
      foot.replaceChildren(off, ' · ', privacy);
    } else foot.replaceChildren(privacy);
  }

  function openSync() {
    if (!shown) return;
    renderSync(shown);
    if (!syncDialog.open) syncDialog.showModal();
  }

  // 頂列按鈕和 Ctrl+S：有變更就存到所有連結的地方；有狀況要處理或還沒連結任何地方就打開視窗
  function saveAll(always) {
    const nb = shown;
    if (!nb) return;
    if (trouble(nb) || !(nb.drive || nb.local) || (!always && !unsaved(nb))) { openSync(); return; }
    if (nb.local) local.sync(nb.id, { ask: true });
    if (nb.drive && (always || driveDirty(nb) || !drive.connected)) syncNow();
  }

  // ---------- 選單 ----------
  const addNew = () => run(async () => {
    const name = prompt('新筆記本名稱', '未命名筆記本');
    if (name === null) return;
    await switchTo(await create(name));
  });

  const rename = () => run(async () => {
    const nb = await db.get('notebooks', current());
    const name = prompt('筆記本名稱（存到 Drive 時也會更新檔名）', nb.name);
    if (name === null || cleanName(name) === nb.name) return;
    await db.update('notebooks', nb.id, latest => latest && { ...latest, name: cleanName(name), changes: latest.changes + 1 });
    render();
  });

  const close = () => run(async () => {
    await flush();
    let nb = await db.get('notebooks', current());
    if (localDirty(nb)) { await local.sync(nb.id); nb = await db.get('notebooks', nb.id); }
    if (driveDirty(nb) && drive.connected) { await driveSync.sync(nb.id); nb = await db.get('notebooks', nb.id); }
    const places = [nb.drive && 'Drive', nb.local && '本機檔案'].filter(Boolean).join('、');
    const warning = !places
      ? `「${nb.name}」只存在這個瀏覽器，關閉後會永久刪除。\n\n建議先存到 Drive 或下載 zip。確定要刪除並關閉嗎？`
      : unsaved(nb) ? `「${nb.name}」有變更還沒存到${places}，關閉後這些變更會消失。\n\n確定要關閉嗎？` : null;
    if (warning && !confirm(warning)) return;
    const next = (await db.getAll('notebooks')).filter(other => other.id !== nb.id).sort(byCreated)[0];
    await switchTo(next?.id ?? await create('未命名筆記本'));
    await deleteNotebook(nb.id);
    await dropHandle(nb.id);
    toast(`已關閉「${nb.name}」`);
  });

  const icons = nb => (nb.drive ? '☁' : '') + (nb.local ? '💾' : '') + (unsaved(nb) ? '•' : '');

  async function openMenu() {
    const rect = $('#nb-button').getBoundingClientRect();
    const list = (await db.getAll('notebooks')).sort(byCreated);
    showMenu(rect, [
      ...list.map(nb => ({ label: `${nb.id === current() ? '✓' : '　'} ${nb.name}`, hint: icons(nb), run: () => nb.id !== current() && run(() => switchTo(nb.id)) })),
      { sep: true },
      { label: '＋ 新增筆記本', run: addNew },
      { label: '📂 開啟…', run: () => showMenu(rect, [
        { head: '開啟' },
        { label: '☁ Google Drive…', run: openDrive },
        { label: localSupported ? '💾 本機檔案…' : '💾 匯入 zip…', run: openLocal },
      ]) },
      { sep: true },
      ...(share.ready() ? [{ label: '👥 共用頁面…', run: share.showShared }] : []),
      { label: '⇅ 儲存與同步…', run: openSync },
      { label: '✎ 重新命名', run: rename },
      { label: '✕ 關閉筆記本', danger: true, run: close },
    ]);
  }

  $('#nb-button').addEventListener('click', openMenu);
  button.addEventListener('click', () => saveAll(false));
  $('#sync-close').addEventListener('click', () => syncDialog.close());
  $('#drive-close').addEventListener('click', () => dialog.close());
  $('#drive-disconnect').addEventListener('click', disconnect);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveAll(true); }
  });
  // 離開分頁前把變更寫進檔案和 Drive；回到分頁（切回來或視窗拿到焦點）時看看別處有沒有改過
  function back() {
    if (!shown || busy || document.hidden || Date.now() - lastCheck < 5000) return;
    lastCheck = Date.now();
    if (shown.local) local.check(shown.id);
    if (shown.drive && !resuming) driveSync.sync(shown.id);
  }
  document.addEventListener('visibilitychange', () => {
    if (!shown || busy) return;
    if (!document.hidden) { back(); return; }
    if (shown.local) local.sync(shown.id);
    if (shown.drive && driveDirty(shown)) driveSync.sync(shown.id);
  });
  window.addEventListener('focus', back);
  // 開著的時候每分鐘看一次 Drive 上有沒有別台裝置存的新版本（只讀檔案資訊，很便宜）
  setInterval(() => {
    if (shown?.drive && !busy && !resuming && !document.hidden && drive.connected) driveSync.sync(shown.id);
  }, CHECK_EVERY);

  // 內容有變更（main.js 的 markChanged 之後）
  async function changed() {
    await render();
    if (shown?.local) local.schedule();
    if (shown?.drive) driveSync.schedule(shown.id);
  }

  afterGoogle();

  return { render, changed, sharePage: share.sharePage, drivePage: share.drivePage, liveReady: share.liveReady, shareReady: share.ready };
}
