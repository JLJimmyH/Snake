"""Verify Ctrl+wheel zoom steps, zoom buttons, fit-to-content, the lost-content hint and the minimap."""
import math
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')

def view(page):
    return page.evaluate("""() => {
      const m=document.querySelector('.world').style.transform.match(/translate\\((.+?)px, (.+?)px\\) scale\\((.+?)\\)/);
      return {x:+m[1],y:+m[2],s:+m[3]};
    }""")

def center(locator):
    box=locator.bounding_box()
    return box['x']+box['width']/2,box['y']+box['height']/2

def all_visible(page):
    return page.evaluate("""() => {
      const v=document.querySelector('#viewport').getBoundingClientRect();
      return [...document.querySelectorAll('.ink path, .item')].every(el => {
        const r=el.getBoundingClientRect();
        return r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1;
      });
    }""")

# Average position of minimap pixels whose color is dominated by one channel.
MAP_PIXELS="""channel => {
  const c=document.querySelector('#minimap canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let sx=0,sy=0,n=0;
  for (let i=0;i<d.length;i+=4) {
    const v=d[i+channel],o=[0,1,2].filter(k=>k!==channel).map(k=>d[i+k]);
    if (v>120&&o.every(x=>v-x>60)) {const p=i/4;sx+=p%c.width;sy+=Math.floor(p/c.width);n++;}
  }
  const r=c.getBoundingClientRect(),k=r.width/c.width;
  return n?{n,x:r.x+sx/n*k,y:r.y+sy/n*k}:{n:0};
}"""

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    # Content near the origin while the saved view is far away: the user is lost.
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      const canvas=document.createElement('canvas');canvas.width=canvas.height=4;
      const g=canvas.getContext('2d');g.fillStyle='#00f';g.fillRect(0,0,4,4);
      await db.put('blobs',await new Promise(resolve=>canvas.toBlob(resolve)),'nav-image');
      await db.put('docs',{pageId:id,view:{x:-40000,y:-30000,s:1},items:[
        {id:'red',type:'stroke',tool:'pen',width:24,color:'#ff0000',pts:[[0,0],[400,0],[400,300]]},
        {id:'text',type:'text',x:0,y:360,size:20,text:'line one\\nline two'},
        {id:'image',type:'image',x:500,y:100,w:200,h:150,blobId:'nav-image'}
      ]});
    }""")
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    expect(page.locator('#back-to-content')).to_be_visible()
    expect(page.locator('#minimap')).to_be_visible()
    expect(page.locator('#toolbar #zoom')).to_have_count(0)
    # Clicking the content on the minimap brings it back into view.
    red=page.evaluate(MAP_PIXELS,0)
    assert red['n']>0,red
    page.mouse.click(red['x'],red['y'])
    expect(page.locator('#back-to-content')).to_be_hidden()
    page.wait_for_timeout(100)
    assert page.evaluate(MAP_PIXELS,2)['n']>0,'image thumbnail missing from minimap'
    # Dragging from inside the viewport frame does not jump, then pans with the pointer.
    before=view(page)
    frame=page.evaluate("""() => {
      const c=document.querySelector('#minimap canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let x0=1e9,y0=1e9,x1=-1,y1=-1;
      for (let i=0;i<d.length;i+=4) if (d[i]<40&&d[i+1]>100&&d[i+1]<140&&d[i+2]>190) { // 畫面框 #0078d4
        const p=i/4,x=p%c.width,y=Math.floor(p/c.width);
        x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
      }
      const r=c.getBoundingClientRect(),k=r.width/c.width;
      return {x:r.x+(x0+x1)/2*k,y:r.y+(y0+y1)/2*k};
    }""")
    page.mouse.move(frame['x'],frame['y']);page.mouse.down()
    assert abs(view(page)['x']-before['x'])<.5 and abs(view(page)['y']-before['y'])<.5
    page.mouse.move(frame['x']+20,frame['y']+10,steps=5);page.mouse.up()
    after=view(page)
    assert after['x']<before['x']-10 and after['y']<before['y']-5 and after['s']==before['s'],(before,after)
    print('PASS: lost hint, minimap click and frame drag')
    # One mouse-wheel notch (deltaY 100) zooms about 10%; small trackpad deltas stay proportional.
    page.locator('#zoom').click()
    x,y=center(page.locator('#viewport'))
    page.mouse.move(x,y);page.keyboard.down('Control')
    for delta,expected in [(-100,math.exp(.1)),(100,math.exp(-.1)),(-3,math.exp(.03))]:
        s=view(page)['s'];page.mouse.wheel(0,delta);page.wait_for_timeout(50)
        assert abs(view(page)['s']/s-expected)<1e-3,(delta,s,view(page)['s'])
    page.keyboard.up('Control')
    before=view(page);page.mouse.wheel(0,100);page.wait_for_timeout(400);after=view(page)
    assert after['s']==before['s'] and abs(after['y']-(before['y']-100))<.01
    expect(page.locator('#zoom')).to_have_text(f"{round(after['s']*100)}%")
    # Zoom buttons step through round percentages.
    page.locator('#zoom').click()
    for button,expected in [('#zoom-in',1.25),('#zoom-in',1.5),('#zoom-out',1.25),('#zoom-out',1),('#zoom-out',.75)]:
        page.locator(button).click();assert abs(view(page)['s']-expected)<1e-6,(button,view(page))
    print('PASS: Ctrl+wheel steps about 10% and zoom buttons')
    # Wheel panning: a notch (100px) glides instead of jumping; small high-resolution deltas
    # (thumb wheels, trackpads) apply at once, on both axes together; Shift+wheel scrolls sideways.
    def moved(before):
        after=view(page);return round(before['x']-after['x'],2),round(before['y']-after['y'],2)
    page.mouse.move(x,y)
    before=view(page);page.mouse.wheel(0,100)
    page.evaluate('new Promise(r=>requestAnimationFrame(r))');first=moved(before)
    assert 0<=first[1]<100,('notch should glide, not jump',first)
    page.wait_for_timeout(400);assert moved(before)==(0,100),moved(before)
    before=view(page);page.mouse.wheel(0,100);page.mouse.wheel(0,100);page.wait_for_timeout(500)
    assert moved(before)==(0,200),'consecutive notches add up'
    before=view(page);page.mouse.wheel(12.5,0);page.wait_for_timeout(20)
    assert moved(before)==(12.5,0),'high-resolution delta applies at once'
    before=view(page);page.mouse.wheel(17.5,0);page.mouse.wheel(0,100);page.wait_for_timeout(400)
    assert moved(before)==(17.5,100),'both wheels together move on both axes'
    page.keyboard.down('Shift');before=view(page);page.mouse.wheel(0,100);page.wait_for_timeout(400)
    page.keyboard.up('Shift');assert moved(before)==(100,0),'shift+wheel scrolls sideways'
    print('PASS: wheel notches glide, high-resolution deltas follow at once')
    # A real MX Master thumb-wheel nudge (ms, deltaX): the device itself keeps sending a decaying
    # tail for about 1.5 s. The tail is trimmed, while a steady turn keeps its full distance.
    NUDGE=[(0,.83),(18,2.5),(22,2.5),(35,2.5),(52,5.83),(71,7.5),(90,10.83),(91,11.67),(103,20),(119,23.33),
      (136,30.83),(153,23.33),(155,26.67),(170,25.83),(186,15.83),(205,15),(221,15.83),(222,15),(235,15.83),
      (250,15.83),(270,15),(286,15.83),(291,14.17),(302,13.33),(320,12.5),(336,10.83),(350,10),(355,9.17),
      (369,8.33),(386,7.5),(404,6.67),(420,5.83),(423,5.83),(436,5),(454,5),(467,4.17),(484,4.17),(489,3.33),
      (504,3.33),(520,2.5),(538,2.5),(553,2.5),(556,2.5),(570,1.67),(587,1.67),(605,1.67),(621,1.67),(623,1.67),
      (637,.83),(654,1.67),(672,.83),(687,.83),(690,.83),(703,.83),(748,.83),(818,.83),(864,.83),(890,.83),
      (942,.83),(991,.83),(1081,.83),(1201,.83),(1497,.83)]
    def replay(events):
        return page.evaluate('''async events => {
          const vp=document.querySelector('#viewport'),r=vp.getBoundingClientRect(),t0=performance.now(),xs=[];
          const x=()=>+document.querySelector('.world').style.transform.match(/translate\((.+?)px/)[1];
          const start=x();
          for (const [ms,dx] of events) {
            await new Promise(res=>setTimeout(res,Math.max(0,t0+ms-performance.now())));
            vp.dispatchEvent(new WheelEvent('wheel',{deltaX:dx,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}));
            xs.push([ms,start-x()]);
          }
          return xs;
        }''',events)
    page.wait_for_timeout(300)
    xs=replay(NUDGE);raw=sum(dx for _,dx in NUDGE);total=xs[-1][1]
    after_peak=total-next(d for ms,d in xs if ms>=400)
    assert total<raw*.75,(total,raw)
    assert after_peak<10,('tail after 400 ms should be tiny',after_peak)
    page.wait_for_timeout(300)
    steady=[(i*15,15) for i in range(30)]
    assert abs(replay(steady)[-1][1]-15*30)<1,'a steady turn keeps its full distance'
    print(f'PASS: thumb-wheel momentum tail trimmed ({raw:.0f}px -> {total:.0f}px, {after_peak:.1f}px after 400 ms)')
    # Fit to content via Shift+1, the toolbar button and the lost hint.
    for trigger in ['Shift+1','#btn-fit','#back-to-content']:
        page.mouse.move(x,y);page.mouse.wheel(30000,30000)
        expect(page.locator('#back-to-content')).to_be_visible()
        if trigger.startswith('#'): page.locator(trigger).click()
        else: page.keyboard.press(trigger)
        page.wait_for_timeout(600)
        assert all_visible(page) and view(page)['s']<=1,trigger
        expect(page.locator('#back-to-content')).to_be_hidden()
    page.keyboard.press('Shift+0');assert abs(view(page)['s']-1)<1e-6
    print('PASS: fit to content and back to 100%')
    # M toggles the minimap and the choice survives a reload.
    page.keyboard.press('m');expect(page.locator('#minimap')).to_be_hidden()
    expect(page.locator('#btn-map')).to_have_attribute('aria-pressed','false')
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    expect(page.locator('#minimap')).to_be_hidden()
    page.locator('#btn-map').click();expect(page.locator('#minimap')).to_be_visible()
    assert not errors,errors
    print('PASS: minimap toggle is remembered')
    browser.close()
