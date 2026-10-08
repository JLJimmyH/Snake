"""Verify AI collaboration and copy/paste: right-click copies the selection (or everything), the export dialog's 「複製給 AI」 previews and exports just the selected region, the AI reply is pasted with Ctrl+V at the cursor, undo, missing images, persistence, and pasting copied items on another page."""
import json, os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')

def texts(page):
    return page.locator('.text-item .text-body').all_inner_texts()

def strokes(page):
    return page.locator('svg.ink path:not(.lasso)').count()

def draw(page):
    page.keyboard.press('q')
    box=page.locator('#viewport').bounding_box()
    x,y=box['x']+box['width']-560,box['y']+box['height']-160  # 避開右下角的小地圖
    page.mouse.move(x,y); page.mouse.down()
    for i in range(1,10): page.mouse.move(x+i*10,y+(i%3)*8)
    page.mouse.up()
    page.keyboard.press('Escape')
    return x,y

def copy(page, request=''):
    page.fill('#ai-request',request)
    page.click('#ai-copy')
    expect(page.locator('#toast')).to_contain_text('已複製')
    return page.evaluate('navigator.clipboard.readText()').replace('\r\n','\n')  # Windows 剪貼簿是 CRLF

def region_json(prompt):
    return json.loads(re.search(r'```json\n(.*)\n```',prompt,re.S).group(1))

def labels(page):
    return page.eval_on_selector_all('#menu button','bs => bs.map(b => b.firstChild.textContent)')  # 不含右邊的快捷鍵提示

def menu(page, label):
    page.locator('#menu button',has_text=label).click()

REPLY={'items':[
    {'type':'text','x':0,'y':0,'text':'# AI 轉出的文字','size':20},
    {'type':'stroke','pts':[[0,40],[120,40]],'color':'#ff0000','width':3},
]}

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900})
    context.grant_permissions(['clipboard-read','clipboard-write'],origin=BASE)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(BASE+'/')
    page.wait_for_selector('.row.active')
    sx,sy=draw(page)
    expect(page.locator('#save-state')).to_have_text('已儲存')
    before_texts,before_strokes=texts(page),strokes(page)
    assert before_strokes==1 and len(before_texts)>3,(before_strokes,before_texts)

    # 右鍵點筆跡：選取它，選單只有「複製」，複製的是完整的筆跡
    page.mouse.click(sx+30,sy,button='right')
    expect(page.locator('#menu button')).to_have_count(8)
    assert labels(page)==['剪下','複製（1 個物件）','刪除','貼上','純文字貼上','原始格式貼上','原位貼上','匯出 PDF'],labels(page)
    menu(page,'複製（1 個物件）')
    expect(page.locator('#toast')).to_contain_text('已複製 1 個物件')
    data=json.loads(page.evaluate('navigator.clipboard.readText()'))
    assert data['format']=='snake-note-ai' and len(data['items'])==1 and len(data['items'][0]['pts'])==10,data

    # 選取後按「匯出」→「複製給 AI」：只把這一塊交給 AI
    page.click('#export-button')
    expect(page.locator('#export-dialog')).to_be_visible()
    expect(page.locator('#export-heading')).to_have_text('匯出選取的 1 個物件')
    # 預覽：只畫選取的那一塊
    expect(page.locator('#export-preview')).to_be_visible()
    page.wait_for_function("document.querySelector('#export-preview').naturalWidth>0")
    nw,nh=page.locator('#export-preview').evaluate('el => [el.naturalWidth, el.naturalHeight]')
    assert nw<400 and nh<200,(nw,nh)
    prompt=copy(page,'轉成文字')
    assert '轉成文字' in prompt and '"items"' in prompt and '框選' in prompt,prompt[:300]
    data=region_json(prompt)
    assert data['format']=='snake-note-ai' and data['scope']=='selection' and data['area']['w']>0,data
    assert len(data['items'])==1 and data['items'][0]['type']=='stroke',data['items']
    xs=[p[0] for p in data['items'][0]['pts']]
    assert min(xs)>=0 and max(xs)<=data['area']['w'],xs  # 以區域左上角為原點
    expect(page.locator('#toast')).to_contain_text('截圖')

    # 截圖：只畫選取的那一塊（headless 不支援時會改成下載）
    page.click('#export-image')
    expect(page.locator('#toast')).to_have_text(re.compile('已複製圖片|改成下載'))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS,'export-dialog.png'))

    page.click('#export-close')

    # AI 的回覆：在畫布上 Ctrl+V，外框左上角放在游標位置
    page.evaluate('t => navigator.clipboard.writeText(t)','以下是結果：\n```json\n'+json.dumps(REPLY,ensure_ascii=False)+'\n```')
    box=page.locator('#viewport').bounding_box()
    px,py=box['x']+300,box['y']+box['height']-300
    page.mouse.click(px,py)
    page.keyboard.press('Control+V')
    expect(page.locator('#toast')).to_contain_text('已貼上 2 個物件')
    after=texts(page)
    assert after[:len(before_texts)]==before_texts and after[-1]=='AI 轉出的文字',after
    assert strokes(page)==before_strokes+1
    added=page.locator('.text-item').last.bounding_box()
    assert abs(added['x']-px)<4 and abs(added['y']-py)<4,(added,px,py)
    assert page.locator('svg.ink path[stroke="#ff0000"]').count()==1
    expect(page.locator('#btn-del')).to_be_enabled()  # 貼上的物件是選取狀態

    # 一次復原就拿掉，重做放回來
    page.click('#btn-undo')
    assert texts(page)==before_texts and strokes(page)==before_strokes,texts(page)
    page.click('#btn-redo')
    assert texts(page)==after and strokes(page)==before_strokes+1

    # Ctrl+V：剪貼簿裡是 AI 回覆就放在游標位置，不當成一般文字
    page.keyboard.press('Escape')
    page.mouse.click(box['x']+600,box['y']+120)
    page.keyboard.press('Control+V')
    expect(page.locator('.text-item .text-body',has_text='AI 轉出的文字')).to_have_count(2)
    assert texts(page).count('AI 轉出的文字')==2 and strokes(page)==before_strokes+2

    # 圖片只帶 blob id：這台裝置找不到圖檔就略過，其他照貼
    page.evaluate('t => navigator.clipboard.writeText(t)',json.dumps({'items':[
        {'type':'text','x':0,'y':0,'text':'有圖的貼上'},{'type':'image','x':0,'y':40,'w':50,'h':50,'blob':'nope'}]}))
    page.mouse.click(box['x']+650,box['y']+box['height']-120)
    page.keyboard.press('Control+V')
    expect(page.locator('#toast')).to_contain_text('1 張圖片找不到')
    expect(page.locator('.text-item .text-body',has_text='有圖的貼上')).to_have_count(1)
    page.evaluate("navigator.clipboard.writeText('一般文字')")

    # 一般文字的 Ctrl+V 還是新增文字框
    page.mouse.click(box['x']+900,box['y']+60)
    page.keyboard.press('Control+V')
    expect(page.locator('.text-item .text-body',has_text='一般文字')).to_have_count(1)

    # 沒有選取時「複製給 AI」＝整頁
    page.keyboard.press('Escape')
    page.mouse.click(box['x']+700,box['y']+300)
    page.click('#export-button')
    expect(page.locator('#export-heading')).to_have_text('匯出整頁')
    data=region_json(copy(page))
    assert data['scope']=='page' and len(data['items'])==len(texts(page))+strokes(page),data['scope']
    page.click('#export-close')

    # 重新整理後保留
    expect(page.locator('#save-state')).to_have_text('已儲存')
    final=texts(page)
    page.reload()
    page.wait_for_selector('.row.active')
    assert texts(page)==final and strokes(page)==before_strokes+2,texts(page)

    # 右鍵空白處是「複製全部」和貼上選項，貼到別頁會整份貼上
    page.mouse.click(box['x']+700,box['y']+300,button='right')
    expect(page.locator('#menu button')).to_have_count(6)
    assert labels(page)==['複製全部','貼上','純文字貼上','原始格式貼上','原位貼上','匯出整頁 PDF'],labels(page)
    menu(page,'複製全部')
    expect(page.locator('#toast')).to_contain_text('已複製全部')
    data=json.loads(page.evaluate('navigator.clipboard.readText()'))
    assert len(data['items'])==len(final)+before_strokes+2,len(data['items'])
    page.locator('.row',has_text='會議記錄').click()
    expect(page.locator('#page-title')).to_have_value('會議記錄')
    other_texts,other_strokes=texts(page),strokes(page)
    page.mouse.click(box['x']+700,box['y']+300)
    page.keyboard.press('Control+V')
    expect(page.locator('.text-item')).to_have_count(len(other_texts)+len(final))
    assert strokes(page)==other_strokes+before_strokes+2

    # 貼上後是選取狀態，Ctrl+C 再複製一次
    page.keyboard.press('Control+C')
    expect(page.locator('#toast')).to_contain_text(f'已複製 {len(data["items"])} 個物件')
    assert len(json.loads(page.evaluate('navigator.clipboard.readText()'))['items'])==len(data['items'])

    assert not errors,errors
    browser.close()
print('ai smoke ok')
