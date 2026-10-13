import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from '../js/vendor/fflate.js';
import { packNotebook, unpackNotebook, readZip, validateNotebook, renumber, fileName, nameFromFile, FORMAT, toFile, fromFile, snapshot, sameSnapshot, mergeNotebook } from '../js/notebook-core.js';

const png = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
const local = () => ({
  name: '工作筆記',
  pages: [
    { id: 'root', notebookId: 'nb', parentId: null, title: '工作', order: 0, open: true, created: 1 },
    { id: 'child', notebookId: 'nb', parentId: 'root', title: '會議', order: 0, open: false, created: 2 },
  ],
  // child 還沒編輯過，沒有 doc
  docs: [{ pageId: 'root', view: { x: 1, y: 2, s: 1.5 }, items: [
    { id: 't1', type: 'text', x: 0, y: 0, size: 18, text: '<b>純文字</b>' },
    { id: 's1', type: 'stroke', pts: [[0, 0], [10, 5]], color: '#1f2937', width: 3, tool: 'pen' },
    { id: 'i1', type: 'image', blobId: 'img', x: 5, y: 5, w: 100, h: 50 },
  ] }],
  blobs: new Map([['img', png], ['unused', png]]),
});
const json = value => new TextEncoder().encode(JSON.stringify(value));
const zip = files => new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v instanceof Uint8Array ? v : json(v)])))]);
const minimal = { 'manifest.json': { format: FORMAT, schema: 1, name: 'x' }, 'pages.json': [{ id: 'a', parentId: null, title: 'A', order: 0 }], 'docs/a.json': { pageId: 'a', view: { x: 0, y: 0, s: 1 }, items: [] } };

test('pack → unpack round-trips pages, content and images with fresh IDs', async () => {
  const source = local();
  const result = await unpackNotebook(await packNotebook(source));
  assert.equal(result.name, '工作筆記');
  assert.equal(result.pages.length, 2);
  const root = result.pages.find(p => p.title === '工作'), child = result.pages.find(p => p.title === '會議');
  assert.notEqual(root.id, 'root');
  assert.equal(child.parentId, root.id);
  assert.equal(child.open, false);
  assert.equal(result.pages.some(p => 'notebookId' in p), false);
  const doc = result.docs.find(d => d.pageId === root.id);
  assert.deepEqual(doc.view, { x: 1, y: 2, s: 1.5 });
  assert.equal(doc.items[0].text, '<b>純文字</b>');
  const image = doc.items.find(i => i.type === 'image');
  assert.notEqual(image.blobId, 'img');
  assert.equal(result.blobs.size, 1, 'unreferenced images are not exported');
  const blob = result.blobs.get(image.blobId);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(await png.arrayBuffer()));
  assert.deepEqual(result.docs.find(d => d.pageId === child.id).items, [], 'page without doc gets empty content');
});

test('opening the same file twice never reuses page or image IDs', async () => {
  const file = await packNotebook(local());
  const [a, b] = [await unpackNotebook(file), await unpackNotebook(file)];
  const ids = notebook => [...notebook.pages.map(p => p.id), ...notebook.blobs.keys()];
  assert.equal(new Set([...ids(a), ...ids(b)]).size, ids(a).length * 2);
});

test('renumber retries colliding IDs', () => {
  const sequence = ['same', 'same', 'other'];
  const result = renumber({ pages: [{ id: 'a', parentId: null, title: '', order: 0 }, { id: 'b', parentId: 'a', title: '', order: 1 }], docs: [], blobs: new Map() }, () => sequence.shift());
  assert.deepEqual(result.pages.map(p => p.id), ['same', 'other']);
  assert.equal(result.pages[1].parentId, 'same');
});

test('accepts a zip re-compressed inside a folder and ignores macOS metadata', async () => {
  const files = Object.fromEntries(Object.entries(minimal).map(([k, v]) => ['工作筆記/' + k, v]));
  const result = await unpackNotebook(zip({ ...files, '__MACOSX/工作筆記/._manifest.json': new Uint8Array([0]) }));
  assert.equal(result.pages[0].title, 'A');
});

test('rejects files that are not notebooks', async () => {
  await assert.rejects(unpackNotebook(new Blob(['not a zip'])), /不是有效的 zip/);
  await assert.rejects(unpackNotebook(zip({ 'readme.txt': new Uint8Array([1]) })), /manifest/);
  await assert.rejects(unpackNotebook(zip({ ...minimal, 'manifest.json': { format: 'other', schema: 1 } })), /不是筆記本/);
  await assert.rejects(unpackNotebook(zip({ ...minimal, 'manifest.json': { format: FORMAT, schema: 2 } })), /較新/);
  const { 'docs/a.json': _, ...noDoc } = minimal;
  await assert.rejects(unpackNotebook(zip(noDoc)), /缺少 docs\/a.json/);
});

test('rejects zip bombs by declared size before inflating', async () => {
  const big = new Uint8Array(21 * 1024 * 1024); // compresses to a few KB
  await assert.rejects(unpackNotebook(zip({ ...minimal, 'images/a.png': big })), /過大/);
});

test('validation rejects cycles, missing images, bad IDs and unsafe values', () => {
  const notebook = () => ({ pages: [{ id: 'a', parentId: null, title: 'A', order: 0 }], docs: [{ pageId: 'a', view: { x: 0, y: 0, s: 1 }, items: [] }], blobs: new Map() });
  const cycle = notebook(); cycle.pages[0].parentId = 'a'; assert.throws(() => validateNotebook(cycle), /循環/);
  const missing = notebook(); missing.docs[0].items = [{ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, blobId: 'nope' }]; assert.throws(() => validateNotebook(missing), /圖片/);
  const proto = notebook(); proto.pages[0].id = '__proto__'; proto.docs[0].pageId = '__proto__'; assert.throws(() => validateNotebook(proto));
  const path = notebook(); path.pages[0].id = '../x'; path.docs[0].pageId = '../x'; assert.throws(() => validateNotebook(path));
  const zoom = notebook(); zoom.docs[0].view.s = 0; assert.throws(() => validateNotebook(zoom), /視角/);
  const huge = notebook(); huge.docs[0].items = [{ id: 't', type: 'text', x: Infinity, y: 0, size: 18, text: 'x' }]; assert.throws(() => validateNotebook(huge));
  const nullDoc = notebook(); nullDoc.docs = [null]; assert.throws(() => validateNotebook(nullDoc), /頁面內容/);
});

test('Drive file name is the notebook name plus .zip', () => {
  assert.equal(fileName('  工作筆記 '), '工作筆記.zip');
  assert.equal(fileName(''), '未命名筆記本.zip');
  assert.equal(nameFromFile('工作筆記.ZIP'), '工作筆記');
  assert.equal(nameFromFile('notes.v2.zip'), 'notes.v2');
});

// ---------- 同步 ----------
const page = (id, title, extra = {}) => ({ id, parentId: null, title, order: 0, open: true, created: 1, ...extra });
const text = (id, value) => ({ id, type: 'text', x: 0, y: 0, size: 18, text: value });
const book = (pages, items = {}, name = '筆記') => ({
  name, pages, blobs: new Map(),
  docs: pages.map(p => ({ pageId: p.id, view: { x: 0, y: 0, s: 1 }, items: items[p.id] ?? [] })),
});
const itemsOf = (content, id) => content.docs.find(d => d.pageId === id).items;
let counter = 0;
const fresh = () => 'n' + ++counter;

test('readZip keeps file IDs; pack → readZip round-trips', async () => {
  const result = await readZip(await packNotebook(local()));
  assert.deepEqual(result.pages.map(p => p.id), ['root', 'child']);
  assert.equal(result.docs[0].items[2].blobId, 'img');
  assert.deepEqual([...result.blobs.keys()], ['img']);
});

test('toFile / fromFile map only colliding IDs and reuse the mapping', () => {
  const file = book([page('a', 'A'), page('b', 'B', { parentId: 'a' })], { a: [{ id: 'i', type: 'image', blobId: 'x', x: 0, y: 0, w: 1, h: 1 }] });
  file.blobs = new Map([['x', png]]);
  const first = fromFile(file, {}, new Set(['a', 'x']), fresh);
  const [a, b] = first.content.pages;
  assert.notEqual(a.id, 'a'); assert.equal(b.id, 'b'); assert.equal(b.parentId, a.id);
  const blobId = itemsOf(first.content, a.id)[0].blobId;
  assert.notEqual(blobId, 'x'); assert.ok(first.content.blobs.has(blobId));
  assert.deepEqual(first.ids, { [a.id]: 'a', [blobId]: 'x' });
  // 再開一次：同樣的檔案 ID 對到同樣的本機 ID
  const again = fromFile(file, first.ids, new Set(['a', 'x']), fresh);
  assert.deepEqual(again.content.pages.map(p => p.id), [a.id, 'b']);
  // 轉回檔案 ID
  const back = toFile({ name: '筆記', ...first.content }, first.ids);
  assert.deepEqual(back.pages.map(p => [p.id, p.parentId]), [['a', null], ['b', 'a']]);
  assert.equal(itemsOf(back, 'a')[0].blobId, 'x');
  assert.ok(back.blobs.has('x'));
});

test('fromFile never hands one local ID to two file IDs', () => {
  // 舊對照表：本機 p 對到檔案 q；檔案裡現在又出現一個叫 p 的頁面
  const result = fromFile(book([page('q', 'Q'), page('p', 'P')]), { p: 'q' }, new Set(), fresh);
  const ids = result.content.pages.map(x => x.id);
  assert.equal(ids[0], 'p'); assert.notEqual(ids[1], 'p');
  assert.equal(new Set(ids).size, 2);
});

test('snapshot ignores view, expanded state and key order', () => {
  const a = book([page('a', 'A')], { a: [text('t', 'x')] });
  const b = book([page('a', 'A', { open: false })], { a: [{ text: 'x', size: 18, y: 0, x: 0, type: 'text', id: 't' }] });
  b.docs[0].view = { x: 99, y: 9, s: 2 };
  assert.ok(sameSnapshot(snapshot(a), snapshot(b)));
  b.docs[0].items[0].text = 'y';
  assert.ok(!sameSnapshot(snapshot(a), snapshot(b)));
});

test('merge takes each page from the side that changed it', () => {
  const base = book([page('a', 'A'), page('b', 'B', { order: 1 })], { a: [text('1', 'a')], b: [text('2', 'b')] });
  const local = structuredClone(base); itemsOf(local, 'a').push(text('3', 'local'));
  const remote = structuredClone(base); itemsOf(remote, 'b').push(text('4', 'remote')); remote.pages[1].title = 'B2';
  const { content, conflicts } = mergeNotebook(snapshot(base), local, remote, fresh);
  assert.equal(conflicts, 0);
  assert.deepEqual(itemsOf(content, 'a').map(i => i.text), ['a', 'local']);
  assert.deepEqual(itemsOf(content, 'b').map(i => i.text), ['b', 'remote']);
  assert.equal(content.pages[1].title, 'B2');
});

test('merge keeps both versions when the same page changed on both sides', () => {
  const base = book([page('a', 'A')], { a: [text('1', 'a')] });
  const local = structuredClone(base); itemsOf(local, 'a').push(text('2', 'mine'));
  const remote = structuredClone(base); itemsOf(remote, 'a').push(text('3', 'theirs'));
  const { content, conflicts } = mergeNotebook(snapshot(base), local, remote, fresh);
  assert.equal(conflicts, 1);
  assert.deepEqual(itemsOf(content, 'a').map(i => i.text), ['a', 'mine']);
  const copy = content.pages.find(p => p.id !== 'a');
  assert.equal(copy.title, 'A（衝突副本）');
  assert.deepEqual(itemsOf(content, copy.id).map(i => i.text), ['a', 'theirs']);
});

test('merge deletes a page removed on one side only if the other side left it alone', () => {
  const base = book([page('a', 'A'), page('b', 'B'), page('c', 'C')], { b: [text('1', 'b')] });
  const local = book([page('a', 'A'), page('b', 'B')], { b: [text('1', 'b'), text('2', 'edited')] });  // 刪 c、改 b
  const remote = book([page('a', 'A'), page('c', 'C')]);  // 刪 b
  const { content } = mergeNotebook(snapshot(base), local, remote, fresh);
  assert.deepEqual(content.pages.map(p => p.id), ['a', 'b']);
  assert.equal(itemsOf(content, 'b').length, 2);
});

test('merge adds new pages from both sides and fixes orphans and cycles', () => {
  const base = book([page('a', 'A'), page('b', 'B')]);
  const local = book([page('a', 'A', { parentId: 'b' }), page('b', 'B'), page('l', 'L', { parentId: 'gone' })]);
  const remote = book([page('a', 'A'), page('b', 'B', { parentId: 'a' }), page('r', 'R')]);
  const { content } = mergeNotebook(snapshot(base), local, remote, fresh);
  assert.deepEqual(content.pages.map(p => p.id).sort(), ['a', 'b', 'l', 'r']);
  assert.equal(content.pages.find(p => p.id === 'l').parentId, null);
  validateNotebook(content);
});

test('merge takes the renamed notebook name and unions images', () => {
  const base = book([page('a', 'A')]);
  const local = book([page('a', 'A')], {}, '新名字');
  const remote = book([page('a', 'A')], { a: [{ id: 'i', type: 'image', blobId: 'x', x: 0, y: 0, w: 1, h: 1 }] });
  remote.blobs = new Map([['x', png]]);
  const { content } = mergeNotebook(snapshot(base), local, remote, fresh);
  assert.equal(content.name, '新名字');
  assert.ok(content.blobs.has('x'));
});
