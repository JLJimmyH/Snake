import { db, uid, newNotebook, pagesOf } from './db.js';
import { setupAppearance } from './appearance.js';
import { Board } from './board.js';
import { Minimap } from './minimap.js';
import { cleanName } from './notebook-core.js';
import { setupNotebooks } from './notebook-ui.js';
import { setupAi } from './ai-ui.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const isMobile = () => matchMedia('(max-width: 767px)').matches;

let notebookId = null;   // 每個分頁各自記住目前開著哪本
let notebooks = null;
let pages = [];          // 只有目前筆記本的頁面
let current = null;
let saveTimer = null;
let contentChanged = false;
let collaboration = null;
let lastLocalPage = null;

const board = new Board($('#viewport'), {
  onChange: () => { contentChanged = true; scheduleSave(); refreshNav(); },
  onRemote: refreshNav,
  onView: (v, silent) => {
    $('#zoom').textContent = Math.round(v.s * 100) + '%';
    refreshNav();
    if (!silent) scheduleSave();
  },
  onSelect: count => { $('#btn-del').disabled = !count; },
  onHistory: (canUndo, canRedo) => {
    $('#btn-undo').disabled = !canUndo;
    $('#btn-redo').disabled = !canRedo;
  },
  onPenDetected: () => {
    updateFinger();
    toast('偵測到觸控筆：單指改為「移動畫面」，可在工具列切換');
  },
});

// ---------- 儲存 ----------
function setSaveState(t) { $('#save-state').textContent = t; }

function scheduleSave() {
  if (!current && !collaboration?.active) return;
  collaboration?.changed();
  setSaveState('編輯中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (collaboration?.active) {
    contentChanged = false;
    await collaboration.saved();
    setSaveState('已存於本機');
    return;
  }
  if (!current) return;
  await db.put('docs', { pageId: current, items: board.items, view: board.view });
  setSaveState('已儲存');
  // 只移動畫面不算變更；有改內容才標記「尚未存到 Drive」
  if (contentChanged) {
    contentChanged = false;
    await markChanged();
  }
}

async function markChanged() {
  if (!notebookId) return;
  await db.update('notebooks', notebookId, nb => nb && { ...nb, changes: nb.changes + 1 });
  notebooks?.render();
}

async function flush() {
  board.commitText();
  if (saveTimer) await saveNow();
}

document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', () => { flush(); });

// ---------- 頁面資料 ----------
const byId = id => pages.find(p => p.id === id);
const kids = pid => pages.filter(p => (p.parentId ?? null) === pid).sort((a, b) => a.order - b.order);
const savePage = p => db.put('pages', p);

function descendants(id) {
  const out = [];
  const walk = pid => kids(pid).forEach(c => { out.push(c.id); walk(c.id); });
  walk(id);
  return out;
}

function ancestors(id) {
  const out = [];
  let p = byId(id);
  while (p?.parentId) {
    p = byId(p.parentId);
    if (p) out.unshift(p);
  }
  return out;
}

async function createPage(parentId, title = '') {
  const sibs = kids(parentId);
  const p = {
    id: uid(), notebookId, parentId, title,
    order: sibs.length ? sibs[sibs.length - 1].order + 1 : 0,
    open: true, created: Date.now(),
  };
  pages.push(p);
  await savePage(p);
  const parent = byId(parentId);
  if (parent && !parent.open) {
    parent.open = true;
    await savePage(parent);
  }
  return p;
}

async function seed() {
  const welcome = await createPage(null, '歡迎使用');
  const lines = [
    [28, '👋 歡迎！這是 Snake Note'],
    [18, '↖ 選取（預設）：拖曳移動畫布，點一下選取物件後可拖曳移動'],
    [18, '➰ 套索：圈起筆跡/文字/圖片，一起移動或刪除'],
    [18, '✏️ 筆：單指或觸控筆直接書寫'],
    [18, '🧽 橡皮擦：可切換「局部」或「整條」'],
    [18, '🤏 雙指：縮放與平移畫面'],
    [18, 'T 文字：點空白處新增文字，點文字框編輯；選取後拉把手調寬度'],
    [18, '✍️ 文字支援 Markdown：`# 標題`、`**粗體**`、`*斜體*`、`- 清單`、`- [ ] 待辦`、`[連結](https://…)`'],
    [18, '- [ ] 點方框就能打勾，不用進入編輯'],
    [18, '🖼 圖片：從相簿或相機上傳，拉右下角圓點縮放'],
    [18, '📁 左側頁面可以無限層巢狀（像 Notion）'],
  ];
  let y = 0;
  const items = lines.map(([size, text]) => {
    const it = { id: uid(), type: 'text', x: 0, y, size, text };
    y += size * 1.45 + 14;
    return it;
  });
  await db.put('docs', { pageId: welcome.id, items, view: { x: 32, y: 32, s: 1 } });
  const work = await createPage(null, '工作');
  await createPage(work.id, '會議記錄');
  const study = await createPage(null, '學習');
  await createPage(study.id, '課堂筆記');
  return welcome;
}

async function openPage(id) {
  await flush();
  await collaboration?.detach();
  current = id;
  lastLocalPage = id;
  $('#page-title').readOnly = false;
  board.load(await db.get('docs', id));
  setSaveState('');
  db.update('notebooks', notebookId, nb => nb && { ...nb, lastPage: id });
  for (const a of ancestors(id)) {
    if (!a.open) {
      a.open = true;
      savePage(a);
    }
  }
  renderTree();
  renderHeader();
}

async function addPage(parentId) {
  const p = await createPage(parentId, '');
  markChanged();
  await openPage(p.id);
  closeSidebar();
  $('#page-title').focus();
}

async function renamePage(id) {
  const p = byId(id);
  const t = prompt('頁面名稱', p.title);
  if (t === null) return;
  p.title = t.trim();
  await savePage(p);
  markChanged();
  renderTree();
  renderHeader();
}

async function swapOrder(a, b) {
  [a.order, b.order] = [b.order, a.order];
  await Promise.all([savePage(a), savePage(b)]);
  markChanged();
  renderTree();
}

async function movePage(id, parentId) {
  const p = byId(id);
  const sibs = kids(parentId).filter(x => x !== p);
  p.parentId = parentId;
  p.order = sibs.length ? sibs[sibs.length - 1].order + 1 : 0;
  await savePage(p);
  const parent = byId(parentId);
  if (parent && !parent.open) {
    parent.open = true;
    await savePage(parent);
  }
  markChanged();
  renderTree();
  renderHeader();
}

async function deletePage(id) {
  const p = byId(id);
  const ids = [id, ...descendants(id)];
  const extra = ids.length > 1 ? `及底下 ${ids.length - 1} 個子頁面` : '';
  if (!confirm(`確定刪除「${p.title || '未命名'}」${extra}？`)) return;

  if (ids.includes(current)) {
    clearTimeout(saveTimer);
    saveTimer = null;
    current = null;
  }
  for (const pid of ids) {
    const doc = await db.get('docs', pid);
    for (const it of doc?.items ?? []) if (it.type === 'image') await db.del('blobs', it.blobId);
    await db.del('docs', pid);
    await db.del('pages', pid);
  }
  pages = pages.filter(x => !ids.includes(x.id));
  markChanged();

  if (!current) {
    const next = kids(null)[0] ?? await createPage(null, '');
    await openPage(next.id);
  } else {
    renderTree();
  }
}

// ---------- 側欄樹 ----------
function renderTree() {
  const tree = $('#tree');
  tree.replaceChildren();
  const walk = (pid, depth) => {
    for (const p of kids(pid)) {
      const n = kids(p.id).length;
      const row = document.createElement('div');
      row.className = 'row' + (p.id === current ? ' active' : '');
      row.dataset.id = p.id;
      row.style.paddingLeft = 4 + depth * 16 + 'px';
      row.innerHTML = `
        <button class="caret${n ? '' : ' empty'}${p.open ? ' open' : ''}" data-act="toggle">▶</button>
        <span class="pg-icon">📄</span>
        <span class="pg-title"></span>
        <button class="row-btn" data-act="add" title="新增子頁面">＋</button>
        <button class="row-btn" data-act="more" title="更多">⋯</button>`;
      row.querySelector('.pg-title').textContent = p.title || '未命名';
      tree.append(row);
      if (n && p.open) walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
}

function renderHeader() {
  const p = byId(current);
  if (!p) return;
  const input = $('#page-title');
  if (document.activeElement !== input) input.value = p.title;
  $('#crumbs').textContent = ancestors(current).map(a => a.title || '未命名').join(' / ');
  document.title = (p.title || '未命名') + ' - 筆記';
}

$('#tree').addEventListener('click', async e => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'toggle') {
    const p = byId(id);
    p.open = !p.open;
    savePage(p);
    renderTree();
  } else if (act === 'add') {
    await addPage(id);
  } else if (act === 'more') {
    pageMenu(e.target.getBoundingClientRect(), id);
  } else {
    if (id !== current) await openPage(id);
    closeSidebar();
  }
});

$('#add-root').addEventListener('click', () => addPage(null));

$('#page-title').addEventListener('input', e => {
  const p = byId(current);
  if (!p) return;
  p.title = e.target.value;
  savePage(p);
  markChanged();
  renderTree();
  document.title = (p.title || '未命名') + ' - 筆記';
});
$('#page-title').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

// ---------- 選單 ----------
function showMenu(rect, entries) {
  const m = $('#menu');
  m.replaceChildren();
  for (const en of entries) {
    if (en.head) {
      const d = document.createElement('div');
      d.className = 'menu-head';
      d.textContent = en.head;
      m.append(d);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = en.label;
    b.disabled = !!en.disabled;
    if (en.danger) b.className = 'danger';
    b.addEventListener('click', () => { hideMenu(); en.run(); });
    m.append(b);
  }
  m.hidden = false;
  const left = Math.max(8, Math.min(rect.left, innerWidth - m.offsetWidth - 8));
  let top = rect.bottom + 4;
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, rect.top - m.offsetHeight - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
}

function hideMenu() { $('#menu').hidden = true; }

document.addEventListener('pointerdown', e => {
  if (!$('#menu').hidden && !e.target.closest('#menu')) hideMenu();
}, true);

function pageMenu(rect, id) {
  const p = byId(id);
  const sibs = kids(p.parentId ?? null);
  const i = sibs.indexOf(p);
  showMenu(rect, [
    { label: '＋ 新增子頁面', run: () => addPage(id) },
    { label: '✎ 重新命名', run: () => renamePage(id) },
    { label: '↑ 上移', disabled: i === 0, run: () => swapOrder(p, sibs[i - 1]) },
    { label: '↓ 下移', disabled: i === sibs.length - 1, run: () => swapOrder(p, sibs[i + 1]) },
    { label: '⇢ 移動到…', run: () => moveMenu(rect, id) },
    { label: '🗑 刪除', danger: true, run: () => deletePage(id) },
  ]);
}

function moveMenu(rect, id) {
  const banned = new Set([id, ...descendants(id)]);
  const entries = [
    { head: '移動到…' },
    { label: '（最上層）', disabled: !byId(id).parentId, run: () => movePage(id, null) },
  ];
  const walk = (pid, depth) => {
    for (const p of kids(pid)) {
      if (banned.has(p.id)) continue;
      entries.push({
        label: ' '.repeat(depth * 4) + '📄 ' + (p.title || '未命名'),
        disabled: p.id === byId(id).parentId,
        run: () => movePage(id, p.id),
      });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  showMenu(rect, entries);
}

// ---------- 側欄開關 ----------
function closeSidebar() { document.body.classList.remove('sb-open'); }

$('#sb-toggle').addEventListener('click', () => {
  if (isMobile()) document.body.classList.toggle('sb-open');
  else document.body.classList.toggle('sb-collapsed');
});
$('#sb-close').addEventListener('click', closeSidebar);
$('#scrim').addEventListener('click', closeSidebar);

// ---------- 工具列 ----------
function setTool(t) {
  closeBrushPalettes();
  $('#brush-preview').hidden = true;
  board.setTool(t);
  $('#toolbar').dataset.tool = t;
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
}

$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

function closeBrushPalettes(restoreFocus = false) {
  for (const panel of $$('.brush-palette')) {
    if (panel.hidden) continue;
    panel.hidden = true;
    const toggle = panel.parentElement.querySelector('.palette-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  }
}

function updateBrushColor(group, value) {
  board.style[group.dataset.for].color = value;
  group.querySelector('input[type=color]').value = value;
  group.querySelector('.palette-toggle').style.setProperty('--brush-color', value);
  group.querySelectorAll('.swatch').forEach(button => {
    const active = button.dataset.color === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.brush-palette, .palette-toggle')) closeBrushPalettes();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeBrushPalettes(true);
});
$('#toolbar').addEventListener('scroll', () => closeBrushPalettes());
window.addEventListener('resize', () => closeBrushPalettes());

$$('.opts').forEach(group => {
  const style = board.style[group.dataset.for];
  group.addEventListener('click', e => {
    const toggle = e.target.closest('.palette-toggle');
    const sw = e.target.closest('.swatch');
    const wb = e.target.closest('.wbtn');
    const md = e.target.closest('[data-mode]');
    if (toggle) {
      $('#brush-preview').hidden = true;
      const panel = group.querySelector('.brush-palette');
      const opening = panel.hidden;
      closeBrushPalettes();
      if (opening) {
        const rect = toggle.getBoundingClientRect();
        panel.style.left = Math.max(8, Math.min(innerWidth - 248, rect.left)) + 'px';
        panel.style.top = Math.min(innerHeight - 168, rect.bottom + 8) + 'px';
        panel.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
      }
    } else if (md) {
      style.mode = md.dataset.mode;
      group.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === md));
    } else if (sw) {
      updateBrushColor(group, sw.dataset.color);
      closeBrushPalettes(true);
    } else if (wb) {
      // Eraser still uses size presets; drawing brushes use their sole slider.
      style.width = +wb.dataset.width;
      group.querySelectorAll('.wbtn').forEach(x => x.classList.toggle('active', x === wb));
    }
  });
});

for (const group of $$('.opts[data-for=pen], .opts[data-for=hl]')) {
  const style = board.style[group.dataset.for];
  const color = group.querySelector('input[type=color]');
  const slider = group.querySelector('input[type=range]');
  const preview = $('#brush-preview');
  const showPreview = () => {
    closeBrushPalettes();
    const rect = slider.getBoundingClientRect();
    preview.style.left = Math.max(8, Math.min(innerWidth - 140, rect.left + rect.width / 2 - 66)) + 'px';
    preview.style.top = Math.min(innerHeight - 148, rect.bottom + 10) + 'px';
    const dot = preview.querySelector('.brush-dot');
    dot.style.width = dot.style.height = style.width + 'px';
    // 預覽底色＝畫布底色，筆點顏色跟畫在畫布上一樣
    dot.style.backgroundColor = board.inkColor({ tool: group.dataset.for, color: style.color });
    dot.style.opacity = group.dataset.for === 'hl' ? '.5' : '1';
    preview.querySelector('.brush-caption').textContent = style.width + ' px';
    preview.hidden = false;
  };
  color.addEventListener('input', () => {
    updateBrushColor(group, color.value);
  });
  slider.addEventListener('input', () => {
    style.width = Math.round(Number(slider.value) * 100) / 100;
    group.querySelector('output').textContent = style.width;
    showPreview();
  });
  slider.addEventListener('pointerdown', showPreview);
  slider.addEventListener('focus', showPreview);
  slider.addEventListener('blur', () => { preview.hidden = true; });
  slider.addEventListener('pointerup', () => { preview.hidden = true; });
  slider.addEventListener('pointercancel', () => { preview.hidden = true; });
}

$('#btn-image').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  setTool('select');
  for (const f of files) {
    try { await board.addImage(f); } catch (err) { toast(err.message); }
  }
});

$('#btn-undo').addEventListener('click', () => board.undo());
$('#btn-redo').addEventListener('click', () => board.redo());
$('#btn-del').addEventListener('click', () => board.deleteSelected());

// ---------- 導覽：縮放、顯示全部、小地圖、回到內容 ----------
const minimap = new Minimap(board, $('#minimap canvas'));
let navFrame = 0;

// 視角或內容變了：下一個 frame 重畫小地圖，並判斷要不要提示「回到內容」
function refreshNav() {
  if (navFrame) return;
  navFrame = requestAnimationFrame(() => {
    navFrame = 0;
    minimap.draw();
    const lost = $('#back-to-content');
    lost.hidden = !board.items.length || board.hasVisibleContent();
    if (!lost.hidden) lost.style.top = $('#viewport').offsetTop + 12 + 'px';
  });
}

function setMinimap(open) {
  $('#minimap').hidden = !open;
  $('#btn-map').setAttribute('aria-pressed', String(open));
  try { localStorage.setItem('minimap', open ? '1' : '0'); } catch { /* ignore */ }
  refreshNav();
}

$('#zoom').addEventListener('click', () => board.zoomTo(1));
$('#zoom-in').addEventListener('click', () => board.zoomStep(1));
$('#zoom-out').addEventListener('click', () => board.zoomStep(-1));
$('#btn-fit').addEventListener('click', () => board.fitContent());
$('#back-to-content').addEventListener('click', () => board.fitContent());
$('#btn-map').addEventListener('click', () => setMinimap($('#minimap').hidden));
// 停在導覽列上按 Ctrl+滾輪不要縮放整個網頁
$('#nav').addEventListener('wheel', e => e.preventDefault(), { passive: false });
// 圖片載入完成後小地圖才畫得出縮圖（load 不會冒泡，用 capture）
$('#viewport').addEventListener('load', refreshNav, true);
window.addEventListener('resize', refreshNav);

function updateFinger() {
  try { localStorage.setItem('fingerDraws', board.fingerDraws ? '1' : '0'); } catch { /* ignore */ }
  const b = $('#btn-finger');
  b.textContent = board.fingerDraws ? '☝️ 手指：書寫' : '✋ 手指：移動';
  b.classList.toggle('on', !board.fingerDraws);
}
$('#btn-finger').addEventListener('click', () => {
  board.fingerDraws = !board.fingerDraws;
  updateFinger();
});

// ---------- 鍵盤 / 貼上 ----------
const typing = el => el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

document.addEventListener('keydown', e => {
  if (typing(document.activeElement) || $('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? board.redo() : board.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); board.redo(); return; }
  if (mod) return;
  if (e.shiftKey && e.code === 'Digit1') { board.fitContent(); return; }
  if (e.shiftKey && e.code === 'Digit0') { board.zoomTo(1); return; }
  if (k === 'm') { setMinimap($('#minimap').hidden); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { board.deleteSelected(); return; }
  const tools = { v: 'select', l: 'lasso', p: 'pen', h: 'hl', e: 'eraser', t: 'text' };
  if (tools[k]) setTool(tools[k]);
});

document.addEventListener('paste', async e => {
  if (typing(document.activeElement) || board.readOnly || $('dialog[open]')) return;
  const clipboard = e.clipboardData;
  if (!clipboard) return;
  const files = [...clipboard.files].filter(file => file.type.startsWith('image/'));
  const text = clipboard.getData('text/plain');
  if (!files.length && !text) return;
  e.preventDefault();
  setTool('select');
  const position = board.pastePosition();
  if (files.length) {
    for (let i = 0; i < files.length; i++) {
      try { await board.addImage(files[i], { x: position.x + i * 24, y: position.y + i * 24 }); }
      catch (error) { toast(error.message); }
    }
  } else board.addText(text, position);
});

// 手機鍵盤彈出時 visualViewport 會變小：讓整個 app 貼齊可見範圍，再把游標捲進畫面
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const root = document.documentElement.style;
    root.setProperty('--app-h', vv.height + 'px');
    root.setProperty('--app-top', vv.offsetTop + 'px');
    board.rect = $('#viewport').getBoundingClientRect();
    board.revealCaret();
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// iOS Safari 的整頁縮放手勢
document.addEventListener('gesturestart', e => e.preventDefault());

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  // 每次重新 showPopover 才會疊在最新開啟的 <dialog> 上面
  if (t.showPopover) { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// Static hosting keeps local notes usable and explains collaboration status.
function showLocalCollaborationInfo() {
  const dialog = $('#collab-dialog');
  $('#collab-mode').textContent = '此網站目前使用本機儲存，多人協作尚未啟用。';
  $('#collab-user').textContent = '筆記會先儲存在目前裝置；可從左上角的筆記本選單存到自己的 Google Drive 或匯出 zip。多人即時同步尚未啟用。';
  $('#collab-pages').textContent = '你可以繼續新增頁面、書寫、插入圖片與使用復原／重做。帳號登入、分享及多人共同編輯需等協作服務啟用。';
  for (const id of ['collab-login', 'collab-logout', 'collab-copy', 'demo-accounts', 'collab-share']) $('#' + id).hidden = true;
  $('.collab-help').hidden = true;
  $('#collab-button').hidden = false;
  $('#collab-button').textContent = '協作說明';
  $('#collab-button').addEventListener('click', () => dialog.showModal());
  $('#collab-close').addEventListener('click', () => dialog.close());
}

// ---------- 筆記本 ----------
async function createNotebook(name) {
  const id = uid();
  await db.put('notebooks', newNotebook(id, cleanName(name)), id);
  return id;
}

async function switchNotebook(id) {
  await flush();
  const nb = await db.get('notebooks', id);
  if (!nb) throw new Error('找不到這本筆記本');
  notebookId = id;
  try { sessionStorage.setItem('notebook', id); } catch { /* ignore */ }
  db.put('meta', id, 'lastNotebook');
  current = null;
  pages = await pagesOf(id);
  if (!pages.length) await createPage(null, '');
  await openPage(byId(nb.lastPage) ? nb.lastPage : kids(null)[0].id);
  notebooks?.render();
}

// 從 Drive 同步後重新載入：畫布上的舊內容已被取代，丟掉，不能再存回去
async function reloadNotebook(id) {
  current = null;
  clearTimeout(saveTimer);
  saveTimer = null;
  board.commitText();
  contentChanged = false;
  await switchNotebook(id);
}

// 這個分頁上次開的 → 任何分頁最後開的 → 最早建立的；全新安裝則建立含教學的「我的筆記」
async function initialNotebook() {
  const list = await db.getAll('notebooks');
  let saved = null;
  try { saved = sessionStorage.getItem('notebook'); } catch { /* ignore */ }
  const last = await db.get('meta', 'lastNotebook');
  const found = [saved, last].find(id => list.some(nb => nb.id === id)) ?? list.sort((a, b) => a.created - b.created)[0]?.id;
  if (found) return found;
  notebookId = await createNotebook('我的筆記');
  await seed();
  return notebookId;
}

// ---------- init ----------
async function init() {
  try { if (localStorage.getItem('fingerDraws') === '0') board.fingerDraws = false; } catch { /* ignore */ }
  // 小地圖預設：桌機打開、手機收合；之後記住使用者的選擇
  let map = null;
  try { map = localStorage.getItem('minimap'); } catch { /* ignore */ }
  setMinimap(map ? map === '1' : !isMobile());
  setupAppearance({ board, button: $('#btn-appearance'), panel: $('#appearance-panel'), onCanvas: refreshNav });
  setupAi({ board, title: () => $('#page-title').value, toast });
  setTool('select');
  updateFinger();
  notebooks = setupNotebooks({
    current: () => notebookId, switchTo: switchNotebook, reload: reloadNotebook, create: createNotebook, flush, showMenu, toast,
  });
  await switchNotebook(await initialNotebook());
  try {
    const response = await fetch(new URL('api/config', document.baseURI));
    if (response.ok) {
      const { setupCollaboration } = await import('/collab-assets/collaboration.js');
      collaboration = await setupCollaboration({
        board, beforeOpen: flush, localPage: () => byId(current), toast,
        onOpen: page => {
          current = null;
          $('#page-title').value = page.title;
          $('#page-title').readOnly = true;
          $('#crumbs').textContent = '協作頁面';
          document.title = page.title + ' - 協作筆記';
          renderTree(); setSaveState('');
        },
        onLeave: () => openPage(byId(lastLocalPage) ? lastLocalPage : kids(null)[0].id),
      });
    } else showLocalCollaborationInfo();
  } catch (error) {
    showLocalCollaborationInfo();
    toast('協作服務無法啟動：' + error.message);
  }
}

init().catch(err => {
  console.error(err);
  toast('初始化失敗：' + err.message);
});
