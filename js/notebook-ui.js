import { db, uid, newNotebook, readNotebook, addNotebook, replaceNotebook, deleteNotebook } from './db.js';
import { packNotebook, unpackNotebook, cleanName, fileName, nameFromFile } from './notebook-core.js';
import { DriveClient, loadGoogleIdentity } from './drive.js';
import { GOOGLE_DRIVE_CLIENT_ID } from './drive-config.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const dirty = nb => nb.changes !== nb.savedChanges;
const state = nb => !nb.drive ? '僅本機' : dirty(nb) ? '未儲存到 Drive' : '已存到 Drive';
const byCreated = (a, b) => a.created - b.created;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

// 筆記本：切換、新增、重新命名、關閉、匯入匯出 zip、Drive 開啟／儲存／同步／另存副本
export function setupNotebooks({ current, switchTo, reload, create, flush, showMenu, toast }) {
  const drive = new DriveClient(GOOGLE_DRIVE_CLIENT_ID);
  if (GOOGLE_DRIVE_CLIENT_ID) loadGoogleIdentity().catch(error => toast(error.message));
  const dialog = $('#drive-dialog');
  let busy = false;

  async function render() {
    const nb = await db.get('notebooks', current());
    if (!nb) return;
    $('#nb-name').textContent = nb.name;
    $('#nb-button').title = `${nb.name}（${state(nb)}）：點一下切換筆記本`;
    $('#nb-dirty').hidden = !nb.drive || !dirty(nb);
    const save = $('#drive-save');
    const label = !nb.drive ? '存到 Drive' : dirty(nb) ? '儲存到 Drive' : '已存到 Drive';
    save.setAttribute('aria-label', label);
    save.title = `${label} (Ctrl+S)`;
    save.classList.toggle('on', Boolean(nb.drive) && dirty(nb));
    save.disabled = busy;
    $('#drive-sync').hidden = !nb.drive;
    $('#drive-sync').disabled = busy;
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
    if (!nb.drive) throw new Error('這本筆記本只在本機，請先「存到 Drive」');
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
    await replaceNotebook({ ...nb, name: nameFromFile(meta.name), lastPage, savedChanges: nb.changes, drive: { ...nb.drive, revision: meta.headRevisionId } }, content);
    await reload(nb.id);
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
      toast(`已匯入「${nameFromFile(file.name)}」（僅本機）`);
    });
  });

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
  });

  const close = () => run(async () => {
    await flush();
    const nb = await db.get('notebooks', current());
    const warning = !nb.drive
      ? `「${nb.name}」只存在這台裝置，關閉後會永久刪除。\n\n建議先「匯出 zip」或「存到 Drive」。確定要刪除並關閉嗎？`
      : dirty(nb) ? `「${nb.name}」有尚未存到 Drive 的變更，關閉後這些變更會消失。\n\n確定要關閉嗎？` : null;
    if (warning && !confirm(warning)) return;
    const next = (await db.getAll('notebooks')).filter(other => other.id !== nb.id).sort(byCreated)[0];
    await switchTo(next?.id ?? await create('未命名筆記本'));
    await deleteNotebook(nb.id);
    toast(`已關閉「${nb.name}」`);
  });

  async function openMenu() {
    const rect = $('#nb-button').getBoundingClientRect();
    const list = (await db.getAll('notebooks')).sort(byCreated);
    showMenu(rect, [
      { head: '筆記本' },
      ...list.map(nb => ({ label: `${nb.id === current() ? '✓' : '　'} ${nb.name} · ${state(nb)}`, run: () => nb.id !== current() && run(() => switchTo(nb.id)) })),
      { head: '這本筆記本' },
      { label: '☁ 儲存到 Drive（Ctrl+S）', run: save },
      { label: '⟳ 從 Drive 同步', run: sync },
      { label: '☁ 另存副本到 Drive…', run: saveCopy },
      { label: '⬇ 匯出 zip', run: exportZip },
      { label: '✎ 重新命名', run: rename },
      { label: '✕ 關閉筆記本', danger: true, run: close },
      { head: '開啟' },
      { label: '＋ 新增筆記本', run: addNew },
      { label: '☁ 從 Drive 開啟…', run: openDrive },
      { label: '📂 匯入 zip…', run: () => $('#nb-import').click() },
      ...(drive.connected ? [{ label: `中斷 Google 連線（${drive.account.email}）`, run: disconnect }] : []),
      { label: '隱私權政策', run: () => window.open('privacy.html', '_blank', 'noopener') },
    ]);
  }

  function disconnect() {
    drive.disconnect(); dialog.close(); render();
    toast('已中斷 Google 連線，本機與 Drive 上的筆記本都會保留');
  }

  $('#nb-button').addEventListener('click', openMenu);
  $('#drive-save').addEventListener('click', save);
  $('#drive-sync').addEventListener('click', sync);
  $('#drive-close').addEventListener('click', () => dialog.close());
  $('#drive-disconnect').addEventListener('click', disconnect);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  });

  return { render };
}
