// Extra geometry helpers used by the handwriting path.
// Tesseract in sparse mode (PSM 11) tends to emit one "line" per word, so we
// re-cluster words into visual text lines ourselves.

export function clusterIntoLines(words, { overlapFrac = 0.25 } = {}) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  let cur = null;

  for (const w of sorted) {
    if (!cur) {
      cur = { words: [w], top: w.y0, bottom: w.y1, height: w.y1 - w.y0 };
      lines.push(cur);
      continue;
    }
    const height = Math.max(cur.height, cur.bottom - cur.top);
    // Same visual line if the new word starts above the line's bottom minus a
    // small overlap allowance (handwriting ascenders/descenders overlap a bit).
    const tolerance = height * overlapFrac;
    if (w.y0 < cur.bottom - tolerance || w.y0 - cur.top <= height * 0.9) {
      cur.words.push(w);
      cur.bottom = Math.max(cur.bottom, w.y1);
      cur.height = Math.max(cur.height, w.y1 - w.y0);
    } else {
      cur = { words: [w], top: w.y0, bottom: w.y1, height: w.y1 - w.y0 };
      lines.push(cur);
    }
  }

  return lines.map((L) => {
    L.words.sort((a, b) => a.x0 - b.x0);
    L.x0 = Math.min(...L.words.map((w) => w.x0));
    L.x1 = Math.max(...L.words.map((w) => w.x1));
    L.y0 = Math.min(...L.words.map((w) => w.y0));
    L.y1 = Math.max(...L.words.map((w) => w.y1));
    L.yc = (L.y0 + L.y1) / 2;
    L.conf = L.words.reduce((s, w) => s + (w.conf || 0), 0) / L.words.length;
    return L;
  }).sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
}

export { groupParagraphs } from './tsv.js';
