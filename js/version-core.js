// Pure, browser/Node-compatible version format. Drive and IndexedDB share it.
export const FORMAT = 'note-mvp-history';
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_BYTES = 100 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export async function hash(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Blob ? await value.arrayBuffer() : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function ensure(test, message = '版本資料格式錯誤') { if (!test) throw new Error(message); }
export const emptyTree = () => ({ pages: {}, docs: {} });
export function validateTree(tree) {
  ensure(tree && tree.pages && tree.docs && Object.keys(tree.pages).length <= 2000);
  for (const group of ['pages', 'docs']) {
    ensure(typeof tree[group] === 'object' && !Array.isArray(tree[group]));
    for (const [id, value] of Object.entries(tree[group])) ensure(ID.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && HASH.test(value));
  }
  ensure(canonical(Object.keys(tree.pages).sort()) === canonical(Object.keys(tree.docs).sort()));
}
export function delta(before, after) {
  const result = {};
  for (const group of ['pages', 'docs']) result[group] = {
    set: Object.fromEntries(Object.entries(after[group]).filter(([id, value]) => before[group][id] !== value)),
    remove: Object.keys(before[group]).filter(id => !(id in after[group])),
  };
  return result;
}
export function applyDelta(before, change) {
  const result = structuredClone(before);
  for (const group of ['pages', 'docs']) {
    ensure(change?.[group] && Array.isArray(change[group].remove));
    for (const id of change[group].remove) delete result[group][id];
    for (const [id, value] of Object.entries(change[group].set)) {
      ensure(ID.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && HASH.test(value));
      result[group][id] = value;
    }
  }
  validateTree(result);
  return result;
}
export async function makeCommit({ tree, previousTree = emptyTree(), parent = null, depth = 0, device, message = '', restoredFrom = null, now = new Date().toISOString() }) {
  validateTree(tree);
  const data = { format: FORMAT, schema: 1, parent, depth, device, createdAt: now, message: message.slice(0, 200), stateHash: await hash(canonical(tree)) };
  if (restoredFrom) data.restoredFrom = restoredFrom;
  if (!parent || depth % 10 === 0) data.snapshot = tree;
  else data.delta = delta(previousTree, tree);
  return { id: await hash(canonical(data)), ...data };
}
export async function verifyCommit(commit) {
  ensure(commit?.format === FORMAT && commit.schema === 1 && HASH.test(commit.id), '不支援的版本格式');
  const { id, ...data } = commit;
  ensure(await hash(canonical(data)) === id, '版本校驗失敗，檔案可能不完整');
  ensure(commit.parent === null || HASH.test(commit.parent));
  ensure(!commit.restoredFrom || HASH.test(commit.restoredFrom));
  ensure(Number.isSafeInteger(commit.depth) && commit.depth >= 0 && commit.depth < 100000);
  ensure(typeof commit.device === 'string' && commit.device.length <= 100 && typeof commit.message === 'string' && commit.message.length <= 200);
  ensure(typeof commit.createdAt === 'string' && Number.isFinite(Date.parse(commit.createdAt)) && HASH.test(commit.stateHash));
  ensure(Boolean(commit.snapshot) !== Boolean(commit.delta));
  if (!commit.parent) ensure(commit.snapshot && commit.depth === 0);
  return commit;
}
export async function resolveTree(id, readCommit) {
  const chain = [], seen = new Set();
  let next = id;
  while (next) {
    ensure(!seen.has(next) && seen.size < 1000, '版本鏈過長或有循環'); seen.add(next);
    const commit = await verifyCommit(await readCommit(next));
    ensure(commit.id === next);
    chain.push(commit);
    if (commit.snapshot) break;
    next = commit.parent;
  }
  ensure(chain.length && chain.at(-1).snapshot, '版本缺少完整快照');
  let tree;
  let previous;
  for (const commit of chain.reverse()) {
    if (previous) ensure(commit.parent === previous.id && commit.depth === previous.depth + 1, '版本鏈不一致');
    tree = commit.snapshot ? structuredClone(commit.snapshot) : applyDelta(tree, commit.delta);
    validateTree(tree);
    ensure(await hash(canonical(tree)) === commit.stateHash, '版本內容校驗失敗');
    previous = commit;
  }
  return tree;
}
export function heads(commits) {
  const ancestors = new Set(commits.flatMap(c => [c.parent, c.restoredFrom]).filter(Boolean));
  return commits.filter(c => !ancestors.has(c.id));
}
export function validateWorkspace({ pages, docs, blobs }) {
  ensure(Array.isArray(pages) && pages.length > 0 && pages.length <= 2000, '頁面數量不合法');
  const pageMap = new Map(pages.map(p => [p.id, p]));
  ensure(pageMap.size === pages.length, '頁面 ID 重複');
  let count = 0;
  for (const p of pages) {
    ensure(ID.test(p.id) && typeof p.title === 'string' && p.title.length <= 10000 && Number.isFinite(p.order));
    ensure(p.parentId == null || pageMap.has(p.parentId), '頁面上層不存在');
    const seen = new Set([p.id]); let parent = p.parentId;
    while (parent) { ensure(!seen.has(parent) && seen.size < 200, '頁面分類循環或過深'); seen.add(parent); parent = pageMap.get(parent).parentId; }
  }
  ensure(docs.length === pages.length && new Set(docs.map(d => d.pageId)).size === pages.length);
  for (const doc of docs) {
    ensure(pageMap.has(doc.pageId) && Array.isArray(doc.items));
    ensure(doc.view && ['x', 'y', 's'].every(key => Number.isFinite(doc.view[key])) && doc.view.s >= .1 && doc.view.s <= 8);
    const ids = new Set();
    for (const item of doc.items) {
      ensure(++count <= 20000 && ID.test(item.id) && !ids.has(item.id), '物件數量或 ID 不合法'); ids.add(item.id);
      ensure(['stroke', 'text', 'image'].includes(item.type), '不支援的物件類型');
      for (const key of ['x', 'y', 'w', 'h', 'size', 'width']) if (item[key] !== undefined) ensure(Number.isFinite(item[key]) && Math.abs(item[key]) <= 1e7);
      if (item.type === 'stroke') {
        ensure(Array.isArray(item.pts) && item.pts.length > 0 && item.pts.length <= 100000 && item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)));
        ensure(/^#[0-9a-f]{6}$/i.test(item.color) && item.width > 0 && ['pen', 'hl'].includes(item.tool));
      } else {
        ensure(Number.isFinite(item.x) && Number.isFinite(item.y));
        if (item.type === 'text') ensure(typeof item.text === 'string' && item.text.length <= 100000 && item.size > 0);
        else ensure(item.w > 0 && item.h > 0 && HASH.test(item.blobId) && blobs.has(item.blobId), '圖片遺失');
      }
    }
  }
}
export function compareWorkspaces(before, after) {
  const changes = [];
  const oldPages = new Map(before.pages.map(p => [p.id, p]));
  const newPages = new Map(after.pages.map(p => [p.id, p]));
  const oldDocs = new Map(before.docs.map(d => [d.pageId, d]));
  const newDocs = new Map(after.docs.map(d => [d.pageId, d]));
  for (const id of new Set([...oldPages.keys(), ...newPages.keys()])) {
    const old = oldPages.get(id), next = newPages.get(id);
    if (canonical(old) !== canonical(next)) changes.push({ kind: 'page', action: !old ? '新增' : !next ? '刪除' : '修改', title: next?.title || old?.title || '未命名', before: old, after: next });
    const a = new Map((oldDocs.get(id)?.items ?? []).map(i => [i.id, i]));
    const b = new Map((newDocs.get(id)?.items ?? []).map(i => [i.id, i]));
    for (const itemId of new Set([...a.keys(), ...b.keys()])) {
      const first = a.get(itemId), second = b.get(itemId);
      if (canonical(first) !== canonical(second)) changes.push({ kind: second?.type || first.type, action: !first ? '新增' : !second ? '刪除' : '修改', title: next?.title || old?.title || '未命名', before: first, after: second });
    }
  }
  return changes;
}
