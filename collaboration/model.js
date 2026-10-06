// Independent objects and fields merge; same-field concurrent edits resolve
// deterministically through Yjs. Character-level text collaboration is deferred.
import * as Y from 'yjs';
export const LOCAL = 'local-edit';
export const encode = bytes => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};
export const decode = value => typeof Buffer !== 'undefined'
  ? new Uint8Array(Buffer.from(value, 'base64'))
  : Uint8Array.from(atob(value), char => char.charCodeAt(0));

export function project(doc) {
  return [...doc.getMap('items').values()].map(value => value.toJSON())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .map(({ order, ...item }) => item);
}

// Diff against the last BOARD projection, not the latest remote state. Thus a
// remote object unseen by a user during a gesture is never deleted by its commit.
export function publish(doc, before, after) {
  const old = new Map(before.map(item => [item.id, item]));
  const next = new Map(after.map(item => [item.id, item]));
  const items = doc.getMap('items');
  let order = Math.max(0, ...[...items.values()].map(item => item.get('order') ?? 0)) + 1;
  doc.transact(() => {
    for (const id of old.keys()) if (!next.has(id)) items.delete(id);
    for (const [id, item] of next) {
      const previous = old.get(id);
      let shared = items.get(id);
      if (!shared) {
        // A remote deletion wins over an edit to an object already visible.
        if (previous) continue;
        shared = new Y.Map();
        items.set(id, shared);
        shared.set('order', order++);
      }
      for (const [key, value] of Object.entries(item)) {
        if (!previous || JSON.stringify(previous[key]) !== JSON.stringify(value)) shared.set(key, structuredClone(value));
      }
      if (previous) for (const key of Object.keys(previous)) if (!(key in item)) shared.delete(key);
    }
  }, LOCAL);
}
