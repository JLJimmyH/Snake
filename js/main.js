import { db, uid, newNotebook, pagesOf } from './db.js';
import { setupAppearance } from './appearance.js';
import { setupShortcuts } from './shortcuts.js';
import { setupInputMode } from './input-mode.js';
import { Board, FONTS } from './board.js';
import { Minimap } from './minimap.js';
import { cleanName } from './notebook-core.js';
import { setupNotebooks } from './notebook-ui.js';
import { setupAi, peekClipboard } from './ai-ui.js';
import { setupExport } from './export.js';
import { setupSearch } from './search.js';
import { htmlToMarkdown, htmlToText, fenceCode } from './markdown.js';
import { BUILD } from './build.js';

// index.html 跟 JS 不是同一版（瀏覽器快取了舊的 index.html，見 scripts/stamp.mjs）：
// 重新抓 index.html 再重新整理，每一版只試一次；在任何用到畫面元素的程式之前檢查
function staleHtml() {
  const html = document.querySelector('meta[name=build]')?.content;
  if (!html || html === BUILD) return false;
  try {
    if (sessionStorage.getItem('reloadFor') === BUILD) return false;
    sessionStorage.setItem('reloadFor', BUILD);
  } catch { return false; }
  fetch(location.href, { cache: 'reload' }).catch(() => {}).finally(() => location.reload());
  return true;
}
if (staleHtml()) throw new Error('index.html 是舊版，重新整理中');

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
let ai = null;
let search = null;
let lastLocalPage = null;
let contextReady = false; // Board 建構時就會通知，等工具列的元素都準備好再更新

const board = new Board($('#viewport'), {
  onChange: () => { contentChanged = true; scheduleSave(); refreshNav(); search?.changed(); },
  onRemote: () => { refreshNav(); search?.changed(); },
  onLoad: () => search?.loaded(),
  onView: (v, silent) => {
    $('#zoom').textContent = Math.round(v.s * 100) + '%';
    refreshNav();
    search?.view(v);
    if (!silent) scheduleSave();
  },
  onSelect: count => { $('#btn-del').disabled = !count; },
  onTool: t => setTool(t),
  onContext: () => { if (contextReady) refreshContext(); },
  onHistory: (canUndo, canRedo) => {
    $('#btn-undo').disabled = !canUndo;
    $('#btn-redo').disabled = !canRedo;
  },
  // 最後一次調整的字級當新文字框的預設，記在這台裝置
  onTextSize: size => { try { localStorage.setItem('textSize', size); } catch { /* ignore */ } },
});
try {
  const size = Number(localStorage.getItem('textSize'));
  if (size > 0) board.style.text.size = size;
} catch { /* ignore */ }

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
  notebooks?.changed();
}

async function flush() {
  board.commitText();
  await persist();
}

// 存進 IndexedDB 但不結束正在編輯的文字框（背景自動同步用）
async function persist() {
  if (saveTimer) await saveNow();
}

document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', () => { flush(); });

// ---------- 頁面資料 ----------
const byId = id => pages.find(p => p.id === id);
const kids = pid => pages.filter(p => (p.parentId ?? null) === pid).sort((a, b) => a.order - b.order);
const savePage = p => db.put('pages', p);

// 整本的頁面，照側欄樹的順序
function treeOrder() {
  const out = [];
  const walk = pid => kids(pid).forEach(p => { out.push(p); walk(p.id); });
  walk(null);
  return out;
}

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
  search?.pagesChanged();
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
    if (en.sep) {
      m.append(Object.assign(document.createElement('hr'), { className: 'menu-sep' }));
      continue;
    }
    const b = document.createElement('button');
    b.textContent = en.label;
    // hint：靠右的小字（例如筆記本的儲存狀態圖示）
    if (en.hint) b.append(Object.assign(document.createElement('span'), { className: 'menu-hint', textContent: en.hint }));
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

// 工具列第一組按鈕依序對應 Esc、Q、W、E、R、T、Y…（隱藏的不算），提示文字與快捷鍵面板跟著更新
const TOOL_KEYS = ['Esc', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U'];
function updateToolKeys() {
  const rows = [];
  $$('#toolbar .tb-group:first-child .tbtn').forEach(b => {
    const key = b.hidden ? null : TOOL_KEYS[rows.length / 2];
    b.dataset.key = key?.toLowerCase() ?? '';
    b.title = key ? `${b.dataset.name} (${key})` : b.dataset.name;
    if (!key) return;
    const dt = document.createElement('dt'), kbd = document.createElement('kbd'), dd = document.createElement('dd');
    kbd.textContent = key;
    dt.append(kbd);
    dd.textContent = b.dataset.name;
    rows.push(dt, dd);
  });
  $('#tool-keys').replaceChildren(...rows);
}

// 滑鼠模式不需要套索：選取工具在空白處拖曳就是框選
function onInputMode(mode) {
  $('.tool[data-tool=lasso]').hidden = mode === 'mouse';
  if (mode === 'mouse' && board.tool === 'lasso') setTool('select');
  updateToolKeys();
}

function closeBrushPalettes(restoreFocus = false) {
  for (const panel of $$('.brush-palette')) {
    if (panel.hidden) continue;
    panel.hidden = true;
    const toggle = $(`[aria-controls="${panel.id}"]`);
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  }
}

// 選取工具下選中筆跡時，筆／螢光筆的設定改的是那些筆跡，工具還是選取；不然改的是畫筆
const brushValue = group => board.strokeFormat(group.dataset.for) ?? board.style[group.dataset.for];

function setBrush(group, key, value, live = false) {
  const tool = group.dataset.for;
  if (board.strokeTargets(tool).length) board.setStrokeStyle(tool, key, value, live);
  else { board.style[tool][key] = value; syncBrush(group); }
}

function syncBrush(group) {
  const { color, width } = brushValue(group);
  group.querySelector('input[type=color]').value = color;
  group.querySelector('.palette-toggle').style.setProperty('--brush-color', color);
  group.querySelectorAll('.swatch').forEach(button => {
    const active = button.dataset.color === color;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  group.querySelector('input[type=range]').value = width;
  const box = group.querySelector('.width-input');
  if (document.activeElement !== box) box.value = width;  // 正在輸入時不要蓋掉
}

// 筆寬：滑桿和輸入框都是 0.5–100，取到小數第二位
const MIN_WIDTH = 0.5, MAX_WIDTH = 100;
const roundWidth = value => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) * 100) / 100;

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.brush-palette, .palette-toggle')) closeBrushPalettes();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeBrushPalettes(true);
});
$('#toolbar').addEventListener('scroll', () => closeBrushPalettes());
window.addEventListener('resize', () => closeBrushPalettes());

function togglePalette(toggle) {
  $('#brush-preview').hidden = true;
  const panel = $('#' + toggle.getAttribute('aria-controls'));
  const opening = panel.hidden;
  closeBrushPalettes();
  if (!opening) return;
  const rect = toggle.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(innerWidth - 248, rect.left)) + 'px';
  panel.style.top = Math.min(innerHeight - 168, rect.bottom + 8) + 'px';
  panel.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
}

$$('.opts').forEach(group => {
  const style = board.style[group.dataset.for];
  group.addEventListener('click', e => {
    const toggle = e.target.closest('.palette-toggle');
    const sw = e.target.closest('.swatch');
    const wb = e.target.closest('.wbtn');
    const md = e.target.closest('[data-mode]');
    if (toggle) {
      togglePalette(toggle);
    } else if (md) {
      style.mode = md.dataset.mode;
      group.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === md));
    } else if (sw) {
      setBrush(group, 'color', sw.dataset.color);
      closeBrushPalettes(true);
    } else if (wb) {
      // Eraser still uses size presets; drawing brushes use their sole slider.
      style.width = +wb.dataset.width;
      group.querySelectorAll('.wbtn').forEach(x => x.classList.toggle('active', x === wb));
    }
  });
});

for (const group of $$('.opts[data-for=pen], .opts[data-for=hl]')) {
  const color = group.querySelector('input[type=color]');
  const slider = group.querySelector('input[type=range]');
  const preview = $('#brush-preview');
  const showPreview = () => {
    closeBrushPalettes();
    const rect = slider.getBoundingClientRect();
    preview.style.left = Math.max(8, Math.min(innerWidth - 140, rect.left + rect.width / 2 - 66)) + 'px';
    preview.style.top = Math.min(innerHeight - 148, rect.bottom + 10) + 'px';
    const dot = preview.querySelector('.brush-dot'), style = brushValue(group);
    // 筆寬是畫布上的大小，預覽畫成目前縮放下實際看到的粗細
    dot.style.width = dot.style.height = style.width * board.view.s + 'px';
    // 預覽底色＝畫布底色，筆點顏色跟畫在畫布上一樣
    dot.style.backgroundColor = board.inkColor({ tool: group.dataset.for, color: style.color });
    dot.style.opacity = group.dataset.for === 'hl' ? '.5' : '1';
    preview.querySelector('.brush-caption').textContent = style.width + ' px';
    preview.hidden = false;
  };
  // 拖色盤、滑桿時 input 一直觸發；改選中筆跡時放開（change）才存成一步
  color.addEventListener('input', () => setBrush(group, 'color', color.value, true));
  color.addEventListener('change', () => setBrush(group, 'color', color.value));
  const box = group.querySelector('.width-input');
  const width = () => roundWidth(Number(slider.value));
  slider.addEventListener('input', () => {
    setBrush(group, 'width', width(), true);
    box.value = width();
    showPreview();
  });
  slider.addEventListener('change', () => setBrush(group, 'width', width()));
  slider.addEventListener('pointerdown', showPreview);
  slider.addEventListener('focus', showPreview);
  slider.addEventListener('blur', () => { preview.hidden = true; });
  slider.addEventListener('pointerup', () => { preview.hidden = true; });
  slider.addEventListener('pointercancel', () => { preview.hidden = true; });
  // 直接輸入大小（例如 2.71），Enter 或離開就套用；不是數字就還原
  box.addEventListener('focus', () => box.select());
  box.addEventListener('change', () => {
    const value = Number(box.value.trim());
    if (box.value.trim() && Number.isFinite(value)) setBrush(group, 'width', roundWidth(value));
    box.value = brushValue(group).width;
    slider.value = box.value;
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter') box.blur();
    else if (e.key === 'Escape') { box.value = brushValue(group).width; box.blur(); }
  });
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

// ---------- 文字格式、圖片：跟著選取的物件出現 ----------
const textGroup = $('.ctx[data-ctx=text]');
const imageGroup = $('.ctx[data-ctx=image]');
const sizeInput = textGroup.querySelector('.size-input');
for (const b of $$('.font-opt')) b.style.fontFamily = FONTS[b.dataset.font] ?? '';
contextReady = true;
refreshContext();

function refreshContext() {
  const format = board.textFormat();
  const types = board.selectedTypes();
  const images = !board.readOnly && (board.tool === 'select' || board.tool === 'lasso') && types.size === 1 && types.has('image');
  const strokes = ['pen', 'hl'].filter(t => board.strokeTargets(t).length);
  $('#toolbar').dataset.ctx = [format && 'text', images && 'image', ...strokes].filter(Boolean).join(' ');
  if (!format && !images && !strokes.length) closeBrushPalettes();
  for (const group of $$('.opts[data-for=pen], .opts[data-for=hl]')) syncBrush(group);
  if (format) {
    const press = (el, on) => el.setAttribute('aria-pressed', String(on));
    press(textGroup.querySelector('[data-fmt=bold]'), format.bold);
    press(textGroup.querySelector('[data-fmt=italic]'), format.italic);
    textGroup.querySelector('[aria-controls=text-palette]').style.setProperty('--brush-color', format.color ?? 'var(--text)');
    const size = Math.round(format.size * 10) / 10;
    for (const b of $$('.size-opt')) press(b, +b.dataset.size === size);
    sizeInput.value = size;
    for (const sw of $$('#text-palette .swatch')) press(sw, sw.dataset.color === (format.color ?? ''));
    if (format.color) $('#text-palette input[type=color]').value = format.color;
    // 框線與底色只給已經有的文字框（不記成新文字框的格式）
    const boxToggle = textGroup.querySelector('.box-toggle');
    boxToggle.hidden = !format.box;
    if (!format.box && !$('#box-menu').hidden) closeBrushPalettes();
    Object.assign(boxToggle.querySelector('.box-preview').style, {
      background: format.fill ?? 'transparent',
      border: format.border ? `2px ${format.borderStyle || 'solid'} ${format.border}` : '1.5px solid var(--muted)',
    });
    for (const key of ['border', 'fill']) {
      for (const sw of $$(`#box-menu [data-box=${key}] .swatch`)) press(sw, sw.dataset.color === (format[key] ?? ''));
      if (format[key]) $(`#box-menu input[data-box=${key}]`).value = format[key];
    }
    for (const b of $$('#box-menu [data-bw]')) press(b, !!format.border && +b.dataset.bw === format.borderW);
    for (const b of $$('#box-menu [data-bs]')) press(b, !!format.border && b.dataset.bs === format.borderStyle);
    for (const b of $$('.font-opt')) press(b, b.dataset.font === (format.font ?? ''));
    const font = $(`.font-opt[data-font="${format.font ?? ''}"]`) ?? $('.font-opt[data-font=""]');
    textGroup.querySelector('.font-name').textContent = font.textContent.split(' ')[0];
  }
  const crop = imageGroup.querySelector('[data-img=crop]');
  crop.disabled = board.sel.size !== 1;
  crop.setAttribute('aria-pressed', String(!!board.cropping));
  crop.classList.toggle('active', !!board.cropping);
}

// 按格式按鈕時不要把焦點從編輯中的文字框搶走（自訂顏色除外，見 Board._focusOut）
textGroup.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
textGroup.addEventListener('click', e => {
  const fmt = e.target.closest('[data-fmt]');
  const toggle = e.target.closest('.palette-toggle');
  const sw = e.target.closest('.swatch');
  const font = e.target.closest('.font-opt');
  const size = e.target.closest('.size-opt');
  const line = e.target.closest('.line-opt');
  const box = sw?.closest('[data-box]')?.dataset.box;
  if (toggle) togglePalette(toggle);
  else if (size) { board.setTextSize(+size.dataset.size); closeBrushPalettes(); }
  else if (fmt?.dataset.fmt === 'bigger' || fmt?.dataset.fmt === 'smaller') board.stepTextSize(fmt.dataset.fmt === 'bigger' ? 1 : -1);
  else if (fmt) board.toggleMark(fmt.dataset.fmt);
  else if (box) board.setTextBox(box, sw.dataset.color); // 框線、底色常常一起改，色盤不關
  else if (sw) { board.setTextStyle('color', sw.dataset.color); closeBrushPalettes(); }
  else if (line) line.dataset.bw ? board.setTextBox('borderW', +line.dataset.bw) : board.setTextBox('borderStyle', line.dataset.bs);
  else if (font) { board.setTextStyle('font', font.dataset.font); closeBrushPalettes(); }
});
// 拖色盤時 input 會一直觸發，選定（change）才存，復原才不會一格一格
$('#text-palette input[type=color]').addEventListener('change', e => board.setTextStyle('color', e.target.value));
for (const input of $$('#box-menu input[type=color]')) input.addEventListener('change', () => board.setTextBox(input.dataset.box, input.value));
// 字級框：點了打開預設字級清單，也可以直接輸入數字按 Enter
sizeInput.addEventListener('focus', () => sizeInput.select());
sizeInput.addEventListener('click', () => {
  if (!$('#size-menu').hidden) return;
  togglePalette(sizeInput);
  sizeInput.select();
});
sizeInput.addEventListener('change', () => {
  const size = Number(sizeInput.value);
  if (size > 0) board.setTextSize(size);
  else refreshContext();
  closeBrushPalettes();
});

imageGroup.addEventListener('click', e => {
  const b = e.target.closest('[data-img]');
  if (b?.dataset.img === 'rotate') board.rotateImages(90);
  else if (b?.dataset.img === 'crop') board.cropping ? board.endCrop() : board.startCrop();
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

// ---------- 鍵盤 / 貼上 ----------
const shortcuts = setupShortcuts({ button: $('#btn-shortcuts'), panel: $('#shortcuts-panel') });
const typing = el => el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

// Esc 回到選取工具（編輯文字框時也算）。有色盤、面板或對話框開著時只關掉它們，交給各自的處理。
// 用 window capture 搶在那些處理之前，才看得到它們關掉前的狀態。
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('dialog[open], .brush-palette:not([hidden]), .popover:not([hidden])')) return;
  const a = document.activeElement;
  if (typing(a) && !a.classList.contains('text-body')) return;
  setTool('select');
}, true);

document.addEventListener('keydown', e => {
  if (typing(document.activeElement) || $('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? board.redo() : board.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); board.redo(); return; }
  if (mod && (k === 'b' || k === 'i') && board.textFormat()) { e.preventDefault(); board.toggleMark(k === 'b' ? 'bold' : 'italic'); return; }
  if (mod && k === 'v') plainPaste = e.shiftKey;  // 接著的 paste 事件看這個：Ctrl+Shift+V＝純文字貼上
  if (mod) return;
  if (e.key === 'Enter' && board.cropping) { e.preventDefault(); board.endCrop(); return; }
  if (e.shiftKey && e.code === 'Digit1') { board.fitContent(); return; }
  if (e.shiftKey && e.code === 'Digit0') { board.zoomTo(1); return; }
  if (k === 'm') { setMinimap($('#minimap').hidden); return; }
  // 手機排版沒有「?」按鈕，面板也就不開
  if (e.key === '?' && $('#btn-shortcuts').offsetParent) { shortcuts.toggle(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { board.deleteSelected(); return; }
  if (e.key === ' ') { e.preventDefault(); setSpacePan(true); return; }
  if (e.shiftKey || e.altKey) return;
  $$('#toolbar .tbtn[data-key]').find(b => b.dataset.key === k)?.click();
});

// 按住空白鍵時，左鍵拖曳＝移動畫布
function setSpacePan(on) {
  board.spacePan = on;
  $('#viewport').classList.toggle('space-pan', on);
}
document.addEventListener('keyup', e => {
  if (e.key !== ' ' || !board.spacePan) return;
  e.preventDefault(); // 不讓焦點所在的按鈕被空白鍵按下
  setSpacePan(false);
});
window.addEventListener('blur', () => setSpacePan(false));

let plainPaste = false;
document.addEventListener('paste', async e => {
  const plain = plainPaste;
  plainPaste = false;
  if (typing(document.activeElement) || board.readOnly || $('dialog[open]')) return;
  const clipboard = e.clipboardData;
  if (!clipboard) return;
  const files = [...clipboard.files].filter(file => file.type.startsWith('image/'));
  const text = clipboard.getData('text/plain');
  if (!files.length && !text) return;
  e.preventDefault();
  const position = board.pastePosition();
  // Ctrl+Shift+V 的 paste 事件只給純文字（可能是 markdown）；允許讀剪貼簿的話改讀完整內容，才能從 HTML 取文字
  if (plain) pasteContent((await peekClipboard()) ?? { files, text }, position, 'plain');
  else pasteContent({ files, text: editorCode(text, clipboard.getData('vscode-editor-data')) }, position, 'auto');
});

// 從 VS Code 複製的程式碼：剪貼簿裡有 vscode-editor-data（裡面有語言），包成 ``` 程式碼區塊
const EDITOR_LANG = { shellscript: 'sh', plaintext: '', markdown: null };
function editorCode(text, data) {
  let mode;
  try { mode = JSON.parse(data).mode; } catch { return text; }
  if (typeof mode !== 'string' || !text.trim()) return text;
  const lang = mode in EDITOR_LANG ? EDITOR_LANG[mode] : mode;
  return lang === null ? text : fenceCode(text, lang);
}

// 貼上剪貼簿的內容（Ctrl+V 和右鍵選單共用）。mode：
// auto＝貼上：圖片、複製的物件或 AI 回覆、文字，看剪貼簿裡有什麼；
// plain＝純文字貼上：一律變成一個沒有格式的文字框，有 HTML 就從 HTML 取看得到的文字；
// format＝原始格式貼上：網頁、文件的粗體、標題、清單轉成 markdown；inplace＝原位貼上：複製的物件放回原本的位置
async function pasteContent({ files = [], text = '', html = '' }, position, mode = 'auto') {
  if (board.readOnly) return;
  setTool('select');
  if (mode === 'inplace') {
    if (!ai?.paste(text, position, { inPlace: true })) toast('剪貼簿裡沒有從筆記複製的物件');
    return;
  }
  if (mode === 'plain') {
    const plain = (html && htmlToText(html)) || text;
    if (plain) board.addText(plain, position); else toast('剪貼簿裡沒有文字');
    return;
  }
  const formatted = mode === 'format' && html && htmlToMarkdown(html);
  if (formatted) { board.addText(formatted, position); return; }
  if (files.length) {
    for (let i = 0; i < files.length; i++) {
      try { await board.addImage(files[i], { x: position.x + i * 24, y: position.y + i * 24 }); }
      catch (error) { toast(error.message); }
    }
  } else if (!text) toast('剪貼簿是空的');
  else if (!ai?.paste(text, position)) board.addText(text, position);
}

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
// 附加功能壞掉不能擋住筆記載入。例如剛更新時，瀏覽器快取（GitHub Pages 10 分鐘）可能給新舊混在一起的檔案
function optional(name, setup) {
  try {
    return setup();
  } catch (err) {
    console.error(err);
    toast(`${name}功能載入失敗，筆記不受影響；請重新整理頁面（${err.message}）`);
    return null;
  }
}

async function init() {
  // 小地圖預設：桌機打開、手機收合；之後記住使用者的選擇
  let map = null;
  try { map = localStorage.getItem('minimap'); } catch { /* ignore */ }
  setMinimap(map ? map === '1' : !isMobile());
  optional('外觀設定', () => setupAppearance({ board, button: $('#btn-appearance'), panel: $('#appearance-panel'), onCanvas: refreshNav }));
  optional('輸入模式', () => setupInputMode({ board, panel: $('#appearance-panel'), onChange: onInputMode }));
  ai = optional('AI', () => setupAi({ board, title: () => $('#page-title').value, toast, showMenu, pasteContent }));
  optional('匯出', () => setupExport({ board, title: () => $('#page-title').value, toast, showMenu, ai }));
  search = optional('搜尋', () => setupSearch({
    board, minimap, refreshNav, hideSidebar: closeSidebar, top: () => $('#viewport').offsetTop,
    showSidebar: () => isMobile() ? document.body.classList.add('sb-open') : document.body.classList.remove('sb-collapsed'),
    pages: () => treeOrder().map(p => ({
      id: p.id, title: p.title || '未命名', crumbs: ancestors(p.id).map(a => a.title || '未命名').join(' / '),
    })),
    currentPage: () => current,
    loadItems: async id => (await db.get('docs', id))?.items ?? [],
    openPage: id => { if (byId(id)) return openPage(id); },
  }));
  $('#find-button').addEventListener('click', () => search?.open());
  setTool('select');
  notebooks = optional('筆記本選單', () => setupNotebooks({
    current: () => notebookId, switchTo: switchNotebook, reload: reloadNotebook, create: createNotebook, flush, persist, showMenu, toast,
  }));
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
  toast('初始化失敗，筆記還存在這台裝置上，請重新整理頁面：' + err.message);
});
