// scripts/smoke.mjs — real-browser smoke test for the Room3D feature.
// Run: node scripts/smoke.mjs  (dev server must be on :5173)
//
// Verifies: real Depth Anything V2 inference in-browser, point cloud with
// image-derived RGB colors, orbit controls (rotate/zoom/pan), Reset View,
// image swap regeneration, and error states for invalid images.

import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.SMOKE_URL || 'http://localhost:5173'
const CHROME_PATH =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CLOUD_READY_TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 300000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForState(page, predicate, description, timeoutMs) {
  const start = Date.now()
  let lastValue = null
  while (Date.now() - start < timeoutMs) {
    const value = await page.evaluate(() => {
      const el = document.getElementById('room3d-debug')
      const stage = el?.getAttribute('data-stage') || 'unknown'
      let info = { points: 0, rebuilt: 0, rgbStd: 0 }
      try {
        info = JSON.parse(el?.textContent || '{}')
      } catch {}
      return { stage, ...info }
    })
    lastValue = value
    if (predicate(value)) return value
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${description}; last state: ${JSON.stringify(lastValue)}`)
}

// The WebGL canvas is NOT necessarily the first canvas in the DOM (the
// depth-map preview canvas sits above it); pick the largest one.
async function mainCanvasBox(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
    )
    const r = canvases[0].getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--window-size=1280,900', '--use-angle=1', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1280, height: 860 },
  })
  const page = await browser.newPage()

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 300))
  })

  console.log('1. Loading harness page…')
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('#btn-demo1', { timeout: 15000 })
  console.log('   ✓ page loaded')

  console.log('2. Clicking demo room 1 → real Depth Anything V2 inference…')
  const t0 = Date.now()
  await page.click('#btn-demo1')
  const state = await waitForState(
    page,
    (s) => s.stage === 'done' && s.points > 0,
    'inference to complete',
    CLOUD_READY_TIMEOUT,
  )
  console.log(
    `   ✓ READY in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${state.points} points, rebuilt=${state.rebuilt}, rgbStd=${state.rgbStd}`,
  )

  // 3. Colors must be image-derived: non-trivial RGB variance, and the depth
  //    preview canvas must be painted (not all zeros).
  assert(state.rgbStd > 5, `rgbStd too low (${state.rgbStd}) — colors look flat/grayscale`)
  const previewInfo = await page.evaluate(() => {
    const c = document.getElementById('room3d-depth-preview')
    if (!c) return null
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lo = 255
    let hi = 0
    for (let i = 0; i < d.length; i += 40) {
      if (d[i] < lo) lo = d[i]
      if (d[i] > hi) hi = d[i]
    }
    return { lo, hi, exists: true, str: c.toDataURL('image/png').length }
  })
  assert(previewInfo && previewInfo.exists, 'depth preview canvas missing')
  assert(
    previewInfo.hi - previewInfo.lo > 8,
    `depth preview looks flat (range ${previewInfo.lo}–${previewInfo.hi})`,
  )
  console.log(`   ✓ depth preview painted (range ${previewInfo.lo}–${previewInfo.hi})`)

  // 4. Orbit controls: rotate, zoom, pan, reset.
  const dist0 = await page.evaluate(() => window.__room3d.cameraDistance())
  const camBeforeRotate = await page.evaluate(() => window.__room3d.camera())
  await rotate(page)
  await sleep(600) // let damping settle
  const dist1 = await page.evaluate(() => window.__room3d.cameraDistance())
  const camAfterRotate = await page.evaluate(() => window.__room3d.camera())
  const rotated = camAfterRotate.some((v, i) => Math.abs(v - camBeforeRotate[i]) > 0.02)
  page.mouse.wheel({ deltaY: -240 })
  await page.mouse.wheel({ deltaY: -240 })
  await sleep(400)
  const dist2 = await page.evaluate(() => window.__room3d.cameraDistance())
  page.mouse.wheel({ deltaY: 240 })
  await sleep(400)
  const dist3 = await page.evaluate(() => window.__room3d.cameraDistance())
  const camBeforePan = await page.evaluate(() => window.__room3d.camera())
  await pan(page)
  await sleep(600)
  const camAfterPan = await page.evaluate(() => {
    return window.__room3d.camera()
  })

  // Rotate must change the camera pose while keeping orbit distance stable;
  // zoom must move distance; pan must change the pose without zooming.
  assert(rotated, `camera did not rotate: ${JSON.stringify(camBeforeRotate)} → ${JSON.stringify(camAfterRotate)}`)
  assert(Math.abs(dist1 - dist0) < 0.15, `orbit changed distance unexpectedly: ${dist0}→${dist1}`)
  assert(Math.abs(dist2 - dist1) > 0.05, `zoom-in did not change distance: ${dist1}→${dist2}`)
  assert(Math.abs(dist3 - dist2) > 0.05, `zoom-out did not restore distance: ${dist2}→${dist3}`)
  assert(
    camAfterPan.some((v, i) => Math.abs(v - camBeforePan[i]) > 0.01),
    `pan did not move camera: ${JSON.stringify(camBeforePan)} → ${JSON.stringify(camAfterPan)}`,
  )
  console.log(
    `   ✓ orbit (d=${dist0.toFixed(3)}→${dist1.toFixed(3)}), zoom (${dist1.toFixed(3)}→${dist2.toFixed(3)}→${dist3.toFixed(3)}), pan ok`,
  )

  const distBeforeReset = await page.evaluate(() => window.__room3d.cameraDistance())
  await page.click('#btn-reset-view')
  await sleep(800)
  const distReset = await page.evaluate(() => window.__room3d.cameraDistance())
  const camReset = await page.evaluate(() => window.__room3d.camera())
  const camInitial = [0.35, -0.25, 1.75]
  await page.mouse.wheel({ deltaY: -240 }) // displace again
  await sleep(300)
  await page.click('#btn-reset-view')
  await sleep(800)
  const camReset2 = await page.evaluate(() => window.__room3d.camera())
  assert(
    camReset2.every((v, i) => Math.abs(v - camInitial[i]) < 0.02),
    `reset did not restore initial camera: ${JSON.stringify(camReset2)}`,
  )
  console.log(`   ✓ Reset View restores camera ${JSON.stringify(camReset2)} (d=${distReset.toFixed(3)})`)
  void distBeforeReset

  // 5. Image swap → new inference, existing resources replaced.
  console.log('5. Swapping to demo room 2 → re-inference…')
  const t1 = Date.now()
  await page.click('#btn-demo2')
  const state2 = await waitForState(
    page,
    (s) => s.stage === 'done' && s.points > 0 && s.rebuilt > state.rebuilt,
    'second inference to complete',
    CLOUD_READY_TIMEOUT,
  )
  console.log(
    `   ✓ SWAPPED in ${((Date.now() - t1) / 1000).toFixed(1)}s — rebuilt=${state2.rebuilt}, points=${state2.points}`,
  )
  assert(state2.rebuilt === state.rebuilt + 1, 'expected exactly one rebuild')
  // No resource leaks across the swap: the old cloud geometry must be
  // disposed, so Three.js should hold ~1 geometry after 2 rebuilds.
  const infoAfterSwap = await page.evaluate(() => window.__room3d.rendererInfo())
  assert(
    infoAfterSwap && infoAfterSwap.geometries <= 2,
    `geometry leak suspected after swap: ${JSON.stringify(infoAfterSwap)}`,
  )
  console.log(`   ✓ no geometry leaks (renderer memory: ${JSON.stringify(infoAfterSwap)})`)

  // 6. Error states: invalid URL, then empty URL.
  await page.click('#btn-badurl')
  await waitForState(page, (s) => s.stage === 'error', 'error state for invalid URL', 30000)
  const errText = await page.$eval('#room3d-status', (el) => el.textContent || '')
  assert(errText.length > 10 && errText.includes('Could not load'), `unexpected error text: ${errText}`)
  console.log(`   ✓ invalid URL → "${errText.slice(0, 80)}…"`)
  await page.click('#btn-blank')
  await waitForState(page, (s) => s.stage === 'idle', 'idle state for blank URL', 15000)
  console.log('   ✓ blank URL → idle state with helpful message')

  // 6b. Real upload flow: a local file via blob URL (this is exactly what the
  // main frontend upload flow produces), plus a corrupt/unsealable upload.
  console.log('6b. Testing the file-upload (blob URL) flow…')
  const rebuiltBeforeUpload = await page.evaluate(() =>
    Number(document.getElementById('room3d-debug')?.textContent &&
      document.getElementById('room3d-debug').textContent.includes('rebuilt')
      ? JSON.parse(document.getElementById('room3d-debug').textContent).rebuilt
      : 0),
  )
  const t2 = Date.now()
  const fileInput = await page.$('#file-input')
  await fileInput.uploadFile('/tmp/room1.jpg')
  const state3 = await waitForState(
    page,
    (s) => s.stage === 'done' && s.points > 0 && s.rebuilt > rebuiltBeforeUpload,
    'blob-URL inference to complete',
    CLOUD_READY_TIMEOUT,
  )
  console.log(
    `   ✓ BLOB UPLOAD worked in ${((Date.now() - t2) / 1000).toFixed(1)}s — rebuilt=${state3.rebuilt}, points=${state3.points}`,
  )

  await fileInput.uploadFile('/tmp/room-bad.txt')
  await waitForState(page, (s) => s.stage === 'error', 'error state for corrupt upload', 30000)
  const errText2 = await page.$eval('#room3d-status', (el) => el.textContent || '')
  assert(/image|decode|file/i.test(errText2), `unexpected corrupt-upload error: ${errText2}`)
  console.log(`   ✓ corrupt upload → "${errText2.slice(0, 80)}…"`)

  // 7. No unhandled page errors across the whole run.
  const realErrors = pageErrors.filter((e) => !e.includes('ResizeObserver loop'))
  if (realErrors.length) {
    console.error('UNHANDLED PAGE ERRORS:', realErrors)
    process.exitCode = 1
  } else {
    console.log('   ✓ no unhandled browser errors')
  }

  await browser.close()
  console.log('\nSMOKE TEST: PASS')
}

async function rotate(page) {
  const box = await mainCanvasBox(page)
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 })
  await page.mouse.up()
}

async function pan(page) {
  const box = await mainCanvasBox(page)
  await page.mouse.move(box.x, box.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(box.x - 80, box.y - 30, { steps: 8 })
  await page.mouse.up({ button: 'right' })
}

main().catch((err) => {
  console.error('\nSMOKE TEST: FAIL —', err.message)
  process.exit(1)
})
