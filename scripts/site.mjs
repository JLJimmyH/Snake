// 把網站本身（index.html、privacy.html、css、js）複製到 dist/，給 Cloudflare Worker 上傳。
// 只上傳這些檔案，node_modules、測試、.env 之類的絕不會跟著出去。wrangler deploy 會自動先跑這支（見 wrangler.jsonc 的 build）。
import { cpSync, rmSync } from 'node:fs';

const SITE = ['index.html', 'privacy.html', 'css', 'js'];
rmSync('dist', { recursive: true, force: true });
for (const path of SITE) cpSync(path, `dist/${path}`, { recursive: true });
console.log('dist/ ready:', SITE.join(', '));
