import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from '../js/vendor/fflate.js';
import { packNotebook, unpackNotebook, validateNotebook, renumber, fileName, nameFromFile, FORMAT } from '../js/notebook-core.js';

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
