"""Notebooks: switching, zip import/export, simulated Google OAuth/Drive. No real Google credentials."""
import io, json, os, re, sys, zipfile
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_drive import FakeDrive
BASE = os.environ.get('NOTE_TEST_ORIGIN', 'http://127.0.0.1:8040')
GIS = """window.google={accounts:{oauth2:{initTokenClient(options){return {requestAccessToken(){options.callback({access_token:'token-'+(window.testAccount||'alice'),expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'})}}}}}};"""

def new_context(browser, fake):
    context = browser.new_context(viewport={'width': 1400, 'height': 1000}, accept_downloads=True)
    context.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=GIS))
    context.route('https://www.googleapis.com/**', fake.route)
    return context

class Dialogs:
    """Answers prompt/confirm in order; fails the test on an unexpected dialog."""
    def __init__(self, page):
        self.answers = []; self.seen = []
        page.on('dialog', self.handle)
    def handle(self, dialog):
        self.seen.append(dialog.message)
        assert self.answers, 'unexpected dialog: ' + dialog.message
        answer = self.answers.pop(0)
        if answer is False: dialog.dismiss()
        else: dialog.accept(answer if isinstance(answer, str) else None)
    def last(self, page):
        """Message of the most recent dialog, once every queued answer has been used."""
        for _ in range(100):
            if not self.answers: return self.seen[-1]
            page.wait_for_timeout(50)
        raise AssertionError('dialog never appeared')

def lib(page):
    """Go up to the sidebar's notebook list (click the current notebook's name)."""
    if page.locator('#library-pane').is_hidden(): page.locator('#nb-button').click()

def book_row(page, name):
    lib(page)
    exact = page.locator('.lib-name', has_text=re.compile('^' + re.escape(name) + '$'))
    return page.locator('#library .lib-row[data-notebook]').filter(has=exact)

def book(page, name):
    """Switch to a notebook from the sidebar list."""
    book_row(page, name).click()

def book_menu(page, name, label):
    row = book_row(page, name); row.hover(); row.locator('[data-act=more]').click()
    page.locator('#menu button', has_text=label).first.click()

def new_book(page, name, where='local'):
    lib(page); page.locator('#lib-new').click()
    page.locator('#new-name').fill(name); page.locator(f'#new-where input[value={where}]').check()
    page.locator('#new-dialog button[type=submit]').click()

def account_menu(page, label):
    page.locator('#account .acct-btn').click(); page.locator('#menu button', has_text=label).click()

def sync_click(page, label):
    """Click a button in the 儲存位置 panel (opened from the top bar, 進階 expanded when needed), then close the panel."""
    if not page.locator('#sync-dialog').is_visible(): page.locator('#sync-button').click()
    button = page.locator('#sync-dialog button', has_text=label).first
    if not button.is_visible(): page.locator('#sync-more summary').click()
    button.click()
    if page.locator('#sync-dialog').is_visible(): page.locator('#sync-close').click()

def save(page):
    page.keyboard.press('Control+s')

SAVED, UNSAVED = '已同步', '等待同步（Ctrl+S 立即同步）'

def toast(page, text):
    expect(page.locator('#toast')).to_contain_text(text, timeout=15000)

def draw(page, dy=0):
    page.locator('.tool[data-tool=pen]').click()
    box = page.locator('#viewport').bounding_box(); x, y = box['x'] + 300, box['y'] + 300 + dy
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 40, steps=5); page.mouse.up()
    expect(page.locator('#save-state')).to_have_text('已儲存')

def titles(page):
    return page.locator('#tree .pg-title').all_inner_texts()

def zip_files(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z: return {name: z.read(name) for name in z.namelist()}

def zip_json(data, name):
    return json.loads(zip_files(data)[name])

def make_zip(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data in files.items(): z.writestr(name, data)
    return out.getvalue()

def page_ids(page):
    """Title → local page ID of the current notebook."""
    return page.evaluate("""async()=>{const {db}=await import('./js/db.js');const id=sessionStorage.getItem('notebook');return Object.fromEntries((await db.getAll('pages')).filter(p=>p.notebookId===id).map(p=>[p.title,p.id]))}""")

def notebooks(page):
    return page.evaluate("""async()=>{const {db}=await import('./js/db.js');return (await db.getAll('notebooks')).sort((a,b)=>a.created-b.created)}""")

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    fake = FakeDrive(); errors = []

    # 1. Fresh install, several notebooks with separate pages.
    ctx = new_context(browser, fake); page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e))); dialogs = Dialogs(page)
    page.goto(BASE)
    expect(page.locator('#nb-name')).to_have_text('我的筆記')
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    new_book(page, '專案 A')
    expect(page.locator('#nb-name')).to_have_text('專案 A')
    expect(page.locator('#pages-pane')).to_be_visible()
    page.locator('#page-title').fill('A 的頁面'); page.locator('#page-title').press('Enter')
    draw(page)
    assert titles(page) == ['A 的頁面'], titles(page)
    book(page, '我的筆記')
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    assert 'A 的頁面' not in titles(page)
    book(page, '專案 A')
    expect(page.locator('#page-title')).to_have_value('A 的頁面')
    expect(page.locator('#viewport path, #viewport polyline').first).to_be_attached()
    # 側欄兩層：點「‹ 筆記本名稱」往上一層（分頁收起來），點清單上目前那本回來
    page.locator('#nb-button').click()
    expect(page.locator('#library-pane')).to_be_visible(); expect(page.locator('.sb-tabs')).to_be_hidden(); expect(page.locator('#tree')).to_be_hidden()
    expect(page.locator('#sidebar .sb-title')).to_have_text('所有筆記本')
    book(page, '專案 A')
    expect(page.locator('#tree')).to_be_visible(); expect(page.locator('#library-pane')).to_be_hidden(); expect(page.locator('#nb-button')).to_be_visible()

    # 2. Export → import creates an independent local copy.
    page.locator('#file').set_input_files({'name': 'x.png', 'mimeType': 'image/png', 'buffer': bytes.fromhex(
        '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
        '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')})
    expect(page.locator('#viewport img')).to_be_visible()
    expect(page.locator('#save-state')).to_have_text('已儲存')
    with page.expect_download() as download_info: sync_click(page, '下載 zip')
    download = download_info.value
    assert download.suggested_filename == '專案 A.zip', download.suggested_filename
    zip_path = download.path()
    page.locator('#nb-import').set_input_files(files=[{'name': '專案 A 匯入.zip', 'mimeType': 'application/zip', 'buffer': open(zip_path, 'rb').read()}])
    toast(page, '已匯入「專案 A 匯入」')
    expect(page.locator('#nb-name')).to_have_text('專案 A 匯入')
    expect(page.locator('#page-title')).to_have_value('A 的頁面')
    expect(page.locator('#viewport img')).to_be_visible()
    books = notebooks(page)
    assert [b['name'] for b in books] == ['我的筆記', '專案 A', '專案 A 匯入'], books
    ids = page.evaluate("""async()=>{const {db}=await import('./js/db.js');return (await db.getAll('pages')).filter(p=>p.title==='A 的頁面').map(p=>p.id)}""")
    assert len(set(ids)) == 2, ids
    page.locator('#nb-import').set_input_files(files=[{'name': 'bad.zip', 'mimeType': 'application/zip', 'buffer': b'not a zip'}])
    toast(page, '不是有效的 zip')
    assert len(notebooks(page)) == 3

    # 3. Save to Drive (local → bound), edit marks unsaved, Ctrl+S syncs the same file, idle edits upload by themselves.
    book(page, '專案 A'); expect(page.locator('#nb-name')).to_have_text('專案 A')
    lib(page); expect(book_row(page, '專案 A').locator('.lib-status')).to_have_text('只存在這個瀏覽器')
    # 還沒連結任何地方：頂列的狀態寫「只在這台」，點一下打開「儲存位置」，提醒只存在這個瀏覽器
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', re.compile('只存在這個瀏覽器'))
    expect(page.locator('#sync-text')).to_have_text('只在這台')
    page.locator('#sync-button').click()
    expect(page.locator('#sync-warn')).to_be_visible()
    sync_click(page, '存到 Drive')
    toast(page, '已儲存到 alice@example.test 的 Drive，之後的變更會自動同步')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    expect(page.locator('#sync-text')).to_have_text('')
    expect(page.locator('#account')).to_contain_text('alice@example.test')
    assert [f['name'] for f in fake.files['alice'].values()] == ['專案 A.zip']
    file_id = next(iter(fake.files['alice']))
    assert [f['name'] for f in fake.folders['alice'].values()] == ['SnakeNote'], fake.folders
    folder_id = next(iter(fake.folders['alice']))
    assert fake.files['alice'][file_id]['parents'] == [folder_id]
    # 檔案裡的頁面 ID 就是這台的 ID（之後每台裝置都用同一組 ID 合併）
    assert zip_json(fake.files['alice'][file_id]['data'], 'pages.json')[0]['id'] == page_ids(page)['A 的頁面']
    draw(page, 60)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', UNSAVED)
    expect(book_row(page, '專案 A').locator('.lib-status')).to_have_text('☁ 等待同步')
    page.keyboard.press('Control+s')
    toast(page, '已和 alice@example.test 的 Drive 同步')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    assert list(fake.files['alice']) == [file_id] and fake.uploads == 2
    # Panning only is not a change.
    page.locator('#zoom-in').click(); page.wait_for_timeout(700)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    # 停手一陣子就自動上傳，不用按儲存
    draw(page, 90)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', UNSAVED)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED, timeout=20000)
    assert fake.uploads == 3
    # Rename syncs the Drive file name on the next save.
    dialogs.answers = ['專案 A 改名']; book_menu(page, '專案 A', '重新命名')
    expect(page.locator('#nb-name')).to_have_text('專案 A 改名')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', UNSAVED)
    save(page); expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    assert fake.files['alice'][file_id]['name'] == '專案 A 改名.zip'

    # 4. Another device opens it from Drive, edits and saves.
    other = new_context(browser, fake); device = other.new_page(); device.on('pageerror', lambda e: errors.append(str(e))); Dialogs(device)
    device.goto(BASE); expect(device.locator('#nb-name')).to_have_text('我的筆記')
    # 筆記本清單：連線 Google 後，Drive 上還沒在這台開過的筆記本跟這台的列在一起
    fake.fail_list = True; lib(device); device.locator('#account .acct-connect').click()
    expect(device.locator('#library')).to_contain_text('Drive 請求失敗 (500)')
    fake.fail_list = False
    fake.files['alice']['stray'] = {**fake.files['alice'][file_id], 'id': 'stray', 'name': '資料夾外.zip', 'parents': ['root']}
    device.locator('#library .lib-retry').click()
    expect(device.locator('#library .lib-row[data-file]')).to_have_count(1)
    expect(device.locator('#account')).to_contain_text('alice@example.test')
    device.locator('#library .lib-row[data-file]', has_text='專案 A 改名').click()
    expect(device.locator('#nb-name')).to_have_text('專案 A 改名')
    expect(device.locator('#page-title')).to_have_value('A 的頁面')
    expect(device.locator('#viewport img')).to_be_visible()
    expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    del fake.files['alice']['stray']
    # 開過的不會再出現成「在 Drive 上」，而是這台的一本
    expect(device.locator('#pages-pane')).to_be_visible(); lib(device)
    expect(device.locator('#library .lib-row[data-file]')).to_have_count(0)
    expect(book_row(device, '專案 A 改名').locator('.lib-status')).to_have_text('☁ 已同步')
    book(device, '專案 A 改名')
    assert len(notebooks(device)) == 2, 'opening an already open file switches instead of duplicating'
    # 這台沒有別本筆記本用掉同樣的 ID，所以沿用檔案的 ID
    assert page_ids(device)['A 的頁面'] == page_ids(page)['A 的頁面']
    draw(device, 120); save(device); expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)

    # 5. First device is stale. Coming back to the tab pulls the other device's strokes and
    # stays on the same page; syncing again is a no-op.
    uploads = fake.uploads; strokes = page.locator('.ink path').count()
    page.wait_for_timeout(5100); page.evaluate("window.dispatchEvent(new Event('focus'))"); toast(page, '已載入其他裝置在 Drive 上的變更')
    expect(page.locator('.ink path')).to_have_count(strokes + 1)
    expect(page.locator('#page-title')).to_have_value('A 的頁面')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    assert titles(page) == ['A 的頁面'], titles(page)
    sync_click(page, '立即同步'); toast(page, '已和 alice@example.test 的 Drive 同步')
    assert fake.uploads == uploads
    # Both changed, different pages: merged without asking, both strokes end up everywhere.
    device.locator('#tree .row', has_text='A 的頁面').hover(); device.locator('#tree .row', has_text='A 的頁面').locator('[data-act=add]').click()
    expect(device.locator('#page-title')).to_have_value('')  # 等新頁面開好，才不會改到原本那頁的標題
    device.locator('#page-title').fill('B 的子頁'); device.locator('#page-title').press('Enter'); draw(device, 30)
    save(device); expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    draw(page, 180); strokes = page.locator('.ink path').count()
    save(page); expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    expect(page.locator('.ink path')).to_have_count(strokes)
    assert sorted(titles(page)) == ['A 的頁面', 'B 的子頁'], titles(page)
    remote = zip_json(fake.files['alice'][file_id]['data'], 'pages.json')
    assert sorted(p['title'] for p in remote) == ['A 的頁面', 'B 的子頁'], remote
    # Both changed the same page: this device keeps its version, the other one becomes a conflict copy.
    device.locator('#tree .row', has_text='A 的頁面').locator('.pg-title').click(); expect(device.locator('#page-title')).to_have_value('A 的頁面')
    sync_click(device, '立即同步'); expect(device.locator('#tree .pg-title')).to_have_count(2)
    expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    draw(device, 210); save(device); expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    draw(page, 240); strokes = page.locator('.ink path').count()
    # 衝突副本的提示很快會被「已同步」蓋掉，直接看頁面清單
    save(page); expect(page.locator('#tree .pg-title', has_text='（衝突副本）')).to_have_count(1, timeout=15000)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    assert sorted(titles(page)) == ['A 的頁面', 'A 的頁面（衝突副本）', 'B 的子頁'], titles(page)
    expect(page.locator('.ink path')).to_have_count(strokes)
    assert sorted(p['title'] for p in zip_json(fake.files['alice'][file_id]['data'], 'pages.json')) == ['A 的頁面', 'A 的頁面（衝突副本）', 'B 的子頁']
    # Another device saved between this device's check and upload: its version is merged in, not lost.
    def squeeze(data):
        files = zip_files(data); pages = json.loads(files['pages.json'])
        pages.append({'id': 'squeezed', 'parentId': None, 'title': '插隊的頁面', 'order': 99, 'open': True, 'created': 1})
        files['pages.json'] = json.dumps(pages).encode(); files['docs/squeezed.json'] = json.dumps({'pageId': 'squeezed', 'view': {'x': 0, 'y': 0, 's': 1}, 'items': []}).encode()
        return make_zip(files)
    fake.inject = squeeze
    draw(page, 270); save(page)
    expect(page.locator('#tree .pg-title', has_text='插隊的頁面')).to_have_count(1, timeout=15000)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    remote = zip_json(fake.files['alice'][file_id]['data'], 'pages.json')
    assert '插隊的頁面' in [p['title'] for p in remote] and len(remote) == 4, remote
    # Old record without a snapshot (saved by the previous version): both changed → the user decides.
    sync_click(device, '立即同步'); expect(device.locator('#tree .pg-title')).to_have_count(4)
    draw(device, 300); save(device); expect(device.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    page.evaluate("""async()=>{const {db}=await import('./js/db.js');const nbs=await db.getAll('notebooks');const nb=nbs.find(n=>n.drive);delete nb.drive.base;await db.put('notebooks',nb,nb.id)}""")
    draw(page, 330); uploads = fake.uploads
    save(page)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '同步需要處理')
    page.locator('#sync-button').click(); expect(page.locator('#sync-drive')).to_contain_text('被別台裝置改過')
    assert fake.uploads == uploads
    page.locator('#sync-drive button', has_text='用這台覆蓋').click()
    expect(page.locator('#sync-drive')).to_contain_text('已自動同步')
    page.locator('#sync-close').click()
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED)
    assert fake.uploads == uploads + 1

    # 6. Save a copy: a new notebook in the list (new page IDs), also saved to the same Drive; the current one stays bound to the original.
    dialogs.answers = ['備份一']; sync_click(page, '另存一份新筆記本'); toast(page, '已建立「備份一」，也存了一份到 alice@example.test 的 Drive')
    assert sorted(f['name'] for f in fake.files['alice'].values()) == ['備份一.zip', '專案 A 改名.zip']
    assert len(fake.folders['alice']) == 1 and all(f['parents'] == [folder_id] for f in fake.files['alice'].values())
    books = notebooks(page)
    assert [b['name'] for b in books] == ['我的筆記', '專案 A 改名', '專案 A 匯入', '備份一'], books
    assert books[1]['drive']['fileId'] == file_id and books[3]['drive']['fileId'] not in (None, file_id)
    expect(page.locator('#nb-name')).to_have_text('專案 A 改名')
    copy_pages = page.evaluate("""async id=>{const {db}=await import('./js/db.js');return (await db.getAll('pages')).filter(p=>p.notebookId===id).map(p=>p.id)}""", books[3]['id'])
    assert len(copy_pages) == 4 and not set(copy_pages) & set(page_ids(page).values()), copy_pages
    expect(book_row(page, '備份一').locator('.lib-status')).to_have_text('☁ 已同步')

    # 7. A different Google account cannot overwrite alice's file; the panel offers to sign in with alice again.
    page.evaluate("window.testAccount='bob'")
    account_menu(page, '中斷 Google 連線'); toast(page, '已中斷')
    expect(page.locator('#account')).to_contain_text('連線 Google Drive')
    draw(page, 240); save(page); toast(page, '存在 alice@example.test 的 Drive')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '同步需要處理')
    page.evaluate("window.testAccount='alice'")
    page.locator('#sync-button').click(); page.locator('#sync-drive button', has_text='改用 alice@example.test 連線').click()
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', SAVED, timeout=20000)
    if page.locator('#sync-dialog').is_visible(): page.locator('#sync-close').click()
    account_menu(page, '中斷 Google 連線'); toast(page, '已中斷')
    draw(page, 270)

    # 8. Removing: unsaved Drive changes and local-only notebooks ask first; last one is replaced by an empty notebook.
    dialogs.answers = [False]; book_menu(page, '專案 A 改名', '從這台移除')
    assert '還沒存到Drive' in dialogs.last(page); expect(page.locator('#nb-name')).to_have_text('專案 A 改名')
    dialogs.answers = [True]; book_menu(page, '專案 A 改名', '從這台移除'); toast(page, '已從這台移除「專案 A 改名」，Drive 上的檔案保留')
    expect(page.locator('#nb-name')).to_have_text('我的筆記')
    for name in ['我的筆記', '專案 A 匯入']:
        dialogs.answers = [True]; book_menu(page, name, '刪除筆記本')
        assert '只存在這個瀏覽器' in dialogs.last(page)
        toast(page, f'已刪除「{name}」')
        expect(page.locator('#sync-button')).to_be_enabled()
    book_menu(page, '備份一', '從這台移除'); toast(page, '已從這台移除「備份一」')
    expect(page.locator('#nb-name')).to_have_text('未命名筆記本')
    assert [b['name'] for b in notebooks(page)] == ['未命名筆記本']
    left = page.evaluate("""async()=>{const {db}=await import('./js/db.js');return {pages:(await db.getAll('pages')).length,docs:(await db.getAll('docs')).length,blobs:(await db.getAll('blobs')).length}}""")
    assert left == {'pages': 1, 'docs': 0, 'blobs': 0}, left
    assert len(fake.files['alice']) == 2, 'closing never deletes Drive files'

    assert not errors, errors
    browser.close()
print('notebook smoke ok')
