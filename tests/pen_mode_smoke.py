"""Verify stylus handling in both input modes: after the first pen contact the device remembers it has a pen,
fingers only pan with drawing tools (and use touch rules with the select tool in mouse mode) while the pen
draws, and the pen's eraser end erases whatever tool is active."""
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

def set_mode(page,mode):
    page.click('#btn-appearance');page.click(f'[data-input-mode={mode}]');page.keyboard.press('Escape')
    expect(page.locator('html')).to_have_attribute('data-input',mode)

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
      localStorage.setItem('inputMode','touch');localStorage.removeItem('pen');
    }""")
    page.reload();expect(page.locator('.ink path[data-id=stroke]')).to_have_count(1)
    expect(page.locator('[data-input-mode]')).to_have_count(2)
    vp=page.locator('#viewport').bounding_box()
    ox,oy=vp['x']+40,vp['y']+40  # 世界座標原點在螢幕上的位置

    def pans(kind,x,y,dx,dy):
        global ox,oy
        before=state(page)
        stroke(page,kind,x,y,dx,dy);saved(page)
        after=state(page)
        assert after['items']==before['items'],f'{kind} changed items'
        assert abs(after['view']['x']-before['view']['x']-dx)<.1 and abs(after['view']['y']-before['view']['y']-dy)<.1,(before['view'],after['view'])
        ox,oy=ox+dx,oy+dy

    # 還沒用過觸控筆：手指可以畫
    page.click('.tool[data-tool=pen]')
    stroke(page,'touch',ox+100,oy+500,120,0);saved(page)
    assert len(state(page)['items'])==2
    page.locator('#btn-undo').click();saved(page)
    print('PASS: fingers draw before any pen is used')

    # 第一次用觸控筆：照樣畫，操作方式不變，記住這台有筆
    stroke(page,'pen',ox+100,oy+100,200,40);saved(page)
    expect(page.locator('html')).to_have_attribute('data-input','touch')
    assert page.evaluate("localStorage.getItem('pen')")=='1'
    assert len(state(page)['items'])==2
    print('PASS: the first pen contact draws and keeps the input mode')

    # 觸控模式＋筆：手指拿著筆、橡皮擦都只移動畫布
    pans('touch',ox+600,oy+500,-50,30)
    page.click('.tool[data-tool=eraser]')
    pans('touch',ox+150,oy+120,40,0)
    print('PASS: touch mode with a pen: fingers pan instead of drawing or erasing')

    # 筆的橡皮擦端：拿著筆工具也能擦
    page.click('.tool[data-tool=pen]')
    stroke(page,'pen',ox+250,oy+260,0,80,buttons=32);saved(page)
    ids=[i['id'] for i in state(page)['items']]
    assert 'stroke' not in ids,ids
    expect(page.locator('.eraser-cursor')).to_be_hidden()
    page.locator('#btn-undo').click();saved(page)
    print("PASS: the pen's eraser end erases")

    # 滑鼠模式＋筆：重新整理後還記得有筆；筆畫線，手指移動畫布
    set_mode(page,'mouse');page.reload();expect(page.locator('.ink path[data-id=stroke]')).to_have_count(1)
    page.click('.tool[data-tool=pen]')
    n=len(state(page)['items'])
    stroke(page,'pen',ox+500,oy+600,80,20);saved(page)
    assert len(state(page)['items'])==n+1
    pans('touch',ox+700,oy+500,-30,-20)
    # 選取工具：手指在空白處拖曳＝移動畫布（不是框選），筆照滑鼠的方式框選
    page.keyboard.press('Escape');assert page.locator('#viewport').get_attribute('data-tool')=='select'
    pans('touch',ox+50,oy+200,500,0)
    expect(page.locator('.sel-box')).to_be_hidden()
    stroke(page,'pen',ox+50,oy+250,450,100)
    expect(page.locator('.sel-box')).to_be_visible()
    print('PASS: mouse mode with a pen: the pen draws and box-selects, fingers pan')

    assert not errors,errors
    browser.close()
