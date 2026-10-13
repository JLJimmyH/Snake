import { ensure, MAX_BYTES } from './notebook-core.js';

const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
const APP = 'snake-note-notebook-v1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FIELDS = 'id,name,modifiedTime,size,headRevisionId';
const FOLDER = 'SnakeNote';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const PAGE_FOLDER = '共用頁面';
let scriptPromise;
// 需要使用者重新登入 Google 的錯誤（背景同步遇到就暫停，等使用者點擊）
const authError = message => Object.assign(new Error(message), { auth: true });
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

// 一本筆記本 = Drive 上 SnakeNote 資料夾裡的一個 zip 檔。drive.file 權限只看得到這個 app 建立的資料夾與檔案。
// 兩種登入方式：
//   伺服器（網站有 api/google/*，Cloudflare Worker）：Google 授權一次，Worker 用 HttpOnly cookie 保存 refresh token，
//     之後背景自動換 access token，重新整理也不用再登入。
//   瀏覽器（GitHub Pages 等純靜態網站）：Google 登入元件給的 access token，約一小時過期，過期要使用者再點一次。
export class DriveClient {
  constructor(clientId, { request = (...args) => fetch(...args) } = {}) {
    this.clientId = clientId; this.request = request;
    this.token = null; this.expires = 0; this.account = null;
    this.server = false;   // 網站有 Worker 幫忙保存登入
    this.session = false;  // Worker 上有這個瀏覽器的登入
  }
  // 有帳號、而且不用使用者點擊就能拿到 token
  get connected() { return Boolean(this.account && (this.session || this.token && Date.now() < this.expires)); }

  // 載入時：網站有 Worker、而且之前登入過，就直接恢復連線
  async resume() {
    let status;
    try {
      const response = await this.request(new URL('api/google/status', document.baseURI), { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) return false;
      status = await response.json();
    } catch { return false; }
    this.server = true; this.session = !!status.connected;
    if (!this.session) return false;
    try { await this.refresh(); await this.whoami(); return true; }
    catch { return false; }
  }

  // Must be invoked directly by a user click. 伺服器模式會整頁跳到 Google 授權，回來後 resume() 接手，回傳的 promise 不會結束。
  connect() {
    if (this.server) {
      const back = location.pathname + location.search;
      location.assign(new URL('api/google/start?return=' + encodeURIComponent(back), document.baseURI));
      return new Promise(() => {});
    }
    ensure(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(this.clientId), '網站尚未設定 Google OAuth Client ID');
    ensure(globalThis.google?.accounts?.oauth2, 'Google 登入元件尚未載入，請稍候再試');
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPE, include_granted_scopes: false,
        callback: async response => {
          if (response.error) { reject(new Error('Google 授權未完成：' + response.error)); return; }
          if (!response.access_token || !response.scope?.split(' ').includes(SCOPE)) { reject(new Error('尚未授權存取應用程式的 Drive 檔案')); return; }
          this.token = response.access_token; this.expires = Date.now() + Number(response.expires_in) * 1000 - 30000;
          try { resolve(await this.whoami()); } catch (error) { this.disconnect(); reject(error); }
        }, error_callback: error => reject(new Error(error.type === 'popup_closed' ? '已取消 Google 授權' : '無法開啟 Google 登入，請允許彈出視窗')),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  }
  async whoami() {
    const about = await this.json('about?fields=user(permissionId,emailAddress,displayName)');
    ensure(about.user?.permissionId && about.user.emailAddress, '無法確認 Drive 帳號');
    this.account = { id: about.user.permissionId, email: about.user.emailAddress };
    return this.account;
  }
  // 伺服器模式：用 Worker 保存的 refresh token 換一個新的 access token
  async refresh() {
    let response;
    try {
      response = await this.request(new URL('api/google/token', document.baseURI), { method: 'POST', headers: { 'X-Requested-With': 'snake-note' }, signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('連線中斷，本機筆記仍保留；請確認網路後重試'); }
    if (response.status === 401) { this.session = false; this.token = null; throw authError('Google 登入已失效，請重新連線'); }
    if (!response.ok) throw new Error(`無法更新 Google 授權 (${response.status})，本機筆記仍保留`);
    const { access_token: token, expires_in: seconds } = await response.json();
    this.token = token; this.expires = Date.now() + Number(seconds) * 1000 - 60000;
  }
  disconnect() {
    if (this.server && this.session) this.request(new URL('api/google/logout', document.baseURI), { method: 'POST', headers: { 'X-Requested-With': 'snake-note' } }).catch(() => {});
    this.token = null; this.expires = 0; this.account = null; this.session = false;
  }
  // 有效的 access token（伺服器模式過期就自動換新的）
  async fresh() {
    if (!(this.token && Date.now() < this.expires)) {
      if (!this.session) throw authError('Google 授權已過期，請重新連線；本機筆記仍保留');
      await this.refresh();
    }
    return this.token;
  }
  async api(url, options = {}, timeout = 60000) {
    await this.fresh();
    let response;
    try { response = await this.request(url.startsWith('https://') ? url : API + url, {
      ...options, signal: AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${this.token}`, ...options.headers },
    }); } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? 'Drive 請求逾時，本機筆記仍保留，請稍後重試' : '連線中斷，本機筆記仍保留；請確認網路後重試');
    }
    if (response.status === 401) { this.token = null; throw authError('Google 授權已過期，請重新連線'); }
    if (!response.ok) {
      const error = new Error(response.status === 404 ? 'Drive 上找不到這個檔案' : response.status === 403 ? 'Drive 拒絕存取，請確認授權、API 設定與儲存空間' : response.status === 429 ? 'Drive 請求過多，請稍後重試' : `Drive 請求失敗 (${response.status})，本機筆記仍保留`);
      error.status = response.status; throw error;
    }
    return response;
  }
  async json(url, options) { return (await this.api(url, options)).json(); }
  // 本網站建立的 SnakeNote 資料夾，舊的在前。兩台裝置同時第一次存檔可能各建一個，讀取時都要看。
  async folders() {
    const params = new URLSearchParams({ q: `name = '${FOLDER}' and mimeType = '${FOLDER_TYPE}' and trashed = false`, fields: 'files(id)', orderBy: 'createdTime', pageSize: '10' });
    return ((await this.json('files?' + params)).files ?? []).map(folder => folder.id);
  }
  async folder() {
    const [id] = await this.folders();
    if (id) return id;
    return (await this.json('files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE }),
    })).id;
  }
  async list() {
    const folders = await this.folders();
    if (!folders.length) return [];
    const result = []; let pageToken;
    const parents = folders.map(id => `'${id}' in parents`).join(' or ');
    do {
      const params = new URLSearchParams({ q: `(${parents}) and trashed = false and appProperties has { key='app' and value='${APP}' }`, fields: `nextPageToken,files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '100' });
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
  // ---------- 共用頁：一頁一個檔案，放在 SnakeNote/共用頁面，appProperties kind=page ----------
  async pageFolder() {
    const parent = await this.folder();
    const params = new URLSearchParams({ q: `name = '${PAGE_FOLDER}' and mimeType = '${FOLDER_TYPE}' and '${parent}' in parents and trashed = false`, fields: 'files(id)', orderBy: 'createdTime', pageSize: '10' });
    const [found] = (await this.json('files?' + params)).files ?? [];
    if (found) return found.id;
    return (await this.json('files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name: PAGE_FOLDER, mimeType: FOLDER_TYPE, parents: [parent] }),
    })).id;
  }
  async createPage({ name, blob }) {
    const metadata = { name, mimeType: 'application/zip', appProperties: { app: APP, kind: 'page' }, parents: [await this.pageFolder()] };
    const session = await this.api(`${UPLOAD}files?uploadType=resumable&fields=${FIELDS}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip' }, body: JSON.stringify(metadata),
    });
    const location = session.headers.get('Location');
    ensure(location?.startsWith(UPLOAD), 'Drive 上傳初始化失敗，請稍後重試');
    return (await this.api(location, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: blob }, 600000)).json();
  }
  // 這個 app 看得到的共用頁：自己建立的，加上別人共用、在檔案選擇器選過的。
  // permissions 只有自己的檔案（能管理共用的人）才拿得到，用來顯示共用給幾個人
  async pages() {
    const result = []; let pageToken;
    do {
      const params = new URLSearchParams({ q: "appProperties has { key='kind' and value='page' } and trashed = false", fields: 'nextPageToken,files(id,name,modifiedTime,ownedByMe,owners(displayName,emailAddress),capabilities(canEdit),permissions(id,type,role))', orderBy: 'modifiedTime desc', pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json('files?' + params);
      result.push(...(page.files ?? [])); pageToken = page.nextPageToken;
    } while (pageToken && result.length < 1000);
    return result;
  }
  // ---------- 共用設定（Drive permissions）----------
  async permissions(id) {
    const params = new URLSearchParams({ fields: 'permissions(id,type,role,emailAddress,displayName,photoLink,deleted)' });
    return ((await this.json(`files/${encodeURIComponent(id)}/permissions?${params}`)).permissions ?? []).filter(p => !p.deleted);
  }
  // role：writer（編輯者）／reader（檢視者）；email 省略＝知道連結的任何人
  async share(id, { email, role, message }) {
    const params = new URLSearchParams({ fields: 'id' });
    const body = email ? { type: 'user', role, emailAddress: email } : { type: 'anyone', role, allowFileDiscovery: false };
    if (email) { params.set('sendNotificationEmail', 'true'); if (message) params.set('emailMessage', message); }
    return this.json(`files/${encodeURIComponent(id)}/permissions?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
  }
  setRole(id, permission, role) {
    return this.json(`files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permission)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ role }) });
  }
  unshare(id, permission) {
    return this.api(`files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permission)}`, { method: 'DELETE' });
  }
  // 移到 Drive 的垃圾桶（30 天內可以在 Drive 還原）
  trash(id) {
    return this.json(`files/${encodeURIComponent(id)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) });
  }

  // 這個檔案在 rev 之前的那一版（找不到回傳 null）。上傳後用來確認中間沒有夾著別台裝置存的版本。
  async previousRevision(id, rev) {
    const all = []; let pageToken;
    do {
      const params = new URLSearchParams({ fields: 'nextPageToken,revisions(id)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.json(`files/${encodeURIComponent(id)}/revisions?${params}`);
      all.push(...(page.revisions ?? []).map(r => r.id)); pageToken = page.nextPageToken;
    } while (pageToken && all.length < 10000);
    const at = all.indexOf(rev);
    return at > 0 ? all[at - 1] : null;
  }
  async revisionData(id, rev) {
    return (await this.api(`files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(rev)}?alt=media`, {}, 600000)).blob();
  }
  // 省略 id = 在 SnakeNote 資料夾建立新檔；有 id = 覆寫內容並同步檔名。用 resumable upload，大檔也能傳。
  async upload({ id, name, blob }) {
    const metadata = id ? { name } : { name, mimeType: 'application/zip', appProperties: { app: APP }, parents: [await this.folder()] };
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
