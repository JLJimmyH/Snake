import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { publish, project, LOCAL } from '../collaboration/model.js';

const stroke = id => ({ id, type: 'stroke', tool: 'pen', color: '#123456', width: 3, pts: [[1, 2], [3, 4]] });

test('concurrent strokes and offline edits merge without deleting unseen objects', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  publish(a, [], [stroke('alice')]);
  publish(b, [], [stroke('bob')]);
  const au = Y.encodeStateAsUpdate(a), bu = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bu); Y.applyUpdate(b, au);
  assert.deepEqual(project(a), project(b));
  assert.equal(project(a).length, 2);
  // Alice's board still displayed only her stroke while Bob's arrived.
  publish(a, [stroke('alice')], [{ ...stroke('alice'), width: 7 }]);
  assert.equal(project(a).find(i => i.id === 'bob').width, 3);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.deepEqual(project(a), project(b));
  a.destroy(); b.destroy();
});

test('local Yjs undo keeps another user’s stroke', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  const undo = new Y.UndoManager(a.getMap('items'), { trackedOrigins: new Set([LOCAL]) });
  publish(a, [], [stroke('alice')]);
  publish(b, [], [stroke('bob')]);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
  undo.undo();
  assert.deepEqual(project(a).map(item => item.id), ['bob']);
  undo.redo();
  assert.equal(project(a).length, 2);
  undo.destroy(); a.destroy(); b.destroy();
});
