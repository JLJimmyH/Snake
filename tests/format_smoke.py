"""Text formatting and scaling, image rotation and crop, zoom-independent sizes."""
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

def drag(page, locator, dx, dy):
    x,y=center(locator)
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=8);page.mouse.up()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1400,'height':950})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#f00';ctx.fillRect(0,0,20,20);ctx.fillStyle='#00f';ctx.fillRect(20,0,20,20);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve));
      await db.put('blobs',blob,'fmt-image');
      await db.put('docs',{pageId:id,view:{x:0,y:0,s:1},items:[
        {id:'t',type:'text',x:100,y:100,size:20,text:'Hello world'},
        {id:'img',type:'image',x:500,y:100,w:200,h:100,blobId:'fmt-image'}
      ]});
    }""")
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    text_bar=page.locator('.ctx[data-ctx=text]');image_bar=page.locator('.ctx[data-ctx=image]')
    expect(text_bar).to_be_hidden();expect(image_bar).to_be_hidden()

    # Whole-box formatting from the toolbar.
    x,y=center(page.locator('.text-item'));page.mouse.click(x,y)
    expect(text_bar).to_be_visible();expect(image_bar).to_be_hidden()
    text_bar.locator('[data-fmt=bold]').click();saved(page)
    text_bar.locator('[data-fmt=italic]').click();saved(page)
    text_bar.locator('[aria-controls=text-palette]').click();page.locator('#text-palette [data-color="#dc2626"]').click();saved(page)
    text_bar.locator('.font-toggle').click();page.locator('.font-opt[data-font=serif]').click();saved(page)
    text_bar.locator('[data-fmt=bigger]').click();saved(page)
    t=item(page,'t')
    assert t['bold'] and t['italic'] and t['color']=='#dc2626' and t['font']=='serif' and t['size']==25,t
    expect(page.locator('.text-item')).to_have_css('font-weight','700')
    expect(page.locator('.text-item')).to_have_css('font-style','italic')
    expect(page.locator('.text-item')).to_have_css('color','rgb(220, 38, 38)')
    expect(text_bar.locator('[data-fmt=bold]')).to_have_attribute('aria-pressed','true')
    text_bar.locator('[data-fmt=bold]').click();saved(page)
    assert 'bold' not in item(page,'t')
    page.locator('#btn-undo').click();saved(page);assert item(page,'t')['bold']
    print('PASS: bold, italic, color, font and size buttons with undo')

    # Corner handle scales the text itself; side handle only changes wrapping width.
    drag(page,page.locator('[data-transform=se]'),60,30);saved(page)
    scaled=item(page,'t');assert scaled['size']>30,scaled
    page.locator('#btn-undo').click();saved(page);assert item(page,'t')['size']==25
    drag(page,page.locator('[data-transform=e]'),80,0);saved(page)
    widened=item(page,'t');assert widened['size']==25 and widened['w']>0,widened
    expect(page.locator('[data-transform=rotate]')).to_be_hidden()
    print('PASS: text scales with the selection handles')

    # Inline Markdown bold while editing.
    x,y=center(page.locator('.text-item'));page.mouse.dblclick(x,y)
    page.keyboard.press('Control+A');page.keyboard.press('Control+B')
    page.locator('#page-title').click();saved(page)
    assert item(page,'t')['text']=='**Hello world**',item(page,'t')
    expect(page.locator('.text-body strong')).to_have_text('Hello world')
    print('PASS: Ctrl+B wraps the highlighted text in Markdown')

    # New text and strokes keep the same size at any zoom.
    page.locator('#zoom-in').click();page.locator('#zoom-in').click();saved(page)
    assert state(page)['view']['s']==1.5
    page.locator('.tool[data-tool=text]').click()
    expect(text_bar).to_be_visible()  # format for the next new text box
    vp=page.locator('#viewport').bounding_box()
    page.mouse.click(vp['x']+300,vp['y']+600);page.keyboard.type('zoomed')
    page.locator('#page-title').click();saved(page)
    new_text=next(it for it in state(page)['items'] if it.get('text')=='zoomed')
    assert new_text['size']==25,new_text  # 最後一次調整的字級（上面拉側邊把手時是 25），不乘縮放
    page.locator('.tool[data-tool=pen]').click()
    page.mouse.move(vp['x']+300,vp['y']+700);page.mouse.down();page.mouse.move(vp['x']+400,vp['y']+720,steps=5);page.mouse.up();saved(page)
    stroke=next(it for it in state(page)['items'] if it['type']=='stroke')
    assert stroke['width']==3,stroke
    page.locator('.tool[data-tool=select]').click()
    page.locator('#zoom').click();saved(page)
    print('PASS: text size and stroke width do not depend on zoom')

    # Image rotation: toolbar button, then the rotate handle.
    x,y=center(page.locator('.img-item'));page.mouse.click(x,y)
    expect(image_bar).to_be_visible();expect(text_bar).to_be_hidden()
    image_bar.locator('[data-img=rotate]').click();saved(page)
    assert item(page,'img')['rot']==90
    page.locator('#btn-undo').click();saved(page);assert 'rot' not in item(page,'img')
    drag(page,page.locator('[data-transform=rotate]'),120,60);saved(page)
    rotated=item(page,'img');assert rotated.get('rot'),rotated
    page.locator('#btn-undo').click();saved(page)
    print('PASS: image rotation from the toolbar and the handle')

    # Crop: drag the right edge in, Enter applies; left edge stays put.
    image_bar.locator('[data-img=crop]').click()
    expect(page.locator('.crop-frame')).to_be_visible()
    s=state(page)['view']['s']
    drag(page,page.locator('[data-crop=e]'),-80*s,0)
    page.keyboard.press('Enter');saved(page)
    expect(page.locator('.crop-frame')).to_have_count(0)
    cropped=item(page,'img')
    assert abs(cropped['crop']['w']-.6)<.01 and cropped['crop']['x']==0,cropped
    assert abs(cropped['w']-120)<1 and abs(cropped['x']-500)<.2 and cropped['h']==100,cropped
    # Double-click reopens crop; tapping elsewhere without changes keeps the crop.
    x,y=center(page.locator('.img-item'));page.mouse.dblclick(x,y)
    expect(page.locator('.crop-frame')).to_be_visible()
    page.mouse.click(vp['x']+50,vp['y']+800);saved(page)  # tapping elsewhere finishes
    expect(page.locator('.crop-frame')).to_have_count(0)
    assert item(page,'img')==cropped
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    assert item(page,'img')==cropped
    assert page.locator('.img-item img').evaluate("img=>img.style.width").startswith('166.6')
    print('PASS: crop applies, persists and survives reload')
    assert not errors,errors
    browser.close()
