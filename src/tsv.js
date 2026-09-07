// Parse Tesseract TSV output into structured words/lines with boxes + confidence.

export function parseTsvToLines(tsvText, { minConf = 20 } = {}) {
  const rows = tsvText.split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) return [];

  // Tesseract.js sometimes strips the TSV header row — support both shapes.
  const first = rows[0].split('\t').map((c) => c.trim().toLowerCase());
  const hasHeader = first.includes('level') && first.includes('text');
  let start = 0;
  const idx = (name) => (hasHeader ? first.indexOf(name) : -1);
  const I = {
    level: hasHeader ? idx('level') : 0,
    block: hasHeader ? idx('block_num') : 1,
    par: hasHeader ? idx('par_num') : 2,
    line: hasHeader ? idx('line_num') : 3,
    left: hasHeader ? idx('left') : 6,
    top: hasHeader ? idx('top') : 7,
    width: hasHeader ? idx('width') : 8,
    height: hasHeader ? idx('height') : 9,
    conf: hasHeader ? idx('conf') : 10,
    text: hasHeader ? idx('text') : 11,
  };
  if (hasHeader) start = 1;

  const words = [];
  for (let r = start; r < rows.length; r++) {
    const c = rows[r].split('\t');
    if (c.length <= Math.max(I.text, I.conf)) continue;
    if (+c[I.level] !== 5) continue; // word rows only
    const text = (c[I.text] || '').trim();
    if (!text) continue;
    const conf = +c[I.conf];
    if (conf < minConf && !Number.isNaN(conf)) continue;
    words.push({
      block: +c[I.block] || 0,
      par: +c[I.par] || 0,
      line: +c[I.line] || 0,
      x0: +c[I.left] || 0,
      y0: +c[I.top] || 0,
      x1: (+c[I.left] || 0) + (+c[I.width] || 0),
      y1: (+c[I.top] || 0) + (+c[I.height] || 0),
      conf,
      text,
    });
  }
  if (!words.length) return [];

  // Group into text lines keyed by (block, par, line), keep block reading order.
  const linesMap = new Map();
  for (const w of words) {
    const key = `${w.block}:${w.par}:${w.line}`;
    if (!linesMap.has(key)) {
      linesMap.set(key, { block: w.block, par: w.par, line: w.line, words: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    }
    const L = linesMap.get(key);
    L.words.push(w);
    L.x0 = Math.min(L.x0, w.x0); L.y0 = Math.min(L.y0, w.y0);
    L.x1 = Math.max(L.x1, w.x1); L.y1 = Math.max(L.y1, w.y1);
  }

  const lines = [...linesMap.values()].map((L) => {
    L.words.sort((a, b) => a.x0 - b.x0);
    let wsum = 0, n = 0;
    for (const w of L.words) { wsum += w.conf * (w.x1 - w.x0); n += w.x1 - w.x0; }
    L.conf = n ? wsum / n : 0;
    L.yc = (L.y0 + L.y1) / 2;
    L.xc = (L.x0 + L.x1) / 2;
    return L;
  });

  // Order top→bottom; ties broken left→right.
  lines.sort((a, b) => (a.yc - b.yc) || (a.xc - b.xc));
  return lines;
}

/** Split lines into paragraphs where vertical gaps are much larger than line pitch. */
export function groupParagraphs(lines) {
  if (!lines.length) return [];
  lines.sort((a, b) => a.yc - b.yc);
  const pitches = [];
  for (let i = 1; i < lines.length; i++) pitches.push(lines[i].yc - lines[i - 1].yc);
  pitches.sort((a, b) => a - b);
  const pitch = pitches[Math.floor(pitches.length / 2)] || 20;
  const paras = [];
  let cur = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].yc - lines[i - 1].y1 > Math.max(pitch * 1.9, pitch + 8)) {
      paras.push(cur);
      cur = [];
    }
    cur.push(lines[i]);
  }
  paras.push(cur);
  return paras;
}

export function linesToText(lines, { paragraphBreaks = true } = {}) {
  if (paragraphBreaks) {
    return groupParagraphs(lines)
      .map((p) => p.map((l) => l.words.map((w) => w.text).join(' ')).join('\n'))
      .join('\n\n');
  }
  return lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n');
}
