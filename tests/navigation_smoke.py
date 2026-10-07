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
    page.wait_for_timeout(1100) # 拇指滾輪剛動過的 1 秒內，整格事件會先等一下
    page.keyboard.down('Shift');before=view(page);page.mouse.wheel(0,100);page.wait_for_timeout(400)
    page.keyboard.up('Shift');assert moved(before)==(100,0),'shift+wheel scrolls sideways'
    print('PASS: wheel notches glide, high-resolution deltas follow at once')
    # A real MX Master thumb-wheel recording (ms, deltaX, deltaY): while the thumb wheel scrolls, the device
    # slips in whole-notch events (deltaY +100, or deltaX -100 against the scroll) that made the view jump.
    THUMB=[(0,-0.83,0),(23,-0.83,0),(39,-0.83,0),(55,-0.83,0),(72,-0.83,0),(76,-0.83,0),(101,-0.83,0),(109,-0.83,0),
      (122,-0.83,0),(143,-0.83,0),(180,-0.83,0),(198,-0.83,0),(223,-0.83,0),(277,-0.83,0),(399,-0.83,0),(612,-0.83,0),
      (900,0,100),(963,2.5,0),(979,3.33,0),(993,5.83,0),(1008,6.67,0),(1025,6.67,0),(1046,9.17,0),(1061,7.5,0),
      (1080,11.67,0),(1096,13.33,0),(1111,13.33,0),(1129,14.17,0),(1145,10,0),(1160,10,0),(1179,10.83,0),(1195,15,0),
      (1207,14.17,0),(1228,10,0),(1244,10,0),(1260,11.67,0),(1277,12.5,0),(1296,11.67,0),(1310,13.33,0),(1327,12.5,0),
      (1346,10.83,0),(1358,10.83,0),(1376,0,100),(1379,10.83,0),(1396,10.83,0),(1413,9.17,0),(1427,9.17,0),(1444,9.17,0),
      (1456,-100,0),(1458,9.17,0),(1473,9.17,0),(1491,9.17,0),(1543,5.83,0),(1548,5.83,0),(1556,5.83,0),(1570,0,100),
      (1571,5.83,0),(1587,5.83,0),(1606,5.83,0),(1620,5.83,0),(1623,5.83,0),(1637,5.83,0),(1654,5.83,0),(1674,5.83,0),
      (1691,5.83,0),(1707,0,100),(1707,5.83,0),(1721,5,0),(1739,5,0),(1755,2.5,0),(1774,2.5,0),(1791,2.5,0),
      (1805,2.5,0),(1822,2.5,0),(1838,3.33,0),(1855,2.5,0),(1871,2.5,0),(1890,2.5,0),(1907,2.5,0),(1924,2.5,0),
      (1925,-100,0),(1941,2.5,0),(1958,1.67,0),(1973,1.67,0),(1991,1.67,0),(2726,10.83,0),(2766,15.83,0),(2806,18.33,0),
      (2847,19.17,0),(2894,23.33,0),(2928,20,0),(2958,21.67,0),(2994,21.67,0),(3035,23.33,0),(3067,19.17,0),(3100,17.5,0),
      (3137,17.5,0),(3180,16.67,0),(3214,15.83,0),(3245,13.33,0),(3255,-100,0),(3286,12.5,0),(3294,0,100),(3319,12.5,0),
      (3326,0,100),(3358,12.5,0),(3396,13.33,0),(3433,12.5,0)]
    def replay(events):
        return page.evaluate('''async events => {
          const vp=document.querySelector('#viewport'),r=vp.getBoundingClientRect(),t0=performance.now();
          const at=()=>document.querySelector('.world').style.transform.match(/translate\((.+?)px, (.+?)px/).slice(1).map(Number);
          const [x0,y0]=at(),track=[];
          for (const [ms,dx,dy] of events) {
            await new Promise(res=>setTimeout(res,Math.max(0,t0+ms-performance.now())));
            vp.dispatchEvent(new WheelEvent('wheel',{deltaX:dx,deltaY:dy,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}));
            const [x,y]=at();track.push([x0-x,y0-y]);
          }
          await new Promise(res=>setTimeout(res,400));
          const [x,y]=at();track.push([x0-x,y0-y]);
          return track;
        }''',events)
    track=replay(THUMB)
    smooth=sum(dx for _,dx,dy in THUMB if abs(dx)<50 and not dy)
    assert all(abs(y)<.01 for _,y in track),'the view must not move vertically'
    assert abs(track[-1][0]-smooth)<.5,(track[-1][0],smooth)
    forward=[x for (ms,_,_),(x,_) in zip(THUMB,track) if ms>=963]
    assert all(b>=a-.01 for a,b in zip(forward,forward[1:])),'no jump against the scroll direction'
    for events,expected,why in [
        ([(0,17.5,0),(10,0,100)],(17.5,0),'a notch while the thumb wheel scrolls is noise'),
        ([(0,5,0),(400,0,100),(430,5,0)],(10,0),'a notch right before the thumb wheel moves again is noise'),
        ([(0,5,0),(400,0,100)],(5,100),'a notch shortly after the thumb wheel stops still scrolls'),
        ([(0,0,100)],(0,100),'without a thumb wheel a notch scrolls')]:
        page.wait_for_timeout(1100)
        end=replay(events)[-1];assert (round(end[0],2),round(end[1],2))==expected,(why,end)
    print('PASS: stray notches from a thumb wheel are ignored')
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
