// 文字框的精簡 markdown：標題、粗體／斜體、清單、待辦、行內程式碼、連結。
// 只用 DOM API 產生節點、文字一律走 textContent，不會有 HTML 注入。
// 每個顯示出來的文字節點都記住它在原始文字的位置，切回編輯時游標才能放回點到的地方。

const BLOCK = /^(?:(#{1,6}) +|(\s*)[-*+] +(?:\[([ xX])\] +)?)/;
const INLINE = /(`+)(.+?)\1|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const SAFE_URL = /^(https?:|mailto:)/i;

function node(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// text → 內容放進 body；回傳 Map(文字節點 → 在原始文字的起點)
export function renderMarkdown(body, text) {
  const map = new Map();
  const frag = document.createDocumentFragment();
  const plain = (parent, str, at) => {
    if (!str) return;
    const t = document.createTextNode(str);
    map.set(t, at);
    parent.append(t);
  };
  const inline = (parent, str, at) => {
    let last = 0;
    for (const m of str.matchAll(INLINE)) {
      const [all, ticks, code, bold, em, label, url] = m;
      plain(parent, str.slice(last, m.index), at + last);
      last = m.index + all.length;
      if (ticks) {
        const c = node('code', 'md-code');
        plain(c, code, at + m.index + ticks.length);
        parent.append(c);
      } else if (bold || em) {
        const e = node(bold ? 'strong' : 'em');
        inline(e, bold ?? em, at + m.index + (bold ? 2 : 1));
        parent.append(e);
      } else if (SAFE_URL.test(url)) {
        const a = node('a', 'md-link');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        inline(a, label, at + m.index + 1);
        parent.append(a);
      } else {
        plain(parent, all, at + m.index);
      }
    }
    plain(parent, str.slice(last), at + last);
  };

  let at = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (i) { plain(frag, '\n', at - 1); }
    const m = BLOCK.exec(line);
    let parent = frag, rest = m ? m[0].length : 0;
    if (m?.[1]) {
      parent = node('span', 'md-h' + Math.min(m[1].length, 3));
      frag.append(parent);
    } else if (m) {
      plain(frag, m[2], at);
      if (m[3]) {
        const box = node('span', 'md-check');
        box.dataset.at = at + m[0].indexOf('[') + 1;
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(m[3] !== ' '));
        frag.append(box, ' ');
        if (m[3] !== ' ') { parent = node('span', 'md-done'); frag.append(parent); }
      } else {
        frag.append(node('span', 'md-bullet'));
      }
    }
    inline(parent, line.slice(rest), at + rest);
    at += line.length + 1;
  }
  body.replaceChildren(frag);
  return map;
}

// 顯示畫面中的游標位置 (node, offset) → 原始文字的位置
export function sourceOffset(body, map, container, offset) {
  if (map.has(container)) return map.get(container) + offset;
  const caret = document.createRange();
  caret.setStart(container, offset);
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let last = 0;
  for (let t; (t = walker.nextNode());) {
    if (!map.has(t)) continue;
    if (caret.comparePoint(t, 0) >= 0) return map.get(t);
    last = map.get(t) + t.length;
  }
  return last;
}

// 切換 text 第 at 個字元的待辦勾選（[ ] ↔ [x]）
export function toggleTask(text, at) {
  const done = text[at] !== ' ';
  return text.slice(0, at) + (done ? ' ' : 'x') + text.slice(at + 1);
}

// 「保留格式貼上」：網頁、Word、Google 文件複製來的 HTML → 文字框的 markdown。
// DOMParser 產生的文件不會執行腳本、也不會載入圖片，這裡只讀文字和標籤。
// 區塊的邊界先記成 \0、空白段落記成 \u0001、清單縮排記成 \u0002，最後才換成換行和空白，
// 原始 HTML 排版用的空白和換行就不會變成多餘的空行
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FIGURE', 'FIGCAPTION',
  'BLOCKQUOTE', 'ADDRESS', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'HR', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'CAPTION']);
const SKIP = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'IMG', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = convert(doc.body, { depth: 0 })
    .replace(/[ \n]*\0[\0 \n]*/g, run => '\n'.repeat(1 + (run.slice(run.indexOf('\0')).match(/\n/g)?.length ?? 0)))
    .replace(/\u0001/g, '')
    .split('\n').map(line => line.trimEnd().replace(/^ +/, '').replace(/\u0002/g, ' ')).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

function convert(node, ctx) {
  if (node.nodeType === 3) return ctx.pre ? node.data : node.data.replace(/[\s\u0000-\u0002]+/g, ' ');
  if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
  const tag = node.tagName;
  const inner = (more = {}) => [...node.childNodes].map(c => convert(c, { ...ctx, ...more })).join('');
  if (tag === 'BR') return '\n';
  if (tag === 'PRE') return '\0' + node.textContent.replace(/^ +/gm, s => '\u0002'.repeat(s.length)) + '\0';
  if (/^H[1-6]$/.test(tag)) {
    const text = oneLine(inner({ bold: true }));
    return text ? `\0${'#'.repeat(+tag[1])} ${text}\0` : '';
  }
  if (tag === 'UL' || tag === 'OL') {
    let n = +node.getAttribute('start') || 1;
    return '\0' + [...node.children].filter(c => c.tagName === 'LI')
      .map(li => listItem(li, tag === 'OL' ? `${n++}. ` : '- ', ctx)).join('\0') + '\0';
  }
  if (tag === 'LI') return listItem(node, '- ', ctx);
  if (tag === 'TR') return '\0' + [...node.children].map(cell => oneLine(convert(cell, ctx))).join(' | ') + '\0';
  if (BLOCKS.has(tag)) {
    const text = inner().replace(/\n$/, '');  // 區塊最後的 <br> 不會多出一行
    return /^[\s\0\u0001]*$/.test(text) ? '\0\u0001\0' : '\0' + text + '\0';
  }
  if (!ctx.pre && (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP')) {
    const text = oneLine(node.textContent);
    return text ? '`' + text + '`' : '';
  }
  const style = node.style ?? {};
  const bold = !ctx.bold && (style.fontWeight ? /^(bold|bolder|[6-9]00)$/.test(style.fontWeight) : tag === 'B' || tag === 'STRONG');
  const italic = !ctx.italic && (style.fontStyle ? style.fontStyle === 'italic' : tag === 'I' || tag === 'EM');
  let text = inner({ bold: ctx.bold || bold, italic: ctx.italic || italic });
  if (bold) text = mark(text, '**');
  if (italic) text = mark(text, '*');
  const href = tag === 'A' && node.getAttribute('href');
  if (href && SAFE_URL.test(href) && !/[\0\n]/.test(text) && text.trim()) return `[${text.trim()}](${href.replace(/[\s)]/g, encodeURIComponent)})`;
  return text;
}

// 清單項目：縮排 + 符號（待辦就加 [ ]／[x]），裡面的子清單再縮一層
function listItem(li, bullet, ctx) {
  const box = [...li.querySelectorAll('input[type=checkbox]')].find(b => b.closest('li') === li);
  const text = [...li.childNodes].map(c => convert(c, { ...ctx, depth: ctx.depth + 1 })).join('').replace(/^[\s\0\u0001]+/, '');
  return '\u0002'.repeat(ctx.depth * 2) + bullet + (box ? (box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '') + text;
}

const oneLine = text => text.replace(/[\s\0\u0001\u0002]+/g, ' ').trim();

// 每一行分開包，前後空白留在記號外面，不然 markdown 認不得
const mark = (text, m) => text.split(/(\0|\n)/).map(part => {
  const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(part);
  return core && part !== '\0' ? lead + m + core + m + trail : part;
}).join('');
