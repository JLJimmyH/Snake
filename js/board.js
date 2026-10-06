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

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 從折線挖掉圓 (c, R) 覆蓋的部分，回傳剩下的片段；完全沒碰到回傳 null
function cutStroke(pts, c, R) {
  const R2 = R * R;
  const inside = p => (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2 <= R2;
  if (pts.length === 1) return inside(pts[0]) ? [] : null;
  const out = [];
  let cur = inside(pts[0]) ? null : [pts[0]];
  let touched = !cur;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - c.x, fy = a[1] - c.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R2;
    const disc = B * B - 4 * A * C;
    let lo = 1, hi = 0;
    if (A > 0 && disc > 0) {
      const s = Math.sqrt(disc);
      lo = Math.max(0, (-B - s) / (2 * A));
      hi = Math.min(1, (-B + s) / (2 * A));
    } else if (A === 0 && C <= 0) {
      lo = 0; hi = 1;
    }
    if (lo >= hi) {
      (cur ??= [a]).push(b);
      continue;
    }
    touched = true;
    const at = t => [r1(a[0] + dx * t), r1(a[1] + dy * t)];
    if (lo > 0) (cur ??= [a]).push(at(lo));
    if (cur && cur.length >= 2) out.push(cur);
    cur = hi < 1 ? [at(hi), b] : null;
  }
  if (cur && cur.length >= 2) out.push(cur);
  return touched ? out : null;
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
    this.uiLayer = h('div', 'layer');
    this.selBox = h('div', 'sel-box');
    this.selBox.hidden = true;
    this.uiLayer.append(this.selBox);
    this.world.append(this.imgLayer, this.svg, this.textLayer, this.uiLayer);
    this.cursor = h('div', 'eraser-cursor');
    this.cursor.hidden = true;
    vp.append(this.world, this.cursor);

    this.items = [];          // 視為不可變：要改某個 item 先 _own() 複製
    this.els = new Map();     // item.id -> DOM
    this.urls = new Map();    // blobId -> objectURL
    this.view = { x: 0, y: 0, s: 1 };
    this.style = {
      pen: { color: '#1f2937', width: 3 },
      hl: { color: '#fde047', width: 20 },
      eraser: { mode: 'partial', width: 12 }, // width = 螢幕上的半徑
    };
    this.fingerDraws = true;  // 偵測到觸控筆後自動改成手指只負責移動
    this.pointers = new Map();
    this.action = null;
    this.editing = null;
    this.sel = new Set();
    this.selBounds = null;
    this.undoStack = [];
    this.redoStack = [];
    this.rect = vp.getBoundingClientRect();
    this.setTool('select');
    this._bind();
  }

  // ---------- public ----------
  load(doc) {
    this.action = null;
    this.pointers.clear();
    this.editing = null;
    this.sel = new Set();
    this.items = doc?.items ?? [];
    this.undoStack = [];
    this.redoStack = [];
    this._renderAll();
    const v = doc?.view ?? { x: 40, y: 40, s: 1 };
    this.setView(v.x, v.y, v.s, true);
    this._history();
  }

  setReadOnly(value) {
    this.readOnly = value;
    this.vp.dataset.readonly = String(value);
    for (const body of this.textLayer.querySelectorAll('.text-body')) body.contentEditable = String(!value);
  }

  // Apply committed remote objects without resetting view, history or a gesture.
  applyRemote(items) {
    const next = new Map(items.map(item => [item.id, item]));
    for (const item of this.items) if (!next.has(item.id)) this._unmount(item.id);
    for (const item of items) {
      const old = this._item(item.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
        this._unmount(item.id); this._mount(item);
      }
    }
    this.items = structuredClone(items);
    this.setSelection([...this.sel].filter(id => next.has(id)));
  }

  refreshImages() {
    for (const item of this.items) if (item.type === 'image') {
      const el = this.els.get(item.id);
      this._url(item.blobId).then(url => { if (url && el?.isConnected) el.querySelector('img').src = url; });
    }
  }

  preview(peerId, item) {
    this.previews ??= new Map();
    const old = this.previews.get(peerId);
    old?.remove(); this.previews.delete(peerId);
    if (!item || this.els.has(item.id)) return;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'remote-preview');
    path.setAttribute('d', pathData(item.pts));
    path.setAttribute('stroke', item.color);
    path.setAttribute('stroke-width', item.width);
    path.dataset.previewId = item.id;
    this.svg.append(path); this.previews.set(peerId, path);
  }

  clearPreviews() {
    for (const path of this.previews?.values() ?? []) path.remove();
    this.previews?.clear();
  }

  setTool(t) {
    this.commitText();
    this.tool = t;
    this.vp.dataset.tool = t;
    this.cursor.hidden = true;
    if (t !== 'select' && t !== 'lasso') this.setSelection([]);
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

  setSelection(ids) {
    for (const id of this.sel) this.els.get(id)?.classList.remove('selected');
    this.sel = new Set(ids);
    // 只有單選時顯示縮放把手
    if (this.sel.size === 1) this.els.get(ids[0])?.classList.add('selected');
    this._updateSelBox();
    this.cb.onSelect?.(this.sel.size);
  }

  deleteSelected() {
    if (this.readOnly) return;
    if (!this.sel.size) return;
    this.commitText();
    const ids = this.sel;
    this.setSelection([]);
    const n = this.items.length;
    const before = this._snap();
    this.items = this.items.filter(x => !ids.has(x.id));
    if (this.items.length === n) return;
    ids.forEach(id => this._unmount(id));
    this._commit(before);
  }

  undo() {
    if (this.readOnly) return;
    if (this.historyDelegate) return this.historyDelegate.undo();
    this.commitText();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.items);
    this.items = this.undoStack.pop();
    this._renderAll();
    this._history();
    this.cb.onChange?.();
  }

  redo() {
    if (this.readOnly) return;
    if (this.historyDelegate) return this.historyDelegate.redo();
    this.commitText();
    if (!this.redoStack.length) return;
    this.undoStack.push(this.items);
    this.items = this.redoStack.pop();
    this._renderAll();
    this._history();
    this.cb.onChange?.();
  }

  async addImage(file) {
    if (this.readOnly) return;
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
    this.setSelection([item.id]);
  }

  // 結束目前的文字編輯（會觸發 focusout 存檔）
  commitText() {
    const a = document.activeElement;
    if (a?.classList?.contains('text-body')) a.blur();
  }

  // 讓正在輸入的游標留在可見範圍（手機鍵盤彈出時）
  revealCaret() {
    const body = document.activeElement;
    if (!body?.classList?.contains('text-body')) return;
    const vr = this.vp.getBoundingClientRect();
    let r = null;
    const sel = getSelection();
    if (sel.rangeCount) {
      const rects = sel.getRangeAt(0).getClientRects();
      if (rects.length) r = rects[rects.length - 1];
    }
    if (!r || (!r.width && !r.height)) r = body.getBoundingClientRect();
    const m = 24;
    let dx = 0, dy = 0;
    if (r.bottom > vr.bottom - m) dy = vr.bottom - m - r.bottom;
    else if (r.top < vr.top + m) dy = vr.top + m - r.top;
    if (r.right > vr.right - m) dx = vr.right - m - r.right;
    else if (r.left < vr.left + m) dx = vr.left + m - r.left;
    if (dx || dy) this.setView(this.view.x + dx, this.view.y + dy, this.view.s);
  }

  // ---------- events ----------
  _bind() {
    const vp = this.vp;
    vp.addEventListener('pointerdown', e => this._down(e));
    vp.addEventListener('pointermove', e => this._move(e));
    vp.addEventListener('pointerup', e => this._up(e));
    vp.addEventListener('pointercancel', e => this._up(e));
    vp.addEventListener('pointerleave', e => { if (!this.action) this.cursor.hidden = true; });
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

    if (this.readOnly) {
      e.preventDefault();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      this._startPan(e, null);
      try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
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

    const itemEl = e.target.closest('.item');
    const handle = e.target.closest('.handle');
    const textEl = e.target.closest('.text-item');
    if (!handle && textEl && (this.tool === 'text' || textEl.contains(document.activeElement))) return; // 交給瀏覽器放游標

    e.preventDefault();
    this.commitText();
    try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const w = this.toWorld(e.clientX, e.clientY);
    const base = { id: e.pointerId, ptype: e.pointerType };
    const fingerPans = isTouch && !this.fingerDraws;
    const t = this.tool;

    if ((t === 'pen' || t === 'hl' || t === 'eraser') && !fingerPans) {
      if (t === 'eraser') {
        this.action = { ...base, kind: 'erase', before: this._snap(), hit: false, last: w };
        this._showCursor(e);
        this._eraseAt(w);
      } else {
        this._startStroke(base, w);
      }
      return;
    }

    if (t === 'select' || t === 'lasso') {
      if (handle && itemEl) return this._startResize(base, w, itemEl.dataset.id);
      if (itemEl) {
        const id = itemEl.dataset.id;
        if (!this.sel.has(id)) this.setSelection([id]);
        return this._startMove(base, w, id);
      }
      if (this._inSelBox(w)) return this._startMove(base, w, null);
      if (t === 'lasso' && !fingerPans) return this._startLasso(base, w);
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
    if (this.tool === 'eraser' && (e.pointerType !== 'touch' || this.action?.kind === 'erase')) this._showCursor(e);
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
    } else if (a.kind === 'lasso') {
      const w = this.toWorld(e.clientX, e.clientY);
      const last = a.pts[a.pts.length - 1];
      if (Math.hypot(w.x - last[0], w.y - last[1]) * this.view.s < 3) return;
      a.pts.push([r1(w.x), r1(w.y)]);
      a.path.setAttribute('d', 'M' + a.pts.map(q => q.join(' ')).join('L') + 'Z');
    } else if (a.kind === 'pan') {
      const dx = e.clientX - a.sx, dy = e.clientY - a.sy;
      if (!a.moved && Math.hypot(dx, dy) < 6) return;
      a.moved = true;
      this.setView(a.vx + dx, a.vy + dy, this.view.s);
    } else if (a.kind === 'move') {
      const w = this.toWorld(e.clientX, e.clientY);
      const dx = w.x - a.start.x, dy = w.y - a.start.y;
      if (!a.moved && Math.hypot(dx, dy) * this.view.s < 6) return;
      if (!a.moved) this._beginMove(a);
      this._applyMove(a, dx, dy);
    } else if (a.kind === 'resize') {
      const w = this.toWorld(e.clientX, e.clientY);
      const nw = Math.max(a.min, a.ow + w.x - a.start.x);
      a.item.w = r1(nw);
      if (a.item.type === 'image') a.item.h = r1(nw * a.ratio);
      this._place(a.item);
      this._updateSelBox();
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
        if (a.ptype !== 'mouse') this.cursor.hidden = true;
        break;
      case 'lasso':
        this._endLasso(a);
        break;
      case 'move':
        if (a.moved) this._finishMove(a);
        else if (a.tapId && this._item(a.tapId)?.type === 'text') this._focusText(a.tapId);
        break;
      case 'resize':
        this._commit(a.before);
        this._updateSelBox();
        break;
      case 'pan':
        if (a.moved || !a.at) break;
        if (this.tool === 'text') this._newText(a.at);
        else if (this.tool === 'select' || this.tool === 'lasso') this._tapSelect(a.at);
        break;
    }
  }

  // 被雙指手勢或觸控筆打斷的動作
  _abort() {
    const a = this.action;
    this.action = null;
    if (!a) return;
    if (a.kind === 'draw' || a.kind === 'lasso') a.path.remove();
    else if (a.kind === 'move' && a.moved) this._finishMove(a);
    else if (a.kind === 'resize' || (a.kind === 'erase' && a.hit)) this._commit(a.before);
    this.cursor.hidden = true;
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

  _showCursor(e) {
    const d = this.style.eraser.width * 2;
    const r = this.vp.getBoundingClientRect();
    Object.assign(this.cursor.style, {
      width: d + 'px', height: d + 'px',
      left: e.clientX - r.left - d / 2 + 'px',
      top: e.clientY - r.top - d / 2 + 'px',
    });
    this.cursor.hidden = false;
  }

  _eraseAt(w) {
    const a = this.action;
    const r = this.style.eraser.width / this.view.s;
    const steps = Math.max(1, Math.ceil(dist(a.last, w) / (r / 2)));
    const samples = [];
    for (let i = 1; i <= steps; i++) {
      samples.push({ x: a.last.x + (w.x - a.last.x) * i / steps, y: a.last.y + (w.y - a.last.y) * i / steps });
    }
    a.last = w;

    const partial = this.style.eraser.mode === 'partial';
    let changed = false;
    const next = [];
    for (const it of this.items) {
      if (it.type !== 'stroke' || !samples.some(p => strokeHit(it, p, r))) {
        next.push(it);
        continue;
      }
      changed = true;
      if (partial) {
        // 局部擦除：把筆跡切成剩下的片段，原位置插回去以保持上下順序
        let pieces = [it.pts];
        for (const p of samples) {
          pieces = pieces.flatMap(pc => cutStroke(pc, p, r + it.width / 2) ?? [pc]);
        }
        const oldEl = this.els.get(it.id);
        for (const pts of pieces) {
          const piece = { ...it, id: uid(), pts };
          next.push(piece);
          this._mount(piece, oldEl);
        }
      }
      this._unmount(it.id);
    }
    if (changed) {
      this.items = next;
      a.hit = true;
    }
  }

  // ---------- selection ----------
  _item(id) {
    return this.items.find(x => x.id === id);
  }

  _box(it) {
    if (it.type === 'stroke') {
      const b = bbox(it), p = it.width / 2;
      return { x: b[0] - p, y: b[1] - p, w: b[2] - b[0] + 2 * p, h: b[3] - b[1] + 2 * p };
    }
    if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
    const el = this.els.get(it.id);
    return { x: it.x, y: it.y, w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  }

  _updateSelBox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of this.sel) {
      const it = this._item(id);
      if (!it) continue;
      const b = this._box(it);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    if (x0 === Infinity) {
      this.selBounds = null;
      this.selBox.hidden = true;
      return;
    }
    const pad = 6 / this.view.s;
    this.selBounds = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
    this._placeSelBox(0, 0);
    this.selBox.hidden = false;
  }

  _placeSelBox(dx, dy) {
    const b = this.selBounds;
    Object.assign(this.selBox.style, {
      left: b.x0 + dx + 'px', top: b.y0 + dy + 'px',
      width: b.x1 - b.x0 + 'px', height: b.y1 - b.y0 + 'px',
    });
  }

  _inSelBox(w) {
    const b = this.selBounds;
    return !!b && w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;
  }

  _hitTest(w) {
    const r = 10 / this.view.s;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type === 'stroke') {
        if (strokeHit(it, w, r)) return it;
      } else {
        const b = this._box(it);
        if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return it;
      }
    }
    return null;
  }

  _tapSelect(w) {
    const hit = this._hitTest(w);
    this.setSelection(hit ? [hit.id] : []);
  }

  _startLasso(base, w) {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'lasso');
    path.setAttribute('stroke-width', 1.5 / this.view.s);
    path.setAttribute('stroke-dasharray', `${6 / this.view.s} ${4 / this.view.s}`);
    this.svg.append(path);
    this.action = { ...base, kind: 'lasso', path, at: w, pts: [[r1(w.x), r1(w.y)]] };
  }

  _endLasso(a) {
    a.path.remove();
    const xs = a.pts.map(p => p[0]), ys = a.pts.map(p => p[1]);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * this.view.s;
    if (a.pts.length < 3 || size < 10) return this._tapSelect(a.at);
    const poly = a.pts;
    const ids = this.items.filter(it => {
      if (it.type === 'stroke') {
        const n = it.pts.filter(([x, y]) => inPoly(x, y, poly)).length;
        return n / it.pts.length >= 0.5;
      }
      const b = this._box(it);
      return inPoly(b.x + b.w / 2, b.y + b.h / 2, poly);
    }).map(it => it.id);
    this.setSelection(ids);
  }

  _startMove(base, w, tapId) {
    this.action = { ...base, kind: 'move', tapId, before: this._snap(), start: w, moved: false, dx: 0, dy: 0 };
  }

  _beginMove(a) {
    a.moved = true;
    a.orig = new Map();
    for (const id of this.sel) {
      const it = this._item(id);
      if (!it) continue;
      if (it.type === 'stroke') {
        a.orig.set(id, null);
      } else {
        const own = this._own(id);
        a.orig.set(id, { item: own, x: own.x, y: own.y });
      }
    }
  }

  _applyMove(a, dx, dy) {
    a.dx = dx;
    a.dy = dy;
    for (const [id, o] of a.orig) {
      if (o) {
        o.item.x = r1(o.x + dx);
        o.item.y = r1(o.y + dy);
        this._place(o.item);
      } else {
        // 筆跡拖曳中先用 transform，放開時再把位移寫進座標
        this.els.get(id)?.setAttribute('transform', `translate(${dx} ${dy})`);
      }
    }
    if (this.selBounds) this._placeSelBox(dx, dy);
  }

  _finishMove(a) {
    for (const [id, o] of a.orig) {
      if (o) continue;
      const own = this._own(id);
      own.pts = own.pts.map(([x, y]) => [r1(x + a.dx), r1(y + a.dy)]);
      const el = this.els.get(id);
      el.removeAttribute('transform');
      el.setAttribute('d', pathData(own.pts));
    }
    this._commit(a.before);
    this._updateSelBox();
  }

  _startResize(base, w, id) {
    const before = this._snap();
    const item = this._own(id);
    const isText = item.type === 'text';
    this.action = {
      ...base, kind: 'resize', item, before, start: w,
      ow: isText ? (item.w ?? this.els.get(id).offsetWidth) : item.w,
      ratio: isText ? 0 : item.h / item.w,
      min: isText ? item.size * 2 : 24 / this.view.s,
    };
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
    const body = this.els.get(id)?.querySelector('.text-body');
    if (!body) return;
    body.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  _focusIn(e) {
    const el = e.target.closest?.('.text-item');
    if (!el) return;
    setTimeout(() => this.revealCaret(), 350); // 等手機鍵盤動畫
    const id = el.dataset.id;
    if (this.editing?.id === id) return;
    const before = this._snap();
    const item = this._own(id);
    this.editing = { id, item, before, orig: item.text, created: false };
  }

  _input() {
    const ed = this.editing;
    if (!ed) return;
    ed.item.text = this.els.get(ed.id).querySelector('.text-body').innerText;
    if (this.sel.has(ed.id)) this._updateSelBox();
    requestAnimationFrame(() => this.revealCaret());
    this.cb.onChange?.();
  }

  _focusOut(e) {
    const ed = this.editing;
    if (!ed || e.target.closest?.('.text-item')?.dataset.id !== ed.id) return;
    this.editing = null;
    const text = e.target.innerText.replace(/\n+$/, '');
    ed.item.text = text;
    if (!text.trim()) {
      this.items = this.items.filter(x => x.id !== ed.id);
      this._unmount(ed.id);
      if (this.sel.has(ed.id)) this.setSelection([...this.sel].filter(x => x !== ed.id));
      if (ed.created) this.cb.onChange?.();
      else this._commit(ed.before);
    } else if (ed.created || text !== ed.orig) {
      this._commit(ed.before);
    }
  }

  // ---------- render ----------
  _mount(item, beforeEl = null) {
    let el;
    if (item.type === 'stroke') {
      for (const [peer, path] of this.previews ?? []) if (path.dataset.previewId === item.id) { path.remove(); this.previews.delete(peer); }
      el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', pathData(item.pts));
      el.setAttribute('stroke', item.color);
      el.setAttribute('stroke-width', item.width);
      if (item.tool === 'hl') el.setAttribute('class', 'hl');
      this.svg.insertBefore(el, beforeEl);
    } else if (item.type === 'text') {
      el = h('div', 'item text-item');
      const body = h('div', 'text-body');
      body.contentEditable = String(!this.readOnly);
      body.spellcheck = false;
      body.innerText = item.text;
      el.append(body, h('div', 'handle w-handle'));
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
    } else {
      el.style.width = item.w ? item.w + 'px' : '';
      el.classList.toggle('fixed-w', !!item.w);
    }
  }

  _renderAll() {
    for (const layer of [this.svg, this.imgLayer, this.textLayer]) layer.replaceChildren();
    this.els.clear();
    for (const it of this.items) this._mount(it);
    this.setSelection([...this.sel].filter(id => this.els.has(id)));
  }

  async _url(blobId) {
    if (!this.urls.has(blobId)) {
      const blob = this.blobLoader ? await this.blobLoader(blobId) : await db.get('blobs', blobId);
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
    if (this.historyDelegate) {
      this.cb.onChange?.(); this._history(); return;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this._history();
    this.cb.onChange?.();
  }

  _history() {
    if (this.historyDelegate) { this.cb.onHistory?.(...this.historyDelegate.state()); return; }
    this.cb.onHistory?.(this.undoStack.length > 0, this.redoStack.length > 0);
  }
}
