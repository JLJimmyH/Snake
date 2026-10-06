import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { publish, project, LOCAL, encode } from '../collaboration/model.js';
import { DemoStore } from '../collaboration/store.mjs';
import { createCollaborationServer } from '../collaboration/server.mjs';

const stroke = id => ({ id, type: 'stroke', tool: 'pen', color: '#123456', width: 3, pts: [[1, 2], [3, 4]] });

test('concurrent strokes and offline edits merge without deleting unseen objects', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  publish(a, [], [stroke('alice')]);
  publish(b, [], [stroke('bob')]);
  const au = Y.encodeStateAsUpdate(a), bu = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bu); Y.applyUpdate(b, au);
  assert.deepEqual(project(a), project(b));
  assert.equal(project(a).length, 2);
  // Alice's board still displayed only her stroke while Bob's arrived.
  publish(a, [stroke('alice')], [{ ...stroke('alice'), width: 7 }]);
  assert.equal(project(a).find(i => i.id === 'bob').width, 3);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.deepEqual(project(a), project(b));
  a.destroy(); b.destroy();
});

test('local Yjs undo keeps another user’s stroke', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  const undo = new Y.UndoManager(a.getMap('items'), { trackedOrigins: new Set([LOCAL]) });
  publish(a, [], [stroke('alice')]);
  publish(b, [], [stroke('bob')]);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
  undo.undo();
  assert.deepEqual(project(a).map(item => item.id), ['bob']);
  undo.redo();
  assert.equal(project(a).length, 2);
  undo.destroy(); a.destroy(); b.destroy();
});

test('demo store preserves data and denies viewer, stranger, and editor invitations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'note-store-'));
  try {
    const store = new DemoStore(directory);
    const alice = { id: 'a', email: 'alice@example.test' }, bob = { id: 'b', email: 'bob@example.test' }, eve = { id: 'e', email: 'eve@example.test' };
    const page = await store.create(alice, 'shared');
    await store.invite(page.id, alice, bob.email, 'viewer');
    await store.append(page.id, alice, 'update');
    await assert.rejects(store.append(page.id, bob, 'forbidden'), { status: 403 });
    await assert.rejects(store.access(page.id, eve), { status: 403 });
    await store.invite(page.id, alice, bob.email, 'editor');
    await assert.rejects(store.invite(page.id, bob, eve.email, 'editor'), { status: 403 });
    assert.deepEqual(await new DemoStore(directory).updates(page.id, bob), ['update']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function connect(url, origin, page, email) {
  const ws = new WebSocket(url, { origin });
  const messages = []; const waiting = [];
  ws.on('message', data => {
    const value = JSON.parse(data);
    messages.push(value);
    for (const waiter of [...waiting]) {
      const index = messages.findIndex(m => m.type === waiter.type);
      if (index >= 0) { waiting.splice(waiting.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(messages.splice(index, 1)[0]); }
    }
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: `demo:${email}`, page })));
  const next = type => {
    const index = messages.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, timer: setTimeout(() => reject(new Error(`Timed out: ${type}`)), 5000) }; waiting.push(waiter);
    });
  };
  return { ws, next };
}

test('HTTP/WS enforce ACL, acknowledge durable updates, and keep private files private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'note-server-'));
  const origin = 'http://test.local';
  const app = await createCollaborationServer({ demo: true, host: '127.0.0.1', port: 0, origin, directory });
  const sockets = [];
  try {
    const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
    const request = (path, email, options = {}) => fetch(base + path, { ...options, headers: { Authorization: `Bearer demo:${email}`, 'Content-Type': 'application/json', ...options.headers } });
    const created = await request('/api/pages', 'alice@example.test', { method: 'POST', body: JSON.stringify({ title: 'test' }) });
    assert.equal(created.status, 201); const page = await created.json();
    await request(`/api/pages/${page.id}/members`, 'alice@example.test', { method: 'POST', body: JSON.stringify({ email: 'bob@example.test', role: 'viewer' }) });
    const a = connect(base.replace('http:', 'ws:') + '/collab', origin, page.id, 'alice@example.test'); sockets.push(a.ws);
    const b = connect(base.replace('http:', 'ws:') + '/collab', origin, page.id, 'bob@example.test'); sockets.push(b.ws);
    assert.equal((await a.next('sync')).role, 'owner'); assert.equal((await b.next('sync')).role, 'viewer');
    const doc = new Y.Doc(); publish(doc, [], [stroke('alice')]);
    a.ws.send(JSON.stringify({ type: 'update', update: encode(Y.encodeStateAsUpdate(doc)), version: 1 }));
    assert.equal((await a.next('ack')).version, 1); assert.ok((await b.next('update')).update);
    assert.equal((await new DemoStore(directory).updates(page.id, { id: 'alice@example.test', email: 'alice@example.test' })).length, 1);
    b.ws.send(JSON.stringify({ type: 'update', update: encode(Y.encodeStateAsUpdate(doc)), version: 2 }));
    assert.match((await b.next('error')).message, /存取权|存取權/);
    const eve = connect(base.replace('http:', 'ws:') + '/collab', origin, page.id, 'eve@example.test'); sockets.push(eve.ws);
    assert.match((await eve.next('error')).message, /存取權/);
    assert.deepEqual(await (await request('/api/pages', 'eve@example.test')).json(), []);
    for (const path of ['/.env', '/.local-data/demo.json', '/collaboration/server.mjs', '/package-lock.json']) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/api/pages')).status, 401);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      http.get(base + '/api/config', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await fetch(base + '/api/pages', { headers: { Origin: 'https://evil.example' } })).status, 403);
    doc.destroy();
  } finally { sockets.forEach(ws => ws.terminate()); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('demo cannot bind a public interface', async () => {
  await assert.rejects(createCollaborationServer({ demo: true, host: '0.0.0.0' }), /loopback/);
});


test('production refuses secret and service-role keys before exposing config', async () => {
  await assert.rejects(createCollaborationServer({ demo: false, supabaseUrl: 'https://example.supabase.co', key: 'sb_secret_private' }), /公開金鑰/);
  const serviceKey = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
  await assert.rejects(createCollaborationServer({ demo: false, supabaseUrl: 'https://example.supabase.co', key: serviceKey }), /公開金鑰/);
});
