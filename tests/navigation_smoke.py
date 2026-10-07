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
    # Both wheels at once (recorded on Chrome/Windows with an MX Master, ms, deltaX, deltaY). Chrome turns a
    # vertical notch that shares a message time with the thumb wheel's last WM_MOUSEHWHEEL into a horizontal
    # one (hwnd_message_handler.cc), so a notch down arrives as deltaX -100 / wheelDeltaX +120.
    BOTH=[(0,0,100),(63,2.5,0),(79,3.33,0),(93,5.83,0),(108,6.67,0),(125,6.67,0),(146,9.17,0),(161,7.5,0),
      (180,11.67,0),(196,13.33,0),(211,13.33,0),(229,14.17,0),(245,10,0),(260,10,0),(279,10.83,0),(295,15,0),
      (307,14.17,0),(328,10,0),(344,10,0),(360,11.67,0),(377,12.5,0),(396,11.67,0),(410,13.33,0),(427,12.5,0),
      (446,10.83,0),(458,10.83,0),(476,0,100),(479,10.83,0),(496,10.83,0),(513,9.17,0),(527,9.17,0),(544,9.17,0),
      (556,-100,0),(558,9.17,0),(573,9.17,0),(591,9.17,0),(643,5.83,0),(648,5.83,0),(656,5.83,0),(670,0,100),
      (671,5.83,0),(687,5.83,0),(706,5.83,0),(720,5.83,0),(723,5.83,0),(737,5.83,0),(754,5.83,0),(774,5.83,0),
      (791,5.83,0),(807,0,100),(807,5.83,0),(821,5,0),(839,5,0),(855,2.5,0),(874,2.5,0),(891,2.5,0),
      (905,2.5,0),(922,2.5,0),(938,3.33,0),(955,2.5,0),(971,2.5,0),(990,2.5,0),(1007,2.5,0),(1024,2.5,0),
      (1025,-100,0),(1041,2.5,0),(1058,1.67,0),(1073,1.67,0),(1091,1.67,0),(1826,10.83,0),(1866,15.83,0),(1906,18.33,0),
      (1947,19.17,0),(1994,23.33,0),(2028,20,0),(2058,21.67,0),(2094,21.67,0),(2135,23.33,0),(2167,19.17,0),(2200,17.5,0),
      (2237,17.5,0),(2280,16.67,0),(2314,15.83,0),(2345,13.33,0),(2355,-100,0),(2386,12.5,0),(2394,0,100),(2419,12.5,0),
      (2426,0,100),(2458,12.5,0),(2496,13.33,0),(2533,12.5,0)]
    def wheel_init(dx,dy,pad=False):
        # Mouse: wheelDelta = ticks * 120, a notch is 120 and the thumb wheel sends 1/120-tick units (deltaX 0.8333).
        # Touchpad: Chrome sets ticks = delta / 120, so wheelDelta equals the truncated delta.
        k=1 if pad else 1.2
        if dy: return {'deltaX':0,'deltaY':dy,'wheelDeltaX':0,'wheelDeltaY':-int(dy*k)}
        return {'deltaX':dx,'deltaY':0,'wheelDeltaX':-int(dx*k),'wheelDeltaY':0}
    def replay(events,settle=500,pad=False):
        return page.evaluate('''async ([events,settle]) => {
          const vp=document.querySelector('#viewport'),r=vp.getBoundingClientRect(),t0=performance.now();
          const at=()=>document.querySelector('.world').style.transform.match(/translate\((.+?)px, (.+?)px/).slice(1).map(Number);
          const [x0,y0]=at(),track=[];
          for (const [ms,init] of events) {
            await new Promise(res=>setTimeout(res,Math.max(0,t0+ms-performance.now())));
            vp.dispatchEvent(new WheelEvent('wheel',{...init,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}));
            const [x,y]=at();track.push([x0-x,y0-y]);
          }
          await new Promise(res=>setTimeout(res,settle));
          const [x,y]=at();track.push([x0-x,y0-y]);
          return track;
        }''',[[[ms,wheel_init(dx,dy,pad)] for ms,dx,dy in events],settle])
    page.wait_for_timeout(300)
    track=replay(BOTH)
    thumb=sum(dx for _,dx,dy in BOTH if abs(dx)<50 and not dy)
    assert abs(track[-1][1]-900)<.5,('all 9 vertical notches (6 + 3 swapped by Chrome) scroll down',track[-1])
    assert abs(track[-1][0]-thumb)<.5,('horizontal follows the thumb wheel only',track[-1][0],thumb)
    xs=[x for x,_ in track]
    assert all(b>=a-.01 for a,b in zip(xs,xs[1:])),'no jump against the scroll direction'
    page.wait_for_timeout(300)
    # A whole horizontal notch with no thumb wheel nearby (tilt wheel, Shift) stays horizontal.
    end=replay([(0,-100,0)],900)[-1];assert (round(end[0],2),round(end[1],2))==(-100,0),end
    # Scrolling up while the thumb wheel moves comes back as deltaX +100; it is restored to a notch up.
    end=replay([(0,5,0),(8,100,0)],900)[-1];assert (round(end[0],2),round(end[1],2))==(5,-100),end
    # A thumb wheel flicked hard enough to send a whole tick right after a big step stays horizontal.
    end=replay([(0,60,0),(10,100,0)],900)[-1];assert (round(end[0],2),round(end[1],2))==(160,0),end
    # A fast touchpad swipe (pure horizontal, decaying, wheelDelta = delta) passes through whole-tick sizes
    # but must never turn into a vertical step.
    swipe=[];d=300.0
    for i in range(40): swipe.append((i*8,round(d,2),0));d*=.93
    end=replay(swipe,900,pad=True)[-1]
    assert abs(end[1])<.01 and abs(end[0]-sum(dx for _,dx,_ in swipe))<1,end
    print('PASS: notches Chrome swaps to horizontal during two-wheel scrolling are restored')
    # With both wheels moving, a notch glides longer (tau 100 ms) so consecutive notches join up;
    # alone it keeps the short glide (tau 40 ms).
    def after(events,ms):
        return replay(events,settle=ms)[-1][1]
    page.wait_for_timeout(300);alone=after([(0,0,100)],100)
    page.wait_for_timeout(600);both=after([(0,5,0),(10,0,100)],100)
    assert alone>74 and both<70,(alone,both)
    page.wait_for_timeout(600)
    print('PASS: notches glide longer only while both wheels move')
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
