// 共用頁的即時協作（Cloudflare 版，worker/room.js 的客戶端）。一個共用頁＝Drive 上的一個檔案＝一間房間。
// 內容用 Yjs 合併：先在本機顯示並存進 IndexedDB，連上後依 state vector 補送；還會轉發畫到一半的筆跡、游標、選取與在線名單。
// 進房間前先跟 Worker 拿通行證（Worker 用這個人的 Google 授權問 Drive 能不能看／改這個檔案）。
// 房間指定一位在線的編輯者（saver）定時把內容寫回 Drive 上的檔案，那才是正本。
// 這個檔案用 esbuild 打包成 collab-assets/collaboration.js（含 Yjs），網站有 /api/config 時才載入。
import * as Y from 'yjs';
import { db } from './db.js';
import { LOCAL, encode, decode, project, publish } from '../collaboration/model.js';

const $ = selector => document.querySelector(selector);
const SAVE_DELAY = 15000;   // saver 停手多久後寫回 Drive
const CURSOR_EVERY = 50;
const api = path => new URL('api/shared/' + path, document.baseURI);
const failure = (message, code) => Object.assign(new Error(message), { code });

class LiveSession {
  // page：{ file（Drive 檔案 ID）, title, local（筆記本裡對應的頁面 ID；別人共用來的頁面沒有）}
  constructor(ui, page) {
    this.ui = ui; this.page = page; this.doc = new Y.Doc(); this.baseline = [];
    this.version = 0; this.dirty = false; this.ready = false; this.closed = false;
    this.uploads = new Set(); this.cacheQueue = Promise.resolve();
    this.cacheKey = `live:${page.file}`;
    this.instance = crypto.randomUUID();
    this.people = new Map();  // peer → { name, color }
    this.undo = new Y.UndoManager(this.doc.getMap('items'), { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 });
  }

  // 拿通行證；沒登入、沒權限、檔案不見了分別丟出 code＝signin／access／missing 的錯誤
  async ticket() {
    let response;
    try { response = await fetch(api(this.page.file + '/ticket'), { method: 'POST', headers: { 'X-Requested-With': 'snake-note' } }); }
    catch { throw failure('連線中斷，請確認網路後重試', 'offline'); }
    if (response.status === 401) throw failure('請先連線 Google', 'signin');
    if (response.status === 403) throw failure('還沒有這一頁的存取權', 'access');
    if (response.status === 404) throw failure('找不到這個共用頁面，可能已被刪除', 'missing');
    if (!response.ok) throw failure(`無法進入共用頁面 (${response.status})`, 'error');
    const ticket = await response.json();
    this.pass = ticket; this.role = ticket.role; this.me = ticket.user;
    // 別人共用來的頁面：標題用 Drive 上的檔名
    this.page.title ??= String(ticket.name ?? '').replace(/\.zip$/i, '') || '共用頁面';
    return ticket;
  }

  // items：還沒有本機快取時先顯示的內容（筆記本裡的這一頁）
  async start(items = []) {
    const cached = await db.get('meta', this.cacheKey);
    try { await this.ticket(); }
    catch (error) {
      // 離線或還沒連線 Google：用這台的快取照常編輯，連上後再補送。沒有權限、檔案不見了就不能開
      if (!['offline', 'signin', 'error'].includes(error.code)) throw error;
      // 別人共用來、這台又沒開過：沒有內容可以顯示
      if (!cached && !this.page.local) throw error;
      this.role = cached?.role ?? 'editor';
      this.page.title ??= cached?.title ?? '共用頁面';
    }
    if (cached) {
      Y.applyUpdate(this.doc, decode(cached.update), 'cache');
      this.version = cached.version ?? 0; this.dirty = cached.dirty;
      this.inheritedPending = { ...(cached.pending ?? {}) };
      this.uploads = new Set(cached.uploads ?? []);
    }
    this.seedItems = items;
    this.baseline = cached ? project(this.doc) : structuredClone(items);
    this.ui.openBoard(this, this.baseline);
    this.doc.on('update', (_update, origin) => {
      if (origin === LOCAL || origin === this.undo) {
        this.version++; this.dirty = true;
        this.cache(); this.scheduleSend();
      } else this.cache();
      this.changedSinceSave = true; this.scheduleSave();
      this.ui.board._history();
    });
    this.undo.on('stack-item-added', () => this.ui.board._history());
    this.undo.on('stack-item-popped', () => this.ui.board._history());
    this.renderTimer = setInterval(() => this.render(), 60);
    this.previewTimer = setInterval(() => this.sendPreview(), 50);
    this.focusTimer = setInterval(() => this.sendFocus(), 150);
    this.pointer = event => this.sendCursor(event);
    this.ui.board.vp.addEventListener('pointermove', this.pointer);
    this.ui.board.vp.addEventListener('pointerleave', this.pointer);
    this.connect();
  }

  blobKey(id) { return `live-blob:${this.page.file}:${id}`; }
  async blob(id) {
    const cached = await db.get('blobs', this.blobKey(id));
    if (cached) return cached;
    // 自己剛加的圖片、或筆記本裡原本就有的圖片
    const local = await db.get('blobs', id);
    if (local) return local;
    try {
      const response = await fetch(api(`${this.page.file}/blobs/${id}`), { headers: { 'X-Snake-Ticket': this.pass.ticket } });
      if (!response.ok) return null;
      const blob = await response.blob();
      await db.put('blobs', blob, this.blobKey(id));
      return blob;
    } catch { return null; }
  }

  async cache() {
    const value = { update: encode(Y.encodeStateAsUpdate(this.doc)), dirty: this.dirty, version: this.version, uploads: [...this.uploads], role: this.role, title: this.page.title };
    // 同一頁在好幾個分頁開著：各自的待同步標記分開記，不會互相蓋掉
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
    if (this.role !== 'editor') return;
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
      this.ui.content(this, items);
    }
  }

  scheduleSend() {
    clearTimeout(this.sendTimer);
    this.ui.status(this.ready ? '同步中…' : '離線中：可以繼續編輯，連上後自動同步');
    this.sendTimer = setTimeout(() => this.send().catch(error => this.fail(error)), 80);
  }

  async send() {
    if (!this.ready || this.inFlight || this.sending || !this.dirty || this.role !== 'editor') return;
    this.sending = true;
    try {
      for (const item of project(this.doc)) {
        if (item.type !== 'image' || this.uploads.has(item.blobId)) continue;
        const blob = await this.blob(item.blobId);
        if (!blob) throw new Error('圖片尚未取得，稍後再同步');
        const response = await fetch(api(`${this.page.file}/blobs/${item.blobId}`), { method: 'PUT', headers: { 'Content-Type': blob.type, 'X-Snake-Ticket': this.pass.ticket }, body: blob });
        if (!response.ok) throw new Error(response.status === 413 ? '這一頁的圖片已達 50 MB 上限' : `圖片上傳失敗 (${response.status})`);
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

  // 房間是空的（剛共用、或房間被清掉）：用筆記本裡的這一頁或 Drive 上的檔案當初始內容
  async seed() {
    if (this.doc.getMap('items').size) { this.dirty = true; return; }
    let items = this.seedItems;
    if (!items.length && !this.page.local) items = (await this.ui.drivePage.load(this.page.file)).items;
    if (items.length) publish(this.doc, [], items);
  }

  async connect() {
    if (this.closed) return;
    this.ui.status(this.dirty ? '連線中，待同步內容已保留' : '連線中…');
    try {
      if (!this.pass || this.pass.until - Date.now() < 30000) await this.ticket();
      if (this.closed) return;
      const url = api(`${this.page.file}/ws?ticket=${encodeURIComponent(this.pass.ticket)}`);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = this.ws = new WebSocket(url);
      let messages = Promise.resolve();
      ws.onmessage = event => {
        messages = messages.then(() => this.receive(ws, JSON.parse(event.data))).catch(error => this.fail(error));
      };
      ws.onclose = event => {
        if (this.closed || this.ws !== ws) return;
        this.ready = false; this.inFlight = null;
        clearTimeout(this.ackTimer);
        this.ui.board.clearPreviews();
        this.ui.presence(this, []);
        if (event.code === 4001) { this.pass = null; this.connect(); return; }  // 通行證到期：換一張再連
        this.ui.status(this.dirty ? '離線中：可以繼續編輯，連上後自動同步' : navigator.onLine ? '連線中斷，正在重連' : '離線中，正在重新連線');
        this.retry();
      };
      ws.onerror = () => {}; // onclose 處理離線
    } catch (error) {
      if (error.code === 'signin') { this.ui.status(this.role === 'editor' ? '連線 Google 後才會同步；可以先繼續編輯' : error.message); return; }
      if (error.code === 'access' || error.code === 'missing') { this.ui.status(error.message); return; }
      if (error.code === 'offline') {
        this.ui.status(this.dirty ? '離線中：可以繼續編輯，連上後自動同步' : '離線中，正在重新連線');
        this.retry();
        return;
      }
      this.fail(error);
    }
  }

  // 連不上時越等越久再試（2 秒起，最多 30 秒）；連上就重設
  retry() {
    if (this.closed) return;
    this.retryDelay = Math.min(30000, (this.retryDelay ?? 1000) * 2);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
  }

  async receive(ws, message) {
    if (this.closed || this.ws !== ws) return;
    const board = this.ui.board;
    if (message.type === 'sync') {
      Y.applyUpdate(this.doc, decode(message.update), 'remote');
      this.vector = message.vector; this.role = message.role; this.peer = message.peer;
      this.retryDelay = null;
      board.setReadOnly(message.role !== 'editor');
      this.ready = true; this.inFlight = null;
      if (message.empty && message.role === 'editor') await this.seed();
      this.render(true);
      // 中斷時沒送出的內容，依 state vector 補送，不會整頁覆蓋
      if (this.dirty && message.role === 'editor') await this.send();
      else this.ui.status(message.role === 'editor' ? '已同步' : '唯讀・已連線');
      if (this.dirty && message.role !== 'editor') this.ui.status('權限已改為唯讀，未同步內容仍保留在此裝置');
      board.refreshImages();
      this.lastFocus = null;
    } else if (message.type === 'update') {
      Y.applyUpdate(this.doc, decode(message.update), 'remote');
      this.render();
    } else if (message.type === 'ack') {
      clearTimeout(this.ackTimer); this.inFlight = null; this.vector = message.vector;
      if (message.version === this.version) this.dirty = false;
      await this.cache();
      if (!this.dirty) await db.update('meta', this.cacheKey, previous => {
        if (!previous) return previous;
        // 只清掉這個分頁載入時繼承、而且沒再變過的待同步標記；別的分頁之後的離線編輯保留
        const pending = { ...previous.pending };
        for (const [instance, version] of Object.entries(this.inheritedPending ?? {})) if (pending[instance] === version) delete pending[instance];
        this.inheritedPending = {};
        return { ...previous, pending, dirty: Object.keys(pending).length > 0 };
      });
      this.ui.status(this.dirty ? '同步中…' : '已同步');
      if (this.dirty) await this.send();
    } else if (message.type === 'preview') board.preview(message.peer, message.item);
    else if (message.type === 'cursor') this.peerUpdate(message.peer, { x: message.x, y: message.y });
    else if (message.type === 'focus') this.peerUpdate(message.peer, { sel: message.sel, editing: message.editing });
    else if (message.type === 'presence') {
      this.people.clear();
      for (const person of message.people) for (const peer of person.peers) this.people.set(peer, person);
      for (const peer of [...(board.peers?.keys() ?? [])]) if (!this.people.has(peer)) board.setPeer(peer, null);
      for (const [peer, person] of this.people) if (board.peers?.has(peer)) board.setPeer(peer, { name: person.name, color: person.color });
      this.saver = message.saver === this.peer;
      if (this.saver) this.scheduleSave();
      this.ui.presence(this, message.people);
    } else if (message.type === 'error') this.ui.status(message.message);
  }

  peerUpdate(peer, value) {
    if (peer === this.peer) return;
    const person = this.people.get(peer);
    this.ui.board.setPeer(peer, { name: person?.name ?? '', color: person?.color, ...value });
  }

  // ---------- 游標、選取、畫到一半的筆跡 ----------
  sendCursor(event) {
    if (!this.ready) return;
    const now = Date.now();
    const point = event.type === 'pointerleave' ? null : this.ui.board.toWorld(event.clientX, event.clientY);
    clearTimeout(this.cursorTimer);
    const send = () => { this.lastCursor = Date.now(); this.ws.send(JSON.stringify({ type: 'cursor', x: point?.x ?? null, y: point?.y ?? null })); };
    if (!point || now - (this.lastCursor ?? 0) >= CURSOR_EVERY) send();
    else this.cursorTimer = setTimeout(send, CURSOR_EVERY);
  }

  sendFocus() {
    if (!this.ready) return;
    const board = this.ui.board;
    const value = JSON.stringify({ type: 'focus', sel: [...board.sel].slice(0, 500), editing: board.editing?.id ?? null });
    if (value === this.lastFocus) return;
    this.lastFocus = value;
    this.ws.send(value);
  }

  sendPreview() {
    if (!this.ready || this.role !== 'editor') return;
    const action = this.ui.board.action;
    if (action?.kind === 'draw') {
      // 只是預覽：很長的筆跡抽樣送出，放開後的完整筆跡才是正式內容
      const item = { ...action.item, pts: action.item.pts.filter((_, i) => i % Math.max(1, Math.ceil(action.item.pts.length / 1500)) === 0) };
      this.ws.send(JSON.stringify({ type: 'preview', item })); this.previewActive = true;
    } else if (this.previewActive) {
      this.ws.send(JSON.stringify({ type: 'preview', item: null })); this.previewActive = false;
    }
  }

  // ---------- 寫回 Drive（只有 saver 做）----------
  scheduleSave(delay = SAVE_DELAY) {
    if (!this.saver || !this.changedSinceSave || this.closed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDrive(), delay);
  }

  async saveToDrive() {
    if (!this.saver || !this.changedSinceSave) return;
    this.changedSinceSave = false;
    try {
      await this.ui.drivePage.save(this.page.file, { name: this.pass.name, title: this.page.title, items: project(this.doc), blob: id => this.blob(id) });
    } catch (error) {
      this.changedSinceSave = true;
      if (!this.closed) this.scheduleSave(60000);
      console.warn('寫回 Drive 失敗', error);
    }
  }

  fail(error) {
    this.ui.status(error.message || '同步失敗，待同步內容已保留');
    this.ws?.close();
    if (!this.closed && !this.ws) this.retry();
  }

  undoLocal(redo = false) {
    this.ui.board.commitText();
    if (redo) this.undo.redo(); else this.undo.undo();
    this.render(true);
  }

  async close() {
    this.closed = true;
    for (const name of ['renderTimer', 'previewTimer', 'focusTimer']) clearInterval(this[name]);
    for (const name of ['sendTimer', 'retryTimer', 'ackTimer', 'cursorTimer', 'saveTimer']) clearTimeout(this[name]);
    this.ui.board.vp.removeEventListener('pointermove', this.pointer);
    this.ui.board.vp.removeEventListener('pointerleave', this.pointer);
    if (this.saver && this.changedSinceSave) this.saveToDrive();  // 不等它，離開時盡量寫回
    this.ws?.close();
    await this.cache();
    this.undo.destroy(); this.doc.destroy();
  }
}

// board；beforeOpen()：開房間前把本機頁面存好；onOpen(page)／onLeave()：進出別人共用的頁面（不在筆記本裡）；
// onContent(page, items)：房間內容變了（筆記本裡的這一頁要跟著存）；drivePage：{ load(file), save(file, content) }
export async function setupCollaboration({ board, beforeOpen, onOpen, onLeave, onContent, drivePage, showMenu, toast }) {
  const ui = {
    board, active: null, drivePage,
    status(text) { $('#collab-state').textContent = text; },
    openBoard(session, items) {
      if (!session.page.local) board.load({ items: structuredClone(items) });
      else if (JSON.stringify(items) !== JSON.stringify(board.items)) board.applyRemote(structuredClone(items));
      board.setReadOnly(session.role !== 'editor');
      board.blobLoader = id => session.blob(id);
      board.historyDelegate = { undo: () => session.undoLocal(), redo: () => session.undoLocal(true), state: () => [session.undo.undoStack.length > 0, session.undo.redoStack.length > 0] };
      if (!session.page.local) onOpen(session.page);
      $('#collab-leave').hidden = !!session.page.local;
      $('#collab-presence').hidden = false;
      board._history();
    },
    content(session, items) { if (session.page.local) onContent(session.page, items); },
    // 在線的人：電腦版是其他人的彩色圓點，手機版只顯示「👥 人數」；點一下列出所有人
    presence(session, people) {
      const box = $('#collab-presence');
      const others = people.filter(person => person.id !== session.me?.id);
      ui.people = people.map(person => ({ ...person, me: person.id === session.me?.id }));
      box.replaceChildren();
      for (const person of others) {
        const dot = document.createElement('span');
        dot.className = 'presence-dot';
        dot.style.setProperty('--peer', person.color);
        dot.textContent = [...(person.name || person.email || '?')][0].toUpperCase();
        dot.title = `${person.name || person.email}${person.role === 'editor' ? '' : '（檢視者）'}`;
        box.append(dot);
      }
      const count = document.createElement('span');
      count.className = 'presence-count';
      count.textContent = `👥 ${people.length}`;
      box.append(count);
      box.title = others.length ? `${people.length} 人正在看這一頁，點一下看是誰` : '';
      box.classList.toggle('alone', !others.length);
    },
    // page：{ file, title, local }；items：還沒有快取時先顯示的內容。沒登入／沒權限丟出 code 為 signin／access 的錯誤
    async open(page, items = []) {
      await beforeOpen();
      await ui.detach();
      const session = new LiveSession(ui, page);
      await session.start(items);
      ui.active = session;
    },
    async detach() {
      if (ui.active) {
        board.commitText();
        await ui.active.close(); ui.active = null;
      }
      board.historyDelegate = null; board.blobLoader = null; board.setReadOnly(false);
      board.clearPreviews();
      $('#collab-leave').hidden = true; $('#collab-presence').hidden = true;
      ui.status('');
    },
    changed() { if (ui.active) ui.active.local(board.items); },
    async saved() { if (ui.active) await ui.active.cache(); },
  };
  $('#collab-leave').addEventListener('click', async () => { await beforeOpen(); await ui.detach(); await onLeave(); });
  $('#collab-presence').addEventListener('click', event => {
    if (!ui.people?.length) return;
    showMenu(event.currentTarget.getBoundingClientRect(), [
      { head: `正在看這一頁（${ui.people.length} 人）` },
      ...ui.people.map(person => ({ label: `${person.name || person.email}${person.me ? '（你）' : ''}`, hint: person.role === 'editor' ? '可編輯' : '檢視者', run: () => {} })),
    ]);
  });
  window.addEventListener('online', () => { if (ui.active && !ui.active.ready) { clearTimeout(ui.active.retryTimer); ui.active.connect(); } });
  return ui;
}
