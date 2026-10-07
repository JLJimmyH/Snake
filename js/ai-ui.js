import { exportPage, buildPrompt, parseReply, applyOps, summarize } from './ai-core.js';

const $ = selector => document.querySelector(selector);

// AI 整理：複製這頁給 ChatGPT／Claude → 貼回 AI 的 ops → 看過摘要再套用
export function setupAi({ board, title, toast }) {
  const dialog = $('#ai-dialog');
  const reply = $('#ai-reply');
  const preview = $('#ai-preview');
  let copied = null; // 複製當下的內容，套用前用來判斷這頁有沒有又被改過
  let pending = null;

  const snapshot = () => JSON.stringify(board.items);

  $('#ai-button').addEventListener('click', () => {
    board.commitText();
    $('#ai-apply').disabled = true;
    check();
    dialog.showModal();
  });
  $('#ai-close').addEventListener('click', () => dialog.close());

  $('#ai-copy').addEventListener('click', async () => {
    board.commitText();
    const exported = exportPage({ title: title(), items: board.items, area: board.exportArea() });
    try {
      await navigator.clipboard.writeText(buildPrompt(exported, $('#ai-request').value));
      copied = snapshot();
      toast(board.items.some(it => it.type !== 'text') ? '已複製。有手寫或圖片的話，再附上截圖給 AI' : '已複製，貼給 AI 吧');
    } catch {
      toast('無法存取剪貼簿，請改用 https 或 localhost 開啟');
    }
  });

  $('#ai-shot').addEventListener('click', async () => {
    const area = board.exportArea();
    if (!area) { toast('這頁還沒有內容'); return; }
    const png = board.toPNG(area);
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

  // 貼上就先試算一次，讓使用者看到會改什麼
  function check() {
    pending = null;
    preview.replaceChildren();
    $('#ai-apply').disabled = true;
    if (!reply.value.trim()) return;
    try {
      const result = applyOps(board.items, parseReply(reply.value));
      const { counts, lines, warn } = summarize(result.changes);
      const head = document.createElement('p');
      head.className = 'ai-counts';
      head.textContent = counts + (warn ? `（${warn}）` : '') + (board.readOnly ? '。這頁是唯讀，不能套用' : '');
      const list = document.createElement('ul');
      for (const line of lines.slice(0, 50)) list.append(Object.assign(document.createElement('li'), { textContent: line }));
      if (lines.length > 50) list.append(Object.assign(document.createElement('li'), { textContent: `…還有 ${lines.length - 50} 項` }));
      preview.append(head, list);
      pending = reply.value;
      $('#ai-apply').disabled = board.readOnly;
    } catch (error) {
      preview.append(Object.assign(document.createElement('p'), { className: 'ai-error', textContent: error.message }));
    }
  }
  reply.addEventListener('input', check);

  $('#ai-apply').addEventListener('click', () => {
    if (!pending || board.readOnly) return;
    if (copied && copied !== snapshot() && !confirm('複製給 AI 之後，這頁又被改過了。仍要套用嗎？')) return;
    try {
      const { items, changes } = applyOps(board.items, parseReply(pending));
      board.replaceItems(items);
      dialog.close();
      reply.value = '';
      copied = null;
      check();
      toast(`已套用 ${changes.length} 項修改，可以按復原還原`);
    } catch (error) {
      toast(error.message);
      check();
    }
  });
}
