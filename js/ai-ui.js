import { uid } from './db.js';
import { exportRegion, copyText, buildPrompt, parseReply, toItems, replyItems, placeItems, itemsBox, summarize } from './ai-core.js';

const $ = selector => document.querySelector(selector);

// AI 協作：框選一塊（或整頁）→ 複製給 ChatGPT／Claude → 貼回 AI 的回覆 → 點畫布放上新元件。
// 原本的內容不會被改動，新元件放在旁邊就能對照。右鍵／Ctrl+C 複製物件、Ctrl+V 貼上也在這裡。
export function setupAi({ board, title, toast, showMenu }) {
  const dialog = $('#ai-dialog');
  const reply = $('#ai-reply');
  const preview = $('#ai-preview');
  const ghost = $('#ai-ghost');
  let scope = null;     // 要交給 AI 的物件 id（Set）；null＝整頁
  let size = 18;        // AI 沒給字級時用的字級：匯出範圍裡最常見的字級
  let pending = null;   // 驗證過、還沒放上畫布的元件（區域座標）

  const scoped = () => scope ? board.items.filter(it => scope.has(it.id)) : board.items;

  function open(ids = null) {
    board.commitText();
    scope = ids?.length ? new Set(ids) : null;
    $('#ai-heading').textContent = scope ? `AI 分析選取的 ${scope.size} 個物件` : 'AI 分析這一頁';
    check();
    dialog.showModal();
  }

  // 有選取就只給選取的部分，沒有就整頁
  $('#ai-button').addEventListener('click', () => open([...board.sel]));
  $('#ai-close').addEventListener('click', () => dialog.close());

  $('#ai-copy').addEventListener('click', async () => {
    board.commitText();
    const items = scoped();
    if (!items.length) { toast(scope ? '選取的物件已經不在這頁了' : '這頁還沒有內容'); return; }
    const exported = exportRegion({ title: title(), items, area: board.exportArea(scope), selected: !!scope });
    const sizes = items.filter(it => it.type === 'text').map(it => it.size);
    if (sizes.length) size = mostCommon(sizes);
    try {
      await navigator.clipboard.writeText(buildPrompt(exported, $('#ai-request').value));
      toast(items.some(it => it.type !== 'text') ? '已複製。有手寫或圖片的話，再附上截圖給 AI' : '已複製，貼給 AI 吧');
    } catch {
      toast('無法存取剪貼簿，請改用 https 或 localhost 開啟');
    }
  });

  $('#ai-shot').addEventListener('click', async () => {
    const area = board.exportArea(scope);
    if (!area) { toast('這頁還沒有內容'); return; }
    const png = board.toPNG(area, { ids: scope });
    try {
      // Safari 要求在點擊當下呼叫 write，所以傳 Promise 進去
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast('已複製截圖，貼到 AI 的對話框');
    } catch {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await png);
      a.download = (title() || '筆記') + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('瀏覽器不能複製圖片，改成下載截圖');
    }
  });

  // 貼上就先驗證一次，讓使用者看到會放上什麼
  function check() {
    pending = null;
    preview.replaceChildren();
    $('#ai-insert').disabled = true;
    if (!reply.value.trim()) return;
    try {
      const items = toItems(parseReply(reply.value), { defaultSize: size });
      const { counts, lines } = summarize(items);
      const head = document.createElement('p');
      head.className = 'ai-counts';
      head.textContent = counts + (board.readOnly ? '。這頁是唯讀，不能放上去' : '');
      const list = document.createElement('ul');
      for (const line of lines.slice(0, 50)) list.append(Object.assign(document.createElement('li'), { textContent: line }));
      if (lines.length > 50) list.append(Object.assign(document.createElement('li'), { textContent: `…還有 ${lines.length - 50} 項` }));
      preview.append(head, list);
      pending = items;
      $('#ai-insert').disabled = board.readOnly;
    } catch (error) {
      preview.append(Object.assign(document.createElement('p'), { className: 'ai-error', textContent: error.message }));
    }
  }
  reply.addEventListener('input', check);

  // 關掉對話框，等使用者點畫布決定位置。回覆留著，可以再放一份
  $('#ai-insert').addEventListener('click', () => {
    if (!pending || board.readOnly) return;
    dialog.close();
    place(pending);
  });

  async function place(items) {
    const box = itemsBox(items);
    toast('點一下畫布，放在那裡（Esc 取消）');
    ghost.dataset.w = box.w;
    ghost.dataset.h = box.h;
    const at = await board.pickPoint();
    ghost.hidden = true;
    if (at) insert(items, at);
  }

  async function insert(items, at) {
    if (board.readOnly) return;
    // 圖片只帶 blob id：這台裝置（或協作伺服器）找不到圖檔就略過
    const found = await Promise.all(items.map(it => it.type !== 'image' || board.hasBlob(it.blobId)));
    const kept = items.filter((_, i) => found[i]), skipped = items.length - kept.length;
    if (!kept.length) { toast('找不到圖片檔，無法貼上'); return; }
    // 每次放都換新 id，同一份內容可以放好幾次
    board.insertItems(placeItems(kept.map(it => ({ ...it, id: uid() })), at));
    toast(`已放上 ${kept.length} 個物件` + (skipped ? `（${skipped} 張圖片找不到，略過）` : '') + '，可以按復原還原');
  }

  // 放置預覽框跟著游標，大小是粗估的外框
  $('#viewport').addEventListener('pointermove', e => {
    if (!board.picking) return;
    const s = board.view.s;
    Object.assign(ghost.style, {
      left: e.clientX + 'px', top: e.clientY + 'px',
      width: Math.max(8, ghost.dataset.w * s) + 'px', height: Math.max(8, ghost.dataset.h * s) + 'px',
    });
    ghost.hidden = false;
  });
  $('#viewport').addEventListener('pointerleave', () => { ghost.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !board.picking) return;
    board.cancelPick();
    toast('已取消');
  });

  // 右鍵：選取框裡或點到物件＝複製這些物件（點到未選取的物件會先選它）；空白處＝複製全部。
  // 複製的是 {"items":[…]} JSON，可以 Ctrl+V 貼到別頁，也可以直接貼給 AI
  $('#viewport').addEventListener('contextmenu', e => {
    if (e.target.isContentEditable || board.picking) return;
    const { clientX: x, clientY: y } = e;
    let ids = board.selectionHas(x, y) ? [...board.sel] : null;
    if (!ids && (board.tool === 'select' || board.tool === 'lasso')) {
      const hit = board.itemAt(x, y);
      board.setSelection(hit ? [hit.id] : []);
      if (hit) ids = [hit.id];
    }
    if (!ids && !board.items.length) return;
    showMenu({ left: x, right: x, top: y, bottom: y }, [ids
      ? { label: `複製（${ids.length} 個物件）`, run: () => copy(ids) }
      : { label: '複製全部', run: () => copy(null) }]);
  });

  // Ctrl+C：有選取物件、而且不是在打字時，複製物件
  document.addEventListener('copy', e => {
    const a = document.activeElement;
    if (!board.sel.size || a?.isContentEditable || a?.matches?.('input, textarea') || $('dialog[open]')) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', copied([...board.sel]));
    toast(`已複製 ${board.sel.size} 個物件`);
  });

  function copied(ids) {
    board.commitText();
    const set = ids && new Set(ids);
    const items = set ? board.items.filter(it => set.has(it.id)) : board.items;
    return copyText(items, board.exportArea(set));
  }

  async function copy(ids) {
    const text = copied(ids);
    try {
      await navigator.clipboard.writeText(text);
      toast(ids ? `已複製 ${ids.length} 個物件，可以貼到別頁或貼給 AI` : '已複製全部，可以貼到別頁或貼給 AI');
    } catch {
      toast('無法存取剪貼簿，請改用 https 或 localhost 開啟');
    }
  }

  // 一般的貼上（Ctrl+V）認得複製的物件和 AI 回覆：是的話放在游標位置，回傳 true
  function paste(text, at) {
    const items = replyItems(text, { defaultSize: size });
    if (!items) return false;
    insert(items, at);
    return true;
  }

  return { open, paste };
}

const mostCommon = values => {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
};
