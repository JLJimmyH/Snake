"""Selecting strokes with the select tool shows the pen / highlighter settings; changing colour or size restyles
the selected strokes (one undo step per change) while the tool stays select and the brush keeps its own settings."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8032')

def state(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      return db.get('docs',(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage);
    }""")

def item(page, id):
    return next(it for it in state(page)['items'] if it['id']==id)

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1400,'height':950})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'a',type:'stroke',tool:'pen',width:6,color:'#123456',pts:[[100,300],[400,300]]},
        {id:'b',type:'stroke',tool:'pen',width:4,color:'#654321',pts:[[100,400],[400,400]]},
        {id:'h',type:'stroke',tool:'hl',width:20,color:'#fde047',pts:[[100,500],[400,500]]}
      ]});
      localStorage.setItem('inputMode','mouse');
    }""")
    page.reload();expect(page.locator('.ink path')).to_have_count(3)
    toolbar=page.locator('#toolbar')
    pen_bar=page.locator('.opts[data-for=pen]');hl_bar=page.locator('.opts[data-for=hl]')
    vp=page.locator('#viewport').bounding_box()
    ox,oy=vp['x']+40,vp['y']+40
    expect(toolbar).to_have_attribute('data-tool','select')
    expect(pen_bar).to_be_hidden();expect(hl_bar).to_be_hidden()

    # Click one pen stroke: pen settings appear with that stroke's colour and size, tool stays select.
    page.mouse.click(ox+250,oy+300)
    expect(pen_bar).to_be_visible();expect(hl_bar).to_be_hidden()
    expect(toolbar).to_have_attribute('data-tool','select')
    expect(pen_bar.locator('output')).to_have_text('6')
    expect(pen_bar.locator('input[type=color]')).to_have_value('#123456')
    pen_bar.locator('.palette-toggle').click()
    page.locator('#pen-palette [data-color="#dc2626"]').click();saved(page)
    assert item(page,'a')['color']=='#dc2626' and item(page,'b')['color']=='#654321'
    expect(page.locator('.ink path[data-id=a]')).to_have_attribute('stroke','#dc2626')
    expect(toolbar).to_have_attribute('data-tool','select')
    print('PASS: selecting a stroke shows pen settings and a swatch recolours it')

    # Dragging the size slider is one undo step.
    slider=pen_bar.locator('input[type=range]')
    box=slider.bounding_box()
    page.mouse.move(box['x']+2,box['y']+box['height']/2);page.mouse.down()
    page.mouse.move(box['x']+box['width']*0.3,box['y']+box['height']/2,steps=6);page.mouse.up();saved(page)
    w=item(page,'a')['width']
    assert w>6,w
    assert float(page.locator('.ink path[data-id=a]').get_attribute('stroke-width'))==w
    page.locator('#btn-undo').click();saved(page)
    assert item(page,'a')['width']==6 and item(page,'a')['color']=='#dc2626',item(page,'a')
    page.locator('#btn-undo').click();saved(page)
    assert item(page,'a')['color']=='#123456'
    print('PASS: slider drag restyles the stroke as one undo step')

    # Box-select everything: both groups show; each only changes its own kind of stroke.
    page.mouse.click(ox+700,oy+700)
    expect(pen_bar).to_be_hidden()
    page.mouse.move(ox+50,oy+250);page.mouse.down();page.mouse.move(ox+450,oy+550,steps=8);page.mouse.up()
    expect(pen_bar).to_be_visible();expect(hl_bar).to_be_visible()
    hl_bar.locator('.palette-toggle').click()
    page.locator('#hl-palette [data-color="#86efac"]').click();saved(page)
    assert item(page,'h')['color']=='#86efac' and item(page,'a')['color']=='#123456'
    pen_bar.locator('.palette-toggle').click()
    page.locator('#pen-palette [data-color="#2563eb"]').click();saved(page)
    assert item(page,'a')['color']==item(page,'b')['color']=='#2563eb' and item(page,'h')['color']=='#86efac'
    print('PASS: mixed selection shows both groups and each restyles its own strokes')

    # The brush itself is untouched: switching to the pen shows the default brush settings.
    page.click('.tool[data-tool=pen]')
    expect(pen_bar).to_be_visible();expect(hl_bar).to_be_hidden()
    expect(pen_bar.locator('output')).to_have_text('3')
    expect(pen_bar.locator('input[type=color]')).to_have_value('#1f2937')
    assert page.evaluate("() => document.querySelector('.opts[data-for=pen] .palette-toggle').style.getPropertyValue('--brush-color')")=='#1f2937'
    print('PASS: brush settings are separate from the selected strokes')

    assert not errors,errors
    browser.close()
