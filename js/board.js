// 無限畫布：手寫(SVG) / 文字框 / 圖片，雙指縮放平移，復原重做
// 座標系：item 都存「世界座標」，畫面用 translate(x,y) scale(s) 呈現
import { db, uid } from './db.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MIN_S = 0.1, MAX_S = 8, GRID = 24, HISTORY = 100;

const r1 = n => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function h(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// 以中點二次曲線平滑筆跡
function pathData(pts) {
  const [x0, y0] = pts[0];
  if (pts.length === 1) return `M${x0} ${y0}l0.01 0`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += `Q${x} ${y} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + `L${lx} ${ly}`;
}

const boxes = new WeakMap();
function bbox(it) {
  let b = boxes.get(it);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of it.pts) {
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    boxes.set(it, b);
  }
  return b;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

function strokeHit(it, p, r) {
  const rr = r + it.width / 2;
  const b = bbox(it);
  if (p.x < b[0] - rr || p.x > b[2] + rr || p.y < b[1] - rr || p.y > b[3] + rr) return false;
  const pts = it.pts;
  if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= rr;
  for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1], pts[i]) <= rr) return true;
  return false;
}

// 手機照片動輒 4000px / 5MB，先縮到 2000px 內再存
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('無法讀取圖片'));
      i.src = url;
    });
    const w = img.naturalWidth, ht = img.naturalHeight;
    const k = Math.min(1, 2000 / Math.max(w, ht));
    if (k === 1 && file.size < 1.5e6) return { blob: file, w, h: ht };
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(ht * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(resolve => c.toBlob(resolve, type, 0.85));
    return { blob: blob || file, w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class Board {
  constructor(vp, cb = {}) {
    this.vp = vp;
    this.cb = cb;
    this.world = h('div', 'world');
    this.imgLayer = h('div', 'layer');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'ink');
    this.textLayer = h('div', 'layer');
    this.world.append(this.imgLayer, this.svg, this.textLayer);
    vp.append(this.world);

    this.items = [];          // 視為不可變：要改某個 item 先 _own() 複製
    this.els = new Map();     // item.id -> DOM
    this.urls = new Map();    // blobId -> objectURL
    this.view = { x: 0, y: 0, s: 1 };
    this.style = {
      pen: { color: '#1f2937', width: 3 },
      hl: { color: '#fde047', width: 20 },
    };
    this.fingerDraws = true;  // 偵測到觸控筆後自動改成手指只負責移動
    this.pointers = new Map();
    this.action = null;
    this.editing = null;
    this.selected = null;
    this.undoStack = [];
    this.redoStack = [];
    this.rect = vp.getBoundingClientRect();
    this.setTool('pen');
    this._bind();
  }

  // ---------- public ----------
  load(doc) {
    this.action = null;
    this.pointers.clear();
    this.editing = null;
    this.selected = null;
    this.items = doc?.items ?? [];
    this.undoStack = [];
    this.redoStack = [];
    this._renderAll();
    const v = doc?.view ?? { x: 40, y: 40, s: 1 };
    this.setView(v.x, v.y, v.s, true);
    this.cb.onSelect?.(false);
    this._history();
  }

  setTool(t) {
    this.commitText();
    this.tool = t;
    this.vp.dataset.tool = t;
    if (t !== 'select') this.select(null);
  }

  setView(x, y, s, silent = false) {
    this.view = { x, y, s };
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    this.world.style.setProperty('--inv', 1 / s);
    const g = GRID * s;
    this.vp.style.backgroundSize = `${g}px ${g}px`;
    this.vp.style.backgroundPosition = `${x}px ${y}px`;
    this.vp.classList.toggle('no-grid', s < 0.35);
    this.cb.onView?.(this.view, silent);
  }

  zoomAt(px, py, f) {
    const { x, y, s } = this.view;
    const ns = clamp(s * f, MIN_S, MAX_S);
    this.setView(px - (px - x) * ns / s, py - (py - y) * ns / s, ns);
  }

  zoomTo(s) {
    const r = this.vp.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, s / this.view.s);
  }

  toWorld(cx, cy) {
    const r = this.rect;
    return { x: (cx - r.left - this.view.x) / this.view.s, y: (cy - r.top - this.view.y) / this.view.s };
  }

  select(id) {
    if (this.selected === id) return;
    this.els.get(this.selected)?.classList.remove('selected');
    this.selected = id;
    this.els.get(id)?.classList.add('selected');
    this.cb.onSelect?.(!!id);
  }

  deleteSelected() {
    const id = this.selected;
    if (!id) return;
    this.commitText();
    this.select(null);
    if (!this.items.some(x => x.id === id)) return;
    const before = this._snap();
    this.items = this.items.filter(x => x.id !== id);
    this._unmount(id);
    this._commit(before);
  }

  undo() {
    this.commitText();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.items);
    this.items = this.undoStack.pop();
    this._renderAll();
    this._history();
    this.cb.onChange?.();
  }

  redo() {
    this.commitText();
    if (!this.redoStack.length) return;
    this.undoStack.push(this.items);
    this.items = this.redoStack.pop();
    this._renderAll();
    this._history();
    this.cb.onChange?.();
  }

  async addImage(file) {
    const { blob, w, h: ih } = await prepareImage(file);
    const blobId = uid();
    await db.put('blobs', blob, blobId);
    this.urls.set(blobId, URL.createObjectURL(blob));

    this.rect = this.vp.getBoundingClientRect();
    const r = this.rect, s = this.view.s;
    const k = Math.min(1 / s, (r.width * 0.8 / s) / w, (r.height * 0.8 / s) / ih);
    const iw = w * k, ihh = ih * k;
    const c = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const item = { id: uid(), type: 'image', blobId, x: r1(c.x - iw / 2), y: r1(c.y - ihh / 2), w: r1(iw), h: r1(ihh) };

    const before = this._snap();
    this.items.push(item);
    this._mount(item);
    this._commit(before);
    this.select(item.id);
  }

  // 結束目前的文字編輯（會觸發 focusout 存檔）
  commitText() {
    const a = document.activeElement;
    if (a?.classList?.contains('text-item')) a.blur();
  }

  // ---------- events ----------
  _bind() {
    const vp = this.vp;
    vp.addEventListener('pointerdown', e => this._down(e));
    vp.addEventListener('pointermove', e => this._move(e));
    vp.addEventListener('pointerup', e => this._up(e));
    vp.addEventListener('pointercancel', e => this._up(e));
    vp.addEventListener('wheel', e => this._wheel(e), { passive: false });
    vp.addEventListener('contextmenu', e => { if (!e.target.isContentEditable) e.preventDefault(); });
    // focus 到文字框時瀏覽器可能偷偷捲動 overflow:hidden 的容器，強制歸零
    vp.addEventListener('scroll', () => { vp.scrollTop = 0; vp.scrollLeft = 0; });
    this.textLayer.addEventListener('focusin', e => this._focusIn(e));
    this.textLayer.addEventListener('focusout', e => this._focusOut(e));
    this.textLayer.addEventListener('input', () => this._input());
    this.textLayer.addEventListener('paste', e => {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    window.addEventListener('resize', () => { this.rect = vp.getBoundingClientRect(); });
  }

  _touches() {
    return [...this.pointers.values()].filter(p => p.type === 'touch');
  }

  _down(e) {
    this.rect = this.vp.getBoundingClientRect();
    if (e.pointerType === 'mouse' && e.button !== 0) {
      if (e.button === 1 && !this.action) {
        e.preventDefault();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'mouse' });
        this._startPan(e, null);
      }
      return;
    }

    const isPen = e.pointerType === 'pen';
    const isTouch = e.pointerType === 'touch';

    if (isTouch && e.isPrimary) {
      // 新的觸控序列開始：清掉可能殘留的舊觸控點
      for (const [id, p] of this.pointers) if (p.type === 'touch') this.pointers.delete(id);
      if (this.action && this.action.ptype !== 'pen') this.action = null;
    }
    if (isPen) {
      if (this.fingerDraws) {
        this.fingerDraws = false;
        this.cb.onPenDetected?.();
      }
      if (this.action && this.action.ptype !== 'pen') this._abort();
    } else if (isTouch && this.action?.ptype === 'pen') {
      return; // 觸控筆書寫中，忽略手掌
    }

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (isTouch) {
      const t = this._touches();
      if (t.length >= 2) {
        if (this.action?.kind !== 'gesture') {
          this._abort();
          this._startGesture(t);
        }
        return;
      }
    }
    if (this.action) return;

    const textEl = e.target.closest('.text-item');
    if (textEl && (this.tool === 'text' || textEl === document.activeElement)) return; // 交給瀏覽器放游標

    e.preventDefault();
    this.commitText();
    try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const w = this.toWorld(e.clientX, e.clientY);
    const base = { id: e.pointerId, ptype: e.pointerType };
    const drawTool = this.tool === 'pen' || this.tool === 'hl' || this.tool === 'eraser';

    if (drawTool && !(isTouch && !this.fingerDraws)) {
      if (this.tool === 'eraser') {
        this.action = { ...base, kind: 'erase', before: this._snap(), hit: false, last: w };
        this._eraseAt(w);
      } else {
        this._startStroke(base, w);
      }
      return;
    }

    if (this.tool === 'select') {
      const itemEl = e.target.closest('.item');
      if (itemEl) {
        const id = itemEl.dataset.id;
        const before = this._snap();
        const item = this._own(id);
        this.select(id);
        if (e.target.closest('.handle')) {
          this.action = { ...base, kind: 'resize', item, before, start: w, ow: item.w, ratio: item.h / item.w };
        } else {
          this.action = { ...base, kind: 'move', item, before, start: w, ox: item.x, oy: item.y, moved: false };
        }
        return;
      }
    }

    this._startPan(e, w);
  }

  _startPan(e, w) {
    this.action = {
      id: e.pointerId, ptype: e.pointerType, kind: 'pan',
      sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, at: w,
    };
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const a = this.action;
    if (!a) return;
    if (a.kind === 'gesture') return this._gesture();
    if (a.id !== e.pointerId) return;

    if (a.kind === 'draw') {
      const evs = e.getCoalescedEvents?.();
      for (const ev of evs?.length ? evs : [e]) this._addPoint(a, this.toWorld(ev.clientX, ev.clientY));
      a.path.setAttribute('d', pathData(a.item.pts));
    } else if (a.kind === 'erase') {
      this._eraseAt(this.toWorld(e.clientX, e.clientY));
    } else if (a.kind === 'pan') {
      const dx = e.clientX - a.sx, dy = e.clientY - a.sy;
      if (!a.moved && Math.hypot(dx, dy) < 6) return;
      a.moved = true;
      this.setView(a.vx + dx, a.vy + dy, this.view.s);
    } else if (a.kind === 'move') {
      const w = this.toWorld(e.clientX, e.clientY);
      const dx = w.x - a.start.x, dy = w.y - a.start.y;
      if (!a.moved && Math.hypot(dx, dy) * this.view.s < 6) return;
      a.moved = true;
      a.item.x = r1(a.ox + dx);
      a.item.y = r1(a.oy + dy);
      this._place(a.item);
    } else if (a.kind === 'resize') {
      const w = this.toWorld(e.clientX, e.clientY);
      const nw = Math.max(24 / this.view.s, a.ow + w.x - a.start.x);
      a.item.w = r1(nw);
      a.item.h = r1(nw * a.ratio);
      this._place(a.item);
    }
  }

  _up(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    const a = this.action;
    if (!a) return;
    if (a.kind === 'gesture') {
      if (this._touches().length < 2) this.action = this.pointers.size ? { kind: 'idle' } : null;
      return;
    }
    if (a.kind === 'idle') {
      if (!this.pointers.size) this.action = null;
      return;
    }
    if (a.id !== e.pointerId) return;
    this.action = null;

    switch (a.kind) {
      case 'draw':
        this.items.push(a.item);
        this._commit(a.before);
        break;
      case 'erase':
        if (a.hit) this._commit(a.before);
        break;
      case 'move':
        if (a.moved) this._commit(a.before);
        else if (a.item.type === 'text') this._focusText(a.item.id);
        break;
      case 'resize':
        this._commit(a.before);
        break;
      case 'pan':
        if (a.moved || !a.at) break;
        if (this.tool === 'text') this._newText(a.at);
        else if (this.tool === 'select') this.select(null);
        break;
    }
  }

  // 被雙指手勢或觸控筆打斷的動作
  _abort() {
    const a = this.action;
    this.action = null;
    if (!a) return;
    if (a.kind === 'draw') a.path.remove();
    else if ((a.kind === 'move' && a.moved) || a.kind === 'resize' || (a.kind === 'erase' && a.hit)) this._commit(a.before);
  }

  _startGesture([a, b]) {
    this.action = { kind: 'gesture', a, b, d0: Math.max(dist(a, b), 1), m0: mid(a, b), v0: { ...this.view } };
  }

  _gesture() {
    const g = this.action, r = this.rect;
    const m = mid(g.a, g.b);
    const s = clamp(g.v0.s * dist(g.a, g.b) / g.d0, MIN_S, MAX_S);
    const wx = (g.m0.x - r.left - g.v0.x) / g.v0.s;
    const wy = (g.m0.y - r.top - g.v0.y) / g.v0.s;
    this.setView(m.x - r.left - wx * s, m.y - r.top - wy * s, s);
  }

  _wheel(e) {
    e.preventDefault();
    this.rect = this.vp.getBoundingClientRect();
    const k = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX - this.rect.left, e.clientY - this.rect.top, Math.exp(-e.deltaY * k * 0.01));
    } else {
      this.setView(this.view.x - e.deltaX * k, this.view.y - e.deltaY * k, this.view.s);
    }
  }

  // ---------- ink ----------
  _startStroke(base, w) {
    const st = this.style[this.tool];
    const item = {
      id: uid(), type: 'stroke', tool: this.tool, color: st.color,
      width: Math.round(st.width / this.view.s * 100) / 100, // 粗細以「螢幕上看起來」為準
      pts: [[r1(w.x), r1(w.y)]],
    };
    const path = this._mount(item);
    this.action = { ...base, kind: 'draw', item, path, before: this._snap() };
  }

  _addPoint(a, w) {
    const last = a.item.pts[a.item.pts.length - 1];
    if (Math.hypot(w.x - last[0], w.y - last[1]) * this.view.s < 1.5) return;
    a.item.pts.push([r1(w.x), r1(w.y)]);
  }

  _eraseAt(w) {
    const a = this.action, r = 10 / this.view.s;
    const steps = Math.max(1, Math.ceil(dist(a.last, w) / r));
    const samples = [];
    for (let i = 1; i <= steps; i++) {
      samples.push({ x: a.last.x + (w.x - a.last.x) * i / steps, y: a.last.y + (w.y - a.last.y) * i / steps });
    }
    a.last = w;
    const keep = this.items.filter(it => {
      if (it.type !== 'stroke' || !samples.some(p => strokeHit(it, p, r))) return true;
      this._unmount(it.id);
      return false;
    });
    if (keep.length !== this.items.length) {
      this.items = keep;
      a.hit = true;
    }
  }

  // ---------- text ----------
  _newText(w) {
    const size = r1(18 / this.view.s);
    const item = { id: uid(), type: 'text', x: r1(w.x), y: r1(w.y - size * 0.8), size, text: '' };
    const before = this._snap();
    this.items.push(item);
    this._mount(item);
    this.editing = { id: item.id, item, before, orig: '', created: true };
    this._focusText(item.id);
  }

  _focusText(id) {
    const el = this.els.get(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  _focusIn(e) {
    const el = e.target.closest?.('.text-item');
    if (!el) return;
    const id = el.dataset.id;
    if (this.editing?.id === id) return;
    const before = this._snap();
    const item = this._own(id);
    this.editing = { id, item, before, orig: item.text, created: false };
  }

  _input() {
    const ed = this.editing;
    if (!ed) return;
    ed.item.text = this.els.get(ed.id).innerText;
    this.cb.onChange?.();
  }

  _focusOut(e) {
    const ed = this.editing;
    if (!ed || e.target.dataset?.id !== ed.id) return;
    this.editing = null;
    const text = e.target.innerText.replace(/\n+$/, '');
    ed.item.text = text;
    if (!text.trim()) {
      this.items = this.items.filter(x => x.id !== ed.id);
      if (this.selected === ed.id) this.select(null);
      this._unmount(ed.id);
      if (ed.created) this.cb.onChange?.();
      else this._commit(ed.before);
    } else if (ed.created || text !== ed.orig) {
      this._commit(ed.before);
    }
  }

  // ---------- render ----------
  _mount(item) {
    let el;
    if (item.type === 'stroke') {
      el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', pathData(item.pts));
      el.setAttribute('stroke', item.color);
      el.setAttribute('stroke-width', item.width);
      if (item.tool === 'hl') el.setAttribute('class', 'hl');
      this.svg.append(el);
    } else if (item.type === 'text') {
      el = h('div', 'item text-item');
      el.contentEditable = 'true';
      el.spellcheck = false;
      el.innerText = item.text;
      el.style.fontSize = item.size + 'px';
      this.textLayer.append(el);
    } else if (item.type === 'image') {
      el = h('div', 'item img-item');
      const img = new Image();
      img.alt = '';
      img.draggable = false;
      el.append(img, h('div', 'handle'));
      this._url(item.blobId).then(u => { if (u) img.src = u; });
      this.imgLayer.append(el);
    } else {
      return null;
    }
    el.dataset.id = item.id;
    this.els.set(item.id, el);
    this._place(item);
    return el;
  }

  _unmount(id) {
    this.els.get(id)?.remove();
    this.els.delete(id);
  }

  _place(item) {
    if (item.type === 'stroke') return;
    const el = this.els.get(item.id);
    el.style.left = item.x + 'px';
    el.style.top = item.y + 'px';
    if (item.type === 'image') {
      el.style.width = item.w + 'px';
      el.style.height = item.h + 'px';
    }
  }

  _renderAll() {
    this.svg.replaceChildren();
    this.imgLayer.replaceChildren();
    this.textLayer.replaceChildren();
    this.els.clear();
    for (const it of this.items) this._mount(it);
    if (this.selected && this.els.has(this.selected)) this.els.get(this.selected).classList.add('selected');
    else this.select(null);
  }

  async _url(blobId) {
    if (!this.urls.has(blobId)) {
      const blob = await db.get('blobs', blobId);
      if (!blob) return null;
      this.urls.set(blobId, URL.createObjectURL(blob));
    }
    return this.urls.get(blobId);
  }

  // ---------- history ----------
  _snap() {
    return this.items.slice();
  }

  _own(id) {
    const i = this.items.findIndex(x => x.id === id);
    const copy = { ...this.items[i] };
    this.items[i] = copy;
    return copy;
  }

  _commit(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this._history();
    this.cb.onChange?.();
  }

  _history() {
    this.cb.onHistory?.(this.undoStack.length > 0, this.redoStack.length > 0);
  }
}
