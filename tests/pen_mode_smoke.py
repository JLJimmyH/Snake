"""Verify the stylus input mode: the first pen contact switches an unchosen device to it, fingers only pan
with drawing tools while the pen draws, and the pen's eraser end erases whatever tool is active."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8030')

def state(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      return db.get('docs',(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage);
    }""")

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

# 合成的 PointerEvent：Playwright 沒辦法直接模擬觸控筆
def stroke(page,kind,x,y,dx,dy,buttons=1,pid=None):
    page.evaluate("""([kind,x,y,dx,dy,buttons,pid]) => {
      const vp=document.getElementById('viewport');
      const ev=(type,cx,cy,b)=>new PointerEvent(type,{pointerType:kind,pointerId:pid,isPrimary:true,
        clientX:cx,clientY:cy,buttons:b,button:type==='pointermove'?-1:(buttons&32?5:0),bubbles:true,cancelable:true});
      vp.dispatchEvent(ev('pointerdown',x,y,buttons));
      for(let i=1;i<=6;i++)vp.dispatchEvent(ev('pointermove',x+dx*i/6,y+dy*i/6,buttons));
      vp.dispatchEvent(ev('pointerup',x+dx,y+dy,0));
    }""",[kind,x,y,dx,dy,buttons,pid or (2 if kind=='pen' else 3)])

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1500,'height':950},has_touch=True)
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'stroke',type:'stroke',tool:'pen',width:6,color:'#123456',pts:[[100,300],[400,300]]}
      ]});
      localStorage.removeItem('inputMode');
    }""")
    page.reload();expect(page.locator('.ink path[data-id=stroke]')).to_have_count(1)
    vp=page.locator('#viewport').bounding_box()
    ox,oy=vp['x']+40,vp['y']+40  # 世界座標原點在螢幕上的位置

    # 沒選過操作方式：第一次用觸控筆就換成觸控筆模式，而且記住
    expect(page.locator('html')).not_to_have_attribute('data-input','pen')
    page.click('.tool[data-tool=pen]')
    stroke(page,'pen',ox+100,oy+100,200,40);saved(page)
    expect(page.locator('html')).to_have_attribute('data-input','pen')
    assert page.evaluate("localStorage.getItem('inputMode')")=='pen'
    items=state(page)['items']
    assert len(items)==2 and items[1]['type']=='stroke',items
    page.click('#btn-appearance')
    expect(page.locator('[data-input-mode=pen]')).to_have_attribute('aria-pressed','true')
    page.keyboard.press('Escape')
    print('PASS: first pen contact switches to stylus mode and draws')

    # 手指拿著筆工具只移動畫布，不畫線
    before=state(page)
    stroke(page,'touch',ox+600,oy+500,-50,30);saved(page)
    after=state(page)
    assert after['items']==before['items'],'finger drew in stylus mode'
    assert abs(after['view']['x']-before['view']['x']+50)<.1 and abs(after['view']['y']-before['view']['y']-30)<.1,(before['view'],after['view'])
    ox,oy=ox-50,oy+30
    print('PASS: fingers pan instead of drawing')

    # 筆的橡皮擦端：拿著筆工具也能擦
    stroke(page,'pen',ox+250,oy+260,0,80,buttons=32);saved(page)
    ids=[i['id'] for i in state(page)['items']]
    assert 'stroke' not in ids,ids
    expect(page.locator('.eraser-cursor')).to_be_hidden()
    print("PASS: the pen's eraser end erases")

    # 手指拿著橡皮擦也只移動畫布
    page.click('.tool[data-tool=eraser]')
    before=state(page)
    stroke(page,'touch',ox+150,oy+120,40,0);saved(page)
    after=state(page)
    assert after['items']==before['items'] and abs(after['view']['x']-before['view']['x']-40)<.1

    # 切回觸控模式：手指又可以畫，觸控筆不會再自動切換
    page.click('#btn-appearance');page.click('[data-input-mode=touch]');page.keyboard.press('Escape')
    page.click('.tool[data-tool=pen]')
    n=len(state(page)['items'])
    stroke(page,'touch',ox+500,oy+500,80,20);saved(page)
    assert len(state(page)['items'])==n+1
    stroke(page,'pen',ox+500,oy+600,80,20);saved(page)
    expect(page.locator('html')).to_have_attribute('data-input','touch')
    print('PASS: touch mode lets fingers draw and stays chosen')

    assert not errors,errors
    browser.close()
