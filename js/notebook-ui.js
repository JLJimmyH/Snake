import { db, uid, newNotebook, readNotebook, addNotebook, replaceNotebook, deleteNotebook } from './db.js';
import { packNotebook, unpackNotebook, cleanName, fileName, nameFromFile } from './notebook-core.js';
import { DriveClient, loadGoogleIdentity } from './drive.js';
import { GOOGLE_DRIVE_CLIENT_ID } from './drive-config.js';
import { localSupported, createLocalSync, localDirty, handleOf, setHandle, dropHandle, pickSave, pickOpen, allowWrite } from './local-file.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const dirty = nb => !!nb.drive && nb.changes !== nb.savedChanges;
const unsaved = nb => dirty(nb) || localDirty(nb);
const byCreated = (a, b) => a.created - b.created;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
const TROUBLE = ['paused', 'conflict', 'missing', 'error'];

// 筆記本：選單（切換、新增、開啟、重新命名、關閉）＋「儲存與同步」視窗（Drive、本機檔案、副本）＋頂列的儲存按鈕。
// persist：把畫布存進 IndexedDB 但不結束文字編輯（背景自動同步用）；flush：連編輯中的文字框一起存（使用者按下動作時用）
export function setupNotebooks({ current, switchTo, reload, create, flush, persist, showMenu, toast }) {
  const drive = new DriveClient(GOOGLE_DRIVE_CLIENT_ID);
  if (GOOGLE_DRIVE_CLIENT_ID) loadGoogleIdentity().catch(error => toast(error.message));
  const dialog = $('#drive-dialog');
  const syncDialog = $('#sync-dialog');
  const button = $('#sync-button');
  let busy = false;
  let shown = null;    // 上次畫出來的目前筆記本；點擊當下要同步判斷（Google 登入視窗、檔案權限都要在點擊當下開）
  let checked = null;  // 已經檢查過本機檔案的筆記本 id

  const contentOf = async nb => packNotebook({ name: nb.name, ...await readNotebook(nb.id) });
  const local = createLocalSync({ current, flush: persist, pack: contentOf, load: loadLocal, onState: () => render() });
  const trouble = nb => !!nb.local && TROUBLE.includes(local.status(nb.id).state);

  async function render() {
    const nb = await db.get('notebooks', current());
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
    // 打開或切換到有同步本機檔案的筆記本：檔案在別處被改過就載入
    if (nb.id !== checked) {
      checked = nb.id;
      if (nb.local) local.check(nb.id);
    }
  }

  async function run(task) {
    if (busy) { toast('上一個動作還在進行中'); return; }
    busy = true; render();
    try { await task(); } catch (error) { toast(error.message || '操作失敗，本機筆記仍保留'); }
    finally { busy = false; render(); }
  }

  // Google 登入視窗必須在使用者點擊的當下開啟（在任何 await 之前）
  function withDrive(task) {
    if (busy) { toast('上一個動作還在進行中'); return; }
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

  // ---------- Google Drive ----------
  // 這本筆記本在 Drive 上的檔案；帳號不符、已刪除或在垃圾桶都擋下
  async function remoteOf(nb) {
    if (nb.drive.accountId !== drive.account.id) throw new Error(`這本筆記本存在 ${nb.drive.email} 的 Drive；請先中斷 Google 連線，再用該帳號連線（目前是 ${drive.account.email}）`);
    let remote;
    try { remote = await drive.file(nb.drive.fileId); }
    catch (error) { throw error.status === 404 ? new Error('Drive 上的檔案已刪除或無法存取，請改用「另存副本到 Drive」') : error; }
    if (remote.trashed) throw new Error('Drive 上的檔案已移到垃圾桶，請先還原，或改用「另存副本到 Drive」');
    return remote;
  }

  const save = () => withDrive(async () => {
    await flush();
    const nb = await db.get('notebooks', current());
    if (nb.drive) {
      const remote = await remoteOf(nb);
      if (remote.headRevisionId !== nb.drive.revision && !confirm(`Drive 上的「${remote.name}」在這台裝置上次開啟或儲存後，已被其他裝置修改。\n\n覆蓋會以這台裝置的內容取代它（之後仍可在 Drive 的「管理版本」找回舊內容）。\n\n要覆蓋嗎？按「取消」後可用「從 Drive 同步」載入 Drive 上的內容，或「另存副本到 Drive」。`)) return;
    }
    const changes = nb.changes;
    toast('正在儲存到 Drive…');
    const file = await drive.upload({ id: nb.drive?.fileId, name: fileName(nb.name), blob: await pack(nb) });
    const account = drive.account;
    await db.update('notebooks', nb.id, latest => latest && { ...latest, savedChanges: changes, drive: { accountId: account.id, email: account.email, fileId: file.id, revision: file.headRevisionId } });
    toast(`已儲存到 ${account.email} 的 Drive`);
  });

  // 同步：Drive 上有其他裝置存的新內容，就下載下來取代這台裝置的內容
  const sync = () => withDrive(async () => {
    await flush();
    let nb = await db.get('notebooks', current());
    if (!nb.drive) throw new Error('這本筆記本還沒存到 Drive');
    const remote = await remoteOf(nb);
    if (remote.headRevisionId === nb.drive.revision) {
      toast(dirty(nb) ? '已是 Drive 上的最新內容（這台裝置有尚未儲存的變更）' : '已是最新內容');
      return;
    }
    toast('正在從 Drive 同步…');
    const { file: meta, data } = await drive.download(nb.drive.fileId);
    const content = await unpackNotebook(data);
    await flush();
    nb = await db.get('notebooks', nb.id);
    if (dirty(nb) && !confirm(`「${nb.name}」在這台裝置有尚未存到 Drive 的變更，同步會用 Drive 上的內容取代它們。\n\n確定要同步嗎？按「取消」可先「另存副本到 Drive」保留這些變更。`)) return;
    // 頁面 ID 每次開啟都會換新，用標題找回剛剛開著的那一頁
    const title = (await db.get('pages', nb.lastPage))?.title;
    const lastPage = content.pages.find(page => page.title === title)?.id ?? null;
    // 內容換成 Drive 的版本：同步的本機檔案也要跟著更新
    const changes = nb.changes + 1;
    await replaceNotebook({ ...nb, name: nameFromFile(meta.name), lastPage, changes, savedChanges: changes, drive: { ...nb.drive, revision: meta.headRevisionId } }, content);
    await reload(nb.id);
    if (nb.local) local.schedule(0);
    toast(`已同步 Drive 上最新的「${nameFromFile(meta.name)}」`);
  });

  // 另存副本：在 Drive 建立新檔當備份，目前的筆記本仍對應原本的檔案
  const saveCopy = () => withDrive(async () => {
    const nb = await db.get('notebooks', current());
    const name = prompt('副本名稱（會在 Drive 建立新檔案；目前的筆記本不受影響）', `${nb.name} 備份 ${today()}`);
    if (name === null) return;
    toast('正在上傳副本到 Drive…');
    await drive.upload({ name: fileName(name), blob: await pack(nb, name) });
    toast(`已在 ${drive.account.email} 的 Drive 建立「${cleanName(name)}」`);
  });

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
  });

  async function openFile(file) {
    const account = drive.account;
    const existing = (await db.getAll('notebooks')).find(nb => nb.drive?.fileId === file.id && nb.drive.accountId === account.id);
    if (existing) { dialog.close(); await switchTo(existing.id); return; }
    toast('正在從 Drive 下載…');
    const { file: meta, data } = await drive.download(file.id);
    const content = await unpackNotebook(data);
    const id = uid();
    await addNotebook(newNotebook(id, nameFromFile(meta.name), { drive: { accountId: account.id, email: account.email, fileId: meta.id, revision: meta.headRevisionId } }), content);
    dialog.close();
    await switchTo(id);
    toast(`已開啟「${nameFromFile(meta.name)}」`);
  }

  function disconnect() {
    drive.disconnect(); dialog.close(); render();
    toast('已中斷 Google 連線，本機與 Drive 上的筆記本都會保留');
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
      const content = await unpackNotebook(file);
      const id = uid();
      await addNotebook(newNotebook(id, nameFromFile(file.name), { local: { fileName: file.name, lastModified: file.lastModified, savedChanges: 0, at: Date.now() } }), content);
      await setHandle(id, handle);
      await allowWrite(handle);
      await switchTo(id);
      toast(`已開啟「${nameFromFile(file.name)}」，之後的變更會自動存回這個檔案`);
    });
  };

  // 用本機檔案的內容取代這本筆記本（檔案在別處被改過）
  async function loadLocal(nb, file) {
    const content = await unpackNotebook(file);
    const title = (await db.get('pages', nb.lastPage))?.title;
    const lastPage = content.pages.find(page => page.title === title)?.id ?? null;
    // 內容換了：Drive 那份要重新存（changes 加一），本機檔案已經是這個內容
    const changes = nb.changes + 1;
    await replaceNotebook({ ...nb, lastPage, changes, local: { ...nb.local, savedChanges: changes, lastModified: file.lastModified, at: Date.now() } }, content);
    if (nb.id === current()) await reload(nb.id);
    toast(`已載入「${file.name}」的最新內容`);
  }

  const takeLocal = () => run(async () => {
    const nb = await db.get('notebooks', current());
    if (!confirm(`會用「${nb.local.fileName}」的內容取代這台裝置上的「${nb.name}」，這台還沒存進檔案的變更會消失。\n\n確定要載入嗎？`)) return;
    const handle = await handleOf(nb.id);
    await loadLocal(nb, await handle.getFile());
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
    place($('#sync-drive'), '☁ Google Drive', !nb.drive ? '未連結' : `${nb.drive.email} · ${dirty(nb) ? '有變更未儲存' : '已儲存'}`, !nb.drive
      ? [{ label: '存到 Drive', primary: true, run: save }]
      : [{ label: '儲存', primary: dirty(nb), run: save }, { label: '從 Drive 同步', run: sync }]);

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
    if (nb.drive && (always || dirty(nb))) save();
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
  // 離開分頁前把變更寫進檔案；回到分頁時看看檔案有沒有在別處被改過
  document.addEventListener('visibilitychange', () => {
    if (!shown?.local || busy) return;
    if (document.hidden) local.sync(shown.id);
    else local.check(shown.id);
  });

  // 內容有變更（main.js 的 markChanged 之後）
  async function changed() {
    await render();
    if (shown?.local) local.schedule();
  }

  return { render, changed };
}
