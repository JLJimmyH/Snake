"""Verify the theme switch, canvas colors, readable ink on dark canvases and that settings persist."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')

def state(page):
    return page.evaluate("""() => {
      const root=document.documentElement,vp=document.querySelector('#viewport');
      const path=[...document.querySelectorAll('svg.ink path:not(.lasso)')].at(-1); // 剛畫的那條
      return {
        theme:root.dataset.theme,
        board:root.style.getPropertyValue('--board'),
        bg:getComputedStyle(vp).backgroundColor,
        ink:getComputedStyle(vp).color,
        topbar:getComputedStyle(document.querySelector('#main')).backgroundColor,
        dark:vp.classList.contains('dark-canvas'),
        stroke:path?.getAttribute('stroke'),
      };
    }""")

def pick(page, selector):
    if page.locator('#appearance-panel').is_hidden():
        page.click('#btn-appearance')
    page.click('#appearance-panel '+selector)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900},color_scheme='light')
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(BASE+'/')
    page.wait_for_selector('.row.active')

    # 預設跟隨系統（淺色），畫布白色
    s=state(page)
    assert s['theme']=='light' and s['bg']=='rgb(255, 255, 255)' and not s['dark'],s

    # 畫一條黑色筆跡
    page.keyboard.press('p')
    box=page.locator('#viewport').bounding_box()
    x,y=box['x']+box['width']/2,box['y']+box['height']/2
    page.mouse.move(x,y); page.mouse.down()
    for i in range(1,12): page.mouse.move(x+i*12,y+(i%3)*8)
    page.mouse.up()
    page.keyboard.press('v')
    assert state(page)['stroke']=='#1f2937',state(page)

    # 面板開關、Escape 關閉
    page.click('#btn-appearance')
    expect(page.locator('#appearance-panel')).to_be_visible()
    expect(page.locator('#btn-appearance')).to_have_attribute('aria-expanded','true')
    expect(page.locator('[data-theme-option=system]')).to_have_attribute('aria-pressed','true')
    expect(page.locator('[data-canvas=auto]')).to_have_attribute('aria-pressed','true')
    page.keyboard.press('Escape')
    expect(page.locator('#appearance-panel')).to_be_hidden()

    # 深色模式：自動畫布變深，黑筆改用亮色顯示
    pick(page,'[data-theme-option=dark]')
    s=state(page)
    assert s['theme']=='dark' and s['bg']=='rgb(30, 30, 30)' and s['dark'],s
    assert s['topbar']=='rgb(37, 37, 37)',s
    assert s['stroke']!='#1f2937' and int(s['stroke'][1:3],16)>0xc0,s
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'appearance-dark.png'))

    # 深色介面配白紙：筆跡回原色，畫布文字用深色
    pick(page,'[data-canvas="#ffffff"]')
    s=state(page)
    assert s['theme']=='dark' and s['bg']=='rgb(255, 255, 255)' and not s['dark'],s
    assert s['stroke']=='#1f2937' and s['ink']=='rgb(55, 53, 47)',s
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'appearance-dark-ui-white-canvas.png'))

    # 淺色介面配黑板綠
    pick(page,'[data-theme-option=light]')
    pick(page,'[data-canvas="#23302a"]')
    s=state(page)
    assert s['theme']=='light' and s['bg']=='rgb(35, 48, 42)' and s['dark'],s
    assert s['ink']=='rgb(230, 228, 223)' and s['stroke']!='#1f2937',s
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'appearance-light-ui-board.png'))

    # 自訂顏色
    page.locator('#appearance-panel input[type=color]').evaluate("el => { el.value='#ffeecc'; el.dispatchEvent(new Event('input',{bubbles:true})); }")
    s=state(page)
    assert s['bg']=='rgb(255, 238, 204)' and not s['dark'] and s['stroke']=='#1f2937',s
    assert page.locator('#appearance-panel .swatch.active').count()==0

    # 點畫布外面關閉面板
    page.mouse.click(box['x']+40,box['y']+box['height']-40)
    expect(page.locator('#appearance-panel')).to_be_hidden()

    # 重新整理後保留設定（先等筆跡存好）
    expect(page.locator('#save-state')).to_have_text('已儲存')
    page.reload()
    page.wait_for_selector('.row.active')
    s=state(page)
    assert s['theme']=='light' and s['bg']=='rgb(255, 238, 204)' and s['stroke']=='#1f2937',s

    # 跟隨系統：系統切到深色就跟著變
    pick(page,'[data-theme-option=system]')
    pick(page,'[data-canvas=auto]')
    page.emulate_media(color_scheme='dark')
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    s=state(page)
    assert s['bg']=='rgb(30, 30, 30)' and s['dark'],s
    page.emulate_media(color_scheme='light')
    expect(page.locator('html')).to_have_attribute('data-theme','light')

    assert not errors,errors
    browser.close()
print('appearance smoke ok')
