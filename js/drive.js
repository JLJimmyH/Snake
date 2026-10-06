import { db } from './db.js';
import { hash, ensure, HASH, canonical, verifyCommit } from './version-core.js';

const API = 'https://www.googleapis.com/drive/v3/';
const APP = 'note-mvp-history-v1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
let scriptPromise;
export function loadGoogleIdentity() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    const timeout = setTimeout(() => { script.remove(); scriptPromise = null; reject(new Error('Google 登入元件載入逾時，請確認網路後再試')); }, 15000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); scriptPromise = null; reject(new Error('無法載入 Google 登入元件')); };
    document.head.append(script);
  });
  return scriptPromise;
}

export class DriveClient {
  constructor(clientId, { request = (...args) => fetch(...args), progress = () => {} } = {}) {
    this.clientId = clientId; this.request = request; this.progress = progress;
    this.token = null; this.expires = 0; this.account = null;
  }
  // Must be invoked directly by a user click, after loadGoogleIdentity resolves.
  connect() {
    ensure(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(this.clientId), '請先設定有效的公開 OAuth Client ID');
    ensure(globalThis.google?.accounts?.oauth2, 'Google 登入元件尚未載入，請稍候再按連線');
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPE, include_granted_scopes: false,
        callback: async response => {
          if (response.error) { reject(new Error('Google 授權未完成：' + response.error)); return; }
          if (!response.access_token || !response.scope?.split(' ').includes(SCOPE)) { reject(new Error('尚未授權存取應用程式的 Drive 檔案')); return; }
          this.token = response.access_token; this.expires = Date.now() + Number(response.expires_in) * 1000 - 30000;
          try {
            const about = await this.json('about?fields=user(permissionId,emailAddress,displayName)');
            ensure(about.user?.permissionId && about.user.emailAddress, '無法確認 Drive 帳號');
            this.account = { id: about.user.permissionId, email: about.user.emailAddress };
            resolve(this.account);
          } catch (error) { this.disconnect(); reject(error); }
        }, error_callback: error => reject(new Error(error.type === 'popup_closed' ? '已取消 Google 授權' : '無法開啟 Google 登入，請允許彈出視窗')),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  }
  disconnect() { this.token = null; this.expires = 0; this.account = null; }
  async api(path, options = {}, upload = false) {
    ensure(this.token && Date.now() < this.expires, 'Google 授權已過期，請重新連線；本機版本仍保留');
    const token = this.token;
    let response;
    try { response = await this.request((upload ? 'https://www.googleapis.com/upload/drive/v3/' : API) + path, {
      ...options, signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}`, ...options.headers },
    }); } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? 'Drive 請求逾時，本機版本仍保留，請稍後重試' : '連線中斷，版本仍保留在本機；請確認網路後重試');
    }
    if (response.status === 401) { this.token = null; throw new Error('Google 授權已過期，請重新連線'); }
    if (!response.ok) {
      const error = new Error(response.status === 403 ? 'Drive 拒絕存取，請確認授權、API 設定與儲存空間' : response.status === 429 ? 'Drive 請求過多，請稍後重試' : `Drive 請求失敗 (${response.status})，本機內容仍保留`);
      error.status = response.status; throw error;
    }
    return response;
  }
  async json(path, options) { return (await this.api(path, options)).json(); }
  async files(query) {
    const result = []; let pageToken;
    do {
      const params = new URLSearchParams({ q: `trashed = false and appProperties has { key='app' and value='${APP}' }${query ? ' and ' + query : ''}`, fields: 'nextPageToken,files(id,name,mimeType,size,appProperties)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json('files?' + params);
      result.push(...(page.files ?? [])); pageToken = page.nextPageToken;
      ensure(result.length <= 100000, '雲端檔案過多，請聯絡網站管理者');
    } while (pageToken);
    return result;
  }
  async find(key) {
    ensure(key === 'folder' || /^(object|commit):[a-f0-9]{64}$/.test(key));
    return (await this.files(`appProperties has { key='key' and value='${key}' }`)).sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  async ensureFile(key, data, kind, parent) {
    const existing = await this.find(key);
    if (existing) return existing;
    // Persist a pre-generated Drive ID BEFORE the upload. If Google committed
    // a request but its response was lost, retry uses that same file ID.
    const journalKey = `drive-id:${this.clientId}:${this.account.id}:${key}`;
    let id = await db.get('meta', journalKey);
    if (!id) {
      id = (await this.json('files/generateIds?count=1&space=drive&type=files')).ids[0];
      await db.put('meta', id, journalKey);
    }
    try {
      const prior = await this.json(`files/${encodeURIComponent(id)}?fields=id,appProperties`);
      ensure(prior.appProperties?.key === key && prior.appProperties?.app === APP, '上傳識別碼不一致');
      return prior;
    } catch (error) { if (error.status !== 404) throw error; }
    const metadata = { id, name: kind === 'folder' ? '筆記 MVP 版本歷史' : key.replace(':', '-') + (kind === 'commit' || kind === 'json' ? '.json' : ''),
      appProperties: { app: APP, key, kind }, mimeType: kind === 'folder' ? 'application/vnd.google-apps.folder' : data.type || 'application/octet-stream' };
    if (parent) metadata.parents = [parent];
    if (kind === 'folder') return this.json('files?fields=id,appProperties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
    const boundary = 'note_' + crypto.randomUUID();
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata), `\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`, data, `\r\n--${boundary}--`]);
    return (await this.api('files?uploadType=multipart&fields=id,appProperties', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, true)).json();
  }
  async listCommits() {
    const files = await this.files("appProperties has { key='kind' and value='commit' }");
    const commits = new Map();
    for (const file of files) {
      ensure(Number(file.size ?? 0) <= 2 * 1024 * 1024, '版本索引檔過大');
      const commit = await (await this.api(`files/${encodeURIComponent(file.id)}?alt=media`)).json();
      await verifyCommit(commit);
      ensure(file.appProperties.key === 'commit:' + commit.id, '雲端版本索引不一致');
      commits.set(commit.id, commit);
    }
    return [...commits.values()];
  }
  async downloadObject(id) {
    ensure(HASH.test(id));
    const file = await this.find('object:' + id);
    ensure(file && ['json', 'blob'].includes(file.appProperties.kind) && Number(file.size ?? 0) <= 20 * 1024 * 1024, '雲端缺少內容／圖片或檔案過大');
    const data = await (await this.api(`files/${encodeURIComponent(file.id)}?alt=media`)).blob();
    ensure(data.size <= 20 * 1024 * 1024 && await hash(data) === id, '雲端檔案校驗失敗，未修改本機筆記');
    return { kind: file.appProperties.kind, data };
  }
  async upload(store, id) {
    ensure(this.account && store.scope === 'drive:' + this.account.id, '帳號已變更，不能上傳其他帳號的版本');
    const accountId = this.account.id;
    const publish = async () => {
      const folder = await this.ensureFile('folder', null, 'folder');
      const commits = [], seen = new Set();
      const visit = async key => {
        if (!key || seen.has(key)) return;
        ensure(seen.size < 10000, '版本歷史過長'); seen.add(key);
        const commit = await store.read(key);
        await visit(commit.parent); await visit(commit.restoredFrom); commits.push(commit);
      };
      await visit(id);
      const uploaded = new Set();
      for (let index = 0; index < commits.length; index++) {
        ensure(this.account?.id === accountId, '帳號已變更，上傳已停止');
        const commit = commits[index];
        if (await this.find('commit:' + commit.id)) continue;
        const { objects } = await store.materialize(commit.id);
        for (const [key, object] of objects) {
          if (uploaded.has(key)) continue;
          this.progress(`上傳內容 ${uploaded.size + 1}…`);
          await this.ensureFile('object:' + key, object.data, object.kind, folder.id); uploaded.add(key);
        }
        // Immutable commit is the publication marker, written LAST.
        this.progress(`發布版本 ${index + 1}/${commits.length}…`);
        await this.ensureFile('commit:' + commit.id, new Blob([canonical(commit)], { type: 'application/json' }), 'commit', folder.id);
      }
    };
    if (navigator.locks) await navigator.locks.request('drive-upload:' + accountId, publish);
    else await publish();
  }
}
