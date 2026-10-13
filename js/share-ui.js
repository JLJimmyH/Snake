// 共用頁（像 draw.io 用 Google Drive 共用）：共用一頁＝把那一頁另存成 Drive 上的一個檔案（SnakeNote/共用頁面），
// 誰能看、誰能改都用 Drive 的共用設定（email 邀請由 Google 寄出）。即時協作見 js/collaboration.js。
//   sharePage(pageId)：共用視窗（還沒共用就先建立檔案）；shareCurrent()：頂列「共用」按鈕，目前開著的這一頁
//   openShared(file)：打開共用頁；別人共用來的要先在 Google 檔案選擇器選一次，app 才能開
//   list()：側欄「共用頁面」清單的資料；pickOther()：在檔案選擇器選別人共用給我的頁面
//   drivePage：{ load(file), save(file, content) }，房間用來從 Drive 載入初始內容、寫回 Drive
import { db } from './db.js';
import { packNotebook, readZip, fileName, nameFromFile } from './notebook-core.js';
import { pickPage, pickerReady } from './picker.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const ROLE = { writer: '編輯者', reader: '檢視者' };
const PAGE = 'page';  // 共用頁檔案裡那一頁的 ID
const linkTo = file => `${location.origin}${location.pathname}?page=${encodeURIComponent(file)}`;

// drive：DriveClient；withDrive(task, intent)：確定連上 Google 再做（必要時跳去授權）；run(task)：一次只做一件事並顯示錯誤；
// onChanged()：共用的狀態變了（開始、停止、邀請），側欄清單要重新讀
export function setupShare({ drive, withDrive, run, toast, switchTo, onChanged }) {
  const dialog = $('#share-dialog');
  // main.js 準備好即時協作後才有：{ open(page, items), linkShared(id, file), current()（筆記本裡目前這頁）, openLocal(id),
  //   page()（開著的共用頁）, leave()（離開別人共用的頁面）}
  let live = null;
  let waiting = null; // 從 Google 授權回來時即時協作還沒準備好：等 liveReady 再做
  const owners = new Map(); // 共用頁檔案 → 共用給我的人（清單讀過才知道）

  // 一頁 → 一頁的筆記本 zip（共用頁檔案的格式）
  async function packPage(title, items, blob) {
    const blobs = new Map();
    for (const item of items) if (item.type === 'image' && !blobs.has(item.blobId)) {
      const data = await blob(item.blobId);
      if (!data) throw new Error('有圖片還沒下載完成，稍後再試');
      blobs.set(item.blobId, data);
    }
    return packNotebook({ name: title, pages: [{ id: PAGE, parentId: null, title, order: 0, open: true, created: Date.now() }], docs: [{ pageId: PAGE, view: { x: 40, y: 40, s: 1 }, items }], blobs });
  }

  const drivePage = {
    // 房間是空的時候，從 Drive 上的檔案載入；圖片先放進這一頁的圖片快取，之後上傳到房間
    async load(file) {
      const { data } = await drive.download(file);
      const content = await readZip(data);
      for (const [id, blob] of content.blobs) await db.put('blobs', blob, `live-blob:${file}:${id}`);
      return { title: content.pages[0]?.title ?? '', items: content.docs[0]?.items ?? [] };
    },
    async save(file, { name, title, items, blob }) {
      if (!drive.connected) return;
      await drive.upload({ id: file, name: name || fileName(title), blob: await packPage(title, items, blob) });
    },
  };

  // ---------- 共用視窗 ----------
  function sharePage(pageId) {
    withDrive(async () => {
      const page = await db.get('pages', pageId);
      if (!page) return;
      if (page.shared) { await showPanel({ file: page.shared, title: page.title || '未命名', pageId }); return; }
      showIntro(page);
    }, 'share:' + pageId);
  }

  // 還沒共用：說明會在 Drive 建立一個檔案
  function showIntro(page) {
    const title = page.title || '未命名';
    const start = el('button', '開始共用', 'collab-primary');
    start.addEventListener('click', () => run(async () => {
      const doc = await db.get('docs', page.id);
      const items = doc?.items ?? [];
      toast('正在建立共用檔案…');
      const file = await drive.createPage({ name: fileName(title), blob: await packPage(title, items, id => db.get('blobs', id)) });
      await live.linkShared(page.id, file.id);
      onChanged();
      await showPanel({ file: file.id, title, pageId: page.id });
    }));
    render(`共用「${title}」`, [
      el('p', '共用這一頁會在你的 Google Drive「SnakeNote／共用頁面」建立一個檔案，再用 Drive 的共用設定邀請其他人。被邀請的人用自己的 Google 帳號登入，就能一起即時編輯，看得到彼此的游標。'),
      el('p', '只會共用這一頁，不包含子頁面與筆記本裡的其他頁面。', 'drive-muted'),
      actions(start),
    ]);
  }

  async function showPanel(target) {
    render(`共用「${target.title}」`, [el('p', '讀取共用設定…', 'drive-muted')]);
    let permissions;
    try { permissions = await drive.permissions(target.file); }
    catch (error) {
      // 不是擁有者（或沒有管理權）：只能複製連結
      render(`共用「${target.title}」`, [el('p', error.status === 403 ? '只有擁有者可以變更共用設定。' : error.message, 'drive-muted'), actions(copyButton(target.file), doneButton())]);
      return;
    }
    const me = drive.account?.id;
    // 邀請：email＋權限
    const form = el('form', undefined, 'share-invite');
    const email = el('input'); email.type = 'email'; email.required = true; email.placeholder = '新增使用者（輸入 email）'; email.autocomplete = 'email';
    const role = roleSelect('writer');
    const send = el('button', '傳送', 'collab-primary'); send.type = 'submit';
    form.append(email, role, send);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const address = email.value.trim().toLowerCase();
      run(async () => {
        await drive.share(target.file, { email: address, role: role.value, message: `${drive.account.email} 邀請你在 Snake Note 一起${role.value === 'writer' ? '編輯' : '查看'}「${target.title}」：${linkTo(target.file)}` });
        toast(`已邀請 ${address}，Google 會寄信通知對方`);
        onChanged();
        await showPanel(target);
      });
    });
    // 具有存取權的使用者
    const people = el('div', undefined, 'share-people');
    const users = permissions.filter(p => p.type === 'user').sort((a, b) => (b.role === 'owner') - (a.role === 'owner'));
    for (const person of users) {
      const row = el('div', undefined, 'share-person');
      const who = el('div');
      who.append(el('strong', (person.displayName || person.emailAddress) + (person.id === me ? '（你）' : '')), el('small', person.emailAddress ?? ''));
      row.append(who);
      if (person.role === 'owner') row.append(el('span', '擁有者', 'drive-muted'));
      else {
        const select = roleSelect(person.role === 'writer' ? 'writer' : 'reader', true);
        select.addEventListener('change', () => run(async () => {
          if (select.value === 'remove') await drive.unshare(target.file, person.id);
          else await drive.setRole(target.file, person.id, select.value);
          onChanged();
          await showPanel(target);
        }));
        row.append(select);
      }
      people.append(row);
    }
    // 一般存取權：限制／知道連結的任何人（對方仍要用 Google 帳號登入）
    const anyone = permissions.find(p => p.type === 'anyone');
    const general = el('div', undefined, 'share-general');
    const scope = el('select');
    scope.append(new Option('限制：只有上面的人可以開啟', 'restricted'), new Option('知道連結的任何人（需登入 Google）', 'anyone'));
    scope.value = anyone ? 'anyone' : 'restricted';
    const anyoneRole = roleSelect(anyone?.role === 'writer' ? 'writer' : 'reader');
    anyoneRole.hidden = !anyone;
    const apply = () => run(async () => {
      if (anyone) await drive.unshare(target.file, anyone.id);
      if (scope.value === 'anyone') await drive.share(target.file, { role: anyoneRole.value });
      onChanged();
      await showPanel(target);
    });
    scope.addEventListener('change', apply);
    anyoneRole.addEventListener('change', apply);
    general.append(scope, anyoneRole);
    // 停止共用：移除所有人的存取權，Drive 上的共用檔案移到垃圾桶（內容還在筆記本的這一頁），這一頁變回一般頁面。
    // 不留著檔案：留著的話清單上會一直有一個已經沒人能開、也不會再更新的「我共用的」頁面
    const stop = el('button', '停止共用這一頁', 'link-btn');
    stop.addEventListener('click', () => {
      const keep = target.pageId ? '這一頁變回只在你筆記本裡的一般頁面，' : '';
      if (!confirm(`會移除其他人對「${target.title}」的存取權，${keep}Drive 上的共用檔案移到垃圾桶（30 天內可以在 Drive 還原）。\n\n確定要停止共用嗎？`)) return;
      run(async () => {
        for (const p of permissions) if (p.role !== 'owner') await drive.unshare(target.file, p.id);
        // 清掉 Cloudflare 房間裡的即時內容與圖片
        await fetch(new URL('api/shared/' + encodeURIComponent(target.file), document.baseURI), { method: 'DELETE', headers: { 'X-Requested-With': 'snake-note' } }).catch(() => {});
        if (target.pageId) await live.linkShared(target.pageId, null);
        // 開著的就是這個共用頁（不在筆記本裡）：先離開
        else if (live.page()?.file === target.file) await live.leave();
        await drive.trash(target.file);
        dialog.close();
        onChanged();
        toast(`已停止共用「${target.title}」`);
      });
    });
    render(`共用「${target.title}」`, [
      form,
      el('h3', '具有存取權的使用者'), people,
      el('h3', '一般存取權'), general,
      actions(copyButton(target.file), doneButton()),
      el('p', undefined, 'share-foot'),
    ]);
    dialog.querySelector('.share-foot').append(stop);
    email.focus();
  }

  function roleSelect(value, removable = false) {
    const select = el('select');
    select.append(new Option(ROLE.writer, 'writer'), new Option(ROLE.reader, 'reader'));
    if (removable) select.append(new Option('移除存取權', 'remove'));
    select.value = value;
    return select;
  }
  function copyButton(file) {
    const button = el('button', '🔗 複製連結', 'chip');
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(linkTo(file)); toast('已複製連結；對方要有存取權才能開啟'); }
      catch { prompt('複製這個連結', linkTo(file)); }
    });
    return button;
  }
  function doneButton() {
    const button = el('button', '完成', 'collab-primary');
    button.addEventListener('click', () => dialog.close());
    return button;
  }
  const actions = (...buttons) => { const row = el('div', undefined, 'sync-actions share-actions'); row.append(...buttons); return row; };
  function render(title, children) {
    $('#share-heading').textContent = title;
    $('#share-body').replaceChildren(...children);
    if (!dialog.open) dialog.showModal();
  }

  // ---------- 打開共用頁 ----------
  // 自己筆記本裡有這一頁就切過去；不然就當成別人共用來的頁面打開（不加進筆記本）
  async function openShared(file) {
    const page = (await db.getAll('pages')).find(p => p.shared === file);
    if (page) {
      await switchTo(page.notebookId);
      if (live.current() !== page.id) await live.openLocal?.(page.id);
      return;
    }
    try { await live.open({ file, title: null, local: null }); }
    catch (error) {
      // 在 run() 裡面不能再開另一個動作，等這個結束再連線 Google
      if (error.code === 'signin') { setTimeout(() => withDrive(() => openShared(file), 'page:' + file)); return; }
      if (error.code === 'access') { askAccess(file); return; }
      toast(error.message);
    }
  }

  // 別人共用來、還沒在這個 app 開過的頁面：用 Google 檔案選擇器選一次
  function askAccess(file) {
    const pick = el('button', '選取並開啟', 'collab-primary');
    pick.addEventListener('click', () => run(async () => {
      const picked = await pickPage(await drive.fresh(), file);
      if (!picked) return;
      dialog.close();
      onChanged();
      await openShared(picked.id);
    }));
    render('開啟共用頁面', [
      el('p', '這是別人透過 Google Drive 共用給你的頁面。第一次開啟時，請在接下來的 Google 視窗選取它，允許 Snake Note 開啟這個檔案。'),
      el('p', pickerReady() ? '如果清單裡沒有，代表這個 Google 帳號沒有存取權，請向共用的人確認 email。' : '網站尚未設定 Google 檔案選擇器，暫時無法開啟別人共用的頁面。', 'drive-muted'),
      actions(pick),
    ]);
    pick.disabled = !pickerReady();
  }

  // 頂列「共用」：筆記本裡的這一頁，或開著的共用頁（別人共用來的、或已經不在筆記本裡的）
  function shareCurrent() {
    const page = live?.page();
    if (page && !page.local) {
      withDrive(() => showPanel({ file: page.file, title: page.title || '共用頁面', pageId: null }), 'sharefile:' + page.file);
      return;
    }
    const id = live?.current();
    if (id) sharePage(id);
  }

  // 側欄「共用頁面」清單：自己共用出去的，加上別人共用、在選擇器選過的。
  // 回傳 [{ id, name, mine, owner, canEdit, people（自己的才有：共用給幾個人）, anyone（知道連結的人都能開）, modified }]
  async function list() {
    const files = await drive.pages();
    return files.map(file => {
      const owner = file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || '別人';
      if (!file.ownedByMe) owners.set(file.id, owner);
      const others = (file.permissions ?? []).filter(p => p.role !== 'owner');
      return {
        id: file.id, name: nameFromFile(file.name), mine: !!file.ownedByMe, owner, canEdit: file.capabilities?.canEdit !== false,
        people: file.permissions ? others.filter(p => p.type !== 'anyone').length : null, anyone: others.some(p => p.type === 'anyone'),
        modified: file.modifiedTime,
      };
    });
  }

  // 別人共用給我、還沒在這個 app 開過的頁面：在 Google 檔案選擇器選一次
  function pickOther() {
    if (!pickerReady()) { toast('網站尚未設定 Google 檔案選擇器，暫時無法開啟別人共用的頁面'); return; }
    withDrive(async () => {
      const picked = await pickPage(await drive.fresh());
      if (!picked) return;
      onChanged();
      await openShared(picked.id);
    }, 'pick');
  }

  $('#share-close').addEventListener('click', () => dialog.close());

  // main.js 的即時協作準備好了；網址帶 ?page= 就打開那個共用頁
  function liveReady(handle) {
    live = handle;
    const file = new URLSearchParams(location.search).get('page');
    if (file) {
      history.replaceState(null, '', location.pathname + location.hash);
      run(() => openShared(file));
    }
    if (waiting) { resume(waiting); waiting = null; }
  }

  // 從 Google 授權回來後接著做
  function resume(intent) {
    if (!live) { waiting = intent; return; }
    if (intent === 'pick') pickOther();
    else if (intent?.startsWith('page:')) run(() => openShared(intent.slice(5)));
    else if (intent?.startsWith('share:')) sharePage(intent.slice(6));
    else if (intent?.startsWith('sharefile:')) shareCurrent();
  }

  return {
    sharePage, shareCurrent, openShared, pickOther, list, drivePage, liveReady, resume, ready: () => !!live,
    owner: file => owners.get(file) ?? null, active: () => live?.page()?.file ?? null,
  };
}
