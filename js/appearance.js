// 外觀：主題（跟隨系統或指定一個，每個主題屬於淺色或深色系列）與畫布顏色，記在這台裝置，不跟著筆記本走
// <html data-theme data-palette> 由 index.html 開頭的小段程式先設好，避免載入時先閃一下別的顏色
import { isDark } from './color.js';

// 跟隨系統時用的主題
const SYSTEM = { light: 'vscode-light', dark: 'atom' };
const system = matchMedia('(prefers-color-scheme: dark)');

const load = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

export function setupAppearance({ board, button, panel, onCanvas }) {
  const cards = [...panel.querySelectorAll('.theme-card')];
  const modeOf = p => cards.find(c => c.dataset.palette === p)?.dataset.mode;
  // 'system' 或主題名稱；舊版存 light／dark，主題另外存在 lightPalette／darkPalette。不認得的就跟隨系統
  const loadTheme = () => {
    let t = load('theme', 'system');
    if (t === 'light' || t === 'dark') t = load(t + 'Palette', SYSTEM[t]);
    return modeOf(t) ? t : 'system';
  };
  let theme = loadTheme();
  let canvas = load('canvasColor', 'auto');
  const picker = panel.querySelector('input[type=color]');
  const meta = document.querySelector('meta[name=theme-color]');

  function apply() {
    const palette = theme === 'system' ? SYSTEM[system.matches ? 'dark' : 'light'] : theme;
    const root = document.documentElement;
    root.dataset.theme = modeOf(palette);
    root.dataset.palette = palette;
    const css = getComputedStyle(root);
    // 畫布選「自動」時用主題的畫布色
    const color = canvas === 'auto' ? css.getPropertyValue('--canvas-auto').trim() : canvas;
    const darkCanvas = isDark(color);
    meta.content = css.getPropertyValue('--surface').trim();
    // 畫布上的文字與格點跟著畫布深淺，不是跟著主題（深色介面也可以配白紙）
    root.style.setProperty('--board', color);
    root.style.setProperty('--ink', darkCanvas ? '#dcdfe4' : '#3b3b3b');
    root.style.setProperty('--dot', darkCanvas ? 'rgba(255, 255, 255, .16)' : 'rgba(0, 0, 0, .16)');
    board.setCanvas(color);
    onCanvas?.();

    for (const b of cards) b.setAttribute('aria-pressed', String(b.dataset.palette === theme));
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
    const t = e.target.closest('.theme-card');
    const c = e.target.closest('[data-canvas]');
    if (t) {
      theme = t.dataset.palette;
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
    theme = loadTheme();
    canvas = load('canvasColor', 'auto');
    apply();
  });

  apply();
}
