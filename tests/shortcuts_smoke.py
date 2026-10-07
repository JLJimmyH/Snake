"""Verify the ? shortcuts panel, the Q/W/E/R tool keys in the select tool, Esc back to select, and the hidden button on mobile."""
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
    expect(panel).to_contain_text('套索')
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
    for key,name in [('q','pen'),('w','hl'),('e','lasso'),('r','text')]:
        page.keyboard.press(key); assert tool()==name,(key,tool())
        page.keyboard.press('w' if key!='w' else 'q'); assert tool()==name,('only in select',key,tool())
        page.keyboard.press('Escape'); assert tool()=='select',(key,tool())
    page.locator('.tool[data-tool=eraser]').click(); assert tool()=='eraser'
    page.keyboard.press('Escape'); assert tool()=='select'

    # 編輯文字框時按 Esc：結束編輯並回到選取
    page.keyboard.press('r'); page.mouse.click(700,650); page.keyboard.type('hello')
    assert page.evaluate("document.activeElement.classList.contains('text-body')")
    page.keyboard.press('Escape'); assert tool()=='select'
    assert not page.evaluate("document.activeElement.classList.contains('text-body')")
    expect(page.locator('.text-item', has_text='hello')).to_have_count(1)
    # 頁面標題裡打字不受影響
    page.click('#page-title'); page.keyboard.press('q'); assert tool()=='select'
    page.click('#viewport')

    page.set_viewport_size({'width':390,'height':800})
    expect(button).to_be_hidden()
    page.click('#viewport')
    page.keyboard.press('Shift+Slash')
    expect(panel).to_be_hidden()
    browser.close()
print('shortcuts smoke ok')
