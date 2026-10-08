// 文字框的精簡 markdown：標題、粗體／斜體、清單、待辦、行內程式碼、連結、```程式碼區塊、```mermaid 流程圖。
// 只用 DOM API 產生節點、文字一律走 textContent，不會有 HTML 注入。
// 每個顯示出來的文字節點都記住它在原始文字的位置，切回編輯時游標才能放回點到的地方。
import { highlight } from './highlight.js';
import { diagram, DIAGRAM_EM } from './diagram.js';

const BLOCK = /^(?:(#{1,6}) +|(\s*)[-*+] +(?:\[([ xX])\] +)?)/;
const INLINE = /(`+)(.+?)\1|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const SAFE_URL = /^(https?:|mailto:)/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;

function node(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ``` 或 ~~~ 圍起來的區塊（行號範圍，含前後的 ``` 行）；沒有結尾的一直到最後一行
function fences(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[end]);
      if (c && c[1][0] === m[1][0] && c[1].length >= m[1].length) break;
      end++;
    }
    out.push({ start: i, end: Math.min(end + 1, lines.length), close: end, lang: m[2].toLowerCase() });
    i = end;
  }
  return out;
}

// text → 內容放進 body；回傳 Map(文字節點 → 在原始文字的起點)。
// dark：流程圖用深色主題；onResize：流程圖畫好、文字框大小變了
export function renderMarkdown(body, text, { dark = false, onResize } = {}) {
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

  // 一般的文字行（從原始文字第 at 個字元開始）放進 to
  const prose = (to, lines, at) => {
    for (const [i, line] of lines.entries()) {
      if (i) { plain(to, '\n', at - 1); }
      const m = BLOCK.exec(line);
      let parent = to, rest = m ? m[0].length : 0;
      if (m?.[1]) {
        parent = node('span', 'md-h' + Math.min(m[1].length, 3));
        to.append(parent);
      } else if (m) {
        plain(to, m[2], at);
        if (m[3]) {
          const box = node('span', 'md-check');
          box.dataset.at = at + m[0].indexOf('[') + 1;
          box.setAttribute('role', 'checkbox');
          box.setAttribute('aria-checked', String(m[3] !== ' '));
          to.append(box, ' ');
          if (m[3] !== ' ') { parent = node('span', 'md-done'); to.append(parent); }
        } else {
          to.append(node('span', 'md-bullet'));
        }
      }
      inline(parent, line.slice(rest), at + rest);
      at += line.length + 1;
    }
  };
  // 程式碼區塊、流程圖：data-from／data-to 是程式碼在原始文字的範圍（右上角「複製」用）
  const block = (cls, code, at) => {
    const el = node('div', cls);
    el.dataset.from = at;
    el.dataset.to = at + code.length;
    const copy = node('span', 'md-copy');
    copy.contentEditable = 'false';
    copy.title = '複製';
    el.append(copy);
    return el;
  };
  const codeBlock = (code, lang, at) => {
    const el = block('md-pre', code, at), c = node('code');
    for (const [cls, part] of highlight(code, lang)) {
      if (cls) { const s = node('span', cls); plain(s, part, at); c.append(s); } else plain(c, part, at);
      at += part.length;
    }
    el.append(c);
    return el;
  };
  const mermaid = (code, at) => {
    const el = block('md-mermaid', code, at), wait = node('div', 'md-diagram-wait');
    wait.textContent = '畫流程圖中…';
    el.append(wait);
    diagram(code, dark).then(r => {
      if (!body.contains(el)) return;  // 已經切到編輯或重畫了
      let out;
      if (r.error) {
        out = node('div', 'md-diagram-error');
        out.textContent = '流程圖畫不出來：' + r.error;
      } else {
        out = new Image(r.w, r.h);
        out.className = 'md-diagram';
        out.alt = '流程圖';
        out.draggable = false;
        out.src = r.src;
        out.style.width = r.w / DIAGRAM_EM + 'em';
        if (r.taints) out.dataset.taints = '';
      }
      wait.replaceWith(out);
      onResize?.();
    });
    return el;
  };

  const lines = text.split('\n'), starts = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i++].length + 1) starts.push(at);
  const blocks = fences(lines);
  if (!blocks.length) prose(frag, lines, 0);
  else {
    // 有區塊時，前後的文字各包成一段（.md-seg）：文字照樣在 32 個字寬換行，區塊可以更寬
    let i = 0;
    const seg = end => {
      if (end <= i) return;
      const el = node('div', 'md-seg');
      prose(el, lines.slice(i, end), starts[i]);
      frag.append(el);
    };
    for (const b of blocks) {
      seg(b.start);
      const code = lines.slice(b.start + 1, b.close).join('\n'), at = starts[b.start + 1] ?? text.length;
      frag.append(b.lang === 'mermaid' ? mermaid(code, at) : codeBlock(code, b.lang, at));
      i = b.end;
    }
    seg(lines.length);
  }
  body.replaceChildren(frag);
  return map;
}

// 原始文字裡第 from～to 個字元（程式碼區塊的「複製」）
export function blockSource(text, el) {
  return text.slice(Number(el.dataset.from), Number(el.dataset.to));
}

// 顯示畫面中的游標位置 (node, offset) → 原始文字的位置
export function sourceOffset(body, map, container, offset) {
  if (map.has(container)) return map.get(container) + offset;
  // 點在流程圖上：游標放在流程圖原始碼的開頭
  const diagramBox = (container.nodeType === 1 ? container : container.parentElement)?.closest?.('.md-mermaid');
  if (diagramBox && body.contains(diagramBox)) return Number(diagramBox.dataset.from);
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

// 「原始格式貼上」：網頁、Word、Google 文件複製來的 HTML → 文字框的 markdown。
// 「純文字貼上」用 htmlToText：同一份 HTML 只留看得到的文字，不加任何 markdown 記號。
// ChatGPT 這類網站給的純文字本身就是 markdown，直接貼會變成有格式，所以有 HTML 時一律從 HTML 取文字。
// DOMParser 產生的文件不會執行腳本、也不會載入圖片，這裡只讀文字和標籤。
// 區塊的邊界先記成 \0、空白段落記成 \u0001、清單縮排記成 \u0002，最後才換成換行和空白，
// 原始 HTML 排版用的空白和換行就不會變成多餘的空行
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FIGURE', 'FIGCAPTION',
  'BLOCKQUOTE', 'ADDRESS', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'HR', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'CAPTION']);
const SKIP = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'IMG', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

export const htmlToMarkdown = html => fromHtml(html, false);
export const htmlToText = html => fromHtml(html, true);

function fromHtml(html, plain) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = convert(doc.body, { depth: 0, plain })
    .replace(/[ \n]*\0[\0 \n]*/g, run => '\n'.repeat(1 + (run.slice(run.indexOf('\0')).match(/\n/g)?.length ?? 0)))
    .replace(/\u0001/g, '')
    .split('\n').map(line => line.trimEnd().replace(/^ +/, '').replace(/\u0002/g, ' ')).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '').replace(/\u0003/g, '\n');
}

// 程式碼包成 ``` 區塊；程式碼裡本來就有 ``` 的話，外面的 ` 多一個
export function fenceCode(code, lang = '') {
  const ticks = '`'.repeat(Math.max(3, ...[...code.matchAll(/`{3,}/g)].map(m => m[0].length + 1)));
  return `${ticks}${lang}\n${code.replace(/\n+$/, '')}\n${ticks}`;
}

function convert(node, ctx) {
  if (node.nodeType === 3) return ctx.pre ? node.data : node.data.replace(/[\s\u0000-\u0002]+/g, ' ');
  if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
  const tag = node.tagName;
  const inner = (more = {}) => [...node.childNodes].map(c => convert(c, { ...ctx, ...more })).join('');
  if (tag === 'BR') return '\n';
  // 程式碼：網頁的 <pre>；VS Code 複製的是 white-space: pre 的等寬字 <div>，一行一個 <div>。
  // 換行先記成 \u0003，後面整理空白、合併空行時才不會動到程式碼
  const style = node.style ?? {};
  const editor = tag === 'DIV' && style.whiteSpace === 'pre' && /mono|consolas|courier|menlo/i.test(style.fontFamily);
  if (tag === 'PRE' || editor) {
    const lines = editor && node.children.length ? [...node.children].map(c => c.textContent) : [node.textContent];
    const lang = /(?:language|lang|highlight-source)-([\w+#-]+)/.exec(`${node.className} ${node.querySelector('code')?.className ?? ''} ${node.parentElement?.className ?? ''}`)?.[1];
    const code = lines.join('\n');
    return '\0' + (ctx.plain ? code.replace(/\n+$/, '') : fenceCode(code, lang)).replace(/\n/g, '\u0003') + '\0';
  }
  if (/^H[1-6]$/.test(tag)) {
    const text = oneLine(inner({ bold: true }));
    return text ? `\0${ctx.plain ? '' : '#'.repeat(+tag[1]) + ' '}${text}\0` : '';
  }
  if (tag === 'UL' || tag === 'OL') {
    let n = +node.getAttribute('start') || 1;
    return '\0' + [...node.children].filter(c => c.tagName === 'LI')
      .map(li => listItem(li, tag === 'OL' ? `${n++}. ` : bullet(ctx), ctx)).join('\0') + '\0';
  }
  if (tag === 'LI') return listItem(node, bullet(ctx), ctx);
  if (tag === 'TR') return '\0' + [...node.children].map(cell => oneLine(convert(cell, ctx))).join(' | ') + '\0';
  if (BLOCKS.has(tag)) {
    const text = inner().replace(/\n$/, '');  // 區塊最後的 <br> 不會多出一行
    return /^[\s\0\u0001]*$/.test(text) ? '\0\u0001\0' : '\0' + text + '\0';
  }
  if (!ctx.pre && (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP')) {
    const text = oneLine(node.textContent);
    return text && !ctx.plain ? '`' + text + '`' : text;
  }
  const bold = !ctx.bold && (style.fontWeight ? /^(bold|bolder|[6-9]00)$/.test(style.fontWeight) : tag === 'B' || tag === 'STRONG');
  const italic = !ctx.italic && (style.fontStyle ? style.fontStyle === 'italic' : tag === 'I' || tag === 'EM');
  let text = inner({ bold: ctx.bold || bold, italic: ctx.italic || italic });
  if (ctx.plain) return text;
  if (bold) text = mark(text, '**');
  if (italic) text = mark(text, '*');
  const href = tag === 'A' && node.getAttribute('href');
  if (href && SAFE_URL.test(href) && !/[\0\n]/.test(text) && text.trim()) return `[${text.trim()}](${href.replace(/[\s)]/g, encodeURIComponent)})`;
  return text;
}

// 純文字的項目符號用「•」，不是 markdown 的「-」，貼上後不會變成清單格式
const bullet = ctx => ctx.plain ? '• ' : '- ';

// 清單項目：縮排 + 符號（待辦就加 [ ]／[x]），裡面的子清單再縮一層
function listItem(li, bullet, ctx) {
  const box = !ctx.plain && [...li.querySelectorAll('input[type=checkbox]')].find(b => b.closest('li') === li);
  const text = [...li.childNodes].map(c => convert(c, { ...ctx, depth: ctx.depth + 1 })).join('').replace(/^[\s\0\u0001]+/, '');
  return '\u0002'.repeat(ctx.depth * 2) + bullet + (box ? (box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '') + text;
}

const oneLine = text => text.replace(/[\s\0\u0001\u0002]+/g, ' ').trim();

// 每一行分開包，前後空白留在記號外面，不然 markdown 認不得
const mark = (text, m) => text.split(/(\0|\n)/).map(part => {
  const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(part);
  return core && part !== '\0' ? lead + m + core + m + trail : part;
}).join('');
