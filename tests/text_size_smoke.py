"""Text size menu (presets and custom), A−/A+, and new text boxes using the last size the user picked, remembered across reloads."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8031')

def state(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      return db.get('docs',(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage);
    }""")

def item(page, id):
    return next(it for it in state(page)['items'] if it['id']==id)

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

def center(locator):
    box=locator.bounding_box()
    return box['x']+box['width']/2,box['y']+box['height']/2

def new_text(page, x, y, text):
    page.locator('.tool[data-tool=text]').click()
    page.mouse.click(x,y)
    page.keyboard.type(text)
    page.locator('#page-title').click();saved(page)
    return next(it for it in state(page)['items'] if it.get('text')==text)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1400,'height':950})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:0,y:0,s:1},items:[
        {id:'t',type:'text',x:100,y:100,size:22.5,w:200,text:'Hello world'},
      ]});
    }""")
    page.reload();expect(page.locator('.text-item')).to_have_count(1)
    bar=page.locator('.ctx[data-ctx=text]')
    vp=page.locator('#viewport').bounding_box()

    # 一開始沒調整過：新文字框是 18
    assert new_text(page,vp['x']+600,vp['y']+400,'first')['size']==18

    # 選取文字框：字級按鈕顯示目前大小，選單選 32，固定寬度等比例縮放
    page.locator('.tool[data-tool=select]').click()
    page.mouse.click(*center(page.locator('[data-id=t]')))
    expect(bar.locator('.size-name')).to_have_text('22.5')
    bar.locator('.size-toggle').click()
    expect(page.locator('#size-menu')).to_be_visible()
    expect(page.locator('.size-opt[aria-pressed=true]')).to_have_count(0)
    page.locator('.size-opt[data-size="32"]').click();saved(page)
    expect(page.locator('#size-menu')).to_be_hidden()
    t=item(page,'t');assert t['size']==32 and abs(t['w']-200*32/22.5)<0.2,t
    expect(bar.locator('.size-name')).to_have_text('32')
    bar.locator('.size-toggle').click()
    expect(page.locator('.size-opt[data-size="32"]')).to_have_attribute('aria-pressed','true')
    page.keyboard.press('Escape')
    page.locator('#btn-undo').click();saved(page);assert item(page,'t')['size']==22.5
    page.locator('#btn-redo').click();saved(page);assert item(page,'t')['size']==32
    print('PASS: size menu sets an exact size, scales fixed width, undo/redo')

    # 新文字框用最後一次調整的字級
    assert new_text(page,vp['x']+600,vp['y']+500,'second')['size']==32

    # A+ 之後新文字框跟著變
    page.locator('.tool[data-tool=select]').click()
    page.mouse.click(*center(page.locator('[data-id=t]')))
    bar.locator('[data-fmt=bigger]').click();saved(page)
    assert item(page,'t')['size']==40
    expect(bar.locator('.size-name')).to_have_text('40')
    assert new_text(page,vp['x']+600,vp['y']+600,'third')['size']==40

    # 自訂字級：輸入數字按 Enter
    page.locator('.tool[data-tool=select]').click()
    page.mouse.click(*center(page.locator('[data-id=t]')))
    bar.locator('.size-toggle').click()
    page.locator('.size-input').fill('21')
    page.locator('.size-input').press('Enter');saved(page)
    assert item(page,'t')['size']==21
    print('PASS: A+ and custom size become the default for new text boxes')

    # 重新整理後還記得
    page.reload();expect(page.locator('.text-item')).to_have_count(4)
    assert new_text(page,vp['x']+600,vp['y']+700,'fourth')['size']==21

    # 文字工具、沒有選文字框時：選字級只改新文字框的預設
    page.locator('.tool[data-tool=text]').click()
    expect(bar).to_be_visible()
    bar.locator('.size-toggle').click()
    page.locator('.size-opt[data-size="14"]').click()
    expect(bar.locator('.size-name')).to_have_text('14')
    assert item(page,'t')['size']==21
    assert new_text(page,vp['x']+900,vp['y']+400,'fifth')['size']==14
    print('PASS: remembered after reload; text tool sets the default without a target')

    assert not errors,errors
    browser.close()
