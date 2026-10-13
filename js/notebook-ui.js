import { db, uid, newNotebook, readNotebook, addNotebook, replaceNotebook, deleteNotebook, pagesOf } from './db.js';
import { packNotebook, unpackNotebook, readZip, toFile, fromFile, snapshot, sameSnapshot, mergeNotebook, cleanName, fileName, nameFromFile } from './notebook-core.js';
import { DriveClient, loadGoogleIdentity } from './drive.js';
import { createDriveSync, driveDirty } from './drive-sync.js';
import { GOOGLE_DRIVE_CLIENT_ID } from './drive-config.js';
import { setupShare } from './share-ui.js';
import { setupLibrary } from './library.js';
import { localSupported, createLocalSync, localDirty, handleOf, setHandle, dropHandle, pickSave, pickOpen, allowWrite } from './local-file.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const unsaved = nb => driveDirty(nb) || localDirty(nb);
const byCreated = (a, b) => a.created - b.created;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const TROUBLE = ['paused', 'conflict', 'missing', 'error'];
const DRIVE_TROUBLE = ['conflict', 'missing', 'account', 'error'];
const CHECK_EVERY = 60000;
const GOOGLE_RESULT = { denied: '已取消 Google 授權', error: 'Google 授權失敗，請再試一次', scope: '要勾選「Drive 檔案」權限才能同步，請再連線一次' };

// 筆記本：側欄上層的筆記本清單（js/library.js：切換、新增、從 Drive 開啟、重新命名、從這台移除）＋頂列的同步狀態
// 與「儲存位置」面板（Drive、進階裡的本機檔案與副本）＋新增筆記本視窗。
// persist：把畫布存進 IndexedDB 但不結束文字編輯（背景自動同步用）；flush：連編輯中的文字框一起存（使用者按下動作時用）
// idle：使用者現在沒在畫、沒在打字，可以換掉畫布內容；refresh：筆記本內容被同步換掉後，重新載入頁面樹與目前這頁
// showTab(name)：回到目前筆記本的側欄分頁（'pages'）；hideSidebar()：手機版收起側欄；onCloud()：Drive 的清單讀好了（頁面樹的共用人數）
export function setupNotebooks({ current, switchTo, create, flush, persist, idle, refresh, showMenu, toast, showTab, hideSidebar, onCloud }) {
  const drive = new DriveClient(GOOGLE_DRIVE_CLIENT_ID);
  if (GOOGLE_DRIVE_CLIENT_ID) loadGoogleIdentity().catch(error => toast(error.message));
  const panel = $('#sync-dialog');
  const button = $('#sync-button');
  let busy = false;
  let resuming = true; // 載入時正在恢復 Google 連線
  let shown = null;    // 上次畫出來的目前筆記本；點擊當下要同步判斷（Google 登入視窗、檔案權限都要在點擊當下開）
  let checked = null;  // 已經檢查過本機檔案與 Drive 的筆記本 id
  let lastCheck = 0;
  let who;             // 上次畫的時候連線的 Google 帳號：換了就重讀側欄的雲端清單

  const local = createLocalSync({ current, flush: persist, pack: packFile, load: loadLocal, onState: () => render() });
  const driveSync = createDriveSync({ drive, store: { read: readFile, merge }, onState: () => render(), toast });
  const share = setupShare({ drive, withDrive: (task, intent) => withDrive(task, intent), run: task => run(task), toast, switchTo, onChanged: () => library.refresh(true) });
  const trouble = nb => !!nb.local && TROUBLE.includes(local.status(nb.id).state) || !!nb.drive && DRIVE_TROUBLE.includes(driveSync.status(nb.id).state);
  const library = setupLibrary({
    drive, showMenu, toast, onCloud,
    showPages: () => showTab('pages'),
    connect: () => withDrive(() => library.refresh(true), 'account'),
    disconnect,
    notebooks: {
      list: async () => (await db.getAll('notebooks')).sort(byCreated),
      current, describe, resuming: () => resuming,
      open: id => id === current() ? Promise.resolve() : run(() => switchTo(id)),
      openCloud: file => withDrive(() => openFile(file), 'open'),
      more: notebookMenu, create: addNew, openLocal,
      localLabel: localSupported ? '開啟本機檔案…' : '匯入 zip…',
    },
    shares: {
      ready: () => share.ready(), list: () => share.list(), active: () => share.active(), pick: () => share.pickOther(),
      // 這台的筆記本裡連到共用檔案的頁面；清單上沒連到的可以直接停止共用
      linked: async () => new Set((await db.getAll('pages')).filter(p => p.shared).map(p => p.shared)),
      more: (rect, file, title) => showMenu(rect, [{ head: title }, { label: '停止共用…', danger: true, run: () => share.stopListed(file, title) }]),
      open: file => run(() => share.openShared(file)).then(hideSidebar),
    },
  });

  async function render() {
    const id = current();
    const nb = id && await db.get('notebooks', id);
    if (!nb) return;
    shown = nb;
    $('#nb-name').textContent = nb.name;
    $('#nb-button').title = `${nb.name}：點一下切換筆記本`;
    renderPill(nb);
    if (panel.matches(':popover-open')) renderSync(nb);
    const account = drive.connected ? drive.account.id : null;
    // 換了帳號（或剛連上）：重讀雲端清單；之前沒連線時刪掉的共用頁，現在停止共用
    if (account !== who && !resuming) { who = account; library.refresh(true); share.flushDeleted(); }
    else library.render();
    // 打開或切換到有同步的筆記本：檔案或 Drive 在別處被改過就載入
    if (nb.id !== checked) {
      checked = nb.id;
      if (nb.local) local.check(nb.id);
      if (nb.drive && !resuming) driveSync.sync(nb.id);
    }
  }

  // 頂列唯一的同步狀態：平常只有一朵雲；只在這台、沒連線、要處理時才有字
  function renderPill(nb) {
    const warn = trouble(nb), linked = nb.drive || nb.local;
    const drives = nb.drive ? driveSync.status(nb.id).state : null, files = nb.local ? local.status(nb.id).state : null;
    const paused = drives === 'paused', saving = drives === 'saving' || files === 'saving';
    const [label, text, tone] = warn ? ['同步需要處理', '需要處理', 'warn']
      : !linked ? ['只存在這個瀏覽器：點一下選擇儲存位置', '只在這台', 'local']
      : paused ? ['要連線 Google 才能同步到 Drive', '未連線', 'local']
      : saving ? ['同步中…', '', 'busy']
      : unsaved(nb) ? ['等待同步（Ctrl+S 立即同步）', '', 'busy']
      : ['已同步', '', 'ok'];
    const where = [nb.drive && `${nb.drive.email} 的 Google Drive${nb.drive.at ? `（${clock(nb.drive.at)}）` : ''}`, nb.local && `本機檔案「${nb.local.fileName}」`].filter(Boolean).join('、');
    button.setAttribute('aria-label', label);
    button.title = tone === 'ok' ? `已同步到 ${where}` : where && tone === 'busy' ? `${label}：${where}` : label;
    $('#sync-text').textContent = text;
    button.dataset.tone = tone;
    button.disabled = busy;
  }

  // 側欄清單上這本筆記本存在哪裡、同步得怎樣
  function describe(nb) {
    if (trouble(nb)) return { text: '⚠ 同步需要處理', warn: true };
    const parts = [];
    if (nb.drive) {
      const { state } = driveSync.status(nb.id);
      parts.push(state === 'saving' ? '☁ 同步中…' : state === 'paused' ? '☁ 要連線 Google' : driveDirty(nb) ? '☁ 等待同步' : '☁ 已同步');
    }
    if (nb.local) parts.push(local.status(nb.id).state === 'saving' ? '💾 寫入中…' : '💾 ' + nb.local.fileName);
    return parts.length ? { text: parts.join(' · '), warn: false } : { text: '只存在這個瀏覽器', warn: true };
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
    if (busy) { toast('上一個動作還在進行中'); return Promise.resolve(); }
    if (resuming && !drive.connected) { toast('正在連線 Google，請稍候'); return Promise.resolve(); }
    if (!drive.connected && drive.server) {
      return run(async () => {
        await flush();
        try { sessionStorage.setItem('afterGoogle', JSON.stringify({ intent, notebook: current() })); } catch { /* ignore */ }
        await drive.connect();
      });
    }
    let connection = null;
    if (!drive.connected) {
      try { connection = drive.connect(); } catch (error) { toast(error.message); return Promise.resolve(); }
    }
    return run(async () => { if (connection) await connection; await task(); });
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
  // 第一次存到 Drive（或原本的檔案不見了）：在 SnakeNote 資料夾建立新檔，之後自動同步。drive 要已經連線
  async function upload(id) {
    const { content, changes } = await readFile(id);
    toast('正在儲存到 Drive…');
    const file = await drive.upload({ name: fileName(content.name), blob: await packNotebook(content) });
    const account = drive.account;
    await db.update('notebooks', id, latest => latest && { ...latest, savedChanges: changes,
      drive: { accountId: account.id, email: account.email, fileId: file.id, revision: file.headRevisionId, base: snapshot(content), at: Date.now() } });
    driveSync.sync(id);
    library.refresh(true);
    toast(`已儲存到 ${account.email} 的 Drive，之後的變更會自動同步`);
  }
  const link = () => withDrive(() => upload(current()), 'link');

  // 立即同步（Ctrl+S、面板裡的按鈕）；force 見 drive-sync
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

  // 這本存在另一個 Google 帳號的 Drive：換成那個帳號連線（Google 會讓使用者選帳號）
  const switchAccount = () => { drive.disconnect(); render(); syncNow(); };

  // 另存一份新筆記本：在這台建立一本副本（新的頁面 ID），原本這本存在 Drive 的話副本也存一份到同一個 Drive。
  // 副本是一本獨立的筆記本，會出現在側欄清單裡，不會跟原本那本混在一起
  const duplicate = () => run(async () => {
    const nb = await db.get('notebooks', current());
    const name = prompt('副本名稱（會建立一本新的筆記本，原本的不受影響）', `${nb.name} 副本 ${today()}`);
    if (name === null) return;
    const { content } = await readFile(nb.id);
    const id = await addFromFile({ ...content, name: cleanName(name) }, {});
    if (nb.drive && drive.connected && nb.drive.accountId === drive.account.id) {
      await upload(id);
      toast(`已建立「${cleanName(name)}」，也存了一份到 ${drive.account.email} 的 Drive`);
    } else toast(`已建立「${cleanName(name)}」（只存在這個瀏覽器）`);
    library.refresh(true);
  });

  async function openFile(file) {
    const account = drive.account;
    const existing = (await db.getAll('notebooks')).find(nb => nb.drive?.fileId === file.id && nb.drive.accountId === account.id);
    if (existing) { await switchTo(existing.id); return; }
    toast('正在從 Drive 下載…');
    const { file: meta, data } = await drive.download(file.id);
    const theirs = { ...await readZip(data), name: nameFromFile(meta.name) };
    const id = await addFromFile(theirs, {
      drive: { accountId: account.id, email: account.email, fileId: meta.id, revision: meta.headRevisionId, base: snapshot(theirs), at: Date.now() },
    });
    await switchTo(id);
    toast(`已開啟「${theirs.name}」，之後的變更會自動同步`);
  }

  function disconnect() {
    drive.disconnect(); render();
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
    if (pending?.intent?.startsWith('new:')) return run(() => createIn(pending.intent.slice(4), true));
    if (pending?.notebook === current()) {
      if (pending.intent === 'link' && !shown?.drive) return link();
      if (pending.intent === 'copy') return duplicate();
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
  function openLocal() {
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
    }).then(() => showTab('pages'));
  }

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

  const exportZip = (id = current()) => run(async () => {
    const nb = await db.get('notebooks', id);
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
    }).then(() => showTab('pages'));
  });

  // ---------- 儲存位置面板（頂列的同步狀態打開，popover）----------
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
    if (!nb.drive) place($('#sync-drive'), '☁ Google Drive', '未連結：存到 Drive 後會自動同步，換裝置也打得開', [{ label: '存到 Drive', primary: true, run: link }]);
    else {
      const { state, message } = driveSync.status(nb.id), email = nb.drive.email;
      const [status, actions] = {
        saving: [`${email} · 同步中…`, []],
        paused: [`${email} · 要連線 Google 才能自動同步`, [{ label: '連線 Google', primary: true, run: () => syncNow() }]],
        conflict: [`${email} · ⚠ Drive 上的檔案被別台裝置改過，這台也有變更`, [{ label: '用這台覆蓋', primary: true, run: () => syncNow('local') }, { label: '載入 Drive 的內容', run: takeDrive }]],
        missing: [`${email} · ⚠ ${message}`, [{ label: '重新存到 Drive', primary: true, run: link }]],
        account: [`⚠ ${message}`, [{ label: `改用 ${email} 連線`, primary: true, run: switchAccount }]],
        error: [`${email} · ⚠ ${message}`, [{ label: '重試', primary: true, run: () => syncNow() }]],
      }[state] ?? [`${email} · ${driveDirty(nb) ? '等待同步…' : nb.drive.at ? `${clock(nb.drive.at)} 已自動同步` : '已同步'}`, [{ label: '立即同步', run: () => syncNow() }]];
      place($('#sync-drive'), '☁ Google Drive', status, actions);
    }

    // 進階：本機檔案同步、副本、zip。有連結本機檔案就展開，不然收著
    const more = $('#sync-more');
    if (nb.local) more.open = true;
    $('#sync-local').hidden = !localSupported;
    if (localSupported) {
      if (!nb.local) place($('#sync-local'), '💾 同時存到本機檔案', '未連結：電腦上的一個 zip 檔，之後的變更會自動寫進去', [{ label: '選擇檔案…', primary: true, run: linkLocal }]);
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

    const copy = el('button', '另存一份新筆記本', 'link-btn'), zip = el('button', '下載 zip', 'link-btn');
    copy.addEventListener('click', duplicate);
    zip.addEventListener('click', () => exportZip());
    $('#sync-links').replaceChildren(copy, ' · ', zip);
  }

  // 頂列按鈕用 popovertarget 開關；打開前先畫好，打開後貼在按鈕下面
  panel.addEventListener('beforetoggle', event => { if (event.newState === 'open' && shown) renderSync(shown); });
  panel.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    const rect = button.getBoundingClientRect(), width = panel.offsetWidth;
    panel.style.left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)) + 'px';
    panel.style.top = rect.bottom + 6 + 'px';
  });
  button.setAttribute('popovertarget', 'sync-dialog');
  const openSync = () => { if (shown && !panel.matches(':popover-open')) panel.showPopover(); };

  // Ctrl+S：存到所有連結的地方；有狀況要處理或還沒連結任何地方就打開面板
  function saveAll() {
    const nb = shown;
    if (!nb) return;
    if (trouble(nb) || !(nb.drive || nb.local)) { openSync(); return; }
    if (nb.local) local.sync(nb.id, { ask: true });
    if (nb.drive) syncNow();
  }

  // ---------- 新增筆記本 ----------
  const newDialog = $('#new-dialog'), newForm = $('#new-form'), newName = $('#new-name');
  function addNew() {
    newName.value = '未命名筆記本';
    newForm.elements.where.value = 'drive';
    newDialog.showModal();
    newName.select();
  }
  // 存到 Drive：Google 登入要在點「建立」的當下開（網站有 Worker 時跳去授權，回來後 afterGoogle 接著建立）
  newForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = cleanName(newName.value), cloud = newForm.elements.where.value === 'drive';
    newDialog.close();
    if (cloud) withDrive(() => createIn(name, true), 'new:' + name);
    else run(() => createIn(name, false));
  });
  for (const id of ['#new-close', '#new-cancel']) $(id).addEventListener('click', () => newDialog.close());
  async function createIn(name, cloud) {
    const id = await create(name);
    await switchTo(id);
    showTab('pages');
    if (cloud) await upload(id);
  }

  // ---------- 側欄清單上每本筆記本的動作 ----------
  const rename = id => run(async () => {
    const nb = await db.get('notebooks', id);
    const name = prompt('筆記本名稱（存到 Drive 時也會更新檔名）', nb.name);
    if (name === null || cleanName(name) === nb.name) return;
    await db.update('notebooks', id, latest => latest && { ...latest, name: cleanName(name), changes: latest.changes + 1 });
    if (id === current()) { if (nb.local) local.schedule(); }
    if (nb.drive) driveSync.schedule(id);
  });

  // 從這台移除：先把還沒同步的變更存出去；只存在這台的就是刪除，要講清楚
  const remove = id => run(async () => {
    await flush();
    let nb = await db.get('notebooks', id);
    if (localDirty(nb)) { await local.sync(id); nb = await db.get('notebooks', id); }
    if (driveDirty(nb) && drive.connected) { await driveSync.sync(id); nb = await db.get('notebooks', id); }
    const places = [nb.drive && 'Drive', nb.local && '本機檔案'].filter(Boolean).join('、');
    const pages = (await pagesOf(id)).length;
    const warning = !places
      ? `「${nb.name}」（${pages} 頁）只存在這個瀏覽器，刪除後就找不回來了。\n\n建議先存到 Drive 或下載 zip。確定要刪除嗎？`
      : unsaved(nb) ? `「${nb.name}」有變更還沒存到${places}，從這台移除後這些變更會消失。\n\n確定要移除嗎？` : null;
    if (warning && !confirm(warning)) return;
    if (id === current()) {
      const next = (await db.getAll('notebooks')).filter(other => other.id !== id).sort(byCreated)[0];
      await switchTo(next?.id ?? await create('未命名筆記本'));
    }
    await deleteNotebook(id);
    await dropHandle(id);
    const kept = [nb.drive && 'Drive 上的檔案', nb.local && `本機檔案「${nb.local.fileName}」`].filter(Boolean).join('、');
    toast(places ? `已從這台移除「${nb.name}」，${kept}保留` : `已刪除「${nb.name}」`);
  });

  async function notebookMenu(rect, id) {
    const nb = await db.get('notebooks', id);
    if (!nb) return;
    const linked = nb.drive || nb.local;
    showMenu(rect, [
      { head: nb.name },
      { label: '✎ 重新命名', run: () => rename(id) },
      { label: '⇅ 儲存位置…', run: () => (id === current() ? Promise.resolve() : run(() => switchTo(id))).then(render).then(openSync) },
      { label: '⬇ 下載 zip', run: () => exportZip(id) },
      ...(nb.drive ? [{ label: '↗ 在 Google Drive 中顯示', run: () => window.open(`https://drive.google.com/file/d/${encodeURIComponent(nb.drive.fileId)}/view`, '_blank', 'noopener') }] : []),
      { sep: true },
      { label: linked ? '從這台移除' : '刪除筆記本', danger: true, run: () => remove(id) },
    ]);
  }

  $('#sync-close').addEventListener('click', () => panel.hidePopover());
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveAll(); }
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

  return {
    render, changed,
    sharePage: share.sharePage, shareCurrent: share.shareCurrent, drivePage: share.drivePage, shareReady: share.ready,
    unshareDeleted: share.unshareDeleted,
    owner: share.owner, people: library.people,
    // 即時協作準備好了：共用頁面清單要等它才能讀
    liveReady: handle => { share.liveReady(handle); library.refresh(); },
    // 側欄切到上層的筆記本清單
    showLibrary: library.shown,
  };
}
