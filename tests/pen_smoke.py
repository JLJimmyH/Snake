"""Verify the pen tip draws with the active tool, the pen's eraser end erases whatever tool is active,
and fingers keep drawing as before."""
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
      localStorage.setItem('inputMode','touch');
    }""")
    page.reload();expect(page.locator('.ink path[data-id=stroke]')).to_have_count(1)
    vp=page.locator('#viewport').bounding_box()
    ox,oy=vp['x']+40,vp['y']+40  # 世界座標原點在螢幕上的位置
    count=lambda: len(state(page)['items'])

    # 筆尖照目前的工具畫
    page.click('.tool[data-tool=pen]')
    stroke(page,'pen',ox+100,oy+100,200,40);saved(page)
    assert count()==2
    # 筆尾＝橡皮擦，不管目前是哪個工具
    stroke(page,'pen',ox+250,oy+260,0,80,buttons=32);saved(page)
    ids=[i['id'] for i in state(page)['items']]
    assert 'stroke' not in ids,ids
    expect(page.locator('.eraser-cursor')).to_be_hidden()
    page.locator('#btn-undo').click();saved(page)
    # 只回報 button 5（橡皮擦）的瀏覽器也認得
    page.evaluate("""() => {
      const vp=document.getElementById('viewport');
      const ev=(type,y,b,button)=>new PointerEvent(type,{pointerType:'pen',pointerId:2,isPrimary:true,clientX:%f,clientY:y,buttons:b,button,bubbles:true,cancelable:true});
      vp.dispatchEvent(ev('pointerdown',%f,0,5));
      for(let i=1;i<=6;i++)vp.dispatchEvent(ev('pointermove',%f+i*14,0,-1));
      vp.dispatchEvent(ev('pointerup',%f+84,0,5));
    }""" % (ox+250,oy+260,oy+260,oy+260))
    saved(page)
    assert 'stroke' not in [i['id'] for i in state(page)['items']]
    page.locator('#btn-undo').click();saved(page)
    print("PASS: the pen tip draws and the eraser end erases")

    # 手指照舊：拿著筆工具就畫
    n=count()
    stroke(page,'touch',ox+100,oy+500,120,0);saved(page)
    assert count()==n+1
    print('PASS: fingers still draw with the pen tool')

    assert not errors,errors
    browser.close()
