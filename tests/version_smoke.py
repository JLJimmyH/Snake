"""index.html and the JS/CSS it loads always come from the same version: every module request carries ?v=, a cached old index.html triggers one fresh reload (no loop), and a broken optional feature does not stop the notes from loading."""
import os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8031')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])

    # 每個 JS／CSS 都帶版本號，HTML 換版時一定抓新的
    page=browser.new_page()
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    assets=[]
    page.on('request',lambda r: re.search(r'/(js|css)/',r.url) and assets.append(r.url))
    page.goto(BASE+'/');page.wait_for_selector('.row.active')
    page.wait_for_timeout(1000)
    assert len(assets)>10 and all('?v=' in u for u in assets),[u for u in assets if '?v=' not in u]
    assert not errors,errors
    page.close()
    print('PASS: every module and stylesheet request is versioned')

    # 快取到舊的 index.html（build 對不上新的 JS）：重新抓一次 HTML 再重新整理，只試一次不會無限重整
    page=browser.new_page()
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    docs=[]
    def old_html(route):
        docs.append(route.request.url)
        html=route.fetch().text()
        route.fulfill(body=re.sub(r'<meta name="build" content="\w+">','<meta name="build" content="old">',html),content_type='text/html')
    page.route(re.compile(r'^'+re.escape(BASE)+r'/(index\.html)?(\?.*)?$'),old_html)
    page.goto(BASE+'/');page.wait_for_selector('.row.active')
    page.wait_for_timeout(500)
    assert len(docs)==3,docs  # 第一次載入、cache: 'reload' 重新抓、重新整理後
    expect(page.locator('.text-item').first).to_be_visible()
    assert [e for e in errors if '重新整理中' not in e]==[],errors
    page.close()
    print('PASS: stale index.html reloads once, then loads normally')

    # 附加功能壞掉（例如舊版的 ai-ui.js 找不到 #ai-button）：筆記照樣載入，只提示重新整理
    page=browser.new_page()
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    def broken(route):
        js=route.fetch().text()
        route.fulfill(body=js.replace("const dialog = $('#ai-dialog');","const dialog = $('#ai-dialog'); $('#ai-button').addEventListener('click', () => {});"),content_type='text/javascript')
    page.route(re.compile(r'/js/ai-ui\.js'),broken)
    page.goto(BASE+'/');page.wait_for_selector('.row.active')
    expect(page.locator('#toast')).to_contain_text('AI功能載入失敗，筆記不受影響')
    expect(page.locator('.text-item').first).to_be_visible()
    page.click('#export-button')
    expect(page.locator('#menu button',has_text='交給 AI')).to_be_disabled()
    assert not errors,errors
    print('PASS: a broken optional feature does not block loading the notes')
    browser.close()
