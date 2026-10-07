// 快捷鍵說明面板：頂列的「?」按鈕或按 ? 鍵開關，只在電腦版排版顯示按鈕
export function setupShortcuts({ button, panel }) {
  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }

  function open() {
    panel.hidden = false;
    const r = button.getBoundingClientRect();
    const w = panel.offsetWidth;
    panel.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    panel.style.top = r.bottom + 8 + 'px';
    button.setAttribute('aria-expanded', 'true');
  }

  const toggle = () => (panel.hidden ? open() : close());

  button.addEventListener('click', toggle);
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#shortcuts-panel, #btn-shortcuts')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(true); });
  window.addEventListener('resize', () => close());

  return { toggle };
}
