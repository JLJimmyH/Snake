import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hash, delta, applyDelta, makeCommit, verifyCommit, resolveTree, heads, validateWorkspace, compareWorkspaces } from '../js/version-core.js';
const digest = char => char.repeat(64);
const tree = value => ({ pages: { a: digest(value) }, docs: { a: digest('b') } });
const workspace = () => ({ pages: [{id:'a',title:'note',parentId:null,order:0}], docs: [{pageId:'a',view:{x:0,y:0,s:1},items:[]}], blobs:new Map() });

test('canonical content hashing ignores object key order and deduplicates bytes', async () => {
  assert.equal(await hash(canonical({b:2,a:1})),await hash(canonical({a:1,b:2})));
  assert.equal(await hash(new Blob(['same'])),await hash(new Blob(['same'])));
});
test('delta records deletion and rebuilds the complete tree', () => {
  const first={pages:{a:digest('a'),b:digest('b')},docs:{a:digest('c'),b:digest('d')}};
  const second=tree('e'); const change=delta(first,second);
  assert.deepEqual(change.pages.remove,['b']); assert.deepEqual(applyDelta(first,change),second);
});
test('snapshot every ten versions bounds reconstruction and verifies integrity', async () => {
  const commits=new Map();let previous=null;
  for(let i=0;i<=12;i++) {
    const next=tree(i%2?'c':'a');
    const commit=await makeCommit({tree:next,previousTree:previous?await resolveTree(previous.id,id=>commits.get(id)):undefined,parent:previous?.id??null,depth:i,device:'test'});
    commits.set(commit.id,commit);previous=commit;
    assert.equal(Boolean(commit.snapshot),i===0||i===10);
  }
  let reads=0;
  assert.deepEqual(await resolveTree(previous.id,id=>{reads++;return commits.get(id)}),tree('a'));
  assert.equal(reads,3);
  const corrupt={...previous,message:'tampered'};await assert.rejects(verifyCommit(corrupt),/校驗/);
});
test('concurrent branches are retained, restore is a new descendant', async () => {
  const root=await makeCommit({tree:tree('a'),device:'a'});
  const a=await makeCommit({tree:tree('c'),previousTree:tree('a'),parent:root.id,depth:1,device:'a'});
  const b=await makeCommit({tree:tree('d'),previousTree:tree('a'),parent:root.id,depth:1,device:'b'});
  assert.deepEqual(new Set(heads([root,a,b]).map(c=>c.id)),new Set([a.id,b.id]));
  const restored=await makeCommit({tree:tree('a'),previousTree:tree('c'),parent:a.id,depth:2,device:'a',restoredFrom:root.id});
  assert.equal(restored.parent,a.id);assert.notEqual(restored.id,root.id);
});
test('restore rejects hierarchy cycles, missing images and unsafe coordinates', () => {
  const cycle=workspace();cycle.pages[0].parentId='a';assert.throws(()=>validateWorkspace(cycle),/循環/);
  const missing=workspace();missing.docs[0].items=[{id:'i',type:'image',x:0,y:0,w:10,h:10,blobId:digest('a')}];assert.throws(()=>validateWorkspace(missing),/圖片/);
  const bad=workspace();bad.docs[0].view.s=0;assert.throws(()=>validateWorkspace(bad));
  const huge=workspace();huge.docs[0].items=[{id:'t',type:'text',x:Infinity,y:0,size:18,text:'x'}];assert.throws(()=>validateWorkspace(huge));
});
test('diff reports text before/after and deleted objects without rendering HTML', () => {
  const before=workspace(),after=workspace();
  before.docs[0].items=[{id:'t',type:'text',text:'old'},{id:'i',type:'image',blobId:'a'}];
  after.docs[0].items=[{id:'t',type:'text',text:'<script>plain text</script>'}];
  const changes=compareWorkspaces(before,after);
  assert.equal(changes.length,2);assert.equal(changes[0].before.text,'old');assert.equal(changes[0].after.text,'<script>plain text</script>');assert.equal(changes[1].action,'刪除');
});
