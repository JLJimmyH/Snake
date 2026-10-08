"""Code blocks and Mermaid diagrams in text boxes: highlighting, width, copy button, raw editing with Tab, errors, theme, paste and image export."""
import os, base64
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8031')
SHOTS=os.environ.get('NOTE_TEST_SHOTS')
CODE='const x = add(1, 2); // sum\nfunction add(a, b) {\n    return a + b;  // a fairly long line that is wider than thirty-two characters\n}'
FLOW='flowchart LR\n  A[開始] --> B{判斷?}\n  B -->|是| C[處理]\n  B -->|否| D[結束]'
TEXT='說明：\n```js\n'+CODE+'\n```\n```mermaid\n'+FLOW+'\n```\n結尾 <script>x</script>'
BAD='```mermaid\nflowchart LR\n  A -->\n```'

def state(page):
    return page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      return db.get('docs',(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage);
    }""")

def text_of(page, id):
    return next(it['text'] for it in state(page)['items'] if it['id']==id)

def clip(page):
    return page.evaluate('navigator.clipboard.readText()').replace('\r\n','\n')  # Windows 的剪貼簿是 CRLF

def saved(page):
    expect(page.locator('#save-state')).to_have_text('已儲存')

def center(locator):
    box=locator.bounding_box()
    return box['x']+box['width']/2,box['y']+box['height']/2

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':900},color_scheme='light')
    context.grant_permissions(['clipboard-read','clipboard-write'],origin=BASE)
    page=context.new_page()
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_selector('.row.active')
    page.evaluate("""async ([text, bad]) => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:20,s:1},items:[
        {id:'md',type:'text',x:100,y:40,size:18,text},
        {id:'bad',type:'text',x:100,y:620,size:18,text:bad}]});
    }""",[TEXT,BAD])
    page.reload()
    md=page.locator('[data-id=md]');body=md.locator('.text-body')

    # Code block: highlighted, fences hidden, wider than the 32em text limit, prose still wraps at 32em.
    expect(body.locator('.md-pre')).to_have_count(1)
    expect(body.locator('.md-pre code')).to_have_text(CODE,use_inner_text=True)
    expect(body.locator('.md-pre .tok-k').first).to_have_text('const')
    expect(body.locator('.md-pre .tok-c').first).to_have_text('// sum')
    expect(body.locator('.md-pre .tok-f').first).to_have_text('add')
    assert '```' not in body.inner_text()
    assert body.locator('script').count()==0 and '<script>x</script>' in body.inner_text()
    widths=page.evaluate("""() => {
      const el=document.querySelector('[data-id=md]'), em=parseFloat(getComputedStyle(el).fontSize);
      return {item:el.offsetWidth, limit:32*em, segs:[...el.querySelectorAll('.md-seg')].map(s=>s.offsetWidth)};
    }""")
    assert widths['item']>widths['limit'] and all(w<=widths['limit']+1 for w in widths['segs']),widths
    print('PASS: code block renders highlighted and widens the text box')

    # Mermaid: drawn into an inert <img> (data: SVG), sized with the font; bad syntax shows an error instead.
    img=body.locator('img.md-diagram')
    expect(img).to_have_count(1,timeout=20000)
    src=img.get_attribute('src')
    assert src.startswith('data:image/svg+xml'),src[:40]
    svg=page.evaluate("s => decodeURIComponent(s.split(',')[1])",src)
    assert '開始' in svg and '<foreignObject' not in svg and '<script' not in svg
    expect(page.locator('[data-id=bad] .md-diagram-error')).to_contain_text('流程圖畫不出來')
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'code-light.png'))
    print('PASS: mermaid renders as an image, errors are shown')

    # The minimap shows the diagram itself, not gray text lines.
    drawn=page.evaluate("""() => new Promise(resolve => {
      const ctx=document.querySelector('#minimap canvas').getContext('2d'), orig=ctx.drawImage;
      let hit=false;
      ctx.drawImage=function (img, ...rest) { if (img.classList?.contains('md-diagram')) hit=true; return orig.call(this, img, ...rest); };
      dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => requestAnimationFrame(() => { ctx.drawImage=orig; resolve(hit); }));
    })""")
    assert drawn
    print('PASS: minimap draws the diagram')

    # The copy button copies the block's source and does not start editing.
    page.locator('.tool[data-tool=select]').click()
    page.mouse.click(*center(body.locator('.md-seg').first))
    expect(page.locator('[data-id=md].selected')).to_have_count(1)
    body.locator('.md-pre .md-copy').click()
    expect(body.locator('.md-pre .md-copy[data-done]')).to_have_count(1)
    assert clip(page)==CODE
    body.locator('.md-mermaid .md-copy').click()
    assert clip(page)==FLOW
    assert not page.evaluate("document.activeElement.classList.contains('text-body')")
    print('PASS: copy button copies code and diagram source')

    # Copy image: the export draws code and diagram (canvas is not tainted).
    page.click('#export-button')
    page.click('#export-image')
    expect(page.locator('#toast')).to_contain_text('已複製圖片')
    png=page.evaluate("""async () => {
      const [item]=await navigator.clipboard.read(), blob=await item.getType('image/png');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      let s=''; for (const b of bytes) s+=String.fromCharCode(b);
      return btoa(s);
    }""")
    data=base64.b64decode(png)
    assert data[:8]==b'\x89PNG\r\n\x1a\n' and len(data)>5000,len(data)
    if SHOTS: open(os.path.join(SHOTS,'code-export.png'),'wb').write(data)
    print('PASS: copy image includes the blocks')

    # Editing shows the raw markdown; Tab indents, a multi-line selection indents and outdents whole lines.
    page.keyboard.press('Escape')
    page.locator('.tool[data-tool=text]').click()
    page.mouse.click(*center(body.locator('.md-seg').last))
    expect(body).to_have_text(TEXT,use_inner_text=True)
    assert md.evaluate('el => el.style.width')!=''  # width held while editing
    page.keyboard.press('Control+End')
    page.keyboard.press('Enter');page.keyboard.type('a');page.keyboard.press('Enter');page.keyboard.type('b')
    page.keyboard.press('Home');page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.innerText").endswith('\na\n    b')
    page.keyboard.press('Shift+Tab')
    assert page.evaluate("document.activeElement.innerText").endswith('\na\nb')
    page.keyboard.press('Shift+ArrowUp');page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.innerText").endswith('\n    a\n    b')
    page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.innerText").endswith('\n        a\n        b')
    page.keyboard.press('Shift+Tab');page.keyboard.press('Shift+Tab')
    assert page.evaluate("document.activeElement.innerText").endswith('\na\nb')
    page.keyboard.press('Control+z')
    assert page.evaluate("document.activeElement.innerText").endswith('\n    a\n    b')
    page.locator('#page-title').click();saved(page)
    assert text_of(page,'md')==TEXT+'\n    a\n    b',text_of(page,'md')
    expect(body.locator('.md-pre')).to_have_count(1)
    assert md.evaluate('el => el.style.width')==''
    print('PASS: edit raw text, Tab and Shift+Tab indent lines with browser undo')

    # Dark canvas: code uses dark colors and the diagram is redrawn with the dark theme.
    page.click('#btn-appearance')
    page.click('#appearance-panel [data-canvas="#23302a"]')
    page.keyboard.press('Escape')
    expect(img).not_to_have_attribute('src',src,timeout=20000)
    assert page.evaluate("getComputedStyle(document.querySelector('.md-pre')).backgroundColor")=='rgb(40, 44, 52)'
    if SHOTS: page.screenshot(path=os.path.join(SHOTS,'code-dark.png'))
    print('PASS: dark canvas restyles code and redraws the diagram')

    # Paste: <pre> and VS Code's HTML become fenced blocks (plain paste keeps just the code);
    # Ctrl+V from VS Code wraps the text in a fence with its language.
    out=page.evaluate("""async () => {
      const {htmlToMarkdown, htmlToText}=await import('./js/markdown.js');
      const pre='<p>hi</p><pre><code class="language-python">def f():\\n\\n\\n    return 1\\n</code></pre>';
      const vs='<div style="color: #ccc;font-family: Consolas, monospace;white-space: pre;"><div><span>int a;</span></div><div><br></div><div><span>  a++;</span></div></div>';
      return [htmlToMarkdown(pre), htmlToText(pre), htmlToMarkdown(vs)];
    }""")
    assert out==['hi\n```python\ndef f():\n\n\n    return 1\n```','hi\ndef f():\n\n\n    return 1','```\nint a;\n\n  a++;\n```'],out
    page.locator('.tool[data-tool=select]').click()
    page.mouse.click(1000,800)
    page.evaluate("""() => {
      const dt=new DataTransfer();
      dt.setData('text/plain','print(1)\\n# comment');
      dt.setData('vscode-editor-data',JSON.stringify({version:1,mode:'python'}));
      document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));
    }""")
    saved(page)
    pasted=[it['text'] for it in state(page)['items'] if it['id'] not in ('md','bad')]
    assert pasted==['```python\nprint(1)\n# comment\n```'],pasted
    print('PASS: pasted code becomes a code block')
    assert not errors,errors
    browser.close()
