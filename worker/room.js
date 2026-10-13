// 共用頁的房間（Durable Object，一個 Drive 檔案一間）：保存這一頁的 Yjs 內容與圖片，轉發即時更新、
// 畫到一半的筆跡、游標與選取。誰能進來由 Worker 先用 Drive 權限檢查（見 index.js 的 ticket），這裡只看身分與角色。
// 內容的正本仍是 Drive 上的檔案：房間指定一位在線的編輯者（saver）定時把內容寫回 Drive。
//
// 客戶端 → 房間：update {update, version}、preview {item}、cursor {x, y}、focus {sel, editing}
// 房間 → 客戶端：sync {update, vector, role, peer, empty}、update {update}、ack {version, vector}、
//               preview {peer, item}、cursor {peer, x, y}、focus {peer, sel, editing}、presence {people, saver}、error {message}
import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import { encode, decode } from '../collaboration/model.js';

const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_DOC = 20 * 1024 * 1024;
const MAX_BLOBS = 50 * 1024 * 1024;  // 每頁圖片合計
const MAX_IMAGE = 12 * 1024 * 1024;
const CHUNK = 1024 * 1024;            // SQLite 一列最多 2 MB
const COMPACT_AFTER = 200;
const RATE = 120;                     // 每連線每秒訊息數
const KEY = /^[a-zA-Z0-9_-]{1,100}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const PALETTE = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#be5046'];
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e7;

// 單一物件的格式檢查（跟 notebook-core 的 validateNotebook 同樣的規則）
export function validItem(item) {
  if (!item || !KEY.test(item.id) || !['stroke', 'text', 'image'].includes(item.type)) return false;
  for (const key of ['x', 'y', 'w', 'h', 'size', 'width', 'rot']) if (item[key] !== undefined && !finite(item[key])) return false;
  if (item.type === 'stroke') {
    return Array.isArray(item.pts) && item.pts.length > 0 && item.pts.length <= 100000
      && item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(finite)) && COLOR.test(item.color);
  }
  if (!finite(item.x) || !finite(item.y)) return false;
  if (item.type === 'text') return typeof item.text === 'string' && item.text.length <= 100000;
  return KEY.test(item.blobId);
}

export class PageRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS updates (seq INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (seq, part));
      CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, part INTEGER NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, part));`);
    this.doc = null;        // 休眠醒來後第一次用到才從 SQLite 載入
    this.rates = new Map(); // ws → { count, since }
    this.cursors = new Map(); // peer → 最後的 cursor／focus，讓新進來的人看得到
  }

  // ---------- 內容 ----------
  load() {
    if (this.doc) return this.doc;
    const doc = new Y.Doc();
    let seq = null, parts = [];
    const flush = () => { if (parts.length) Y.applyUpdate(doc, concat(parts)); parts = []; };
    for (const row of this.sql.exec('SELECT seq, data FROM updates ORDER BY seq, part')) {
      if (row.seq !== seq) { flush(); seq = row.seq; }
      parts.push(new Uint8Array(row.data));
    }
    flush();
    this.doc = doc;
    return doc;
  }

  // 寫一筆更新；超過 COMPACT_AFTER 筆就把整份內容壓成一筆
  persist(update) {
    const next = (this.sql.exec('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM updates').one()).seq;
    this.ctx.storage.transactionSync(() => {
      chunks(update).forEach((part, i) => this.sql.exec('INSERT INTO updates (seq, part, data) VALUES (?, ?, ?)', next, i, part));
    });
    const count = this.sql.exec('SELECT COUNT(DISTINCT seq) AS n FROM updates').one().n;
    if (count > COMPACT_AFTER) {
      const state = Y.encodeStateAsUpdate(this.doc);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM updates');
        chunks(state).forEach((part, i) => this.sql.exec('INSERT INTO updates (seq, part, data) VALUES (1, ?, ?)', i, part));
      });
    }
  }

  // 套用一筆更新並檢查它碰到的物件；不合格就丟掉記憶體裡的內容（下次從 SQLite 重新載入），回傳 false
  apply(update) {
    const doc = this.load(), items = doc.getMap('items'), touched = new Set();
    const watch = events => {
      for (const event of events) {
        if (event.target === items) for (const key of event.keys.keys()) touched.add(key);
        else if (event.path.length) touched.add(event.path[0]);
      }
    };
    items.observeDeep(watch);
    try { Y.applyUpdate(doc, update, 'remote'); }
    catch { this.doc = null; return false; }
    finally { items.unobserveDeep(watch); }
    const ok = items.size <= 20000 && [...touched].every(id => {
      const value = items.get(id);
      if (value === undefined) return true;
      const { order, ...item } = value instanceof Y.Map ? value.toJSON() : {};
      return item.id === id && validItem(item);
    });
    if (!ok) { this.doc.destroy(); this.doc = null; }
    return ok;
  }

  // ---------- 連線 ----------
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const who = JSON.parse(request.headers.get('X-Snake-Peer'));
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      const peer = crypto.randomUUID();
      server.serializeAttachment({ ...who, peer, color: colorOf(who.id), joined: Date.now() });
      const doc = this.load();
      send(server, { type: 'sync', update: encode(Y.encodeStateAsUpdate(doc)), vector: encode(Y.encodeStateVector(doc)), role: who.role, peer, empty: doc.getMap('items').size === 0 && this.empty() });
      for (const value of this.cursors.values()) send(server, value);
      this.presence();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/blob') return this.blob(request, url.searchParams.get('key'));
    if (url.pathname === '/destroy') {
      for (const ws of this.ctx.getWebSockets()) fail(ws, '這一頁已停止共用', 4004);
      await this.ctx.storage.deleteAll();
      this.doc = null; this.cursors.clear();
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  // 從來沒有人寫過內容（剛建立，或房間被清掉）：第一個進來的人要從 Drive 檔案載入
  empty() { return this.sql.exec('SELECT COUNT(*) AS n FROM updates').one().n === 0; }

  webSocketMessage(ws, raw) {
    const who = ws.deserializeAttachment();
    if (Date.now() > who.until) { ws.close(4001, '需要重新確認權限'); return; }
    const rate = this.rates.get(ws) ?? { count: 0, since: Date.now() };
    if (Date.now() - rate.since > 1000) { rate.count = 0; rate.since = Date.now(); }
    this.rates.set(ws, rate);
    if (++rate.count > RATE) { fail(ws, '更新過於頻繁', 1008); return; }
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE * 1.4) { fail(ws, '訊息過大', 1009); return; }
    let message;
    try { message = JSON.parse(raw); } catch { fail(ws, '訊息格式錯誤'); return; }
    const editor = who.role === 'editor';
    if (message.type === 'update') {
      if (!editor) { fail(ws, '這一頁是唯讀', 4003); return; }
      if (typeof message.update !== 'string' || !Number.isSafeInteger(message.version)) { fail(ws, '更新格式錯誤'); return; }
      const update = decode(message.update);
      if (!this.apply(update)) { fail(ws, '更新內容不合法'); return; }
      this.persist(update);
      if (this.size() > MAX_DOC) { fail(ws, '這一頁內容過大'); return; }
      this.broadcast({ type: 'update', update: message.update }, ws);
      send(ws, { type: 'ack', version: message.version, vector: encode(Y.encodeStateVector(this.doc)) });
    } else if (message.type === 'preview') {
      if (!editor) return;
      const item = message.item;
      if (item !== null && !(item?.type === 'stroke' && validItem({ ...item, pts: item.pts?.length ? item.pts : [[0, 0]] }) && item.pts.length <= 5000)) return;
      this.broadcast({ type: 'preview', peer: who.peer, item: item && { id: item.id, type: 'stroke', tool: item.tool, color: item.color, width: item.width, pts: item.pts } }, ws);
    } else if (message.type === 'cursor') {
      const value = finite(message.x) && finite(message.y) ? { type: 'cursor', x: message.x, y: message.y } : { type: 'cursor', x: null, y: null };
      this.remember(who.peer, value);
      this.broadcast({ ...value, peer: who.peer }, ws);
    } else if (message.type === 'focus') {
      const sel = Array.isArray(message.sel) ? message.sel.filter(id => typeof id === 'string' && KEY.test(id)).slice(0, 500) : [];
      const editing = typeof message.editing === 'string' && KEY.test(message.editing) ? message.editing : null;
      const value = { type: 'focus', sel, editing };
      this.remember(who.peer, value);
      this.broadcast({ ...value, peer: who.peer }, ws);
    }
  }

  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const who = ws.deserializeAttachment();
    this.rates.delete(ws);
    if (who) {
      for (const key of [...this.cursors.keys()]) if (key.startsWith(who.peer + ':')) this.cursors.delete(key);
      this.broadcast({ type: 'preview', peer: who.peer, item: null }, ws);
      this.broadcast({ type: 'cursor', peer: who.peer, x: null, y: null }, ws);
      this.broadcast({ type: 'focus', peer: who.peer, sel: [], editing: null }, ws);
    }
    try { ws.close(1000); } catch { /* already closed */ }
    this.presence(ws);
  }

  remember(peer, value) { this.cursors.set(peer + ':' + value.type, { ...value, peer }); }

  // 在線名單：同一個人開好幾個分頁只算一個；saver＝最早進來的編輯者，負責寫回 Drive
  presence(leaving = null) {
    const sockets = this.ctx.getWebSockets().filter(ws => ws !== leaving && ws.readyState === WebSocket.OPEN);
    const people = new Map();
    let saver = null;
    for (const ws of sockets) {
      const who = ws.deserializeAttachment();
      if (!who) continue;
      if (!people.has(who.id)) people.set(who.id, { id: who.id, name: who.name, email: who.email, color: who.color, role: who.role, peers: [] });
      people.get(who.id).peers.push(who.peer);
      if (who.role === 'editor' && (!saver || who.joined < saver.joined)) saver = who;
    }
    this.broadcast({ type: 'presence', people: [...people.values()], saver: saver?.peer ?? null }, leaving);
  }

  broadcast(value, except = null) {
    const text = JSON.stringify(value);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) send(ws, text);
  }

  size() { return this.sql.exec('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM updates').one().n; }

  // ---------- 圖片（分塊存在 SQLite）----------
  async blob(request, key) {
    if (!KEY.test(key ?? '')) return new Response('bad key', { status: 400 });
    if (request.method === 'GET') {
      const rows = [...this.sql.exec('SELECT type, data FROM blobs WHERE key = ? ORDER BY part', key)];
      if (!rows.length) return new Response('not found', { status: 404 });
      return new Response(concat(rows.map(row => new Uint8Array(row.data))), {
        headers: { 'Content-Type': rows[0].type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    if (request.method === 'PUT') {
      const type = request.headers.get('Content-Type')?.split(';')[0];
      if (!IMAGE_TYPES.includes(type)) return new Response('僅支援點陣圖片', { status: 400 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > MAX_IMAGE) return new Response('圖片過大', { status: 413 });
      if (this.sql.exec('SELECT COUNT(*) AS n FROM blobs WHERE key = ?', key).one().n) return new Response(null, { status: 204 });
      const used = this.sql.exec('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM blobs').one().n;
      if (used + bytes.length > MAX_BLOBS) return new Response('這一頁的圖片已達 50 MB 上限', { status: 413 });
      this.ctx.storage.transactionSync(() => {
        chunks(bytes).forEach((part, i) => this.sql.exec('INSERT INTO blobs (key, part, type, size, data) VALUES (?, ?, ?, ?, ?)', key, i, type, bytes.length, part));
      });
      return new Response(null, { status: 204 });
    }
    return new Response('method not allowed', { status: 405 });
  }
}

const send = (ws, value) => {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(typeof value === 'string' ? value : JSON.stringify(value)); } catch { /* closing */ }
};
const fail = (ws, message, code = 1011) => { send(ws, { type: 'error', message }); try { ws.close(code, message.slice(0, 60)); } catch { /* closed */ } };
const chunks = bytes => { const out = []; for (let i = 0; i < bytes.length || !out.length; i += CHUNK) out.push(bytes.slice(i, i + CHUNK)); return out; };
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
function colorOf(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
