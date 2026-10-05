import { db, uid } from './db.js';
import { Board } from './board.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const isMobile = () => matchMedia('(max-width: 767px)').matches;

let pages = [];
let current = null;
let saveTimer = null;

const board = new Board($('#viewport'), {
  onChange: scheduleSave,
  onView: (v, silent) => {
    $('#zoom').textContent = Math.round(v.s * 100) + '%';
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
  if (!current) return;
  setSaveState('編輯中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return;
  await db.put('docs', { pageId: current, items: board.items, view: board.view });
  setSaveState('已儲存');
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
    id: uid(), parentId, title,
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
    [28, '👋 歡迎！這是筆記 MVP'],
    [18, '↖ 選取（預設）：單指拖曳移動畫面，點一下選取物件後可拖曳'],
    [18, '➰ 套索：圈起筆跡/文字/圖片，一起移動或刪除'],
    [18, '✏️ 筆：單指或觸控筆直接書寫'],
    [18, '🧽 橡皮擦：可切換「局部」或「整條」'],
    [18, '🤏 雙指：縮放與平移畫面'],
    [18, 'T 文字：點空白處開始打字，選取後拉右側把手調寬度'],
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
  current = id;
  board.load(await db.get('docs', id));
  setSaveState('');
  db.put('meta', id, 'lastPage');
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
  renderTree();
  renderHeader();
}

async function swapOrder(a, b) {
  [a.order, b.order] = [b.order, a.order];
  await Promise.all([savePage(a), savePage(b)]);
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
  p.title = e.target.value;
  savePage(p);
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
  board.setTool(t);
  $('#toolbar').dataset.tool = t;
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
}

$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

$$('.opts').forEach(group => {
  const style = board.style[group.dataset.for];
  group.addEventListener('click', e => {
    const sw = e.target.closest('.swatch');
    const wb = e.target.closest('.wbtn');
    const md = e.target.closest('[data-mode]');
    if (md) {
      style.mode = md.dataset.mode;
      group.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === md));
    } else if (sw) {
      style.color = sw.dataset.color;
      group.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x === sw));
    } else if (wb) {
      style.width = +wb.dataset.width;
      group.querySelectorAll('.wbtn').forEach(x => x.classList.toggle('active', x === wb));
    }
  });
});

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
$('#zoom').addEventListener('click', () => board.zoomTo(1));

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
  if (typing(document.activeElement)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? board.redo() : board.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); board.redo(); return; }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { board.deleteSelected(); return; }
  const tools = { v: 'select', l: 'lasso', p: 'pen', h: 'hl', e: 'eraser', t: 'text' };
  if (tools[k]) setTool(tools[k]);
});

document.addEventListener('paste', async e => {
  if (typing(document.activeElement)) return;
  const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  setTool('select');
  for (const f of files) await board.addImage(f);
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
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- init ----------
async function init() {
  pages = await db.getAll('pages');
  if (!pages.length) await seed();
  const last = await db.get('meta', 'lastPage');
  try { if (localStorage.getItem('fingerDraws') === '0') board.fingerDraws = false; } catch { /* ignore */ }
  setTool('select');
  updateFinger();
  await openPage(byId(last) ? last : kids(null)[0].id);
}

init().catch(err => {
  console.error(err);
  toast('初始化失敗：' + err.message);
});
