// AI 整理：把一頁內容匯出成 AI 看得懂的精簡 JSON，AI 回傳操作清單（ops），驗證後再套用。
// AI 不直接改原始資料：沒提到的物件一律不動，筆跡與圖片只能移動或刪除。
import { uid } from './db.js';

export const FORMAT = 'snake-note-ai';
const MAX_OPS = 5000;
const MAX_ITEMS = 20000;
const MAX_TEXT = 100000;
const OPS = ['update', 'move', 'add', 'delete'];

const r1 = n => Math.round(n * 10) / 10;
const num = n => Number.isFinite(n) && Math.abs(n) <= 1e7;

// 筆跡座標的外框（不含筆寬）
function strokeBox(it) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of it.pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) };
}

// area：截圖涵蓋的世界座標範圍（由畫面量測，文字框高度只有 DOM 知道）
export function exportPage({ title, items, area }) {
  return {
    format: FORMAT,
    page: title || '未命名',
    ...(area && { area: { x: r1(area.x), y: r1(area.y), w: r1(area.w), h: r1(area.h) } }),
    items: items.map(it => {
      if (it.type === 'text') return { id: it.id, type: 'text', x: it.x, y: it.y, ...(it.w && { w: it.w }), size: it.size, text: it.text };
      if (it.type === 'stroke') return { id: it.id, type: 'stroke', ...strokeBox(it), color: it.color, ...(it.tool === 'hl' && { highlighter: true }) };
      return { id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h };
    }),
  };
}

// 一個物件一行：筆跡很多時比縮排格式短很多，AI 也比較好對照
export function pageJson(exported) {
  const { items, ...head } = exported;
  const lines = items.map(it => '    ' + JSON.stringify(it));
  return JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "items": [\n${lines.join(',\n')}\n  ]\n}`);
}

export function buildPrompt(exported, request = '') {
  const ask = request.trim() || '幫我整理這頁筆記：讓文字更清楚、有條理，版面排整齊。';
  return `你是筆記整理助手。下面是白板筆記中一頁的內容（JSON），請依照我的要求整理，並且只回傳一段 JSON：{"ops":[…]}，不要其他說明。

## 筆記格式
- 座標：x 往右、y 往下，單位是畫布像素；x、y 是物件左上角。
- text：文字框。text 是 Markdown（# 標題、**粗體**、*斜體*、- 清單、- [ ] 待辦、- [x] 已完成、[文字](網址)、\`程式碼\`）。size 是字級，w 是固定寬度（沒有 w 就自動寬度，最寬約 32 個字）。
- stroke：手寫筆跡，只提供外框 x/y/w/h 和顏色，看不到寫了什麼。highlighter 表示螢光筆。
- image：圖片，只提供外框。
${exported.area ? `- 如果我附上截圖，截圖範圍就是 area（世界座標），可以依比例對照到各物件。\n` : ''}
## 可以用的操作
{"op":"update","id":"…","text":"…"}                  修改文字框內容（也可以帶 size、w）
{"op":"move","id":"…","x":0,"y":0}                     移動任何物件到新的左上角
{"op":"add","type":"text","x":0,"y":0,"text":"…"}     新增文字框（也可以帶 size、w）
{"op":"delete","id":"…"}                              刪除任何物件

## 規則
- 只列出要改的物件，沒提到的保持不動。
- id 必須來自下面的 JSON。
- 筆跡和圖片的內容不能改，只能移動或刪除。
- 除非我要求，不要刪除筆跡和圖片。把手寫轉成文字時，新增文字框並保留原本的筆跡。
- 不要讓物件互相重疊。

## 我的要求
${ask}

## 筆記內容
\`\`\`json
${pageJson(exported)}
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
    const ops = Array.isArray(value) ? value : value?.ops;
    if (Array.isArray(ops)) return ops;
  }
  throw new Error('看不懂這段回覆：需要 {"ops":[…]} 格式的 JSON');
}

// 套用 ops，回傳新的 items 與摘要；任何一個操作有問題就整批不套用
export function applyOps(items, ops, { newId = uid, defaultSize = 18 } = {}) {
  if (!Array.isArray(ops)) throw new Error('ops 必須是陣列');
  if (!ops.length) throw new Error('AI 沒有提出任何修改');
  if (ops.length > MAX_OPS) throw new Error(`操作太多（上限 ${MAX_OPS} 個）`);
  const sizes = items.filter(it => it.type === 'text').map(it => it.size);
  const size = sizes.length ? mode(sizes) : defaultSize;
  const out = items.slice();
  const index = new Map(out.map((it, i) => [it.id, i]));
  const deleted = new Set();
  const errors = [];
  const changes = [];
  const fail = (i, msg) => errors.push(`第 ${i + 1} 個操作：${msg}`);
  const own = id => (out[index.get(id)] = { ...out[index.get(id)] });

  ops.forEach((op, i) => {
    if (!op || typeof op !== 'object' || !OPS.includes(op.op)) return fail(i, `不認得的操作 ${JSON.stringify(op?.op ?? op)}`);
    if (op.op === 'add') {
      if (op.type !== undefined && op.type !== 'text') return fail(i, '只能新增文字框');
      const bad = checkText(op, true);
      if (bad) return fail(i, bad);
      const item = { id: newId(), type: 'text', x: r1(op.x), y: r1(op.y), size: op.size ?? size, text: op.text };
      if (op.w) item.w = r1(op.w);
      index.set(item.id, out.length);
      out.push(item);
      changes.push({ op: 'add', item });
      return;
    }
    if (!index.has(op.id)) return fail(i, `找不到物件 ${JSON.stringify(op.id)}`);
    if (deleted.has(op.id)) return fail(i, `物件 ${op.id} 已經被刪除`);
    const it = out[index.get(op.id)];
    if (op.op === 'delete') {
      deleted.add(op.id);
      changes.push({ op: 'delete', item: it });
    } else if (op.op === 'move') {
      if (!num(op.x) || !num(op.y)) return fail(i, '座標不合法');
      const copy = own(op.id);
      if (it.type === 'stroke') {
        const b = strokeBox(it), dx = op.x - b.x, dy = op.y - b.y;
        copy.pts = it.pts.map(([x, y]) => [r1(x + dx), r1(y + dy)]);
      } else {
        copy.x = r1(op.x); copy.y = r1(op.y);
      }
      changes.push({ op: 'move', item: copy });
    } else {
      if (it.type !== 'text') return fail(i, '只能修改文字框，筆跡和圖片只能移動或刪除');
      if (op.text === undefined && op.size === undefined && op.w === undefined) return fail(i, '沒有要修改的內容');
      const bad = checkText(op, false);
      if (bad) return fail(i, bad);
      const copy = own(op.id);
      if (op.text !== undefined) copy.text = op.text;
      if (op.size !== undefined) copy.size = op.size;
      if (op.w !== undefined) { if (op.w) copy.w = r1(op.w); else delete copy.w; }
      changes.push({ op: 'update', item: copy, before: it });
    }
  });

  const result = out.filter(it => !deleted.has(it.id));
  if (result.length > MAX_ITEMS) errors.push(`物件太多（上限 ${MAX_ITEMS} 個）`);
  if (errors.length) throw new Error(errors.slice(0, 5).join('\n') + (errors.length > 5 ? `\n…還有 ${errors.length - 5} 個錯誤` : ''));
  return { items: result, changes };
}

function checkText(op, adding) {
  if (adding && (!num(op.x) || !num(op.y))) return '座標不合法';
  if (adding || op.text !== undefined) if (typeof op.text !== 'string' || op.text.length > MAX_TEXT) return '文字不合法';
  if (adding && !op.text.trim()) return '文字是空的';
  if (op.size !== undefined && !(num(op.size) && op.size > 0 && op.size <= 1000)) return '字級不合法';
  if (op.w !== undefined && op.w !== null && !(num(op.w) && op.w >= 0)) return '寬度不合法';
  return null;
}

const mode = values => {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
};

// 給使用者確認的摘要
export function summarize(changes) {
  const kind = { stroke: '筆跡', text: '文字框', image: '圖片' };
  const count = op => changes.filter(c => c.op === op).length;
  const counts = [['update', '修改'], ['add', '新增'], ['move', '移動'], ['delete', '刪除']]
    .filter(([op]) => count(op)).map(([op, label]) => `${label} ${count(op)}`);
  const snippet = text => { const line = text.trim().split('\n')[0]; return line.length > 30 ? line.slice(0, 30) + '…' : line; };
  const lines = changes.map(c => {
    if (c.op === 'add') return `＋ 新增文字：${snippet(c.item.text)}`;
    if (c.op === 'update') return `✎ 修改文字：${snippet(c.before.text)} → ${snippet(c.item.text)}`;
    const what = kind[c.item.type] + (c.item.type === 'text' ? `「${snippet(c.item.text)}」` : '');
    return c.op === 'move' ? `↔ 移動${what}` : `✕ 刪除${what}`;
  });
  const deletes = changes.filter(c => c.op === 'delete' && c.item.type !== 'text').length;
  return { counts: counts.join('、'), lines, warn: deletes ? `會刪除 ${deletes} 個筆跡或圖片` : '' };
}
