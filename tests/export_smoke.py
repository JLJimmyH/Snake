"""Verify the export menu: PDF of the selection (right-click or top-bar button) or the whole page, printed on white paper on one A4 page, copying an image, handing off to AI, and that the button fits the mobile top bar."""
import os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')

def menu(page, label):
    page.locator('#menu button',has_text=label).click()

def printed(page, n):
    page.wait_for_function('n => window.__prints === n',arg=n)
    return page.evaluate("""() => {
      const root=document.querySelector('#print-root');
      return {
        strokes:[...root.querySelectorAll('svg.ink path')].map(p => p.getAttribute('stroke')),
        texts:root.querySelectorAll('.text-item').length,
        images:[...root.querySelectorAll('.img-item img')].map(img => img.naturalWidth),
        editable:root.querySelectorAll('[contenteditable]').length,
        selected:root.querySelectorAll('.selected').length,
        page:document.querySelector('#print-page').textContent,
        title:document.title,
      };
    }""")

def on_screen(page):
    return page.evaluate("""() => ({
      strokes:document.querySelectorAll('#viewport svg.ink path:not(.lasso)').length,
      texts:document.querySelectorAll('#viewport .text-item').length,
      images:document.querySelectorAll('#viewport .img-item').length,
    })""")

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900},color_scheme='light')
    context.grant_permissions(['clipboard-read','clipboard-write'],origin=BASE)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(BASE+'/')
    page.wait_for_selector('.row.active')
    # 不真的打開列印對話框，只記次數；#print-root 的內容就是會印出來的東西
    page.evaluate('() => { window.print = () => { window.__prints = (window.__prints || 0) + 1 } }')
    title=page.locator('#page-title').input_value()
    box=page.locator('#viewport').bounding_box()

    # 貼一張圖片
    page.evaluate("""async () => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=2;
      canvas.getContext('2d').fillRect(0,0,2,2);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    }""")
    page.mouse.click(box['x']+box['width']-300,box['y']+box['height']-140)
    page.keyboard.press('Control+V')
    expect(page.locator('.img-item')).to_have_count(1)
    page.keyboard.press('Escape')

    # 畫一條寬的黑色筆跡
    page.keyboard.press('q')
    x,y=box['x']+box['width']-560,box['y']+box['height']-160
    page.mouse.move(x,y); page.mouse.down()
    for i in range(1,10): page.mouse.move(x+i*20,y+(i%3)*8)
    page.mouse.up()
    page.keyboard.press('Escape')
    expect(page.locator('#save-state')).to_have_text('已儲存')

    # 右鍵筆跡：匯出 PDF 只印這一條，原本的顏色、白紙、橫向 A4
    page.mouse.click(x+40,y+8,button='right')
    expect(page.locator('#menu button')).to_have_count(8)
    menu(page,'匯出 PDF')
    p=printed(page,1)
    assert p['strokes']==['#1f2937'] and p['texts']==0 and p['images']==[],p
    assert p['selected']==0 and 'A4 landscape' in p['page'] and p['title']==title,p
    expect(page.locator('#print-root')).to_be_hidden()  # 平常不顯示

    # 頂列「匯出」：直接打開對話框，先看到截圖；有選取＝選取的部分
    page.click('#export-button')
    expect(page.locator('#export-heading')).to_have_text('匯出選取的 1 個物件')
    expect(page.locator('#export-preview')).to_be_visible()
    expect(page.locator('.export-actions button')).to_have_text(['✨ 複製給 AI','🖼 複製圖片','📄 匯出 PDF'])
    page.click('#export-image')
    expect(page.locator('#toast')).to_have_text(re.compile('已複製圖片|改成下載'))
    page.click('#export-close')

    # 沒有選取＝整頁，所有物件都在、文字不能編輯、圖片載入完成
    page.keyboard.press('Escape')
    page.mouse.click(box['x']+700,box['y']+300)
    page.click('#export-button')
    expect(page.locator('#export-heading')).to_have_text('匯出整頁')
    page.click('#export-pdf')
    expect(page.locator('#export-dialog')).to_be_hidden()  # 先關對話框再列印
    p=printed(page,2)
    s=on_screen(page)
    assert len(p['strokes'])==s['strokes'] and p['texts']==s['texts']>3 and len(p['images'])==s['images']==1,(p,s)
    assert p['images']==[2] and p['editable']==0,p

    # 真的用列印樣式輸出 PDF：只有一頁，畫面其他部分不會印出來
    page.emulate_media(media='print')
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS,'export-print.png'),full_page=True)
    assert page.locator('#app').is_hidden() and page.locator('#print-root').is_visible()
    pdf=page.pdf(prefer_css_page_size=True,print_background=True)
    pages=len(re.findall(rb'/Type\s*/Page\b',pdf))
    assert pages==1,pages
    if SHOTS:
        open(os.path.join(SHOTS,'export.pdf'),'wb').write(pdf)
    page.emulate_media(media='screen')

    # 深色畫布：畫面上的黑筆會反轉成亮色，印出來還是原本的黑色
    page.click('#btn-appearance')
    page.click('#appearance-panel .theme-card[data-palette=atom]')
    page.keyboard.press('Escape')
    assert page.locator('#viewport svg.ink path:not(.lasso)').last.get_attribute('stroke')!='#1f2937'
    page.mouse.click(x+40,y+8,button='right')
    menu(page,'匯出 PDF')
    assert printed(page,3)['strokes']==['#1f2937']

    # 交給 AI：同一個對話框，選取的部分
    page.click('#export-button')
    expect(page.locator('#export-heading')).to_have_text('匯出選取的 1 個物件')
    expect(page.locator('#ai-copy')).to_be_enabled()
    page.click('#export-close')

    # 手機：匯出按鈕在頂列裡，頂列沒有被擠爆
    page.set_viewport_size({'width':390,'height':844})
    expect(page.locator('#export-button')).to_be_visible()
    b=page.locator('#export-button').bounding_box()
    assert b['x']+b['width']<=390,b
    assert page.evaluate("(t => t.scrollWidth <= t.clientWidth)(document.querySelector('#topbar'))")

    assert not errors,errors
    browser.close()
print('export smoke ok')
