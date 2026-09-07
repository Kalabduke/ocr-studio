# 👁️ OCR Studio

The most accurate **fully in-browser** OCR site you can run for free:

- **🖨️ Printed** — photos & scans of typed documents, receipts, letters (Tesseract LSTM, ~100 languages)
- **💻 Screenshot** — dashboards, apps, code, UI text (optimized preprocessing + sharpening)
- **📊 Table** — invoices/spreadsheets → clean rows & columns (CSV / Markdown / HTML grid with per-cell confidence)
- **✍️ Handwriting** — TrOCR AI model running on ONNX WebAssembly (best-in-class open handwriting model that runs client-side)

**Privacy:** 100% of OCR runs inside your browser tab. Images, PDFs and results never leave your device — no upload, no account, no API keys.

**Accuracy stack used:**
| Step | Tool |
|---|---|
| Image prep | EXIF-aware load, grayscale luminance, percentile contrast stretch, upscaling of small images, optional Otsu binarization, unsharp mask for screenshots |
| Printed / tables | Tesseract.js v6 (LSTM) — `tessdata` language packs cached in your browser |
| Handwriting | Tesseract for line-finding geometry + TrOCR (`Xenova/trocr-base-handwritten`, quantized ONNX) for recognition per line |
| PDFs | PDF.js renders every page at high scale, then the same pipeline |
| Tables | Word-box (TSV) geometry → vertical-gutter column detection → cell grid |

## Run it

No build step — plain static files. Serve the folder over HTTP (needed for ES modules + workers), e.g.:

```bash
cd ~/Desktop/ocr-website
python3 -m http.server 8131
# → http://localhost:8131
```

Engines download from a CDN **on first use** and are then cached by your browser (IndexedDB/Cache), so the second run works offline-ish for already-loaded languages/models.

## Files

```
ocr-website/
├── index.html            # UI
├── src/
│   ├── main.js           # app logic, modes, PDF loop, history
│   ├── style.css
│   ├── preprocess.js     # load/enhance/rotate/crop helpers
│   ├── tsv.js            # Tesseract TSV → word/line objects
│   ├── tsv_extra.js      # word→visual-line clustering (handwriting)
│   ├── table.js          # grid reconstruction → CSV/Markdown/HTML
│   └── engines/
│       ├── tesseract.js  # worker manager (language switching)
│       └── trocr.js      # TrOCR via transformers.js ONNX
```

## Notes & limits (honest)

- **Handwriting** is English-first (TrOCR training data). First run downloads ~180 MB (quantized); pick the *small* model in options for ~60 MB.
- If no text is found, bump *Image enhancement* to **Strong** for scans, rotate manually when the page is 90° off, and prefer bright, flat, close photos for handwriting.
- Everything is client-side, so very large PDFs (>~30 pages) can take a while — page progress is shown.

## Console / automation hook

`window.__ocrStudio.runCanvas(canvas, {mode, lang})` runs the full pipeline on any canvas and returns `{text, conf, table, ms}` — handy for testing or scripting.
