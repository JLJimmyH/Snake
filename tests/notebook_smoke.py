"""Notebooks: switching, zip import/export, simulated Google OAuth/Drive. No real Google credentials."""
import json, os, re
from urllib.parse import urlparse, parse_qs, unquote
from playwright.sync_api import sync_playwright, expect
BASE = os.environ.get('NOTE_TEST_ORIGIN', 'http://127.0.0.1:8040')
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type,x-upload-content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS', 'Access-Control-Expose-Headers': 'Location'}

class FakeDrive:
    def __init__(self):
        self.files = {}; self.folders = {}; self.sessions = {}; self.next = 0; self.uploads = 0; self.fail_list = False
    def fields(self, file):
        return {k: v for k, v in file.items() if k != 'data'}
    def route(self, route):
        req = route.request; url = urlparse(req.url); q = parse_qs(url.query)
        def reply(status, data, headers={}):
            route.fulfill(status=status, content_type='application/json', headers={**CORS, **headers}, body=json.dumps(data))
        if req.method == 'OPTIONS': return reply(200, {})
        account = req.headers.get('authorization', '').removeprefix('Bearer token-')
        files = self.files.setdefault(account, {}); folders = self.folders.setdefault(account, {})
        if url.path.startswith('/upload/drive/v3/files'):
            if 'upload_id' in q:
                session = self.sessions.pop(q['upload_id'][0])
                self.next += 1; self.uploads += 1
                file = files.setdefault(session['id'] or 'file-' + str(self.next), {'id': session['id'] or 'file-' + str(self.next)})
                file.update({**session['meta'], 'data': req.post_data_buffer, 'size': str(len(req.post_data_buffer)),
                             'headRevisionId': 'rev-' + str(self.next), 'modifiedTime': '2026-10-06T00:00:%02dZ' % self.next})
                return reply(200, self.fields(file))
            file_id = unquote(url.path[len('/upload/drive/v3/files/'):]) if req.method == 'PATCH' else None
            if file_id and file_id not in files: return reply(404, {'error': 'missing'})
            self.next += 1; sid = str(self.next)
            self.sessions[sid] = {'id': file_id, 'meta': json.loads(req.post_data)}
            return reply(200, {}, {'Location': 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + sid})
        path = url.path.split('/drive/v3/')[-1]
        if path == 'about': return reply(200, {'user': {'permissionId': account, 'emailAddress': account + '@example.test'}})
        if path == 'files' and req.method == 'POST':
            self.next += 1; folder = {'id': 'folder-' + str(self.next), **json.loads(req.post_data)}
            assert folder['mimeType'] == 'application/vnd.google-apps.folder', folder
            folders[folder['id']] = folder
            return reply(200, {'id': folder['id']})
        if path == 'files':
            query = q['q'][0]
            if 'vnd.google-apps.folder' in query:
                name = re.search(r"name = '([^']+)'", query).group(1)
                return reply(200, {'files': [{'id': f['id']} for f in folders.values() if f['name'] == name]})
            if self.fail_list: return reply(500, {'error': 'boom'})
            app = re.search(r"key='app' and value='([^']+)'", query).group(1)
            parents = set(re.findall(r"'([^']+)' in parents", query))
            return reply(200, {'files': [self.fields(f) for f in files.values()
                                         if f.get('appProperties', {}).get('app') == app and parents & set(f.get('parents', []))]})
        file = files.get(unquote(path[len('files/'):]))
        if not file: return reply(404, {'error': 'missing'})
        if q.get('alt') == ['media']: return route.fulfill(status=200, content_type='application/zip', headers=CORS, body=file['data'])
        return reply(200, self.fields(file))

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

def menu(page, label):
    page.locator('#nb-button').click()
    page.locator('#menu button', has_text=label).first.click()

def toast(page, text):
    expect(page.locator('#toast')).to_contain_text(text, timeout=15000)

def draw(page, dy=0):
    page.locator('.tool[data-tool=pen]').click()
    box = page.locator('#viewport').bounding_box(); x, y = box['x'] + 300, box['y'] + 300 + dy
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 40, steps=5); page.mouse.up()
    expect(page.locator('#save-state')).to_have_text('已儲存')

def titles(page):
    return page.locator('#tree .pg-title').all_inner_texts()

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
    dialogs.answers = ['專案 A']; menu(page, '新增筆記本')
    expect(page.locator('#nb-name')).to_have_text('專案 A')
    page.locator('#page-title').fill('A 的頁面'); page.locator('#page-title').press('Enter')
    draw(page)
    assert titles(page) == ['A 的頁面'], titles(page)
    menu(page, '我的筆記')
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    assert 'A 的頁面' not in titles(page)
    menu(page, '專案 A')
    expect(page.locator('#page-title')).to_have_value('A 的頁面')
    expect(page.locator('#viewport path, #viewport polyline').first).to_be_attached()

    # 2. Export → import creates an independent local copy.
    page.locator('#file').set_input_files({'name': 'x.png', 'mimeType': 'image/png', 'buffer': bytes.fromhex(
        '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
        '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')})
    expect(page.locator('#viewport img')).to_be_visible()
    expect(page.locator('#save-state')).to_have_text('已儲存')
    with page.expect_download() as download_info: menu(page, '匯出 zip')
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

    # 3. Save to Drive (local → bound), edit marks unsaved, save overwrites the same file.
    menu(page, '專案 A'); expect(page.locator('#nb-name')).to_have_text('專案 A')
    page.locator('#drive-save').click()
    toast(page, '已儲存到 alice@example.test 的 Drive')
    expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    assert [f['name'] for f in fake.files['alice'].values()] == ['專案 A.zip']
    file_id = next(iter(fake.files['alice']))
    assert [f['name'] for f in fake.folders['alice'].values()] == ['SnakeNote'], fake.folders
    folder_id = next(iter(fake.folders['alice']))
    assert fake.files['alice'][file_id]['parents'] == [folder_id]
    draw(page, 60)
    expect(page.locator('#drive-save')).to_have_text('☁ 儲存到 Drive')
    expect(page.locator('#nb-dirty')).to_be_visible()
    page.keyboard.press('Control+s')
    toast(page, '已儲存到')
    expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    assert list(fake.files['alice']) == [file_id] and fake.uploads == 2
    # Panning only is not a change.
    page.locator('#zoom-in').click(); page.wait_for_timeout(700)
    expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    # Rename syncs the Drive file name on the next save.
    dialogs.answers = ['專案 A 改名']; menu(page, '重新命名')
    expect(page.locator('#nb-name')).to_have_text('專案 A 改名')
    expect(page.locator('#drive-save')).to_have_text('☁ 儲存到 Drive')
    page.locator('#drive-save').click(); expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    assert fake.files['alice'][file_id]['name'] == '專案 A 改名.zip'

    # 4. Another device opens it from Drive, edits and saves.
    other = new_context(browser, fake); device = other.new_page(); device.on('pageerror', lambda e: errors.append(str(e))); Dialogs(device)
    device.goto(BASE); expect(device.locator('#nb-name')).to_have_text('我的筆記')
    fake.fail_list = True; menu(device, '從 Drive 開啟')
    expect(device.locator('#drive-files')).to_contain_text('Drive 請求失敗 (500)')
    device.locator('#drive-close').click(); fake.fail_list = False
    fake.files['alice']['stray'] = {**fake.files['alice'][file_id], 'id': 'stray', 'name': '資料夾外.zip', 'parents': ['root']}
    menu(device, '從 Drive 開啟')
    expect(device.locator('.drive-file')).to_have_count(1)
    expect(device.locator('#drive-account')).to_contain_text('alice@example.test')
    row = device.locator('.drive-file', has_text='專案 A 改名'); row.locator('button').click()
    expect(device.locator('#nb-name')).to_have_text('專案 A 改名')
    expect(device.locator('#page-title')).to_have_value('A 的頁面')
    expect(device.locator('#viewport img')).to_be_visible()
    expect(device.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    del fake.files['alice']['stray']
    menu(device, '從 Drive 開啟'); device.locator('.drive-file', has_text='專案 A 改名').locator('button', has_text='切換').click()
    expect(device.locator('#drive-dialog')).not_to_be_visible()
    assert len(notebooks(device)) == 2, 'opening an already open file switches instead of duplicating'
    draw(device, 120); device.locator('#drive-save').click(); expect(device.locator('#drive-save')).to_have_text('☁ 已存到 Drive')

    # 5. First device is now stale. Sync pulls the other device's strokes and
    # stays on the same page; syncing again is a no-op.
    uploads = fake.uploads; strokes = page.locator('.ink path').count()
    expect(page.locator('#drive-sync')).to_be_visible()
    page.locator('#drive-sync').click(); toast(page, '已同步 Drive 上最新的「專案 A 改名」')
    expect(page.locator('.ink path')).to_have_count(strokes + 1)
    expect(page.locator('#page-title')).to_have_value('A 的頁面')
    expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    assert titles(page) == ['A 的頁面'], titles(page)
    page.locator('#drive-sync').click(); toast(page, '已是最新內容')
    assert fake.uploads == uploads
    # Unsaved local edits: cancelling the sync keeps them.
    draw(device, 150); device.locator('#drive-save').click(); expect(device.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    uploads = fake.uploads
    draw(page, 180); strokes = page.locator('.ink path').count()
    dialogs.answers = [False]; page.locator('#drive-sync').click()
    assert '尚未存到 Drive 的變更' in dialogs.last(page)
    expect(page.locator('#drive-sync')).to_be_enabled()
    expect(page.locator('.ink path')).to_have_count(strokes)
    expect(page.locator('#drive-save')).to_have_text('☁ 儲存到 Drive')
    # Saving while stale: cancel keeps Drive untouched, confirm overwrites.
    dialogs.answers = [False]; page.locator('#drive-save').click()
    assert '已被其他裝置修改' in dialogs.last(page)
    expect(page.locator('#drive-save')).to_be_enabled(); page.wait_for_timeout(300)
    assert fake.uploads == uploads
    dialogs.answers = [True]; page.locator('#drive-save').click(); expect(page.locator('#drive-save')).to_have_text('☁ 已存到 Drive')
    assert fake.uploads == uploads + 1

    # 6. Save a copy: new file, current notebook still bound to the original.
    dialogs.answers = ['備份一']; menu(page, '另存副本到 Drive'); toast(page, '已在 alice@example.test 的 Drive 建立「備份一」')
    assert sorted(f['name'] for f in fake.files['alice'].values()) == ['備份一.zip', '專案 A 改名.zip']
    assert len(fake.folders['alice']) == 1 and all(f['parents'] == [folder_id] for f in fake.files['alice'].values())
    assert notebooks(page)[1]['drive']['fileId'] == file_id

    # 7. A different Google account cannot overwrite alice's file.
    page.evaluate("window.testAccount='bob'")
    menu(page, '中斷 Google 連線'); toast(page, '已中斷')
    draw(page, 240); page.locator('#drive-save').click(); toast(page, '存在 alice@example.test 的 Drive')

    # 8. Closing: unsaved Drive changes and local-only notebooks ask first; last one is replaced by an empty notebook.
    dialogs.answers = [False]; menu(page, '關閉筆記本')
    assert '尚未存到 Drive' in dialogs.last(page); expect(page.locator('#nb-name')).to_have_text('專案 A 改名')
    dialogs.answers = [True]; menu(page, '關閉筆記本'); toast(page, '已關閉「專案 A 改名」')
    expect(page.locator('#nb-name')).to_have_text('我的筆記')
    for _ in range(2):
        dialogs.answers = [True]; menu(page, '關閉筆記本')
        assert '只存在這台裝置' in dialogs.last(page)
        expect(page.locator('#drive-save')).to_be_enabled()
    expect(page.locator('#nb-name')).to_have_text('未命名筆記本')
    assert [b['name'] for b in notebooks(page)] == ['未命名筆記本']
    left = page.evaluate("""async()=>{const {db}=await import('./js/db.js');return {pages:(await db.getAll('pages')).length,docs:(await db.getAll('docs')).length,blobs:(await db.getAll('blobs')).length}}""")
    assert left == {'pages': 1, 'docs': 0, 'blobs': 0}, left
    assert len(fake.files['alice']) == 2, 'closing never deletes Drive files'

    assert not errors, errors
    browser.close()
print('notebook smoke ok')
