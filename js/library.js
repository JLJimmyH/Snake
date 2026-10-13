// 側欄上層（點頂部的筆記本名稱進來）：我的筆記本（這台的，加上 Drive 上還沒在這台開過的，同一份清單用狀態區分）、共用頁面
// （我共用的、共用給我的），以及側欄底部的 Google 帳號列。Drive 的清單只在這個分頁打開時讀，最多 30 秒讀一次。
// notebooks：{ list(), current(), describe(nb)（{ text, warn }）, open(id), openCloud(file), more(rect, id), create(), openLocal(), localLabel, resuming() }
// shares：{ ready(), list(), open(file), pick(), active(), linked()（這台筆記本裡連到的共用檔案）, more(rect, file, title) }；showPages()：切回頁面分頁；connect()／disconnect()：Google 連線
import { nameFromFile } from './notebook-core.js';

const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const STALE = 30000;
const when = time => new Date(time).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

export function setupLibrary({ drive, notebooks, shares, showPages, connect, disconnect, showMenu, toast, onCloud }) {
  const pane = $('#library-pane'), box = $('#library'), account = $('#account');
  let files = null;   // Drive 上的筆記本（drive.list()）
  let pages = null;   // 共用頁面（shares.list()）
  let error = '';
  let loading = null;
  let at = 0, readFor = null; // 上次讀清單的時間、帳號

  const shown = () => !pane.hidden;

  // 讀 Drive 上的筆記本與共用頁面。force：不管多久前讀過
  function refresh(force = false) {
    if (!drive.connected) {
      if (files || pages || error) { files = pages = null; error = ''; onCloud(); }
      render();
      return Promise.resolve();
    }
    if (loading) return loading;
    // 剛載入時即時協作還沒準備好，共用頁面沒讀到：準備好之後要再讀一次
    if (!force && readFor === drive.account.id && Date.now() - at < STALE && (pages || !shares.ready())) { render(); return Promise.resolve(); }
    if (readFor !== drive.account.id) { files = pages = null; }
    render();
    loading = (async () => {
      try {
        [files, pages] = await Promise.all([drive.list(), shares.ready() ? shares.list() : null]);
        error = '';
      } catch (failure) { error = failure.message || 'Drive 清單讀取失敗'; }
      at = Date.now(); readFor = drive.account?.id ?? null; loading = null;
      render(); onCloud();
    })();
    return loading;
  }

  function row({ icon, name, status, warn, active, data, more }) {
    const node = el('div', undefined, 'lib-row' + (active ? ' active' : ''));
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    Object.assign(node.dataset, data);
    const text = el('span', undefined, 'lib-text');
    text.append(el('span', name, 'lib-name'), el('span', status, 'lib-status' + (warn ? ' warn' : '')));
    node.append(el('span', icon, 'lib-icon'), text);
    if (more) { const button = el('button', '⋯', 'row-btn'); button.dataset.act = 'more'; button.title = '更多'; button.setAttribute('aria-label', '更多動作'); node.append(button); }
    return node;
  }

  const head = text => el('div', text, 'lib-head');

  async function render() {
    renderAccount();
    if (!shown()) return;
    const list = await notebooks.list();
    const current = notebooks.current();
    const nodes = [head('我的筆記本')];
    for (const nb of list) {
      const { text, warn } = notebooks.describe(nb);
      nodes.push(row({ icon: '📒', name: nb.name, status: text, warn, active: nb.id === current, data: { notebook: nb.id }, more: true }));
    }
    // Drive 上有、這台還沒開過的
    if (drive.connected && files) {
      const open = new Set(list.filter(nb => nb.drive?.accountId === drive.account.id).map(nb => nb.drive.fileId));
      for (const file of files) if (!open.has(file.id)) {
        nodes.push(row({ icon: '☁', name: nameFromFile(file.name), status: `在 Drive 上 · ${when(file.modifiedTime)} · ${size(Number(file.size ?? 0))}`, data: { file: file.id } }));
      }
    }
    // 沒連線時清單上不放連線按鈕：底部帳號列就有「連線 Google Drive」
    if (drive.connected && error) {
      const note = el('p', '⚠ ' + error + ' ', 'lib-muted lib-error');
      const retry = el('button', '重試', 'link-btn lib-retry');
      note.append(retry);
      nodes.push(note);
    } else if (drive.connected && !files) nodes.push(el('p', '讀取中…', 'lib-muted'));
    nodes.push(el('button', '📂 ' + notebooks.localLabel, 'lib-link lib-local'));

    if (shares.ready()) {
      nodes.push(head('共用頁面'));
      const active = shares.active();
      if (!drive.connected) nodes.push(el('p', '連線 Google 後顯示', 'lib-muted'));
      else if (pages) {
        const mine = pages.filter(p => p.mine), theirs = pages.filter(p => !p.mine), linked = await shares.linked();
        if (!pages.length) nodes.push(el('p', '還沒有', 'lib-muted'));
        if (mine.length) nodes.push(el('div', '我共用的', 'lib-sub'));
        for (const page of mine) {
          const people = page.people ? `${page.people} 人可以存取` : page.people === 0 && !page.anyone ? '還沒共用給任何人' : '';
          // 頁面刪掉了（或在別台的筆記本裡）：標出來，⋯ 可以直接停止共用
          const orphan = !linked.has(page.id);
          const status = [orphan && '這台沒有這一頁', people, page.anyone && '有連結就能開'].filter(Boolean).join(' · ') || '你共用的';
          nodes.push(row({ icon: '👥', name: page.name, status, warn: orphan, active: page.id === active, data: { shared: page.id }, more: orphan }));
        }
        if (theirs.length) nodes.push(el('div', '共用給我的', 'lib-sub'));
        for (const page of theirs) {
          nodes.push(row({ icon: '👤', name: page.name, status: `${page.owner} · ${page.canEdit ? '可編輯' : '只能檢視'}`, active: page.id === active, data: { shared: page.id } }));
        }
      } else if (!error) nodes.push(el('p', '讀取中…', 'lib-muted'));
      nodes.push(el('button', '＋ 開啟別人共用的頁面…', 'lib-link lib-pick'));
    }
    // 同步狀態一直在變，清單常常重畫：內容一樣就不換，免得正要點的那一列被換掉
    const next = el('div');
    next.append(...nodes);
    if (next.innerHTML !== box.innerHTML) box.replaceChildren(...next.childNodes);
  }

  // 側欄底部：Google 帳號
  function renderAccount() {
    if (notebooks.resuming() && !drive.connected) { account.hidden = false; account.replaceChildren(el('span', '正在連線 Google…', 'lib-muted')); return; }
    account.hidden = false;
    if (!drive.connected) {
      const button = el('button', '☁ 連線 Google Drive', 'acct-connect');
      button.addEventListener('click', connect);
      const privacy = el('a', '隱私權政策', 'acct-privacy');
      privacy.href = 'privacy.html'; privacy.target = '_blank'; privacy.rel = 'noopener';
      account.replaceChildren(button, privacy);
      return;
    }
    const email = drive.account.email;
    const button = el('button', undefined, 'acct-btn');
    button.title = `${email}：點一下管理 Google 連線`;
    const text = el('span', undefined, 'acct-text');
    text.append(el('span', email, 'acct-email'), el('small', 'Google Drive 已連線'));
    button.append(el('span', [...email][0].toUpperCase(), 'acct-avatar'), text);
    button.addEventListener('click', () => showMenu(button.getBoundingClientRect(), [
      { head: email },
      { label: '⟳ 重新整理雲端清單', run: () => refresh(true).then(() => toast('已重新讀取 Drive 上的筆記本與共用頁面')) },
      { label: '↗ 隱私權政策', run: () => window.open('privacy.html', '_blank', 'noopener') },
      { sep: true },
      { label: '中斷 Google 連線', run: disconnect },
    ]));
    account.replaceChildren(button);
  }

  // ---------- 事件 ----------
  box.addEventListener('click', event => {
    const target = event.target;
    if (target.closest('.lib-retry')) { refresh(true); return; }
    if (target.closest('.lib-local')) { notebooks.openLocal(); return; }
    if (target.closest('.lib-pick')) { shares.pick(); return; }
    const node = target.closest('.lib-row');
    if (!node) return;
    const { notebook, file, shared } = node.dataset;
    const more = target.closest('[data-act=more]')?.getBoundingClientRect();
    if (more && notebook) { notebooks.more(more, notebook); return; }
    if (more && shared) { shares.more(more, shared, node.querySelector('.lib-name').textContent); return; }
    if (notebook) { notebooks.open(notebook).then(showPages); return; }
    if (file) { notebooks.openCloud(files.find(f => f.id === file)).then(showPages); return; }
    if (shared) shares.open(shared);
  });
  $('#lib-new').addEventListener('click', () => notebooks.create());
  box.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('lib-row')) { event.preventDefault(); event.target.click(); }
  });

  return {
    render,
    refresh,
    // 分頁打開：畫一次，清單太舊就重讀
    shown: () => refresh(),
    // 共用頁檔案 → 共用給幾個人（清單還沒讀過是 null），頁面樹的 👥 旁邊顯示
    people: file => pages?.find(p => p.id === file)?.people ?? null,
  };
}
