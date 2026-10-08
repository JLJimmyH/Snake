"""Right-click menu: cut/copy/delete, paste at the clicked spot, paste in place, paste as plain text (also Ctrl+Shift+V), paste keeping the formatting of copied HTML, Ctrl+X, and greyed-out options the clipboard can't fill."""
import json, os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8060')

HTML=('<meta charset="utf-8"><h2>標題 <b>粗</b></h2>\n  <p><b>粗體</b> 和 <i>斜體</i>，<code>x = 1</code></p>\n'
      '<ul>\n  <li>一</li>\n  <li>二<ul><li>三</li></ul></li>\n  <li><input type="checkbox" checked> 做完了</li>\n</ul>\n'
      '<ol start="3"><li>第三</li></ol><p><br></p>'
      '<p>第一行<br>第二行 <a href="https://example.com/a b">連結</a> <a href="javascript:alert(1)">壞</a></p>'
      '<b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700">文件粗</span><span>一般</span></b>'
      '<script>alert(1)</script><table><tr><td>A</td><td><p>B</p></td></tr></table>')
MARKDOWN=('## 標題 粗\n**粗體** 和 *斜體*，`x = 1`\n- 一\n- 二\n  - 三\n- [x] 做完了\n3. 第三\n\n'
          '第一行\n第二行 [連結](https://example.com/a%20b) 壞\n**文件粗**一般\nA | B')

PLAIN=('標題 粗\n粗體 和 斜體，x = 1\n• 一\n• 二\n  • 三\n• 做完了\n3. 第三\n\n'
       '第一行\n第二行 連結 壞\n文件粗一般\nA | B')

def items(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      return (await db.get('docs',(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage)).items;
    }""")

def texts(page):
    return page.locator('.text-item .text-body').all_inner_texts()

def right(page, x, y):
    page.mouse.click(x,y,button='right')
    expect(page.locator('#menu')).to_be_visible()  # 選單要等讀完剪貼簿才出現

def labels(page):
    return page.eval_on_selector_all('#menu button','bs => bs.map(b => b.firstChild.textContent)')

def disabled(page):
    return page.eval_on_selector_all('#menu button:disabled','bs => bs.map(b => b.firstChild.textContent)')

def pick(page, label):
    page.locator('#menu button').nth(labels(page).index(label)).click()

def write(page, text, html=None):
    if html is None: page.evaluate('t => navigator.clipboard.writeText(t)',text)
    else: page.evaluate("""([t,h]) => navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([t],{type:'text/plain'}), 'text/html': new Blob([h],{type:'text/html'})})])""",[text,html])

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900})
    context.grant_permissions(['clipboard-read','clipboard-write'],origin=BASE)
    page=context.new_page()
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(BASE+'/')
    page.wait_for_selector('.row.active')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:0,y:0,s:1},items:[{id:'src',type:'text',x:120,y:120,size:20,text:'來源'}]});
    }""")
    page.reload();expect(page.locator('.text-item')).to_have_count(1)
    vp=page.locator('#viewport').bounding_box()
    src=page.locator('[data-id=src]').bounding_box()
    sx,sy=src['x']+src['width']/2,src['y']+src['height']/2

    # 右鍵物件：剪下／複製／刪除、四種貼上、匯出；剪貼簿是一般文字時「原始格式貼上」「原位貼上」是灰的
    write(page,'一般文字')
    right(page,sx,sy)
    expect(page.locator('#menu button')).to_have_count(8)
    assert labels(page)==['剪下','複製（1 個物件）','刪除','貼上','純文字貼上','原始格式貼上','原位貼上','匯出 PDF'],labels(page)
    assert disabled(page)==['原始格式貼上','原位貼上'],disabled(page)
    expect(page.locator('#menu button').first.locator('.menu-hint')).to_have_text('Ctrl+X')
    pick(page,'複製（1 個物件）')
    expect(page.locator('#toast')).to_contain_text('已複製 1 個物件')

    # 貼上：外框左上角放在按右鍵的地方
    px,py=vp['x']+500,vp['y']+400
    right(page,px,py)
    assert disabled(page)==['原始格式貼上'],disabled(page)
    pick(page,'貼上')
    expect(page.locator('.text-item')).to_have_count(2)
    added=page.locator('.text-item').last.bounding_box()
    assert abs(added['x']-px)<4 and abs(added['y']-py)<4,(added,px,py)

    # 原位貼上：疊在原本的位置
    right(page,vp['x']+800,vp['y']+250)
    pick(page,'原位貼上')
    expect(page.locator('.text-item')).to_have_count(3)
    saved(page)
    placed=[(it['x'],it['y']) for it in items(page)]
    assert placed[0]==(120,120) and placed[2]==(120,120) and placed[1]!=(120,120),placed

    # 純文字貼上：複製的物件也只是一段文字
    right(page,px,py+150)
    pick(page,'純文字貼上')
    expect(page.locator('.text-item')).to_have_count(4)
    saved(page)
    assert json.loads(items(page)[3]['text'])['items'][0]['text']=='來源'

    # 剪下：拿掉選取的物件，剪貼簿裡是它
    page.keyboard.press('Escape')
    right(page,sx,sy)
    pick(page,'刪除')
    expect(page.locator('.text-item')).to_have_count(3)
    page.keyboard.press('Control+Z')
    expect(page.locator('.text-item')).to_have_count(4)
    right(page,px+5,py+5)
    pick(page,'剪下')
    expect(page.locator('#toast')).to_contain_text('已剪下 1 個物件')
    expect(page.locator('.text-item')).to_have_count(3)
    assert json.loads(page.evaluate('navigator.clipboard.readText()'))['items'][0]['text']=='來源'

    # Ctrl+X 也是剪下；Ctrl+Shift+V 是純文字貼上
    page.keyboard.press('Escape')
    page.mouse.click(sx,sy)  # 疊在最上面的是原位貼上的那一個
    page.keyboard.press('Control+X')
    expect(page.locator('#toast')).to_contain_text('已剪下 1 個物件')
    expect(page.locator('.text-item')).to_have_count(2)
    page.mouse.click(vp['x']+700,vp['y']+120)
    page.keyboard.press('Control+Shift+V')
    expect(page.locator('.text-item')).to_have_count(3)
    assert '"items"' in texts(page)[-1],texts(page)
    page.keyboard.press('Control+V')  # 一般的 Ctrl+V 還是貼成物件
    expect(page.locator('.text-item')).to_have_count(4)
    assert texts(page).count('來源')==2,texts(page)

    # 原始格式貼上：HTML 的標題、粗斜體、清單、連結變成 markdown；「貼上」還是純文字
    write(page,'純文字版本',HTML)
    page.keyboard.press('Escape')
    right(page,vp['x']+300,vp['y']+250)
    assert disabled(page)==['原位貼上'],disabled(page)
    pick(page,'原始格式貼上')
    expect(page.locator('.text-item')).to_have_count(5)
    saved(page)
    assert items(page)[-1]['text']==MARKDOWN,items(page)[-1]['text']
    body=page.locator('.text-item').last.locator('.text-body')
    expect(body.locator('.md-h2')).to_have_text('標題 粗')
    expect(body.locator('strong').first).to_have_text('粗體')
    expect(body.locator('a')).to_have_attribute('href','https://example.com/a%20b')
    page.keyboard.press('Escape')
    right(page,vp['x']+150,vp['y']+450)
    pick(page,'貼上')
    expect(page.locator('.text-item .text-body',has_text='純文字版本')).to_have_count(1)

    # 純文字貼上：ChatGPT 這類網站的純文字是 markdown，要從 HTML 取看得到的文字，不能有任何格式
    write(page,'## 標題 **粗**\n**粗體** 和 *斜體*',HTML)
    page.keyboard.press('Escape')
    right(page,vp['x']+700,vp['y']+450)
    pick(page,'純文字貼上')
    expect(page.locator('.text-item')).to_have_count(7)
    saved(page)
    assert items(page)[-1]['text']==PLAIN,items(page)[-1]['text']
    body=page.locator('.text-item').last.locator('.text-body')
    expect(body.locator('strong, em, code, a, .md-h1, .md-h2, .md-h3, .md-bullet, .md-check')).to_have_count(0)
    # Ctrl+Shift+V 一樣
    page.keyboard.press('Escape')
    page.mouse.click(vp['x']+150,vp['y']+650)
    page.keyboard.press('Control+Shift+V')
    expect(page.locator('.text-item')).to_have_count(8)
    saved(page)
    assert items(page)[-1]['text']==PLAIN,items(page)[-1]['text']

    # 空白的頁面也有貼上選項
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:0,y:0,s:1},items:[]});
    }""")
    page.reload();page.wait_for_selector('.row.active')
    expect(page.locator('.text-item')).to_have_count(0)
    right(page,vp['x']+400,vp['y']+300)
    expect(page.locator('#menu button')).to_have_count(4)
    assert labels(page)==['貼上','純文字貼上','原始格式貼上','原位貼上'],labels(page)

    assert not errors,errors
    browser.close()
print('paste menu smoke ok')
