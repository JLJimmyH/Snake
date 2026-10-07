import { ensure, MAX_BYTES } from './notebook-core.js';

const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
const APP = 'snake-note-notebook-v1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FIELDS = 'id,name,modifiedTime,size,headRevisionId';
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

// 一本筆記本 = Drive 上一個 zip 檔。drive.file 權限只看得到這個 app 建立的檔案。
export class DriveClient {
  constructor(clientId, { request = (...args) => fetch(...args) } = {}) {
    this.clientId = clientId; this.request = request;
    this.token = null; this.expires = 0; this.account = null;
  }
  get connected() { return Boolean(this.account && this.token && Date.now() < this.expires); }
  // Must be invoked directly by a user click, after loadGoogleIdentity resolves.
  connect() {
    ensure(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(this.clientId), '網站尚未設定 Google OAuth Client ID');
    ensure(globalThis.google?.accounts?.oauth2, 'Google 登入元件尚未載入，請稍候再試');
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
  async api(url, options = {}, timeout = 60000) {
    ensure(this.token && Date.now() < this.expires, 'Google 授權已過期，請重新連線；本機筆記仍保留');
    let response;
    try { response = await this.request(url.startsWith('https://') ? url : API + url, {
      ...options, signal: AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${this.token}`, ...options.headers },
    }); } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? 'Drive 請求逾時，本機筆記仍保留，請稍後重試' : '連線中斷，本機筆記仍保留；請確認網路後重試');
    }
    if (response.status === 401) { this.token = null; throw new Error('Google 授權已過期，請重新連線'); }
    if (!response.ok) {
      const error = new Error(response.status === 404 ? 'Drive 上找不到這個檔案' : response.status === 403 ? 'Drive 拒絕存取，請確認授權、API 設定與儲存空間' : response.status === 429 ? 'Drive 請求過多，請稍後重試' : `Drive 請求失敗 (${response.status})，本機筆記仍保留`);
      error.status = response.status; throw error;
    }
    return response;
  }
  async json(url, options) { return (await this.api(url, options)).json(); }
  async list() {
    const result = []; let pageToken;
    do {
      const params = new URLSearchParams({ q: `trashed = false and appProperties has { key='app' and value='${APP}' }`, fields: `nextPageToken,files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json('files?' + params);
      result.push(...(page.files ?? [])); pageToken = page.nextPageToken;
      ensure(result.length <= 10000, '雲端檔案過多');
    } while (pageToken);
    return result;
  }
  file(id) { return this.json(`files/${encodeURIComponent(id)}?fields=${FIELDS},trashed,appProperties`); }
  async download(id) {
    const file = await this.file(id);
    ensure(file.appProperties?.app === APP && !file.trashed, '這不是筆記本檔案，或已移到垃圾桶');
    ensure(Number(file.size ?? 0) <= MAX_BYTES, '檔案超過 100 MB');
    const data = await (await this.api(`files/${encodeURIComponent(id)}?alt=media`, {}, 600000)).blob();
    return { file, data };
  }
  // 省略 id = 建立新檔；有 id = 覆寫內容並同步檔名。用 resumable upload，大檔也能傳。
  async upload({ id, name, blob }) {
    const metadata = id ? { name } : { name, mimeType: 'application/zip', appProperties: { app: APP } };
    const session = await this.api(`${UPLOAD}files${id ? '/' + encodeURIComponent(id) : ''}?uploadType=resumable&fields=${FIELDS}`, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip' },
      body: JSON.stringify(metadata),
    });
    const location = session.headers.get('Location');
    ensure(location?.startsWith(UPLOAD), 'Drive 上傳初始化失敗，請稍後重試');
    return (await this.api(location, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: blob }, 600000)).json();
  }
}
