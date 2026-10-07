// 小地圖：縮圖顯示整頁內容與目前畫面的位置，點一下或拖曳就能移動畫布
// 地圖範圍＝全部內容＋目前畫面，所以就算畫面移到很遠的空白處，也看得到「我在這、內容在那」

// 跟 css/style.css 裡 #viewport 的 --accent 一致：跟著畫布深淺，不跟著主題
const FRAME = { light: '#0078d4', dark: '#4daafc' };
const GRAY = '#8b8f97';

export class Minimap {
  constructor(board, canvas) {
    this.board = board;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.paths = new WeakMap(); // stroke item -> Path2D；item 不可變，改過就是新物件，快取自然失效
    this.map = null;            // 世界座標 -> 地圖座標：x * k + ox
    this.drag = null;
    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e));
  }

  draw() {
    const { canvas, ctx, board } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return; // 收合中
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const v = board.viewBounds(), c = board.contentBounds();
    // 拖曳中固定比例尺，否則畫面框會在手指底下跑掉
    const m = this.map = this.drag?.map ?? this._fit(w, h, v, c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 離內容很遠時內容會縮成幾個像素，加一個圓形標記，一眼就知道「內容在這」
    if (c && Math.max(c.x1 - c.x0, c.y1 - c.y0) * m.k < 12) {
      ctx.beginPath();
      ctx.arc((c.x0 + c.x1) / 2 * m.k + m.ox, (c.y0 + c.y1) / 2 * m.k + m.oy, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(128, 128, 128, .2)';
      ctx.fill();
      ctx.strokeStyle = GRAY;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.save();
    ctx.setTransform(dpr * m.k, 0, 0, dpr * m.k, dpr * m.ox, dpr * m.oy);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const it of board.items) this._drawItem(it, m.k);
    ctx.restore();

    if (!board.items.length) {
      ctx.fillStyle = GRAY;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('這頁還沒有內容', w / 2, h / 2 + 4);
    }
    // 目前畫面的框，放很大時也至少 6px 才點得到
    const rw = Math.max(6, (v.x1 - v.x0) * m.k), rh = Math.max(6, (v.y1 - v.y0) * m.k);
    const rx = (v.x0 + v.x1) / 2 * m.k + m.ox - rw / 2, ry = (v.y0 + v.y1) / 2 * m.k + m.oy - rh / 2;
    const frame = FRAME[board.darkCanvas ? 'dark' : 'light'];
    ctx.fillStyle = frame + '14'; // 8% 不透明
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = frame;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // 地圖範圍＝全部內容＋目前畫面
  _fit(w, h, v, c) {
    c ??= v;
    const x0 = Math.min(v.x0, c.x0), y0 = Math.min(v.y0, c.y0);
    const x1 = Math.max(v.x1, c.x1), y1 = Math.max(v.y1, c.y1);
    const pad = 8;
    const k = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0));
    return { k, ox: (w - (x1 - x0) * k) / 2 - x0 * k, oy: (h - (y1 - y0) * k) / 2 - y0 * k };
  }

  _drawItem(it, k) {
    const ctx = this.ctx;
    if (it.type === 'stroke') {
      let p = this.paths.get(it);
      if (!p) {
        p = new Path2D();
        it.pts.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y));
        if (it.pts.length === 1) p.lineTo(it.pts[0][0] + .01, it.pts[0][1]);
        this.paths.set(it, p);
      }
      ctx.globalAlpha = it.tool === 'hl' ? .5 : 1;
      ctx.strokeStyle = this.board.inkColor(it);
      ctx.lineWidth = Math.max(it.width, 1 / k); // 縮到很小也至少 1px
      ctx.stroke(p);
    } else if (it.type === 'image') {
      const img = this.board.els.get(it.id)?.querySelector('img');
      ctx.globalAlpha = 1;
      if (img?.complete && img.naturalWidth) ctx.drawImage(img, it.x, it.y, it.w, it.h);
      else {
        ctx.fillStyle = '#e5e5e5';
        ctx.fillRect(it.x, it.y, it.w, it.h);
      }
    } else if (it.type === 'text') {
      // 文字縮到地圖上讀不出來，畫成一行一條灰線
      const el = this.board.els.get(it.id);
      const lh = it.size * 1.45, tw = el?.offsetWidth ?? 0;
      const rows = Math.max(1, Math.round((el?.offsetHeight ?? lh) / lh));
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#a9adb4';
      for (let i = 0; i < rows; i++) {
        const last = rows > 1 && i === rows - 1;
        ctx.fillRect(it.x, it.y + i * lh + lh * .25, last ? tw * .6 : tw, Math.max(lh * .5, 1 / k));
      }
    }
  }

  _point(e) {
    const r = this.canvas.getBoundingClientRect(), m = this.map;
    return { x: (e.clientX - r.left - m.ox) / m.k, y: (e.clientY - r.top - m.oy) / m.k };
  }

  // 按在畫面框內＝拖曳框；按在框外＝畫面中心直接跳到該處，可以接著拖曳
  _down(e) {
    if (!this.map || this.drag) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this._point(e), v = this.board.viewBounds();
    const inside = p.x >= v.x0 && p.x <= v.x1 && p.y >= v.y0 && p.y <= v.y1;
    this.drag = {
      id: e.pointerId, map: this.map,
      dx: inside ? (v.x0 + v.x1) / 2 - p.x : 0,
      dy: inside ? (v.y0 + v.y1) / 2 - p.y : 0,
    };
    this.canvas.classList.add('dragging');
    this._move(e);
  }

  _move(e) {
    if (this.drag?.id !== e.pointerId) return;
    const p = this._point(e);
    this.board.centerOn(p.x + this.drag.dx, p.y + this.drag.dy);
  }

  _up(e) {
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    this.canvas.classList.remove('dragging');
    this.draw();
  }
}
