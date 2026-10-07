// 操作方式：觸控（手機、平板）、觸控筆（手指只移動畫布）或滑鼠（電腦），記在這台裝置，不跟著筆記本走。
// 沒選過就看主要的輸入裝置：能懸停的精準指標（滑鼠、觸控板）＝滑鼠，其他＝觸控；第一次用觸控筆就換成觸控筆。
// 跟版面寬度無關：版面（側欄要不要收起來）仍看視窗寬度。
const load = () => { try { return localStorage.getItem('inputMode'); } catch { return null; } };
const save = value => { try { localStorage.setItem('inputMode', value); } catch { /* ignore */ } };
const detect = () => (matchMedia('(hover: hover) and (pointer: fine)').matches ? 'mouse' : 'touch');
const valid = m => (m === 'mouse' || m === 'touch' || m === 'pen' ? m : null);

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
  // 捕獲階段先換好，畫板收到這次 pointerdown 時已經是觸控筆模式
  window.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'pen' || mode === 'pen' || valid(load())) return;
    mode = 'pen';
    save(mode);
    apply();
  }, true);
  // 其他分頁改了也跟著換
  window.addEventListener('storage', e => {
    if (e.key !== 'inputMode') return;
    mode = valid(e.newValue) ?? detect();
    apply();
  });

  apply();
}
