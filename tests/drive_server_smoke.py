"""Google sign-in through the Cloudflare Worker (api/google/*), simulated: connecting redirects away and back,
the sign-in survives a reload without clicking, idle edits upload by themselves, and disconnecting signs out."""
import os, sys
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_drive import FakeDrive
BASE = os.environ.get('NOTE_TEST_ORIGIN', 'http://127.0.0.1:8040')

class FakeWorker:
    """Stands in for worker/index.js; the Google consent screen is skipped (start → straight back with #google=ok)."""
    def __init__(self):
        self.connected = False; self.tokens = 0; self.logouts = 0; self.headers = []
    def route(self, route):
        req = route.request; url = urlparse(req.url); path = url.path.split('/api/google/')[-1]
        json_reply = lambda data, status=200: route.fulfill(status=status, content_type='application/json', body=__import__('json').dumps(data))
        if path == 'status': return json_reply({'connected': self.connected})
        if path == 'start':
            self.connected = True
            back = parse_qs(url.query)['return'][0]
            return route.fulfill(status=302, headers={'Location': back + '#google=ok'})
        if path == 'token' and req.method == 'POST':
            self.headers.append(req.headers.get('x-requested-with'))
            if not self.connected: return json_reply({'error': 'signed out'}, 401)
            self.tokens += 1
            return json_reply({'access_token': 'token-alice', 'expires_in': 3600})
        if path == 'logout' and req.method == 'POST':
            self.connected = False; self.logouts += 1
            return json_reply({'ok': True})
        return json_reply({'error': 'not found'}, 404)

def toast(page, text):
    expect(page.locator('#toast')).to_contain_text(text, timeout=15000)

def draw(page, dy=0):
    page.locator('.tool[data-tool=pen]').click()
    box = page.locator('#viewport').bounding_box(); x, y = box['x'] + 300, box['y'] + 300 + dy
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 40, steps=5); page.mouse.up()
    expect(page.locator('#save-state')).to_have_text('已儲存')

def menu(page, label):
    page.locator('#nb-button').click()
    page.locator('#menu button', has_text=label).first.click()

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    drive = FakeDrive(); worker = FakeWorker(); errors = []
    context = browser.new_context(viewport={'width': 1400, 'height': 1000})
    context.route('**/api/google/**', worker.route)
    context.route('https://www.googleapis.com/**', drive.route)
    # 伺服器模式不該載入或用到瀏覽器版的 Google 登入元件
    context.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body='window.google={accounts:{oauth2:{initTokenClient(){throw new Error("GIS used")}}}}'))
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE); expect(page.locator('#page-title')).to_have_value('歡迎使用')

    # 1. 存到 Drive：整頁跳去 Google 授權，回來後自動接著存
    draw(page)
    menu(page, '儲存與同步'); page.locator('#sync-drive button', has_text='存到 Drive').click()
    toast(page, '已儲存到 alice@example.test 的 Drive，之後的變更會自動同步')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '已儲存')
    assert [f['name'] for f in drive.files['alice'].values()] == ['我的筆記.zip']
    assert '#google' not in page.url, page.url
    assert set(worker.headers) == {'snake-note'}, worker.headers
    print('PASS: connecting goes through the Worker and finishes the save after coming back')

    # 2. 重新整理：不用點就恢復連線；停手後自動上傳
    page.reload(); expect(page.locator('#page-title')).to_have_value('歡迎使用')
    menu(page, '儲存與同步'); expect(page.locator('#sync-foot')).to_contain_text('中斷 Google 連線（alice@example.test）')
    page.locator('#sync-close').click()
    uploads = drive.uploads
    draw(page, 60)
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '儲存 (Ctrl+S)')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '已儲存', timeout=20000)
    assert drive.uploads == uploads + 1
    print('PASS: the sign-in survives a reload and idle edits upload by themselves')

    # 3. 中斷連線：Worker 撤銷登入；之後的變更等使用者重新連線
    menu(page, '儲存與同步'); page.locator('#sync-foot button', has_text='中斷 Google 連線').click()
    toast(page, '已中斷 Google 連線')
    page.wait_for_timeout(300)
    assert worker.logouts == 1 and not worker.connected
    draw(page, 120); page.wait_for_timeout(500)
    menu(page, '儲存與同步'); expect(page.locator('#sync-drive')).to_contain_text('要連線 Google 才能自動同步')
    page.locator('#sync-close').click()
    page.reload(); expect(page.locator('#page-title')).to_have_value('歡迎使用')
    menu(page, '儲存與同步'); expect(page.locator('#sync-drive')).to_contain_text('要連線 Google')
    # 重新連線：再跳一次，回來後把剛剛的變更傳上去
    uploads = drive.uploads
    page.locator('#sync-drive button', has_text='連線 Google').click()
    toast(page, '已連線 alice@example.test 的 Google Drive')
    expect(page.locator('#sync-button')).to_have_attribute('aria-label', '已儲存', timeout=20000)
    assert drive.uploads == uploads + 1
    print('PASS: disconnecting signs out; reconnecting uploads what was waiting')

    assert not errors, errors
    browser.close()
print('drive server smoke ok')
