"""Verify stylus handling: the pen tip draws with the active tool and the eraser end erases with any tool,
an eraser contact is remembered until the pen leaves range, a light eraser contact that starts as ink turns
into erasing, touches are ignored as palms while the pen is near, and fingers draw as before once it leaves."""
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

# 合成的 PointerEvent：Playwright 沒辦法直接模擬觸控筆。steps 是 [(x, y, buttons, pointerId)]
def send(page,kind,steps,down=True,up=True,button=0):
    page.evaluate("""([kind,steps,down,up,button]) => {
      const vp=document.getElementById('viewport');
      const ev=(type,[x,y,b,id])=>new PointerEvent(type,{pointerType:kind,pointerId:id,isPrimary:true,
        clientX:x,clientY:y,buttons:b,button:type==='pointermove'?-1:button,bubbles:true,cancelable:true});
      if(down)vp.dispatchEvent(ev('pointerdown',steps[0]));
      for(const s of steps.slice(1))vp.dispatchEvent(ev('pointermove',s));
      if(up)vp.dispatchEvent(ev('pointerup',[...steps.at(-1).slice(0,2),0,steps.at(-1)[3]]));
    }""",[kind,steps,down,up,button])

def line(x,y,dx,dy,buttons=1,pid=2):
    return [(x+dx*i/6,y+dy*i/6,buttons,pid) for i in range(7)]

def pen_leaves(page):
    page.evaluate("""() => document.getElementById('viewport').dispatchEvent(
      new PointerEvent('pointerout',{pointerType:'pen',pointerId:2,bubbles:true,relatedTarget:null}))""")
    page.wait_for_timeout(350)

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
    ids=lambda: [i['id'] for i in state(page)['items']]
    page.click('.tool[data-tool=pen]')

    # 筆尖照目前的工具畫
    send(page,'pen',line(ox+100,oy+100,200,40));saved(page)
    assert len(ids())==2
    page.locator('#btn-undo').click();saved(page)
    print('PASS: the pen tip draws with the active tool')

    # 筆尾＝橡皮擦，不管目前是哪個工具；只回報 button 5 的瀏覽器也認得
    for buttons,button in [(32,5),(0,5)]:
        send(page,'pen',line(ox+250,oy+260,0,80,buttons),button=button);saved(page)
        assert 'stroke' not in ids(),ids()
        page.locator('#btn-undo').click();saved(page);pen_leaves(page)
    expect(page.locator('.eraser-cursor')).to_be_hidden()
    print('PASS: the eraser end erases with any tool')

    # 擦過一次就記著是筆尾：沒標成橡皮擦的輕碰也擦，筆離開範圍後才恢復筆尖
    send(page,'pen',line(ox+150,oy+200,0,40,32),button=5);saved(page)
    before=ids()
    send(page,'pen',line(ox+250,oy+260,0,80));saved(page)
    assert 'stroke' not in ids() and len(ids())>=len(before),ids()
    page.locator('#btn-undo').click();saved(page)
    pen_leaves(page)
    n=len(ids())
    send(page,'pen',line(ox+500,oy+100,80,0));saved(page)
    assert len(ids())==n+1 and 'stroke' in ids()
    page.locator('#btn-undo').click();saved(page)
    print('PASS: an eraser contact is remembered until the pen leaves range')

    # 輕碰先被當筆尖畫，壓下去才標成橡皮擦（還換了 pointerId）：整筆改成擦除，不留墨跡
    pen_leaves(page)
    steps=line(ox+250,oy+220,0,40)+[(ox+250,oy+300,32,7),(ox+250,oy+320,32,7)]
    send(page,'pen',steps);saved(page)
    assert ids()!=['stroke'] and 'stroke' not in ids(),ids()
    assert all(i['type']=='stroke' and i['id']!='stroke' and i['pts'][0][1]==300 for i in state(page)['items']),state(page)['items']
    page.locator('#btn-undo').click();saved(page)
    assert ids()==['stroke']
    pen_leaves(page)
    print('PASS: a light eraser contact that started as ink becomes erasing')

    # 筆靠近時：已經壓著的手掌被中止，新的觸控也不理
    send(page,'touch',line(ox+600,oy+500,80,0,1,3),up=False)
    expect(page.locator('.ink path')).to_have_count(2)
    send(page,'pen',[(ox+620,oy+400,0,2)]*2,down=False,up=False)  # 懸停
    expect(page.locator('.ink path')).to_have_count(1)
    send(page,'touch',[(ox+700,oy+520,0,3)],down=False)  # 手掌離開
    send(page,'touch',line(ox+600,oy+600,80,0,1,4))
    send(page,'touch',line(ox+600,oy+650,80,0,1,5),up=False)
    send(page,'touch',line(ox+700,oy+650,80,0,1,6),up=False)  # 兩個手掌也不會變成雙指縮放
    page.wait_for_timeout(200)
    assert ids()==['stroke'] and state(page)['view']=={'x':40,'y':40,'s':1},state(page)
    send(page,'touch',[(ox+680,oy+650,0,5)],down=False);send(page,'touch',[(ox+780,oy+650,0,6)],down=False)
    print('PASS: touches are ignored as palms while the pen is near')

    # 筆離開範圍後手指照舊畫
    pen_leaves(page)
    send(page,'touch',line(ox+100,oy+500,120,0,1,3));saved(page)
    assert len(ids())==2
    print('PASS: fingers draw again after the pen leaves')

    assert not errors,errors
    browser.close()
