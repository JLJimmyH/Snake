// 幫 index.html 引用的 CSS／JS 加上內容雜湊（?v=），HTML 跟 JS 才會成對更新。
// GitHub Pages 每個檔案快取 10 分鐘：沒有版本號時，新的 index.html 可能配到快取裡舊的 JS，初始化就失敗。
// 用法：node scripts/stamp.mjs（改完 JS／CSS 後、提交前）；--check 只檢查是不是最新，不寫檔（pre-commit hook、測試用）
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_FILE = 'js/build.js';
const START = '<!-- 版本：scripts/stamp.mjs 產生，不要手改 -->', END = '<!-- /版本 -->';

const read = path => readFileSync(join(ROOT, path), 'utf8');
// Windows checkout 是 CRLF、GitHub 上是 LF：換行統一後再算，不同電腦算出來才一樣
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);

function jsFiles(dir = 'js') {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(d => {
    const path = dir + '/' + d.name;
    return d.isDirectory() ? jsFiles(path) : d.name.endsWith('.js') ? [path] : [];
  }).sort();
}

// 回傳應該寫入的 { 'index.html': 內容, 'js/build.js': 內容 }
export function stamped() {
  const files = jsFiles().filter(f => f !== BUILD_FILE);
  const versions = Object.fromEntries(['css/style.css', ...files].map(f => [f, hash(read(f))]));
  const build = hash(Object.entries(versions).map(([f, v]) => f + ' ' + v).join('\n'));
  const buildJs = `// scripts/stamp.mjs 產生，不要手改。跟 index.html 的 <meta name="build"> 不一樣＝HTML 是快取的舊版，見 js/main.js\nexport const BUILD = '${build}';\n`;
  versions[BUILD_FILE] = hash(buildJs);

  let html = read('index.html');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const imports = Object.fromEntries(Object.keys(versions).filter(f => f.endsWith('.js')).map(f => ['./' + f, `./${f}?v=${versions[f]}`]));
  const block = [
    START,
    `<meta name="build" content="${build}">`,
    '<script type="importmap">',
    JSON.stringify({ imports }, null, 2),
    '</script>',
    END,
  ].join('\n').split('\n').join(eol);
  const at = html.indexOf(START);
  if (at >= 0) html = html.slice(0, at) + block + html.slice(html.indexOf(END) + END.length);
  else html = html.replace(/(<title>.*<\/title>\r?\n)/, `$1${block}${eol}`);
  html = html
    .replace(/href="css\/style\.css(\?v=\w+)?"/, `href="css/style.css?v=${versions['css/style.css']}"`)
    .replace(/src="js\/main\.js(\?v=\w+)?"/, `src="js/main.js?v=${versions['js/main.js']}"`);
  return { 'index.html': html, [BUILD_FILE]: buildJs };
}

// 跟磁碟上不一樣的檔案
export function stale() {
  return Object.entries(stamped()).filter(([f, text]) => {
    try { return read(f).replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n'); } catch { return true; }
  }).map(([f]) => f);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  if (process.argv.includes('--check')) {
    const files = stale();
    if (files.length) {
      console.error(`版本號不是最新（${files.join('、')}）。請執行 npm run stamp 再提交。`);
      process.exit(1);
    }
  } else {
    for (const [f, text] of Object.entries(stamped())) writeFileSync(join(ROOT, f.split('/').join(sep)), text);
    console.log('已更新 index.html 與 js/build.js 的版本號');
  }
}
