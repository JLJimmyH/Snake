"""Verify the touch/mouse input mode switch: mouse mode drags objects directly, box-selects on blank space,
pans with Space+drag or the middle button, hides the lasso, and tool keys follow the visible toolbar order."""
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

def center(locator):
    box=locator.bounding_box()
    return box['x']+box['width']/2,box['y']+box['height']/2

def drag(page,x,y,dx,dy):
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=6);page.mouse.up()

def set_mode(page,mode):
    page.click('#btn-appearance');page.click(f'[data-input-mode={mode}]');page.keyboard.press('Escape')
    expect(page.locator('html')).to_have_attribute('data-input',mode)

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1500,'height':950})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'stroke',type:'stroke',tool:'pen',width:4,color:'#123456',pts:[[60,80],[180,100]]},
        {id:'text',type:'text',x:300,y:80,size:20,text:'Drag this text'}
      ]});
    }""")
    page.reload();expect(page.locator('.text-item')).to_have_count(1)
    original=state(page)['items']
    tool=lambda: page.locator('#viewport').get_attribute('data-tool')
    lasso=page.locator('.tool[data-tool=lasso]')

    # 桌機（能懸停的精準指標）預設滑鼠模式
    expect(page.locator('html')).to_have_attribute('data-input','mouse')
    expect(lasso).to_be_hidden()
    expect(page.locator('#btn-shortcuts')).to_be_visible()

    # 滑鼠模式：工具鍵照看得到的工具列順序，任何工具下都能切
    page.click('#viewport')
    for key,name in [('q','pen'),('w','hl'),('e','eraser'),('r','text'),('Escape','select')]:
        page.keyboard.press(key);assert tool()==name,(key,tool())
    with page.expect_file_chooser():page.keyboard.press('t')
    expect(page.locator('#tool-keys dt')).to_have_text(['Esc','Q','W','E','R','T'])
    expect(page.locator('.tool[data-tool=pen]')).to_have_attribute('title','筆 (Q)')
    print('PASS: mouse mode tool keys follow the toolbar without the lasso')

    # 未選取的物件直接拖動
    before=state(page)
    x,y=center(page.locator('.text-item'));drag(page,x,y,40,20);saved(page)
    after=state(page)
    assert after['view']==before['view'],'mouse drag on object panned'
    assert after['items'][1]['x']==original[1]['x']+40 and after['items'][1]['y']==original[1]['y']+20,after['items'][1]
    expect(page.locator('.text-item.selected')).to_have_count(1)
    page.locator('#btn-undo').click();saved(page)
    print('PASS: mouse mode drags an unselected object directly')

    # 空白處拖曳＝框選，不移動畫布
    vp=page.locator('#viewport').bounding_box()
    page.mouse.click(vp['x']+700,vp['y']+500);expect(page.locator('.sel-box')).to_be_hidden()
    before=state(page)
    drag(page,vp['x']+20,vp['y']+20,600,150)
    expect(page.locator('.sel-box')).to_be_visible()
    assert page.evaluate('document.querySelectorAll("svg.ink path.lasso").length')==0
    assert page.locator('#btn-del').is_enabled()
    page.keyboard.press('Delete');saved(page)
    assert state(page)['items']==[],'box select should catch both objects'
    assert state(page)['view']==before['view']
    page.locator('#btn-undo').click();saved(page)
    print('PASS: mouse mode box-selects on blank space')

    # Shift+點選加選
    page.mouse.click(vp['x']+700,vp['y']+500)
    x,y=center(page.locator('.text-item'));page.mouse.click(x,y)
    page.keyboard.down('Shift');x,y=center(page.locator('.ink path[data-id=stroke]'));page.mouse.click(x,y);page.keyboard.up('Shift')
    page.keyboard.press('Delete');saved(page);assert state(page)['items']==[]
    page.locator('#btn-undo').click();saved(page)
    print('PASS: shift+click adds to the selection')

    # 重疊時再點一下換選下層，接著拖曳要移動下層，不能又被上層搶走
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      const doc=await db.get('docs',id);
      doc.items.push({id:'over',type:'stroke',tool:'pen',width:4,color:'#654321',pts:[[330,0],[330,300]]});
      await db.put('docs',doc);
    }""")
    page.reload();expect(page.locator('.ink path[data-id=over]')).to_have_count(1)
    vp=page.locator('#viewport').bounding_box()
    page.mouse.click(vp['x']+700,vp['y']+500)
    before=state(page);view=before['view']
    _,y=center(page.locator('.text-item'));x=vp['x']+view['x']+330*view['s']
    page.mouse.click(x,y);expect(page.locator('.text-item.selected')).to_have_count(1)
    page.mouse.click(x,y);expect(page.locator('.text-item.selected')).to_have_count(0)
    drag(page,x,y,40,20);saved(page)
    after=state(page)
    assert after['items'][1]==before['items'][1],'top object stole the drag'
    assert after['items'][2]['pts']==[[370,20],[370,320]],after['items'][2]
    page.mouse.click(x+40,y);expect(page.locator('.text-item.selected')).to_have_count(1)
    page.locator('#btn-undo').click();saved(page)
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      const doc=await db.get('docs',id);doc.items=doc.items.filter(it=>it.id!=='over');await db.put('docs',doc);
    }""")
    page.reload();expect(page.locator('.ink path[data-id=over]')).to_have_count(0)
    vp=page.locator('#viewport').bounding_box()
    print('PASS: clicking again cycles overlapped objects and the drag moves the picked one')

    # 按住空白鍵拖曳＝移動畫布
    before=state(page)
    page.keyboard.down(' ');x,y=center(page.locator('.text-item'));drag(page,x,y,30,25);page.keyboard.up(' ');saved(page)
    after=state(page)
    assert after['items']==original
    assert abs(after['view']['x']-before['view']['x']-30)<.1 and abs(after['view']['y']-before['view']['y']-25)<.1,(before['view'],after['view'])
    # 中鍵拖曳＝移動畫布（就算按在物件上）
    before=state(page)
    x,y=center(page.locator('.text-item'))
    page.mouse.move(x,y);page.mouse.down(button='middle');page.mouse.move(x-35,y-15,steps=6);page.mouse.up(button='middle');saved(page)
    after=state(page)
    assert after['items']==original
    assert abs(after['view']['x']-before['view']['x']+35)<.1 and abs(after['view']['y']-before['view']['y']+15)<.1,(before['view'],after['view'])
    print('PASS: space+drag and middle-button drag pan')

    # 觸控模式：套索回來，未選取的物件拖曳＝移動畫布，快捷鍵按鈕藏起來
    set_mode(page,'touch')
    expect(lasso).to_be_visible()
    expect(page.locator('#btn-shortcuts')).to_be_hidden()
    page.click('#viewport');page.keyboard.press('q');assert tool()=='lasso';page.keyboard.press('Escape')
    page.mouse.click(vp['x']+700,vp['y']+500)
    before=state(page)
    x,y=center(page.locator('.text-item'));drag(page,x,y,28,18);saved(page)
    after=state(page)
    assert after['items']==original and abs(after['view']['x']-before['view']['x']-28)<.1
    # 套索選取中切到滑鼠模式會回到選取工具，而且重新整理後記得選擇
    page.keyboard.press('q');assert tool()=='lasso'
    set_mode(page,'mouse');assert tool()=='select'
    set_mode(page,'touch');page.reload();expect(page.locator('html')).to_have_attribute('data-input','touch')
    print('PASS: touch mode keeps tap-to-select, lasso and remembers the choice')
    assert not errors,errors
    browser.close()
