"""Verify select-mode dragging pans, taps select, and dragging a selection moves it."""
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

def moved(item,dx,dy):
    item=dict(item)
    if item['type']=='stroke': item['pts']=[[x+dx,y+dy] for x,y in item['pts']]
    else: item['x']+=dx;item['y']+=dy
    return item

def center(locator):
    box=locator.bounding_box()
    return box['x']+box['width']/2,box['y']+box['height']/2

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1500,'height':950},has_touch=True)
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      const canvas=document.createElement('canvas');canvas.width=canvas.height=2;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve));
      await db.put('blobs',blob,'pan-image');
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'stroke',type:'stroke',tool:'pen',width:4,color:'#123456',pts:[[60,80],[180,100]]},
        {id:'text',type:'text',x:300,y:80,size:20,text:'Drag this text'},
        {id:'image',type:'image',x:540,y:80,w:100,h:80,blobId:'pan-image'}
      ]});
    }""")
    page.reload();expect(page.locator('.img-item')).to_have_count(1)
    original=state(page)['items']
    for index,selector in enumerate(['.ink path[data-id=stroke]','.text-item','.img-item']):
        # Blank-space tap clears selection. Dragging an unselected object must
        # not select or move it; dragging a selected object moves it instead.
        viewport=page.locator('#viewport').bounding_box()
        page.mouse.click(viewport['x']+10,viewport['y']+viewport['height']-20)
        expect(page.locator('.sel-box')).to_be_hidden()
        item=page.locator(selector)
        for selected in [False,True]:
            before=state(page)
            x,y=center(item)
            page.mouse.move(x,y);page.mouse.down()
            if not selected: expect(page.locator('.sel-box')).to_be_hidden()
            page.mouse.move(x+28,y+18,steps=6);page.mouse.up();saved(page)
            after=state(page)
            if not selected:
                assert after['items']==original,(selector,'unselected object mutated')
                assert abs(after['view']['x']-before['view']['x']-28)<.1
                assert abs(after['view']['y']-before['view']['y']-18)<.1
                expect(page.locator('.sel-box')).to_be_hidden()
                x,y=center(item);page.mouse.click(x,y)
                expect(page.locator('.sel-box')).to_be_visible()
            else:
                s=before['view']['s']
                assert after['view']==before['view'],(selector,'selected drag panned')
                assert after['items'][index]==moved(original[index],28/s,18/s),(selector,after['items'][index])
                page.locator('#btn-undo').click();saved(page)
                assert state(page)['items']==original
        print('PASS: tap selects, unselected drag pans, selected drag moves:',selector)
    # Image resize is available only via the selection's corner handle.
    before=state(page);handle=page.locator('[data-transform=se]');x,y=center(handle)
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+50,y+30,steps=5);page.mouse.up();saved(page)
    after=state(page)
    assert after['view']==before['view']
    assert after['items'][2]['w']>before['items'][2]['w']
    page.locator('#btn-undo').click();saved(page);assert state(page)['items']==original
    # A real touch gesture must also pan without moving the text object.
    session=page.context.new_cdp_session(page)
    before=state(page);x,y=center(page.locator('.text-item'))
    session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
    for delta in [10,20,30]:
        session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+delta,'y':y+delta}]})
    session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    saved(page);after=state(page)
    assert after['items']==original
    assert after['view']['x']>before['view']['x']
    # Touch tap selects; a second touch drag on the selected text moves it.
    x,y=center(page.locator('.text-item'))
    session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
    session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    expect(page.locator('.sel-box')).to_be_visible()
    before=state(page)
    session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
    for delta in [10,20,30]:
        session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+delta,'y':y+delta}]})
    session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    saved(page);after=state(page)
    assert after['view']==before['view']
    assert after['items'][1]['x']>original[1]['x'] and after['items'][1]['y']>original[1]['y']
    page.locator('#btn-undo').click();saved(page);assert state(page)['items']==original
    # Editing requires choosing the text tool; clicking in select mode did not
    # focus the contenteditable and therefore cannot swallow a pan gesture.
    page.locator('.tool[data-tool=text]').click()
    page.locator('.text-body').click();page.keyboard.press('End');page.keyboard.type(' edited')
    page.locator('#page-title').click();saved(page)
    assert state(page)['items'][1]['text'].endswith(' edited')
    assert not errors,errors
    print('PASS: resize handle, undo, touch pan, touch move and explicit text editing')
    # Stacked objects: taps follow the on-screen stacking (images < strokes <
    # text, later DOM on top), not creation order. Tapping the same spot again
    # selects the next layer down, wrapping back to the top; dragging then
    # moves only that layer.
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'label',type:'text',x:180,y:170,size:20,text:'Label'},
        {id:'back',type:'image',x:100,y:100,w:200,h:160,blobId:'pan-image'},
        {id:'middle',type:'stroke',tool:'pen',width:6,color:'#123456',pts:[[80,180],[320,180]]},
        {id:'front',type:'image',x:160,y:140,w:80,h:80,blobId:'pan-image'}
      ]});
    }""")
    page.reload();expect(page.locator('.img-item')).to_have_count(2)
    page.locator('.tool[data-tool=select]').click()
    stacked=state(page)['items']
    x,y=center(page.locator('.img-item[data-id=front]'))
    for expected in ['label','middle','front','back']*2:
        page.mouse.click(x,y)
        expect(page.locator(f'[data-id={expected}].selected')).to_have_count(1)
    before=state(page)
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+30,y+20,steps=6);page.mouse.up();saved(page)
    after=state(page)
    assert after['view']==before['view']
    assert (after['items'][1]['x'],after['items'][1]['y'])==(stacked[1]['x']+30,stacked[1]['y']+20),after['items'][1]
    assert [after['items'][0]]+after['items'][2:]==[stacked[0]]+stacked[2:]
    assert not errors,errors
    print('PASS: taps cycle stacked objects in on-screen order and drag moves the chosen layer')
    browser.close()
