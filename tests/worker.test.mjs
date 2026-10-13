import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const ORIGIN = 'https://snake.example';
const env = {
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', SESSION_KEY: 'test-key',
  ASSETS: { fetch: request => new Response('asset ' + new URL(request.url).pathname) },
};
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

// 假的 Google token 端點：記錄收到的表單，回傳 reply(form)
function fakeGoogle(reply) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const form = Object.fromEntries(new URLSearchParams(options.body ?? ''));
    if (String(url).includes('/drive/v3/about')) return new Response(JSON.stringify({ user: { permissionId: 'p-alice', emailAddress: 'Alice@Example.test', displayName: 'Alice' } }));
    calls.push({ url: String(url), form });
    const [status, body] = reply(form, String(url));
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

const call = (path, { method = 'GET', cookie = '', headers = {} } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers: { Cookie: cookie, ...headers } }), env);
const setCookies = response => response.headers.getSetCookie();
const value = (response, name) => setCookies(response).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='))?.slice(name.length + 1);
const api = { 'X-Requested-With': 'snake-note', Origin: ORIGIN };

// 走完一次授權，回傳 session cookie
async function signIn(scope = DRIVE) {
  const start = await call('/api/google/start?return=' + encodeURIComponent('/app/?x=1'));
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const calls = fakeGoogle(() => [200, { access_token: 'a1', refresh_token: 'r1', scope, expires_in: 3599 }]);
  const back = await call(`/api/google/callback?code=c1&state=${state}`, { cookie: 'snake_google_state=' + value(start, 'snake_google_state') });
  return { back, calls, session: value(back, 'snake_session') };
}

test('static files go to the assets binding; unknown API paths are 404', async () => {
  assert.equal(await (await call('/index.html')).text(), 'asset /index.html');
  assert.equal((await call('/api/nope')).status, 404);
});

test('start redirects to Google with offline access and a state cookie', async () => {
  const response = await call('/api/google/start?return=/');
  assert.equal(response.status, 302);
  const auth = new URL(response.headers.get('Location'));
  assert.equal(auth.origin, 'https://accounts.google.com');
  const params = Object.fromEntries(auth.searchParams);
  assert.equal(params.client_id, env.GOOGLE_CLIENT_ID);
  assert.equal(params.redirect_uri, ORIGIN + '/api/google/callback');
  assert.equal(params.scope, DRIVE);
  assert.equal(params.access_type, 'offline');
  assert.match(params.prompt, /consent/);
  assert.ok(params.state.length >= 20);
  const cookie = setCookies(response)[0];
  assert.match(cookie, /^snake_google_state=/);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /Path=\/api\/google\//);
});

test('callback exchanges the code, stores an encrypted session and goes back', async () => {
  const { back, calls, session } = await signIn();
  assert.equal(back.headers.get('Location'), ORIGIN + '/app/?x=1#google=ok');
  assert.deepEqual(calls[0].form, { code: 'c1', client_id: env.GOOGLE_CLIENT_ID, client_secret: 'secret', redirect_uri: ORIGIN + '/api/google/callback', grant_type: 'authorization_code' });
  assert.ok(session && !session.includes('r1'), 'refresh token is encrypted');
  assert.ok(setCookies(back).some(c => c.startsWith('snake_google_state=;')), 'state cookie cleared');
  const status = await (await call('/api/google/status', { cookie: 'snake_session=' + session })).json();
  assert.deepEqual(status, { connected: true, user: { id: 'p-alice', email: 'alice@example.test', name: 'Alice' } });
});

test('callback rejects a wrong state, a denied consent and a missing Drive scope', async () => {
  const start = await call('/api/google/start?return=/');
  const state = value(start, 'snake_google_state');
  fakeGoogle(() => [200, {}]);
  const wrong = await call('/api/google/callback?code=c&state=nope', { cookie: 'snake_google_state=' + state });
  assert.equal(wrong.headers.get('Location'), ORIGIN + '/#google=error');
  assert.equal(value(wrong, 'snake_session'), undefined);
  const real = new URL(start.headers.get('Location')).searchParams.get('state');
  const denied = await call(`/api/google/callback?error=access_denied&state=${real}`, { cookie: 'snake_google_state=' + state });
  assert.equal(denied.headers.get('Location'), ORIGIN + '/#google=denied');
  const { back } = await signIn('openid');
  assert.match(back.headers.get('Location'), /#google=scope$/);
  assert.equal(value(back, 'snake_session'), undefined);
});

test('return path must stay on this site', async () => {
  for (const evil of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
    const start = await call('/api/google/start?return=' + encodeURIComponent(evil));
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    fakeGoogle(() => [200, { refresh_token: 'r', scope: DRIVE }]);
    const back = await call(`/api/google/callback?code=c&state=${state}`, { cookie: 'snake_google_state=' + value(start, 'snake_google_state') });
    assert.equal(back.headers.get('Location'), ORIGIN + '/#google=ok', evil);
  }
});

test('token refreshes with the stored refresh token and renews the cookie', async () => {
  const { session } = await signIn();
  const calls = fakeGoogle(() => [200, { access_token: 'a2', expires_in: 3599 }]);
  const response = await call('/api/google/token', { method: 'POST', cookie: 'snake_session=' + session, headers: api });
  assert.deepEqual(await response.json(), { access_token: 'a2', expires_in: 3599, user: { id: 'p-alice', email: 'alice@example.test', name: 'Alice' } });
  assert.equal(calls[0].form.refresh_token, 'r1');
  assert.equal(calls[0].form.grant_type, 'refresh_token');
  assert.ok(value(response, 'snake_session'));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('token is refused across sites, without a session, or with a tampered cookie', async () => {
  const { session } = await signIn();
  fakeGoogle(() => [200, { access_token: 'a' }]);
  const cross = await call('/api/google/token', { method: 'POST', cookie: 'snake_session=' + session, headers: { ...api, Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const noHeader = await call('/api/google/token', { method: 'POST', cookie: 'snake_session=' + session, headers: { Origin: ORIGIN } });
  assert.equal(noHeader.status, 403);
  assert.equal((await call('/api/google/token', { method: 'POST', headers: api })).status, 401);
  const tampered = session.slice(0, -2) + (session.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await call('/api/google/token', { method: 'POST', cookie: 'snake_session=' + tampered, headers: api })).status, 401);
  assert.equal((await call('/api/google/token', { headers: api })).status, 404, 'GET is not allowed');
});

test('a revoked grant signs the browser out', async () => {
  const { session } = await signIn();
  fakeGoogle(() => [400, { error: 'invalid_grant' }]);
  const response = await call('/api/google/token', { method: 'POST', cookie: 'snake_session=' + session, headers: api });
  assert.equal(response.status, 401);
  assert.ok(setCookies(response).some(c => c.startsWith('snake_session=;') && c.includes('Max-Age=0')));
});

test('logout revokes the token and clears the cookie', async () => {
  const { session } = await signIn();
  const calls = fakeGoogle(() => [200, {}]);
  const response = await call('/api/google/logout', { method: 'POST', cookie: 'snake_session=' + session, headers: api });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(calls.at(-1).form.token, 'r1');
  assert.ok(setCookies(response).some(c => c.startsWith('snake_session=;')));
});

test('config says the site has live collaboration', async () => {
  assert.deepEqual(await (await call('/api/config')).json(), { mode: 'cloudflare' });
});

test('an old cookie still works and is replaced by the new one', async () => {
  const { session } = await signIn();
  fakeGoogle(() => [200, { access_token: 'a3', expires_in: 3599 }]);
  const response = await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + session, headers: api });
  assert.equal(response.status, 200);
  assert.ok(value(response, 'snake_session'));
  assert.ok(setCookies(response).some(c => c.startsWith('snake_google=;') && c.includes('Path=/api/google/')));
});

// 假的 Drive：files.get 依 access 回傳權限
function fakeDrive(access) {
  return fakeGoogle((form, url) => {
    if (url.endsWith('/token')) return [200, { access_token: 'a', expires_in: 3599 }];
    if (url.includes('/drive/v3/files/')) return access;
    return [404, {}];
  });
}
const FILE_ID = '1AbCdEfGhIjKlMnOp';
const roomEnv = fetch => ({ ...env, ROOMS: { idFromName: name => name, get: id => ({ fetch: request => fetch(request, id) }) } });

test('a ticket reflects Drive permissions and only opens its own file', async () => {
  const { session } = await signIn();
  const calls = fakeDrive([200, { id: FILE_ID, name: '頁.zip', trashed: false, appProperties: { kind: 'page' }, capabilities: { canEdit: false, canShare: false } }]);
  const response = await call(`/api/shared/${FILE_ID}/ticket`, { method: 'POST', cookie: 'snake_session=' + session, headers: api });
  const body = await response.json();
  assert.equal(body.role, 'viewer');
  assert.equal(body.user.email, 'alice@example.test');
  assert.ok(calls.some(c => c.url.includes(`/drive/v3/files/${FILE_ID}?`)));
  // 通行證只能開這個檔案的圖片
  const env2 = roomEnv((request, id) => new Response(`room ${id} ${new URL(request.url).pathname}`));
  const blob = await worker.fetch(new Request(`${ORIGIN}/api/shared/${FILE_ID}/blobs/img1`, { headers: { 'X-Snake-Ticket': body.ticket } }), env2);
  assert.equal(await blob.text(), `room ${FILE_ID} /blob`);
  const other = await worker.fetch(new Request(`${ORIGIN}/api/shared/OtherFile12345/blobs/img1`, { headers: { 'X-Snake-Ticket': body.ticket } }), env2);
  assert.equal(other.status, 401);
  const write = await worker.fetch(new Request(`${ORIGIN}/api/shared/${FILE_ID}/blobs/img1`, { method: 'PUT', headers: { 'X-Snake-Ticket': body.ticket, 'Content-Type': 'image/png' }, body: 'x' }), env2);
  assert.equal(write.status, 403, 'viewers cannot upload');
});

test('no ticket without Drive access, for non-page files, or across sites', async () => {
  const { session } = await signIn();
  const ask = () => call(`/api/shared/${FILE_ID}/ticket`, { method: 'POST', cookie: 'snake_session=' + session, headers: api });
  fakeDrive([404, {}]); assert.equal((await ask()).status, 403);
  fakeDrive([200, { id: FILE_ID, trashed: false, appProperties: { app: 'snake-note-notebook-v1' }, capabilities: { canEdit: true } }]); assert.equal((await ask()).status, 404);
  fakeDrive([200, { id: FILE_ID, trashed: true, appProperties: { kind: 'page' }, capabilities: { canEdit: true } }]); assert.equal((await ask()).status, 404);
  const cross = await call(`/api/shared/${FILE_ID}/ticket`, { method: 'POST', cookie: 'snake_session=' + session, headers: { ...api, Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal((await call(`/api/shared/${FILE_ID}/ticket`, { method: 'POST', headers: api })).status, 401);
});

test('the room WebSocket needs a valid ticket for that file', async () => {
  const { session } = await signIn();
  fakeDrive([200, { id: FILE_ID, trashed: false, appProperties: { kind: 'page' }, capabilities: { canEdit: true } }]);
  const { ticket } = await (await call(`/api/shared/${FILE_ID}/ticket`, { method: 'POST', cookie: 'snake_session=' + session, headers: api })).json();
  let peer;
  const env2 = roomEnv(request => { peer = JSON.parse(request.headers.get('X-Snake-Peer')); return new Response('ok'); });
  const open = t => worker.fetch(new Request(`${ORIGIN}/api/shared/${FILE_ID}/ws?ticket=${t}`, { headers: { Upgrade: 'websocket', Origin: ORIGIN } }), env2);
  assert.equal((await open(ticket)).status, 200);
  assert.deepEqual({ ...peer, until: 0 }, { id: 'p-alice', name: 'Alice', email: 'alice@example.test', role: 'editor', until: 0 });
  assert.equal((await open('forged')).status, 401);
  const cross = await worker.fetch(new Request(`${ORIGIN}/api/shared/${FILE_ID}/ws?ticket=${ticket}`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }), env2);
  assert.equal(cross.status, 403);
});

test('only the owner can clear the room when sharing stops', async () => {
  const { session } = await signIn();
  let destroyed = 0;
  const env2 = roomEnv(request => { if (new URL(request.url).pathname === '/destroy') destroyed++; return new Response(null, { status: 204 }); });
  const stop = () => worker.fetch(new Request(`${ORIGIN}/api/shared/${FILE_ID}`, { method: 'DELETE', headers: { Cookie: 'snake_session=' + session, ...api } }), env2);
  fakeDrive([200, { id: FILE_ID, trashed: false, appProperties: { kind: 'page' }, capabilities: { canEdit: true, canShare: false } }]);
  assert.equal((await stop()).status, 403, 'editors cannot');
  fakeDrive([200, { id: FILE_ID, trashed: false, appProperties: { kind: 'page' }, capabilities: { canEdit: true, canShare: true } }]);
  assert.equal((await stop()).status, 200);
  assert.equal(destroyed, 1);
});
