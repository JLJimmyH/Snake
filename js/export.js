// 分享：頂列按鈕和右鍵「分享」的對話框（截圖預覽、交給 AI、圖片、PDF）。有選取就只匯出選取的物件，沒有就整頁
const $ = selector => document.querySelector(selector);

const MM = 96 / 25.4;               // 1mm 幾個 CSS px
const A4 = { w: 210, h: 297 }, MARGIN = 10; // mm

// 用瀏覽器列印存成 PDF：選取的物件（沒給就整頁）複製到 #print-root，橫直自動選，放得下照實際大小，放不下縮成一頁 A4。
// 走列印而不是自己產生 PDF：文字是向量、可以搜尋，中文字型交給系統，Markdown 排版跟畫面一樣
export async function printPdf(board, ids, name) {
  board.commitText();
  const set = ids?.length ? new Set(ids) : null;
  const area = board.exportArea(set);
  if (!area) return false;
  const landscape = area.w > area.h;
  // 可印範圍；少 2px，免得四捨五入擠出第二頁
  const pw = ((landscape ? A4.h : A4.w) - MARGIN * 2) * MM - 2;
  const ph = ((landscape ? A4.w : A4.h) - MARGIN * 2) * MM - 2;
  const k = Math.min(1, pw / area.w, ph / area.h);
  const sheet = board.printSheet(area, set);
  sheet.style.transform = `scale(${k})`;
  const fit = document.createElement('div');
  fit.className = 'print-fit';
  fit.style.width = area.w * k + 'px';
  fit.style.height = area.h * k + 'px';
  fit.append(sheet);
  let root = $('#print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.append(root);
  }
  root.replaceChildren(fit);
  let page = $('#print-page');
  if (!page) {
    page = document.createElement('style');
    page.id = 'print-page';
    document.head.append(page);
  }
  page.textContent = `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: ${MARGIN}mm; }`;
  // 圖片是複製出來的新 <img>，等它解碼完再印，不然可能印出空白
  await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
  // 存成 PDF 的預設檔名是頁面標題。#print-root 留著不拆：iOS 的 afterprint 可能比真正輸出早，下次匯出再換掉
  const old = document.title;
  document.title = name;
  addEventListener('afterprint', () => { document.title = old; }, { once: true });
  print();
  return true;
}

// 複製 PNG 到剪貼簿，不行就下載。png 要傳 Promise：Safari 要求在點擊當下就呼叫 clipboard.write
export async function copyPng(png, name, toast) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('已複製圖片');
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await png);
    a.download = name + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('瀏覽器不能複製圖片，改成下載');
  }
}

// 頂列「分享」：直接打開對話框，先看到要分享的截圖，下面選複製給 AI、複製圖片或匯出 PDF。
// ai：ai-ui.js 的 setupAi；載入失敗時是 null，「複製給 AI」變灰，其他照用。回傳的 open(ids) 給右鍵「分享」用
export function setupExport({ board, title, toast, ai }) {
  const dialog = $('#export-dialog');
  const shot = $('#export-preview');
  const name = () => title() || '筆記';
  let ids = [];        // 要匯出的物件 id；空的＝整頁
  let png = null;      // 打開時畫好的截圖（Promise<Blob>），預覽和「複製圖片」共用

  // list：要分享的物件 id；空的＝整頁
  function open(list) {
    board.commitText();
    ids = list ?? [];
    const set = ids.length ? new Set(ids) : null;
    const area = board.exportArea(set);
    $('#export-heading').textContent = !area ? '這頁沒有內容' : set ? `分享選取的 ${ids.length} 個物件` : '分享整頁';
    png = area && board.toPNG(area, { ids: set });
    URL.revokeObjectURL(shot.src);
    shot.removeAttribute('src');
    shot.hidden = !png;
    png?.then(blob => { shot.src = URL.createObjectURL(blob); }).catch(() => { shot.hidden = true; });
    $('#ai-copy').disabled = !ai || !area;
    $('#export-image').disabled = $('#export-pdf').disabled = !area;
    dialog.showModal();
  }

  $('#export-button').addEventListener('click', () => open([...board.sel]));

  $('#export-close').addEventListener('click', () => dialog.close());
  $('#ai-copy').addEventListener('click', () => ai.toAi(ids, $('#ai-request').value));
  $('#export-image').addEventListener('click', () => copyPng(png, name(), toast));
  // 先關對話框再列印，列印畫面才不會被 modal 擋住
  $('#export-pdf').addEventListener('click', () => { dialog.close(); printPdf(board, ids, name()); });
  return { open };
}
