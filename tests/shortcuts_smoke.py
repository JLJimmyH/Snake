"""Verify the ? shortcuts panel, Esc back to select from any tool or a text box, and that typing in inputs is not hijacked."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1280,'height':900})
    page.goto(BASE+'/index.html')
    page.wait_for_selector('#tree .row')
    panel=page.locator('#shortcuts-panel')
    button=page.locator('#btn-shortcuts')

    expect(button).to_be_visible()
    button.click()
    expect(panel).to_be_visible()
    expect(button).to_have_attribute('aria-expanded','true')
    expect(panel).to_contain_text('橡皮擦')
    box=panel.bounding_box()
    assert box['x']>=8 and box['x']+box['width']<=1280-8, box
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'shortcuts.png'))
    page.keyboard.press('Escape')
    expect(panel).to_be_hidden()

    page.click('#viewport')
    page.keyboard.press('Shift+Slash')
    expect(panel).to_be_visible()
    page.mouse.click(600,500)
    expect(panel).to_be_hidden()

    tool=lambda: page.locator('#viewport').get_attribute('data-tool')
    for key in ['q','w','e','r']:
        page.keyboard.press(key); assert tool()!='select',key
        page.keyboard.press('Escape'); assert tool()=='select',(key,tool())

    # 編輯文字框時按 Esc：結束編輯並回到選取
    page.keyboard.press('r'); page.mouse.click(700,650); page.keyboard.type('hello')
    assert page.evaluate("document.activeElement.classList.contains('text-body')")
    page.keyboard.press('Escape'); assert tool()=='select'
    assert not page.evaluate("document.activeElement.classList.contains('text-body')")
    expect(page.locator('.text-item', has_text='hello')).to_have_count(1)
    # 頁面標題裡打字不受影響
    page.click('#page-title'); page.keyboard.press('q'); assert tool()=='select'
    page.click('#viewport')

    browser.close()
print('shortcuts smoke ok')
