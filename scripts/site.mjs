// 把網站本身（index.html、privacy.html、css、js）複製到 dist/，並打包即時協作的前端（含 Yjs）到 dist/collab-assets/，
// 給 Cloudflare Worker 上傳。只上傳這些檔案，node_modules、測試、.env 之類的絕不會跟著出去。
// wrangler deploy／dev 會自動先跑這支（見 wrangler.jsonc 的 build）。
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const SITE = ['index.html', 'privacy.html', 'css', 'js'];
rmSync('dist', { recursive: true, force: true });
for (const path of SITE) cpSync(path, `dist/${path}`, { recursive: true });
await build({ entryPoints: ['js/collaboration.js'], outfile: 'dist/collab-assets/collaboration.js', bundle: true, format: 'esm', target: ['es2022'], sourcemap: true, logLevel: 'warning' });
console.log('dist/ ready:', [...SITE, 'collab-assets'].join(', '));
