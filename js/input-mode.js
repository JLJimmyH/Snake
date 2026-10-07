// 操作方式：觸控（手機、平板）或滑鼠（電腦），記在這台裝置，不跟著筆記本走。
// 沒選過就看主要的輸入裝置：能懸停的精準指標（滑鼠、觸控板）＝滑鼠，其他＝觸控。
// 跟版面寬度無關：版面（側欄要不要收起來）仍看視窗寬度。
// 觸控筆跟操作方式無關：這台裝置用過一次觸控筆，之後書寫只聽筆，手指只移動畫布。
const load = (key = 'inputMode') => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (value, key = 'inputMode') => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };
const detect = () => (matchMedia('(hover: hover) and (pointer: fine)').matches ? 'mouse' : 'touch');
const valid = m => (m === 'mouse' || m === 'touch' ? m : null);

export function setupInputMode({ board, panel, onChange }) {
  const buttons = [...panel.querySelectorAll('[data-input-mode]')];
  let mode = valid(load()) ?? detect();

  function apply() {
    board.setInputMode(mode);
    document.documentElement.dataset.input = mode;
    for (const b of buttons) {
      const on = b.dataset.inputMode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    onChange?.(mode);
  }

  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-input-mode]');
    if (!b) return;
    mode = b.dataset.inputMode;
    save(mode);
    apply();
  });
  // 捕獲階段先記下，畫板收到這次 pointerdown 時已經知道有筆
  board.penOnly = load('pen') === '1';
  window.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'pen' || board.penOnly) return;
    board.penOnly = true;
    save('1', 'pen');
  }, true);
  // 其他分頁改了也跟著換
  window.addEventListener('storage', e => {
    if (e.key === 'pen') board.penOnly = e.newValue === '1';
    if (e.key !== 'inputMode') return;
    mode = valid(e.newValue) ?? detect();
    apply();
  });

  apply();
}
