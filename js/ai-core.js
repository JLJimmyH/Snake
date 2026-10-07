// AI 協作：把框選的一塊區域（沒選就整頁）匯出成 AI 看得懂的精簡 JSON，
// AI 回傳一組「新元件」（文字框、筆跡），使用者點畫布決定放哪裡。原本的內容一律不動，方便對照。
import { uid } from './db.js';

export const FORMAT = 'snake-note-ai';
const MAX_ITEMS = 5000;
const MAX_PTS = 5000;          // 單一筆跡最多幾個點
const MAX_EXPORT_PTS = 4000;   // 匯出時全部筆跡加起來最多給幾個點，超過就只給外框
const MAX_TEXT = 100000;
const PEN = { color: '#1f2937', width: 3 };
const HL = { color: '#fde047', width: 20 };

const r1 = n => Math.round(n * 10) / 10;
const num = n => Number.isFinite(n) && Math.abs(n) <= 1e7;

// 筆跡座標的外框（不含筆寬）
function strokeBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Ramer–Douglas–Peucker：保留形狀、去掉多餘的點，給 AI 的筆跡才不會太長
export function simplify(pts, tolerance = 1.5) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, best = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > best) { best = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// area：匯出範圍（世界座標）。座標一律換成以 area 左上角為 (0,0)，AI 回傳的新元件也用同一套座標
export function exportRegion({ title, items, area, selected = false }) {
  const ox = area?.x ?? 0, oy = area?.y ?? 0;
  const at = (x, y) => [Math.round(x - ox), Math.round(y - oy)];
  const strokes = items.filter(it => it.type === 'stroke').map(it => simplify(it.pts));
  const withPts = strokes.reduce((n, pts) => n + pts.length, 0) <= MAX_EXPORT_PTS;
  let s = 0;
  return {
    format: FORMAT,
    page: title || '未命名',
    scope: selected ? 'selection' : 'page',
    ...(area && { area: { w: Math.round(area.w), h: Math.round(area.h) } }),
    items: items.map(it => {
      if (it.type === 'text') {
        const [x, y] = at(it.x, it.y);
        return { type: 'text', x, y, ...(it.w && { w: r1(it.w) }), size: it.size, text: it.text };
      }
      if (it.type === 'stroke') {
        const pts = strokes[s++];
        const b = strokeBox(pts), [x, y] = at(b.x, b.y);
        const look = { color: it.color, width: it.width, ...(it.tool === 'hl' && { highlighter: true }) };
        if (withPts) return { type: 'stroke', ...look, pts: pts.map(([px, py]) => at(px, py)) };
        return { type: 'stroke', ...look, x, y, w: Math.round(b.w), h: Math.round(b.h) };
      }
      const [x, y] = at(it.x, it.y);
      return { type: it.type, x, y, w: Math.round(it.w), h: Math.round(it.h) };
    }),
  };
}

// 一個物件一行：筆跡很多時比縮排格式短很多，AI 也比較好對照
export function regionJson(exported) {
  const { items, ...head } = exported;
  const lines = items.map(it => '    ' + JSON.stringify(it));
  return JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "items": [\n${lines.join(',\n')}\n  ]\n}`);
}

export function buildPrompt(exported, request = '') {
  const what = exported.scope === 'selection' ? '我從白板筆記框選的一塊區域' : '白板筆記的一整頁';
  const ask = request.trim() || '幫我整理這段內容：手寫轉成文字、重點整理成清楚的條列。';
  const strokesHavePts = exported.items.some(it => it.type === 'stroke' && it.pts);
  return `你是筆記助手。下面是${what}（JSON）。請依照我的要求產生「新的內容」，只回傳一段 JSON：{"items":[…]}，不要其他說明。
你回傳的內容會當成新物件貼到畫布上，原本的內容不會被改動，所以請給完整的結果，不要只給差異。

## 筆記格式
- 座標：以這塊區域的左上角為 (0,0)，x 往右、y 往下，單位是畫布像素。area 是區域大小。
- text：文字框，x、y 是左上角。text 是 Markdown（# 標題、**粗體**、*斜體*、- 清單、- [ ] 待辦、- [x] 已完成、[文字](網址)、\`程式碼\`）。size 是字級，w 是固定寬度（沒有 w 就自動寬度，最寬約 32 個字）。
- stroke：手寫筆跡。${strokesHavePts ? 'pts 是筆畫經過的點（已簡化）。' : '只提供外框 x/y/w/h，看不到寫了什麼。'}width 是筆寬，highlighter 表示螢光筆。
- image：圖片，只提供外框。
- 如果我附上截圖，截圖範圍就是這塊區域，可以依比例對照座標。

## 回傳格式
{"items":[
  {"type":"text","x":0,"y":0,"text":"# 標題\\n- 重點","size":18},
  {"type":"stroke","pts":[[0,0],[40,0],[40,30]],"color":"#1f2937","width":3}
]}
- text 必填 x、y、text；size、w 可省略。
- stroke 必填 pts（至少 2 個點）；color（#rrggbb）、width、highlighter 可省略。可以用來畫底線、框線、箭頭、圖表。
- 不能新增圖片。
- 新內容之間不要互相重疊；整體位置不重要，使用者會自己選地方放。

## 我的要求
${ask}

## 筆記內容
\`\`\`json
${regionJson(exported)}
\`\`\`
`;
}

// AI 回覆常常包在 ```json … ``` 裡，或前後多一段說明：找出第一段能解析的 JSON
export function parseReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('請先貼上 AI 的回覆');
  const candidates = [raw];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1]);
  const start = raw.search(/[[{]/), end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const c of candidates) {
    let value;
    try { value = JSON.parse(c); } catch { continue; }
    const items = Array.isArray(value) ? value : value?.items;
    if (Array.isArray(items)) return items;
  }
  throw new Error('看不懂這段回覆：需要 {"items":[…]} 格式的 JSON');
}

// 驗證 AI 給的元件並轉成畫布物件（座標仍是區域座標）；任何一個有問題就整批不收
export function toItems(raw, { newId = uid, defaultSize = 18 } = {}) {
  if (!Array.isArray(raw)) throw new Error('items 必須是陣列');
  if (!raw.length) throw new Error('AI 沒有給任何內容');
  if (raw.length > MAX_ITEMS) throw new Error(`內容太多（上限 ${MAX_ITEMS} 個）`);
  const errors = [];
  const items = [];
  raw.forEach((it, i) => {
    const bad = !it || typeof it !== 'object' ? '格式不對'
      : it.type === 'text' ? checkText(it)
      : it.type === 'stroke' ? checkStroke(it)
      : it.type === 'image' ? '不能新增圖片'
      : `不認得的類型 ${JSON.stringify(it.type)}`;
    if (bad) return errors.push(`第 ${i + 1} 個：${bad}`);
    if (it.type === 'text') {
      const item = { id: newId(), type: 'text', x: r1(it.x), y: r1(it.y), size: it.size ?? defaultSize, text: it.text };
      if (it.w) item.w = r1(it.w);
      items.push(item);
    } else {
      const look = it.highlighter ? HL : PEN;
      items.push({
        id: newId(), type: 'stroke', tool: it.highlighter ? 'hl' : 'pen',
        color: /^#[0-9a-f]{6}$/i.test(it.color) ? it.color.toLowerCase() : look.color,
        width: it.width ?? look.width,
        pts: it.pts.map(([x, y]) => [r1(x), r1(y)]),
      });
    }
  });
  if (errors.length) throw new Error(errors.slice(0, 5).join('\n') + (errors.length > 5 ? `\n…還有 ${errors.length - 5} 個錯誤` : ''));
  return items;
}

function checkText(it) {
  if (!num(it.x) || !num(it.y)) return '座標不合法';
  if (typeof it.text !== 'string' || it.text.length > MAX_TEXT) return '文字不合法';
  if (!it.text.trim()) return '文字是空的';
  if (it.size !== undefined && !(num(it.size) && it.size > 0 && it.size <= 1000)) return '字級不合法';
  if (it.w !== undefined && it.w !== null && !(num(it.w) && it.w >= 0)) return '寬度不合法';
  return null;
}

function checkStroke(it) {
  if (!Array.isArray(it.pts) || it.pts.length < 2) return '筆跡至少要 2 個點';
  if (it.pts.length > MAX_PTS) return `筆跡的點太多（上限 ${MAX_PTS}）`;
  if (!it.pts.every(p => Array.isArray(p) && num(p[0]) && num(p[1]))) return '筆跡座標不合法';
  if (it.width !== undefined && !(num(it.width) && it.width > 0 && it.width <= 200)) return '筆寬不合法';
  return null;
}

// 文字框的大小要排版後才知道，這裡粗估（中文字約 1 個字級寬），給放置預覽框用
function roughBox(it) {
  if (it.type === 'stroke') {
    const b = strokeBox(it.pts), p = it.width / 2;
    return { x: b.x - p, y: b.y - p, w: b.w + it.width, h: b.h + it.width };
  }
  const lines = it.text.split('\n');
  const longest = Math.max(...lines.map(l => [...l].length));
  return { x: it.x, y: it.y, w: it.w || Math.min(longest, 32) * it.size + 8, h: lines.length * it.size * 1.45 + 4 };
}

export function itemsBox(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    const b = roughBox(it);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 整組平移，讓外框左上角落在 at（世界座標）；相對位置不變
export function placeItems(items, at) {
  const b = itemsBox(items), dx = at.x - b.x, dy = at.y - b.y;
  return items.map(it => it.type === 'stroke'
    ? { ...it, pts: it.pts.map(([x, y]) => [r1(x + dx), r1(y + dy)]) }
    : { ...it, x: r1(it.x + dx), y: r1(it.y + dy) });
}

// 貼上的文字是不是 AI 的回覆：是就回傳元件，不是就回傳 null（當一般文字貼上）
export function replyItems(text, options) {
  if (!/"items"\s*:/.test(text)) return null;
  try { return toItems(parseReply(text), options); } catch { return null; }
}

// 給使用者確認的摘要
export function summarize(items) {
  const count = type => items.filter(it => it.type === type).length;
  const counts = [['text', '文字框'], ['stroke', '筆跡']].filter(([t]) => count(t)).map(([t, label]) => `${label} ${count(t)}`);
  const snippet = text => { const line = text.trim().split('\n')[0]; return line.length > 30 ? line.slice(0, 30) + '…' : line; };
  const lines = items.filter(it => it.type === 'text').map(it => `＋ ${snippet(it.text)}`);
  if (count('stroke')) lines.push(`＋ ${count('stroke')} 條筆跡`);
  return { counts: counts.join('、'), lines };
}
