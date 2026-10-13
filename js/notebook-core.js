// 筆記本檔案格式：一本筆記本 = 一個 zip。匯出／匯入與 Drive 共用。
//   manifest.json       { format, schema, name, savedAt }
//   pages.json          頁面樹
//   docs/<pageId>.json  每頁的白板內容
//   images/<blobId>.png 圖片原檔
import { zipSync, unzipSync } from './vendor/fflate.js';
import { uid } from './db.js';

export const FORMAT = 'snake-note-notebook';
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_FILES = 25000;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const DEFAULT_VIEW = { x: 40, y: 40, s: 1 };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));
// 允許使用者解壓後再重新壓縮（外面多包一層資料夾）
const ENTRY = /^(?:[^/]+\/)?(?:manifest\.json|pages\.json|docs\/[^/]+\.json|images\/[^/]+)$/;

export function ensure(test, message = '筆記本格式錯誤') { if (!test) throw new Error(message); }
const validId = id => typeof id === 'string' && ID.test(id) && !RESERVED.includes(id);
// 圖片裁切範圍：原圖上的比例 0～1
export const validCrop = c => !!c && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(c[k]) && c[k] >= 0 && c[k] <= 1)
  && c.w > 0 && c.h > 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001;
export const cleanName = name => String(name ?? '').trim().slice(0, 100) || '未命名筆記本';
// Drive 檔名 = 筆記本名稱 + .zip
export const fileName = name => cleanName(name) + '.zip';
export const nameFromFile = file => cleanName(String(file ?? '').replace(/\.zip$/i, ''));

export function validateNotebook({ pages, docs, blobs }) {
  ensure(Array.isArray(pages) && pages.length > 0 && pages.length <= 2000, '頁面數量不合法');
  const pageMap = new Map(pages.map(p => [p?.id, p]));
  ensure(pageMap.size === pages.length, '頁面 ID 重複');
  for (const p of pages) {
    ensure(validId(p.id) && typeof p.title === 'string' && p.title.length <= 10000 && Number.isFinite(p.order), '頁面資料不合法');
    ensure(p.shared === undefined || p.shared === null || validId(p.shared), '頁面資料不合法');
    ensure(p.parentId == null || pageMap.has(p.parentId), '頁面上層不存在');
    const seen = new Set([p.id]); let parent = p.parentId;
    while (parent) { ensure(!seen.has(parent) && seen.size < 200, '頁面分類循環或過深'); seen.add(parent); parent = pageMap.get(parent).parentId; }
  }
  ensure(Array.isArray(docs) && docs.length === pages.length && new Set(docs.map(d => d?.pageId)).size === pages.length, '頁面內容不完整');
  let count = 0;
  for (const doc of docs) {
    ensure(doc && pageMap.has(doc.pageId) && Array.isArray(doc.items), '頁面內容不合法');
    ensure(doc.view && ['x', 'y', 's'].every(key => Number.isFinite(doc.view[key])) && doc.view.s >= .1 && doc.view.s <= 8, '頁面視角不合法');
    const ids = new Set();
    for (const item of doc.items) {
      ensure(item && ++count <= 20000 && validId(item.id) && !ids.has(item.id), '物件數量或 ID 不合法'); ids.add(item.id);
      ensure(['stroke', 'text', 'image'].includes(item.type), '不支援的物件類型');
      for (const key of ['x', 'y', 'w', 'h', 'size', 'width', 'rot']) if (item[key] !== undefined) ensure(Number.isFinite(item[key]) && Math.abs(item[key]) <= 1e7, '物件座標不合法');
      if (item.type === 'stroke') {
        ensure(Array.isArray(item.pts) && item.pts.length > 0 && item.pts.length <= 100000 && item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)), '筆跡資料不合法');
        ensure(/^#[0-9a-f]{6}$/i.test(item.color) && item.width > 0 && ['pen', 'hl'].includes(item.tool), '筆跡資料不合法');
      } else {
        ensure(Number.isFinite(item.x) && Number.isFinite(item.y), '物件座標不合法');
        if (item.type === 'text') {
          ensure(typeof item.text === 'string' && item.text.length <= 100000 && item.size > 0, '文字資料不合法');
          ensure(item.color === undefined || /^#[0-9a-f]{6}$/i.test(item.color), '文字資料不合法');
        } else {
          ensure(item.w > 0 && item.h > 0 && validId(item.blobId) && blobs.has(item.blobId), '圖片遺失');
          ensure(item.crop === undefined || validCrop(item.crop), '圖片裁切不合法');
        }
      }
    }
  }
}

const usedImages = docs => new Set(docs.flatMap(d => d.items.filter(i => i.type === 'image').map(i => i.blobId)));

// 只留檔案裡要存的欄位；還沒編輯過的頁面沒有 doc，補上空白內容
function normalize({ pages, docs, blobs }) {
  const byPage = new Map(docs.map(d => [d.pageId, d]));
  return {
    // shared：這一頁共用出去時對應的 Drive 檔案 ID
    pages: pages.map(p => ({ id: p.id, parentId: p.parentId ?? null, title: p.title ?? '', order: p.order, open: p.open !== false, created: Number.isFinite(p.created) ? p.created : 0, ...(p.shared ? { shared: p.shared } : {}) })),
    docs: pages.map(p => {
      const doc = byPage.get(p.id), view = doc?.view ?? DEFAULT_VIEW;
      return { pageId: p.id, view: { x: view.x, y: view.y, s: view.s }, items: doc?.items ?? [] };
    }),
    blobs,
  };
}

// 本機資料 → zip
export async function packNotebook({ name, pages, docs, blobs }) {
  const content = normalize({ pages, docs, blobs });
  validateNotebook(content);
  const files = {};
  let total = 0;
  const add = (path, bytes, level) => {
    total += bytes.length;
    ensure(total <= MAX_BYTES, '筆記本超過 100 MB，請先減少大型圖片');
    files[path] = [bytes, { level }];
  };
  const json = value => new TextEncoder().encode(JSON.stringify(value));
  add('manifest.json', json({ format: FORMAT, schema: 1, name: cleanName(name), savedAt: new Date().toISOString() }), 6);
  add('pages.json', json(content.pages), 6);
  for (const doc of content.docs) add(`docs/${doc.pageId}.json`, json(doc), 6);
  // 圖片本身已壓縮過，只存不壓
  for (const id of usedImages(content.docs)) {
    const blob = blobs.get(id);
    ensure(blob.size <= MAX_IMAGE, '單張圖片超過 20 MB');
    add(`images/${id}.${EXT[blob.type] ?? 'bin'}`, new Uint8Array(await blob.arrayBuffer()), 0);
  }
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

// zip → 驗證過、ID 全部換新的筆記本內容（匯入：當成一本新的筆記本）
export async function unpackNotebook(file) {
  const { name, ...content } = await readZip(file);
  return { name, ...renumber(content) };
}

// zip → 驗證過的筆記本內容，保留檔案裡的 ID（同步要靠它對應頁面）。檔案來自外部，一律不信任。
export async function readZip(file) {
  ensure(file.size <= MAX_BYTES, '檔案超過 100 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let count = 0, total = 0, tooBig = false, entries;
  try {
    entries = unzipSync(bytes, {
      // 依宣告大小檢查；fflate 依此大小配置輸出，不會解出更多（防 zip bomb）
      filter: entry => {
        if (++count > MAX_FILES) { tooBig = true; throw new Error(); }
        if (!ENTRY.test(entry.name) || entry.name.startsWith('__MACOSX/')) return false;
        total += entry.originalSize;
        if (total > MAX_BYTES || entry.originalSize > MAX_IMAGE) { tooBig = true; throw new Error(); }
        return true;
      },
    });
  } catch {
    throw new Error(tooBig ? '筆記本內容過大或檔案過多' : '無法讀取：這不是有效的 zip 檔');
  }
  const manifestPath = Object.keys(entries).find(path => /^(?:[^/]+\/)?manifest\.json$/.test(path));
  ensure(manifestPath, '找不到 manifest.json，這不是筆記本檔案');
  const root = manifestPath.slice(0, -'manifest.json'.length);
  const parse = path => {
    const data = entries[root + path];
    ensure(data, `筆記本缺少 ${path}`);
    try { return JSON.parse(new TextDecoder().decode(data)); } catch { throw new Error(`${path} 格式錯誤`); }
  };
  const manifest = parse('manifest.json');
  ensure(manifest?.format === FORMAT, '這不是筆記本檔案');
  ensure(manifest.schema === 1, '筆記本格式較新，請重新整理網頁後再開啟');
  const pages = parse('pages.json');
  ensure(Array.isArray(pages) && pages.length <= 2000 && pages.every(p => validId(p?.id)), '頁面資料不合法');
  const docs = pages.map(p => parse(`docs/${p.id}.json`));
  const blobs = new Map();
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith(root + 'images/')) continue;
    const match = /^([^/.]+)\.([a-z0-9]+)$/i.exec(path.slice(root.length + 'images/'.length));
    if (match && validId(match[1])) blobs.set(match[1], new Blob([data], { type: MIME[match[2].toLowerCase()] ?? '' }));
  }
  validateNotebook({ pages, docs, blobs });
  return { name: cleanName(manifest.name), ...normalize({ pages, docs, blobs }) };
}

// 換上全新的頁面與圖片 ID：同一個檔案開兩次、或另存的副本，才不會跟本機現有的互相覆蓋
export function renumber({ pages, docs, blobs }, newId = uid) {
  const taken = new Set();
  const fresh = () => { let id; do id = newId(); while (taken.has(id)); taken.add(id); return id; };
  const pageIds = new Map(pages.map(p => [p.id, fresh()]));
  const blobIds = new Map([...usedImages(docs)].map(id => [id, fresh()]));
  return {
    pages: pages.map(p => ({
      id: pageIds.get(p.id), parentId: p.parentId == null ? null : pageIds.get(p.parentId),
      title: p.title, order: p.order, open: p.open !== false, created: Number.isFinite(p.created) ? p.created : 0,
    })),
    docs: docs.map(d => ({
      pageId: pageIds.get(d.pageId),
      view: { x: d.view.x, y: d.view.y, s: d.view.s },
      items: d.items.map(item => item.type === 'image' ? { ...item, blobId: blobIds.get(item.blobId) } : item),
    })),
    blobs: new Map([...blobIds].map(([old, id]) => [id, blobs.get(old)])),
  };
}

// ---------- 同步：檔案 ID、快照、合併 ----------
// 檔案裡的頁面與圖片 ID 在每台裝置都一樣，合併靠它對應頁面。開檔時檔案 ID 若跟這台裝置上
// 別本筆記本撞到，才換一個本機 ID；ids = { 本機 ID: 檔案 ID } 只記換過的。

// 本機內容 → 檔案 ID 的內容
export function toFile({ name, pages, docs, blobs }, ids = {}) {
  const f = id => Object.hasOwn(ids, id) ? ids[id] : id;
  const content = normalize({ pages, docs, blobs });
  return {
    name: cleanName(name),
    pages: content.pages.map(p => ({ ...p, id: f(p.id), parentId: p.parentId == null ? null : f(p.parentId) })),
    docs: content.docs.map(d => ({ ...d, pageId: f(d.pageId), items: d.items.map(i => i.type === 'image' ? { ...i, blobId: f(i.blobId) } : i) })),
    blobs: new Map([...blobs].map(([id, blob]) => [f(id), blob])),
  };
}

// 檔案 ID 的內容 → 本機內容。used：這台裝置上其他筆記本用掉的 ID。回傳本機內容與新的對照表。
export function fromFile({ name, pages, docs, blobs }, ids = {}, used = new Set(), newId = uid) {
  const owner = new Map(Object.entries(ids));  // 本機 ID → 檔案 ID
  const back = new Map([...owner].map(([id, file]) => [file, id]));
  const done = new Map(), map = {};
  const local = file => {
    if (done.has(file)) return done.get(file);
    let id = back.get(file) ?? file;
    while (used.has(id) || (owner.get(id) ?? file) !== file) id = newId();
    owner.set(id, file); done.set(file, id);
    if (id !== file) map[id] = file;
    return id;
  };
  return {
    ids: map,
    content: {
      name,
      pages: pages.map(p => ({ ...p, id: local(p.id), parentId: p.parentId == null ? null : local(p.parentId) })),
      docs: docs.map(d => ({ ...d, pageId: local(d.pageId), items: d.items.map(i => i.type === 'image' ? { ...i, blobId: local(i.blobId) } : i) })),
      blobs: new Map([...blobs].map(([id, blob]) => [local(id), blob])),
    },
  };
}

// 物件的 key 排序後再序列化：同樣的內容不論欄位順序都得到同樣的字串
const canon = value => Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}'
  : JSON.stringify(value) ?? 'null';
// cyrb53：快速的 53 位元雜湊，只用來判斷內容有沒有變
function hash(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const metaOf = p => hash(canon([p.title, p.parentId, p.order, p.shared ?? null]));

// 快照：每頁 [頁面資訊的雜湊, 內容的雜湊]。只看標題、位置與物件；畫面視角、展開狀態是各台裝置自己的。
export function snapshot({ name, pages, docs }) {
  const items = new Map(docs.map(d => [d.pageId, d.items]));
  return { name, pages: Object.fromEntries(pages.map(p => [p.id, [metaOf(p), hash(canon(items.get(p.id) ?? []))]])) };
}

export function sameSnapshot(a, b) {
  if (a.name !== b.name) return false;
  const keys = Object.keys(a.pages);
  return keys.length === Object.keys(b.pages).length && keys.every(id => b.pages[id]?.[0] === a.pages[id][0] && b.pages[id][1] === a.pages[id][1]);
}

// 三方合併（都是檔案 ID）。base：上次同步時的快照；local／remote：兩邊現在的內容。
// 以頁為單位：只有一邊改過就用那一邊；兩邊都改了同一頁的內容，保留這台的，另一邊的另存成一頁「衝突副本」。
// 一邊刪除、另一邊沒改就刪；另一邊有改就保留。回傳 { content, conflicts }。
export function mergeNotebook(base, local, remote, newId = uid) {
  const L = snapshot(local), R = snapshot(remote);
  const pick = (b, l, r) => l === r || r === b ? 'local' : l === b ? 'remote' : 'both';
  const lPages = new Map(local.pages.map(p => [p.id, p])), rPages = new Map(remote.pages.map(p => [p.id, p]));
  const lDocs = new Map(local.docs.map(d => [d.pageId, d])), rDocs = new Map(remote.docs.map(d => [d.pageId, d]));
  const unchanged = (b, s) => b && b[0] === s[0] && b[1] === s[1];
  const pages = [], docs = [], copies = [];
  for (const id of new Set([...lPages.keys(), ...rPages.keys()])) {
    const b = base.pages[id], l = L.pages[id], r = R.pages[id];
    if (l && r) {
      const lp = lPages.get(id), rp = rPages.get(id);
      const meta = pick(b?.[0], l[0], r[0]) === 'remote' ? rp : lp;
      pages.push({ ...meta, open: lp.open });
      const side = pick(b?.[1], l[1], r[1]);
      docs.push({ ...lDocs.get(id), items: (side === 'remote' ? rDocs : lDocs).get(id).items });
      if (side === 'both') copies.push({ page: { ...rp, parentId: meta.parentId, order: meta.order + .5 }, doc: rDocs.get(id) });
    } else if (l) {
      if (unchanged(b, l)) continue;  // 另一邊刪了，這邊沒改
      pages.push({ ...lPages.get(id) }); docs.push(lDocs.get(id));
    } else {
      if (unchanged(b, r)) continue;
      pages.push({ ...rPages.get(id) }); docs.push(rDocs.get(id));
    }
  }
  const taken = new Set([...lPages.keys(), ...rPages.keys()]);
  for (const { page, doc } of copies) {
    let id; do id = newId(); while (taken.has(id)); taken.add(id);
    pages.push({ ...page, id, title: `${page.title || '未命名'}（衝突副本）`, open: true, created: Date.now() });
    docs.push({ ...doc, pageId: id });
  }
  if (!pages.length) {
    const id = newId();
    pages.push({ id, parentId: null, title: '', order: 0, open: true, created: Date.now() });
    docs.push({ pageId: id, view: DEFAULT_VIEW, items: [] });
  }
  // 上層被刪掉的頁面移到最上層；兩邊各把 A 移進 B、B 移進 A 造成的循環也打斷
  const byId = new Map(pages.map(p => [p.id, p]));
  for (const page of pages) if (page.parentId != null && !byId.has(page.parentId)) page.parentId = null;
  for (const page of pages) {
    const seen = new Set([page.id]);
    for (let parent = page.parentId; parent != null; parent = byId.get(parent).parentId) {
      if (seen.has(parent)) { page.parentId = null; break; }
      seen.add(parent);
    }
  }
  const name = L.name !== base.name ? local.name : remote.name;
  const content = { name, pages, docs, blobs: new Map([...remote.blobs, ...local.blobs]) };
  validateNotebook(content);
  return { content, conflicts: copies.length };
}
