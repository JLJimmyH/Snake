import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { encode, decode, project } from './model.js';
import { DemoStore, SupabaseStore, HttpError } from './store.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9_-]{1,100}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_UPDATE = 2 * 1024 * 1024;
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const localHost = header => {
  try { return loopback(new URL('http://' + header).hostname.replace(/^\[|\]$/g, '')); }
  catch { return false; }
};

async function body(req, limit = MAX_UPDATE) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '資料過大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function validateDocument(doc) {
  const items = project(doc);
  if (items.length > 20000 || Y.encodeStateAsUpdate(doc).length > 20 * 1024 * 1024) throw new HttpError(413, '頁面過大');
  for (const item of items) {
    if (!KEY.test(item.id) || !['stroke', 'text', 'image'].includes(item.type)) throw new HttpError(400, '物件格式錯誤');
    for (const k of ['x', 'y', 'w', 'h', 'size', 'width']) if (item[k] !== undefined && (!Number.isFinite(item[k]) || Math.abs(item[k]) > 1e7)) throw new HttpError(400, '座標格式錯誤');
    if (item.type === 'stroke' && (!Array.isArray(item.pts) || item.pts.length > 100000 || !item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)) || !/^#[0-9a-f]{6}$/i.test(item.color))) throw new HttpError(400, '筆跡格式錯誤');
    if (item.type === 'text' && (typeof item.text !== 'string' || item.text.length > 100000)) throw new HttpError(400, '文字格式錯誤');
    if (item.type === 'image' && !KEY.test(item.blobId)) throw new HttpError(400, '圖片格式錯誤');
  }
}

export async function createCollaborationServer(options = {}) {
  const demo = options.demo ?? process.env.COLLAB_DEMO === '1';
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 8000);
  const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL ?? '';
  const key = options.key ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
  const origin = options.origin ?? process.env.PUBLIC_ORIGIN ?? `http://${host}:${port}`;
  if (demo && !loopback(host)) throw new Error('COLLAB_DEMO 僅允許綁定 loopback；正式部署必須使用 Supabase');
  if (!demo) {
    let role;
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { /* modern publishable key */ }
    if (!key.startsWith('sb_publishable_') && role !== 'anon') throw new Error('僅允許 Supabase publishable／anon 公開金鑰，不能使用 service-role 或 secret key');
  }
  if (!demo && (!supabaseUrl.startsWith('https://') || !key)) throw new Error('請設定 SUPABASE_URL 與 SUPABASE_PUBLISHABLE_KEY；本機測試可顯式設定 COLLAB_DEMO=1');
  if (!demo && origin !== `http://${host}:${port}` && !origin.startsWith('https://')) throw new Error('正式外部網址必須使用 HTTPS');
  const store = options.store ?? (demo ? new DemoStore(options.directory ?? resolve(ROOT, '.local-data')) : new SupabaseStore(supabaseUrl, key));
  const rooms = new Map();
  const authenticate = async (token, address) => {
    if (demo) {
      if (!loopback(address)) throw new HttpError(403, '示範模式僅允許本機連線');
      const email = token?.startsWith('demo:') ? token.slice(5).toLowerCase() : '';
      if (!EMAIL.test(email) || !email.endsWith('@example.test')) throw new HttpError(401, '請使用示範帳號');
      return { id: email, email, token };
    }
    if (!token || token.length > 8192) throw new HttpError(401, '請先登入');
    const response = await fetch(supabaseUrl.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new HttpError(401, '登入已過期，請重新登入');
    const user = await response.json();
    if (!user.id || !user.email || !user.email_confirmed_at) throw new HttpError(401, '需要已驗證的帳號');
    return { id: user.id, email: user.email.toLowerCase(), token };
  };
  const userFor = req => authenticate(req.headers.authorization?.replace(/^Bearer /, ''), req.socket.remoteAddress);
  const roomFor = async (id, user) => {
    if (!rooms.has(id)) {
      const promise = (async () => {
        const doc = new Y.Doc();
        for (const update of await store.updates(id, user)) Y.applyUpdate(doc, decode(update));
        return { id, doc, peers: new Set(), queue: Promise.resolve() };
      })();
      rooms.set(id, promise);
      promise.catch(() => rooms.delete(id));
    }
    return rooms.get(id);
  };
  const queue = (room, fn) => {
    const result = room.queue.then(fn);
    room.queue = result.catch(() => {});
    return result;
  };
  const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * MAX_UPDATE) ws.send(JSON.stringify(value)); };
  const broadcast = async (room, value, except, transient = false) => {
    await Promise.all([...room.peers].filter(peer => peer !== except).map(async peer => {
      try {
        if (!transient || Date.now() - (peer.lastReadCheck ?? 0) > 1000) {
          await store.access(room.id, peer.user); peer.lastReadCheck = Date.now();
        }
        send(peer, value);
      } catch { peer.close(4403, '頁面權限已變更'); }
    }));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (demo && !loopback(req.socket.remoteAddress)) throw new HttpError(403, '僅供本機使用');
      if (demo && !localHost(req.headers.host)) throw new HttpError(403, '本機示範不允許外部 hostname');
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, '來源不允許');
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/config') return json(res, 200, { mode: demo ? 'demo' : 'supabase', supabaseUrl, publishableKey: key });
      if (path.startsWith('/api/')) {
        const user = await userFor(req);
        if (path === '/api/pages') {
          if (req.method === 'GET') return json(res, 200, await store.list(user));
          if (req.method === 'POST') {
            const value = JSON.parse(await body(req, 10000));
            const title = String(value.title ?? '').trim().slice(0, 200) || '未命名';
            return json(res, 201, await store.create(user, title));
          }
        }
        const match = path.match(/^\/api\/pages\/([^/]+)\/(members|blobs)(?:\/([^/]+))?$/);
        if (match && UUID.test(match[1])) {
          const [, id, resource, blobKey] = match;
          if (resource === 'members' && !blobKey && req.method === 'POST') {
            const { email, role } = JSON.parse(await body(req, 10000));
            if (typeof email !== 'string' || !EMAIL.test(email) || !['editor', 'viewer'].includes(role)) throw new HttpError(400, '請輸入 email 與有效權限');
            await store.invite(id, user, email.trim().toLowerCase(), role);
            // Disconnect existing sessions so downgraded users cannot retain edit UI.
            const existing = rooms.get(id);
            if (existing) for (const peer of (await existing).peers) if (peer.user.email === email.trim().toLowerCase()) peer.close(4403, '分享權限已變更');
            return json(res, 200, { ok: true });
          }
          if (resource === 'blobs' && KEY.test(blobKey ?? '')) {
            if (req.method === 'PUT') {
              const type = req.headers['content-type']?.split(';')[0];
              if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(type)) throw new HttpError(400, '僅支援點陣圖片');
              await store.putBlob(id, blobKey, user, await body(req, 12 * 1024 * 1024), type);
              return json(res, 200, { ok: true });
            }
            if (req.method === 'GET') {
              const blob = await store.getBlob(id, blobKey, user);
              res.writeHead(200, { 'Content-Type': blob.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
              return res.end(blob.bytes);
            }
          }
        }
        throw new HttpError(404, '找不到 API');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '方法不允許');
      // Explicit allowlist: never expose .env, backend sources, lockfiles or data.
      if (!(path === '/' || path === '/index.html' || path === '/privacy.html' || path === '/docs/GOOGLE_DRIVE_SETUP.md' || /^\/(css|js)\/[a-zA-Z0-9_-]+\.(css|js)$/.test(path) || path === '/collab-assets/collaboration.js')) throw new HttpError(404, '找不到檔案');
      const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : path));
      let content;
      try { content = await readFile(file); } catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '請先執行 npm run build'); throw error; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/plain' }[extname(file)];
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? (error instanceof SyntaxError ? 400 : 500), { error: error.status || error instanceof SyntaxError ? error.message : '服務暫時無法使用' });
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_UPDATE });
  server.on('upgrade', (req, socket, head) => {
    if ((demo && !localHost(req.headers.host)) || req.url !== '/collab' || req.headers.origin !== origin || (demo && !loopback(req.socket.remoteAddress))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    ws.peerId = randomUUID();
    ws.alive = true;
    let room, count = 0, tick = Date.now();
    const authTimeout = setTimeout(() => ws.close(4401, '請登入'), 10000);
    ws.on('pong', () => { ws.alive = true; });
    let incoming = Promise.resolve();
    ws.on('message', raw => {
      incoming = incoming.then(async () => {
        try {
          if (Date.now() - tick > 1000) { count = 0; tick = Date.now(); }
          if (++count > 80) throw new HttpError(429, '更新過於頻繁');
          const message = JSON.parse(raw.toString());
          if (!room) {
            if (message.type !== 'auth' || !UUID.test(message.page ?? '')) throw new HttpError(401, '請先登入');
            ws.user = await authenticate(message.token, req.socket.remoteAddress);
            const access = await store.access(message.page, ws.user);
            room = await roomFor(message.page, ws.user);
            await queue(room, async () => {
              room.peers.add(ws);
              send(ws, { type: 'sync', update: encode(Y.encodeStateAsUpdate(room.doc)), vector: encode(Y.encodeStateVector(room.doc)), role: access.role, title: access.title, peerId: ws.peerId });
              await broadcast(room, { type: 'presence', count: room.peers.size });
            });
            clearTimeout(authTimeout);
            return;
          }
          if (message.type === 'update') {
            await queue(room, async () => {
              // Revalidate authentication, ACL, and storage RLS for every durable write.
              ws.user = await authenticate(ws.user.token, req.socket.remoteAddress);
              await store.access(room.id, ws.user, true);
              if (typeof message.update !== 'string' || message.update.length > MAX_UPDATE || !Number.isSafeInteger(message.version)) throw new HttpError(400, '更新格式錯誤');
              const candidate = new Y.Doc();
              try {
                Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
                Y.applyUpdate(candidate, decode(message.update));
                validateDocument(candidate);
                await store.append(room.id, ws.user, message.update);
                Y.applyUpdate(room.doc, decode(message.update));
              } finally { candidate.destroy(); }
              await broadcast(room, { type: 'update', update: message.update }, ws);
              send(ws, { type: 'ack', version: message.version, vector: encode(Y.encodeStateVector(room.doc)) });
            });
          } else if (message.type === 'preview') {
            const item = message.item;
            if (item !== null && (!item || item.type !== 'stroke' || !KEY.test(item.id) || !/^#[0-9a-f]{6}$/i.test(item.color) || !Number.isFinite(item.width) || item.width <= 0 || item.width > 1000 || !Array.isArray(item.pts) || item.pts.length > 5000 || !item.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) throw new HttpError(400, '預覽格式錯誤');
            ws.pendingPreview = { item: item && { id: item.id, type: 'stroke', tool: item.tool, color: item.color, width: item.width, pts: item.pts } };
            if (!ws.previewBusy) {
              ws.previewBusy = true;
              (async () => {
                while (ws.pendingPreview && ws.readyState === WebSocket.OPEN) {
                  const next = ws.pendingPreview; ws.pendingPreview = null;
                  if (Date.now() - (ws.lastWriteCheck ?? 0) > 1000) {
                    await store.access(room.id, ws.user, true); ws.lastWriteCheck = Date.now();
                  }
                  await broadcast(room, { type: 'preview', peerId: ws.peerId, item: next.item }, ws, true);
                }
              })().catch(() => ws.close(4403, '預覽權限失效')).finally(() => { ws.previewBusy = false; });
            }
          }
        } catch (error) {
          send(ws, { type: 'error', message: error.status ? error.message : '同步失敗，請稍後重試' });
          ws.close(error.status === 401 ? 4401 : error.status === 403 ? 4403 : 1011, '同步失敗');
        }
      }).catch(() => ws.close(1011));
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (room) {
        room.peers.delete(ws);
        broadcast(room, { type: 'preview', peerId: ws.peerId, item: null }).catch(() => {});
        broadcast(room, { type: 'presence', count: room.peers.size }).catch(() => {});
        // Evict unused rooms only after their pending persistence completes.
        room.queue.finally(() => {
          if (!room.peers.size) { rooms.delete(room.id); room.doc.destroy(); }
        });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 15000);
  heartbeat.unref();
  return { server, store, wss, async listen() {
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, host, yes); });
    return server.address();
  }, async close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createCollaborationServer();
    const address = await app.listen();
    console.log(`note-mvp ${process.env.COLLAB_DEMO === '1' ? '本機示範' : 'Supabase 協作'}服務已啟動，port ${address.port}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
