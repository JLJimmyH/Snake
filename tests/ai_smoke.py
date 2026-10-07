"""Verify the AI organize dialog: copy page JSON and screenshot, preview a pasted reply, apply it, undo, stale-copy confirm and persistence."""
import json, os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')

def texts(page):
    return page.locator('.text-item .text-body').all_inner_texts()

def strokes(page):
    return page.locator('svg.ink path:not(.lasso)').count()

def draw(page, dx=0):
    page.keyboard.press('p')
    box=page.locator('#viewport').bounding_box()
    x,y=box['x']+box['width']-260+dx,box['y']+box['height']-160
    page.mouse.move(x,y); page.mouse.down()
    for i in range(1,10): page.mouse.move(x+i*10,y+(i%3)*8)
    page.mouse.up()
    page.keyboard.press('v')

def copy(page, request=''):
    page.fill('#ai-request',request)
    page.click('#ai-copy')
    expect(page.locator('#toast')).to_contain_text('已複製')
    return page.evaluate('navigator.clipboard.readText()').replace('\r\n','\n')  # Windows 剪貼簿是 CRLF

def page_json(prompt):
    return json.loads(re.search(r'```json\n(.*)\n```',prompt,re.S).group(1))

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900})
    context.grant_permissions(['clipboard-read','clipboard-write'],origin=BASE)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(BASE+'/')
    page.wait_for_selector('.row.active')
    draw(page)
    expect(page.locator('#save-state')).to_have_text('已儲存')
    before_texts,before_strokes=texts(page),strokes(page)
    assert before_strokes==1 and len(before_texts)>3,(before_strokes,before_texts)

    # 複製：提示詞含要求與精簡 JSON，筆跡只有外框
    page.click('#ai-button')
    expect(page.locator('#ai-dialog')).to_be_visible()
    expect(page.locator('#ai-apply')).to_be_disabled()
    prompt=copy(page,'重點整理成條列')
    assert '重點整理成條列' in prompt and '"ops"' in prompt,prompt[:300]
    data=page_json(prompt)
    assert data['format']=='note-mvp-ai' and data['page']=='歡迎使用' and data['area']['w']>0,data
    text=[i for i in data['items'] if i['type']=='text']
    stroke=[i for i in data['items'] if i['type']=='stroke']
    assert len(text)==len(before_texts) and len(stroke)==1 and 'pts' not in stroke[0] and stroke[0]['w']>0,stroke
    expect(page.locator('#toast')).to_contain_text('截圖')

    # 截圖：剪貼簿拿到 PNG（headless 不支援時會改成下載）
    page.click('#ai-shot')
    expect(page.locator('#toast')).to_have_text(re.compile('已複製截圖|改成下載截圖'))
    shot=page.evaluate("""async () => {
      try { const [item]=await navigator.clipboard.read(); const b=await item.getType('image/png'); return b.size; } catch (e) { return String(e); }
    }""")
    print('screenshot clipboard:',shot)
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS,'ai-dialog.png'))

    # 看不懂的回覆：顯示錯誤，不能套用
    page.fill('#ai-reply','好的，我整理好了')
    expect(page.locator('.ai-error')).to_contain_text('看不懂')
    expect(page.locator('#ai-apply')).to_be_disabled()
    page.fill('#ai-reply',json.dumps({'ops':[{'op':'update','id':'nope','text':'x'}]}))
    expect(page.locator('.ai-error')).to_contain_text('找不到')

    # 正常回覆（包在 ```json 裡）：先顯示摘要，再套用
    ops=[
        {'op':'update','id':text[0]['id'],'text':'# AI 改過的標題'},
        {'op':'move','id':text[1]['id'],'x':600,'y':0},
        {'op':'add','x':0,'y':900,'text':'- AI 新增的條列'},
        {'op':'delete','id':stroke[0]['id']},
    ]
    page.fill('#ai-reply','以下是修改：\n```json\n'+json.dumps({'ops':ops},ensure_ascii=False)+'\n```')
    expect(page.locator('.ai-counts')).to_have_text('修改 1、新增 1、移動 1、刪除 1（會刪除 1 個筆跡或圖片）')
    expect(page.locator('#ai-preview li')).to_have_count(4)
    expect(page.locator('#ai-apply')).to_be_enabled()
    page.click('#ai-apply')
    expect(page.locator('#ai-dialog')).to_be_hidden()
    expect(page.locator('#toast')).to_contain_text('已套用 4 項修改')
    after=texts(page)
    assert after[0]=='AI 改過的標題' and after[-1]=='AI 新增的條列' and len(after)==len(before_texts)+1,after
    assert strokes(page)==0
    moved=page.locator('.text-item').nth(1).evaluate('el => el.style.left')
    assert moved=='600px',moved

    # 一次復原就還原
    page.click('#btn-undo')
    assert texts(page)==before_texts and strokes(page)==1,texts(page)
    page.click('#btn-redo')
    assert texts(page)==after and strokes(page)==0

    # 複製之後又改過：套用前確認，取消就不動
    page.click('#ai-button')
    expect(page.locator('#ai-reply')).to_have_value('')
    prompt=copy(page)
    data=page_json(prompt)
    page.click('#ai-close')
    draw(page,dx=-60)
    page.click('#ai-button')
    first=[i for i in data['items'] if i['type']=='text'][0]['id']
    page.fill('#ai-reply',json.dumps({'ops':[{'op':'update','id':first,'text':'第二次'}]}))
    dialogs=[]
    page.once('dialog',lambda d: (dialogs.append(d.message),d.dismiss()))
    page.click('#ai-apply')
    assert dialogs and '又被改過' in dialogs[0],dialogs
    expect(page.locator('#ai-dialog')).to_be_visible()
    assert texts(page)[0]=='AI 改過的標題'
    page.once('dialog',lambda d: d.accept())
    page.click('#ai-apply')
    expect(page.locator('#ai-dialog')).to_be_hidden()
    assert texts(page)[0]=='第二次' and strokes(page)==1

    # 對話框開著時，Delete／快捷鍵不影響畫布
    page.click('#ai-button')
    page.click('#ai-request')
    page.keyboard.press('Escape')
    expect(page.locator('#ai-dialog')).to_be_hidden()

    # 重新整理後保留
    expect(page.locator('#save-state')).to_have_text('已儲存')
    page.reload()
    page.wait_for_selector('.row.active')
    assert texts(page)[0]=='第二次' and texts(page)[-1]=='AI 新增的條列',texts(page)

    assert not errors,errors
    browser.close()
print('ai smoke ok')
