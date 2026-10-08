// 無限畫布：手寫(SVG) / 文字框 / 圖片，雙指縮放平移，復原重做
// 座標系：item 都存「世界座標」，畫面用 translate(x,y) scale(s) 呈現
import { db, uid } from './db.js';
import { isDark, readableInk } from './color.js';
import { renderMarkdown, sourceOffset, toggleTask } from './markdown.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MIN_S = 0.1, MAX_S = 8, GRID = 24, HISTORY = 100;
const PALM_GRACE = 300; // 觸控筆離開後這段時間（毫秒）內的觸控仍當成手掌
// 觸控板捏合的 deltaY 很小，照原比例縮放才跟手；滑鼠滾輪一格約 100，限制成一格約 10%
const WHEEL_ZOOM_MAX = 10;
// 一次至少 WHEEL_NOTCH px 的滾動視為「一格一格」的滾輪，用時間常數 WHEEL_GLIDE 毫秒的動畫滑過去；
// 拇指滾輪 WHEEL_BOTH 毫秒內也在滾（兩個滾輪一起用）時改用 WHEEL_GLIDE_BOTH，讓相鄰兩格接得起來
const WHEEL_NOTCH = 50, WHEEL_GLIDE = 40, WHEEL_GLIDE_BOTH = 100, WHEEL_BOTH = 200;
// Chrome 改判的那一格，會在拇指滾輪事件之後 WHEEL_SWAPPED 毫秒內出現。這個改判只有 Windows 版 Chromium 有
const WHEEL_SWAPPED = 32;
const WIN_CHROMIUM = /Windows/.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent);
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FULL = { x: 0, y: 0, w: 1, h: 1 }; // 圖片沒裁切
// 文字框可選的字體；沒設定＝跟介面一樣的字體
export const FONTS = {
  serif: '"Noto Serif TC", "PMingLiU", "新細明體", "Songti TC", serif',
  kai: '"BiauKai", "DFKai-SB", "標楷體", "Kaiti TC", "KaiTi", serif',
  mono: 'ui-monospace, Consolas, "Courier New", monospace',
};
const PAPER = '#ffffff'; // 列印／匯出 PDF 的紙色
const BORDER = '#1f2937', BORDER_W = 2; // 只選粗細或樣式、還沒有框線時的顏色；沒存粗細時的粗細

// 文字框的框線、底色、字色。框線畫在框外（outline），不影響文字框大小和換行；
// 有底色時字色對底色挑，沒指定字色就看底色深淺用深字或淺字。canvas＝框線外面的底色
function textLook(it, canvas) {
  const under = it.fill ?? canvas;
  return {
    color: it.color ? readableInk(it.color, under) : it.fill ? (isDark(it.fill) ? '#f3f4f6' : '#1f2937') : '',
    backgroundColor: it.fill ?? '',
    outline: it.border ? `${it.borderW ?? BORDER_W}px ${it.borderStyle ?? 'solid'} ${readableInk(it.border, canvas)}` : '',
  };
}

const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const RAD = Math.PI / 180;
// 角度換到 -180～180
const normDeg = d => r1(((d + 180) % 360 + 360) % 360 - 180);
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

// 依寬度逐字換行（中文沒有空白可以斷）
function wrapText(ctx, text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && width > 0 && ctx.measureText(line + ch).width > width) { out.push(line); line = ''; }
      line += ch;
    }
    out.push(line);
  }
  return out;
}

// .text-body → renderMarkdown 回傳的位置對照（編輯中的文字框沒有）
const sources = new WeakMap();

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

// 世界座標 → 圖片自己的座標（以中心為原點、沒旋轉）
function imageLocal(it, p) {
  const r = -(it.rot ?? 0) * RAD, dx = p.x - (it.x + it.w / 2), dy = p.y - (it.y + it.h / 2);
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
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
    for (const direction of [...DIRS, 'rotate']) {
      const handle = h('button', 'sel-handle');
      handle.dataset.transform = direction;
      handle.title = direction === 'rotate' ? '拖曳旋轉' : '拖曳縮放';
      handle.setAttribute('aria-label', direction === 'rotate' ? '旋轉' : '縮放 ' + direction);
      this.selBox.append(handle);
    }
    this.uiLayer.append(this.selBox);
    this.world.append(this.imgLayer, this.svg, this.textLayer, this.uiLayer);
    this.cursor = h('div', 'eraser-cursor');
    this.cursor.hidden = true;
    vp.append(this.world, this.cursor);

    this.items = [];          // 視為不可變：要改某個 item 先 _own() 複製
    this.els = new Map();     // item.id -> DOM
    this.urls = new Map();    // blobId -> objectURL
    this.view = { x: 0, y: 0, s: 1 };
    this.anim = 0;            // animateView 的 requestAnimationFrame id
    this.style = {
      pen: { color: '#1f2937', width: 3 },
      hl: { color: '#fde047', width: 20 },
      eraser: { mode: 'partial', width: 12 }, // width = 螢幕上的半徑
      text: { size: 18 },                      // 新文字框的字級與格式（bold、italic、color、font）
    };
    this.cropping = null;     // 裁切中的圖片：{ id, crop }，crop 是還沒套用的裁切範圍
    this.canvas = '#ffffff';  // 畫布底色，由 setCanvas 設定
    this.darkCanvas = false;
    this.mouseMode = false;   // 滑鼠模式：點到物件直接選取並拖動，空白處拖曳＝框選
    this.spacePan = false;    // 按住空白鍵：左鍵拖曳＝移動畫布
    this.penNear = false;     // 觸控筆在感應範圍內（懸停或接觸）：這時候的觸控都是手掌，見 _penIn
    this.penLeftAt = -Infinity;
    this.penEraser = false;   // 這次靠近用的是筆尾，記到筆離開範圍，見 _down
    this.lastBrush = 'pen';   // 最後用過的畫筆：選取工具下筆尖用它寫
    this.downType = null;     // 最近一次按下的指標種類
    this.glide = { x: 0, y: 0, frame: 0, tau: WHEEL_GLIDE }; // 滾輪還沒滑完的距離，見 _glide
    this.thumbAt = -Infinity; // 最近一次高解析度橫向滾動（拇指滾輪）的時間
    this.thumbTicks = 0;      // 那一次滾了幾格（拇指滾輪只有零點幾格）
    this.lineY = 0;           // 直向滾輪一格幾 px，從真正的直向格學來
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
    this._stopAnim();
    this.action = null;
    this.pointers.clear();
    this.editing = null;
    this.cropping = null;
    this._dragHandle(null);
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
    if (value) this._cancelCrop();
    this._updateSelBox();
    this.cb.onContext?.();
  }

  // Apply committed remote objects without resetting view, history or a gesture.
  applyRemote(items) {
    this._cancelCrop();
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
    this.cb.onRemote?.();
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
    path.setAttribute('stroke', this.inkColor(item));
    path.setAttribute('stroke-width', item.width);
    path.dataset.previewId = item.id;
    this.svg.append(path); this.previews.set(peerId, path);
  }

  clearPreviews() {
    for (const path of this.previews?.values() ?? []) path.remove();
    this.previews?.clear();
  }

  // 換畫布底色：跟底色太接近的筆跡改用看得清楚的顏色重畫（只改顯示，不改資料）
  setCanvas(color) {
    this.canvas = color;
    this.darkCanvas = isDark(color);
    this.vp.classList.toggle('dark-canvas', this.darkCanvas);
    for (const it of this.items) {
      if (it.type === 'stroke') this.els.get(it.id)?.setAttribute('stroke', this.inkColor(it));
      else if (it.type === 'text' && (it.color || it.border)) this._place(it);
    }
  }

  // 螢光筆是半透明的，什麼底色都看得到，保持原色
  inkColor(item) {
    return item.tool === 'hl' ? item.color : readableInk(item.color, this.canvas);
  }

  setTool(t) {
    this.commitText();
    this.endCrop();
    this.tool = t;
    if (t === 'pen' || t === 'hl') this.lastBrush = t;
    this.vp.dataset.tool = t;
    this.cursor.hidden = true;
    if (t !== 'select' && t !== 'lasso') this.setSelection([]);
    this.cb.onContext?.();
  }

  // 'touch'：先點選物件才能拖動，空白處拖曳＝移動畫布，比較不會誤觸
  // 'mouse'：點到物件直接選取並拖動，空白處拖曳＝框選
  setInputMode(mode) {
    this.mouseMode = mode === 'mouse';
    this.vp.dataset.input = mode;
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

  // 縮放按鈕：跳到下一個整數百分比
  zoomStep(dir) {
    const s = this.view.s;
    const next = dir > 0 ? ZOOM_STEPS.find(z => z > s * 1.01) : ZOOM_STEPS.findLast(z => z < s * 0.99);
    if (next) this.zoomTo(next);
  }

  centerOn(wx, wy) {
    this._stopAnim();
    const s = this.view.s;
    this.setView(this.vp.clientWidth / 2 - wx * s, this.vp.clientHeight / 2 - wy * s, s);
  }

  // 縮放到看得見全部內容，最多放大到 100%；空白頁回到原點
  fitContent() {
    const b = this.contentBounds();
    if (!b) return this.animateView(40, 40, 1);
    const w = this.vp.clientWidth, ht = this.vp.clientHeight, pad = 48;
    const s = clamp(Math.min((w - pad * 2) / (b.x1 - b.x0 || 1), (ht - pad * 2) / (b.y1 - b.y0 || 1)), MIN_S, 1);
    this.animateView(w / 2 - (b.x0 + b.x1) / 2 * s, ht / 2 - (b.y0 + b.y1) / 2 * s, s);
  }

  // 平滑移到指定視角：中心點線性移動、縮放以對數內插，大幅跳轉時才看得出從哪裡到哪裡
  animateView(x, y, s) {
    this._stopAnim();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return this.setView(x, y, s);
    const w = this.vp.clientWidth / 2, ht = this.vp.clientHeight / 2, from = { ...this.view };
    const c0 = { x: (w - from.x) / from.s, y: (ht - from.y) / from.s };
    const c1 = { x: (w - x) / s, y: (ht - y) / s };
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / 300), e = 1 - (1 - t) ** 3;
      const ns = from.s * (s / from.s) ** e;
      this.setView(w - (c0.x + (c1.x - c0.x) * e) * ns, ht - (c0.y + (c1.y - c0.y) * e) * ns, ns);
      this.anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.anim = requestAnimationFrame(step);
  }

  _stopAnim() {
    cancelAnimationFrame(this.anim);
    this.anim = 0;
    cancelAnimationFrame(this.glide.frame);
    this.glide = { x: 0, y: 0, frame: 0, tau: WHEEL_GLIDE };
  }

  // 全部物件（或 ids 指定的物件）的外框（世界座標），空白頁回傳 null
  contentBounds(ids = null) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of this.items) {
      if (ids && !ids.has(it.id)) continue;
      const b = this._box(it);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // 目前畫面看得到的範圍（世界座標）
  viewBounds() {
    const { x, y, s } = this.view;
    return { x0: -x / s, y0: -y / s, x1: (this.vp.clientWidth - x) / s, y1: (this.vp.clientHeight - y) / s };
  }

  // 畫面裡是否有任何物件；沒有代表使用者可能迷路了
  hasVisibleContent() {
    const v = this.viewBounds();
    return this.items.some(it => {
      const b = this._box(it);
      return b.x < v.x1 && b.x + b.w > v.x0 && b.y < v.y1 && b.y + b.h > v.y0;
    });
  }

  toWorld(cx, cy) {
    const r = this.rect;
    return { x: (cx - r.left - this.view.x) / this.view.s, y: (cy - r.top - this.view.y) / this.view.s };
  }

  setSelection(ids) {
    if (this.cropping && !(ids.length === 1 && ids[0] === this.cropping.id)) this.endCrop();
    for (const id of this.sel) this.els.get(id)?.classList.remove('selected');
    this.sel = new Set(ids);
    if (this.sel.size === 1) this.els.get(ids[0])?.classList.add('selected');
    this._updateSelBox();
    this.cb.onSelect?.(this.sel.size);
    this.cb.onContext?.();
  }

  // 選取中的物件類型
  selectedTypes() {
    return new Set([...this.sel].map(id => this._item(id)?.type).filter(Boolean));
  }

  // ---------- 文字格式 ----------
  // 要套用格式的文字框：正在編輯的那個，不然是選取中的文字框
  textTargets() {
    if (this.editing) return [this.editing.id];
    return [...this.sel].filter(id => this._item(id)?.type === 'text');
  }

  // 第一個目標文字框的格式；文字工具下沒有目標時是新文字框的預設格式；都沒有回傳 null
  textFormat() {
    if (this.readOnly) return null;
    const id = this.textTargets()[0];
    const it = id ? this._item(id) : this.tool === 'text' ? this.style.text : null;
    return it && {
      bold: !!it.bold, italic: !!it.italic, color: it.color ?? null, font: it.font ?? null, size: it.size,
      box: !!id, border: it.border ?? null, borderW: it.borderW ?? BORDER_W, borderStyle: it.borderStyle ?? '', fill: it.fill ?? null,
    };
  }

  setTextStyle(key, value) {
    this._styleText(it => { if (value) it[key] = value; else delete it[key]; });
  }

  // 框線（border、borderW、borderStyle）和底色（fill）：只改現有的文字框，不記成新文字框的格式
  setTextBox(key, value) {
    if (!this.textTargets().length) return;
    this._styleText(it => {
      if (value) it[key] = value; else delete it[key];
      if (key === 'border' && !value) { delete it.borderW; delete it.borderStyle; }
      if ((key === 'borderW' || key === 'borderStyle') && !it.border) it.border = BORDER;
    });
  }

  // 字級加減 1（小數先取整），固定寬度的文字框寬度跟著等比例縮放
  stepTextSize(dir) {
    this._styleText(it => {
      const size = clamp(dir > 0 ? Math.floor(it.size) + 1 : Math.ceil(it.size) - 1, 1, 2000);
      if (it.w) it.w = r1(it.w * size / it.size);
      it.size = size;
    });
    this._rememberSize();
  }

  // 直接設定字級（字級選單），固定寬度的文字框寬度跟著等比例縮放
  setTextSize(size) {
    size = clamp(r2(size), 1, 2000);
    this._styleText(it => {
      if (it.w) it.w = r1(it.w * size / it.size);
      it.size = size;
    });
    this._rememberSize();
  }

  // 新文字框用最後一次調整過的字級（A−／A+、字級選單、拉把手縮放）
  _rememberSize() {
    const id = this.textTargets()[0];
    const size = id ? this._item(id)?.size : this.tool === 'text' ? this.style.text.size : null;
    if (!size || this.readOnly) return;
    this.style.text.size = size;
    this.cb.onTextSize?.(size);
  }

  // 粗體／斜體：編輯中有反白文字就用 Markdown 包起來（已經包著就拿掉），不然整個文字框切換
  toggleMark(key) {
    const body = document.activeElement, sel = getSelection();
    if (this.editing && body?.classList?.contains('text-body') && sel.rangeCount && !sel.isCollapsed && body.contains(sel.anchorNode)) {
      const mark = key === 'bold' ? '**' : '*', s = sel.toString();
      const wrapped = s.length > mark.length * 2 && s.startsWith(mark) && s.endsWith(mark);
      document.execCommand('insertText', false, wrapped ? s.slice(mark.length, -mark.length) : mark + s + mark);
      return;
    }
    this.setTextStyle(key, !this.textFormat()?.[key]);
  }

  _styleText(fn) {
    if (this.readOnly) return;
    const ids = this.textTargets();
    if (!ids.length) {
      if (this.tool === 'text') fn(this.style.text);
      this.cb.onContext?.();
      return;
    }
    const ed = this.editing, before = this._snap();
    for (const id of ids) {
      const item = ed ? ed.item : this._own(id);
      fn(item);
      this._place(item);
    }
    // 編輯中的文字框等編輯結束時連同文字一起存成一步
    if (ed) { ed.styled = true; this.cb.onChange?.(); } else this._commit(before);
    this._updateSelBox();
    this.cb.onContext?.();
  }

  // ---------- 圖片 ----------
  rotateImages(deg) {
    if (this.readOnly) return;
    this.endCrop();
    const ids = [...this.sel].filter(id => this._item(id)?.type === 'image');
    if (!ids.length) return;
    const before = this._snap();
    for (const id of ids) {
      const item = this._own(id);
      item.rot = normDeg((item.rot ?? 0) + deg);
      if (!item.rot) delete item.rot;
      this._place(item);
    }
    this._commit(before);
    this._updateSelBox();
  }

  // 裁切：顯示整張原圖，拖曳框或八個把手調整範圍；endCrop 才套用
  startCrop() {
    if (this.readOnly || this.cropping || this.sel.size !== 1) return;
    const id = [...this.sel][0], it = this._item(id);
    if (it?.type !== 'image') return;
    this.commitText();
    const el = this.els.get(id);
    const area = h('div', 'crop-area'), frame = h('div', 'crop-frame');
    area.append(h('div', 'crop-shade'));
    frame.dataset.crop = 'move';
    for (const d of DIRS) {
      const k = h('div', 'crop-handle');
      k.dataset.crop = d;
      frame.append(k);
    }
    el.append(area, frame);
    el.classList.add('cropping');
    this.cropping = { id, crop: { ...(it.crop ?? FULL) } };
    this._placeCrop();
    this._updateSelBox();
    this.cb.onContext?.();
  }

  endCrop() {
    const cr = this.cropping;
    if (!cr) return;
    this._cancelCrop();
    const it = this._item(cr.id);
    const c = it?.crop ?? FULL, n = cr.crop;
    if (it && ['x', 'y', 'w', 'h'].some(k => Math.abs(n[k] - c[k]) > 1e-4)) {
      const before = this._snap(), item = this._own(cr.id);
      const fw = it.w / c.w, fh = it.h / c.h; // 整張原圖在世界座標的大小
      // 新範圍中心相對舊範圍中心（圖片自己的座標），轉回世界座標
      const lx = (n.x + n.w / 2 - c.x - c.w / 2) * fw, ly = (n.y + n.h / 2 - c.y - c.h / 2) * fh;
      const r = (it.rot ?? 0) * RAD;
      const cx = it.x + it.w / 2 + lx * Math.cos(r) - ly * Math.sin(r);
      const cy = it.y + it.h / 2 + lx * Math.sin(r) + ly * Math.cos(r);
      item.w = r1(n.w * fw);
      item.h = r1(n.h * fh);
      item.x = r1(cx - item.w / 2);
      item.y = r1(cy - item.h / 2);
      const round = v => Math.round(v * 1e4) / 1e4;
      if (n.w > .9999 && n.h > .9999) delete item.crop;
      else item.crop = { x: round(n.x), y: round(n.y), w: round(n.w), h: round(n.h) };
      this._place(item);
      this._commit(before);
    }
    this._updateSelBox();
    this.cb.onContext?.();
  }

  // 收掉裁切畫面，不套用
  _cancelCrop() {
    const cr = this.cropping;
    if (!cr) return;
    this.cropping = null;
    if (this.action?.kind === 'crop') this.action = null;
    const el = this.els.get(cr.id);
    el?.classList.remove('cropping');
    el?.querySelectorAll('.crop-area, .crop-frame').forEach(x => x.remove());
  }

  _placeCrop() {
    const { id, crop: n } = this.cropping, it = this._item(id), c = it.crop ?? FULL, el = this.els.get(id);
    const fw = it.w / c.w, fh = it.h / c.h, fx = -c.x * fw, fy = -c.y * fh;
    const px = v => v + 'px';
    const box = { left: px(n.x * fw), top: px(n.y * fh), width: px(n.w * fw), height: px(n.h * fh) };
    Object.assign(el.querySelector('.crop-area').style, { left: px(fx), top: px(fy), width: px(fw), height: px(fh) });
    Object.assign(el.querySelector('.crop-shade').style, box);
    Object.assign(el.querySelector('.crop-frame').style, { ...box, left: px(fx + n.x * fw), top: px(fy + n.y * fh) });
  }

  _startCropDrag(base, w, dir) {
    const it = this._item(this.cropping.id);
    this.action = { ...base, kind: 'crop', dir, start: this._cropFrac(it, w), crop0: { ...this.cropping.crop } };
  }

  // 世界座標 → 在整張原圖上的比例位置（0～1）
  _cropFrac(it, p) {
    const c = it.crop ?? FULL, l = imageLocal(it, p);
    return { x: c.x + c.w / 2 + l.x / it.w * c.w, y: c.y + c.h / 2 + l.y / it.h * c.h };
  }

  _cropDrag(a, w) {
    const it = this._item(this.cropping.id), p = this._cropFrac(it, w), o = a.crop0, d = a.dir;
    const c = it.crop ?? FULL, dx = p.x - a.start.x, dy = p.y - a.start.y;
    // 裁切範圍在螢幕上至少 16px
    const mw = Math.min(o.w, 16 / this.view.s / (it.w / c.w)), mh = Math.min(o.h, 16 / this.view.s / (it.h / c.h));
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (d === 'move') {
      const mx = clamp(dx, -x0, 1 - x1), my = clamp(dy, -y0, 1 - y1);
      x0 += mx; x1 += mx; y0 += my; y1 += my;
    } else {
      if (d.includes('w')) x0 = clamp(x0 + dx, 0, x1 - mw);
      if (d.includes('e')) x1 = clamp(x1 + dx, x0 + mw, 1);
      if (d.includes('n')) y0 = clamp(y0 + dy, 0, y1 - mh);
      if (d.includes('s')) y1 = clamp(y1 + dy, y0 + mh, 1);
    }
    this.cropping.crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this._placeCrop();
  }

  // 圖片畫到 canvas，旋轉、裁切跟畫面一樣；圖還沒載好回傳 false
  drawImageItem(ctx, it) {
    const img = this.els.get(it.id)?.querySelector('img');
    if (!img?.complete || !img.naturalWidth) return false;
    const c = it.crop ?? FULL, nw = img.naturalWidth, nh = img.naturalHeight;
    ctx.save();
    ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
    if (it.rot) ctx.rotate(it.rot * RAD);
    ctx.drawImage(img, c.x * nw, c.y * nh, c.w * nw, c.h * nh, -it.w / 2, -it.h / 2, it.w, it.h);
    ctx.restore();
    return true;
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
    this.endCrop();
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
    this.endCrop();
    if (this.historyDelegate) return this.historyDelegate.redo();
    this.commitText();
    if (!this.redoStack.length) return;
    this.undoStack.push(this.items);
    this.items = this.redoStack.pop();
    this._renderAll();
    this._history();
    this.cb.onChange?.();
  }

  pastePosition() {
    const rect = this.vp.getBoundingClientRect();
    const position = this.lastPointer;
    if (position && position.x >= rect.left && position.x <= rect.right && position.y >= rect.top && position.y <= rect.bottom) return this.toWorld(position.x, position.y);
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  addText(text, position = this.pastePosition()) {
    if (this.readOnly || !text) return;
    this.commitText();
    const before = this._snap();
    const item = { id: uid(), type: 'text', x: r1(position.x), y: r1(position.y), size: this.style.text.size, text };
    this.items.push(item); this._mount(item); this._commit(before); this.setSelection([item.id]);
  }

  async addImage(file, position = null) {
    if (this.readOnly) return;
    const { blob, w, h: ih } = await prepareImage(file);
    const blobId = uid();
    await db.put('blobs', blob, blobId);
    this.urls.set(blobId, URL.createObjectURL(blob));

    this.rect = this.vp.getBoundingClientRect();
    const r = this.rect, s = this.view.s;
    const k = Math.min(1 / s, (r.width * 0.8 / s) / w, (r.height * 0.8 / s) / ih);
    const iw = w * k, ihh = ih * k;
    const c = position ?? this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const item = { id: uid(), type: 'image', blobId, x: r1(c.x - iw / 2), y: r1(c.y - ihh / 2), w: r1(iw), h: r1(ihh) };

    const before = this._snap();
    this.items.push(item);
    this._mount(item);
    this._commit(before);
    this.setSelection([item.id]);
  }

  // 插入一組新物件（AI 回傳的元件，已經是世界座標），一次復原就能還原，插入後選取方便拖動對照
  insertItems(items) {
    if (this.readOnly || !items.length) return;
    this.commitText();
    const before = this._snap();
    for (const item of items) { this.items.push(item); this._mount(item); }
    this._commit(before);
    this.setSelection(items.map(it => it.id));
  }

  // 圖檔載得到嗎（貼上從別處複製來的圖片時檢查）
  async hasBlob(blobId) {
    try { return !!(await this._url(blobId)); } catch { return false; }
  }

  // 螢幕座標上最上層的物件，沒有就 null
  itemAt(cx, cy) {
    return this._hitsAt(this.toWorld(cx, cy))[0] ?? null;
  }

  selectionHas(cx, cy) {
    return this.sel.size > 0 && this._inSelBox(this.toWorld(cx, cy));
  }

  // 截圖／匯出範圍：指定物件（沒給就全部）的外框外加一點留白；沒有內容回傳 null
  exportArea(ids = null, pad = 24) {
    const b = this.contentBounds(ids);
    return b && { x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + pad * 2, h: b.y1 - b.y0 + pad * 2 };
  }

  // 把 area 範圍畫成 PNG（給 AI 看手寫），ids 有給就只畫那些物件。顏色跟畫面一樣；文字只畫原始文字，不排 Markdown
  async toPNG(area, { ids = null, maxSide = 2400 } = {}) {
    const k = Math.min(2, maxSide / Math.max(area.w, area.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(area.w * k));
    c.height = Math.max(1, Math.round(area.h * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = this.canvas;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, -area.x * k, -area.y * k);
    ctx.lineCap = ctx.lineJoin = 'round';
    const css = getComputedStyle(this.vp);
    for (const it of this.items) {
      if (ids && !ids.has(it.id)) continue;
      ctx.globalAlpha = 1;
      if (it.type === 'stroke') {
        ctx.globalAlpha = it.tool === 'hl' ? .5 : 1;
        ctx.strokeStyle = this.inkColor(it);
        ctx.lineWidth = it.width;
        ctx.stroke(new Path2D(pathData(it.pts)));
      } else if (it.type === 'image') {
        this.drawImageItem(ctx, it);
      } else if (it.type === 'text') {
        // 畫顯示出來的文字（沒有 Markdown 符號），超出文字框的部分裁掉，避免疊到下一個框
        const el = this.els.get(it.id), lh = it.size * 1.45;
        if (!el) continue;
        const body = el.querySelector('.text-body'), w = el.offsetWidth, ht = el.offsetHeight;
        const pad = getComputedStyle(body), px = parseFloat(pad.paddingLeft), py = parseFloat(pad.paddingTop);
        ctx.save();
        if (it.fill) {
          ctx.fillStyle = it.fill;
          ctx.beginPath();
          ctx.roundRect(it.x, it.y, w, ht, 4);
          ctx.fill();
        }
        if (it.border) {
          // 跟 outline 一樣畫在框外
          const bw = it.borderW ?? BORDER_W;
          ctx.strokeStyle = readableInk(it.border, this.canvas);
          ctx.lineWidth = bw;
          ctx.lineCap = it.borderStyle === 'dotted' ? 'round' : 'butt';
          ctx.setLineDash(it.borderStyle === 'dashed' ? [bw * 3, bw * 2] : it.borderStyle === 'dotted' ? [0, bw * 2] : []);
          ctx.beginPath();
          ctx.roundRect(it.x - bw / 2, it.y - bw / 2, w + bw, ht + bw, 4 + bw / 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.rect(it.x, it.y, w, ht);
        ctx.clip();
        ctx.font = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${it.size}px ${FONTS[it.font] ?? css.fontFamily}`;
        ctx.fillStyle = textLook(it, this.canvas).color || css.color;
        ctx.textBaseline = 'middle';
        let y = it.y + py + lh / 2;
        // offsetWidth 是取整過的，padding 用 em 時會比實際窄一點點，多給 1px 才不會提早換行
        for (const line of wrapText(ctx, body.innerText, w - px * 2 + 1)) { ctx.fillText(line, it.x + px, y); y += lh; }
        ctx.restore();
      }
    }
    return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('無法產生截圖')), 'image/png'));
  }

  // 把 area 範圍複製成一塊 DOM（給列印／匯出 PDF），ids 有給就只放那些物件。
  // 直接複製畫面上的元素，Markdown、字型、圖片都跟畫面一樣；印在白紙上，顏色照白底重算
  printSheet(area, ids = null) {
    const sheet = h('div', 'print-sheet');
    sheet.style.width = area.w + 'px';
    sheet.style.height = area.h + 'px';
    const world = h('div', 'world');
    world.style.transform = `translate(${-area.x}px, ${-area.y}px)`;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ink');
    const layers = [[this.imgLayer, h('div', 'layer')], [this.svg, svg], [this.textLayer, h('div', 'layer')]];
    const byId = new Map(this.items.map(it => [it.id, it]));
    // 照 DOM 順序（＝畫面上的疊放順序）複製；套索、遠端預覽這些不是物件的元素略過
    for (const [from, to] of layers) for (const el of from.children) {
      const it = byId.get(el.dataset.id);
      if (!it || this.els.get(it.id) !== el || (ids && !ids.has(it.id))) continue;
      const copy = el.cloneNode(true);
      copy.classList.remove('selected', 'cropping');
      if (it.type === 'stroke') copy.setAttribute('stroke', it.tool === 'hl' ? it.color : readableInk(it.color, PAPER));
      if (it.type === 'text') {
        copy.querySelector('.text-body').removeAttribute('contenteditable');
        Object.assign(copy.style, textLook(it, PAPER));
      }
      to.append(copy);
    }
    world.append(...layers.map(([, to]) => to));
    sheet.append(world);
    return sheet;
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
    vp.addEventListener('dblclick', e => this._dblEdit(e));
    vp.addEventListener('wheel', e => this._wheel(e), { passive: false });
    vp.addEventListener('contextmenu', e => { if (!e.target.isContentEditable) e.preventDefault(); });
    // focus 到文字框時瀏覽器可能偷偷捲動 overflow:hidden 的容器，強制歸零
    vp.addEventListener('scroll', () => { vp.scrollTop = 0; vp.scrollLeft = 0; });
    this.textLayer.addEventListener('focusin', e => this._focusIn(e));
    this.textLayer.addEventListener('focusout', e => this._focusOut(e));
    this.textLayer.addEventListener('input', () => this._input());
    // Ctrl+B／Ctrl+I：瀏覽器預設會插入 <b>／<i>，改成 Markdown 或整個文字框的格式
    this.textLayer.addEventListener('keydown', e => {
      const k = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase();
      if (k !== 'b' && k !== 'i') return;
      e.preventDefault();
      this.toggleMark(k === 'b' ? 'bold' : 'italic');
    });
    this.textLayer.addEventListener('paste', e => {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    window.addEventListener('resize', () => { this.rect = vp.getBoundingClientRect(); });
    // 觸控筆懸停時瀏覽器會送 pointermove；離開感應範圍送 relatedTarget 為 null 的 pointerout
    document.addEventListener('pointermove', e => { if (e.pointerType === 'pen') this._penIn(); }, true);
    document.addEventListener('pointerout', e => { if (e.pointerType === 'pen' && !e.relatedTarget) this._penOut(); }, true);
  }

  // 筆靠近之前就壓著的觸控是握筆的手掌：中止它的動作，之後也不再理它
  _penIn() {
    if (this.penNear) return;
    this.penNear = true;
    for (const [id, p] of this.pointers) if (p.type === 'touch') this.pointers.delete(id);
    if (this.action && this.action.ptype !== 'pen' && this.action.ptype !== 'mouse') this._abort();
  }

  _penOut() {
    this.penNear = false;
    this.penEraser = false;
    this.penLeftAt = performance.now();
    if (!this.action) this.cursor.hidden = true;
  }

  _touches() {
    return [...this.pointers.values()].filter(p => p.type === 'touch');
  }

  _down(e) {
    this._stopAnim();
    this.rect = this.vp.getBoundingClientRect();
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.downAt = performance.now();
    this.downType = e.pointerType;
    this.noFocusUntil = 0;
    if (e.pointerType === 'mouse' && e.button !== 0) {
      if (e.button === 1 && !this.action) {
        e.preventDefault();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'mouse' });
        this._startPan(e, null);
      }
      return;
    }
    if (this.spacePan && e.pointerType === 'mouse' && !this.action) {
      e.preventDefault();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'mouse' });
      this._startPan(e, null);
      try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }

    const isPen = e.pointerType === 'pen';
    const isTouch = e.pointerType === 'touch';
    if (isPen) this._penIn();
    else if (isTouch && (this.penNear || performance.now() - this.penLeftAt < PALM_GRACE)) return;

    if (this.readOnly) {
      e.preventDefault();
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      this._startPan(e, null);
      try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }

    if (isTouch && e.isPrimary) {
      // 新的觸控序列開始：清掉可能殘留的舊觸控點
      for (const [id, p] of this.pointers) if (p.type === 'touch') this.pointers.delete(id);
      if (this.action && this.action.ptype !== 'pen') this.action = null;
    }
    if (isPen) {
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
    const textEl = e.target.closest('.text-item');
    const editingText = textEl?.contains(document.activeElement);
    const check = e.target.closest('.md-check');
    if (check && textEl && !editingText && ['select', 'lasso', 'text'].includes(this.tool)) {
      e.preventDefault();
      this._toggleTask(textEl.dataset.id, Number(check.dataset.at));
      return;
    }
    // 文字工具，或點在正在編輯的文字框裡：交給瀏覽器放游標。
    // 不能先 blur 再讓瀏覽器 focus 回來，手機鍵盤會收起又跳出。
    if (textEl && (this.tool === 'text' || editingText)) return;

    e.preventDefault();
    this.commitText();
    if (document.activeElement?.matches('input, select, textarea')) document.activeElement.blur();
    try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const w = this.toWorld(e.clientX, e.clientY);
    const base = { id: e.pointerId, ptype: e.pointerType };
    // 裁切中：拖曳裁切框或把手調整範圍；其他地方拖曳＝移動畫布，點一下＝完成裁切
    if (this.cropping) {
      const crop = e.target.closest('[data-crop]');
      if (crop) return this._startCropDrag(base, w, crop.dataset.crop);
      return this._startPan(e, w);
    }
    // 觸控筆的橡皮擦端＝這一筆用橡皮擦。有的瀏覽器只給 button 5、沒給 buttons 32，兩個都看。
    // Chrome 懸停時看不出筆尾，輕碰也可能還沒標成橡皮擦；翻轉筆一定會離開感應範圍，
    // 所以擦過一次就記著，到筆離開前的每一筆都是橡皮擦
    if (isPen && (e.buttons & 32 || e.button === 5)) this.penEraser = true;
    let t = isPen && this.penEraser ? 'eraser' : this.tool;
    // 按住筆的側鍵（回報成 buttons 2）拖曳＝套索選取，什麼工具都一樣
    if (isPen && t !== 'eraser' && (e.buttons & 2 || e.button === 2)) return this._startLasso({ ...base, barrel: true }, w);
    const transform = e.target.closest('[data-transform]');
    if (transform && (t === 'select' || t === 'lasso')) return this._startTransform(base, w, transform.dataset.transform);
    // 選取工具下筆尖照樣用最後用過的畫筆寫，選取交給手指和滑鼠（把手、裁切在上面已經處理）
    if (isPen && t === 'select') t = this.lastBrush;

    if (t === 'pen' || t === 'hl' || t === 'eraser') {
      if (t === 'eraser') {
        this.action = { ...base, kind: 'erase', before: this._snap(), hit: false, last: w };
        this._showCursor(e);
        this._eraseAt(w);
      } else {
        this._startStroke(base, w, t);
      }
      return;
    }

    if (t === 'select' || t === 'lasso') {
      if (this.mouseMode) return this._mouseDown(e, base, w);
      // 拖曳已選取的物件（選取框內）＝移動物件；未選取的物件或空白處＝移動畫布。
      // 選取只在放開時（點一下）發生，不在按下時。
      if (this._inSelBox(w)) {
        this._startMove(base, w);
        // 已選取的文字框裡點連結＝開啟連結（拖曳仍是移動）
        this.action.link = e.target.closest('a.md-link')?.href;
        return;
      }
      if (t === 'lasso' && !itemEl) return this._startLasso(base, w);
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
    this.lastPointer = { x: e.clientX, y: e.clientY };
    const erasing = this.action?.kind === 'erase' && this.action.id === e.pointerId;
    const isPen = e.pointerType === 'pen';
    const eraserNear = isPen && (e.buttons & 32 || this.penEraser);
    if (erasing || (!this.action && (eraserNear || (this.tool === 'eraser' && e.pointerType !== 'touch')))) this._showCursor(e);
    // 筆尾輕碰時先被當成筆尖在畫，壓下去才標成橡皮擦（可能換了 pointerId）：整筆改成擦除
    if (this.action?.kind === 'draw' && this.action.ptype === 'pen' && isPen && e.buttons & 32) this._drawToErase(this.action, e);
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
    } else if (a.kind === 'marquee') {
      const w = this.toWorld(e.clientX, e.clientY);
      a.end = w;
      a.path.setAttribute('d', `M${a.at.x} ${a.at.y}H${w.x}V${w.y}H${a.at.x}Z`);
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
    } else if (a.kind === 'transform') {
      this._transform(a, this.toWorld(e.clientX, e.clientY));
    } else if (a.kind === 'crop') {
      this._cropDrag(a, this.toWorld(e.clientX, e.clientY));
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
        // 拿著畫筆用側鍵圈選：換到選取工具，手指才能拖動選到的東西（筆尖照樣能寫）
        if (a.barrel && this.sel.size && this.tool !== 'select' && this.tool !== 'lasso') this.cb.onTool?.('select');
        break;
      case 'marquee':
        this._endMarquee(a);
        break;
      case 'move':
        if (a.moved) this._finishMove(a);
        else if (a.link) this._openLink(a.link);
        else if (!a.picked) this._tapSelect(a.start);
        break;
      case 'transform':
        this._dragHandle(null);
        if (a.changed) { this._commit(a.before); this._rememberSize(); }
        this._updateSelBox();
        break;
      case 'pan':
        if (a.moved || !a.at) break;
        if (this.cropping) this.endCrop();
        else if (this.tool === 'text') this._newText(a.at);
        else if (this.tool === 'select' || this.tool === 'lasso') this._tapSelect(a.at);
        break;
    }
  }

  // 被雙指手勢或觸控筆打斷的動作
  _abort() {
    const a = this.action;
    this.action = null;
    if (!a) return;
    if (a.kind === 'transform') this._dragHandle(null);
    if (a.kind === 'draw' || a.kind === 'lasso' || a.kind === 'marquee') a.path.remove();
    else if (a.kind === 'move' && a.moved) this._finishMove(a);
    else if ((a.kind === 'transform' && a.changed) || (a.kind === 'erase' && a.hit)) this._commit(a.before);
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
    // 只停 animateView；滾輪自己的滑行要接著累加
    cancelAnimationFrame(this.anim);
    this.anim = 0;
    this.rect = this.vp.getBoundingClientRect();
    const k = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      const d = clamp(e.deltaY * k, -WHEEL_ZOOM_MAX, WHEEL_ZOOM_MAX);
      this.zoomAt(e.clientX - this.rect.left, e.clientY - this.rect.top, Math.exp(-d * 0.01));
      return;
    }
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (WIN_CHROMIUM && e.deltaMode === 0 && !e.shiftKey) [dx, dy] = this._unswap(e, dx, dy);
    // 只有直向滾輪的滑鼠：Shift+滾輪＝橫向（有些瀏覽器已經自己轉好）
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    // 一格一格的滾輪每格跳約 100px，補成短動畫，跟瀏覽器原生捲動一樣順；
    // 高解析度滾輪、觸控板本來就是連續的小數值，直接套用才跟手
    if (e.deltaMode === 1 || Math.max(Math.abs(dx), Math.abs(dy)) >= WHEEL_NOTCH) {
      this.glide.tau = e.timeStamp - this.thumbAt < WHEEL_BOTH ? WHEEL_GLIDE_BOTH : WHEEL_GLIDE;
      this._glide(dx, dy);
    } else this.setView(this.view.x - dx, this.view.y - dy, this.view.s);
  }

  // Windows 版 Chrome 為了舊的 Logitech 驅動，會把「跟前一則橫向滾動同一個時間刻度」的直向滾動
  // 當成橫向（ui/views/win/hwnd_message_handler.cc）。拇指滾輪和直向滾輪一起滾時，
  // 往下那一格就會變成往左一格（deltaX -100），畫面往反方向跳。認出這種整格的橫向事件，還原成直向。
  // wheelDelta 是「格數 × 120 ÷ devicePixelRatio」：整數格＝滾輪的一格，拇指滾輪只有零點幾格。
  // 觸控板（精確式觸控板、Mac）的 wheelDelta 跟 delta 一比一（取整數），不是滾輪，整段都不處理。
  _unswap(e, dx, dy) {
    const wx = e.wheelDeltaX ?? 0, wy = e.wheelDeltaY ?? 0;
    if ((dx && Math.abs(wx) === Math.trunc(Math.abs(e.deltaX))) || (dy && Math.abs(wy) === Math.trunc(Math.abs(e.deltaY)))) return [dx, dy];
    const dpr = devicePixelRatio || 1;
    const ticksX = wx * dpr / 120, ticksY = wy * dpr / 120;
    const whole = t => Math.abs(t) >= .95 && Math.abs(t - Math.round(t)) < .05;
    if (!dx && dy && whole(ticksY)) this.lineY = Math.abs(dy / Math.round(ticksY));
    if (dy || !dx) return [dx, dy];
    if (!whole(ticksX)) {
      this.thumbAt = e.timeStamp;
      this.thumbTicks = Math.abs(ticksX);
      return [dx, dy];
    }
    // 被改判的那一格前面是很小的拇指滾輪事件；拇指滾輪本身用力撥到接近一格時不算
    if (e.timeStamp - this.thumbAt > WHEEL_SWAPPED || this.thumbTicks >= .5) return [dx, dy];
    // 往下一格：wheelDeltaY -120 → 改判後 wheelDeltaX +120、deltaX -100；還原成 deltaY +100
    const ticks = Math.round(ticksX);
    return [0, ticks * (this.lineY || Math.abs(dx / ticks))];
  }

  // 把滾動距離累加起來，每個畫格走剩下距離的一部分（指數減速），連續滾動時會一直接續
  _glide(dx, dy) {
    const g = this.glide;
    g.x += dx;
    g.y += dy;
    if (g.frame) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.setView(this.view.x - g.x, this.view.y - g.y, this.view.s);
      g.x = g.y = 0;
      return;
    }
    let last = performance.now();
    const step = now => {
      const f = 1 - Math.exp(-(now - last) / g.tau);
      last = now;
      let sx = g.x * f, sy = g.y * f;
      if (Math.abs(g.x - sx) < .5 && Math.abs(g.y - sy) < .5) [sx, sy] = [g.x, g.y];
      g.x -= sx;
      g.y -= sy;
      this.setView(this.view.x - sx, this.view.y - sy, this.view.s);
      g.frame = g.x || g.y ? requestAnimationFrame(step) : 0;
    };
    g.frame = requestAnimationFrame(step);
  }

  // ---------- ink ----------
  _startStroke(base, w, tool) {
    const st = this.style[tool];
    const item = {
      id: uid(), type: 'stroke', tool, color: st.color,
      width: st.width, // 粗細固定，不隨畫面縮放改變
      pts: [[r1(w.x), r1(w.y)]],
    };
    const path = this._mount(item);
    this.action = { ...base, kind: 'draw', item, path, before: this._snap() };
  }

  _drawToErase(a, e) {
    a.path.remove();
    this.penEraser = true;
    this.pointers.delete(a.id);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'pen' });
    const [x, y] = a.item.pts[0];
    this.action = { id: e.pointerId, ptype: 'pen', kind: 'erase', before: a.before, hit: false, last: { x, y } };
    for (const [px, py] of a.item.pts) this._eraseAt({ x: px, y: py });
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
    if (it.type === 'image') {
      if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h };
      // 旋轉後的外框
      const c = Math.abs(Math.cos(it.rot * RAD)), s = Math.abs(Math.sin(it.rot * RAD));
      const w = it.w * c + it.h * s, ht = it.w * s + it.h * c;
      return { x: it.x + (it.w - w) / 2, y: it.y + (it.h - ht) / 2, w, h: ht };
    }
    const el = this.els.get(it.id);
    return { x: it.x, y: it.y, w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  }

  _updateSelBox() {
    // 文字框不能旋轉，選取裡有文字就不給旋轉把手
    const text = [...this.sel].some(id => this._item(id)?.type === 'text');
    for (const handle of this.selBox.children) handle.hidden = this.readOnly || (text && handle.dataset.transform === 'rotate');
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
    // 選取框在螢幕上至少 44px，細筆跡的把手才不會擠在一起、手指點框內不會誤觸把手
    const pad = 6 / this.view.s, min = 44 / this.view.s;
    const px = Math.max(pad, (min - (x1 - x0)) / 2), py = Math.max(pad, (min - (y1 - y0)) / 2);
    this.selBounds = { x0: x0 - px, y0: y0 - py, x1: x1 + px, y1: y1 + py };
    // 框在螢幕上太窄／太矮時，那個方向的邊中把手會跟角落擠在一起，CSS 把它藏掉
    this.selBox.toggleAttribute('data-narrow', (x1 - x0 + 2 * px) * this.view.s < 100);
    this.selBox.toggleAttribute('data-short', (y1 - y0 + 2 * py) * this.view.s < 100);
    this._placeSelBox(0, 0);
    this.selBox.hidden = !!this.cropping;
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

  // 該點命中的所有物件，依畫面上的疊放順序由上到下。
  // 畫面是分層畫的（圖片層 < 筆跡層 < 文字層），同層內 DOM 越後面越上層，
  // 跟 items 順序不一定相同，所以用 DOM 順序排，點選才會跟看到的一致。
  _hitsAt(w) {
    const r = 10 / this.view.s;
    const hits = this.items.filter(it => {
      if (!this.els.has(it.id)) return false;
      if (it.type === 'stroke') return strokeHit(it, w, r);
      if (it.type === 'image') {
        const l = imageLocal(it, w);
        return Math.abs(l.x) <= it.w / 2 && Math.abs(l.y) <= it.h / 2;
      }
      const b = this._box(it);
      return w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h;
    });
    return hits.sort((a, b) =>
      this.els.get(a.id).compareDocumentPosition(this.els.get(b.id)) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1);
  }

  // 點一下選最上層；在已選取的物件上再點一下改選下一層（到底後回到最上層）
  _tapSelect(w) {
    const hits = this._hitsAt(w);
    const cur = this.sel.size === 1 ? hits.findIndex(it => this.sel.has(it.id)) : -1;
    const hit = hits[(cur + 1) % hits.length];
    this.setSelection(hit ? [hit.id] : []);
  }

  // 選取工具雙擊文字框＝進入編輯（就算已經選取），雙擊圖片＝裁切。
  // pointerdown 有 setPointerCapture，dblclick 的 target 不可靠，改用座標找文字框。
  _dblEdit(e) {
    if (this.readOnly || this.action || !(this.tool === 'select' || this.tool === 'lasso')) return;
    if (this.downType === 'pen') return; // 筆尖在選取工具下是寫字，連點兩下不是要編輯文字
    if (document.activeElement?.closest?.('.text-item')) return;
    this.rect = this.vp.getBoundingClientRect();
    const hits = this._hitsAt(this.toWorld(e.clientX, e.clientY));
    const hit = hits.find(it => it.type === 'text') ?? (hits[0]?.type === 'image' ? hits[0] : null);
    if (!hit) return;
    e.preventDefault();
    if (this.cropping?.id === hit.id) return this.endCrop();
    this.setSelection([hit.id]);
    if (hit.type === 'image') return this.startCrop();
    this.els.get(hit.id)?.querySelector('.text-body')?.focus({ preventScroll: true });
  }

  // 套索與框選共用的虛線
  _selPath() {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'lasso');
    path.setAttribute('stroke-width', 1.5 / this.view.s);
    path.setAttribute('stroke-dasharray', `${6 / this.view.s} ${4 / this.view.s}`);
    this.svg.append(path);
    return path;
  }

  _startLasso(base, w) {
    this.action = { ...base, kind: 'lasso', path: this._selPath(), at: w, pts: [[r1(w.x), r1(w.y)]] };
  }

  // 滑鼠模式按下：點到未選取的物件＝選它並可直接拖動；選取範圍內＝拖動；空白處＝框選。
  // Shift+點物件＝加選／取消，Shift+框選＝加選。
  // 重疊時點下去先看已選取的：循環切到下層後要能直接拖它，不能又被最上層搶走。
  _mouseDown(e, base, w) {
    const hits = this._hitsAt(w);
    const hit = hits[0];
    if (e.shiftKey && hit) {
      const ids = new Set(this.sel);
      if (ids.has(hit.id)) ids.delete(hit.id); else ids.add(hit.id);
      return this.setSelection([...ids]);
    }
    const onSel = hits.some(it => this.sel.has(it.id));
    if (hit && !onSel) {
      this.setSelection([hit.id]);
      this._startMove(base, w);
      this.action.picked = true;
      return;
    }
    if (onSel || this._inSelBox(w)) {
      this._startMove(base, w);
      this.action.link = e.target.closest('a.md-link')?.href;
      return;
    }
    this.action = { ...base, kind: 'marquee', path: this._selPath(), at: w, end: w, add: e.shiftKey };
  }

  _endMarquee(a) {
    a.path.remove();
    const x0 = Math.min(a.at.x, a.end.x), x1 = Math.max(a.at.x, a.end.x);
    const y0 = Math.min(a.at.y, a.end.y), y1 = Math.max(a.at.y, a.end.y);
    if (Math.max(x1 - x0, y1 - y0) * this.view.s < 4) {
      if (!a.add) this.setSelection([]);
      return;
    }
    // 筆跡有任一點在框內就算；文字、圖片只要跟框重疊就算
    const ids = this.items.filter(it => {
      if (!this.els.has(it.id)) return false;
      if (it.type === 'stroke') return it.pts.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
      const b = this._box(it);
      return b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
    }).map(it => it.id);
    this.setSelection(a.add ? [...new Set([...this.sel, ...ids])] : ids);
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

  _startMove(base, w) {
    this.action = { ...base, kind: 'move', before: this._snap(), start: w, moved: false, dx: 0, dy: 0 };
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

  _startTransform(base, w, direction) {
    if (this.readOnly || !this.selBounds) return;
    const originals = [...this.sel].map(id => this._item(id)).filter(Boolean).map(it => structuredClone(it));
    if (direction === 'rotate' && originals.some(it => it.type === 'text')) return;
    // 自動寬度的文字框，拖左右把手時從目前的寬度開始改
    const widths = new Map(originals.filter(it => it.type === 'text').map(it => [it.id, it.w ?? this.els.get(it.id)?.offsetWidth ?? 0]));
    this.action = { ...base, kind: 'transform', direction, start: w, bounds: { ...this.selBounds }, before: this._snap(), changed: false,
      originals, widths, keepRatio: originals.some(it => it.type !== 'stroke') };
    this._dragHandle(direction);
  }

  // 拖曳把手時只顯示正在拉的那一個；null＝恢復
  _dragHandle(direction) {
    this.selBox.toggleAttribute('data-dragging', !!direction);
    for (const handle of this.selBox.children) handle.classList.toggle('dragging', handle.dataset.transform === direction);
  }

  _transform(a, point) {
    const b = a.bounds, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, d = a.direction;
    let sx = 1, sy = 1, angle = 0, ox = cx, oy = cy;
    if (d === 'rotate') {
      angle = Math.atan2(point.y - cy, point.x - cx) - Math.atan2(a.start.y - cy, a.start.x - cx);
      // 單張圖片轉到接近水平、垂直時吸過去
      const only = a.originals.length === 1 && a.originals[0];
      if (only?.type === 'image') {
        const deg = (only.rot ?? 0) + angle / RAD, snap = Math.round(deg / 90) * 90;
        if (Math.abs(deg - snap) < 4) angle += (snap - deg) * RAD;
      }
    } else {
      ox = d.includes('w') ? b.x1 : b.x0;
      oy = d.includes('n') ? b.y1 : b.y0;
      // 有圖片或文字時不翻面
      const safeScale = value => a.keepRatio ? Math.max(.05, Math.min(100, value))
        : Math.sign(value || 1) * Math.max(.05, Math.min(100, Math.abs(value)));
      if (d.includes('w') || d.includes('e')) sx = safeScale(1 + (point.x - a.start.x) / (d.includes('w') ? b.x0 - b.x1 : b.x1 - b.x0));
      if (d.includes('n') || d.includes('s')) sy = safeScale(1 + (point.y - a.start.y) / (d.includes('n') ? b.y0 - b.y1 : b.y1 - b.y0));
      // 有圖片或文字時拖角落固定比例，以拉動比較多的那一軸為準；只有筆跡時兩軸各自縮放
      if (a.keepRatio && d.length === 2) sx = sy = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    }
    if (!a.changed && Math.hypot(point.x - a.start.x, point.y - a.start.y) * this.view.s < 2) return;
    a.changed = true;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const map = d === 'rotate'
      ? (x, y) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]
      : (x, y) => [ox + (x - ox) * sx, oy + (y - oy) * sy];
    for (const o of a.originals) {
      const item = this._own(o.id);
      if (o.type === 'stroke') {
        item.pts = o.pts.map(([x, y]) => map(x, y).map(r1));
        item.width = Math.max(.1, r2(o.width * Math.sqrt(Math.abs(sx * sy))));
        const path = this.els.get(item.id);
        path.setAttribute('d', pathData(item.pts)); path.setAttribute('stroke-width', item.width);
        continue;
      }
      if (o.type === 'image') {
        const [ncx, ncy] = map(o.x + o.w / 2, o.y + o.h / 2);
        let w = o.w, ht = o.h;
        if (d === 'rotate') {
          item.rot = normDeg((o.rot ?? 0) + angle / RAD);
          if (!item.rot) delete item.rot;
        } else {
          // 旋轉過的圖片：沿著圖片自己的兩個邊各自縮放，保持長方形
          const r = (o.rot ?? 0) * RAD;
          w = o.w * Math.hypot(sx * Math.cos(r), sy * Math.sin(r));
          ht = o.h * Math.hypot(sx * Math.sin(r), sy * Math.cos(r));
        }
        item.w = r1(w); item.h = r1(ht);
        item.x = r1(ncx - w / 2); item.y = r1(ncy - ht / 2);
      } else {
        // 文字：左右把手改換行寬度；上下、角落把手連字一起縮放（比例會稍微不同，沒關係）
        [item.x, item.y] = map(o.x, o.y).map(r1);
        if (d === 'e' || d === 'w') item.w = r1(Math.max(o.size * 2, a.widths.get(o.id) * sx));
        else {
          const k = d === 'n' || d === 's' ? sy : sx;
          item.size = clamp(r2(o.size * k), 1, 2000);
          if (o.w) item.w = r1(o.w * k);
        }
      }
      this._place(item);
    }
    this._updateSelBox();
  }

  // ---------- text ----------
  _newText(w) {
    // 字級固定，不隨畫面縮放改變；格式用文字工具目前的設定
    const { size, ...look } = this.style.text;
    const item = { id: uid(), type: 'text', x: r1(w.x), y: r1(w.y - size * 0.8), size, ...look, text: '' };
    const before = this._snap();
    this.items.push(item);
    this._mount(item);
    this.editing = { id: item.id, item, before, orig: '', created: true };
    this._focusText(item.id);
    this.cb.onContext?.();
  }

  _focusText(id) {
    const body = this.els.get(id)?.querySelector('.text-body');
    if (!body) return;
    body.focus({ preventScroll: true });
    this._setCaret(body, null);
  }

  // 游標放在原始文字第 at 個字元；null = 最後面。編輯中的內容是 innerText 產生的文字節點與 <br>
  _setCaret(body, at) {
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    if (at != null) {
      for (const n of body.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (at <= n.length) { range.setStart(n, at); range.collapse(true); break; }
          at -= n.length;
        } else {
          if (at === 0) { range.setStartBefore(n); range.collapse(true); break; }
          at -= 1;
        }
      }
    }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 剛剛點在 markdown 顯示畫面的哪個位置，換算成原始文字的位置
  _tapOffset(body) {
    const map = sources.get(body), p = this.lastPointer;
    if (!map || !p || performance.now() - (this.downAt ?? 0) > 1000) return null;
    let pos = document.caretPositionFromPoint?.(p.x, p.y);
    if (!pos && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(p.x, p.y);
      pos = r && { offsetNode: r.startContainer, offset: r.startOffset };
    }
    if (!pos || !body.contains(pos.offsetNode)) return null;
    return sourceOffset(body, map, pos.offsetNode, pos.offset);
  }

  _renderText(id) {
    const el = this.els.get(id), item = this._item(id);
    if (!el || !item) return;
    const body = el.querySelector('.text-body');
    sources.set(body, renderMarkdown(body, item.text));
    if (this.sel.has(id)) this._updateSelBox();
  }

  _toggleTask(id, at) {
    const before = this._snap();
    const item = this._own(id);
    item.text = toggleTask(item.text, at);
    this._renderText(id);
    this._commit(before);
    // 手機點一下，瀏覽器之後還可能 focus 文字框；擋到下一次按下為止
    this.noFocusUntil = performance.now() + 800;
  }

  _openLink(href) {
    window.open(href, '_blank', 'noopener');
    this.noFocusUntil = performance.now() + 800;
  }

  _focusIn(e) {
    const el = e.target.closest?.('.text-item');
    if (!el) return;
    if (performance.now() < (this.noFocusUntil ?? 0)) { e.target.blur(); return; }
    setTimeout(() => this.revealCaret(), 350); // 等手機鍵盤動畫
    const id = el.dataset.id;
    if (this.editing?.id === id) return;
    const before = this._snap();
    const item = this._own(id);
    this.editing = { id, item, before, orig: item.text, created: false };
    this.cb.onContext?.();
    // 換成原始 markdown 編輯，游標放回點到的字；瀏覽器之後可能再依新版面放一次，所以下一輪再放一次
    const body = e.target;
    const at = this._tapOffset(body);
    sources.delete(body);
    body.innerText = item.text;
    this._setCaret(body, at);
    setTimeout(() => {
      if (document.activeElement === body && this.editing?.item === item && item.text === this.editing.orig) this._setCaret(body, at);
    }, 0);
    if (this.sel.has(id)) this._updateSelBox();
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
    } else {
      this._renderText(ed.id);
      if (ed.created || ed.styled || text !== ed.orig) this._commit(ed.before);
      // 焦點移到文字格式的選項（例如自訂顏色）：選取這個文字框，格式才套得到它
      if (e.relatedTarget?.closest?.('[data-keep-text]') && !this.sel.has(ed.id)) this.setSelection([ed.id]);
    }
    this.cb.onContext?.();
  }

  // ---------- render ----------
  _mount(item, beforeEl = null) {
    let el;
    if (item.type === 'stroke') {
      for (const [peer, path] of this.previews ?? []) if (path.dataset.previewId === item.id) { path.remove(); this.previews.delete(peer); }
      el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', pathData(item.pts));
      el.setAttribute('stroke', this.inkColor(item));
      el.setAttribute('stroke-width', item.width);
      if (item.tool === 'hl') el.setAttribute('class', 'hl');
      this.svg.insertBefore(el, beforeEl);
    } else if (item.type === 'text') {
      el = h('div', 'item text-item');
      const body = h('div', 'text-body');
      body.contentEditable = String(!this.readOnly);
      body.spellcheck = false;
      sources.set(body, renderMarkdown(body, item.text));
      el.append(body);
      this.textLayer.append(el);
    } else if (item.type === 'image') {
      el = h('div', 'item img-item');
      const clip = h('div', 'img-clip'), img = new Image();
      img.alt = '';
      img.draggable = false;
      clip.append(img);
      el.append(clip);
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
      // x、y、w、h 是裁切後、旋轉前的範圍，繞中心旋轉；img 放整張原圖，超出範圍的裁掉
      const c = item.crop ?? FULL;
      el.style.width = item.w + 'px';
      el.style.height = item.h + 'px';
      el.style.transform = item.rot ? `rotate(${item.rot}deg)` : '';
      Object.assign(el.querySelector('img').style, {
        width: 100 / c.w + '%', height: 100 / c.h + '%', left: -c.x / c.w * 100 + '%', top: -c.y / c.h * 100 + '%',
      });
    } else {
      el.classList.toggle('fixed-w', !!item.w);
      el.classList.toggle('boxed', !!(item.border || item.fill));
      el.style.setProperty('--bw', item.border ? (item.borderW ?? BORDER_W) + 'px' : '');
      Object.assign(el.style, {
        width: item.w ? item.w + 'px' : '',
        fontSize: item.size + 'px',
        fontWeight: item.bold ? '700' : '',
        fontStyle: item.italic ? 'italic' : '',
        fontFamily: FONTS[item.font] ?? '',
        ...textLook(item, this.canvas),
      });
    }
  }

  _renderAll() {
    this._cancelCrop();
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
