// OCR — main application logic.
import { fileToCanvas, enhance, rotateCanvas, cropLineToUrl, fmtDims, detectAutoRotation } from './preprocess.js';
import { parseTsvToLines, linesToText } from './tsv.js';
import { buildTable } from './table.js';
import * as tesseract from './engines/tesseract.js';
import * as trocr from './engines/trocr.js';

/* ---------------- tiny DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

/* ---------------- state ---------------- */
const state = {
  file: null,            // {kind:'image', canvas} | {kind:'pdf', file, numPages} | {kind:'batch', items:[...]}
  rotation: 0,
  mode: 'print',
  busy: false,
  result: null,          // last produced result object
  runSeq: 0,
};

/* ---------------- settings persistence ---------------- */
const SETTINGS_KEY = 'ocr_settings_v1';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: state.mode,
      lang: $('langSel').value,
      lang2: $('langSel2').value,
      enhance: $('enhanceSel').value,
      autoRotate: $('autoRotateChk').checked,
    }));
  } catch { /* quota */ }
}

const MODES = {
  print:  { label: 'Printed', icon: '🖨️', hint: 'Best for photos and scans of typed pages, receipts, letters, reports.', tesseract: true, psm: 3,  rotateAuto: true },
  screen: { label: 'Screenshot', icon: '💻', hint: 'Optimized for sharp UI text: dashboards, apps, code, browser pages.', tesseract: true, psm: 3,  rotateAuto: true, enhance: 'screen' },
  table:  { label: 'Table', icon: '📊', hint: 'Keeps rows and columns: invoices, spreadsheets, price lists.', tesseract: true, psm: 3,  rotateAuto: false },
  hand:   { label: 'Handwriting', icon: '✍️', hint: 'Uses the TrOCR AI model (downloads ~180 MB once, then cached). English text.', tesseract: true, psm: 11, rotateAuto: false },
};

const LANGS = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'],
  ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'], ['pol', 'Polish'],
  ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['tur', 'Turkish'], ['ara', 'Arabic'],
  ['heb', 'Hebrew'], ['hin', 'Hindi'], ['ind', 'Indonesian'], ['vie', 'Vietnamese'],
  ['tha', 'Thai'], ['chi_sim', 'Chinese (simplified)'], ['chi_tra', 'Chinese (traditional)'],
  ['jpn', 'Japanese'], ['kor', 'Korean'], ['ell', 'Greek'], ['ces', 'Czech'], ['hun', 'Hungarian'],
  ['ron', 'Romanian'], ['swe', 'Swedish'], ['dan', 'Danish'], ['nor', 'Norwegian'], ['fin', 'Finnish'],
  ['amh', 'Amharic'],
];

/* ---------------- engine progress -> UI ---------------- */
function setStage(text, pct = null) {
  $('stageTxt').textContent = text;
  $('stagePct').textContent = pct === null ? '' : `${pct}%`;
  $('barFill').style.width = pct === null ? '8%' : `${pct}%`;
}
function tessStatus(m) {
  const s = (m && m.status) || '';
  if (s.includes('core')) { setStage('Loading OCR engine…', 6); }
  else if (s.includes('initializing')) { setStage('Initializing…', 14); }
  else if (s.includes('traineddata')) { setStage('Loading language data (first use downloads it)…', 18 + Math.round((m.progress || 0) * 42)); }
  else if (s.includes('recognizing')) { setStage('Reading text…', 55 + Math.round((m.progress || 0) * 45)); }
  else if (s.includes('api')) { setStage('Warming up…', 60); }
}
tesseract.setEngineLogger(tessStatus);
trocr.setProgressCb((p) => setStage(p.text, p.pct == null ? null : Math.max(5, Math.min(95, p.pct * 0.9))));

/* ---------------- languages (dropdowns populated from LANGS) ---------------- */
(function fillLangs() {
  const opts = LANGS.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  const sel = $('langSel');
  if (sel && sel.options.length <= 1) sel.innerHTML = opts;
  const sel2 = $('langSel2');
  if (sel2) {
    const cur = sel2.value;
    sel2.innerHTML = `<option value="">None (single language)</option>` + opts;
    sel2.value = cur || '';
  }
})();

// restore saved settings (mode, languages, enhancement) on load
(function restoreSettings() {
  const s = loadSettings();
  if (!s || !s.mode) return;
  if (MODES[s.mode]) setMode(s.mode);
  if (s.lang) $('langSel').value = s.lang;
  if (s.lang2 !== undefined) $('langSel2').value = s.lang2 || '';
  if (s.enhance) $('enhanceSel').value = s.enhance;
  if (s.autoRotate !== undefined) $('autoRotateChk').checked = !!s.autoRotate;
})();

/* ---------------- preview ---------------- */
function drawPreview(canvas) {
  const c = $('previewCanvas');
  const max = 520;
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
}

function showSourceMeta(name, dimsTxt) {
  $('fileName').textContent = name;
  $('fileDims').textContent = dimsTxt;
  show($('sourceView'));
}

/* ---------------- file loading ---------------- */
const MAX_FILE_MB = 20;
async function loadFile(file) {
  await loadFiles([file]);
}

/** Load one or many files. Multiple images → batch mode (read in sequence). */
async function loadFiles(files) {
  hide($('banner'));
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return;
  const big = list.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
  if (big) {
    showBanner(`"${big.name}" is ${(big.size / (1024 * 1024)).toFixed(1)} MB — the limit is ${MAX_FILE_MB} MB. Please resize or use a smaller file.`);
    return;
  }
  const pdfs = list.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = list.filter((f) => !(f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
  if (pdfs.length) { await loadPdf(pdfs[0]); return; }
  if (images.length === 1) {
    const canvas = await fileToCanvas(images[0]);
    state.file = { kind: 'image', canvas, name: images[0].name || 'image' };
    drawPreview(canvas);
    showSourceMeta(images[0].name, fmtDims(canvas));
    hide($('pdfInfo'));
    hide($('batchInfo'));
  } else {
    const items = [];
    for (const f of images) {
      const canvas = await fileToCanvas(f);
      items.push({ canvas, name: f.name || 'image' });
    }
    state.file = { kind: 'batch', items, name: `${items.length} images` };
    drawPreview(items[0].canvas);
    showSourceMeta(`${items.length} images`, `first: ${fmtDims(items[0].canvas)}`);
    hide($('pdfInfo'));
    show($('batchInfo'));
    $('batchInfo').textContent = `📁 Batch — ${items.length} images will be read one after another and combined into one result.`;
  }
  state.rotation = 0;
  enableRun();
}

async function loadPdf(file) {
  const { pdfjs } = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 1400 / Math.max(vp.width, vp.height));
  const cv = await renderPdfPage(page, scale);
  state.file = { kind: 'pdf', file, numPages: doc.numPages, name: file.name };
  drawPreview(cv);
  showSourceMeta(file.name, `${doc.numPages} page${doc.numPages > 1 ? 's' : ''} · PDF`);
  show($('pdfInfo'));
  $('pdfInfo').textContent = doc.numPages > 1
    ? `📄 ${doc.numPages}-page PDF — every page will be read.`
    : '📄 Single-page PDF.';
  hide($('batchInfo'));
  doc.destroy();
}

async function loadPdfJs() {
  const base = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  const pdfjs = await import(/* @vite-ignore */ base);
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  return { pdfjs };
}

async function renderPdfPage(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

/* ---------------- preview controls ---------------- */
function rotateCur(deltaTurns) {
  if (!state.file || state.file.kind !== 'image') return;
  state.file.canvas = rotateCanvas(state.file.canvas, deltaTurns);
  state.rotation = ((state.rotation + deltaTurns) % 4 + 4) % 4;
  drawPreview(state.file.canvas);
}
function clearSource() {
  state.file = null;
  hide($('sourceView'));
  hide($('pdfInfo'));
  disableRun();
  show($('emptyState'));
  hide($('outViews'));
  hide($('stats'));
  hide($('actions'));
  hide($('progressWrap'));
  hide($('banner'));
  hide($('baWrap'));
  hide($('batchInfo'));
  $('btnDlZip').classList.add('hidden');
  state.lastBatchResults = null;
}

/* ---------------- buttons enable/disable ---------------- */
const runBtn = $('btnRun');
function disableRun() { runBtn.disabled = true; runBtn.classList.remove('running'); runBtn.querySelector('.run-icon').textContent = '🔍'; }
function enableRun() { if (!state.file) return; runBtn.disabled = false; }

/* ---------------- mode switching ---------------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('modeHint').textContent = MODES[mode].hint;
  $('langRow').classList.toggle('hidden', mode === 'hand');
  $('handModelRow').classList.toggle('hidden', mode !== 'hand');
  if (mode === 'hand') $('enhanceSel').value = 'auto';
  // don't auto-rerun; user presses Read
}
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
setMode('print'); // apply initial visibility rules

/* ---------------- run orchestration ---------------- */
async function run() {
  if (!state.file || state.busy) return;
  state.busy = true;
  const seq = ++state.runSeq;
  runBtn.disabled = true;
  runBtn.classList.add('running');
  runBtn.querySelector('.run-icon').textContent = '⏳';
  hide($('banner'));
  hide($('emptyState'));
  hide($('outViews'));
  hide($('actions'));
  show($('progressWrap'));

  const t0 = performance.now();
  const mode = state.mode;
  const lang = getLangs();
  const modelId = $('handModelSel').value;
  const enhanceLevel = mode === 'hand' ? 'auto' : $('enhanceSel').value;
  saveSettings();
  $('liveText').textContent = '';
  hide($('liveText'));
  hide($('baWrap'));
  let streamed = false;
  const onText = (t) => {
    const lt = $('liveText');
    if (!lt) return;
    if (!streamed) { lt.textContent = ''; show(lt); streamed = true; }
    const cur = lt.textContent || '';
    const chunk = (t || '').trim();
    if (!chunk) return;
    if (cur && chunk.startsWith(cur.slice(0, 60))) lt.textContent = chunk;      // engine re-emitted the same stream → replace
    else if (cur && cur.includes(chunk)) return;                                // duplicate chunk → skip
    else lt.textContent = (cur ? cur + '\n' : '') + chunk;                      // new chunk → append
    lt.textContent = lt.textContent.slice(-12000);
    lt.scrollTop = lt.scrollHeight;
  };

  try {
    let results = [];
    if (state.file.kind === 'image') {
      results = [await runSingle(state.file.canvas, mode, { lang, modelId, enhanceLevel, pageLabel: null, onText })];
    } else if (state.file.kind === 'batch') {
      for (let i = 0; i < state.file.items.length; i++) {
        if (seq !== state.runSeq) return;
        const item = state.file.items[i];
        setStage(`Reading ${item.name} (${i + 1}/${state.file.items.length})…`, Math.round((i / state.file.items.length) * 20));
        const r = await runSingle(item.canvas, mode, { lang, modelId, enhanceLevel, pageLabel: i + 1, pageTotal: state.file.items.length, pageName: item.name, onText });
        results.push(r);
      }
    } else {
      // PDF: iterate pages
      const { pdfjs } = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: await state.file.file.arrayBuffer() }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        if (seq !== state.runSeq) return;
        setStage(`Rendering page ${p}/${doc.numPages}…`, Math.round(((p - 1) / doc.numPages) * 20));
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const scale = Math.min(3, 2200 / Math.max(vp.width, vp.height));
        const cv = await renderPdfPage(page, scale);
        const r = await runSingle(cv, mode, { lang, modelId, enhanceLevel, pageLabel: p, pageTotal: doc.numPages, onText });
        results.push(r);
        page.cleanup();
      }
      doc.destroy();
    }
    if (seq !== state.runSeq) return;

    const ba = window.__lastEnhanced;
    if (ba && ba.after) {
      $('baBefore').src = ba.before.toDataURL('image/jpeg', 0.85);
      $('baAfter').src = ba.after.toDataURL('image/jpeg', 0.85);
      show($('baWrap'));
    }
    if (state.file.kind === 'batch') {
      state.lastBatchResults = results;
      $('btnDlZip').classList.remove('hidden');
    } else {
      $('btnDlZip').classList.add('hidden');
    }

    const merged = mergeResults(results, mode);
    state.result = merged;
    renderResult(merged, mode, lang, modelId, performance.now() - t0);
    addHistory(merged, mode, lang, modelId);
  } catch (err) {
    console.error(err);
    showBanner(`❌ ${err && err.message ? err.message : err}`);
  } finally {
    if (seq === state.runSeq) {
      state.busy = false;
      disableRun();
      hide($('progressWrap'));
    }
  }
}

function getLangs() {
  const a = ($('langSel').value || 'eng').trim();
  const b = ($('langSel2').value || '').trim();
  if (!a) return 'eng';
  return b && b !== a ? `${a}+${b}` : a;
}

/** OCR one image (canvas) for a mode. Returns per-page result. */
async function runSingle(canvas, mode, { lang, modelId, enhanceLevel, pageLabel, pageTotal, pageName, onText } = {}) {
  const spec = MODES[mode];
  const t0 = performance.now();
  const total = pageTotal || 1;
  const label = pageName || (pageLabel ? `page ${pageLabel}/${total}` : 'image');

  if (spec.tesseract) {
    // auto-rotate: only when the user hasn't rotated manually and the checkbox is on
    let src = canvas;
    let rotatedTurns = 0;
    const wantAuto = $('autoRotateChk') ? $('autoRotateChk').checked : true;
    if (wantAuto && state.rotation === 0) {
      setStage(`Checking orientation of ${label}…`, 7);
      rotatedTurns = detectAutoRotation(canvas);
      if (rotatedTurns) {
        src = rotateCanvas(canvas, rotatedTurns);
      }
    }

    setStage(pageLabel ? `Preparing ${label}…` : 'Preparing image…', 8);
    const { canvas: enh, log } = enhance(src, { mode: spec.enhance || 'print', level: enhanceLevel, stripLines: mode === 'table' });
    if (rotatedTurns) log.unshift(`auto-rotated ${rotatedTurns * 90}°`);
    const imgUrl = enh.toDataURL('image/jpeg', 0.9);
    window.__lastEnhanced = { before: src, after: enh };

    setStage(pageLabel ? `Page ${pageLabel}/${total}: loading language…` : 'Loading language…', 10);
    await tesseract.loadLanguage(lang, {});

    if (mode === 'hand') {
      return await runHandwriting(enh, imgUrl, modelId, pageLabel, total, t0, log);
    }

    const r = await tesseract.recognize(imgUrl, {
      langs: lang, psm: spec.psm, rotateAuto: false, minConf: mode === 'table' ? 8 : 5,
      onText,
    });
    let table = null;
    if (mode === 'table') {
      table = buildTable(r.lines);
      if (!table) table = { grid: [], csv: '', markdown: r.text, html: '<p>No clear table found — raw text below.</p>' };
    }
    return {
      text: mode === 'table' && table ? (table.markdown || r.text) : r.text,
      conf: r.confidence,
      tsv: r.tsvText,
      table,
      engine: 'Tesseract LSTM',
      enhanceLog: log,
      ms: performance.now() - t0,
      pageLabel,
      pageName,
      rotatedTurns,
    };
  }

  // No-tesseract fallback (unused today — TrOCR handles its own detection path above).
  throw new Error('Unknown mode');
}

/** Handwriting: detect lines with Tesseract geometry, recognize each with TrOCR. */
async function runHandwriting(enh, imgUrl, modelId, pageLabel, total, t0, log) {
  setStage(pageLabel ? `Page ${pageLabel}/${total}: finding lines…` : 'Finding text lines…', 12);
  const r = await tesseract.recognize(imgUrl, { langs: 'eng', psm: 11, rotateAuto: false, minConf: -10 });
  const { clusterIntoLines, groupParagraphs } = await import('./tsv_extra.js');
  const allWords = [];
  for (const ln of r.lines) for (const w of ln.words) allWords.push(w);
  const visualLines = clusterIntoLines(allWords);
  if (!visualLines.length) {
    throw new Error('Could not find any text lines in this image. Try better lighting / a closer crop.');
  }

  const paras = groupParagraphs(visualLines);
  setStage(pageLabel ? `Page ${pageLabel}/${total}: loading handwriting AI…` : 'Loading handwriting AI (first run downloads ~180 MB)…', 20);
  await trocr.loadModelCheck(modelId);

  // Per-line quality estimate from the geometry pass (avg word confidence).
  // TrOCR itself gives no confidence, so weak-looking lines get re-read once
  // with a slower, more accurate beam search and the better result is kept.
  const flatLines = [];
  for (const para of paras) for (const ln of para) flatLines.push(ln);
  const jobs = []; // parallel to flatLines: {url, conf} | null when crop skipped
  for (const ln of flatLines) {
    const url = cropLineToUrl(enh, { x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1 });
    if (!url) { jobs.push(null); continue; }
    const ws = (ln.words || []).filter((w) => typeof w.conf === 'number');
    const conf = ws.length ? ws.reduce((a, w) => a + w.conf, 0) / ws.length : null;
    jobs.push({ url, conf });
  }
  const texts = new Array(jobs.length).fill('');
  const WEAK_CONF = 45;
  let weakLines = 0;
  const realJobs = jobs.map((j, i) => (j ? i : -1)).filter((i) => i >= 0);
  for (const i of realJobs) {
    let [out] = await trocr.recognizeCrops([jobs[i].url], modelId);
    const weak = jobs[i].conf !== null && jobs[i].conf < WEAK_CONF && (out || '').trim().length >= 2;
    if (weak) {
      const [better] = await trocr.recognizeCrops([jobs[i].url], modelId, { numBeams: 4 });
      if (better && better.trim()) { out = better; weakLines++; }
    }
    texts[i] = (out || '').trim();
    setStage(pageLabel ? `Page ${pageLabel}/${total}: reading handwriting ${i + 1}/${jobs.length}…` : `Reading handwriting ${i + 1}/${jobs.length}…`,
      25 + Math.round(((i + 1) / Math.max(1, jobs.length)) * 70));
  }

  // Reassemble respecting paragraph grouping (index-aligned with jobs).
  let idx = 0;
  const paraTexts = [];
  for (const para of paras) {
    const ls = [];
    for (const ln of para) {
      ls.push(jobs[idx] ? texts[idx] : '');
      idx++;
    }
    paraTexts.push(ls.join('\n'));
  }
  const text = paraTexts.join('\n\n').replace(/ +/g, ' ').trim();

  return {
    text,
    conf: null,
    tsv: r.tsvText,
    table: null,
    engine: `TrOCR · ${modelId.replace('Xenova/', '').replace('trocr-', '')}`,
    enhanceLog: log,
    ms: performance.now() - t0,
    pageLabel,
    linesRecognized: jobs.length,
    weakLines,
  };
}

/* ---------------- merge multi-page results ---------------- */
function mergeResults(results, mode) {
  if (results.length === 1) {
    const r = results[0];
    return { text: r.text, conf: r.conf, tsv: r.tsv || '', table: r.table, engine: r.engine, enhanceLog: r.enhanceLog, ms: r.ms, linesRecognized: r.linesRecognized, weakLines: r.weakLines || 0 };
  }
  const parts = results.map((r) => (r.pageLabel ? `───── Page ${r.pageLabel} ─────\n${r.text}` : r.text));
  let table = null;
  if (mode === 'table') {
    const grids = results.map((r, i) => (r.table && r.table.grid.length ? `───── Page ${i + 1} ─────\n${r.table.markdown}` : '')).filter(Boolean);
    table = { csv: results.map((r, i) => (r.table && r.table.grid.length ? `"=PAGE ${i + 1}=` : '') + (r.table ? r.table.csv : '')).join('\n'), markdown: grids.join('\n\n'), grid: [] };
  }
  const confs = results.filter((r) => r.conf !== null).map((r) => r.conf);
  return {
    text: parts.join('\n\n'),
    conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    tsv: results.map((r, i) => (results.length > 1 ? `===== Page ${i + 1} =====\n` : '') + (r.tsv || '')).join(''),
    table,
    engine: results[0].engine,
    ms: results.reduce((a, r) => a + r.ms, 0),
    linesRecognized: results.reduce((a, r) => a + (r.linesRecognized || 0), 0),
    weakLines: results.reduce((a, r) => a + (r.weakLines || 0), 0),
  };
}

/* ---------------- render result into UI ---------------- */
function renderResult(res, mode, lang, modelId, wallMs) {
  const textEl = $('outText');
  textEl.textContent = res.text || '(no text found — try another mode or a clearer image)';

  $('outTsv').value = res.tsv || '(no word data — TSV only available for Tesseract reads)';

  // view tabs
  const csvTab = $('btnCopyCsv'), dlCsv = $('btnDlCsv');
  document.querySelectorAll('.vtab').forEach((b) => b.classList.remove('active'));
  const hasTable = mode === 'table' && res.table && res.table.grid && res.table.grid.length > 0;
  const tableTab = document.querySelector('.vtab[data-view="table"]');
  tableTab.classList.toggle('hidden', !hasTable);

  // stats
  const wc = res.text.trim().split(/\s+/).filter(Boolean).length;
  const words = `${wc} word${wc === 1 ? '' : 's'}`;
  const secs = (wallMs / 1000).toFixed(1);
  $('statEngine').innerHTML = `<b>${escapeHtml(res.engine)}</b>${mode === 'hand' ? '' : ` · <b>${escapeHtml(lang)}</b>`}`;
  const weak = res.weakLines || 0;
  $('statConf').innerHTML = res.conf !== null
    ? `Confidence <b>${res.conf.toFixed(0)}%</b>`
    : `Confidence <b>—</b> (AI model)${weak ? ` · <b>${weak}</b> weak line${weak === 1 ? '' : 's'} re-read` : ''}`;
  $('statTime').textContent = `${secs}s`;
  $('statWords').textContent = words;
  $('statConf').style.display = (res.conf !== null || weak) ? '' : 'none';

  // wire CSV affordances
  csvTab.classList.toggle('hidden', !hasTable);
  dlCsv.classList.toggle('hidden', !hasTable);
  const tableWrap = $('outTableWrap');
  if (hasTable) {
    tableWrap.innerHTML = res.table.html;
    show(tableWrap);
    selectView('table');
  } else {
    selectView('text');
    hide($('viewTable'));
  }

  show($('outViews'));
  show($('stats'));
  show($('actions'));
  hide($('emptyState'));
}

function selectView(v) {
  document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('viewText').classList.toggle('hidden', v !== 'text');
  $('viewTable').classList.toggle('hidden', v !== 'table');
  $('viewTsv').classList.toggle('hidden', v !== 'tsv');
}
document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => selectView(b.dataset.view)));

function showBanner(msg) {
  const b = $('banner');
  b.textContent = msg;
  show(b);
  show($('emptyState'));
}

/* ---------------- copy / download ---------------- */
function currentText() { return ($('outText').textContent || '').trimEnd(); }
function currentCsv() { return (state.result && state.result.table && state.result.table.csv) || ''; }

$('btnCopyTxt').addEventListener('click', async () => {
  const t = currentText();
  if (!t) return;
  try { await navigator.clipboard.writeText(t); flashBtn($('btnCopyTxt'), '✅ Copied'); }
  catch { fallbackCopy(t); }
});
$('btnCopyCsv').addEventListener('click', async () => {
  const t = currentCsv();
  if (!t) return;
  try { await navigator.clipboard.writeText(t); flashBtn($('btnCopyCsv'), '✅ Copied'); }
  catch { fallbackCopy(t); }
});
$('btnDlTxt').addEventListener('click', () => downloadBlob('ocr-text.txt', currentText(), 'text/plain'));
$('btnDlCsv').addEventListener('click', () => downloadBlob('ocr-table.csv', currentCsv(), 'text/csv'));

function flashBtn(btn, txt) { const old = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = old; }, 1400); }
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); flashBtn(document.activeElement, '✅ Copied'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}
function downloadBlob(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- batch zip download (tiny stored-zip writer, no libs) ---------------- */
$('btnDlZip').addEventListener('click', () => {
  const res = state.lastBatchResults;
  if (!res || !res.length) return;
  const files = res.map((r, i) => {
    const src = (state.file && state.file.items && state.file.items[i] && state.file.items[i].name) || `page-${i + 1}`;
    const base = src.replace(/\.[^.]+$/, '') || `page-${i + 1}`;
    return { name: `${base}.txt`, text: r.text || '' };
  });
  downloadBlob('ocr-batch.zip', makeZip(files), 'application/zip');
});

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = enc.encode(f.text || '');
    const crc = crc32(data);
    const nameBytes = enc.encode(f.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); // stored (no compression)
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  parts.push(...central, eocd.buffer);
  return new Blob(parts, { type: 'application/zip' });
}

/* ---------------- history ---------------- */
const HISTORY_KEY = 'ocrstudio_history_v1';
function addHistory(res, mode, lang, modelId) {
  let h = readHistory();
  const name = state.file ? state.file.name || 'untitled' : 'canvas';
  h.unshift({
    ts: Date.now(),
    name,
    mode,
    lang,
    engine: res.engine,
    text: res.text.slice(0, 60000),
    csv: res.table && res.table.csv ? res.table.csv.slice(0, 60000) : null,
    conf: res.conf,
    words: res.text.trim().split(/\s+/).filter(Boolean).length,
    secs: Math.round((res.ms || 0) / 10) / 100,
  });
  h = h.slice(0, 12);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* quota */ }
  renderHistory();
}
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function renderHistory() {
  const list = $('historyList');
  const items = readHistory();
  if (!items.length) {
    list.innerHTML = '<li class="history-empty">Nothing yet — your runs will appear here (kept only on this device).</li>';
    hide($('btnClearHist'));
    return;
  }
  show($('btnClearHist'));
  list.innerHTML = '';
  const icons = { print: '🖨️', screen: '💻', table: '📊', hand: '✍️' };
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const d = new Date(it.ts);
    const when = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    li.innerHTML = `
      <span class="h-ic">${icons[it.mode] || '📄'}</span>
      <span class="h-body">
        <div class="h-name">${escapeHtml(it.name)}</div>
        <div class="h-meta">${it.words} words · ${it.engine} · ${when}</div>
      </span>
      <button type="button" class="h-del" title="Delete">🗑</button>`;
    li.querySelector('.h-name').closest('li').addEventListener('click', (e) => {
      if (e.target.closest('.h-del')) return;
      restoreHistory(i);
    });
    li.querySelector('.h-del').addEventListener('click', (e) => {
      e.stopPropagation();
      const h = readHistory(); h.splice(i, 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* */ }
      renderHistory();
    });
    list.appendChild(li);
  });
}
function restoreHistory(i) {
  const it = readHistory()[i];
  if (!it) return;
  state.result = { text: it.text, table: it.csv ? { csv: it.csv, grid: [], markdown: '', html: '' } : null, conf: it.conf, engine: it.engine, ms: 0 };
  $('outText').textContent = it.text || '';
  $('outTsv').value = '';
  const hasTable = !!it.csv;
  document.querySelector('.vtab[data-view="table"]').classList.toggle('hidden', !hasTable);
  $('btnCopyCsv').classList.toggle('hidden', !hasTable);
  $('btnDlCsv').classList.toggle('hidden', !hasTable);
  if (hasTable) { $('outTableWrap').innerHTML = '<p class="langnote">Table CSV restored from history.</p>'; }
  hide($('emptyState'));
  show($('outViews'));
  show($('stats'));
  show($('actions'));
  $('statEngine').textContent = it.engine;
  $('statConf').innerHTML = it.conf !== null ? `Confidence <b>${it.conf.toFixed(0)}%</b>` : 'Confidence <b>—</b>';
  $('statWords').textContent = `${it.words} words`;
  $('statTime').textContent = `${it.secs}s`;
  selectView('text');
}
$('btnClearHist').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });
renderHistory();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------------- input wiring ---------------- */
const drop = $('drop');
const fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { if (fileInput.files.length) loadFiles(fileInput.files); fileInput.value = ''; });
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
drop.addEventListener('drop', (e) => {
  const fs = e.dataTransfer && e.dataTransfer.files;
  if (fs && fs.length) loadFiles(fs);
});
$('btnPaste').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find((x) => x.startsWith('image/'));
      if (t) { const blob = await it.getType(t); const file = new File([blob], 'clipboard.png', { type: t }); await loadFile(file); return; }
    }
    showBanner('Clipboard has no image — copy a screenshot first (or paste with Ctrl+V).');
  } catch { showBanner('Clipboard access blocked. Paste with Ctrl+V instead.'); }
});
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      e.preventDefault();
      loadFile(it.getAsFile());
      return;
    }
  }
});
$('btnRotL').addEventListener('click', () => rotateCur(-1));
$('btnRotR').addEventListener('click', () => rotateCur(1));
$('btnClear').addEventListener('click', clearSource);
runBtn.addEventListener('click', run);
$('baSlider').addEventListener('input', () => {
  const box = document.querySelector('.ba-box');
  if (box) box.style.setProperty('--ba', `${$('baSlider').value}%`);
});

/* ============ E2E / console hooks (also used by automated tests) ============ */
window.__ocrStudio = {
  version: '1.0',
  async runCanvas(canvas, { mode = 'print', lang = 'eng', enhanceLevel = 'auto', psm, rotateAuto, minConf, stripLines, onStage, model } = {}) {
    const spec = MODES[mode];
    const t0 = performance.now();
    const doStrip = stripLines ?? (mode === 'table');
    const { canvas: enh } = enhance(canvas, { mode: spec.enhance || 'print', level: enhanceLevel, stripLines: doStrip });
    const url = enh.toDataURL('image/jpeg', 0.9);
    let dbgImg = null;
    if (onStage && onStage === true) {
      const id = enh.getContext('2d').getImageData(0, 0, Math.min(enh.width, 400), Math.min(enh.height, 400));
      const d = id.data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      dbgImg = { w: enh.width, h: enh.height, darkPx: dark, strip: doStrip };
    }
    if (spec.tesseract) {
      await tesseract.loadLanguage(lang, {});
      if (mode === 'hand') {
        const modelId = model || 'Xenova/trocr-base-handwritten';
        const r = await runHandwriting(enh, url, modelId, null, 1, t0, []);
        return { text: r.text, engine: r.engine, ms: performance.now() - t0, tsv: r.tsv, weakLines: r.weakLines || 0 };
      }
      const r = await tesseract.recognize(url, {
        langs: lang,
        psm: psm ?? spec.psm,
        rotateAuto: rotateAuto ?? spec.rotateAuto,
        minConf: minConf ?? 5,
      });
      let table = null;
      if (mode === 'table') {
        try { table = buildTable(r.lines); } catch (e) { console.error('[buildTable]', e); table = null; }
      }
      const dbg = { lines: r.lines.length, words: r.lines.reduce((a, l) => a + l.words.length, 0), conf: r.confidence };
      return { text: mode === 'table' && table ? table.markdown : r.text, conf: r.confidence, engine: 'tesseract', ms: performance.now() - t0, tsv: r.tsvText, table, dbg, dbgImg };
    }
    return null;
  },
  loadFile,
  state,
  get langs() { return LANGS; },
};
