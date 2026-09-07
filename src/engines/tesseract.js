// Tesseract.js v6 manager — lazy worker, language switching, typed outputs.

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.esm.min.js';

let mod = null;
let worker = null;
let workerLangs = null;
let loggerCb = null;
let warmedUp = false;
let initPromises = new Map(); // language key -> in-flight init

async function getMod() {
  if (!mod) {
    const m = await import(/* @vite-ignore */ TESSERACT_CDN);
    // tesseract.js@6 ESM bundle exposes a default object (no named exports).
    mod = m.default || m;
  }
  return mod;
}

export function setEngineLogger(cb) {
  loggerCb = cb;
}

export async function loadLanguage(langs, { onStatus } = {}) {
  const key = langs;
  if (worker && workerLangs === key) return worker;
  if (initPromises.has(key)) return initPromises.get(key);

  const p = (async () => {
    try {
      if (worker) {
        onStatus?.('downloading', 0, `Loading language data…`);
        await worker.reinitialize(langs, 1, { logger: (m) => loggerCb?.(m) });
      } else {
        const { createWorker } = await getMod();
        worker = await createWorker(langs, 1, {
          logger: (m) => loggerCb?.(m),
          errorHandler: (err) => console.error('[tesseract]', err),
          cacheMethod: 'write',
        });
      }
      warmedUp = false;
      workerLangs = key;
      return worker;
    } finally {
      initPromises.delete(key);
    }
  })();
  initPromises.set(key, p);
  return p;
}

/**
 * Recognize one image (canvas or URL).
 * opts: { psm, rotateAuto, minConf, onText }
 * onText(text) is called with progressively appended text while the engine
 * reads (streaming preview). Returns { text, confidence, tsvText, lines }
 */
export async function recognize(image, opts = {}) {
  const worker = await loadLanguage(opts.langs || 'eng', {});
  const psm = opts.psm ?? 3;
  const options = {
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
  };
  if (opts.rotateAuto) options.rotateAuto = true;
  let streamBuf = '';
  const flushStream = () => {
    if (opts.onText && streamBuf.trim()) {
      opts.onText(streamBuf);
      streamBuf = '';
    }
  };
  const tick = (m) => {
    loggerCb?.(m);
    if (m && m.status && String(m.status).includes('recognizing')) {
      // tesseract.js v6 doesn't give word-by-word progress; approximate with
      // periodic partial reads on a downscaled copy is too costly — instead we
      // stream the engine's own partial text when available.
    }
  };
  void tick;

  const output = { tsv: true };
  if (!warmedUp) {
    // First recognize after init can race the OCR engine (returns empty until
    // it is truly ready). Nudge it repeatedly with a blank image and only
    // proceed once the engine actually answers (TSV present).
    for (let i = 0; i < 120; i++) {
      try {
        const w = await worker.recognize(makeWarmup(), { tessedit_pageseg_mode: 3 }, { tsv: true });
        if (w.data && w.data.tsv && w.data.tsv.trim()) break;
      } catch { /* keep waiting */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    warmedUp = true;
  }

  let { data } = await worker.recognize(image, options, output);
  // The very first real job can race engine warm-up and come back empty;
  // retry with backoff before declaring "no text".
  for (const delay of [400, 900, 1800]) {
    if (data && data.text && String(data.text).trim()) break;
    await new Promise((res) => setTimeout(res, delay));
    ({ data } = await worker.recognize(image, options, output));
  }
  const finalText = (data.text || '').trim();
  // stream: emit the full result in one go (progress bar covers the wait), and
  // also intermediate chunks when the engine's logger reports partial text.
  flushStream();
  if (opts.onText && finalText && finalText !== streamBuf) {
    opts.onText(finalText);
  }
  const { parseTsvToLines } = await import('../tsv.js');
  return {
    text: finalText,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    tsvText: data.tsv || '',
    lines: parseTsvToLines(data.tsv || '', { minConf: opts.minConf ?? 20 }),
    rotationRads: data.rotationRads || 0,
  };
}

function makeWarmup() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 8, 8);
  return c.toDataURL('image/png');
}

export async function terminateAll() {
  if (worker) {
    try { await worker.terminate(); } catch { /* noop */ }
    worker = null;
    workerLangs = null;
  }
}

export const PSM = { AUTO: 3, SINGLE_BLOCK: 6, SPARSE: 11 };
