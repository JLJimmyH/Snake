// 畫布底色與筆跡顯示色：只處理 #rgb / #rrggbb，其他格式原樣回傳

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(c) {
  if (typeof c !== 'string' || !HEX.test(c)) return null;
  let h = c.slice(1);
  if (h.length === 3) h = [...h].map(x => x + x).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

const toHex = rgb => '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

// WCAG 相對亮度
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// 深色＝白字比黑字清楚
export function isDark(color) {
  const rgb = parseHex(color);
  return !!rgb && luminance(rgb) < 0.18;
}

// 筆跡跟畫布太接近（深色畫布上的黑筆、淺色畫布上的白筆）就改顯示成反轉明度的顏色，色相不變，資料不動。
// 原本的顏色都是對著白紙挑的，所以深色畫布門檻寬（深藍、深綠也會變亮），淺色畫布只處理幾乎看不到的。
export function readableInk(color, canvas) {
  const ink = parseHex(color), bg = parseHex(canvas);
  if (!ink || !bg) return color;
  const lb = luminance(bg);
  if (contrast(luminance(ink), lb) >= (lb < 0.18 ? 3 : 1.25)) return color;
  // HSL 明度 L → 1-L 時彩度不變，等於每個通道加上同一個位移
  const d = 1 - Math.max(...ink) - Math.min(...ink);
  return toHex(ink.map(v => v + d));
}
