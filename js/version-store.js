import { db, snapshotWorkspace, commitHistory } from './db.js';
import { canonical, hash, ensure, HASH, MAX_BYTES, makeCommit, verifyCommit, resolveTree, validateWorkspace, compareWorkspaces } from './version-core.js';

export class HistoryStore {
  constructor(scope = 'local') { this.scope = scope; }
  async device() {
    await db.update('meta', 'history-device', value => value || crypto.randomUUID());
    return db.get('meta', 'history-device');
  }
  async head() { return (await db.get('meta', 'history:' + this.scope))?.head ?? null; }
  async read(id) {
    ensure(HASH.test(id));
    const row = await db.get('versions', this.scope + ':' + id);
    ensure(row?.scope === this.scope, '此帳號的版本尚未下載或版本遺失');
    return verifyCommit(row.commit);
  }
  async list() {
    return (await db.getAll('versions')).filter(row => row.scope === this.scope).map(row => row.commit).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async object(id) {
    ensure(HASH.test(id));
    const value = await db.get('objects', id);
    ensure(value?.data instanceof Blob && value.data.size <= MAX_BYTES && await hash(value.data) === id, '版本內容或圖片遺失／校驗失敗');
    return value;
  }
  async tree(id) { return resolveTree(id, key => this.read(key)); }
  async pack(snapshot) {
    const objects = new Map();
    let bytes = 0;
    const add = async (data, kind) => {
      const blob = kind === 'json' ? new Blob([canonical(data)], { type: 'application/json' }) : data;
      ensure(blob instanceof Blob && blob.size <= 20 * 1024 * 1024, '單一物件或圖片超過 20 MB');
      const id = await hash(blob);
      if (!objects.has(id)) { bytes += blob.size; ensure(bytes <= MAX_BYTES, '此版本超過 100 MB，請先減少大型圖片'); objects.set(id, { kind, data: blob }); }
      return id;
    };
    const tree = { pages: {}, docs: {} }, docs = [], blobs = new Map();
    const sourceDocs = new Map(snapshot.docs.map(doc => [doc.pageId, doc]));
    const blobHashes = new Map();
    for (const source of snapshot.pages) {
      const page = { id: source.id, parentId: source.parentId ?? null, title: source.title, order: source.order, open: source.open ?? true, created: source.created ?? 0 };
      tree.pages[page.id] = await add(page, 'json');
      const doc = sourceDocs.get(page.id) ?? { pageId: page.id, items: [], view: { x: 40, y: 40, s: 1 } };
      const items = [], references = [];
      for (const original of doc.items) {
        const item = structuredClone(original);
        if (item.type === 'image') {
          const blob = snapshot.blobs.get(item.blobId);
          ensure(blob instanceof Blob, '筆記有遺失的圖片，請先確認圖片能顯示');
          if (!blobHashes.has(item.blobId)) blobHashes.set(item.blobId, await add(blob, 'blob'));
          item.blobId = blobHashes.get(item.blobId); blobs.set(item.blobId, blob);
        }
        references.push(await add(item, 'json')); items.push(item);
      }
      tree.docs[page.id] = await add({ pageId: page.id, view: doc.view, items: references }, 'json');
      docs.push({ pageId: page.id, view: doc.view, items });
    }
    const workspace = { pages: snapshot.pages, docs, blobs };
    validateWorkspace(workspace);
    // CAS objects are immutable; an interrupted operation leaves only harmless,
    // unreferenced objects, never a published partial version.
    for (const [id, value] of objects) await db.put('objects', value, id);
    return { tree, workspace };
  }
  async materialize(id, loader = key => this.object(key)) {
    const tree = await this.tree(id);
    const objects = new Map(); let total = 0;
    const get = async (key, kind) => {
      ensure(HASH.test(key));
      if (!objects.has(key)) {
        const object = await loader(key);
        ensure(object?.data instanceof Blob && object.kind === kind && object.data.size <= 20 * 1024 * 1024 && await hash(object.data) === key, '內容校驗失敗');
        total += object.data.size; ensure(total <= MAX_BYTES, '版本超過 100 MB 限制');
        objects.set(key, object);
      }
      const object = objects.get(key); ensure(object.kind === kind);
      return kind === 'json' ? JSON.parse(await object.data.text()) : object.data;
    };
    const pages = [], docs = [], blobs = new Map();
    for (const [pageId, key] of Object.entries(tree.pages)) {
      const page = await get(key, 'json'); ensure(page.id === pageId); pages.push(page);
      const doc = await get(tree.docs[pageId], 'json'); ensure(doc.pageId === pageId && Array.isArray(doc.items) && doc.items.length <= 20000);
      const items = [];
      for (const itemKey of doc.items) {
        const item = await get(itemKey, 'json');
        if (item.type === 'image') blobs.set(item.blobId, await get(item.blobId, 'blob'));
        items.push(item);
      }
      docs.push({ ...doc, items });
    }
    const workspace = { pages, docs, blobs };
    validateWorkspace(workspace);
    return { workspace, objects, tree };
  }
  async create(message = '') {
    const parent = await this.head();
    const packed = await this.pack(await snapshotWorkspace());
    const previous = parent ? await this.read(parent) : null;
    const commit = await makeCommit({ tree: packed.tree, previousTree: parent ? await this.tree(parent) : undefined, parent, depth: previous ? previous.depth + 1 : 0, device: await this.device(), message });
    await commitHistory({ scope: this.scope, expectedHead: parent, records: [commit], head: commit.id });
    return commit;
  }
  async restore(id) {
    // Validate EVERY image and object before taking any destructive action.
    const target = await this.materialize(id);
    const parent = await this.head();
    const current = await snapshotWorkspace();
    const packed = await this.pack(current);
    const previous = parent ? await this.read(parent) : null;
    const device = await this.device();
    const backup = await makeCommit({ tree: packed.tree, previousTree: parent ? await this.tree(parent) : undefined, parent, depth: previous ? previous.depth + 1 : 0, device, message: '還原前的自動保護版本' });
    const restored = await makeCommit({ tree: target.tree, previousTree: packed.tree, parent: backup.id, depth: backup.depth + 1, device, message: '還原至 ' + id.slice(0, 8), restoredFrom: id });
    await commitHistory({ scope: this.scope, expectedHead: parent, records: [backup, restored], head: restored.id, restore: target.workspace, expectedRevision: current.revision });
    return restored;
  }
  async compare(id) {
    const commit = await this.read(id);
    const current = (await this.materialize(id)).workspace;
    const before = commit.parent ? (await this.materialize(commit.parent)).workspace : { pages: [], docs: [], blobs: new Map() };
    return { changes: compareWorkspaces(before, current), before, after: current };
  }
}
