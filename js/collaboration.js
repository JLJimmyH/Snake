import * as Y from 'yjs';
import { createClient } from '@supabase/supabase-js';
import { db } from './db.js';
import { LOCAL, encode, decode, project, publish } from '../collaboration/model.js';

const roleLabel = { owner: '擁有者', editor: '可編輯', viewer: '唯讀' };
const $ = selector => document.querySelector(selector);

class SharedSession {
  constructor(ui, page) {
    this.ui = ui; this.page = page; this.doc = new Y.Doc(); this.baseline = [];
    this.version = 0; this.dirty = false; this.ready = false; this.closed = false;
    this.uploads = new Set(); this.cacheQueue = Promise.resolve();
    this.cacheKey = `collab:${ui.user.id}:${page.id}`;
    this.instance = crypto.randomUUID();
    this.undo = new Y.UndoManager(this.doc.getMap('items'), { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 });
  }
  async start(initial) {
    const cached = await db.get('meta', this.cacheKey);
    if (cached) {
      Y.applyUpdate(this.doc, decode(cached.update), 'cache');
      this.version = cached.version ?? 0; this.dirty = cached.dirty;
      this.inheritedPending = { ...(cached.pending ?? {}) };
      this.uploads = new Set(cached.uploads ?? []);
    }
    this.baseline = project(this.doc);
    this.ui.openBoard(this.page, this.baseline);
    this.doc.on('update', (_update, origin) => {
      if (origin === LOCAL || origin === this.undo) {
        this.version++; this.dirty = true;
        this.cache(); this.scheduleSend();
      } else this.cache();
      this.ui.board._history();
    });
    this.undo.on('stack-item-added', () => this.ui.board._history());
    this.undo.on('stack-item-popped', () => this.ui.board._history());
    if (initial) { publish(this.doc, [], initial); this.render(); }
    this.renderTimer = setInterval(() => this.render(), 60);
    this.previewTimer = setInterval(() => {
      if (!this.ready || this.page.role === 'viewer') return;
      const action = this.ui.board.action;
      if (action?.kind === 'draw') {
        // Preview only; large strokes are sampled, final full stroke is durable.
        const item = { ...action.item, pts: action.item.pts.filter((_, i) => i % Math.max(1, Math.ceil(action.item.pts.length / 1500)) === 0) };
        this.ws.send(JSON.stringify({ type: 'preview', item })); this.previewActive = true;
      } else if (this.previewActive) {
        this.ws.send(JSON.stringify({ type: 'preview', item: null })); this.previewActive = false;
      }
    }, 50);
    this.connect();
  }
  blobKey(id) { return `collab-blob:${this.ui.user.id}:${this.page.id}:${id}`; }
  async blob(id) {
    const cached = await db.get('blobs', this.blobKey(id));
    if (cached) return cached;
    // A newly added image exists in the original local blob store.
    const local = await db.get('blobs', id);
    if (local) return local;
    try {
      const response = await this.ui.request(`/api/pages/${this.page.id}/blobs/${id}`);
      const blob = await response.blob();
      await db.put('blobs', blob, this.blobKey(id));
      return blob;
    } catch { return null; }
  }
  async cache() {
    const value = { update: encode(Y.encodeStateAsUpdate(this.doc)), dirty: this.dirty, version: this.version, uploads: [...this.uploads] };
    // Never let two tabs overwrite each other's offline Yjs history. Each tab's
    // pending bit is independent: an ack from one cannot clear another's work.
    this.cacheQueue = this.cacheQueue.then(() => db.update('meta', this.cacheKey, previous => {
      const pending = { ...(previous?.pending ?? {}) };
      if (value.dirty) pending[this.instance] = value.version; else delete pending[this.instance];
      const merged = previous ? encode(Y.mergeUpdates([decode(previous.update), decode(value.update)])) : value.update;
      return { ...value, update: merged, pending, dirty: Object.keys(pending).length > 0, uploads: [...new Set([...(previous?.uploads ?? []), ...value.uploads])] };
    }));
    try { await this.cacheQueue; }
    catch (error) { this.ui.status('本機儲存失敗，請勿關閉頁面'); throw error; }
  }
  local(items) {
    if (this.page.role === 'viewer') return;
    publish(this.doc, this.baseline, items);
    this.baseline = structuredClone(items);
  }
  render(force = false) {
    const board = this.ui.board;
    if (this.closed || (!force && (board.action || board.editing))) return;
    const items = project(this.doc);
    if (JSON.stringify(items) !== JSON.stringify(this.baseline)) {
      board.applyRemote(items);
      this.baseline = structuredClone(items);
    }
  }
  scheduleSend() {
    clearTimeout(this.sendTimer);
    this.ui.status(this.ready ? '同步中…' : '離線，已保留待同步內容');
    this.sendTimer = setTimeout(() => this.send().catch(error => this.fail(error)), 80);
  }
  async send() {
    if (!this.ready || this.inFlight || this.sending || !this.dirty || this.page.role === 'viewer') return;
    this.sending = true;
    try {
      for (const item of project(this.doc)) {
        if (item.type !== 'image' || this.uploads.has(item.blobId)) continue;
        const blob = await this.blob(item.blobId);
        if (!blob) throw new Error('圖片尚未取得，稍後再同步');
        await this.ui.request(`/api/pages/${this.page.id}/blobs/${item.blobId}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
        this.uploads.add(item.blobId);
      }
      if (this.closed || !this.ready) return;
      const version = this.version;
      const update = encode(Y.encodeStateAsUpdate(this.doc, decode(this.vector)));
      this.inFlight = version;
      this.ws.send(JSON.stringify({ type: 'update', update, version }));
      clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => this.ws?.close(), 15000);
    } finally { this.sending = false; }
  }
  async connect() {
    if (this.closed) return;
    this.ui.status(this.dirty ? '連線中，待同步內容已保留' : '連線中…');
    try {
      const token = await this.ui.token();
      if (this.closed) return;
      const url = new URL('/collab', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = this.ws = new WebSocket(url);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, page: this.page.id }));
      let messages = Promise.resolve();
      ws.onmessage = event => {
        messages = messages.then(async () => {
          if (this.closed || this.ws !== ws) return;
          const message = JSON.parse(event.data);
          if (message.type === 'sync') {
            Y.applyUpdate(this.doc, decode(message.update), 'remote');
            this.vector = message.vector; this.page.role = message.role;
            this.ui.board.setReadOnly(message.role === 'viewer');
            this.ready = true; this.inFlight = null;
            this.render();
            // An interrupted save is replayed by state vector, not a whole-page overwrite.
            if (this.dirty && message.role !== 'viewer') await this.send();
            else this.ui.status(message.role === 'viewer' ? '唯讀・已連線' : '已同步');
            if (this.dirty && message.role === 'viewer') this.ui.status('權限已改為唯讀，未同步內容仍保留在此裝置');
            this.ui.board.refreshImages();
          } else if (message.type === 'update') {
            Y.applyUpdate(this.doc, decode(message.update), 'remote');
            this.render();
          } else if (message.type === 'ack') {
            clearTimeout(this.ackTimer); this.inFlight = null; this.vector = message.vector;
            if (message.version === this.version) this.dirty = false;
            await this.cache();
            if (!this.dirty) await db.update('meta', this.cacheKey, previous => {
              if (!previous) return previous;
              // This session loaded these exact pending versions into its doc
              // before syncing. Clear only unchanged inherited markers; another
              // tab's later offline edits retain their newer marker.
              const pending = { ...previous.pending };
              for (const [instance, version] of Object.entries(this.inheritedPending ?? {})) {
                if (pending[instance] === version) delete pending[instance];
              }
              this.inheritedPending = {};
              return { ...previous, pending, dirty: Object.keys(pending).length > 0 };
            });
            this.ui.status(this.dirty ? '同步中…' : '已同步');
            if (this.dirty) await this.send();
          } else if (message.type === 'preview') this.ui.board.preview(message.peerId, message.item);
          else if (message.type === 'presence') $('#collab-presence').textContent = `${message.count} 人在線`;
          else if (message.type === 'error') this.ui.status(message.message);
        }).catch(error => this.fail(error));
      };
      ws.onclose = event => {
        if (this.closed || this.ws !== ws) return;
        this.ready = false; this.inFlight = null;
        clearTimeout(this.ackTimer);
        this.ui.board.clearPreviews();
        $('#collab-presence').textContent = '';
        if (event.code === 4401) { this.ui.status('登入已過期，請重新登入；待同步內容已保留'); return; }
        this.ui.status(this.dirty ? '離線，已保留待同步內容' : '連線中斷，正在重連');
        this.retryTimer = setTimeout(() => this.connect(), 2000);
      };
      ws.onerror = () => {}; // onclose handles offline transitions.
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    this.ui.status(error.message || '同步失敗，待同步內容已保留');
    this.ws?.close();
    if (!this.closed && !this.ws) this.retryTimer = setTimeout(() => this.connect(), 2000);
  }
  undoLocal(redo = false) {
    this.ui.board.commitText();
    if (redo) this.undo.redo(); else this.undo.undo();
    this.render(true);
  }
  async close() {
    this.closed = true;
    for (const name of ['renderTimer', 'previewTimer']) clearInterval(this[name]);
    for (const name of ['sendTimer', 'retryTimer', 'ackTimer']) clearTimeout(this[name]);
    this.ws?.close();
    await this.cache();
    this.undo.destroy(); this.doc.destroy();
  }
}

export async function setupCollaboration({ board, beforeOpen, localPage, onOpen, onLeave, toast }) {
  const response = await fetch('/api/config');
  if (!response.ok) return null; // Original Python static mode remains available.
  const config = await response.json();
  const dialog = $('#collab-dialog');
  const ui = {
    board, user: null, active: null, config,
    status(text) { $('#collab-state').textContent = text; },
    async token() {
      if (config.mode === 'demo') {
        if (!ui.user) throw new Error('請先選擇示範帳號');
        return `demo:${ui.user.email}`;
      }
      const { data, error } = await ui.client.auth.getSession();
      if (error || !data.session) throw new Error('請先使用 Google 登入');
      return data.session.access_token;
    },
    async request(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${await ui.token()}`, ...options.headers } });
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw new Error(value.error || `請求失敗 (${response.status})`);
      }
      return response;
    },
    openBoard(page, items) {
      board.load({ items: structuredClone(items) }); board.setReadOnly(page.role === 'viewer');
      board.blobLoader = id => ui.active.blob(id);
      board.historyDelegate = { undo: () => ui.active.undoLocal(), redo: () => ui.active.undoLocal(true), state: () => [ui.active.undo.undoStack.length > 0, ui.active.undo.redoStack.length > 0] };
      onOpen(page);
      $('#collab-leave').hidden = false;
      $('#collab-presence').hidden = false;
      board._history();
    },
    async open(page, initial) {
      await beforeOpen();
      await ui.detach();
      const session = ui.active = new SharedSession(ui, page);
      await session.start(initial);
      dialog.close();
    },
    async detach() {
      if (ui.active) {
        board.commitText();
        await ui.active.close(); ui.active = null;
      }
      board.historyDelegate = null; board.blobLoader = null; board.setReadOnly(false);
      board.clearPreviews();
      for (const url of board.urls.values()) URL.revokeObjectURL(url);
      board.urls.clear();
      $('#collab-leave').hidden = true; $('#collab-presence').hidden = true;
      ui.status('');
    },
    changed() { if (ui.active) ui.active.local(board.items); },
    async saved() { if (ui.active) await ui.active.cache(); },
    async list() {
      const list = $('#collab-pages'); list.replaceChildren();
      if (!ui.user) return;
      try {
        const pages = await (await ui.request('/api/pages')).json();
        if (!pages.length) list.textContent = '尚無協作頁面；可以把目前的本機頁面複製到協作空間。';
        for (const page of pages) {
          const row = document.createElement('div'); row.className = 'collab-page';
          const button = document.createElement('button');
          button.textContent = `${page.title} · ${roleLabel[page.role]}`;
          button.addEventListener('click', () => ui.open(page).catch(error => toast(error.message)));
          row.append(button);
          if (page.role === 'owner') {
            const share = document.createElement('button'); share.textContent = '分享';
            share.addEventListener('click', () => {
              $('#share-page-id').value = page.id;
              $('#share-page-name').textContent = `分享「${page.title}」`;
              $('#collab-share').hidden = false; $('#share-email').focus();
            });
            row.append(share);
          }
          list.append(row);
        }
      } catch (error) { list.textContent = error.message; }
    },
    async setUser(user) {
      if (ui.user?.id !== user?.id && ui.active) { await beforeOpen(); await ui.detach(); await onLeave(); }
      ui.user = user;
      $('#collab-user').textContent = user ? user.email : '登入後可以同步與分享筆記';
      $('#collab-login').hidden = !!user || config.mode === 'demo';
      $('#collab-logout').hidden = !user;
      $('#collab-copy').disabled = !user || !localPage();
      await ui.list();
    },
  };
  if (config.mode === 'supabase') {
    ui.client = createClient(config.supabaseUrl, config.publishableKey);
    ui.client.auth.onAuthStateChange((event, session) => {
      // Avoid awaiting auth SDK calls inside its own state callback.
      setTimeout(() => ui.setUser(session?.user ?? null).catch(error => toast(error.message)), 0);
      if (event === 'TOKEN_REFRESHED' && ui.active) ui.active.ws?.close();
    });
    const { data } = await ui.client.auth.getSession();
    await ui.setUser(data.session?.user ?? null);
  } else {
    $('#collab-mode').textContent = '本機示範：帳號僅用來測試協作，沒有真正登入驗證。正式使用需設定 Google 登入。';
    $('#demo-accounts').hidden = false;
    $('#collab-login').hidden = true;
    for (const button of document.querySelectorAll('[data-demo-email]')) button.addEventListener('click', () => ui.setUser({ id: button.dataset.demoEmail, email: button.dataset.demoEmail }).catch(error => toast(error.message)));
  }
  $('#collab-button').hidden = false;
  $('#collab-button').addEventListener('click', async () => {
    $('#collab-copy').disabled = !ui.user || !localPage();
    $('#collab-share').hidden = true;
    dialog.showModal(); await ui.list();
  });
  $('#collab-close').addEventListener('click', () => dialog.close());
  $('#collab-login').addEventListener('click', async () => {
    const { error } = await ui.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) toast(error.message);
  });
  $('#collab-logout').addEventListener('click', async () => {
    if (ui.active?.dirty) { toast('尚有待同步內容，請先連線完成同步再登出'); return; }
    if (config.mode === 'supabase') { const { error } = await ui.client.auth.signOut(); if (error) { toast(error.message); return; } }
    await ui.setUser(null);
  });
  $('#collab-copy').addEventListener('click', async () => {
    const button = $('#collab-copy'); button.disabled = true;
    try {
      await beforeOpen();
      const local = localPage();
      if (!local) throw new Error('請先選擇本機頁面');
      const initial = structuredClone(board.items);
      const page = await (await ui.request('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: local.title }) })).json();
      await ui.open(page, initial);
      toast('已建立協作副本，原本的本機頁面保留');
    } catch (error) { toast(error.message); }
    finally { button.disabled = !ui.user || !localPage(); }
  });
  $('#collab-share').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#share-submit'); button.disabled = true;
    try {
      await ui.request(`/api/pages/${$('#share-page-id').value}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#share-email').value.trim().toLowerCase(), role: $('#share-role').value }) });
      $('#collab-share').hidden = true; toast('已分享；對方登入相同帳號後即可看到頁面');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $('#collab-leave').addEventListener('click', async () => { await beforeOpen(); await ui.detach(); await onLeave(); });
  window.addEventListener('online', () => { if (ui.active && !ui.active.ready) { clearTimeout(ui.active.retryTimer); ui.active.connect(); } });
  return ui;
}
