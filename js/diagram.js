// Mermaid 流程圖：文字框裡的 ```mermaid 區塊畫成圖。
// Mermaid 很大（約 5 MB），第一次遇到才載入，之後每種圖再各自載入需要的部分。
// 畫出來的 SVG 放進 <img>：圖片裡的 SVG 不會執行任何東西，協作時別人寫的內容也安全；
// htmlLabels 關掉，標籤用 SVG 文字而不是 foreignObject，畫進 canvas（複製圖片）才不會被當成跨來源

const FONT = '-apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
export const DIAGRAM_EM = 16;  // Mermaid 用 16px 排版；顯示時換成 em，圖跟著文字框的字級縮放
const CACHE = 100;
// 配色：冷灰＋藍（跟程式碼區塊的 One Dark／One Light 一致），不用 Mermaid 預設的紫色
const LIGHT = {
  background: '#ffffff', primaryColor: '#e8eef9', primaryBorderColor: '#4a72c4', primaryTextColor: '#1f2937',
  secondaryColor: '#eef1f5', tertiaryColor: '#f7f8fa', lineColor: '#5c6370', textColor: '#1f2937', edgeLabelBackground: '#ffffff',
};
const DARK = {
  darkMode: true, background: '#282c34', primaryColor: '#2f3a4d', primaryBorderColor: '#61afef', primaryTextColor: '#e5e7eb',
  secondaryColor: '#363c48', tertiaryColor: '#2c313c', lineColor: '#9aa2b3', textColor: '#e5e7eb', edgeLabelBackground: '#282c34',
};

let mermaid, queue = Promise.resolve(), seq = 0;
const cache = new Map();  // `${dark}\n${code}` → Promise<{ src, w, h, taints } | { error }>

// 升級 Mermaid 要換資料夾名稱：.mjs 不在 scripts/stamp.mjs 的版本號裡，靠路徑不同才不會用到快取的舊檔
function load() {
  return mermaid ??= import(new URL('./vendor/mermaid-12.1.0/mermaid.esm.min.mjs', import.meta.url)).then(m => m.default);
}

export function diagram(code, dark) {
  const key = (dark ? 'd' : 'l') + '\n' + code;
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); return p; }  // 最近用過的移到最後面
  p = queue = queue.then(() => draw(code, dark), () => draw(code, dark));
  cache.set(key, p);
  if (cache.size > CACHE) cache.delete(cache.keys().next().value);
  return p;
}

async function draw(code, dark) {
  let m;
  try { m = await load(); } catch {
    mermaid = null;  // 下次再試（例如離線）
    return { error: '流程圖元件載不下來，檢查網路後重新整理' };
  }
  const id = 'mermaid-' + ++seq;
  try {
    m.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false,
      theme: 'base', fontFamily: FONT, themeVariables: { fontFamily: FONT, ...(dark ? DARK : LIGHT) },
      themeCSS: '.edgeLabel rect { opacity: 1 !important; }',  // 預設半透明，線會穿過連線上的字
    });
    const { svg } = await m.render(id, code);
    return toImage(svg);
  } catch (e) {
    return { error: String(e?.message ?? e).split('\n').filter(Boolean).slice(0, 3).join('\n') || '流程圖語法錯誤' };
  } finally {
    // render 暫時放在 body 的元素，出錯時可能留著
    for (const el of document.querySelectorAll(`#${id}, #d${id}, #i${id}`)) el.remove();
  }
}

// SVG 字串 → <img> 用的 data URL；寬高照 viewBox 寫死，<img> 才有原始大小。
// render 給的是 HTML 序列化（例如 <br> 沒有結尾），用 HTML 解析再序列化成正式的 XML
function toImage(svg) {
  const root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  const [, , w, h] = (root?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0)) return { error: '流程圖是空的' };
  root.setAttribute('width', w);
  root.setAttribute('height', h);
  root.style.removeProperty('max-width');
  const text = new XMLSerializer().serializeToString(root);
  return { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text), w, h, taints: text.includes('<foreignObject') };
}
