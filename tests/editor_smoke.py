"""Run against Python static server; NOTE_TEST_ORIGIN overrides port 8003."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8003')

def document(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const pages=await db.getAll('pages');
      const page=pages.find(p=>p.title==='Editor test');
      return await db.get('docs',page.id);
    }""")

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

def drag_handle(page, name, dx, dy):
    handle=page.locator(f'[data-transform={name}]')
    expect(handle).to_be_visible()
    box=handle.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=10);page.mouse.up();saved(page)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1400,'height':1000},permissions=['clipboard-read','clipboard-write'])
    page=context.new_page()
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    page.locator('#add-root').click();page.locator('#page-title').fill('Editor test');page.locator('#page-title').press('Enter')
    page.locator('.tool[data-tool=pen]').click()
    page.locator('[data-for=pen] input[type=color]').evaluate("el=>{el.value='#12ab34';el.dispatchEvent(new Event('input',{bubbles:true}));}")
    page.locator('[data-for=pen] input[type=range]').evaluate("el=>{el.focus();el.value='25.5';el.dispatchEvent(new Event('input',{bubbles:true}));}")
    expect(page.locator('#brush-preview')).to_be_visible()
    expect(page.locator('.brush-dot')).to_have_css('width','25.5px')
    expect(page.locator('.brush-dot')).to_have_css('background-color','rgb(18, 171, 52)')
    box=page.locator('#viewport').bounding_box();x,y=box['x']+200,box['y']+200
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+80,y+60,steps=5);page.mouse.move(x+160,y+20,steps=5);page.mouse.up();saved(page)
    expect(page.locator('#brush-preview')).to_be_hidden()
    initial=document(page)['items'][0]
    assert initial['color']=='#12ab34' and initial['width']==25.5,initial
    print('PASS: custom color, fractional size and actual diameter preview')
    page.locator('.tool[data-tool=select]').click();page.mouse.click(x+80,y+60)
    expect(page.locator('[data-transform=e]')).to_be_visible()
    drag_handle(page,'e',100,0)
    scaled=document(page)['items'][0]
    assert [p[1] for p in scaled['pts']]==[p[1] for p in initial['pts']]
    assert max(p[0] for p in scaled['pts'])-min(p[0] for p in scaled['pts'])>max(p[0] for p in initial['pts'])-min(p[0] for p in initial['pts'])
    page.locator('#btn-undo').click();saved(page)
    assert document(page)['items'][0]==initial
    page.locator('#btn-redo').click();saved(page)
    assert document(page)['items'][0]==scaled
    drag_handle(page,'s',0,80)
    stretched=document(page)['items'][0]
    assert [p[0] for p in stretched['pts']]==[p[0] for p in scaled['pts']]
    assert stretched['pts']!=scaled['pts']
    page.locator('#btn-undo').click();saved(page)
    assert document(page)['items'][0]==scaled
    drag_handle(page,'rotate',120,70)
    rotated=document(page)['items'][0]
    assert rotated['pts']!=scaled['pts']
    page.reload();expect(page.locator('#page-title')).to_have_value('Editor test')
    assert document(page)['items'][0]==rotated
    print('PASS: independent-axis scaling, rotation, undo/redo and reload persistence')
    page.evaluate("text=>navigator.clipboard.writeText(text)",'Pasted text\nSecond line <b>plain</b>')
    page.keyboard.press('Control+V')
    expect(page.locator('.text-body')).to_have_text('Pasted text\nSecond line <b>plain</b>',use_inner_text=True);saved(page)
    assert page.locator('.text-body b').count()==0
    page.locator('#btn-undo').click();expect(page.locator('.text-body')).to_have_count(0)
    page.locator('#btn-redo').click();expect(page.locator('.text-body')).to_have_count(1)
    page.locator('.text-body').evaluate('el=>el.focus()')
    page.keyboard.press('End')
    page.evaluate("()=>navigator.clipboard.writeText(' appended')")
    page.keyboard.press('Control+V')
    expect(page.locator('.text-body')).to_contain_text('appended')
    page.locator('#page-title').click();saved(page)
    assert len(document(page)['items'])==2
    page.locator('.tool[data-tool=select]').click()
    page.evaluate("""async () => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=2;
      canvas.getContext('2d').fillRect(0,0,2,2);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    }""")
    page.keyboard.press('Control+V')
    expect(page.locator('.img-item')).to_have_count(1);saved(page)
    page.wait_for_function("document.querySelector('.img-item img').naturalWidth===2")
    page.reload();expect(page.locator('.text-body')).to_contain_text('Pasted text')
    page.wait_for_function("document.querySelector('.img-item img')?.naturalWidth===2")
    print('PASS: plain text and image clipboard payloads, undo and persistent storage')
    assert not errors,errors
    browser.close()
