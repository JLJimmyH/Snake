// 外觀：深色模式（跟隨系統／淺色／深色）與畫布顏色，記在這台裝置，不跟著筆記本走
// <html data-theme> 由 index.html 開頭的小段程式先設好，避免載入時先閃一下白色
import { isDark } from './color.js';

// 畫布選「自動」時跟著主題
const AUTO = { light: '#ffffff', dark: '#1e1e1e' };
const system = matchMedia('(prefers-color-scheme: dark)');

const load = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

export function setupAppearance({ board, button, panel, onCanvas }) {
  let theme = load('theme', 'system');
  let canvas = load('canvasColor', 'auto');
  const picker = panel.querySelector('input[type=color]');

  function apply() {
    const dark = theme === 'dark' || (theme === 'system' && system.matches);
    const color = canvas === 'auto' ? AUTO[dark ? 'dark' : 'light'] : canvas;
    const darkCanvas = isDark(color);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    // 畫布上的文字與格點跟著畫布深淺，不是跟著主題（深色介面也可以配白紙）
    root.style.setProperty('--board', color);
    root.style.setProperty('--ink', darkCanvas ? '#e6e4df' : '#37352f');
    root.style.setProperty('--dot', darkCanvas ? 'rgba(255, 255, 255, .16)' : 'rgba(0, 0, 0, .16)');
    board.setCanvas(color);
    onCanvas?.();

    for (const b of panel.querySelectorAll('[data-theme-option]')) b.setAttribute('aria-pressed', String(b.dataset.themeOption === theme));
    for (const b of panel.querySelectorAll('[data-canvas]')) {
      const on = b.dataset.canvas === canvas;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    picker.value = color;
  }

  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }

  button.addEventListener('click', () => {
    if (!panel.hidden) return close();
    const r = button.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(innerWidth - 248, r.right - 240)) + 'px';
    panel.style.top = r.bottom + 8 + 'px';
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  });

  panel.addEventListener('click', e => {
    const t = e.target.closest('[data-theme-option]');
    const c = e.target.closest('[data-canvas]');
    if (t) {
      theme = t.dataset.themeOption;
      save('theme', theme);
    } else if (c) {
      canvas = c.dataset.canvas;
      save('canvasColor', canvas);
    } else return;
    apply();
  });

  picker.addEventListener('input', () => {
    canvas = picker.value;
    save('canvasColor', canvas);
    apply();
  });

  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#appearance-panel, #btn-appearance')) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(true); });
  window.addEventListener('resize', () => close());
  system.addEventListener('change', () => { if (theme === 'system') apply(); });
  // 其他分頁改了設定也跟著換
  window.addEventListener('storage', e => {
    if (e.key !== 'theme' && e.key !== 'canvasColor') return;
    theme = load('theme', 'system');
    canvas = load('canvasColor', 'auto');
    apply();
  });

  apply();
}
