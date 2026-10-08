"""Verify page search: Ctrl+F bar, jumping between far-apart hits, dots when zoomed out, minimap marks, the sidebar list."""
import os
from playwright.sync_api import sync_playwright, expect
BASE=os.environ.get('NOTE_TEST_ORIGIN','http://127.0.0.1:8050')

def view(page):
    return page.evaluate("""() => {
      const m=document.querySelector('.world').style.transform.match(/translate\\((.+?)px, (.+?)px\\) scale\\((.+?)\\)/);
      return {x:+m[1],y:+m[2],s:+m[3]};
    }""")

# The current hit is fully inside the viewport.
def current_visible(page):
    return page.evaluate("""() => {
      const v=document.querySelector('#viewport').getBoundingClientRect();
      const r=document.querySelector('.search-hit.current').getBoundingClientRect();
      return r.width>0&&r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom;
    }""")

# Orange (#ff8c00) pixels on the minimap = the current search mark.
ORANGE="""() => {
  const c=document.querySelector('#minimap canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let n=0;
  for (let i=0;i<d.length;i+=4) if (d[i]>230&&d[i+1]>120&&d[i+1]<160&&d[i+2]<40) n++;
  return n;
}"""

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE)
    expect(page.locator('#page-title')).to_have_value('歡迎使用')
    page.evaluate("""async () => {
      const {db}=await import('./js/db.js');
      const id=(await db.get('notebooks',sessionStorage.getItem('notebook'))).lastPage;
      await db.put('docs',{pageId:id,view:{x:40,y:40,s:1},items:[
        {id:'a',type:'text',x:0,y:0,size:18,text:'I like apple'},
        {id:'b',type:'text',x:5000,y:3000,size:18,text:'**Apple** pie'},
        {id:'c',type:'text',x:-4000,y:6000,size:18,text:'nothing here\\napple and apple'},
        {id:'ink',type:'stroke',tool:'pen',width:3,color:'#1f2937',pts:[[0,100],[200,100]]}
      ]});
    }""")
    page.reload();expect(page.locator('.text-item')).to_have_count(3)

    # Ctrl+F opens the bar; the hit already on screen becomes the current one without moving.
    page.locator('#viewport').click(position={'x':600,'y':500})
    page.keyboard.press('Control+f')
    expect(page.locator('#find')).to_be_visible()
    expect(page.locator('#find-input')).to_be_focused()
    before=view(page)
    page.keyboard.type('apple')
    expect(page.locator('#find-count')).to_have_text('1 / 4')
    expect(page.locator('.search-hit')).to_have_count(4)
    assert view(page)==before
    # Markdown markers are not part of the text: "**Apple**" matches, and the hit covers just the word.
    page.keyboard.press('Enter');page.wait_for_timeout(500)
    expect(page.locator('#find-count')).to_have_text('2 / 4')
    assert current_visible(page)
    box=page.locator('.search-hit.current').bounding_box()
    word=page.locator('.text-item[data-id=b] strong').bounding_box()
    assert abs(box['x']-word['x'])<2 and abs(box['width']-word['width'])<2,(box,word)
    print('PASS: Ctrl+F finds rendered text and jumps to the next hit')

    # Zoomed out to 10% every hit turns into a dot, and the minimap shows the current one.
    for _ in range(4): page.locator('#zoom-out').click()
    assert abs(view(page)['s']-.1)<1e-6
    expect(page.locator('.search-hit.far')).to_have_count(4)
    expect(page.locator('.search-hit.far.current')).to_have_count(1)
    dot=page.evaluate("""() => getComputedStyle(document.querySelector('.search-hit.far'),'::after').width""")
    assert abs(float(dot[:-2])*.1-12)<.5,dot
    assert page.evaluate(ORANGE)>0,'current mark missing from minimap'
    # Jumping from far away zooms in until the text is readable.
    page.locator('#find-next').click();page.wait_for_timeout(500)
    expect(page.locator('#find-count')).to_have_text('3 / 4')
    assert view(page)['s']>.5 and current_visible(page),view(page)
    expect(page.locator('.search-hit.far')).to_have_count(0)
    page.locator('#find-input').press('Shift+Enter');page.wait_for_timeout(500)
    expect(page.locator('#find-count')).to_have_text('2 / 4')
    assert current_visible(page)
    print('PASS: dots when zoomed out, minimap mark, jumping zooms in')

    # Show all fits every hit; Aa makes the search case-sensitive.
    page.locator('#find-all').click();page.wait_for_timeout(500)
    assert page.evaluate("""() => {
      const v=document.querySelector('#viewport').getBoundingClientRect();
      return [...document.querySelectorAll('.search-hit')].every(el => {
        const r=el.getBoundingClientRect();
        return r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom;
      });
    }""")
    page.locator('#find .find-case').click()
    expect(page.locator('#find-count')).to_contain_text('/ 3')
    expect(page.locator('#sp-input')).to_have_value('apple')
    print('PASS: show all and match case')

    # Ctrl+Shift+F lists the hits in the sidebar; clicking one jumps to it.
    page.keyboard.press('Control+Shift+F')
    expect(page.locator('#search-pane')).to_be_visible()
    expect(page.locator('#tree')).to_be_hidden()
    expect(page.locator('#sp-input')).to_be_focused()
    expect(page.locator('#sp-summary')).to_have_text('這一頁有 3 個結果')
    rows=page.locator('.sp-hit');expect(rows).to_have_count(3)
    expect(rows.nth(0)).to_have_text('I like apple')
    expect(rows.nth(1).locator('mark')).to_have_text('apple')
    rows.nth(2).click();page.wait_for_timeout(500)
    expect(page.locator('#find-count')).to_have_text('3 / 3')
    expect(rows.nth(2)).to_have_class('sp-hit current')
    assert current_visible(page)
    print('PASS: sidebar list')

    # Hits follow edits.
    page.locator('#find-input').fill('like');page.locator('#find-input').press('Enter');page.wait_for_timeout(500)
    page.locator('#find-input').fill('pie')
    expect(page.locator('#find-count')).to_contain_text('/ 1')
    page.locator('.text-item[data-id=a] .text-body').dblclick()
    page.keyboard.press('End');page.keyboard.type(' pie')
    expect(page.locator('#find-count')).to_contain_text('/ 2')
    page.keyboard.press('Escape')
    expect(page.locator('.search-hit')).to_have_count(2)
    # Ctrl+F while editing text opens our bar with the selected word.
    page.locator('.text-item[data-id=a] .text-body').dblclick()
    page.keyboard.press('Control+a');page.keyboard.press('Control+f')
    expect(page.locator('#find-input')).to_be_focused()
    expect(page.locator('#find-input')).to_have_value('I like apple pie')
    expect(page.locator('#find-count')).to_have_text('1 / 1')
    print('PASS: hits follow edits, Ctrl+F while editing')

    # Esc closes the bar but the sidebar list keeps the hits; switching back to pages clears them.
    page.keyboard.press('Escape')
    expect(page.locator('#find')).to_be_hidden()
    expect(page.locator('.search-hit')).to_have_count(1)
    page.locator('#tab-pages').click()
    expect(page.locator('#tree')).to_be_visible()
    expect(page.locator('.search-hit')).to_have_count(0)
    # The topbar button opens the bar too.
    page.locator('#find-button').click()
    expect(page.locator('#find')).to_be_visible()
    expect(page.locator('.search-hit')).to_have_count(1)
    print('PASS: closing and reopening')

    assert not errors,errors
    browser.close()
