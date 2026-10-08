"""Sync a notebook to a local zip file (File System Access API). The file pickers are replaced by files in the
origin private file system, which are real FileSystemFileHandles: link, write 5 s after edits without interrupting
text editing, load a file changed elsewhere, conflicts, a missing file, permission prompts, stop, open and close."""
import os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8031')
SAVED,UNSAVED,TROUBLE='已儲存','儲存 (Ctrl+S)','同步需要處理'

PICKERS="""
window.__pick='notes.zip';
const opfs=()=>navigator.storage.getDirectory();
window.showSaveFilePicker=async({suggestedName})=>{window.__suggested=suggestedName;return (await opfs()).getFileHandle(window.__pick,{create:true});};
window.showOpenFilePicker=async()=>[await (await opfs()).getFileHandle(window.__pick)];
// localStorage testPerm=prompt：像重開瀏覽器後一樣要重新允許存取檔案
const proto=FileSystemHandle.prototype, query=proto.queryPermission;
proto.queryPermission=function(o){return localStorage.getItem('testPerm')==='prompt'?Promise.resolve('prompt'):query?query.call(this,o):Promise.resolve('granted');};
proto.requestPermission=function(){window.__asked=(window.__asked||0)+1;localStorage.removeItem('testPerm');return Promise.resolve('granted');};
"""

def read(page, name):
    return page.evaluate("""async name => {
      const {unpackNotebook}=await import('./js/notebook-core.js');
      const file=await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
      const c=await unpackNotebook(file);
      return {titles:c.pages.map(p=>p.title),strokes:c.docs.flatMap(d=>d.items).filter(i=>i.type==='stroke').length,
              texts:c.docs.flatMap(d=>d.items).filter(i=>i.type==='text').map(i=>i.text),modified:file.lastModified};
    }""",name)

def write_external(page, name, title):
    """Another computer (e.g. through OneDrive) replaces the file with a one-page notebook."""
    page.evaluate("""async ([name,title]) => {
      const {packNotebook}=await import('./js/notebook-core.js');
      const blob=await packNotebook({name:'x',pages:[{id:'p1',title,order:0}],docs:[{pageId:'p1',view:{x:0,y:0,s:1},items:[]}],blobs:new Map()});
      await new Promise(r=>setTimeout(r,20));  // lastModified 一定不同
      const w=await (await (await navigator.storage.getDirectory()).getFileHandle(name)).createWritable();
      await w.write(blob);await w.close();
    }""",[name,title])

def notebook(page):
    return page.evaluate("""async()=>{const {db}=await import('./js/db.js');return db.get('notebooks',sessionStorage.getItem('notebook'))}""")

def menu(page, label):
    page.locator('#nb-button').click()
    page.locator('#menu button',has_text=label).first.click()

def sync_dialog(page):
    if not page.locator('#sync-dialog').is_visible(): menu(page,'儲存與同步')
    return page.locator('#sync-local')

def close_dialog(page):
    if page.locator('#sync-dialog').is_visible(): page.locator('#sync-close').click()

def draw(page, dy=0):
    page.locator('.tool[data-tool=pen]').click()
    box=page.locator('#viewport').bounding_box();x,y=box['x']+300,box['y']+300+dy
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+80,y+40,steps=5);page.mouse.up()
    expect(page.locator('#save-state')).to_have_text('已儲存')

def toast(page, text):
    expect(page.locator('#toast')).to_contain_text(text,timeout=15000)

def until(check, timeout=15):
    """Poll until check() is truthy (auto-sync writes the file a few seconds after the last change)."""
    for _ in range(int(timeout*10)):
        if check(): return
        page.wait_for_timeout(100)  # 要經過 Playwright 才會處理 confirm 之類的事件，不能用 time.sleep
    assert check()

def synced(page):
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',SAVED,timeout=15000)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1400,'height':1000})
    context.add_init_script(PICKERS)
    page=context.new_page()
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    confirms=[];page.on('dialog',lambda d:(confirms.append(d.message),d.accept()))
    page.goto(BASE+'/');page.wait_for_selector('.row.active')

    # 1. 選擇檔案：馬上寫一次，預設檔名是筆記本名稱
    local=sync_dialog(page)
    expect(local).to_contain_text('未連結')
    local.locator('button',has_text='選擇檔案').click()
    toast(page,'已同步到「notes.zip」')
    assert page.evaluate('window.__suggested')=='我的筆記.zip'
    expect(local).to_contain_text(re.compile(r'notes\.zip · \d\d:\d\d 已自動同步'))
    close_dialog(page)
    first=read(page,'notes.zip')
    assert '歡迎使用' in first['titles'] and first['strokes']==0,first
    synced(page)
    page.locator('#nb-button').click()
    expect(page.locator('#menu button',has_text='我的筆記').locator('.menu-hint')).to_have_text('💾')
    page.evaluate("document.querySelector('#menu').hidden = true")
    print('PASS: link a file and write it right away')

    # 2. 有變更：停手 5 秒後自動寫入
    draw(page)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',UNSAVED)
    page.wait_for_timeout(2500)
    assert read(page,'notes.zip')['strokes']==0  # 還在等停手
    synced(page)
    assert read(page,'notes.zip')['strokes']==1
    print('PASS: edits are written 5 s after the last change')

    # 3. 自動寫入不會打斷正在編輯的文字框
    page.locator('.tool[data-tool=text]').click()
    box=page.locator('#viewport').bounding_box()
    page.mouse.click(box['x']+700,box['y']+500);page.keyboard.type('typing')
    page.wait_for_timeout(6500)
    assert page.evaluate("document.activeElement.classList.contains('text-body')")
    assert 'typing' in read(page,'notes.zip')['texts']
    page.keyboard.type(' more');page.locator('#page-title').click()
    until(lambda: 'typing more' in read(page,'notes.zip')['texts'])
    synced(page)
    print('PASS: syncing while typing keeps the text box in edit mode')

    # 4. 檔案在別處被改過、這台沒有變更：重新整理（開啟）時直接載入
    write_external(page,'notes.zip','外部修改')
    page.reload();page.wait_for_selector('.row.active')
    toast(page,'已載入「notes.zip」的最新內容')
    expect(page.locator('#page-title')).to_have_value('外部修改')
    synced(page)
    print('PASS: a file changed elsewhere is loaded when there are no local changes')

    # 5. 兩邊都改過：暫停，選「用這台覆蓋」
    draw(page,40)
    write_external(page,'notes.zip','又被改了')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',TROUBLE,timeout=15000)
    expect(page.locator('#sync-button')).to_have_class(re.compile('warn'))
    page.locator('#sync-button').click()  # 有狀況：打開視窗
    local=page.locator('#sync-local')
    expect(local).to_contain_text('檔案在別處被改過')
    local.locator('button',has_text='用這台覆蓋').click()
    expect(local).to_contain_text('已自動同步')
    close_dialog(page)
    until(lambda: read(page,'notes.zip')['titles']==['外部修改'] and read(page,'notes.zip')['strokes']==1)
    synced(page)
    # 再來一次，這次選「載入檔案內容」
    draw(page,80)
    write_external(page,'notes.zip','用檔案的')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',TROUBLE,timeout=15000)
    page.locator('#sync-button').click()
    count=len(confirms)
    page.locator('#sync-local button',has_text='載入檔案內容').click()
    until(lambda: len(confirms)>count)
    assert '取代這台裝置' in confirms[-1]
    close_dialog(page)
    expect(page.locator('#page-title')).to_have_value('用檔案的')
    synced(page)
    print('PASS: conflicts pause syncing until the user overwrites or loads the file')

    # 6. 重開瀏覽器後要重新允許：顯示警告，按「繼續同步」
    page.evaluate("localStorage.setItem('testPerm','prompt')")
    page.reload();page.wait_for_selector('.row.active')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',TROUBLE)
    draw(page)
    page.wait_for_timeout(5500)
    assert read(page,'notes.zip')['strokes']==0  # 沒有權限不會寫
    page.locator('#sync-button').click()
    expect(page.locator('#sync-local')).to_contain_text('要允許存取檔案')
    page.locator('#sync-local button',has_text='繼續同步').click()
    expect(page.locator('#sync-local')).to_contain_text('已自動同步',timeout=15000)
    close_dialog(page)
    assert page.evaluate('window.__asked')==1
    until(lambda: read(page,'notes.zip')['strokes']==1)
    print('PASS: after a browser restart the user resumes syncing with one click')

    # 7. 檔案被刪掉：提示重新選擇
    page.evaluate("async()=>(await navigator.storage.getDirectory()).removeEntry('notes.zip')")
    draw(page,40)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label',TROUBLE,timeout=15000)
    page.locator('#sync-button').click()
    expect(page.locator('#sync-local')).to_contain_text('找不到檔案')
    page.evaluate("window.__pick='moved.zip'")
    page.locator('#sync-local button',has_text='重新選擇').click()
    expect(page.locator('#sync-local')).to_contain_text('moved.zip',timeout=15000)
    close_dialog(page)
    until(lambda: read(page,'moved.zip')['strokes']==2)
    synced(page)
    print('PASS: a missing file asks to choose a new location')

    # 8. 停止同步：檔案留著，之後的變更不再寫入
    before=read(page,'moved.zip')
    sync_dialog(page).locator('button',has_text='停止同步').click()
    toast(page,'已停止同步')
    expect(page.locator('#sync-local')).to_contain_text('未連結')
    close_dialog(page)
    draw(page,120);page.wait_for_timeout(5500)
    assert read(page,'moved.zip')==before
    print('PASS: stop syncing keeps the file and stops writing')

    # 9. 從本機檔案開啟：成為新的一本，之後的變更寫回這個檔案；同一個檔案再開一次只會切換
    menu(page,'開啟');page.locator('#menu button',has_text='本機檔案').click()
    toast(page,'已開啟「moved」')
    expect(page.locator('#nb-name')).to_have_text('moved')
    assert notebook(page)['local']['fileName']=='moved.zip'
    draw(page,160)
    until(lambda: read(page,'moved.zip')['strokes']==3)
    synced(page)
    menu(page,'我的筆記');expect(page.locator('#nb-name')).to_have_text('我的筆記')
    menu(page,'開啟');page.locator('#menu button',has_text='本機檔案').click()
    expect(page.locator('#nb-name')).to_have_text('moved')
    assert len(page.evaluate("async()=>{const {db}=await import('./js/db.js');return db.getAll('notebooks')}"))==2
    print('PASS: open a local file and keep syncing back to it; reopening switches')

    # 10. 關閉有同步的筆記本：不會說「永久刪除」，檔案保留
    count=len(confirms)
    menu(page,'關閉筆記本');toast(page,'已關閉「moved」')
    assert len(confirms)==count,confirms[count:]
    assert read(page,'moved.zip')['strokes']==3
    print('PASS: closing a synced notebook keeps the file and does not warn')

    assert not errors,errors
    browser.close()
