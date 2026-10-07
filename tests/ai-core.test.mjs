import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRegion, copyText, regionJson, buildPrompt, parseReply, toItems, replyItems, placeItems, itemsBox, simplify, summarize, FORMAT } from '../js/ai-core.js';

const items = () => [
  { id: 't1', type: 'text', x: 100, y: 100, size: 18, text: '# 會議\n重點' },
  { id: 't2', type: 'text', x: 100, y: 180, size: 18, w: 300, text: '待辦' },
  { id: 's1', type: 'stroke', tool: 'pen', color: '#1f2937', width: 3, pts: [[110, 120], [130, 125], [120, 160]] },
  { id: 'h1', type: 'stroke', tool: 'hl', color: '#fde047', width: 20, pts: [[100, 100], [150, 100]] },
  { id: 'i1', type: 'image', blobId: 'b', x: 200, y: 200, w: 200, h: 100 },
];
const area = { x: 76, y: 76, w: 348.33, h: 248 };
let n = 0;
const newId = () => 'new' + ++n;

test('export makes coordinates relative to the area and drops ids and blobs', () => {
  const out = exportRegion({ title: '工作', items: items(), area, selected: true });
  assert.equal(out.format, FORMAT);
  assert.equal(out.page, '工作');
  assert.equal(out.scope, 'selection');
  assert.deepEqual(out.area, { w: 348, h: 248 });
  assert.deepEqual(out.items[0], { type: 'text', x: 24, y: 24, size: 18, text: '# 會議\n重點' });
  assert.equal(out.items[1].w, 300);
  assert.deepEqual(out.items[2], { type: 'stroke', color: '#1f2937', width: 3, pts: [[34, 44], [54, 49], [44, 84]] });
  assert.equal(out.items[3].highlighter, true);
  assert.deepEqual(out.items[4], { type: 'image', x: 124, y: 124, w: 200, h: 100 });
  assert.ok(!JSON.stringify(out).includes('"id"'));
  assert.ok(!JSON.stringify(out).includes('blobId'));
  assert.equal(exportRegion({ title: '', items: [], area: null }).scope, 'page');
});

test('strokes fall back to boxes when there are too many points', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => [i, (i % 2) * 50]);
  const out = exportRegion({ title: '', items: [{ id: 's', type: 'stroke', tool: 'pen', color: '#000000', width: 2, pts }] });
  assert.deepEqual(out.items[0], { type: 'stroke', color: '#000000', width: 2, x: 0, y: 0, w: 4999, h: 50 });
});

test('simplify keeps the shape and drops points on a straight line', () => {
  assert.deepEqual(simplify([[0, 0], [1, 0.1], [2, 0], [3, 0], [3, 5]]), [[0, 0], [3, 0], [3, 5]]);
  assert.deepEqual(simplify([[0, 0]]), [[0, 0]]);
});

test('region JSON is valid with one item per line, and the prompt embeds it with the request', () => {
  const exported = exportRegion({ title: '工作', items: items(), area, selected: true });
  const json = regionJson(exported);
  assert.deepEqual(JSON.parse(json), exported);
  assert.equal(json.split('\n').filter(l => l.includes('"type"')).length, 5);
  assert.deepEqual(JSON.parse(regionJson(exportRegion({ title: '', items: [] }))).items, []);
  const prompt = buildPrompt(exported, '轉成條列');
  assert.ok(prompt.includes('轉成條列') && prompt.includes(json) && prompt.includes('"items"'));
  assert.ok(prompt.includes('框選'));
  assert.ok(prompt.includes('pts 是筆畫經過的點'));
  assert.ok(buildPrompt(exported).includes('幫我整理'), 'default request');
  assert.ok(buildPrompt(exportRegion({ title: '', items: [] })).includes('一整頁'));
});

test('parse reply accepts code fences, surrounding prose and bare arrays', () => {
  const list = [{ type: 'text', x: 0, y: 0, text: 'a' }];
  assert.deepEqual(parseReply(JSON.stringify({ items: list })), list);
  assert.deepEqual(parseReply('好的，以下是結果：\n```json\n' + JSON.stringify({ items: list }) + '\n```\n完成'), list);
  assert.deepEqual(parseReply('結果 ' + JSON.stringify({ items: list }) + ' 請使用'), list);
  assert.deepEqual(parseReply(JSON.stringify(list)), list);
  assert.throws(() => parseReply(''), /貼上/);
  assert.throws(() => parseReply('{"foo":1}'), /items/);
  assert.throws(() => parseReply('沒有 JSON'), /items/);
});

test('reply items become new text and strokes with defaults filled in', () => {
  const out = toItems([
    { type: 'text', x: 0, y: 10.04, text: '# 標題' },
    { type: 'text', x: 0, y: 60, text: '寬', size: 24, w: 200 },
    { type: 'stroke', pts: [[0, 0], [40, 0]] },
    { type: 'stroke', pts: [[0, 0], [40, 0]], highlighter: true },
    { type: 'stroke', pts: [[0, 0], [40, 0]], color: '#FF0000', width: 5 },
    { type: 'stroke', pts: [[0, 0], [40, 0]], color: 'red' },
  ], { newId, defaultSize: 20 });
  assert.deepEqual(out[0], { id: out[0].id, type: 'text', x: 0, y: 10, size: 20, text: '# 標題' });
  assert.equal(out[1].size, 24);
  assert.equal(out[1].w, 200);
  assert.deepEqual(out[2], { id: out[2].id, type: 'stroke', tool: 'pen', color: '#1f2937', width: 3, pts: [[0, 0], [40, 0]] });
  assert.equal(out[3].tool, 'hl');
  assert.equal(out[3].color, '#fde047');
  assert.equal(out[3].width, 20);
  assert.equal(out[4].color, '#ff0000');
  assert.equal(out[4].width, 5);
  assert.equal(out[5].color, '#1f2937', 'unknown colors fall back to the pen color');
  assert.equal(new Set(out.map(it => it.id)).size, out.length);
  assert.deepEqual(summarize(out), { counts: '文字框 2、筆跡 4', lines: ['＋ # 標題', '＋ 寬', '＋ 4 條筆跡'] });
});

test('any invalid item rejects the whole reply', () => {
  const bad = [
    [{ type: 'image', x: 0, y: 0, w: 1, h: 1 }, /不能新增圖片/],
    [{ type: 'circle' }, /不認得/],
    [null, /格式/],
    [{ type: 'text', x: 'a', y: 0, text: 'x' }, /座標/],
    [{ type: 'text', x: 0, y: 0, text: '  ' }, /空的/],
    [{ type: 'text', x: 0, y: 0, text: 'x', size: -1 }, /字級/],
    [{ type: 'stroke', pts: [[0, 0]] }, /至少要 2 個點/],
    [{ type: 'stroke', pts: [[0, 0], [1, 'x']] }, /筆跡座標/],
    [{ type: 'stroke', pts: [[0, 0], [1, 1]], width: 0 }, /筆寬/],
  ];
  for (const [item, pattern] of bad) assert.throws(() => toItems([item], { newId }), pattern, JSON.stringify(item));
  assert.throws(() => toItems([]), /沒有給/);
  assert.throws(() => toItems([{ type: 'text', x: 0, y: 0, text: 'ok' }, { type: 'image' }]), /第 2 個/);
});

test('placing moves the whole group so its top-left lands on the point', () => {
  const group = toItems([
    { type: 'text', x: 50, y: 40, text: 'ab', size: 10 },
    { type: 'stroke', pts: [[30, 100], [90, 100]], width: 4 },
  ], { newId });
  const box = itemsBox(group);
  assert.deepEqual(box, { x: 28, y: 40, w: 64, h: 62 });
  const placed = placeItems(group, { x: 500, y: 300 });
  assert.deepEqual([placed[0].x, placed[0].y], [522, 300]);
  assert.deepEqual(placed[1].pts, [[502, 360], [562, 360]]);
  assert.deepEqual(itemsBox(placed), { x: 500, y: 300, w: 64, h: 62 });
  assert.equal(group[0].x, 50, 'input is not mutated');
});

test('pasted text is only treated as an AI reply when it has valid items', () => {
  assert.equal(replyItems('一般文字', { newId }), null);
  assert.equal(replyItems('{"items":[{"type":"image"}]}', { newId }), null);
  assert.equal(replyItems('[{"type":"text","x":0,"y":0,"text":"沒有 items 鍵"}]', { newId }), null);
  const got = replyItems('```json\n{"items":[{"type":"text","x":0,"y":0,"text":"hi"}]}\n```', { newId });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'hi');
});

test('copied items keep full detail and paste back as new items', () => {
  const source = items();
  const text = copyText(source, area);
  const data = JSON.parse(text);
  assert.equal(data.format, FORMAT);
  assert.ok(data.note.includes('{"items":[…]}'));
  assert.deepEqual(data.items[2], { type: 'stroke', color: '#1f2937', width: 3, pts: [[34, 44], [54, 49], [44, 84]] });
  assert.deepEqual(data.items[4], { type: 'image', x: 124, y: 124, w: 200, h: 100, blob: 'b' });
  const pasted = replyItems(text, { newId });
  assert.equal(pasted.length, 5);
  assert.deepEqual(pasted.map(it => it.type), ['text', 'text', 'stroke', 'stroke', 'image']);
  assert.equal(pasted[3].tool, 'hl');
  assert.equal(pasted[4].blobId, 'b');
  assert.ok(pasted.every(it => !source.some(s => s.id === it.id)), 'fresh ids');
  const placed = placeItems(pasted, { x: 1000, y: 1000 });
  // 外框左上角是螢光筆的 (90,90)（筆寬 20），整組平移 910
  assert.deepEqual(placed[0], { ...source[0], id: pasted[0].id, x: 1010, y: 1010 }, 'relative layout survives the round trip');
  assert.deepEqual(placed[2].pts, source[2].pts.map(([x, y]) => [x + 910, y + 910]));
  assert.deepEqual(summarize(pasted).counts, '文字框 2、筆跡 2、圖片 1');
  assert.throws(() => toItems([{ type: 'image', x: 0, y: 0, w: 0, h: 1, blob: 'b' }]), /圖片位置/);
  assert.throws(() => toItems([{ type: 'image', x: 0, y: 0, w: 1, h: 1, blob: '../x' }]), /不能新增圖片/);
});
