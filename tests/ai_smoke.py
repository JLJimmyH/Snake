"""Verify AI collaboration: right-click a selection to export just that region, paste the AI reply, click the canvas to insert the new items, undo, Esc cancel, Ctrl+V and right-click paste, whole-page export and persistence."""
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

    # 右鍵點筆跡：選取它，只把這一塊交給 AI
    page.mouse.click(sx+30,sy,button='right')
    expect(page.locator('#menu')).to_be_visible()
    menu(page,'提取給 AI 分析（1 個物件）')
    expect(page.locator('#ai-dialog')).to_be_visible()
    expect(page.locator('#ai-heading')).to_have_text('AI 分析選取的 1 個物件')
    expect(page.locator('#ai-insert')).to_be_disabled()
    prompt=copy(page,'轉成文字')
    assert '轉成文字' in prompt and '"items"' in prompt and '框選' in prompt,prompt[:300]
    data=region_json(prompt)
    assert data['format']=='snake-note-ai' and data['scope']=='selection' and data['area']['w']>0,data
    assert len(data['items'])==1 and data['items'][0]['type']=='stroke',data['items']
    xs=[p[0] for p in data['items'][0]['pts']]
    assert min(xs)>=0 and max(xs)<=data['area']['w'],xs  # 以區域左上角為原點
    expect(page.locator('#toast')).to_contain_text('截圖')

    # 截圖：只畫選取的那一塊（headless 不支援時會改成下載）
    page.click('#ai-shot')
    expect(page.locator('#toast')).to_have_text(re.compile('已複製截圖|改成下載截圖'))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS,'ai-dialog.png'))

    # 看不懂的回覆：顯示錯誤，不能放
    page.fill('#ai-reply','好的，我整理好了')
    expect(page.locator('.ai-error')).to_contain_text('看不懂')
    expect(page.locator('#ai-insert')).to_be_disabled()
    page.fill('#ai-reply',json.dumps({'items':[{'type':'image','x':0,'y':0}]}))
    expect(page.locator('.ai-error')).to_contain_text('不能新增圖片')

    # 正常回覆：先顯示摘要，再點畫布放上去
    page.fill('#ai-reply','以下是結果：\n```json\n'+json.dumps(REPLY,ensure_ascii=False)+'\n```')
    expect(page.locator('.ai-counts')).to_have_text('文字框 1、筆跡 1')
    expect(page.locator('#ai-insert')).to_be_enabled()
    page.click('#ai-insert')
    expect(page.locator('#ai-dialog')).to_be_hidden()
    expect(page.locator('#toast')).to_contain_text('點一下畫布')
    expect(page.locator('#viewport')).to_have_class(re.compile('picking'))
    box=page.locator('#viewport').bounding_box()
    px,py=box['x']+300,box['y']+box['height']-300
    page.mouse.move(px,py)
    expect(page.locator('#ai-ghost')).to_be_visible()
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS,'ai-placing.png'))
    page.mouse.click(px,py)
    expect(page.locator('#ai-ghost')).to_be_hidden()
    expect(page.locator('#toast')).to_contain_text('已放上 2 個物件')
    after=texts(page)
    assert after[:len(before_texts)]==before_texts and after[-1]=='AI 轉出的文字',after
    assert strokes(page)==before_strokes+1
    added=page.locator('.text-item').last.bounding_box()
    assert abs(added['x']-px)<4 and abs(added['y']-py)<4,(added,px,py)  # 外框左上角放在點的位置
    assert page.locator('svg.ink path[stroke="#ff0000"]').count()==1
    expect(page.locator('#btn-del')).to_be_enabled()  # 放上去的物件是選取狀態

    # 一次復原就拿掉，重做放回來
    page.click('#btn-undo')
    assert texts(page)==before_texts and strokes(page)==before_strokes,texts(page)
    page.click('#btn-redo')
    assert texts(page)==after and strokes(page)==before_strokes+1

    # 回覆留著可以再放一次；Esc 取消放置
    page.click('#ai-button')
    expect(page.locator('#ai-insert')).to_be_enabled()
    page.click('#ai-insert')
    page.keyboard.press('Escape')
    expect(page.locator('#toast')).to_have_text('已取消')
    expect(page.locator('#viewport')).not_to_have_class(re.compile('picking'))
    page.mouse.click(px+200,py)
    assert texts(page)==after

    # Ctrl+V：剪貼簿裡是 AI 回覆就放在游標位置，不當成一般文字
    page.evaluate('t => navigator.clipboard.writeText(t)',json.dumps(REPLY,ensure_ascii=False))
    page.mouse.click(box['x']+600,box['y']+120)
    page.keyboard.press('Control+V')
    expect(page.locator('#toast')).to_contain_text('已放上 2 個物件')
    assert texts(page).count('AI 轉出的文字')==2 and strokes(page)==before_strokes+2

    # 右鍵空白處「在這裡貼上 AI 回覆」
    page.keyboard.press('Escape')
    page.mouse.click(box['x']+650,box['y']+box['height']-120,button='right')
    menu(page,'在這裡貼上 AI 回覆')
    expect(page.locator('.text-item .text-body',has_text='AI 轉出的文字')).to_have_count(3)
    assert strokes(page)==before_strokes+3
    page.evaluate("navigator.clipboard.writeText('一般文字')")
    page.mouse.click(box['x']+550,box['y']+box['height']-220,button='right')
    menu(page,'在這裡貼上 AI 回覆')
    expect(page.locator('#toast')).to_contain_text('不是 AI 的回覆')

    # 一般文字的 Ctrl+V 還是新增文字框
    page.mouse.click(box['x']+900,box['y']+60)
    page.keyboard.press('Control+V')
    expect(page.locator('.text-item .text-body',has_text='一般文字')).to_have_count(1)

    # 沒有選取時按 ✨＝整頁
    page.keyboard.press('Escape')
    page.mouse.click(box['x']+700,box['y']+300)
    page.click('#ai-button')
    expect(page.locator('#ai-heading')).to_have_text('AI 分析這一頁')
    data=region_json(copy(page))
    assert data['scope']=='page' and len(data['items'])==len(texts(page))+strokes(page),data['scope']
    page.click('#ai-close')

    # 重新整理後保留
    expect(page.locator('#save-state')).to_have_text('已儲存')
    final=texts(page)
    page.reload()
    page.wait_for_selector('.row.active')
    assert texts(page)==final and strokes(page)==before_strokes+3,texts(page)

    assert not errors,errors
    browser.close()
print('ai smoke ok')
