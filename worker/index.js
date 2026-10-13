// Snake Note 的 Cloudflare Worker：送出靜態網站、幫瀏覽器保存 Google 登入、共用頁的即時協作入口。
//   GET  /api/config                     { mode: 'cloudflare' }：網站有即時協作
//   GET  /api/google/status              { connected, user }：這個瀏覽器有沒有登入
//   GET  /api/google/start               跳到 Google 授權；return＝授權完要回到的網站路徑
//   GET  /api/google/callback            Google 授權回來：換到 refresh token，加密存進 HttpOnly cookie，跳回網站（#google=結果）
//   POST /api/google/token               用 cookie 裡的 refresh token 換一個 access token（約一小時有效）
//   POST /api/google/logout              撤銷授權、清掉 cookie
//   POST /api/shared/:file/ticket        用這個人自己的 Google 授權問 Drive 能不能看／改這個檔案，發一張 10 分鐘的通行證
//   GET  /api/shared/:file/ws?ticket=    進房間（WebSocket，見 room.js）
//   GET|PUT /api/shared/:file/blobs/:key 房間裡的圖片（header X-Snake-Ticket）
//   DELETE /api/shared/:file             停止共用：清掉房間裡的內容與圖片（只有能管理共用設定的擁有者）
// refresh token 只存在使用者瀏覽器的 cookie（AES-GCM 加密，金鑰是 Worker secret SESSION_KEY），Worker 本身不存任何資料。
// 設定：vars GOOGLE_CLIENT_ID；secrets GOOGLE_CLIENT_SECRET、SESSION_KEY。見 docs/GOOGLE_DRIVE_SETUP.md。
// 進入點是 main.js（這個檔案不載入 Cloudflare 專用的模組，Node 的單元測試可以直接用）。

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SESSION = 'snake_session';
const LEGACY = 'snake_google';    // 舊版的 cookie（Path=/api/google/），讀到就換成新的
const STATE = 'snake_google_state';
const SESSION_AGE = 180 * 24 * 3600;  // 每次換 token 都會延長
const STATE_AGE = 600;
const TICKET_AGE = 600 * 1000;
const FILE = /^[a-zA-Z0-9_-]{1,200}$/;
const KEY = /^[a-zA-Z0-9_-]{1,100}$/;

// Google 的網址；本機測試可用環境變數換成假的服務
const google = env => ({
  accounts: env.GOOGLE_ACCOUNTS_URL ?? 'https://accounts.google.com',
  oauth: env.GOOGLE_OAUTH_URL ?? 'https://oauth2.googleapis.com',
  api: env.GOOGLE_API_URL ?? 'https://www.googleapis.com',
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const shared = /^\/api\/shared\/([^/]+)(?:\/(ticket|ws|blobs\/([^/]+)))?$/.exec(url.pathname);
    const route = shared ? SHARED[!shared[2] ? 'room' : shared[2].startsWith('blobs/') ? 'blobs' : shared[2]] : ROUTES[`${request.method} ${url.pathname}`];
    if (!route) return json({ error: 'not found' }, 404);
    try {
      return await route(request, env, url, shared && { file: shared[1], key: shared[3] });
    } catch (error) {
      console.error(error);
      return json({ error: 'server error' }, 500);
    }
  },
};

const ROUTES = {
  'GET /api/config': async () => json({ mode: 'cloudflare' }),

  'GET /api/google/status': async (request, env) => {
    const session = await readSession(request, env);
    return json({ connected: !!session, user: session?.user ?? null });
  },

  'GET /api/google/start': async (request, env, url) => {
    const state = base64(crypto.getRandomValues(new Uint8Array(16)));
    const back = safePath(url.searchParams.get('return'));
    const auth = new URL(google(env).accounts + '/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(url), response_type: 'code', scope: SCOPE,
      // offline＋consent：每次都拿得到 refresh token（之前授權過也一樣）
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state,
    });
    return redirect(auth.href, cookie(STATE, await seal(env, { state, back }), STATE_AGE, '/api/google/'));
  },

  'GET /api/google/callback': async (request, env, url) => {
    const saved = await unseal(env, cookies(request)[STATE]);
    const clear = cookie(STATE, '', 0, '/api/google/');
    if (!saved || saved.state !== url.searchParams.get('state')) return redirect(new URL('/#google=error', url).href, clear);
    const back = result => new URL(saved.back + '#google=' + result, url).href;
    const code = url.searchParams.get('code');
    if (!code) return redirect(back('denied'), clear);
    const response = await fetch(google(env).oauth + '/token', form({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(url), grant_type: 'authorization_code',
    }));
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.refresh_token) return redirect(back('error'), clear);
    // 使用者在授權畫面可以取消勾選 Drive 權限
    if (!tokens.scope?.split(' ').includes(SCOPE)) return redirect(back('scope'), clear);
    const user = await whoami(env, tokens.access_token);
    if (!user) return redirect(back('error'), clear);
    return redirect(back('ok'), clear, await sessionCookie(env, { refresh: tokens.refresh_token, user }));
  },

  'POST /api/google/token': async (request, env, url) => {
    if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
    const session = await readSession(request, env);
    if (!session) return json({ error: 'signed out' }, 401);
    const result = await accessToken(env, session);
    if (result.signedOut) return json({ error: 'signed out' }, 401, ...signOut());
    if (!result.token) return json({ error: 'google error' }, 502);
    const user = session.user ?? await whoami(env, result.token);
    const renewed = await sessionCookie(env, { refresh: result.refresh, user });
    return json({ access_token: result.token, expires_in: result.expires, user }, 200, renewed, ...(session.legacy ? [cookie(LEGACY, '', 0, '/api/google/')] : []));
  },

  'POST /api/google/logout': async (request, env, url) => {
    if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
    const session = await readSession(request, env);
    if (session) await fetch(google(env).oauth + '/revoke', form({ token: session.refresh })).catch(() => {});
    return json({ ok: true }, 200, ...signOut());
  },
};

// 用這個人自己的 Google 授權問 Drive：他對這個共用頁檔案有什麼權限。回傳 { user, meta } 或要直接回應的 Response
async function driveAccess(request, env, url, file) {
  if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
  if (!FILE.test(file)) return json({ error: 'bad file' }, 400);
  const session = await readSession(request, env);
  if (!session) return json({ error: 'signed out' }, 401);
  const result = await accessToken(env, session);
  if (result.signedOut) return json({ error: 'signed out' }, 401, ...signOut());
  if (!result.token) return json({ error: 'google error' }, 502);
  const user = session.user ?? await whoami(env, result.token);
  const response = await fetch(`${google(env).api}/drive/v3/files/${file}?fields=id,name,trashed,appProperties,capabilities(canEdit,canShare)`, { headers: { Authorization: 'Bearer ' + result.token } });
  if (response.status === 404 || response.status === 403) return json({ error: 'no access' }, 403);
  if (!response.ok) return json({ error: 'google error' }, 502);
  const meta = await response.json();
  if (meta.trashed || meta.appProperties?.kind !== 'page') return json({ error: 'not a shared page' }, 404);
  return { user, meta };
}

const SHARED = {
  // 通行證：這個人能不能看、能不能改這個 Drive 檔案，以 Drive 的共用設定為準
  async ticket(request, env, url, { file }) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const access = await driveAccess(request, env, url, file);
    if (access instanceof Response) return access;
    const { user, meta } = access;
    const role = meta.capabilities?.canEdit ? 'editor' : 'viewer';
    const until = Date.now() + TICKET_AGE;
    const ticket = await seal(env, { file, role, user, until });
    return json({ ticket, role, user, until, name: meta.name, canShare: !!meta.capabilities?.canShare });
  },

  // 停止共用：清掉房間（內容的正本在 Drive 檔案，不受影響）
  async room(request, env, url, { file }) {
    if (request.method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
    const access = await driveAccess(request, env, url, file);
    if (access instanceof Response) return access;
    if (!access.meta.capabilities?.canShare) return json({ error: 'owner only' }, 403);
    await room(env, file).fetch(new Request('https://room/destroy', { method: 'POST' }));
    return json({ ok: true });
  },

  async ws(request, env, url, { file }) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    if ((request.headers.get('Origin') ?? url.origin) !== url.origin) return json({ error: 'forbidden' }, 403);
    const ticket = await readTicket(env, url.searchParams.get('ticket'), file);
    if (!ticket) return json({ error: 'ticket expired' }, 401);
    const peer = { id: ticket.user.id, name: ticket.user.name || ticket.user.email, email: ticket.user.email, role: ticket.role, until: ticket.until };
    return room(env, file).fetch(new Request('https://room/ws', { headers: { Upgrade: 'websocket', 'X-Snake-Peer': JSON.stringify(peer) } }));
  },

  async blobs(request, env, url, { file, key }) {
    if (!KEY.test(key ?? '')) return json({ error: 'bad key' }, 400);
    const ticket = await readTicket(env, request.headers.get('X-Snake-Ticket') ?? url.searchParams.get('ticket'), file);
    if (!ticket) return json({ error: 'ticket expired' }, 401);
    if (request.method === 'PUT' && ticket.role !== 'editor') return json({ error: 'read only' }, 403);
    if (!['GET', 'PUT'].includes(request.method)) return json({ error: 'method not allowed' }, 405);
    return room(env, file).fetch(new Request('https://room/blob?key=' + key, { method: request.method, headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' }, body: request.method === 'PUT' ? request.body : null }));
  },
};

const room = (env, file) => env.ROOMS.get(env.ROOMS.idFromName(file));
async function readTicket(env, text, file) {
  const ticket = await unseal(env, text);
  return ticket?.file === file && ticket.until > Date.now() ? ticket : null;
}

// ---------- Google ----------
async function accessToken(env, session) {
  const response = await fetch(google(env).oauth + '/token', form({
    refresh_token: session.refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
  }));
  const data = await response.json().catch(() => ({}));
  // 使用者在 Google 帳號撤銷了授權，或 refresh token 過期
  if (data.error === 'invalid_grant') return { signedOut: true };
  if (!response.ok || !data.access_token) return {};
  return { token: data.access_token, expires: data.expires_in, refresh: data.refresh_token ?? session.refresh };
}

// 這個 Google 帳號是誰（Drive 的 permissionId 當作 ID，跟 Drive 共用設定裡看到的是同一個人）
async function whoami(env, token) {
  const response = await fetch(google(env).api + '/drive/v3/about?fields=user(permissionId,emailAddress,displayName)', { headers: { Authorization: 'Bearer ' + token } });
  const about = await response.json().catch(() => ({}));
  const user = about.user;
  if (!response.ok || !user?.permissionId || !user.emailAddress) return null;
  return { id: user.permissionId, email: user.emailAddress.toLowerCase(), name: String(user.displayName ?? '').slice(0, 100) };
}

const callbackUrl = url => url.origin + '/api/google/callback';
// 只接受這個網站裡的路徑，不能跳到別的網站
const safePath = path => typeof path === 'string' && /^\/(?![/\\])[^\s#]*$/.test(path) ? path : '/';
// 自訂 header 跨網站送不出來（沒有 CORS 預檢許可），再加上 Origin 檢查，擋掉別的網站代替使用者呼叫
const sameSite = (request, url) => request.headers.get('X-Requested-With') === 'snake-note' && (request.headers.get('Origin') ?? url.origin) === url.origin;
const form = fields => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

function json(data, status = 200, ...setCookies) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const value of setCookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location, ...setCookies) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of setCookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers });
}

const cookie = (name, value, age, path = '/api/') => `${name}=${value}; Path=${path}; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const sessionCookie = async (env, session) => cookie(SESSION, await seal(env, session), SESSION_AGE);
const signOut = () => [cookie(SESSION, '', 0), cookie(LEGACY, '', 0, '/api/google/')];
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] ??= part.slice(at + 1).trim();
  }
  return out;
}
async function readSession(request, env) {
  const jar = cookies(request);
  const current = await unseal(env, jar[SESSION]);
  if (typeof current?.refresh === 'string') return current;
  const legacy = await unseal(env, jar[LEGACY]);
  return typeof legacy?.refresh === 'string' ? { ...legacy, legacy: true } : null;
}

// ---------- cookie 與通行證加密（AES-GCM）----------
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unbase64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function key(env) {
  if (!env.SESSION_KEY) throw new Error('SESSION_KEY is not set');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SESSION_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv); out.set(data, iv.length);
  return base64(out);
}

// 解不開（沒有、被竄改、換過金鑰）回傳 null
async function unseal(env, text) {
  if (!text) return null;
  try {
    const bytes = unbase64(text);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(env), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(data));
  } catch { return null; }
}
