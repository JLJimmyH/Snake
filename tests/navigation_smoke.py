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
    before=view(page);page.mouse.wheel(0,100);page.wait_for_timeout(50);after=view(page)
    assert after['s']==before['s'] and abs(after['y']-(before['y']-100))<.01
    expect(page.locator('#zoom')).to_have_text(f"{round(after['s']*100)}%")
    # Zoom buttons step through round percentages.
    page.locator('#zoom').click()
    for button,expected in [('#zoom-in',1.25),('#zoom-in',1.5),('#zoom-out',1.25),('#zoom-out',1),('#zoom-out',.75)]:
        page.locator(button).click();assert abs(view(page)['s']-expected)<1e-6,(button,view(page))
    print('PASS: Ctrl+wheel steps about 10% and zoom buttons')
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
