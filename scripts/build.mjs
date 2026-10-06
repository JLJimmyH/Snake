import { build } from 'esbuild';
await build({ entryPoints: ['js/collaboration.js'], outfile: 'collab-assets/collaboration.js', bundle: true, format: 'esm', target: ['es2022'], sourcemap: true });
