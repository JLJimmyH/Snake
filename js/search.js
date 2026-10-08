// 搜尋這一頁的文字：Ctrl+F 開畫布右上角的搜尋列，Ctrl+Shift+F 開側欄的搜尋面板，兩個共用同一組結果。
// 找的是畫面上顯示的文字（markdown 符號不算），結果用世界座標的框標在畫布上，跟著縮放；
// 縮小到字看不清楚時改成固定大小的圓點，小地圖上也有標記。手寫筆跡不搜尋。

const MAX_HITS = 2000;
const FAR = 10;       // 結果在螢幕上矮於這麼多 px 就改畫圓點
const READABLE = 14;  // 跳過去時至少放大到字有這麼高（px）
const SNIPPET = 24;   // 側欄結果在符合處前面留幾個字

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// 文字框裡的所有文字節點接成一個字串，記住每個節點從哪裡開始；<br> 當換行
function flatten(body) {
  const parts = [];
  let text = '';
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n; (n = walker.nextNode());) {
    if (n.nodeType === Node.TEXT_NODE) { parts.push({ node: n, at: text.length }); text += n.data; }
    else if (n.tagName === 'BR') text += '\n';
  }
  return { text, parts };
}

// 字串位置 → (文字節點, offset)；end＝這是結尾，落在節點邊界時算前一個節點
function locate(parts, i, end) {
  for (const p of parts) {
    const len = p.node.length;
    if (end ? i > p.at && i <= p.at + len : i >= p.at && i < p.at + len) return { node: p.node, offset: i - p.at };
  }
  return null;
}

function snippet(text, start, end) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = text.length;
  const from = Math.max(lineStart, start - SNIPPET);
  return {
    before: (from > lineStart ? '…' : '') + text.slice(from, start).trimStart(),
    match: text.slice(start, end),
    after: text.slice(end, Math.min(lineEnd, end + 80)),
  };
}

export function setupSearch({ board, minimap, refreshNav, showSidebar, hideSidebar, top }) {
  const $ = s => document.querySelector(s);
  const bar = $('#find'), input = $('#find-input'), count = $('#find-count');
  const pane = $('#search-pane'), paneInput = $('#sp-input'), summary = $('#sp-summary'), list = $('#sp-results');
  const tabs = { pages: $('#tab-pages'), search: $('#tab-search') };
  const layer = h('div', 'layer search-layer');
  board.world.insertBefore(layer, board.uiLayer);

  let query = '', caseSensitive = false;
  let hits = [];   // { id, key, rects: [{x, y, w, h}], box: {x0, y0, x1, y1}, snip, els }
  let cur = -1;
  let timer = 0;

  const active = () => !bar.hidden || !pane.hidden;

  // ---------- 搜尋 ----------
  function find() {
    if (!query || !active()) return [];
    const re = new RegExp(escape(query), caseSensitive ? 'gu' : 'giu');
    const vp = board.vp.getBoundingClientRect(), { x: vx, y: vy, s } = board.view;
    const out = [];
    const texts = board.items.filter(it => it.type === 'text')
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of texts) {
      const body = board.els.get(it.id)?.querySelector('.text-body');
      if (!body) continue;
      const { text, parts } = flatten(body);
      let n = 0;
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        const a = locate(parts, m.index, false), b = locate(parts, m.index + m[0].length, true);
        if (!a || !b) continue;
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => ({
          x: (r.left - vp.left - vx) / s, y: (r.top - vp.top - vy) / s, w: r.width / s, h: r.height / s,
        }));
        if (!rects.length) continue;
        const box = {
          x0: Math.min(...rects.map(r => r.x)), y0: Math.min(...rects.map(r => r.y)),
          x1: Math.max(...rects.map(r => r.x + r.w)), y1: Math.max(...rects.map(r => r.y + r.h)),
        };
        out.push({ id: it.id, key: it.id + ':' + n++, rects, box, snip: snippet(text, m.index, m.index + m[0].length) });
        if (out.length >= MAX_HITS) return out;
      }
    }
    return out;
  }

  // 內容變了重新找；目前這一個盡量留在同一個（同一個文字框裡第幾個）
  function refresh({ keep = true } = {}) {
    clearTimeout(timer);
    timer = 0;
    const key = keep ? hits[cur]?.key : null, was = cur;
    hits = find();
    cur = key ? hits.findIndex(x => x.key === key) : -1;
    // 原本那一個被刪掉了：留在同一個位置
    if (key && cur < 0) cur = Math.min(was, hits.length - 1);
    render();
  }

  function schedule() {
    if (!active() || !query) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  }

  // ---------- 畫面 ----------
  function render() {
    const s = board.view.s;
    layer.replaceChildren();
    hits.forEach((hit, i) => {
      hit.els = hit.rects.map((r, k) => {
        const el = h('div', 'search-hit' + (k === 0 ? ' lead' : '') + (i === cur ? ' current' : ''));
        Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        layer.append(el);
        return el;
      });
    });
    lastFar = null;
    updateFar(s);
    renderCount();
    renderList();
    minimap.marks = hits.length ? { boxes: hits.map(x => x.box), cur } : null;
    refreshNav();
  }

  // 縮小到看不清楚時改畫圓點；只在跨過門檻時改 class
  let lastFar = null;
  function updateFar(s) {
    if (!hits.length) return;
    const sig = hits.map(x => (x.box.y1 - x.box.y0) * s < FAR ? 1 : 0).join('');
    if (sig === lastFar) return;
    lastFar = sig;
    hits.forEach((hit, i) => hit.els[0].classList.toggle('far', sig[i] === '1'));
  }

  function renderCount() {
    const n = hits.length, more = n >= MAX_HITS ? '+' : '';
    const text = !query ? '' : !n ? '無結果' : `${cur >= 0 ? cur + 1 : '?'} / ${n}${more}`;
    count.textContent = text;
    bar.classList.toggle('none', !!query && !n);
    for (const id of ['#find-prev', '#find-next', '#find-all']) $(id).disabled = !n;
    summary.textContent = !query ? '輸入文字搜尋這一頁（手寫筆跡不會被搜尋）' : !n ? '這一頁沒有符合的文字' : `這一頁有 ${n}${more} 個結果`;
  }

  function renderList() {
    list.replaceChildren(...hits.map((hit, i) => {
      const row = h('button', 'sp-hit' + (i === cur ? ' current' : ''));
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === cur));
      row.append(h('span', '', hit.snip.before), h('mark', '', hit.snip.match), h('span', '', hit.snip.after));
      return row;
    }));
  }

  function setCurrent(i) {
    hits[cur]?.els.forEach(el => el.classList.remove('current'));
    list.children[cur]?.classList.remove('current');
    list.children[cur]?.setAttribute('aria-selected', 'false');
    cur = i;
    hits[cur]?.els.forEach(el => el.classList.add('current'));
    const row = list.children[cur];
    if (row) {
      row.classList.add('current');
      row.setAttribute('aria-selected', 'true');
      row.scrollIntoView({ block: 'nearest' });
    }
    renderCount();
    if (minimap.marks) minimap.marks.cur = cur;
    refreshNav();
  }

  // 跳到第 i 個：字太小先放大到看得清楚；已經在畫面裡就不動
  function go(i) {
    if (!hits.length) return;
    setCurrent((i + hits.length) % hits.length);
    const b = hits[cur].box, v = board.view;
    const w = board.vp.clientWidth, ht = board.vp.clientHeight;
    let s = v.s;
    if ((b.y1 - b.y0) * s < READABLE) s = Math.min(8, READABLE / (b.y1 - b.y0));
    const x0 = b.x0 * s + v.x, y0 = b.y0 * s + v.y, x1 = b.x1 * s + v.x, y1 = b.y1 * s + v.y;
    const pad = 40, padTop = bar.hidden ? pad : 72;
    if (s === v.s && x0 >= pad && x1 <= w - pad && y0 >= padTop && y1 <= ht - pad) return;
    board.animateView(w / 2 - (b.x0 + b.x1) / 2 * s, ht / 2 - (b.y0 + b.y1) / 2 * s, s);
  }

  function showAll() {
    if (!hits.length) return;
    const b = hits.reduce((a, x) => ({
      x0: Math.min(a.x0, x.box.x0), y0: Math.min(a.y0, x.box.y0), x1: Math.max(a.x1, x.box.x1), y1: Math.max(a.y1, x.box.y1),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    board.fitBounds(b);
  }

  // 新的搜尋字：不移動畫面，目前這一個先選畫面裡的第一個
  function setQuery(q, from) {
    query = q;
    if (from !== input) input.value = q;
    if (from !== paneInput) paneInput.value = q;
    hits = find();
    const v = board.viewBounds();
    cur = hits.findIndex(x => x.box.x0 >= v.x0 && x.box.x1 <= v.x1 && x.box.y0 >= v.y0 && x.box.y1 <= v.y1);
    render();
  }

  function setCase(on) {
    caseSensitive = on;
    for (const b of document.querySelectorAll('.find-case')) b.setAttribute('aria-pressed', String(on));
    setQuery(query);
  }

  function clear() {
    hits = [];
    cur = -1;
    layer.replaceChildren();
    list.replaceChildren();
    minimap.marks = null;
    refreshNav();
  }

  // ---------- 開關 ----------
  function prefill() {
    const sel = getSelection()?.toString().trim();
    return sel && !sel.includes('\n') && sel.length <= 100 ? sel : null;
  }

  function placeBar() { bar.style.top = top() + 8 + 'px'; }

  function openBar() {
    const sel = prefill();
    bar.hidden = false;
    placeBar();
    if (sel) setQuery(sel); else if (query) refresh();
    input.focus();
    input.select();
  }

  function closeBar() {
    bar.hidden = true;
    if (!active()) clear();
  }

  function setTab(name) {
    const search = name === 'search';
    pane.hidden = !search;
    $('#pages-pane').hidden = search;
    for (const [k, t] of Object.entries(tabs)) t.setAttribute('aria-selected', String(k === name));
    if (search) { if (query) refresh(); else renderCount(); }
    else if (!active()) clear();
  }

  function openPane() {
    const sel = prefill();
    showSidebar();
    setTab('search');
    if (sel) setQuery(sel);
    paneInput.focus();
    paneInput.select();
  }

  // ---------- 事件 ----------
  for (const el of [input, paneInput]) {
    el.addEventListener('input', () => setQuery(el.value, el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? cur - 1 : cur < 0 ? 0 : cur + 1); }
      else if (e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); setCase(!caseSensitive); }
      else if (e.key === 'Escape' && el === input) { e.preventDefault(); closeBar(); }
    });
  }
  $('#find-prev').addEventListener('click', () => go(cur < 0 ? -1 : cur - 1));
  $('#find-next').addEventListener('click', () => go(cur + 1));
  $('#find-all').addEventListener('click', showAll);
  $('#find-list').addEventListener('click', openPane);
  $('#find-close').addEventListener('click', closeBar);
  for (const b of document.querySelectorAll('.find-case')) b.addEventListener('click', () => setCase(!caseSensitive));
  tabs.pages.addEventListener('click', () => setTab('pages'));
  tabs.search.addEventListener('click', () => { setTab('search'); paneInput.focus(); });
  list.addEventListener('click', e => {
    const row = e.target.closest('.sp-hit');
    if (!row) return;
    go(+row.dataset.i);
    hideSidebar(); // 手機：側欄蓋住畫布，點了結果就收起來
  });

  // Ctrl+F／Ctrl+Shift+F 用自己的搜尋（編輯文字時也是）；F3／Shift+F3 下一個／上一個
  window.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      e.shiftKey ? openPane() : openBar();
    } else if (e.key === 'F3' && query && active()) {
      e.preventDefault();
      go(e.shiftKey ? cur - 1 : cur + 1);
    }
  }, true);
  window.addEventListener('resize', () => { if (!bar.hidden) placeBar(); });
  document.fonts?.ready.then(schedule);

  return {
    open: openBar,
    // 換頁：保留搜尋字，結果重新找
    loaded() { if (query && active()) refresh({ keep: false }); },
    changed: schedule,
    view(v) { updateFar(v.s); },
  };
}
