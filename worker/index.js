// Snake Note 的 Cloudflare Worker：送出靜態網站，並幫瀏覽器保存 Google 登入，Drive 自動同步才不用每小時重新登入。
//   GET  /api/google/status    { connected }：這個瀏覽器有沒有登入
//   GET  /api/google/start     跳到 Google 授權；return＝授權完要回到的網站路徑
//   GET  /api/google/callback  Google 授權回來：換到 refresh token，加密存進 HttpOnly cookie，跳回網站（#google=結果）
//   POST /api/google/token     用 cookie 裡的 refresh token 換一個 access token（約一小時有效）
//   POST /api/google/logout    撤銷授權、清掉 cookie
// refresh token 只存在使用者瀏覽器的 cookie（AES-GCM 加密，金鑰是 Worker secret SESSION_KEY），Worker 本身不存任何資料。
// 設定：vars GOOGLE_CLIENT_ID；secrets GOOGLE_CLIENT_SECRET、SESSION_KEY。見 docs/GOOGLE_DRIVE_SETUP.md。
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SESSION = 'snake_google';
const STATE = 'snake_google_state';
const SESSION_AGE = 180 * 24 * 3600;  // 每次換 token 都會延長
const STATE_AGE = 600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const route = ROUTES[`${request.method} ${url.pathname}`];
    if (!route) return json({ error: 'not found' }, 404);
    try {
      return await route(request, env, url);
    } catch (error) {
      console.error(error);
      return json({ error: 'server error' }, 500);
    }
  },
};

const ROUTES = {
  'GET /api/google/status': async (request, env) => json({ connected: !!await readSession(request, env) }),

  'GET /api/google/start': async (request, env, url) => {
    const state = base64(crypto.getRandomValues(new Uint8Array(16)));
    const back = safePath(url.searchParams.get('return'));
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(url), response_type: 'code', scope: SCOPE,
      // offline＋consent：每次都拿得到 refresh token（之前授權過也一樣）
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state,
    });
    return redirect(auth.href, cookie(STATE, await seal(env, { state, back }), STATE_AGE));
  },

  'GET /api/google/callback': async (request, env, url) => {
    const saved = await unseal(env, cookies(request)[STATE]);
    const clear = cookie(STATE, '', 0);
    if (!saved || saved.state !== url.searchParams.get('state')) return redirect(new URL('/#google=error', url).href, clear);
    const back = result => new URL(saved.back + '#google=' + result, url).href;
    const code = url.searchParams.get('code');
    if (!code) return redirect(back('denied'), clear);
    const response = await fetch(TOKEN_URL, form({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl(url), grant_type: 'authorization_code',
    }));
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.refresh_token) return redirect(back('error'), clear);
    // 使用者在授權畫面可以取消勾選 Drive 權限
    if (!tokens.scope?.split(' ').includes(SCOPE)) return redirect(back('scope'), clear);
    return redirect(back('ok'), clear, cookie(SESSION, await seal(env, { refresh: tokens.refresh_token }), SESSION_AGE));
  },

  'POST /api/google/token': async (request, env, url) => {
    if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
    const session = await readSession(request, env);
    if (!session) return json({ error: 'signed out' }, 401);
    const response = await fetch(TOKEN_URL, form({
      refresh_token: session.refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
    }));
    const data = await response.json().catch(() => ({}));
    // 使用者在 Google 帳號撤銷了授權，或 refresh token 過期
    if (data.error === 'invalid_grant') return json({ error: 'signed out' }, 401, cookie(SESSION, '', 0));
    if (!response.ok || !data.access_token) return json({ error: 'google error' }, 502);
    const renewed = cookie(SESSION, await seal(env, { refresh: data.refresh_token ?? session.refresh }), SESSION_AGE);
    return json({ access_token: data.access_token, expires_in: data.expires_in }, 200, renewed);
  },

  'POST /api/google/logout': async (request, env, url) => {
    if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
    const session = await readSession(request, env);
    if (session) await fetch('https://oauth2.googleapis.com/revoke', form({ token: session.refresh })).catch(() => {});
    return json({ ok: true }, 200, cookie(SESSION, '', 0));
  },
};

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

const cookie = (name, value, age) => `${name}=${value}; Path=/api/google/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}
const readSession = async (request, env) => {
  const session = await unseal(env, cookies(request)[SESSION]);
  return typeof session?.refresh === 'string' ? session : null;
};

// ---------- cookie 加密（AES-GCM）----------
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
