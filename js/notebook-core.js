// 筆記本檔案格式：一本筆記本 = 一個 zip。匯出／匯入與 Drive 共用。
//   manifest.json       { format, schema, name, savedAt }
//   pages.json          頁面樹
//   docs/<pageId>.json  每頁的白板內容
//   images/<blobId>.png 圖片原檔
import { zipSync, unzipSync } from './vendor/fflate.js';
import { uid } from './db.js';

export const FORMAT = 'note-mvp-notebook';
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
      for (const key of ['x', 'y', 'w', 'h', 'size', 'width']) if (item[key] !== undefined) ensure(Number.isFinite(item[key]) && Math.abs(item[key]) <= 1e7, '物件座標不合法');
      if (item.type === 'stroke') {
        ensure(Array.isArray(item.pts) && item.pts.length > 0 && item.pts.length <= 100000 && item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)), '筆跡資料不合法');
        ensure(/^#[0-9a-f]{6}$/i.test(item.color) && item.width > 0 && ['pen', 'hl'].includes(item.tool), '筆跡資料不合法');
      } else {
        ensure(Number.isFinite(item.x) && Number.isFinite(item.y), '物件座標不合法');
        if (item.type === 'text') ensure(typeof item.text === 'string' && item.text.length <= 100000 && item.size > 0, '文字資料不合法');
        else ensure(item.w > 0 && item.h > 0 && validId(item.blobId) && blobs.has(item.blobId), '圖片遺失');
      }
    }
  }
}

const usedImages = docs => new Set(docs.flatMap(d => d.items.filter(i => i.type === 'image').map(i => i.blobId)));

// 本機資料 → zip。還沒編輯過的頁面沒有 doc，補上空白內容。
export async function packNotebook({ name, pages, docs, blobs }) {
  const byPage = new Map(docs.map(d => [d.pageId, d]));
  const content = {
    pages: pages.map(p => ({ id: p.id, parentId: p.parentId ?? null, title: p.title ?? '', order: p.order, open: p.open !== false, created: p.created ?? 0 })),
    docs: pages.map(p => ({ pageId: p.id, view: byPage.get(p.id)?.view ?? DEFAULT_VIEW, items: byPage.get(p.id)?.items ?? [] })),
    blobs,
  };
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

// zip → 驗證過、ID 全部換新的筆記本內容。檔案來自外部，一律不信任。
export async function unpackNotebook(file) {
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
  return { name: cleanName(manifest.name), ...renumber({ pages, docs, blobs }) };
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
