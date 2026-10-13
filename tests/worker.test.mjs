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
  globalThis.fetch = async (url, options) => {
    const form = Object.fromEntries(new URLSearchParams(options.body));
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
  return { back, calls, session: value(back, 'snake_google') };
}

test('static files go to the assets binding; unknown API paths are 404', async () => {
  assert.equal(await (await call('/index.html')).text(), 'asset /index.html');
  assert.equal((await call('/api/config')).status, 404);
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
  const status = await (await call('/api/google/status', { cookie: 'snake_google=' + session })).json();
  assert.deepEqual(status, { connected: true });
});

test('callback rejects a wrong state, a denied consent and a missing Drive scope', async () => {
  const start = await call('/api/google/start?return=/');
  const state = value(start, 'snake_google_state');
  fakeGoogle(() => [200, {}]);
  const wrong = await call('/api/google/callback?code=c&state=nope', { cookie: 'snake_google_state=' + state });
  assert.equal(wrong.headers.get('Location'), ORIGIN + '/#google=error');
  assert.equal(value(wrong, 'snake_google'), undefined);
  const real = new URL(start.headers.get('Location')).searchParams.get('state');
  const denied = await call(`/api/google/callback?error=access_denied&state=${real}`, { cookie: 'snake_google_state=' + state });
  assert.equal(denied.headers.get('Location'), ORIGIN + '/#google=denied');
  const { back } = await signIn('openid');
  assert.match(back.headers.get('Location'), /#google=scope$/);
  assert.equal(value(back, 'snake_google'), undefined);
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
  const response = await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + session, headers: api });
  assert.deepEqual(await response.json(), { access_token: 'a2', expires_in: 3599 });
  assert.equal(calls[0].form.refresh_token, 'r1');
  assert.equal(calls[0].form.grant_type, 'refresh_token');
  assert.ok(value(response, 'snake_google'));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('token is refused across sites, without a session, or with a tampered cookie', async () => {
  const { session } = await signIn();
  fakeGoogle(() => [200, { access_token: 'a' }]);
  const cross = await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + session, headers: { ...api, Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const noHeader = await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + session, headers: { Origin: ORIGIN } });
  assert.equal(noHeader.status, 403);
  assert.equal((await call('/api/google/token', { method: 'POST', headers: api })).status, 401);
  const tampered = session.slice(0, -2) + (session.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + tampered, headers: api })).status, 401);
  assert.equal((await call('/api/google/token', { headers: api })).status, 404, 'GET is not allowed');
});

test('a revoked grant signs the browser out', async () => {
  const { session } = await signIn();
  fakeGoogle(() => [400, { error: 'invalid_grant' }]);
  const response = await call('/api/google/token', { method: 'POST', cookie: 'snake_google=' + session, headers: api });
  assert.equal(response.status, 401);
  assert.ok(setCookies(response).some(c => c.startsWith('snake_google=;') && c.includes('Max-Age=0')));
});

test('logout revokes the token and clears the cookie', async () => {
  const { session } = await signIn();
  const calls = fakeGoogle(() => [200, {}]);
  const response = await call('/api/google/logout', { method: 'POST', cookie: 'snake_google=' + session, headers: api });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(calls[0].form.token, 'r1');
  assert.ok(setCookies(response).some(c => c.startsWith('snake_google=;')));
});
