"""Shared pages, end to end: the real Worker and Durable Object run in `wrangler dev`; Google (OAuth, Drive, Picker) is
faked by tests/fake_drive.py. Alice shares a page and invites Bob by email; Bob opens the link, signs in, picks the file
once; then both draw at the same time and see each other's strokes, cursor, selection and presence. The page is written
back to Alice's Drive file and her notebook copy.
Needs Node (npx wrangler) in addition to the usual Playwright setup; run from the repository root."""
import io, json, os, re, subprocess, sys, tempfile, time, urllib.request, zipfile
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_drive import FakeDrive
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = int(os.environ.get('LIVE_WORKER_PORT', '8790')); GOOGLE = WORKER + 1
BASE = f'http://127.0.0.1:{WORKER}'

# 假的 Google 檔案選擇器：一打開就選好檔案（並告訴假的 Drive 這個帳號選過它）
PICKER = """
window.gapi = { load(name, opts) { (opts.callback || opts)(); } };
window.google = window.google || {};
class DocsView {
  setMimeTypes() { return this; } setIncludeFolders() { return this; } setMode() { return this; } setOwnedByMe() { return this; }
  setFileIds(id) { this.id = id; return this; }
}
class PickerBuilder {
  constructor() { this.s = {}; }
  setTitle() { return this; } setAppId() { return this; } setDeveloperKey() { return this; } setLocale() { return this; }
  addView(view) { this.s.view = view; return this; } setOAuthToken(token) { this.s.token = token; return this; } setCallback(cb) { this.s.cb = cb; return this; }
  build() {
    const s = this.s;
    return { setVisible() {
      fetch('https://www.googleapis.com/test/grant?file=' + s.view.id, { headers: { Authorization: 'Bearer ' + s.token } })
        .then(() => s.cb({ action: 'picked', docs: [{ id: s.view.id, name: 'shared.zip' }] }));
    } };
  }
}
google.picker = { ViewId: { DOCS: 'docs' }, DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel' }, DocsView, PickerBuilder };
"""

def start_worker(log):
    g = f'http://127.0.0.1:{GOOGLE}'
    state = tempfile.mkdtemp(prefix='snake-live-')
    cmd = ['npx', '--no-install', 'wrangler', 'dev', '--port', str(WORKER), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false', '--local-upstream', f'127.0.0.1:{WORKER}',
           '--var', f'GOOGLE_ACCOUNTS_URL:{g}', '--var', f'GOOGLE_OAUTH_URL:{g}', '--var', f'GOOGLE_API_URL:{g}',
           '--var', 'GOOGLE_CLIENT_SECRET:test-secret', '--var', 'SESSION_KEY:test-session-key']
    proc = subprocess.Popen(cmd, cwd=ROOT, shell=os.name == 'nt', stdout=log, stderr=subprocess.STDOUT)
    for _ in range(180):
        try:
            if urllib.request.urlopen(BASE + '/api/config', timeout=2).status == 200: return proc
        except Exception: time.sleep(0.5)
    raise RuntimeError('wrangler dev did not start; see the log')

def stop_worker(proc):
    if os.name == 'nt': subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)
    else: proc.terminate()

def context(browser, fake):
    ctx = browser.new_context(viewport={'width': 1300, 'height': 900})
    ctx.route('https://www.googleapis.com/**', fake.route)
    ctx.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body='window.google=window.google||{};'))
    ctx.route('https://apis.google.com/js/api.js', lambda r: r.fulfill(content_type='text/javascript', body=PICKER))
    # 網站還沒設定 Picker 金鑰：測試時換一個假的
    def config(route):
        body = route.fetch().text().replace("GOOGLE_PICKER_KEY = ''", "GOOGLE_PICKER_KEY = 'test-picker-key'")
        route.fulfill(content_type='text/javascript', body=body)
    ctx.route('**/js/drive-config.js*', config)
    # 記下頁面開的 WebSocket，測試斷線時可以把它關掉
    ctx.add_init_script("{const Native=window.WebSocket;window.__sockets=[];window.WebSocket=class extends Native{constructor(...a){super(...a);window.__sockets.push(this)}}}")
    return ctx

def draw(page, x=300, y=300):
    page.locator('.tool[data-tool=pen]').click()
    box = page.locator('#viewport').bounding_box(); x0, y0 = box['x'] + x, box['y'] + y
    page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move(x0 + 80, y0 + 40, steps=6); page.mouse.up()

def toast(page, text):
    expect(page.locator('#toast')).to_contain_text(text, timeout=20000)

def zip_items(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return json.loads(z.read('docs/page.json'))['items']

with sync_playwright() as pw:
    fake = FakeDrive(); fake.serve(GOOGLE)
    log = open(os.path.join(tempfile.gettempdir(), 'snake-live-wrangler.log'), 'w')
    proc = start_worker(log)
    errors = []
    try:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        # 1. Alice 共用「歡迎使用」：先連線 Google（整頁跳轉），回來後接著建立共用檔案
        a = context(browser, fake).new_page(); a.on('pageerror', lambda e: errors.append('alice: ' + str(e)))
        a.goto(BASE); expect(a.locator('#page-title')).to_have_value('歡迎使用')
        row = a.locator('#tree .row.active')
        # 即時協作的程式載入後，頁面選單才有「共用此頁」
        for _ in range(40):
            row.hover(); row.locator('[data-act=more]').click()
            if a.locator('#menu button', has_text='共用此頁').count(): break
            a.keyboard.press('Escape'); a.wait_for_timeout(250)
        assert not errors, errors
        a.locator('#menu button', has_text='共用此頁').click()
        try: expect(a.locator('#share-dialog')).to_contain_text('會在你的 Google Drive', timeout=20000)
        except AssertionError:
            print('DEBUG url', a.url); a.screenshot(path=os.path.join(tempfile.gettempdir(), 'snake-live.png')); raise
        a.locator('#share-dialog button', has_text='開始共用').click()
        expect(a.locator('#share-dialog')).to_contain_text('具有存取權的使用者', timeout=20000)
        expect(a.locator('#share-dialog .share-person')).to_contain_text('Alice（你）')
        pages = [f for f in fake.files['alice'].values() if f.get('appProperties', {}).get('kind') == 'page']
        assert len(pages) == 1, pages
        file_id = pages[0]['id']
        texts = [i for i in zip_items(pages[0]['data']) if i['type'] == 'text']
        assert texts and '歡迎' in texts[0]['text'], texts
        print('PASS: sharing a page creates its own Drive file')

        # 2. 用 email 邀請 Bob（編輯者）：Drive 權限＋Google 寄信，信裡有開啟連結
        a.locator('.share-invite input[type=email]').fill('bob@example.test')
        a.locator('.share-invite button', has_text='傳送').click()
        toast(a, '已邀請 bob@example.test')
        expect(a.locator('#share-dialog .share-person', has_text='Bob')).to_have_count(1)
        a.locator('#share-dialog').screenshot(path=os.path.join(tempfile.gettempdir(), 'snake-share-dialog.png'))
        assert fake.files['alice'][file_id]['perms'] == {'bob': 'writer'}
        invite = fake.files['alice'][file_id]['invites'][0]
        assert invite['notify'] == ['true'] and f'?page={file_id}' in invite['message'], invite
        a.locator('#share-dialog button', has_text='完成').click()
        expect(a.locator('#collab-state')).to_have_text('已同步', timeout=20000)
        expect(a.locator('#share-button')).to_be_visible()
        # 頁面樹的 👥 旁邊是共用給幾個人
        expect(a.locator('#tree .row.active .pg-count')).to_have_text('1', timeout=20000)
        print('PASS: invite by email through Drive permissions')

        # 3. Bob 打開連結：登入 Google、在檔案選擇器選一次，就進到同一頁
        fake.next_user = 'bob'
        b = context(browser, fake).new_page(); b.on('pageerror', lambda e: errors.append('bob: ' + str(e)))
        b.goto(f'{BASE}/?page={file_id}')
        expect(b.locator('#share-dialog')).to_contain_text('別人透過 Google Drive 共用給你', timeout=30000)
        b.locator('#share-dialog button', has_text='選取並開啟').click()
        expect(b.locator('#crumbs')).to_contain_text('共用頁面', timeout=20000)
        expect(b.locator('#crumbs')).to_contain_text('可編輯')
        expect(b.locator('#collab-copy')).to_be_visible()
        expect(b.locator('#page-title')).to_have_value('歡迎使用')
        expect(b.locator('#collab-state')).to_have_text('已同步', timeout=20000)
        expect(b.locator('.text-item').first).to_contain_text('歡迎')
        print('PASS: the invitee opens the link, signs in and picks the file once')

        # 4. 同時畫：兩邊即時看到對方的筆跡
        before = b.locator('.ink path:not(.remote-preview)').count()
        draw(a, 300, 420)
        expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(before + 1, timeout=10000)
        draw(b, 500, 420)
        expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(before + 2, timeout=10000)
        expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(before + 2)
        print('PASS: strokes appear live on both sides')

        # 5. 游標、選取、在線名單
        box = b.locator('#viewport').bounding_box()
        b.mouse.move(box['x'] + 700, box['y'] + 300); b.mouse.move(box['x'] + 720, box['y'] + 320, steps=3)
        expect(a.locator('.peer-cursor')).to_contain_text('Bob', timeout=10000)
        expect(b.locator('.peer-cursor', has_text='Bob')).to_have_count(0)  # 看不到自己
        a.mouse.move(a.locator('#viewport').bounding_box()['x'] + 400, a.locator('#viewport').bounding_box()['y'] + 200)
        expect(b.locator('.peer-cursor')).to_contain_text('Alice', timeout=10000)
        b.locator('.tool[data-tool=select]').click()
        b.mouse.click(box['x'] + 540, box['y'] + 440)  # Bob 剛畫的那一筆
        expect(a.locator('.peer-box')).to_have_count(1, timeout=10000)
        expect(a.locator('.peer-box')).to_contain_text('Bob')
        expect(a.locator('.peer-cursor')).to_contain_text('Bob', timeout=10000)
        expect(a.locator('#collab-presence .presence-dot')).to_have_count(1)
        assert a.locator('#collab-presence .presence-dot').get_attribute('title') == 'Bob'
        a.screenshot(path=os.path.join(tempfile.gettempdir(), 'snake-live-alice.png'))
        b.mouse.move(box['x'] - 50, box['y'] - 50)  # 離開畫布
        expect(a.locator('.peer-cursor', has_text='Bob')).to_have_count(0, timeout=10000)
        print('PASS: cursors, selection and presence are visible to the other person')

        # 5b. 在線名單：點一下列出所有人；手機寬度只顯示人數
        a.locator('#collab-presence').click()
        expect(a.locator('#menu')).to_contain_text('正在看這一頁（2 人）')
        expect(a.locator('#menu')).to_contain_text('Alice（你）')
        expect(a.locator('#menu')).to_contain_text('Bob')
        a.keyboard.press('Escape'); a.mouse.click(5, 300)
        b.set_viewport_size({'width': 390, 'height': 800})
        expect(b.locator('#collab-presence .presence-count')).to_be_visible()
        expect(b.locator('#collab-presence .presence-count')).to_have_text('👥 2')
        expect(b.locator('#collab-presence .presence-dot')).to_be_hidden()
        b.set_viewport_size({'width': 1300, 'height': 900})
        print('PASS: who is online opens from the avatars or, on phones, the head count')

        # 5c. 斷線時照樣能畫，連回來自動送出
        strokes = a.locator('.ink path:not(.remote-preview)').count()
        b.context.set_offline(True)
        b.evaluate("window.__sockets.forEach(s => s.close())")
        expect(b.locator('#collab-state')).to_contain_text('離線', timeout=10000)
        draw(b, 300, 560)
        expect(b.locator('#collab-state')).to_contain_text('可以繼續編輯')
        a.wait_for_timeout(1500)
        assert a.locator('.ink path:not(.remote-preview)').count() == strokes, 'nothing arrives while offline'
        b.context.set_offline(False)
        expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(strokes + 1, timeout=40000)
        expect(b.locator('#collab-state')).to_have_text('已同步', timeout=20000)
        print('PASS: drawing while offline is sent once the connection is back')

        # 6. 寫回 Drive（saver 是先進來的 Alice）與 Alice 筆記本裡的這一頁
        deadline = time.time() + 40
        while time.time() < deadline and len([i for i in zip_items(fake.files['alice'][file_id]['data']) if i['type'] == 'stroke']) < 2:
            a.wait_for_timeout(500)
        strokes = [i for i in zip_items(fake.files['alice'][file_id]['data']) if i['type'] == 'stroke']
        assert len(strokes) >= 2, strokes
        local = a.evaluate("""async()=>{const {db}=await import('./js/db.js');const p=(await db.getAll('pages')).find(p=>p.shared);return (await db.get('docs',p.id)).items.filter(i=>i.type==='stroke').length}""")
        assert local >= 2, local
        print("PASS: the page is written back to the Drive file and to the owner's notebook")

        # 7. 側欄筆記本清單下方的共用頁面：Bob 看得到誰共用給他、能不能改；Alice 看得到共用給幾個人
        b.locator('#collab-leave').click(); expect(b.locator('#crumbs')).not_to_contain_text('共用頁面')
        b.locator('#nb-button').click()
        theirs = b.locator('#library .lib-row[data-shared]')
        expect(theirs).to_have_count(1, timeout=20000)
        expect(theirs).to_contain_text('Alice · 可編輯')
        a.locator('#nb-button').click()
        mine = a.locator('#library .lib-row[data-shared]')
        expect(mine).to_contain_text('1 人可以存取', timeout=20000)
        expect(mine).to_have_class(re.compile('active'))  # 開著的就是這一頁
        print('PASS: shared pages are listed in the sidebar')

        # 8. Bob 從清單打開，複製一份到自己的筆記本：之後跟共用頁各走各的
        theirs.click()
        expect(b.locator('#crumbs')).to_contain_text('Alice 共用給你', timeout=20000)
        expect(b.locator('#collab-state')).to_have_text('已同步', timeout=20000)
        expect(theirs).to_have_class(re.compile('active'))
        strokes = b.locator('.ink path:not(.remote-preview)').count()
        b.locator('#collab-copy').click()
        toast(b, '已把「歡迎使用」複製到「我的筆記」')
        expect(b.locator('#crumbs')).not_to_contain_text('共用頁面')
        expect(b.locator('#page-title')).not_to_have_attribute('readonly', '')
        expect(b.locator('#tree .pg-title', has_text='歡迎使用')).to_have_count(2)
        expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(strokes)
        draw(b, 600, 600); b.wait_for_timeout(1500)
        assert a.locator('.ink path:not(.remote-preview)').count() == strokes, 'the copy is not shared'
        print('PASS: an invitee copies a shared page into their own notebook')

        # 9. Alice 停止共用（頂列「共用」）：移除 Bob 的權限，共用檔案移到垃圾桶，清單上不再有它
        a.locator('#library .lib-row[data-notebook].active').click()
        a.locator('#share-button').click()
        expect(a.locator('#share-dialog')).to_contain_text('具有存取權的使用者', timeout=20000)
        a.once('dialog', lambda d: d.accept())
        a.locator('#share-dialog button', has_text='停止共用這一頁').click()
        toast(a, '已停止共用「歡迎使用」')
        assert fake.files['alice'][file_id].get('trashed') is True and not fake.files['alice'][file_id]['perms']
        expect(a.locator('#tree .row.active .pg-icon')).to_have_text('📄')
        a.locator('#nb-button').click()
        expect(a.locator('#library .lib-row[data-shared]')).to_have_count(0, timeout=20000)
        expect(a.locator('#library')).to_contain_text('還沒有')
        print('PASS: stopping sharing trashes the shared file and removes it from the list')

        # 10. 刪掉共用頁就自動停止共用；沒連線時刪的，下次連上 Google 再停
        a.locator('#library .lib-row[data-notebook].active').click()
        confirms = []
        def accept(dialog): confirms.append(dialog.message); dialog.accept()
        def share_new(title):
            a.locator('#add-root').click(); expect(a.locator('#page-title')).to_have_value('')
            a.locator('#page-title').fill(title); a.locator('#page-title').press('Enter')
            a.locator('#share-button').click(); a.locator('#share-dialog button', has_text='開始共用').click()
            expect(a.locator('#share-dialog')).to_contain_text('具有存取權的使用者', timeout=20000)
            a.locator('.share-invite input[type=email]').fill('bob@example.test'); a.locator('.share-invite button', has_text='傳送').click()
            toast(a, '已邀請 bob@example.test')
            a.locator('#share-dialog button', has_text='完成').click()
            return next(f for f in fake.files['alice'].values() if f['name'] == title + '.zip')
        def delete_current():
            a.once('dialog', accept)
            row = a.locator('#tree .row.active'); row.hover(); row.locator('[data-act=more]').click()
            a.locator('#menu button', has_text='刪除').click()
        gone = share_new('會刪掉的頁'); assert gone['perms'] == {'bob': 'writer'}
        delete_current()
        toast(a, '已停止共用刪掉的頁面：「會刪掉的頁」')
        assert '刪除後會自動停止共用' in confirms[-1], confirms
        assert gone.get('trashed') is True and not gone['perms']
        later = share_new('沒連線時刪的頁')
        a.locator('#account .acct-btn').click(); a.locator('#menu button', has_text='中斷 Google 連線').click()
        toast(a, '已中斷 Google 連線')
        delete_current(); a.wait_for_timeout(1000)
        assert not later.get('trashed') and later['perms'] == {'bob': 'writer'}, 'nothing happens while signed out'
        fake.next_user = 'alice'
        a.locator('#account .acct-connect').click()
        toast(a, '已停止共用刪掉的頁面：「沒連線時刪的頁」')
        assert later.get('trashed') is True and not later['perms']
        print('PASS: deleting a shared page stops sharing it, right away or after signing in again')

        # 11. 清單上留下來的共用頁（這台沒有這一頁，例如舊版刪掉的）：⋯ 停止共用
        orphan = {'id': 'orphan-page', 'name': '舊的共用頁.zip', 'owner': 'alice', 'mimeType': 'application/zip',
                  'appProperties': {'app': 'snake-note-notebook-v1', 'kind': 'page'}, 'perms': {'bob': 'writer'}}
        fake.store(orphan, b'zip'); fake.files['alice']['orphan-page'] = orphan
        a.locator('#nb-button').click()
        a.locator('#account .acct-btn').click(); a.locator('#menu button', has_text='重新整理').click()
        row = a.locator('#library .lib-row[data-shared="orphan-page"]')
        expect(row).to_contain_text('這台沒有這一頁', timeout=20000)
        expect(a.locator('#library .lib-row[data-shared]', has_text='這台沒有這一頁')).to_have_count(1)
        a.once('dialog', accept)
        row.hover(); row.locator('[data-act=more]').click(); a.locator('#menu button', has_text='停止共用').click()
        toast(a, '已停止共用「舊的共用頁」')
        assert orphan.get('trashed') is True and not orphan['perms']
        expect(row).to_have_count(0, timeout=20000)
        print('PASS: leftover shared pages can be unshared from the list')

        assert not errors, errors
        browser.close()
    finally:
        stop_worker(proc); log.close()
print('live smoke ok')
