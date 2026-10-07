"""Markdown text boxes: rendering, safe output, checkbox toggling, links and raw-text editing."""
import os, re
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8030')
TEXT='# Title\n**mmmm** and *it* `code`\n  - item\n- [ ] todo\n- [x] done\n[site](https://example.com/) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>'

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

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1200,'height':800})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async (text) => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'md',type:'text',x:100,y:80,size:20,text},
        {id:'plain',type:'text',x:100,y:400,size:20,text:'line one\\n\\nline 3 <b>x</b>'}]});
    }""",TEXT)
    page.reload();expect(page.locator('.text-item')).to_have_count(2)
    md=page.locator('[data-id=md] .text-body')

    # Rendering, and nothing executable comes out of the text.
    expect(md.locator('.md-h1')).to_have_text('Title')
    expect(md.locator('strong')).to_have_text('mmmm')
    expect(md.locator('em')).to_have_text('it')
    expect(md.locator('code')).to_have_text('code')
    expect(md.locator('.md-bullet')).to_have_count(1)
    expect(md.locator('.md-check')).to_have_count(2)
    expect(md.locator('.md-done')).to_have_text('done')
    expect(md.locator('a.md-link')).to_have_count(1)
    assert md.locator('a.md-link').get_attribute('href')=='https://example.com/'
    assert md.locator('img, b, script').count()==0
    assert '# Title' not in md.inner_text() and '[bad](javascript:alert(1))' in md.inner_text()
    expect(page.locator('[data-id=plain] .text-body')).to_have_text('line one\n\nline 3 <b>x</b>',use_inner_text=True)
    print('PASS: markdown renders and stays inert')

    # Tapping a checkbox toggles it without entering edit mode; undo restores.
    page.locator('.md-check').first.click();saved(page)
    assert '- [x] todo' in state(page)['items'][0]['text']
    assert not page.evaluate("document.activeElement.classList.contains('text-body')")
    expect(md.locator('.md-check[aria-checked=true]')).to_have_count(2)
    page.locator('#btn-undo').click();saved(page)
    assert state(page)['items'][0]['text']==TEXT
    print('PASS: checkbox toggles with undo')

    # Links open only on a tap inside an already selected text box.
    page.evaluate("()=>{window.opened=[];window.open=u=>{window.opened.push(u)}}")
    page.mouse.click(*center(md.locator('a.md-link')))
    expect(page.locator('[data-id=md].selected')).to_have_count(1)
    assert page.evaluate('window.opened')==[]
    page.mouse.click(*center(md.locator('a.md-link')))
    assert page.evaluate('window.opened')==['https://example.com/']
    assert not page.evaluate("document.activeElement.classList.contains('text-body')")
    print('PASS: link opens from a selected text box')

    # Editing shows raw markdown with the caret where the rendered text was clicked.
    page.locator('.tool[data-tool=text]').click()
    page.mouse.click(*center(md.locator('strong')))
    expect(md).to_have_text(TEXT,use_inner_text=True)
    page.keyboard.type('X')
    page.locator('#page-title').click();saved(page)
    text=state(page)['items'][0]['text']
    assert re.search(r'^\*\*m+Xm+\*\* and',text,re.M),text
    expect(md.locator('strong')).to_contain_text('X')
    print('PASS: edit raw markdown at the clicked position, re-render on blur')
    assert not errors,errors
    browser.close()
