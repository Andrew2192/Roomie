// src/lib/depth.js
// Roomie CV module — real in-browser monocular depth estimation.
//
// Uses @huggingface/transformers (ONNX Runtime Web) to run
// onnx-community/depth-anything-v2-small entirely client-side.
//
// Public API:
//   estimateDepth(imageUrl, options?) -> Promise<DepthResult>
//   getDepthPipeline(options?)        -> Promise<DepthPipeline> (cached, advanced)
//   clearDepthCaches()                -> free memory (optional)
//   DepthEstimationError              -> typed error (has .code)
//
// There are NO mocked/simulated depth maps here — every call runs the real
// neural network. The model weights are downloaded once per browser and
// cached by Transformers.js (IndexedDB/Cache API), so later calls are fast.

import { pipeline, env, RawImage } from '@huggingface/transformers'

export const DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small'

// Sensible defaults for a horizon/hackathon MVP: WASM is the most compatible
// backend and q8 keeps the model download small (~26 MB vs ~99 MB fp32).
// WebGPU exists (pass device:'webgpu') but is opt-in only so compatibility is
// never compromised.
const DEFAULT_DEVICE = 'wasm'
const DEFAULT_DTYPE = 'q8'

// Cap the decode resolution for memory safety; depth is inferred at ~518px
// regardless, so this does not change perceptible quality of the cloud.
const MAX_DECODE_DIM = 2048

export class DepthEstimationError extends Error {
  /**
   * @param {string} message human-readable message (may be shown in UI)
   * @param {string} code one of: bad_input | load_failed | decode_failed | model_unavailable | inference_failed
   */
  constructor(message, code = 'inference_failed') {
    super(message)
    this.name = 'DepthEstimationError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Module-level caches: survive re-renders, remounts and React StrictMode.
// ---------------------------------------------------------------------------

/** @type {Map<string, {promise: import('@huggingface/transformers').DepthEstimationPipeline}>} */
const pipelineCache = new Map() // key: `${device}|${dtype}`
/** @type {Map<string, Promise<DepthResult>>} */
const inFlight = new Map() // key: url, dedupes concurrent identical estimates
/** @type {Map<string, DepthResult>} */
const resultCache = new Map() // key: url (successful results only)

export function clearDepthCaches() {
  pipelineCache.clear()
  inFlight.clear()
  resultCache.clear()
}

/** @typedef {{
 *   stage:'decoding'|'loading-model'|'inferring'|'done',
 *   percent?:number, // 0..100, only present for stage 'loading-model'
 * }} DepthStage
 */

/** @typedef {{
 *   width:number, height:number,
 *   rgba:Uint8ClampedArray,        // original image pixels, w*h*4
 *   depth:{ width:number, height:number, data:Float32Array }, // 0..1, 1 = nearest to camera
 *   meta:{ model:string, device:string, dtype:string, durationMs:number }
 * }} DepthResult
 */

function configureEnvOnce() {
  // Never look for models on the app's own origin (avoids noisy local 404s
  // and always fetches the real model from the HF Hub).
  try { env.allowLocalModels = false } catch { /* env shape varies by version */ }
}

// ---------------------------------------------------------------------------
// Model loading (cached singleton per device|dtype)
// ---------------------------------------------------------------------------

/**
 * Build an aggregated download-progress reporter. Transformers.js emits one
 * event per model file; we report overall bytes loaded / bytes total.
 */
function makeProgressReporter(onProgress, device, dtype) {
  if (typeof onProgress !== 'function') return undefined
  const files = new Map() // name -> { loaded, total, done }
  const emit = () => {
    let loaded = 0
    let total = 0
    let allInitiated = true
    for (const f of files.values()) {
      if (!f.done) allInitiated = false
      loaded += f.loaded || 0
      total += f.total || 0
    }
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined
    onProgress({ stage: 'loading-model', percent })
    if (allInitiated && percent === 100) onProgress({ stage: 'inferring' })
  }
  return (data) => {
    try {
      if (data?.file == null) return
      const key = String(data.file)
      const entry = files.get(key) || { loaded: 0, total: 0, done: false }
      if (data.status === 'progress') {
        entry.loaded = data.loaded ?? entry.loaded
        entry.total = data.total ?? entry.total
      } else if (data.status === 'done') {
        entry.done = true
        entry.loaded = entry.total
      }
      files.set(key, entry)
      emit()
    } catch { /* progress reporting must never break the pipeline */ }
  }
}

/**
 * Get (and cache) the Depth Anything V2 small depth-estimation pipeline.
 * @param {{device?:'wasm'|'webgpu', dtype?:'q8'|'fp32'|'fp16', onProgress?:(s:DepthStage)=>void}=} opts
 */
export async function getDepthPipeline({ device = DEFAULT_DEVICE, dtype = DEFAULT_DTYPE, onProgress } = {}) {
  let resolvedDevice = device

  // Opt-in WebGPU with a hard safety net back to WASM.
  if (resolvedDevice === 'webgpu') {
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator
    if (!hasWebGPU) {
      console.warn('[roomie/depth] WebGPU not available, falling back to WASM')
      resolvedDevice = DEFAULT_DEVICE
    }
  }

  const key = `${resolvedDevice}|${dtype}`
  const cached = pipelineCache.get(key)
  if (cached) return cached.promise

  if (!inFlight.has('pipeline:' + key)) {
    configureEnvOnce()
    const loadPromise = pipeline(
      'depth-estimation',
      DEPTH_MODEL_ID,
      {
        device: resolvedDevice,
        dtype, // 'q8' by default: small download, reliable on WASM
        progress_callback: makeProgressReporter(onProgress, resolvedDevice, dtype),
      },
    ).catch((err) => {
      throw new DepthEstimationError(
        `Could not load the depth model (${err?.message ?? err}). Check your network connection — the model downloads from huggingface.co on first use.`,
        'model_unavailable',
      )
    })
    inFlight.set('pipeline:' + key, loadPromise)
    loadPromise.then((p) => pipelineCache.set(key, { promise: p }))
  }
  return inFlight.get('pipeline:' + key)
}

// ---------------------------------------------------------------------------
// Image loading / decoding (accepts http(s):, blob:, data: URLs)
// ---------------------------------------------------------------------------

async function decodeImage(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new DepthEstimationError(
      'estimateDepth expects an image URL string (http(s):, blob:, or data: URL).',
      'bad_input',
    )
  }

  let blob
  try {
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!resp.ok) {
      throw new DepthEstimationError(`Could not load image (${resp.status} ${resp.statusText || ''}).trim()`, 'load_failed')
    }
    blob = await resp.blob()
  } catch (err) {
    if (err instanceof DepthEstimationError) throw err
    throw new DepthEstimationError(
      `Could not load image from URL: ${err?.message ?? err}. Blob URLs produced by URL.createObjectURL() and CORS-enabled http(s) URLs are supported.`,
      'load_failed',
    )
  }

  if (blob.size === 0) {
    throw new DepthEstimationError('The image file is empty.', 'load_failed')
  }
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new DepthEstimationError(
      `Unsupported input: expected an image file (image/*) but received "${blob.type || 'unknown type'}".`,
      'decode_failed',
    )
  }

  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (err) {
    throw new DepthEstimationError(
      `Could not decode image (is it a valid, complete image file?): ${err?.message ?? err}`,
      'decode_failed',
    )
  }

  try {
    // Downscale huge photos for memory safety.
    let { width, height } = bitmap
    const largest = Math.max(width, height)
    if (largest > MAX_DECODE_DIM) {
      const scale = MAX_DECODE_DIM / largest
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new DepthEstimationError('Could not create a 2D canvas context for image decoding.', 'decode_failed')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const imageData = ctx.getImageData(0, 0, width, height)
    bitmap.close()
    return { width, height, rgba: imageData.data }
  } catch (err) {
    bitmap.close?.()
    if (err instanceof DepthEstimationError) throw err
    throw new DepthEstimationError(`Failed to read image pixels: ${err?.message ?? err}`, 'decode_failed')
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run full depth estimation for an image URL.
 *
 * @param {string} imageUrl http(s):, blob: (e.g. URL.createObjectURL(file)), or data: URL
 * @param {{device?:'wasm'|'webgpu', dtype?:'q8'|'fp32'|'fp16', onProgress?:(s:DepthStage)=>void}=} options
 * @returns {Promise<DepthResult>}
 */
export async function estimateDepth(imageUrl, options = {}) {
  const { device = DEFAULT_DEVICE, dtype = DEFAULT_DTYPE, onProgress } = options

  // Basic validation up front — cheap and gives the clearest errors.
  if (typeof imageUrl !== 'string' || imageUrl.trim() === '') {
    throw new DepthEstimationError(
      'estimateDepth expects an image URL string (http(s):, blob:, or data: URL).',
      'bad_input',
    )
  }

  // Same URL + same config → reuse the previous successful result. This makes
  // repeated renders/uploads free and is what keeps React StrictMode happy.
  const resultKey = `${imageUrl}|${device}|${dtype}`
  if (resultCache.has(resultKey)) return resultCache.get(resultKey)
  if (inFlight.has(resultKey)) return inFlight.get(resultKey)

  const exec = (async () => {
    const started = performance.now()
    onProgress?.({ stage: 'decoding' })
    const img = await decodeImage(imageUrl)

    onProgress?.({ stage: 'loading-model' })
    const pipe = await getDepthPipeline({ device, dtype, onProgress })

    onProgress?.({ stage: 'inferring' })
    let out
    let rawImage
    try {
      rawImage = new RawImage(img.rgba, img.width, img.height, 4)
      out = await pipe(rawImage)
    } catch (err) {
      // Include the root cause; ONNX/WASM failures surface here.
      throw new DepthEstimationError(
        `Depth inference failed: ${err?.message ?? err}`,
        'inference_failed',
      )
    }

    // Normalize depth to a Float32Array in [0, 1] where 1 = nearest.
    let dw, dh, data
    const depthImage = out?.depth // RawImage rendered at the input size, 0..255 grayscale
    if (depthImage && depthImage.data?.length) {
      dw = depthImage.width
      dh = depthImage.height
      data = new Float32Array(dw * dh)
      const src = depthImage.data
      for (let i = 0; i < data.length; i++) data[i] = src[i] / 255
    } else if (out?.predicted_depth) {
      // Fallback: normalize the raw relative-depth tensor ourselves.
      const t = out.predicted_depth
      const n = t.data?.length
      if (!n) throw new DepthEstimationError('Model returned no usable depth output.', 'inference_failed')
      dw = t.dims?.[t.dims.length - 1] ?? img.width
      dh = t.dims?.[t.dims.length - 2] ?? img.height
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < n; i++) {
        const v = t.data[i]
        if (v < min) min = v
        if (v > max) max = v
      }
      data = new Float32Array(n)
      const range = max - min || 1
      for (let i = 0; i < n; i++) data[i] = (t.data[i] - min) / range
      // Normalize tensor (H × W) back to the decoded image size so callers
      // always get a depth grid aligned to result.width/height.
      data = resampleToGrid(data, dw, dh, img.width, img.height)
      dw = img.width
      dh = img.height
    } else {
      throw new DepthEstimationError('Model returned no usable depth output.', 'inference_failed')
    }

    /** @type {DepthResult} */
    const result = {
      width: img.width,
      height: img.height,
      rgba: img.rgba,
      depth: {
        width: dw,
        height: dh,
        data, // Float32Array, 0..1, 1 = nearest
      },
      meta: {
        model: DEPTH_MODEL_ID,
        device: device,
        dtype,
        durationMs: Math.round(performance.now() - started),
      },
    }

    resultCache.set(resultKey, result)
    onProgress?.({ stage: 'done' })
    return result
  })()

  inFlight.set(resultKey, exec)
  try {
    return await exec
  } finally {
    inFlight.delete(resultKey)
  }
}

/** Nearest-neighbour resample of a flat W×H grid (for the tensor fallback path). */
function resampleToGrid(data, sw, sh, tw, th) {
  if (sw === tw && sh === th) return data
  const out = new Float32Array(tw * th)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.round((y / (th - 1 || 1)) * (sh - 1)))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.round((x / (tw - 1 || 1)) * (sw - 1)))
      out[y * tw + x] = data[sy * sw + sx]
    }
  }
  return out
}
