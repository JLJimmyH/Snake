import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPage, pageJson, buildPrompt, parseReply, applyOps, summarize, FORMAT } from '../js/ai-core.js';

const items = () => [
  { id: 't1', type: 'text', x: 0, y: 0, size: 18, text: '# 會議\n重點' },
  { id: 't2', type: 'text', x: 0, y: 80, size: 18, w: 300, text: '待辦' },
  { id: 's1', type: 'stroke', tool: 'pen', color: '#1f2937', width: 3, pts: [[10, 20], [30, 25], [20, 60]] },
  { id: 'h1', type: 'stroke', tool: 'hl', color: '#fde047', width: 20, pts: [[0, 0], [50, 0]] },
  { id: 'i1', type: 'image', blobId: 'b', x: 100, y: 100, w: 200, h: 100 },
];
let n = 0;
const newId = () => 'new' + ++n;

test('export keeps text, reduces strokes to boxes and drops points', () => {
  const out = exportPage({ title: '工作', items: items(), area: { x: -24, y: -24, w: 348.33, h: 248 } });
  assert.equal(out.format, FORMAT);
  assert.equal(out.page, '工作');
  assert.deepEqual(out.area, { x: -24, y: -24, w: 348.3, h: 248 });
  assert.deepEqual(out.items[0], { id: 't1', type: 'text', x: 0, y: 0, size: 18, text: '# 會議\n重點' });
  assert.equal(out.items[1].w, 300);
  assert.deepEqual(out.items[2], { id: 's1', type: 'stroke', x: 10, y: 20, w: 20, h: 40, color: '#1f2937' });
  assert.equal(out.items[3].highlighter, true);
  assert.deepEqual(out.items[4], { id: 'i1', type: 'image', x: 100, y: 100, w: 200, h: 100 });
  assert.ok(!JSON.stringify(out).includes('pts'));
  assert.ok(!JSON.stringify(out).includes('blobId'));
});

test('page JSON is valid with one item per line, and the prompt embeds it with the request', () => {
  const exported = exportPage({ title: '工作', items: items() });
  const json = pageJson(exported);
  assert.deepEqual(JSON.parse(json), exported);
  assert.equal(json.split('\n').filter(l => l.includes('"id"')).length, 5);
  assert.deepEqual(JSON.parse(pageJson(exportPage({ title: '', items: [] }))).items, []);
  const prompt = buildPrompt(exported, '轉成條列');
  assert.ok(prompt.includes('轉成條列') && prompt.includes(json));
  assert.ok(buildPrompt(exported).includes('幫我整理'), 'default request');
  assert.ok(!prompt.includes('area'), 'no screenshot hint without area');
});

test('parse reply accepts code fences, surrounding prose and bare arrays', () => {
  const ops = [{ op: 'delete', id: 't1' }];
  assert.deepEqual(parseReply(JSON.stringify({ ops })), ops);
  assert.deepEqual(parseReply('好的，以下是修改：\n```json\n' + JSON.stringify({ ops }) + '\n```\n完成'), ops);
  assert.deepEqual(parseReply('結果 ' + JSON.stringify({ ops }) + ' 請套用'), ops);
  assert.deepEqual(parseReply(JSON.stringify(ops)), ops);
  assert.throws(() => parseReply(''), /貼上/);
  assert.throws(() => parseReply('{"foo":1}'), /ops/);
  assert.throws(() => parseReply('沒有 JSON'), /ops/);
});

test('apply update, move, add and delete without touching anything else', () => {
  const source = items();
  const frozen = JSON.stringify(source);
  const { items: out, changes } = applyOps(source, [
    { op: 'update', id: 't1', text: '## 會議重點' },
    { op: 'update', id: 't2', w: null, size: 24 },
    { op: 'move', id: 's1', x: 110, y: 220 },
    { op: 'move', id: 'i1', x: 5, y: 6 },
    { op: 'add', x: 0, y: 300, text: '新的' },
    { op: 'delete', id: 'h1' },
  ], { newId });
  assert.equal(JSON.stringify(source), frozen, 'input is not mutated');
  assert.equal(out.find(i => i.id === 't1').text, '## 會議重點');
  const t2 = out.find(i => i.id === 't2');
  assert.equal(t2.size, 24);
  assert.ok(!('w' in t2), 'w: null switches back to auto width');
  assert.deepEqual(out.find(i => i.id === 's1').pts, [[110, 220], [130, 225], [120, 260]], 'strokes move by their box');
  assert.deepEqual(out.find(i => i.id === 'i1'), { id: 'i1', type: 'image', blobId: 'b', x: 5, y: 6, w: 200, h: 100 });
  assert.ok(!out.some(i => i.id === 'h1'));
  const added = out.at(-1);
  assert.deepEqual(added, { id: added.id, type: 'text', x: 0, y: 300, size: 18, text: '新的' }, 'new text uses the common size');
  assert.equal(changes.length, 6);
  const sum = summarize(changes);
  assert.equal(sum.counts, '修改 2、新增 1、移動 2、刪除 1');
  assert.equal(sum.warn, '會刪除 1 個筆跡或圖片');
  assert.ok(sum.lines.some(l => l.includes('# 會議 → ## 會議重點')));
});

test('any invalid op rejects the whole batch', () => {
  const bad = [
    [{ op: 'update', id: 'nope', text: 'x' }, /找不到/],
    [{ op: 'update', id: 's1', text: 'x' }, /只能修改文字框/],
    [{ op: 'update', id: 't1' }, /沒有要修改/],
    [{ op: 'move', id: 't1', x: 'a', y: 0 }, /座標/],
    [{ op: 'add', type: 'image', x: 0, y: 0, text: 'x' }, /只能新增文字框/],
    [{ op: 'add', x: 0, y: 0, text: '  ' }, /空的/],
    [{ op: 'add', x: 0, y: 0, text: 'x', size: -1 }, /字級/],
    [{ op: 'rotate', id: 't1' }, /不認得/],
    [{ op: 'delete', id: 't1' }, { op: 'move', id: 't1', x: 0, y: 0 }, /已經被刪除/],
  ];
  for (const entry of bad) {
    const pattern = entry.pop();
    assert.throws(() => applyOps(items(), entry, { newId }), pattern, JSON.stringify(entry));
  }
  assert.throws(() => applyOps(items(), []), /沒有提出/);
  assert.throws(() => applyOps(items(), [{ op: 'delete', id: 't1' }, { op: 'delete', id: 'x' }]), /第 2 個操作/);
});
