// src/components/Room3D.jsx
// Roomie CV module — interactive 3D point-cloud room visualizer.
//
// Usage (this is the whole integration for the frontend developer):
//
//   import Room3D from './components/Room3D.jsx'
//   <Room3D imageUrl={objectUrlOrHttpsUrl} />
//
// - imageUrl can be a blob URL (URL.createObjectURL(file)), data URL, or any
//   CORS-enabled http(s) image URL.
// - Depth is estimated in-browser with Depth Anything V2 (no API keys, no
//   backend, real ONNX inference). Colors come from the original photograph.
// - Drag = rotate, wheel = zoom, right-drag (or two-finger) = pan.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { estimateDepth, DepthEstimationError } from '../lib/depth.js'

const DEPTH_STRENGTH_DEFAULT = 1.0
const POINT_SIZE_DEFAULT = 0.011

// Point-cloud layout constants (world units).
const CLOUD_WIDTH = 1.6 // world width of the cloud (height = width / aspect)
const CLOUD_DEPTH_RANGE = 0.5 // world-units of relief at depthStrength = 1

const COLORS = {
  bg: '#070b12',
  panel: 'rgba(10, 15, 24, 0.82)',
  text: '#e5e7ec',
  dim: '#8b93a1',
  accent: '#5eead4',
  danger: '#f87171',
}

const CONTAINER_STYLE = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minWidth: 240,
  minHeight: 240,
  overflow: 'hidden',
  background: COLORS.bg,
  borderRadius: 'inherit',
}

// sRGB byte -> linear-sRGB float lookup. Three.js color-managed rendering
// expects vertex colors in linear space; without this the photo colors would
// look washed out.
const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const s = i / 255
    lut[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return lut
})()

export default function Room3D({ imageUrl }) {
  const containerRef = useRef(null)
  const depthPreviewRef = useRef(null) // <canvas> for the grayscale depth preview
  const threeRef = useRef(null) // { renderer, scene, camera, controls, points, pointsMaterial, baseZ, pointsCount, ... }
  const loadTokenRef = useRef(0)
  const rebuildCountRef = useRef(0)
  const depthStrengthRef = useRef(DEPTH_STRENGTH_DEFAULT)
  const lastDepthRef = useRef(null) // latest inferred depth result, for the preview

  const [status, setStatus] = useState(
    imageUrl ? { stage: 'decoding' } : { stage: 'idle' },
  ) // stage: idle | decoding | loading-model | inferring | done | error
  const [message, setMessage] = useState('')
  const [depthStrength, setDepthStrength] = useState(DEPTH_STRENGTH_DEFAULT)
  const [pointSize, setPointSize] = useState(POINT_SIZE_DEFAULT)
  const [debugInfo, setDebugInfo] = useState({ points: 0, rgbStd: 0, rebuilt: 0 })

  // ---------------------------------------------------------------------
  // Depth-strength: updates only the Z coordinates (no re-inference).
  // ---------------------------------------------------------------------

  const applyDepthStrength = useCallback((strength) => {
    const three = threeRef.current
    if (!three?.baseZ) return
    const posAttr = three.points?.geometry?.getAttribute('position')
    if (!posAttr) return
    for (let i = 0; i < three.baseZ.length; i++) {
      posAttr.array[i * 3 + 2] = three.baseZ[i] * strength
    }
    posAttr.needsUpdate = true
  }, [])

  useEffect(() => {
    depthStrengthRef.current = depthStrength
  }, [depthStrength])

  // ---------------------------------------------------------------------
  // Point-cloud construction: depth result → colored THREE.Points
  // ---------------------------------------------------------------------

  const buildPointCloud = useCallback((result) => {
    const three = threeRef.current
    if (!three) return
    const { width, height, rgba, depth } = result
    lastDepthRef.current = depth
    const aspect = width / height

    // ~160×120 sample grid (landscape); portrait maps to ~120 rows, always
    // preserving the image aspect ratio.
    let nx
    let ny
    if (aspect >= 1) {
      nx = 160
      ny = Math.max(16, Math.round(nx / aspect))
    } else {
      ny = 120
      nx = Math.max(16, Math.round(ny * aspect))
    }

    const cloudHeight = CLOUD_WIDTH / aspect
    const count = nx * ny
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const baseZ = new Float32Array(count) // un-exaggerated z, for the slider

    const dw = depth.width
    const dh = depth.height
    const ddata = depth.data

    // Debug metric: per-point RGB std (proves colors are image-derived and
    // not constant/grayscale).
    let meanR = 0
    let meanG = 0
    let meanB = 0
    let acc = 0
    const samples = new Float32Array(count * 3)

    let p = 0
    for (let j = 0; j < ny; j++) {
      const v = ny === 1 ? 0.5 : j / (ny - 1) // 0..1 top→bottom
      for (let i = 0; i < nx; i++) {
        const u = nx === 1 ? 0.5 : i / (nx - 1) // 0..1 left→right

        // Depth and color sampled at the same fractional location, so
        // different image/depth resolutions are handled correctly.
        const px = Math.min(width - 1, Math.round(u * (width - 1)))
        const py = Math.min(height - 1, Math.round(v * (height - 1)))
        const dx = Math.min(dw - 1, Math.round(u * (dw - 1)))
        const dy = Math.min(dh - 1, Math.round(v * (dh - 1)))
        const d = ddata[dy * dw + dx] // 0 = far .. 1 = near

        // X/Y: image plane centered on the origin, aspect preserved, Y flips
        // so image row 0 is the top of the world.
        positions[p * 3 + 0] = (u - 0.5) * CLOUD_WIDTH
        positions[p * 3 + 1] = -(v - 0.5) * cloudHeight
        // Z: nearer points pop toward the viewer (camera sits at +Z).
        const z = (d - 0.5) * CLOUD_DEPTH_RANGE
        baseZ[p] = z
        positions[p * 3 + 2] = z

        // Color from the original photograph.
        const idx4 = (py * width + px) * 4
        const r = rgba[idx4]
        const g = rgba[idx4 + 1]
        const b = rgba[idx4 + 2]
        colors[p * 3 + 0] = SRGB_TO_LINEAR[r]
        colors[p * 3 + 1] = SRGB_TO_LINEAR[g]
        colors[p * 3 + 2] = SRGB_TO_LINEAR[b]
        samples[p * 3] = r
        samples[p * 3 + 1] = g
        samples[p * 3 + 2] = b
        meanR += r
        meanG += g
        meanB += b
        p++
      }
    }

    // Swap in the new Points object, disposing the previous geometry.
    if (three.points) {
      three.scene.remove(three.points)
      three.points.geometry.dispose()
      three.points = null
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    three.points = new THREE.Points(geometry, three.pointsMaterial)
    three.points.frustumCulled = true
    three.scene.add(three.points)
    three.pointsCount = count
    three.baseZ = baseZ

    applyDepthStrength(depthStrengthRef.current)
    rebuildCountRef.current += 1

    const n = count
    meanR /= n
    meanG /= n
    meanB /= n
    for (let i = 0; i < n; i++) {
      const dr = samples[i * 3] - meanR
      const dg = samples[i * 3 + 1] - meanG
      const db = samples[i * 3 + 2] - meanB
      acc += dr * dr + dg * dg + db * db
    }
    setDebugInfo({
      points: n,
      rgbStd: Number(Math.sqrt(acc / n).toFixed(1)),
      rebuilt: rebuildCountRef.current,
    })

  }, [applyDepthStrength])

  // ---------------------------------------------------------------------
  // Scene setup / teardown (once per mount)
  // ---------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch (err) {
      setStatus({ stage: 'error' })
      setMessage(`WebGL is not available in this browser: ${err?.message ?? err}`)
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    renderer.domElement.style.display = 'block'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(COLORS.bg)

    const aspect = (container.clientWidth / container.clientHeight) || 1
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 100)
    // Initial camera: slightly angled for a sense of depth, framed on the
    // 1.6-wide cloud.
    camera.position.set(0.35, -0.25, 1.75)
    camera.lookAt(0, 0, 0)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.screenSpacePanning = true
    controls.target.set(0, 0, 0)
    controls.minDistance = 0.2
    controls.maxDistance = 12
    controls.update()
    controls.saveState() // Reset View returns to this pose

    const pointsMaterial = new THREE.PointsMaterial({
      size: POINT_SIZE_DEFAULT,
      sizeAttenuation: true,
      vertexColors: true,
    })

    let rafId = 0
    const tick = () => {
      controls.update() // required for damping
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    threeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      pointsMaterial,
      points: null,
      pointsCount: 0,
      baseZ: null,
    }

    // Small, harmless debug/test handle (used by the smoke test; do not rely
    // on it in app logic).
    window.__room3d = {
      get pointsCount() {
        return threeRef.current?.pointsCount ?? 0
      },
      get ready() {
        return !!threeRef.current?.points
      },
      camera: () => threeRef.current?.camera?.position.toArray(),
      cameraDistance: () =>
        threeRef.current?.camera?.position.distanceTo(
          threeRef.current?.controls?.target ?? new THREE.Vector3(),
        ) ?? null,
      rendererInfo: () => {
        const m = threeRef.current?.renderer?.info?.memory
        return m ? { geometries: m.geometries, textures: m.textures } : null
      },
    }

    return () => {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      controls.dispose()
      const three = threeRef.current
      if (three?.points) {
        three.scene.remove(three.points)
        three.points.geometry.dispose()
      }
      pointsMaterial.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      threeRef.current = null
      delete window.__room3d
    }
  }, [])

  // Keep material size in sync with the slider (no re-inference).
  useEffect(() => {
    const three = threeRef.current
    if (three?.pointsMaterial) three.pointsMaterial.size = pointSize
  }, [pointSize])

  // ---------------------------------------------------------------------
  // Inference lifecycle (per imageUrl) — real model only, no simulated maps.
  // ---------------------------------------------------------------------

  useEffect(() => {
    const token = ++loadTokenRef.current
    let cancelled = false

    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
      rebuildCountRef.current = 0
      setDebugInfo({ points: 0, rgbStd: 0, rebuilt: 0 })
      setStatus({ stage: 'idle' })
      setMessage('Waiting for a room photo…')
      return undefined
    }

    setStatus({ stage: 'decoding' })
    setMessage('')

    estimateDepth(imageUrl, {
      onProgress: (s) => {
        if (cancelled) return
        setStatus((prev) => {
          const order = ['decoding', 'loading-model', 'inferring']
          const prevIdx = order.indexOf(prev.stage)
          const nextIdx = order.indexOf(s.stage)
          // Never regress the stage; percent updates within a stage are fine.
          if (nextIdx !== -1 && nextIdx < prevIdx) return prev
          return s
        })
      },
    })
      .then((result) => {
        if (cancelled || token !== loadTokenRef.current) return
        buildPointCloud(result)
        setStatus({ stage: 'done' })
      })
      .catch((err) => {
        if (cancelled || token !== loadTokenRef.current) return
        console.error('[roomie/Room3D] depth pipeline failed:', err)
        setStatus({ stage: 'error' })
        setMessage(
          (err instanceof DepthEstimationError
            ? err.message
            : `Unexpected error during depth estimation: ${err?.message ?? err}`) ||
            'Depth estimation failed for an unknown reason.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [imageUrl, buildPointCloud])

  // Paint the depth preview after the canvas has mounted (it only appears
  // together with the cloud, so painting must happen post-render).
  useEffect(() => {
    if (status.stage === 'done' && lastDepthRef.current) {
      paintDepthPreview(depthPreviewRef.current, lastDepthRef.current)
    }
  }, [status.stage, debugInfo])

  const onReset = useCallback(() => {
    const controls = threeRef.current?.controls
    if (!controls) return
    controls.reset()
    controls.update()
  }, [])

  const overlayVisible =
    status.stage === 'idle' ||
    status.stage === 'decoding' ||
    status.stage === 'loading-model' ||
    status.stage === 'inferring' ||
    status.stage === 'error'
  const hasCloud = debugInfo.points > 0 && status.stage === 'done'
  const pct = typeof status.percent === 'number' ? status.percent : null

  return (
    <div ref={containerRef} style={CONTAINER_STYLE}>
      {/* Hidden debug handle for the smoke test (not needed for integration) */}
      <div id="room3d-debug" data-stage={status.stage} style={{ display: 'none' }}>
        {JSON.stringify(debugInfo)}
      </div>

      {/* Loading / idle / error overlay — hidden once the cloud is ready */}
      {overlayVisible && !hasCloud ? (
        <div
          id="room3d-overlay"
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            right: 10,
            display: 'flex',
            justifyContent: 'flex-start',
            pointerEvents: 'none',
          }}
        >
          <div
            id="room3d-status"
            style={{
              pointerEvents: 'auto',
              background: COLORS.panel,
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10,
              padding: '8px 12px',
              color: status.stage === 'error' ? COLORS.danger : COLORS.text,
              fontSize: 12,
              lineHeight: 1.5,
              maxWidth: '85%',
              backdropFilter: 'blur(6px)',
            }}
          >
            {status.stage === 'idle' && 'Room3D ready — waiting for a room photo.'}
            {status.stage === 'decoding' && 'Decoding image…'}
            {status.stage === 'loading-model' && (
              <>
                <div>Loading depth model… {pct != null ? `${pct}%` : ''}</div>
                <div
                  style={{
                    marginTop: 4,
                    width: 180,
                    maxWidth: 180,
                    height: 4,
                    background: 'rgba(255,255,255,0.12)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${pct ?? 8}%`,
                      background: COLORS.accent,
                      transition: 'width 0.15s ease',
                    }}
                  />
                </div>
                {pct == null && (
                  <div style={{ color: COLORS.dim }}>first run downloads the model (~26 MB)</div>
                )}
              </>
            )}
            {status.stage === 'inferring' && 'Estimating depth…'}
            {status.stage === 'error' && `Error: ${message}`}
          </div>
        </div>
      ) : null}

      {/* Grayscale depth-map preview (painted imperatively after inference) */}
      {hasCloud && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            overflow: 'hidden',
            background: COLORS.bg,
          }}
          title="Depth map (brighter = nearer)"
        >
          <canvas
            id="room3d-depth-preview"
            ref={depthPreviewRef}
            width={128}
            height={96}
            style={{ display: 'block', width: 128, height: 96 }}
          />
        </div>
      )}

      {/* Controls bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          left: 10,
          right: 10,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          pointerEvents: 'auto',
          background: COLORS.panel,
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          padding: '8px 12px',
          backdropFilter: 'blur(6px)',
        }}
      >
        <button
          type="button"
          id="btn-reset-view"
          onClick={onReset}
          style={{
            background: COLORS.accent,
            color: '#06281f',
            border: 'none',
            borderRadius: 8,
            padding: '6px 14px',
            fontWeight: 600,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Reset View
        </button>
        <RangeControl
          id="slider-depth"
          label="Depth strength"
          min={0}
          max={2}
          step={0.05}
          value={depthStrength}
          onChange={(value) => {
            setDepthStrength(value)
            applyDepthStrength(value)
          }}
          format={(v) => v.toFixed(2)}
        />
        <RangeControl
          id="slider-pointsize"
          label="Point size"
          min={0.003}
          max={0.04}
          step={0.001}
          value={pointSize}
          onChange={setPointSize}
          format={(v) => (v * 1000).toFixed(0)}
        />
        {hasCloud && (
          <span style={{ marginLeft: 'auto', color: COLORS.dim, fontSize: 11 }}>
            {debugInfo.points.toLocaleString()} points · 2.5D reconstruction
          </span>
        )}
      </div>
    </div>
  )
}

// Paint the grayscale depth preview at its fixed <canvas> resolution.
function paintDepthPreview(canvas, depth) {
  if (!canvas) return
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: dw, height: dh, data } = depth
    // Downsample the depth grid straight into 128×96 canvas pixels with a
    // temporary buffer sized to the canvas (cheaper than drawImage scaling
    // for this small size and avoids extra canvases in the DOM).
    const cw = canvas.width
    const ch = canvas.height
    const img = ctx.createImageData(cw, ch)
    for (let y = 0; y < ch; y++) {
      const sy = Math.min(dh - 1, Math.round((y / (ch - 1 || 1)) * (dh - 1)))
      for (let x = 0; x < cw; x++) {
        const sx = Math.min(dw - 1, Math.round((x / (cw - 1 || 1)) * (dw - 1)))
        const v = Math.round(Math.min(1, Math.max(0, data[sy * dw + sx])) * 255)
        const o = (y * cw + x) * 4
        img.data[o] = v
        img.data[o + 1] = v
        img.data[o + 2] = v
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  } catch (err) {
    console.warn('[roomie/Room3D] depth preview paint failed (non-fatal):', err)
  }
}

function RangeControl({ id, label, min, max, step, value, onChange, format }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.dim }}>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 110, accentColor: COLORS.accent }}
      />
      <span style={{ minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {format ? format(value) : value.toFixed(2)}
      </span>
    </label>
  )
}
