import { db } from './db.js';
import { HistoryStore } from './version-store.js';
import { heads } from './version-core.js';
import { DriveClient, loadGoogleIdentity } from './drive.js';
import { GOOGLE_DRIVE_CLIENT_ID } from './drive-config.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const formatDate = value => new Date(value).toLocaleString();

export async function setupHistory({ beforeAction, afterRestore }) {
  const dialog = $('#history-dialog');
  let scope = 'local', store = new HistoryStore(), drive, busy = false, accounts = await db.get('meta', 'drive-accounts') || [];
  let remoteIds = new Set(), pendingRestore = null;
  const urls = [];
  const status = (text, error = false) => { $('#history-status').textContent = text; $('#history-status').classList.toggle('error', error); };
  const accountName = () => accounts.find(a => 'drive:' + a.id === scope)?.email || '本機';
  const connected = () => drive?.account && 'drive:' + drive.account.id === scope && drive.token && Date.now() < drive.expires;
  const refreshButtons = () => {
    $('#history-account').textContent = drive?.account && drive.token && Date.now() < drive.expires ? `已連結：${drive.account.email}` : '未連線：仍可建立本機版本';
    for (const button of dialog.querySelectorAll('[data-history-action]')) button.disabled = busy;
    $('#history-scope').disabled = busy;
    $('#drive-client-id').disabled = busy;
    $('#drive-upload-current').disabled = busy || !connected();
    $('#drive-refresh').disabled = busy || !connected();
    $('#drive-disconnect').disabled = busy || !drive?.account;
  };
  const run = async task => {
    if (busy) return;
    busy = true; refreshButtons();
    try { await task(); }
    catch (error) { status(error.message || '操作失敗，本機內容仍保留', true); }
    finally { busy = false; refreshButtons(); }
  };
  const clearPreview = () => { urls.splice(0).forEach(URL.revokeObjectURL); $('#history-diff').replaceChildren(); pendingRestore = null; $('#history-restore-confirm').hidden = true; };
  const selectScope = () => {
    const select = $('#history-scope'); select.replaceChildren(new Option('本機版本（未連結帳號）', 'local'));
    for (const account of accounts) select.add(new Option(account.email, 'drive:' + account.id));
    select.value = scope;
    $('#history-account').textContent = drive?.account ? `已連結：${drive.account.email}` : '未連線：仍可建立本機版本';
  };
  const syncRemote = async () => {
    if (!connected()) throw new Error('請先連結這份版本歷史所屬的 Google 帳號');
    status('讀取 Drive 版本歷史…');
    const commits = await drive.listCommits();
    remoteIds = new Set(commits.map(c => c.id));
    for (const commit of commits) await db.put('versions', { scope, commit }, scope + ':' + commit.id);
    await db.put('meta', [...remoteIds], 'drive-remote:' + scope);
    // Reading remote history NEVER changes the local head or working notes.
    status(heads(commits).length > 1 ? '發現多份分歧版本，已全部保留；請預覽後選擇要還原的版本。' : `已讀取 ${commits.length} 個雲端版本，尚未變更本機筆記。`);
  };
  const ensureDownloaded = async id => {
    const commit = await store.read(id);
    // Resolve only this version and its immediate predecessor for the diff.
    // Full snapshots bound reconstruction; do not fetch every historic image.
    for (const key of new Set([id, commit.parent].filter(Boolean))) {
      status('驗證／下載版本 ' + key.slice(0, 8) + '…');
      await store.materialize(key, async objectId => {
        try { return await store.object(objectId); }
        catch {
          if (!connected()) throw new Error('此版本的內容尚未完整下載，請連結所屬 Google 帳號');
          const object = await drive.downloadObject(objectId);
          await db.put('objects', object, objectId); return object;
        }
      });
    }
  };
  const renderPreview = (value, workspace) => {
    if (!value) return el('p', '—', 'history-muted');
    if (value.type === 'text') return el('pre', value.text);
    if (value.type === 'image') {
      const img = el('img'); img.alt = '圖片預覽';
      const url = URL.createObjectURL(workspace.blobs.get(value.blobId)); urls.push(url); img.src = url; return img;
    }
    if (value.type === 'stroke') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of value.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const pad = Math.max(value.width, 2);
      svg.setAttribute('viewBox', `${x0-pad} ${y0-pad} ${Math.max(x1-x0,1)+pad*2} ${Math.max(y1-y0,1)+pad*2}`);
      const path = document.createElementNS(svg.namespaceURI, 'polyline');
      path.setAttribute('points', value.pts.length === 1 ? `${value.pts[0].join(',')} ${value.pts[0][0]+.01},${value.pts[0][1]}` : value.pts.map(p => p.join(',')).join(' '));
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', value.color); path.setAttribute('stroke-width', value.width); path.setAttribute('stroke-linecap', 'round');
      if (value.tool === 'hl') path.setAttribute('opacity', '.5');
      svg.append(path);
      const wrap = el('div'); wrap.append(svg, el('small', `筆寬 ${value.width}；位置 ${Math.round(x0)}, ${Math.round(y0)}`)); return wrap;
    }
    return el('p', `標題：${value.title || '未命名'}\n上層：${value.parentId || '最上層'}\n順序：${value.order}`);
  };
  const preview = async id => {
    clearPreview(); await ensureDownloaded(id);
    const { changes, before, after } = await store.compare(id);
    const area = $('#history-diff'); area.append(el('h3', '與前一版本相比'));
    area.append(el('p', `${changes.length} 項內容變更${changes.length > 200 ? '（先顯示前 200 項）' : ''}`));
    const names = { page: '頁面', stroke: '筆跡', text: '文字', image: '圖片' };
    for (const change of changes.slice(0, 200)) {
      const card = el('section', undefined, 'history-change'); card.append(el('h4', `${change.action}${names[change.kind]} · ${change.title}`));
      const columns = el('div', undefined, 'history-columns');
      for (const [label, value, workspace] of [['之前', change.before, before], ['之後', change.after, after]]) {
        const column = el('div'); column.append(el('strong', label), renderPreview(value, workspace)); columns.append(column);
      }
      card.append(columns); area.append(card);
    }
    pendingRestore = id; $('#history-restore-confirm').hidden = false;
    status('預覽完成，尚未更動筆記。還原會保護目前內容，並新增一個還原版本。');
  };
  const renderList = async () => {
    const list = $('#history-list'); list.replaceChildren();
    const commits = await store.list();
    const current = await store.head();
    const branchHeads = new Set(heads(commits).map(c => c.id));
    $('#history-branch-note').textContent = branchHeads.size > 1 ? '有多份分歧版本；系統不會自動覆蓋或合併。' : '';
    if (!commits.length) list.append(el('p', '還沒有版本。按「建立版本」保存目前全部本機筆記。'));
    for (const commit of commits) {
      const row = el('article', undefined, 'history-row');
      const receipt = remoteIds.has(commit.id);
      const title = el('div'); title.append(el('strong', commit.message || '未填寫備註'), el('small', `${formatDate(commit.createdAt)} · ${commit.id.slice(0,8)}${commit.id === current ? ' · 目前分支' : ''}${branchHeads.has(commit.id) ? ' · 分支末端' : ''}`), el('small', scope === 'local' ? '已存本機' : receipt ? '已備份至 Drive（上次確認）' : '已存本機・待上傳'));
      const button = el('button', '預覽／還原', 'chip'); button.dataset.historyAction = ''; button.onclick = () => run(() => preview(commit.id));
      row.append(title, button); list.append(row);
    }
  };
  const clientId = GOOGLE_DRIVE_CLIENT_ID || await db.get('meta', 'drive-client-id') || '';
  $('#drive-client-id').value = clientId;
  drive = new DriveClient(clientId, { progress: text => status(text) });
  if (clientId) loadGoogleIdentity().catch(error => status(error.message, true));
  $('#history-button').onclick = () => {
    dialog.showModal();
    run(async () => { await beforeAction(); selectScope(); await renderList(); status('版本包含全部本機頁面；協作空間與登入憑證不會被上傳。'); });
  };
  $('#history-close').onclick = () => { clearPreview(); dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else clearPreview(); });
  $('#history-scope').onchange = () => run(async () => {
    scope = $('#history-scope').value; store = new HistoryStore(scope); clearPreview();
    remoteIds = new Set(await db.get('meta', 'drive-remote:' + scope) || []);
    await renderList(); status(`已切換至 ${accountName()} 的版本歷史；本機筆記尚未改變。`);
  });
  $('#drive-save-config').onclick = () => run(async () => {
    const id = $('#drive-client-id').value.trim();
    if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('Client ID 應以 .apps.googleusercontent.com 結尾，請勿填入 Client secret');
    drive.disconnect(); drive = new DriveClient(id, { progress: text => status(text) });
    await db.put('meta', id, 'drive-client-id'); await loadGoogleIdentity(); selectScope(); status('設定已保存，請按「連結 Google Drive」');
  });
  $('#drive-connect').onclick = () => {
    // Calling connect before the first await preserves Google's popup gesture.
    if (busy) return;
    let connection;
    if (!drive.clientId) $('#drive-settings').open = true;
    try { connection = drive.connect(); } catch (error) { status(error.message, true); return; }
    run(async () => {
      const account = await connection;
      accounts = [...accounts.filter(a => a.id !== account.id), account];
      await db.put('meta', accounts, 'drive-accounts');
      scope = 'drive:' + account.id; store = new HistoryStore(scope); clearPreview(); selectScope();
      await syncRemote(); await renderList();
    });
  };
  $('#drive-disconnect').onclick = () => run(async () => {
    drive.disconnect(); scope = 'local'; store = new HistoryStore(scope); remoteIds = new Set(); clearPreview(); selectScope(); await renderList();
    status('已中斷連線，本機與雲端版本仍保留。若要撤銷 Google 授權，請至 Google 帳號的第三方應用程式設定。');
  });
  $('#history-create').onclick = () => run(async () => {
    await beforeAction(); status('建立本機版本…');
    const commit = await store.create($('#history-message').value.trim()); $('#history-message').value = '';
    await renderList(); status(`版本 ${commit.id.slice(0,8)} 已存本機${scope !== 'local' ? '，尚未上傳 Drive' : ''}。`);
  });
  $('#drive-upload-current').onclick = () => run(async () => {
    await beforeAction(); await syncRemote();
    // Explicit action takes a new snapshot of this browser's notes into ONLY
    // the selected account. Local/unrelated-account histories are not copied.
    const head = await store.create($('#history-message').value.trim() || '手動備份');
    $('#history-message').value = ''; await drive.upload(store, head.id); await syncRemote(); await renderList();
    status(`已備份至 ${accountName()} 的 Drive。${heads(await store.list()).length > 1 ? '有分歧版本，已全部保留。' : ''}`);
  });
  $('#drive-retry').onclick = () => run(async () => {
    if (!connected()) throw new Error('請先重新連結此帳號');
    const head = await store.head(); if (!head) throw new Error('尚無版本可上傳');
    await syncRemote(); await drive.upload(store, head); await syncRemote(); await renderList(); status('目前分支已備份至 Drive。');
  });
  $('#drive-refresh').onclick = () => run(async () => { await syncRemote(); await renderList(); });
  $('#history-restore').onclick = () => run(async () => {
    if (!pendingRestore) return;
    await beforeAction(); status('驗證版本並還原…');
    const restored = await store.restore(pendingRestore);
    await afterRestore(); clearPreview(); await renderList(); status(`已還原並建立版本 ${restored.id.slice(0,8)}；原內容已保護，尚未上傳。`);
  });
  selectScope(); refreshButtons();
}
