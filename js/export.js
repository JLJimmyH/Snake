// 匯出：頂列按鈕的選單（PDF、圖片、交給 AI）。有選取就只匯出選取的物件，沒有就整頁
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

export function setupExport({ board, title, toast, showMenu, ai }) {
  const button = $('#export-button');
  const name = () => title() || '筆記';

  button.addEventListener('click', () => {
    board.commitText();
    const ids = [...board.sel];
    const set = ids.length ? new Set(ids) : null;
    const area = board.exportArea(set);
    showMenu(button.getBoundingClientRect(), [
      { head: !area ? '這頁沒有內容' : set ? `匯出選取的 ${ids.length} 個物件` : '匯出整頁' },
      { label: '📄 匯出 PDF', disabled: !area, run: () => printPdf(board, ids, name()) },
      { label: '🖼 複製圖片', disabled: !area, run: () => copyPng(board.toPNG(area, { ids: set }), name(), toast) },
      { label: '✨ 交給 AI…', run: () => ai.open(ids) },
    ]);
  });
}
