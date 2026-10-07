import { uid } from './db.js';
import { exportRegion, copyText, buildPrompt, replyItems, placeItems } from './ai-core.js';
import { copyPng, printPdf } from './export.js';

const $ = selector => document.querySelector(selector);

// AI 協作：框選一塊（或整頁）→ 匯出選單「交給 AI」→ 看一眼要交出去的內容 → 複製給 ChatGPT／Claude。
// AI 回的 {"items":[…]} 由使用者在畫布上 Ctrl+V 貼回，原本的內容不會被改動。右鍵／Ctrl+C 複製物件也在這裡。
export function setupAi({ board, title, toast, showMenu }) {
  const dialog = $('#ai-dialog');
  const shot = $('#ai-shot-preview');
  let scope = null;     // 要交給 AI 的物件 id（Set）；null＝整頁
  let png = null;       // 打開時畫好的截圖（Promise<Blob>），預覽和「複製截圖」共用
  let size = 18;        // 貼上時沒給字級用的字級：上次交給 AI 的範圍裡最常見的字級

  const scoped = () => scope ? board.items.filter(it => scope.has(it.id)) : board.items;

  function open(ids = null) {
    board.commitText();
    scope = ids?.length ? new Set(ids) : null;
    $('#ai-heading').textContent = scope ? `AI 分析選取的 ${scope.size} 個物件` : 'AI 分析這一頁';
    const area = board.exportArea(scope);
    png = area && board.toPNG(area, { ids: scope });
    URL.revokeObjectURL(shot.src);
    shot.removeAttribute('src');
    shot.hidden = !png;
    png?.then(blob => { shot.src = URL.createObjectURL(blob); }).catch(() => { shot.hidden = true; });
    dialog.showModal();
  }

  $('#ai-close').addEventListener('click', () => dialog.close());

  $('#ai-copy').addEventListener('click', async () => {
    const items = scoped();
    if (!items.length) { toast('沒有內容可以複製'); return; }
    const exported = exportRegion({ title: title(), items, area: board.exportArea(scope), selected: !!scope });
    const sizes = items.filter(it => it.type === 'text').map(it => it.size);
    if (sizes.length) size = mostCommon(sizes);
    try {
      await navigator.clipboard.writeText(buildPrompt(exported, $('#ai-request').value));
      toast(items.some(it => it.type !== 'text') ? '已複製，有手寫的話也附上截圖' : '已複製，貼給 AI 吧');
    } catch {
      toast('無法存取剪貼簿，請改用 https 或 localhost 開啟');
    }
  });

  $('#ai-shot').addEventListener('click', () => {
    if (!png) { toast('沒有內容可以複製'); return; }
    copyPng(png, title() || '筆記', toast);
  });

  async function insert(items, at) {
    if (board.readOnly) return;
    // 圖片只帶 blob id：這台裝置（或協作伺服器）找不到圖檔就略過
    const found = await Promise.all(items.map(it => it.type !== 'image' || board.hasBlob(it.blobId)));
    const kept = items.filter((_, i) => found[i]), skipped = items.length - kept.length;
    if (!kept.length) { toast('找不到圖片檔，無法貼上'); return; }
    // 每次貼都換新 id，同一份內容可以貼好幾次
    board.insertItems(placeItems(kept.map(it => ({ ...it, id: uid() })), at));
    toast(`已貼上 ${kept.length} 個物件` + (skipped ? `（${skipped} 張圖片找不到，略過）` : '') + '，可以按復原還原');
  }

  // 右鍵：選取框裡或點到物件＝複製／匯出 PDF 這些物件（點到未選取的物件會先選它）；空白處＝整頁。
  // 複製的是 {"items":[…]} JSON，可以 Ctrl+V 貼到別頁，也可以直接貼給 AI
  $('#viewport').addEventListener('contextmenu', e => {
    if (e.target.isContentEditable) return;
    const { clientX: x, clientY: y } = e;
    let ids = board.selectionHas(x, y) ? [...board.sel] : null;
    if (!ids && (board.tool === 'select' || board.tool === 'lasso')) {
      const hit = board.itemAt(x, y);
      board.setSelection(hit ? [hit.id] : []);
      if (hit) ids = [hit.id];
    }
    if (!ids && !board.items.length) return;
    showMenu({ left: x, right: x, top: y, bottom: y }, [
      ids ? { label: `複製（${ids.length} 個物件）`, run: () => copy(ids) } : { label: '複製全部', run: () => copy(null) },
      { label: ids ? '匯出 PDF' : '匯出整頁 PDF', run: () => printPdf(board, ids, title() || '筆記') },
    ]);
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
