// 程式碼區塊的語法上色。不分語言的簡單 tokenizer：只認註解、字串、數字、關鍵字、函式呼叫，
// 不追求精確，但不用載入一大包上色程式庫。
// 回傳 [[class 或 null, 文字], ...]，全部接起來就是原始程式碼（顯示畫面要對得回原始文字的位置）

// 用 # 當註解的語言；-- 當註解的語言；用 <!-- --> 的標記語言。其他都當成 C 系（// 和 /* */）
const HASH = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'console', 'ps1', 'powershell', 'pwsh', 'yaml', 'yml', 'toml',
  'rb', 'ruby', 'r', 'perl', 'pl', 'make', 'makefile', 'mk', 'dockerfile', 'docker', 'conf', 'ini', 'cmake', 'nim', 'elixir', 'ex', 'tcl', 'gdb']);
const DASH = new Set(['sql', 'lua', 'hs', 'haskell', 'ada', 'vhdl', 'vhd']);
const MARKUP = new Set(['html', 'xml', 'svg', 'vue', 'xaml', 'qml']);
const NOCASE = new Set(['sql', 'vhdl', 'vhd', 'ada']);

const KEYWORDS = new Set(`
  if else elif elsif endif for foreach while do switch case default break continue return goto
  function func fn def class struct enum union interface impl trait type typedef typename template namespace module package
  import from export as use using include define undef ifdef ifndef pragma
  let const var mut static extern public private protected internal virtual override final abstract sealed readonly
  new delete this self super try catch except finally throw throws raise with yield async await lambda
  in of is not and or instanceof typeof sizeof match where pub crate mod loop then fi esac done local
  null nil None NULL nullptr undefined true false True False void int char float double long short unsigned signed
  bool boolean string auto register volatile inline constexpr unsafe defer go chan map range select
  begin end entity architecture signal process port generic downto to
  insert update into values create table drop alter join on group by order having limit union
`.trim().split(/\s+/));

const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfF]*\b`;
const STRING = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`;
// 沒有結尾的註解、字串一直到程式碼最後。不能用 $：有 m 旗標時 $ 是每一行的行尾
const END = String.raw`(?![\s\S])`;
const patterns = new Map();

function pattern(lang) {
  const kind = HASH.has(lang) ? 'hash' : DASH.has(lang) ? 'dash' : MARKUP.has(lang) ? 'markup' : 'c';
  if (!patterns.has(kind)) {
    const comment = {
      hash: String.raw`#[^\n]*`,
      dash: String.raw`--[^\n]*`,
      markup: `<!--[\\s\\S]*?(?:-->|${END})`,
      c: `\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|${END})`,
    }[kind];
    // Python 的三引號、JS 的 `樣板字串` 可以跨行
    const string = (kind === 'hash' ? `"""[\\s\\S]*?(?:"""|${END})|'''[\\s\\S]*?(?:'''|${END})|` : '')
      + (kind === 'c' ? '`(?:[^`\\\\]|\\\\.)*`?|' : '') + STRING;
    // C 系的 #include、#define 這類前置處理指令
    const meta = kind === 'c' ? String.raw`^[ \t]*#[ \t]*[A-Za-z]+` : '(?!)';
    patterns.set(kind, new RegExp(`(${comment})|(${string})|(${meta})|(${NUMBER})|([A-Za-z_$][\\w$]*)(\\s*\\()?`, 'gm'));
  }
  return patterns.get(kind);
}

export function highlight(code, lang = '') {
  lang = lang.toLowerCase();
  const re = pattern(lang), nocase = NOCASE.has(lang), out = [];
  let last = 0;
  const push = (cls, text) => { if (text) out.push([cls, text]); };
  for (const m of code.matchAll(re)) {
    const [all, comment, string, meta, number, word, call] = m;
    let cls = comment ? 'tok-c' : string ? 'tok-s' : meta ? 'tok-m' : number ? 'tok-n' : null;
    let text = all;
    if (word) {
      text = word;
      cls = KEYWORDS.has(nocase ? word.toLowerCase() : word) ? 'tok-k' : call ? 'tok-f' : null;
      if (!cls) continue;  // 一般的名稱不上色，跟前後的文字併在一起
    }
    push(null, code.slice(last, m.index));
    push(cls, text);
    last = m.index + text.length;
  }
  push(null, code.slice(last));
  return out;
}
