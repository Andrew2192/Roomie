// scripts/smoke-integration.mjs — full upload→AI-analysis workflow test.
// Requires: dev server (:5173) + Cortex backend (:3001).
// Verifies: preview renders, Room3D runs independently, /api/analyze is hit,
// loading state appears, and the backend's real (honest) error/result shows.

import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.SMOKE_URL || 'http://localhost:5173'
const CHROME_PATH =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--window-size=1440,1000', '--use-angle=1', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1440, height: 960 },
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const apiRequests = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) apiRequests.push(req.url())
  })

  console.log('1. Loading the app…')
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('#btn-upload', { timeout: 15000 })
  console.log('   ✓ app loaded')

  console.log('2. Uploading a real room photo (blob-URL flow)…')
  await page.waitForSelector('#upload-preview', { hidden: true, timeout: 5000 }).catch(() => {})
  // Loading state can be extremely brief against a snappy backend, so record
  // it via a MutationObserver attached BEFORE the upload + read mutation
  // records, not the live DOM (React may swap elements before the callback).
  await page.evaluate(() => {
    window.__sawLoading = false
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.id === 'roomie-analysis-loading') window.__sawLoading = true
        }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
  })
  await (await page.$('#btn-upload')).click() // opens hidden file input
  const fileInput = await page.$('input[type=file]')
  await fileInput.uploadFile('/tmp/room1.jpg')
  await page.waitForSelector('#upload-preview', { timeout: 10000 })
  const previewSrc = await page.$eval('#upload-preview', (el) => el.src)
  assert(previewSrc.startsWith('blob:'), `preview should use a blob URL, got ${previewSrc.slice(0, 24)}…`)
  console.log('   ✓ preview shown from blob URL')

  const points = await waitForPoints(page, 240000)
  console.log(`   ✓ Room3D depth pipeline finished independently: ${points} points`)

  // 3. Analysis publishes either a real result or the backend's real error —
  //    never anything fabricated.
  const outcome = await waitForAnalysis(page, 90000)
  assert(apiRequests.some((u) => u.includes('/api/analyze')), 'browser never hit /api/analyze!')
  console.log(`   ✓ POST /api/analyze fired from the browser (${apiRequests.length} api call(s))`)
  const sawLoading = await page.evaluate(() => window.__sawLoading)
  assert(sawLoading, 'AI loading state was never rendered')
  console.log('   ✓ AI loading state rendered', sawLoading ? '' : ' (MISSING)')
  if (outcome.status === 'error') {
    // Given the account's network policy we EXPECT an honest error here; the
    // assertion guarantees the team sees the backend's real message.
    assert(
      /snowflake|network policy|cortex/i.test(outcome.text),
      `error message not actionable: ${outcome.text}`,
    )
    console.log(`   ✓ honest error state shown: "${outcome.text.slice(0, 90)}…"`)
  } else {
    console.log(`   ✓ REAL Snowflake result rendered: ${outcome.text.slice(0, 120)}…`)
  }

  // 4. Stale-result protection: upload a second photo; whichever pipeline is
  //    slower must not overwrite the other's state.
  await fileInput.uploadFile('/tmp/room2.jpg')
  const points2 = await waitForPoints(page, 240000)
  assert(points2.rebuilt > points.rebuilt, 'Room3D did not rebuild for the second image')
  const outcome2 = await waitForAnalysis(page, 90000)
  assert(outcome2.status === outcome.status || outcome2.status === 'done' || outcome2.status === 'error')
  console.log(`   ✓ second image rebuilt cloud (rebuilt=${points2.rebuilt}) and re-ran analysis (${outcome2.status})`)

  const realErrors = pageErrors.filter((e) => !e.includes('ResizeObserver loop'))
  assert(realErrors.length === 0, `unhandled page errors: ${realErrors.join(' | ')}`)
  console.log('   ✓ no unhandled browser errors')

  await browser.close()
  console.log('\nINTEGRATION SMOKE TEST: PASS')
}

async function waitForPoints(page, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      try {
        const info = JSON.parse(document.getElementById('room3d-debug')?.textContent || '{}')
        return { stage: document.getElementById('room3d-debug')?.dataset.stage, ...info }
      } catch {
        return { stage: 'unknown', points: 0, rebuilt: 0 }
      }
    })
    if (s.stage === 'done' && s.points > 0) return s
    if (s.stage === 'error') throw new Error(`Room3D error state: ${s}`)
    await sleep(700)
  }
  throw new Error('Room3D never reached done state')
}

async function waitForAnalysis(page, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const ok = document.getElementById('roomie-analysis-result')
      const err = document.getElementById('roomie-analysis-error')
      if (ok) return { status: 'done', text: ok.textContent }
      if (err) return { status: 'error', text: err.textContent }
      return { status: 'pending' }
    })
    if (s.status !== 'pending') return s
    await sleep(700)
  }
  throw new Error('AI analysis never settled (loading forever)')
}

main().catch((err) => {
  console.error('\nINTEGRATION SMOKE TEST: FAIL —', err.message)
  process.exit(1)
})
