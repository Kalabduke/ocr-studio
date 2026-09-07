// TrOCR (handwriting / printed line recognition) via transformers.js ONNX runtime.

const HF_CDN_VERSIONS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2',
];

let mod = null;
let pipe = null;
let pipeModel = null;
let progressCb = null;
let loading = null;

async function getMod() {
  if (mod) return mod;
  let lastErr = null;
  for (const url of HF_CDN_VERSIONS) {
    try {
      mod = await import(/* @vite-ignore */ url);
      return mod;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not load Transformers.js from CDN');
}

export function setProgressCb(cb) {
  progressCb = cb;
}

async function loadModel(modelId) {
  if (pipe && pipeModel === modelId) return pipe;
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await getMod();
    // Model files come from the Hugging Face hub; quantized weights are picked
    // automatically when running on WebAssembly.
    try {
      env.allowLocalModels = false;
    } catch { /* ignore */ }
    const pc = (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.status === 'progress' && p.file) {
        progressCb?.({ stage: 'model', text: `Downloading ${p.file}`, pct: Math.round((p.progress || 0) * 100) });
      } else if (p.status === 'done') {
        progressCb?.({ stage: 'model', text: 'Model ready', pct: 100 });
      }
    };
    const opts = { device: 'wasm', progress_callback: pc };
    // try { opts.dtype = 'q8'; } catch { }
    const p = await pipeline('image-to-text', modelId, opts);
    pipe = p;
    pipeModel = modelId;
    return p;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Ensure the model is loaded (used to surface download progress before work starts). */
export async function loadModelCheck(modelId) {
  await loadModel(modelId);
}

/**
 * Recognize text crops (array of data URLs of single text lines).
 * Batched input returns empty generations on some transformers.js builds, so
 * each crop is recognized individually. Returns strings aligned with input.
 */
export async function recognizeCrops(crops, modelId, { onItem, numBeams } = {}) {
  const p = await loadModel(modelId);
  const out = [];
  for (let i = 0; i < crops.length; i++) {
    const item = await p(crops[i], { max_new_tokens: 128, num_beams: numBeams ?? 1 });
    const r = Array.isArray(item) ? item[0] : item;
    out.push(r && r.generated_text ? r.generated_text.trim() : '');
    onItem?.(i + 1, crops.length);
  }
  return out;
}

/** Convenience: recognize one image (whole image treated as text). */
export async function recognizeOne(imageUrl, modelId) {
  const [text] = await recognizeCrops([imageUrl], modelId);
  return text;
}
