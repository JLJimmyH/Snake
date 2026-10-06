from playwright.sync_api import sync_playwright, expect
import base64, os, time
BASE = os.environ.get('NOTE_TEST_ORIGIN', 'http://127.0.0.1:8001')
TITLE = 'Shared browser test ' + str(time.time_ns())

def login(page, name):
    page.locator('#collab-button').click()
    page.locator(f'[data-demo-email="{name}@example.test"]').click()
    expect(page.locator('#collab-user')).to_have_text(f'{name}@example.test')

def share(page, email, role):
    if not page.locator('#collab-dialog').is_visible(): page.locator('#collab-button').click()
    page.locator('.collab-page').filter(has_text=TITLE).locator('button').nth(1).click()
    page.locator('#share-email').fill(email)
    page.locator('#share-role').select_option(role)
    page.locator('#share-submit').click()
    expect(page.locator('#collab-share')).to_be_hidden()

def draw(page, offset=0, finish=True):
    page.locator('.tool[data-tool="pen"]').click()
    box=page.locator('#viewport').bounding_box()
    x,y=box['x']+140,box['y']+140+offset
    page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x+100,y+30,steps=10)
    if finish: page.mouse.up()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    a_ctx=browser.new_context(viewport={'width':1280,'height':900})
    b_ctx=browser.new_context(viewport={'width':1280,'height':900})
    e_ctx=browser.new_context(viewport={'width':1280,'height':900})
    for ctx in [a_ctx,b_ctx,e_ctx]:
        ctx.add_init_script("""{
          const NativeSocket = window.WebSocket;
          window.__testSockets = [];
          window.WebSocket = class extends NativeSocket {
            constructor(...args) { super(...args); window.__testSockets.push(this); }
          };
        }""")
    a,b,e=[ctx.new_page() for ctx in [a_ctx,b_ctx,e_ctx]]
    errors=[]
    for page in [a,b,e]:
        page.on('pageerror',lambda error: errors.append(str(error)))
        page.goto(BASE)
        expect(page.locator('#collab-button')).to_be_visible()
    # Empty local page copied into shared room.
    a.locator('#add-root').click(); a.locator('#page-title').fill(TITLE); a.locator('#page-title').press('Enter')
    login(a,'alice'); a.locator('#collab-copy').click()
    expect(a.locator('#collab-state')).to_have_text('已同步')
    share(a,'bob@example.test','editor'); a.locator('#collab-close').click()
    login(b,'bob'); b.locator('.collab-page').filter(has_text=TITLE).locator('button').first.click()
    expect(b.locator('#collab-state')).to_have_text('已同步')
    expect(a.locator('#collab-presence')).to_have_text('2 人在線')
    draw(a,finish=False)
    expect(b.locator('.remote-preview')).to_have_count(1)
    a.mouse.up()
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(1)
    print('PASS: share, join, live in-progress preview and committed stroke')
    # Both start a gesture before either commits it.
    draw(a,60,finish=False); draw(b,120,finish=False)
    a.mouse.up(); b.mouse.up()
    expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(3)
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(3)
    expect(a.locator('#collab-state')).to_have_text('已同步')
    expect(b.locator('#collab-state')).to_have_text('已同步')
    a.locator('#btn-undo').click()
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(2)
    assert b.locator('.ink path:not(.remote-preview)').count()==2
    a.locator('#btn-redo').click()
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(3)
    print('PASS: simultaneous gestures merge; undo/redo preserves peer stroke')
    # Simulate a real connection loss while preserving the loaded application.
    b_ctx.set_offline(True)
    b.evaluate("window.__testSockets.forEach(socket => socket.close())")
    expect(b.locator('#collab-state')).to_contain_text('連線中斷')
    draw(b,180)
    expect(b.locator('#collab-state')).to_contain_text('待同步')
    draw(a,240)
    expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(4)
    b_ctx.set_offline(False)
    expect(b.locator('#collab-state')).to_have_text('已同步',timeout=15000)
    expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(5)
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(5)
    print('PASS: offline edits merge with online peer edits after reconnect')
    # Upload a real PNG and ensure another account can load its private blob.
    png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=')
    a.locator('#file').set_input_files({'name':'pixel.png','mimeType':'image/png','buffer':png})
    expect(b.locator('.img-item')).to_have_count(1)
    b.wait_for_function("document.querySelector('.img-item img')?.naturalWidth === 1")
    expect(a.locator('#collab-state')).to_have_text('已同步')
    print('PASS: private image upload and cross-account download')
    a.locator('.tool[data-tool="text"]').click()
    box=a.locator('#viewport').bounding_box()
    a.mouse.click(box['x']+400,box['y']+400)
    a.locator('.text-body').fill('Shared text box')
    a.locator('#page-title').click()
    expect(b.locator('.text-body')).to_have_text('Shared text box')
    print('PASS: text object synchronizes to peer')
    b.reload(); expect(b.locator('#collab-button')).to_be_visible()
    login(b,'bob'); b.locator('.collab-page').filter(has_text=TITLE).locator('button').first.click()
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(5)
    expect(b.locator('.text-body')).to_have_text('Shared text box')
    b.wait_for_function("document.querySelector('.img-item img')?.naturalWidth === 1")
    print('PASS: reload and rejoin restore durable data, text and image')
    # Invite Eve as viewer and check both UI and original local workflow.
    share(a,'eve@example.test','viewer'); a.locator('#collab-close').click()
    login(e,'eve'); e.locator('.collab-page').filter(has_text=TITLE).locator('button').first.click()
    expect(e.locator('#collab-state')).to_have_text('唯讀・已連線')
    draw(e,180)
    expect(e.locator('.ink path:not(.remote-preview)')).to_have_count(5)
    expect(e.locator('#viewport')).to_have_attribute('data-readonly','true')
    print('PASS: viewer can read but drawing does not modify shared page')
    # Two tabs of the same account share IndexedDB. Both edit offline and close
    # before either syncs: their persisted histories must survive a new session.
    b2=b_ctx.new_page()
    b2.on('pageerror',lambda error: errors.append(str(error)))
    b2.goto(BASE); expect(b2.locator('#collab-button')).to_be_visible()
    login(b2,'bob'); b2.locator('.collab-page').filter(has_text=TITLE).locator('button').first.click()
    expect(b2.locator('.ink path:not(.remote-preview)')).to_have_count(5)
    b_ctx.set_offline(True)
    for tab in [b,b2]: tab.evaluate("window.__testSockets.forEach(socket => socket.close())")
    draw(b,300); draw(b2,360)
    for tab in [b,b2]: expect(tab.locator('#save-state')).to_have_text('已存於本機')
    b.close(); b2.close()
    b_ctx.set_offline(False)
    b=b_ctx.new_page(); b.on('pageerror',lambda error: errors.append(str(error)))
    b.goto(BASE); expect(b.locator('#collab-button')).to_be_visible()
    login(b,'bob'); b.locator('.collab-page').filter(has_text=TITLE).locator('button').first.click()
    expect(b.locator('#collab-state')).to_have_text('已同步',timeout=15000)
    expect(b.locator('.ink path:not(.remote-preview)')).to_have_count(7)
    expect(a.locator('.ink path:not(.remote-preview)')).to_have_count(7)
    print('PASS: two offline tabs retain both edits after close and reopen')
    a.locator('#collab-leave').click()
    expect(a.locator('#page-title')).to_have_value(TITLE)
    expect(a.locator('#page-title')).not_to_have_attribute('readonly','')
    expect(a.locator('.ink path')).to_have_count(0)
    draw(a); expect(a.locator('#save-state')).to_have_text('已儲存')
    print('PASS: leaving collaboration restores untouched original local page')
    assert not errors,errors
    browser.close()
