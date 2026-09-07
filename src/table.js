// Reconstruct a grid (table) from word-level boxes produced by Tesseract.
// Tesseract's TSV often merges all words into a single fake "line", so we
// cluster words into visual rows ourselves, then split each row into cells
// wherever the horizontal gap is much larger than a normal inter-word space.

export function buildTable(lines) {
  const words = lines.flatMap((l) => l.words || []).filter((w) => w.conf >= 15);
  if (!words.length) return null;

  // --- 1) cluster words into visual rows by vertical overlap ---
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows = []; // {words, y0, y1, yc}
  let cur = null;
  for (const w of sorted) {
    if (!cur) {
      cur = { words: [w], y0: w.y0, y1: w.y1 };
      rows.push(cur);
      continue;
    }
    const h = Math.max(cur.y1 - cur.y0, w.y1 - w.y0);
    // Same visual row if vertical ranges overlap by a decent margin
    // (ascenders/descenders still belong to one row).
    if (w.y0 < cur.y1 - Math.max(2, h * 0.15) || Math.abs(w.y0 - cur.y0) < h * 0.5) {
      cur.words.push(w);
      cur.y0 = Math.min(cur.y0, w.y0);
      cur.y1 = Math.max(cur.y1, w.y1);
    } else {
      cur = { words: [w], y0: w.y0, y1: w.y1 };
      rows.push(cur);
    }
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    r.yc = (r.y0 + r.y1) / 2;
  }
  rows.sort((a, b) => a.yc - b.yc || a.words[0].x0 - b.words[0].x0);

  // --- 2) split each row into cells by horizontal gap clustering ---
  // A normal inter-word space is a fraction of a character height, while a
  // column gutter is usually at least a full character height wide. Use the
  // median word height as the split threshold (scale-invariant).
  const heights = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const cap = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
  const splitGap = Math.max(cap, 18);

  const grid = [];
  const confs = [];
  for (const r of rows) {
    const cells = [];
    let cell = { words: [r.words[0]], c: 0 };
    for (let i = 1; i < r.words.length; i++) {
      const w = r.words[i];
      if (w.x0 - cell.words[cell.words.length - 1].x1 > splitGap) {
        cells.push(cell);
        cell = { words: [w], c: cells.length };
      } else {
        cell.words.push(w);
      }
    }
    cells.push(cell);
    const text = cells.map((c) => c.words.map((w) => w.text).join(' '));
    const conf = cells.map((c) => {
      const s = c.words.reduce((a, w) => a + w.conf, 0);
      return s / c.words.length;
    });
    grid.push(text);
    confs.push(conf);
  }

  const nCols = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < nCols) r.push('');
  const paddedConfs = confs.map((r) => {
    while (r.length < nCols) r.push(null);
    return r.map((c) => (c === null ? null : Math.round(c)));
  });

  return {
    grid,
    confs: paddedConfs,
    headers: grid[0] ? [...grid[0]] : null,
    nCols,
    csv: toCsv(grid),
    markdown: toMarkdown(grid),
    html: toHtml(grid, paddedConfs),
  };
}

function escCsv(v) {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function toCsv(grid) {
  return grid.map((r) => r.map((c) => escCsv(c)).join(',')).join('\n');
}
function toMarkdown(grid) {
  if (!grid.length) return '';
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (c, n) => c.padEnd(n);
  const head = grid[0].map((c, i) => pad(c, width));
  const sep = grid[0].map(() => '-'.repeat(Math.max(width, 3)));
  const body = grid.slice(1).map((r) => Array.from({ length: width }, (_, i) => pad(r[i] || '', width)));
  return [head.join(' | ').trimEnd(), sep.join(' | '), ...body.map((r) => r.join(' | ').trimEnd())].join('\n');
}
function toHtml(grid, confs) {
  if (!grid.length) return '';
  const cls = (c) => {
    if (c === null) return '';
    if (c < 55) return ' class="low"';
    if (c < 75) return ' class="mid"';
    return '';
  };
  const cell = (v, c) => `<td${cls(c)}>${escapeHtml(v) || '&nbsp;'}</td>`;
  const head = `<tr>${grid[0].map((v) => `<th>${escapeHtml(v) || '&nbsp;'}</th>`).join('')}</tr>`;
  const body = grid.slice(1).map((r, ri) => {
    const confRow = confs[ri + 1] || [];
    const w = Math.max(grid[0].length, r.length);
    return `<tr>${Array.from({ length: w }, (_, i) => cell(r[i] || '', confRow[i])).join('')}</tr>`;
  }).join('');
  return `<table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
