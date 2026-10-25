# Room3D — integration guide for the Roomie frontend

**Owner:** CV / 3D visualization feature
**Scope:** `src/components/Room3D.jsx`, `src/lib/depth.js` only. Nothing here touches the dashboard, upload flow, or Snowflake backend.

## TL;DR — the one-line integration

```jsx
import Room3D from './components/Room3D.jsx'

// In your image-upload flow, wherever `file` is the uploaded File object:
const imageUrl = URL.createObjectURL(file)   // you already do/have something like this

<Room3D imageUrl={imageUrl} />
```

That's it. No props beyond `imageUrl`, no keys, no backend, no state plumbing.

## Requirements in the app

```bash
npm i @huggingface/transformers three
# deps used: @huggingface/transformers@^3.8.1 (browser ONNX inference)
#            three@^0.170.0 (3D rendering)
```

React version: any ≥17 that supports function components + hooks (we ran 18.3).

## Behavior contract

| Input `imageUrl` | Behavior |
| --- | --- |
| `blob:` URL from `URL.createObjectURL(file)` | ✅ primary path, fully tested |
| `data:` URL | ✅ supported (decoded via `fetch`) |
| CORS-enabled `http(s)` photo URL (e.g. Unsplash) | ✅ supported |
| `''` / `null` / non-string | friendly idle state, no request made |
| broken URL / corrupt file / non-image mime | inline error pill, no crash |

- Depth is estimated **in-browser** with `onnx-community/depth-anything-v2-small` (Transformers.js v3 = ONNX Runtime Web; WASM backend by default, `q8` quantized weights ≈ 26 MB downloaded **once per browser**, then served from the browsers' local cache).
- Rendering: `THREE.Points` + `PointsMaterial` with vertex colors sampled from the **original photograph** (sRGB → linear conversion handled internally), ~160×120 sample grid, aspect ratio preserved, cloud centered at origin, dark background.
- Hover gestures: left-drag = orbit, wheel = zoom, right-drag = pan; damped controls; **Reset View** button; **Depth strength** slider (0–2×, re-projects Z live, no re-inference); **Point size** slider; small grayscale depth-map preview (top-right).
- Lifecycle: one cached model pipeline per app session; per-URL result cache; stale-async guard when the image changes quickly; geometry/material/renderer/dispose + rAF + ResetObserver teardown on unmount (resource checks included in smoke test).
- If the user's GPU/browser lacks WebGPU nothing is attempted — WASM is the guaranteed path. (Opt-in: `estimateDepth(url, { device:'webgpu' })` falls back to WASM automatically if WebGPU is unavailable.)

## What it looks like internally (for debugging only)

- `src/lib/depth.js`
  - `estimateDepth(imageUrl, { device?, dtype?, onProgress? })` → `Promise<{ width, height, rgba: Uint8ClampedArray, depth: { width, height, data: Float32Array /* 0..1, 1 = nearest */ }, meta }>`
  - `DepthEstimationError` with `.code`: `bad_input | load_failed | decode_failed | model_unavailable | inference_failed`
  - Result + pipeline caches; concurrent identical calls are deduped.
- `src/components/Room3D.jsx`
  - Every `imageUrl` change runs: decode → (maybe) model load → inference → build/replace `THREE.Points`.
  - `window.__room3d` is a tiny debug/test handle (points count, camera pose, renderer memory) — safe to ignore in app code.

## Styling

The component styles itself (inline styles, dark scene `#070b12`), sized by its parent (set a sized wrapper: it fills 100% width/height). No CSS imports, no global styles added.

## First-load UX expectation

The very first scan after a fresh browser session downloads ~26 MB of model weights (progress bar inside the component), then inference takes a few seconds per image. Subsequent scans (same or different images) skip the download entirely. For a demo, do one warm-up scan before showing the judges.

## Running / testing this feature standalone

```bash
npm install
npm run dev          # http://localhost:5173 — harness with demo rooms + upload
npm run build        # must pass
node scripts/smoke.mjs   # real-browser smoke test (needs Chrome on macOS; dev server running)
```

`scripts/smoke.mjs` drives a real headless Chrome: model download → inference on two different room photos → orbit/zoom/pan/reset assertions → blob-URL file upload → corrupt-file error state → geometry-leak check → zero unhandled errors. It requires `/tmp/room1.jpg` (any room photo) and `/tmp/room-bad.txt` (plain text) for the upload steps.

## Known limitations

- 2.5D relief, not a true 3D scan (by design).
- ~5 s inference per new image on WASM (`q8`) on a laptop; model download ~26 MB once.
- First `npm run build` bundles a large ONNX runtime chunk (~1.5 MB JS) — consider code-splitting/`React.lazy` for Room3D on the dashboard if bundle size matters.
- WebGPU path exists (`device:'webgpu'` in `estimateDepth`) but ships **off** by default (compatibility > speed for the hackathon); enabling it would need COOP/COEP headers for threading anyway.
- No ReqestIdle anything — heavy decode+inference is async but not chunked; page may pause briefly (~1-2s) near inference end on slow machines.
