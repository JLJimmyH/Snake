import { uid } from './db.js';
import { exportRegion, buildPrompt, parseReply, toItems, replyItems, placeItems, itemsBox, summarize } from './ai-core.js';

const $ = selector => document.querySelector(selector);

// AI 協作：框選一塊（或整頁）→ 複製給 ChatGPT／Claude → 貼回 AI 的回覆 → 點畫布放上新元件。
// 原本的內容不會被改動，新元件放在旁邊就能對照。
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

  function insert(items, at) {
    if (board.readOnly) return;
    // 每次放都換新 id，同一份回覆可以放好幾次
    const fresh = items.map(it => ({ ...it, id: uid() }));
    board.insertItems(placeItems(fresh, at));
    toast(`已放上 ${items.length} 個物件，可以按復原還原`);
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

  // 右鍵：選取框裡＝把選取的交給 AI；點到物件就先選它；空白處＝整頁。也可以把剪貼簿裡的 AI 回覆貼在這裡
  $('#viewport').addEventListener('contextmenu', e => {
    if (e.target.isContentEditable || board.picking) return;
    const { clientX: x, clientY: y } = e;
    let ids = null;
    if (board.selectionHas(x, y)) ids = [...board.sel];
    else if (board.tool === 'select' || board.tool === 'lasso') {
      const hit = board.itemAt(x, y);
      board.setSelection(hit ? [hit.id] : []);
      if (hit) ids = [hit.id];
    }
    const at = board.toWorld(x, y);
    showMenu({ left: x, right: x, top: y, bottom: y }, [
      { label: ids ? `✨ 提取給 AI 分析（${ids.length} 個物件）` : '✨ 整頁交給 AI 分析', run: () => open(ids) },
      { label: '📋 在這裡貼上 AI 回覆', disabled: board.readOnly, run: () => pasteClipboard(at) },
    ]);
  });

  async function pasteClipboard(at) {
    let text;
    try { text = await navigator.clipboard.readText(); } catch { toast('無法讀取剪貼簿，請點畫布後按 Ctrl+V'); return; }
    if (!paste(text, at)) toast('剪貼簿裡不是 AI 的回覆（需要 {"items":[…]}）');
  }

  // 一般的貼上（Ctrl+V）也認得 AI 回覆：是的話放在游標位置，回傳 true
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
