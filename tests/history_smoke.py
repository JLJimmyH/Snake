"""Local history plus simulated Google OAuth/Drive. No real Google credentials."""
import json, os, re
from email.parser import BytesParser
from email import policy
from urllib.parse import urlparse,parse_qs,unquote
from playwright.sync_api import sync_playwright,expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8040')

class FakeDrive:
    def __init__(self):
        self.files={};self.next_id=0;self.account='alice';self.fail_object_once=False;self.fail_commit_response=False;self.expire=False
    def route(self,route):
        req=route.request;url=urlparse(req.url);q=parse_qs(url.query)
        def reply(status,data):route.fulfill(status=status,content_type='application/json',headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'},body=json.dumps(data))
        if req.method=='OPTIONS':return reply(200,{})
        if self.expire:return reply(401,{'error':'expired'})
        account=req.headers.get('authorization','').removeprefix('Bearer token-')
        files=self.files.setdefault(account,{})
        path=url.path.split('/drive/v3/')[-1]
        if path=='about':return reply(200,{'user':{'permissionId':account,'emailAddress':account+'@example.test'}})
        if path=='files/generateIds':
            self.next_id+=1;return reply(200,{'ids':['file-'+str(self.next_id)]})
        if path=='files' and req.method=='GET':
            query=q.get('q',[''])[0]
            filters=re.findall(r"key='([^']+)' and value='([^']+)'",query)
            result=[]
            for file in files.values():
                if all(file['appProperties'].get(k)==v for k,v in filters):
                    result.append({k:v for k,v in file.items() if k!='data'})
            return reply(200,{'files':result})
        if path.startswith('files/'):
            key=unquote(path[6:]);file=files.get(key)
            if not file:return reply(404,{'error':'missing'})
            if q.get('alt')==['media']:return route.fulfill(status=200,content_type=file.get('mimeType','application/octet-stream'),headers={'Access-Control-Allow-Origin':'*'},body=file['data'])
            return reply(200,{k:v for k,v in file.items() if k!='data'})
        if path=='files' and req.method=='POST':
            if q.get('uploadType')==['multipart']:
                message=BytesParser(policy=policy.default).parsebytes(('Content-Type: '+req.headers['content-type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+req.post_data_buffer)
                parts=list(message.iter_parts());meta=json.loads(parts[0].get_payload(decode=True));data=parts[1].get_payload(decode=True)
            else:meta=json.loads(req.post_data);data=b''
            if self.fail_object_once and meta['appProperties']['kind'] in ['json','blob']:
                self.fail_object_once=False;return reply(503,{'error':'temporary'})
            if meta['id'] in files:return reply(409,{'error':'exists'})
            files[meta['id']]={**meta,'size':str(len(data)),'data':data}
            if self.fail_commit_response and meta['appProperties']['kind']=='commit':
                self.fail_commit_response=False;return route.abort('failed')
            return reply(200,{k:v for k,v in files[meta['id']].items() if k!='data'})
        return reply(400,{'error':'unexpected route '+path})

GIS="""window.google={accounts:{oauth2:{initTokenClient(options){return {requestAccessToken(){options.callback({access_token:'token-'+(window.testAccount||'alice'),expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'})}}}}}};"""

def new_context(browser,fake):
    context=browser.new_context(viewport={'width':1400,'height':1000})
    context.route('https://accounts.google.com/gsi/client',lambda r:r.fulfill(content_type='text/javascript',body=GIS))
    context.route('https://www.googleapis.com/**',fake.route)
    return context

def history(page):
    page.locator('#history-button').click();expect(page.locator('#history-dialog')).to_be_visible()

def idle(page):expect(page.locator('#history-close')).to_be_enabled(timeout=30000)

def setup_google(page,account='alice'):
    page.evaluate('(value)=>window.testAccount=value',account)
    page.locator('#drive-settings').evaluate('el=>el.open=true')
    page.locator('#drive-client-id').fill('123456-test.apps.googleusercontent.com')
    page.locator('#drive-save-config').click();idle(page)
    page.locator('#drive-connect').click();idle(page)
    expect(page.locator('#history-account')).to_contain_text(account+'@example.test')

def snapshot(page):
    return page.evaluate("""async()=>{const {db}=await import('./js/db.js');return {pages:await db.getAll('pages'),docs:await db.getAll('docs')}}""")

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    fake=FakeDrive();ctx=new_context(browser,fake);page=ctx.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(BASE);expect(page.locator('#page-title')).to_have_value('歡迎使用')
    # Add an image and nested page; no auth/meta/collaboration cache belongs in history.
    page.evaluate("""async()=>{
      const {db}=await import('./js/db.js');
      const pages=await db.getAll('pages');const root=pages.find(p=>p.title==='歡迎使用');
      const doc=await db.get('docs',root.id);const c=document.createElement('canvas');c.width=c.height=2;
      await db.put('blobs',await new Promise(r=>c.toBlob(r)),'test-image');
      doc.items.push({id:'image-test',type:'image',x:0,y:500,w:20,h:20,blobId:'test-image'});await db.put('docs',doc);
      await db.put('meta','do-not-export','private-auth-example');
    }""")
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    history(page);page.locator('#history-message').fill('Original');page.locator('#history-create').click();idle(page)
    expect(page.locator('.history-row')).to_have_count(1)
    first_id=page.evaluate("async()=>{const {HistoryStore}=await import('./js/version-store.js');return new HistoryStore().head()}")
    page.locator('#history-close').click();page.locator('#page-title').fill('Changed title');page.locator('#page-title').press('Enter')
    history(page);page.locator('#history-message').fill('Changed');page.locator('#history-create').click();idle(page)
    page.locator('.history-row').filter(has_text='Original').get_by_role('button').click();idle(page)
    expect(page.locator('#history-diff')).to_contain_text('圖片')
    page.locator('#history-restore').click();idle(page)
    expect(page.locator('.history-row')).to_have_count(4)
    page.locator('#history-close').click();expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.wait_for_function("document.querySelector('.img-item img')?.naturalWidth===2")
    print('PASS: version capture, image preview, atomic restore and protective versions')
    # Missing object fails BEFORE existing notes are replaced.
    protected=snapshot(page)
    outcome=page.evaluate("""async id=>{
      const {db}=await import('./js/db.js');const {HistoryStore}=await import('./js/version-store.js');
      const store=new HistoryStore();const {objects}=await store.materialize(id);const key=[...objects].find(([,v])=>v.kind==='blob')[0];
      const original=await db.get('objects',key);await db.del('objects',key);
      let rejected=false;try{await store.restore(id)}catch{rejected=true}finally{await db.put('objects',original,key)}return rejected;
    }""",first_id)
    assert outcome and snapshot(page)==protected
    conflict=page.evaluate("""async()=>{
      const {db,commitHistory,snapshotWorkspace}=await import('./js/db.js');
      const snapshot=await snapshotWorkspace();await db.put('pages',{...snapshot.pages[0],title:'concurrent edit'});
      try{await commitHistory({scope:'local',expectedHead:(await db.get('meta','history:local')).head,records:[],head:null,restore:snapshot,expectedRevision:snapshot.revision});return false}catch{return true}
    }""")
    assert conflict
    print('PASS: missing images and concurrent writes abort restore without data loss')
    history(page);setup_google(page)
    assert not fake.files.get('alice'), 'Connect must never upload automatically'
    # Simulate a failed object upload: no commit may be visible remotely.
    fake.fail_object_once=True;page.locator('#drive-upload-current').click();idle(page)
    expect(page.locator('#history-status')).to_contain_text('503')
    assert not any(f['appProperties']['kind']=='commit' for f in fake.files['alice'].values())
    fake.fail_commit_response=True;page.locator('#drive-retry').click();idle(page)
    committed=sum(f['appProperties']['kind']=='commit' for f in fake.files['alice'].values());assert committed==1
    page.locator('#drive-retry').click();idle(page)
    expect(page.locator('#history-status')).to_contain_text('已備份')
    assert sum(f['appProperties']['kind']=='commit' for f in fake.files['alice'].values())==committed
    blobs=sum(f['appProperties']['kind']=='blob' for f in fake.files['alice'].values())
    page.locator('#drive-upload-current').click();idle(page)
    assert sum(f['appProperties']['kind']=='blob' for f in fake.files['alice'].values())==blobs
    assert all(b'do-not-export' not in f['data'] for f in fake.files['alice'].values())
    print('PASS: object-first publication, failed upload retry, lost response idempotency and blob dedup')
    # A second device starts its own branch without replacing Alice's first one.
    ctx2=new_context(browser,fake);second=ctx2.new_page();second.on('pageerror',lambda e:errors.append(str(e)))
    second.goto(BASE);expect(second.locator('#page-title')).to_have_value('歡迎使用')
    history(second);setup_google(second)
    second.locator('#drive-upload-current').click();idle(second)
    expect(second.locator('#history-branch-note')).to_contain_text('分歧')
    second.locator('.history-row').last.get_by_role('button').click();idle(second)
    second.locator('#history-restore').click();idle(second)
    expect(second.locator('#history-status')).to_contain_text('已還原')
    print('PASS: cross-device download/restore and divergent heads retained')
    # Google account switch has no automatic cross-account upload/history copy.
    second.locator('#drive-disconnect').click();idle(second);setup_google(second,'bob')
    expect(second.locator('.history-row')).to_have_count(0)
    assert not fake.files.get('bob')
    fake.expire=True;second.locator('#drive-refresh').click();idle(second)
    expect(second.locator('#history-status')).to_contain_text('過期');fake.expire=False
    print('PASS: account isolation, no automatic upload and expired-token feedback')
    # Upgrade the pre-history database without replacing existing notes.
    legacy_ctx=browser.new_context();legacy=legacy_ctx.new_page()
    legacy_ctx.route('**/legacy.html',lambda r:r.fulfill(content_type='text/html',body='<html><body>legacy</body></html>'))
    legacy.goto(BASE+'/legacy.html')
    legacy.evaluate("""async()=>{
      await new Promise((resolve,reject)=>{
        const req=indexedDB.open('note-mvp',1);
        req.onupgradeneeded=()=>{
          req.result.createObjectStore('pages',{keyPath:'id'});req.result.createObjectStore('docs',{keyPath:'pageId'});
          req.result.createObjectStore('blobs');req.result.createObjectStore('meta');
        };
        req.onsuccess=()=>{
          const db=req.result,tx=db.transaction(['pages','docs','meta'],'readwrite');
          tx.objectStore('pages').put({id:'legacy',title:'Existing notes',parentId:null,order:0,open:true});
          tx.objectStore('docs').put({pageId:'legacy',view:{x:0,y:0,s:1},items:[{id:'old-text',type:'text',x:0,y:0,size:18,text:'Keep me'}]});
          tx.objectStore('meta').put('legacy','lastPage');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
        };
      });
    }""")
    legacy.goto(BASE);expect(legacy.locator('#page-title')).to_have_value('Existing notes');expect(legacy.locator('.text-body')).to_have_text('Keep me')
    history(legacy);legacy.locator('#history-create').click();idle(legacy);expect(legacy.locator('.history-row')).to_have_count(1)
    print('PASS: IndexedDB v1 upgrade preserves existing notes')
    assert not errors,errors
    browser.close()
