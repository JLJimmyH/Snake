import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class DemoStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async data() {
    try { return JSON.parse(await readFile(join(this.directory, 'demo.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { pages: [], updates: {} }; throw error; }
  }
  mutate(fn) {
    const run = this.queue.then(async () => {
      const data = await this.data();
      const result = fn(data);
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, 'demo.json.tmp');
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, join(this.directory, 'demo.json'));
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  role(page, user) {
    return page.owner_id === user.id ? 'owner' : page.members[user.email] ?? null;
  }
  async list(user) { return (await this.data()).pages.filter(p => this.role(p, user)).map(p => ({ ...p, role: this.role(p, user), members: undefined })); }
  async access(id, user, edit = false, owner = false) {
    const page = (await this.data()).pages.find(p => p.id === id);
    const role = page && this.role(page, user);
    if (!role || (edit && role === 'viewer') || (owner && role !== 'owner')) throw new HttpError(403, '沒有此頁面的存取權');
    return { ...page, role };
  }
  create(user, title) {
    return this.mutate(data => {
      const page = { id: randomUUID(), owner_id: user.id, title, members: {}, created_at: new Date().toISOString() };
      data.pages.push(page); data.updates[page.id] = [];
      return { ...page, role: 'owner' };
    });
  }
  async invite(id, user, email, role) {
    await this.access(id, user, false, true);
    return this.mutate(data => { data.pages.find(p => p.id === id).members[email] = role; });
  }
  async updates(id, user) { await this.access(id, user); return (await this.data()).updates[id] ?? []; }
  async append(id, user, update) {
    await this.access(id, user, true);
    return this.mutate(data => { data.updates[id].push(update); });
  }
  async putBlob(id, key, user, bytes, type) {
    await this.access(id, user, true);
    await mkdir(join(this.directory, id), { recursive: true });
    await writeFile(join(this.directory, id, key), bytes);
    await writeFile(join(this.directory, id, key + '.type'), type);
  }
  async getBlob(id, key, user) {
    await this.access(id, user);
    try { return { bytes: await readFile(join(this.directory, id, key)), type: await readFile(join(this.directory, id, key + '.type'), 'utf8') }; }
    catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '找不到圖片'); throw error; }
  }
}

// All requests use the caller's JWT; no service-role key or RLS bypass.
export class SupabaseStore {
  constructor(url, key) { this.url = url.replace(/\/$/, ''); this.key = key; }
  async request(path, user, options = {}) {
    const response = await fetch(this.url + path, { ...options, headers: { apikey: this.key, Authorization: `Bearer ${user.token}`, ...options.headers } });
    if (!response.ok) throw new HttpError(response.status >= 500 ? 503 : 403, '雲端存取失敗，請確認登入與頁面權限');
    return response;
  }
  async list(user) {
    const pages = await (await this.request('/rest/v1/collab_pages?select=*', user)).json();
    return Promise.all(pages.map(async page => ({ ...page, role: page.owner_id === user.id ? 'owner' : (await this.access(page.id, user)).role })));
  }
  async access(id, user, edit = false, owner = false) {
    const rows = await (await this.request(`/rest/v1/collab_pages?id=eq.${id}&select=*`, user)).json();
    const page = rows[0];
    if (!page) throw new HttpError(403, '沒有此頁面的存取權');
    let role = 'owner';
    if (page.owner_id !== user.id) {
      const members = await (await this.request(`/rest/v1/collab_members?page_id=eq.${id}&email=eq.${encodeURIComponent(user.email)}&select=role`, user)).json();
      role = members[0]?.role;
    }
    if (!role || (edit && role === 'viewer') || (owner && role !== 'owner')) throw new HttpError(403, '沒有此頁面的編輯權');
    return { ...page, role };
  }
  async create(user, title) {
    const response = await this.request('/rest/v1/collab_pages', user, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: user.id, title }) });
    return { ...(await response.json())[0], role: 'owner' };
  }
  async invite(id, user, email, role) {
    await this.access(id, user, false, true);
    await this.request('/rest/v1/collab_members?on_conflict=page_id,email', user, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ page_id: id, email, role }) });
  }
  async updates(id, user) {
    await this.access(id, user);
    const updates = [];
    for (let offset = 0; ; offset += 500) {
      const rows = await (await this.request(`/rest/v1/collab_updates?page_id=eq.${id}&select=data&order=id.asc&limit=500&offset=${offset}`, user)).json();
      updates.push(...rows.map(row => row.data));
      if (rows.length < 500) return updates;
    }
  }
  async append(id, user, update) {
    await this.request('/rest/v1/collab_updates', user, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: id, data: update }) });
  }
  async putBlob(id, key, user, bytes, type) {
    await this.request(`/storage/v1/object/note-images/${id}/${key}`, user, { method: 'POST', headers: { 'Content-Type': type, 'x-upsert': 'true' }, body: bytes });
  }
  async getBlob(id, key, user) {
    const response = await this.request(`/storage/v1/object/authenticated/note-images/${id}/${key}`, user);
    return { bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('Content-Type') };
  }
}
