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
