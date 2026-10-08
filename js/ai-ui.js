import { uid } from './db.js';
import { exportRegion, copyText, buildPrompt, replyItems, placeItems, itemsBox, copiedOrigin } from './ai-core.js';
import { copyPng, printPdf } from './export.js';

const $ = selector => document.querySelector(selector);

// AI 協作：框選一塊（或整頁）→ 匯出選單「交給 AI」→ 看一眼要交出去的內容 → 複製給 ChatGPT／Claude。
// AI 回的 {"items":[…]} 由使用者在畫布上 Ctrl+V 貼回，原本的內容不會被改動。右鍵選單（剪下／複製／貼上）、Ctrl+C／Ctrl+X 也在這裡。
// pasteContent：main.js 的貼上（圖片、物件、文字），右鍵的各種貼上都交給它
export function setupAi({ board, title, toast, showMenu, pasteContent }) {
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

  // at：外框左上角要放的位置；null＝座標已經是畫布座標（原位貼上）
  async function insert(items, at) {
    if (board.readOnly) return;
    // 圖片只帶 blob id：這台裝置（或協作伺服器）找不到圖檔就略過
    const found = await Promise.all(items.map(it => it.type !== 'image' || board.hasBlob(it.blobId)));
    const kept = items.filter((_, i) => found[i]), skipped = items.length - kept.length;
    if (!kept.length) { toast('找不到圖片檔，無法貼上'); return; }
    // 每次貼都換新 id，同一份內容可以貼好幾次
    const fresh = kept.map(it => ({ ...it, id: uid() }));
    board.insertItems(at ? placeItems(fresh, at) : fresh);
    toast(`已貼上 ${kept.length} 個物件` + (skipped ? `（${skipped} 張圖片找不到，略過）` : '') + '，可以按復原還原');
  }

  // 右鍵：選取框裡或點到物件＝剪下／複製／刪除／匯出 PDF 這些物件（點到未選取的物件會先選它）；空白處＝整頁。
  // 複製的是 {"items":[…]} JSON，可以貼到別頁，也可以直接貼給 AI。貼上的位置是按右鍵的地方
  $('#viewport').addEventListener('contextmenu', async e => {
    if (board.typingIn(e.target)) return;
    const { clientX: x, clientY: y } = e;
    let ids = board.selectionHas(x, y) ? [...board.sel] : null;
    if (!ids && (board.tool === 'select' || board.tool === 'lasso')) {
      const hit = board.itemAt(x, y);
      board.setSelection(hit ? [hit.id] : []);
      if (hit) ids = [hit.id];
    }
    const at = board.toWorld(x, y), edit = !board.readOnly;
    const groups = [
      ids ? [
        edit && { label: '剪下', hint: 'Ctrl+X', run: () => cut(ids) },
        { label: `複製（${ids.length} 個物件）`, hint: 'Ctrl+C', run: () => copy(ids) },
        edit && { label: '刪除', hint: 'Delete', danger: true, run: () => board.deleteSelected() },
      ] : [board.items.length && { label: '複製全部', run: () => copy(null) }],
      edit ? pasteEntries(await peekClipboard(), at) : [],
      [(ids || board.items.length) && { label: ids ? '匯出 PDF' : '匯出整頁 PDF', run: () => printPdf(board, ids, title() || '筆記') }],
    ].map(group => group.filter(Boolean)).filter(group => group.length);
    if (!groups.length) return;
    showMenu({ left: x, right: x, top: y, bottom: y }, groups.flatMap((group, i) => i ? [{ sep: true }, ...group] : group));
  });

  // 貼上選項。clip＝已經讀到的剪貼簿，用不到的選項變灰；null＝還不知道，全部亮著，點了再讀
  function pasteEntries(clip, at) {
    const has = test => !clip || !!test(clip);
    const entry = (label, hint, mode, ok) => ({ label, hint, disabled: !has(ok), run: () => pasteAt(clip, at, mode) });
    return [
      entry('貼上', 'Ctrl+V', 'auto', c => c.files.length || c.text),
      entry('純文字貼上', 'Ctrl+Shift+V', 'plain', c => c.text || c.html),
      entry('原始格式貼上', '', 'format', c => c.html),
      entry('原位貼上', '', 'inplace', c => copiedOrigin(c.text)),
    ];
  }

  async function pasteAt(clip, at, mode) {
    try { clip ??= await readClipboard(); }
    catch { toast('無法讀取剪貼簿：請允許網站存取剪貼簿，或改按 Ctrl+V'); return; }
    pasteContent(clip, at, mode);
  }

  // Ctrl+C／Ctrl+X：有選取物件、而且不是在打字時，複製（剪下）物件
  for (const type of ['copy', 'cut']) document.addEventListener(type, e => {
    const a = document.activeElement;
    if (!board.sel.size || a?.isContentEditable || a?.matches?.('input, textarea') || $('dialog[open]')) return;
    if (type === 'cut' && board.readOnly) return;
    e.preventDefault();
    const n = board.sel.size;
    e.clipboardData.setData('text/plain', copied([...board.sel]));
    if (type === 'cut') board.deleteSelected();
    toast(`已${type === 'cut' ? '剪下' : '複製'} ${n} 個物件`);
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
      return true;
    } catch {
      toast('無法存取剪貼簿，請改用 https 或 localhost 開啟');
      return false;
    }
  }

  async function cut(ids) {
    if (!await copy(ids)) return;
    board.setSelection(ids);
    board.deleteSelected();
    toast(`已剪下 ${ids.length} 個物件，可以貼到別處`);
  }

  // 一般的貼上（Ctrl+V）認得複製的物件和 AI 回覆：是的話放在游標位置，回傳 true。
  // inPlace：放回複製時的位置（只有從這個 app 複製的物件記得位置）
  function paste(text, at, { inPlace = false } = {}) {
    const items = replyItems(text, { defaultSize: size });
    if (!items) return false;
    const origin = inPlace && copiedOrigin(text);
    if (inPlace && !origin) return false;
    if (origin) {
      const box = itemsBox(items);
      insert(placeItems(items, { x: origin.x + box.x, y: origin.y + box.y }), null);
    } else insert(items, at);
    return true;
  }

  return { open, paste };
}

// 已經允許網站讀剪貼簿（Chrome）就先讀，選單才知道哪些貼上選項用得到；還沒允許就不要在按右鍵時跳出詢問
export async function peekClipboard() {
  try {
    if ((await navigator.permissions.query({ name: 'clipboard-read' })).state !== 'granted') return null;
    return await readClipboard();
  } catch { return null; }
}

// 剪貼簿 → { files（圖片）, text, html }；不支援 read() 的瀏覽器只拿得到文字
async function readClipboard() {
  const clip = { files: [], text: '', html: '' };
  if (navigator.clipboard.read) {
    for (const item of await navigator.clipboard.read()) {
      const image = item.types.find(type => type.startsWith('image/'));
      if (image) clip.files.push(await item.getType(image));
      if (!clip.text && item.types.includes('text/plain')) clip.text = await (await item.getType('text/plain')).text();
      if (!clip.html && item.types.includes('text/html')) clip.html = await (await item.getType('text/html')).text();
    }
  } else {
    clip.text = await navigator.clipboard.readText();
  }
  clip.text = clip.text.replace(/\r\n?/g, '\n');  // Windows 剪貼簿是 CRLF
  return clip;
}

const mostCommon = values => {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
};
