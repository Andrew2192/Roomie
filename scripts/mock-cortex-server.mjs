// scripts/mock-cortex-server.mjs
// NOT part of the product. Dev-only stub that answers POST /api/analyze with
// the same JSON shape the real backend returns (per server/README.md), so the
// browser rendering of recommendations can be verified while the real account
// is blocked by its network policy. Never renders fake data in the app itself.
import { createServer } from 'node:http'

const analysis = {
  summary: 'A compact living room with a couch, coffee table, and open floor area.',
  observations: [
    'Floor space is mostly clear but the coffee table holds loose items.',
    'Natural light enters from one side; the seating faces away from it.',
    'Some cables and devices are visible near the entertainment unit.',
  ],
  suggestions: [
    { title: 'Add storage baskets under the coffee table', reason: 'Keeps everyday items reachable while clearing the tabletop.', priority: 'high' },
    { title: 'Angle the seating toward the light source', reason: 'Improves daytime comfort without new furniture.', priority: 'medium' },
    { title: 'Tidy and route cables along the media wall', reason: 'Reduces visual clutter and trip hazards.', priority: 'low' },
  ],
}

createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (req.url === '/api/analyze' && req.method === 'POST') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(analysis))
    })
    return
  }
  res.writeHead(404)
  res.end('{"error":"not found"}')
}).listen(3011, () => console.log('stub analysis API on :3011'))
