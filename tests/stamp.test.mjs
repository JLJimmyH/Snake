import test from 'node:test';
import assert from 'node:assert/strict';
import { stale } from '../scripts/stamp.mjs';

test('index.html 的版本號跟 CSS／JS 內容一致（改完請執行 npm run stamp）', () => {
  assert.deepEqual(stale(), []);
});
