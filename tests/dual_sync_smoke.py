"""A notebook synced to a local file and to Google Drive at the same time: one edit reaches both; a change that
arrives from another device through Drive is written into the local file; a change made to the local file elsewhere
is uploaded to Drive. Google and the file pickers are simulated (OPFS handles, tests/fake_drive.py)."""
import io, json, os, sys, zipfile
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_drive import FakeDrive
BASE = os.environ.get('NOTE_TEST_ORIGIN', 'http://127.0.0.1:8040')
GIS = """window.google={accounts:{oauth2:{initTokenClient(options){return {requestAccessToken(){options.callback({access_token:'token-alice',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'})}}}}}};"""
PICKERS = """
const opfs=()=>navigator.storage.getDirectory();
window.showSaveFilePicker=async()=>(await opfs()).getFileHandle('notes.zip',{create:true});
window.showOpenFilePicker=async()=>[await (await opfs()).getFileHandle('notes.zip')];
"""

def local_titles(page):
    return page.evaluate("""async()=>{const {readZip}=await import('./js/notebook-core.js');
      const file=await (await (await navigator.storage.getDirectory()).getFileHandle('notes.zip')).getFile();
      return (await readZip(file)).pages.map(p=>p.title).sort()}""")

def local_strokes(page):
    return page.evaluate("""async()=>{const {readZip}=await import('./js/notebook-core.js');
      const file=await (await (await navigator.storage.getDirectory()).getFileHandle('notes.zip')).getFile();
      return (await readZip(file)).docs.flatMap(d=>d.items).filter(i=>i.type==='stroke').length}""")

def drive_titles(fake, file_id):
    with zipfile.ZipFile(io.BytesIO(fake.files['alice'][file_id]['data'])) as z:
        return sorted(p['title'] for p in json.loads(z.read('pages.json')))

def drive_strokes(fake, file_id):
    with zipfile.ZipFile(io.BytesIO(fake.files['alice'][file_id]['data'])) as z:
        return sum(1 for n in z.namelist() if n.startswith('docs/') for i in json.loads(z.read(n))['items'] if i['type'] == 'stroke')

def until(page, check, timeout=30):
    for _ in range(timeout * 10):
        if check(): return
        page.wait_for_timeout(100)
    assert check()

def context(browser, fake, pickers=False):
    ctx = browser.new_context(viewport={'width': 1300, 'height': 900})
    ctx.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=GIS))
    ctx.route('https://www.googleapis.com/**', fake.route)
    if pickers: ctx.add_init_script(PICKERS)
    return ctx

def draw(page, dy=0):
    page.locator('.tool[data-tool=pen]').click()
    box = page.locator('#viewport').bounding_box(); x, y = box['x'] + 300, box['y'] + 300 + dy
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 40, steps=5); page.mouse.up()
    expect(page.locator('#save-state')).to_have_text('已儲存')

def sync_click(page, label):
    if not page.locator('#sync-dialog').is_visible():
        page.locator('#nb-button').click(); page.locator('#menu button', has_text='儲存與同步').click()
    page.locator('#sync-dialog button', has_text=label).first.click()

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    fake = FakeDrive(); errors = []
    page = context(browser, fake, pickers=True).new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE); expect(page.locator('#page-title')).to_have_value('歡迎使用')

    # 1. 兩個都連結：一筆修改兩邊都收到
    sync_click(page, '選擇檔案'); expect(page.locator('#toast')).to_contain_text('已同步到「notes.zip」', timeout=15000)
    sync_click(page, '存到 Drive'); expect(page.locator('#toast')).to_contain_text('之後的變更會自動同步', timeout=15000)
    page.locator('#sync-close').click()
    file_id = next(iter(fake.files['alice']))
    draw(page)
    until(page, lambda: local_strokes(page) == 1 and drive_strokes(fake, file_id) == 1)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '已儲存', timeout=20000)
    print('PASS: one edit reaches both the local file and Drive')

    # 2. 另一台裝置經由 Drive 加了一頁：合併進這台，也寫進本機檔案
    other = context(browser, fake).new_page(); other.on('pageerror', lambda e: errors.append(str(e)))
    other.goto(BASE)
    other.locator('#nb-button').click(); other.locator('#menu button', has_text='開啟').click(); other.locator('#menu button', has_text='Google Drive').click()
    other.locator('.drive-file button').first.click()
    expect(other.locator('#page-title')).to_have_value('歡迎使用')
    other.locator('#add-root').click(); expect(other.locator('#page-title')).to_have_value('')
    other.locator('#page-title').fill('另一台加的'); other.locator('#page-title').press('Enter')
    other.locator('#sync-button').click(); expect(other.locator('#sync-button')).to_have_attribute('aria-label', '已儲存', timeout=20000)
    page.wait_for_timeout(5100); page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.locator('#tree .pg-title', has_text='另一台加的')).to_have_count(1, timeout=20000)
    until(page, lambda: '另一台加的' in local_titles(page))
    print('PASS: a change from another device through Drive is written into the local file')

    # 3. 本機檔案在別處被改了（例如雲端硬碟電腦版從別台電腦同步過來）：合併進這台，也傳到 Drive
    page.evaluate("""async()=>{const {readZip,packNotebook}=await import('./js/notebook-core.js');
      const handle=await (await navigator.storage.getDirectory()).getFileHandle('notes.zip');
      const c=await readZip(await handle.getFile());
      c.pages.push({id:'fromfile',parentId:null,title:'檔案那邊加的',order:99,open:true,created:1});
      c.docs.push({pageId:'fromfile',view:{x:0,y:0,s:1},items:[]});
      await new Promise(r=>setTimeout(r,30));
      const w=await handle.createWritable(); await w.write(await packNotebook(c)); await w.close();}""")
    page.wait_for_timeout(5100); page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.locator('#tree .pg-title', has_text='檔案那邊加的')).to_have_count(1, timeout=20000)
    until(page, lambda: '檔案那邊加的' in drive_titles(fake, file_id))
    assert sorted(drive_titles(fake, file_id)) == sorted(local_titles(page)), (drive_titles(fake, file_id), local_titles(page))
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '已儲存', timeout=20000)
    print('PASS: a change to the local file made elsewhere is uploaded to Drive')

    assert not errors, errors
    browser.close()
print('dual sync smoke ok')
