// Image helpers: load (EXIF-aware), enhance (grayscale/contrast/upscale/binarize), rotate, crop.

/**
 * Load an image File/Blob into a canvas, honoring EXIF orientation.
 */
export async function fileToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // createImageBitmap unavailable or decode failed — fall back to <img>.
    bmp = await loadViaImage(file);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  if (typeof bmp.close === 'function') bmp.close();
  return canvas;
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image format in your browser.')); };
    img.src = url;
  });
}

/** Canvas → blob URL of an image so engines/Tesseract can ingest it. */
export function canvasToUrl(canvas, type = 'image/png', quality = 0.92) {
  return canvas.toDataURL(type, quality);
}

/** Rotate a canvas by multiples of 90° clockwise. Returns a new canvas. */
export function rotateCanvas(src, turnsCw = 1) {
  const t = ((turnsCw % 4) + 4) % 4;
  if (t === 0) return src;
  const out = document.createElement('canvas');
  out.width = t % 2 ? src.height : src.width;
  out.height = t % 2 ? src.width : src.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((t * 90 * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/**
 * Enhance an image for OCR.
 *  - upscales small images (tiny photos/screenshots have way more OCR errors)
 *  - converts to grayscale luminance
 *  - percentile contrast stretch (removes haze/low contrast)
 *  - optional Otsu binarization ("strong" mode, for poor scans)
 *  - optional mild sharpen for screenshots
 * Returns a NEW canvas (input untouched) plus a log of what was applied.
 */
export function enhance(canvas, { mode = 'print', level = 'auto', stripLines = false } = {}) {
  let w = canvas.width, h = canvas.height;
  const log = [];

  // 1) Upscale: aim for a max dimension in a sweet spot for OCR.
  let factor = 1;
  const maxDim = Math.max(w, h);
  const target = mode === 'screen' ? 2200 : 2600;
  if (maxDim < 1100) factor = Math.min(3, Math.ceil(target / maxDim));
  if (factor > 1) {
    const c2 = document.createElement('canvas');
    c2.width = Math.round(w * factor);
    c2.height = Math.round(h * factor);
    const ctx = c2.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
    canvas = c2;
    w = c2.width; h = c2.height;
    log.push(`upscaled ${factor}×`);
  }

  if (level === 'none') return { canvas, log };

  // 2) Grayscale (luminance) into ImageData for pixel work.
  const gray = document.createElement('canvas');
  gray.width = w; gray.height = h;
  const gctx = gray.getContext('2d');
  gctx.drawImage(canvas, 0, 0);
  const img = gctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    lum[j] = v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }

  // Optionally strip long thin table rule lines before contrast/binarize so
  // text cells are not glued to box borders (a classic Tesseract weakness).
  let stripApplied = false;
  if (stripLines) {
    stripTableRules(lum, w, h);
    // sync stripped luminance back into the pixel buffer
    for (let j = 0; j < lum.length; j++) {
      const k = j * 4;
      d[k] = d[k + 1] = d[k + 2] = lum[j];
    }
    stripApplied = true;
  }

  if (level === 'otsu') {
    // Global Otsu threshold.
    const HIST = 256, hist = new Uint32Array(HIST);
    for (let j = 0; j < lum.length; j++) hist[lum[j] | 0]++;
    const total = lum.length;
    let sum = 0;
    for (let i = 0; i < HIST; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    for (let i = 0; i < HIST; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; thr = i; }
    }
    for (let j = 0; j < lum.length; j++) {
      const v = lum[j] <= thr ? 0 : 255;
      const k = j * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
    }
    log.push('binarized (Otsu)');
  } else {
    // 3) Percentile contrast stretch on luminance.
    const sorted = new Float32Array(lum);
    sorted.sort();
    const lo = sorted[Math.floor(sorted.length * 0.005)];
    const hi = sorted[Math.floor(sorted.length * 0.995)];
    const span = hi - lo;
    const scale = span < 1 ? 0 : 255 / span;
    for (let j = 0; j < lum.length; j++) {
      let v = lum[j];
      if (scale > 0) {
        v = (v - lo) * scale;
        if (v < 0) v = 0;
        else if (v > 255) v = 255;
      }
      const k = j * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
    }
    if (scale > 0) log.push('contrast stretched');

    // 4) Mild unsharp mask — helps crisp UI/screenshot glyphs.
    if (mode === 'screen') {
      const radius = 1, amt = 0.45;
      const blur = boxBlur(d, w, h, radius);
      for (let j = 0; j < lum.length; j++) {
        const v = d[j * 4] + amt * (d[j * 4] - blur[j * 4]);
        const k = j * 4;
        const cv = v < 0 ? 0 : v > 255 ? 255 : v;
        d[k] = d[k + 1] = d[k + 2] = cv;
      }
      log.push('sharpened');
    }
  }

  gctx.putImageData(img, 0, 0);
  if (stripApplied) log.push('removed table lines');
  return { canvas: gray, log };
}

/**
 * Erase long, thin, dark runs (table borders) from the luminance buffer.
 * A pixel belongs to a line only when the dark run is much longer than any
 * text stroke (so words are left intact). Both axes are scanned.
 */
function stripTableRules(lum, w, h) {
  const DARK = 130;
  const minH = Math.round(w * 0.3);
  const minV = Math.round(h * 0.3);
  const MAX_THICK = 6; // rule lines are thin; anything thicker is text
  const mask = new Uint8Array(w * h); // 1 = part of a rule line

  // --- horizontal runs ---
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (lum[y * w + x] > DARK) { x++; continue; }
      let x2 = x;
      while (x2 < w && lum[y * w + x2] <= DARK) x2++;
      if (x2 - x >= minH && isThinRow(y, x, x2, lum, w, h, MAX_THICK)) {
        for (let i = x; i < x2; i++) mask[y * w + i] = 1;
      }
      x = x2;
    }
  }
  // --- vertical runs ---
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (lum[y * w + x] > DARK) { y++; continue; }
      let y2 = y;
      while (y2 < h && lum[y2 * w + x] <= DARK) y2++;
      if (y2 - y >= minV && isThinCol(x, y, y2, lum, w, h, MAX_THICK)) {
        for (let i = y; i < y2; i++) mask[i * w + x] = 1;
      }
      y = y2;
    }
  }

  // Erase masked pixels + a small anti-aliasing fringe (still thin).
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let erased = mask[i];
      if (!erased) {
        for (let dy = -1; dy <= 1 && !erased; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) { erased = 1; break; }
          }
        }
      }
      out[i] = erased ? 255 : lum[i];
    }
  }
  lum.set(out);
}

// A long dark horizontal run is a table rule only if the rows just above and
// below it are mostly light (i.e. the run is a thin stroke, not a text band).
function isThinRow(y, x0, x1, lum, w, h, maxThick) {
  let thick = 1;
  const frac = (yy) => {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (lum[yy * w + x] <= 180) dark++;
    return dark / (x1 - x0);
  };
  for (let dy = 1; dy <= maxThick; dy++) {
    if (y + dy >= h) break;
    if (frac(y + dy) > 0.6) thick++; else break;
  }
  for (let dy = -1; dy >= -maxThick; dy--) {
    if (y + dy < 0) break;
    if (frac(y + dy) > 0.6) thick++; else break;
  }
  return thick <= maxThick;
}

function isThinCol(x, y0, y1, lum, w, h, maxThick) {
  let thick = 1;
  const frac = (xx) => {
    let dark = 0;
    for (let y = y0; y < y1; y++) if (lum[y * w + xx] <= 180) dark++;
    return dark / (y1 - y0);
  };
  for (let dx = 1; dx <= maxThick; dx++) {
    if (x + dx >= w) break;
    if (frac(x + dx) > 0.6) thick++; else break;
  }
  for (let dx = -1; dx >= -maxThick; dx--) {
    if (x + dx < 0) break;
    if (frac(x + dx) > 0.6) thick++; else break;
  }
  return thick <= maxThick;
}

// Simple 3×3 box blur used by the unsharp mask.
function boxBlur(src, w, h, r) {
  const out = new Uint8ClampedArray(src.length);
  const win = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rs = 0, gs = 0, bs = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const k = (yy * w + xx) * 4;
          rs += src[k]; gs += src[k + 1]; bs += src[k + 2];
        }
      }
      const k = (y * w + x) * 4;
      out[k] = rs / win; out[k + 1] = gs / win; out[k + 2] = bs / win; out[k + 3] = src[k + 3];
    }
  }
  return out;
}

/**
 * Crop a line region out of a source canvas, with horizontal padding and
 * upscaling so short handwriting lines reach a good height for TrOCR.
 * Returns a data URL (jpeg) ready to feed to the model.
 */
export function cropLineToUrl(src, box, { padFrac = 0.08, targetHeight = 96 } = {}) {
  const { x0, y0, x1, y1 } = box;
  let px = Math.max(4, Math.round((x1 - x0) * padFrac));
  const py = Math.max(4, Math.round((y1 - y0) * padFrac * 0.5));
  let l = Math.max(0, Math.round(x0 - px));
  let t = Math.max(0, Math.round(y0 - py));
  let r = Math.min(src.width, Math.round(x1 + px));
  let b = Math.min(src.height, Math.round(y1 + py));
  let cw = r - l, ch = b - t;
  if (cw < 8 || ch < 8) return null;

  let scale = 1;
  if (ch < targetHeight) scale = Math.min(3, targetHeight / ch);
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale);
  out.height = Math.round(ch * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, l, t, cw, ch, 0, 0, out.width, out.height);
  return canvasToUrl(out, 'image/jpeg', 0.9);
}

/**
 * Detect the dominant text orientation for a scan/photo and return the number
 * of clockwise 90° turns needed to right it (0, 1, 2 or 3).
 *
 * Heuristic (no ML): downscale to a small grayscale working buffer, then for
 * 0° and 90° compute the horizontal projection profile of dark pixels. Text
 * lines make the profile vary sharply row-to-row (low diff), while rotated
 * text smears across rows (high diff). The orientation with the crispest
 * profile wins. Confidence < 1.15 → image is ambiguous, return 0 (don't touch).
 */
export function detectAutoRotation(canvas) {
  const S = 320;
  const s = Math.min(1, S / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(w * h);
  let darkCount = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    lum[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) | 0;
    if (lum[j] < 128) darkCount++;
  }
  const fracDark = darkCount / (w * h);
  if (fracDark < 0.01 || fracDark > 0.8) return 0; // blank / photo-like

  const profileScore = (W, H, getLum) => {
    // horizontal projection: dark-pixel count per row
    const rows = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let cnt = 0;
      for (let x = 0; x < W; x++) if (getLum(x, y) < 128) cnt++;
      rows[y] = cnt;
    }
    // text lines → strong row-to-row change. Rotated text → smooth smear.
    let diff = 0, base = 0;
    for (let y = 1; y < H; y++) diff += Math.abs(rows[y] - rows[y - 1]);
    for (let y = 0; y < H; y++) base += rows[y];
    if (base < 1) return 0;
    // normalize: sharpness per unit of ink (higher = crisper line structure)
    return diff / Math.sqrt(base + 1);
  };

  const s0 = profileScore(w, h, (x, y) => lum[y * w + x]);
  const s90 = profileScore(h, w, (x, y) => lum[x * w + (h - 1 - y)]); // transpose (90°)
  const s180 = profileScore(w, h, (x, y) => lum[(h - 1 - y) * w + (w - 1 - x)]);
  const s270 = profileScore(h, w, (x, y) => lum[(w - 1 - x) * w + y]);

  const best = Math.max(s0, s90, s180, s270);
  const ratio = best / (s0 || 0.001);
  if (best === s0 || ratio < 1.12) return 0; // already upright or ambiguous
  if (best === s90) return 1;
  if (best === s270) return 3;
  return 2;
}

export function fmtDims(canvas) {
  return `${canvas.width} × ${canvas.height}px`;
}
