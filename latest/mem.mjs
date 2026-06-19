#!/usr/bin/env node
// Memory profile of the passthrough path: does the `_read` no-op fix introduce
// unbounded buffering / a leak vs baseline? Exercises the READ/push path with
// sizable responses, sampling heap/RSS over many requests with forced GC
// between samples (so we see retained memory, not uncollected garbage).
//
// Run A/B via MSW_FIX (entrypoint applies FIX_KIND). Watch for:
//  - monotonic heapUsed/rss growth (leak) vs flat/sawtooth (healthy)
//  - active handle count growth
//  - MaxListenersExceededWarning (the #706 signature)
import https from 'https'
import fs from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Control: with NO_NOCK, never import/activate nock — raw https passthrough, no
// interceptor. Isolates whether the leak is in msw/nock or the harness/Node.
let nock = null
if (!process.env.NO_NOCK) {
  nock = (await import('nock')).default
}

const key = fs.readFileSync('/work/certs/key.pem')
const cert = fs.readFileSync('/work/certs/cert.pem')

const config = {
  requests: parseInt(process.env.REQUESTS || '20000', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '50', 10),
  respKB: parseInt(process.env.RESP_KB || '64', 10),
  sample: parseInt(process.env.SAMPLE || '2000', 10),
}
const RESP = Buffer.alloc(config.respKB * 1024, 'y')

let warned = false
process.on('warning', (w) => {
  if (/MaxListenersExceeded/.test(String(w.name) + String(w.message))) {
    warned = true
    console.log(`[mem] !! MaxListenersExceededWarning`)
  }
})

function interceptorsVersion() {
  try { return require('@mswjs/interceptors/package.json').version } catch { return 'unknown' }
}

function sampleMem(done) {
  if (global.gc) { global.gc() }
  const m = process.memoryUsage()
  const handles = process._getActiveHandles ? process._getActiveHandles().length : -1
  const reqs = process._getActiveRequests ? process._getActiveRequests().length : -1
  console.log(
    `[mem] done=${done} heapUsed=${(m.heapUsed/1048576).toFixed(1)}MB rss=${(m.rss/1048576).toFixed(1)}MB ` +
    `external=${(m.external/1048576).toFixed(1)}MB arrayBuffers=${(m.arrayBuffers/1048576).toFixed(1)}MB ` +
    `handles=${handles} activeReqs=${reqs}`
  )
}

const startServer = () =>
  new Promise((resolve) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200); res.end(RESP) })
    })
    server.listen(0, '::', () => resolve({ server, port: server.address().port }))
  })

const issue = (port, agent) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      { host: 'localhost', port, method: 'GET', path: '/', rejectUnauthorized: false, agent },
      (res) => { res.on('data', () => {}); res.on('end', resolve) }
    )
    req.on('error', reject)
    req.end()
  })

async function main() {
  if (nock) { nock.enableNetConnect() }
  console.log(`[mem] interceptors=${nock ? interceptorsVersion() : 'NO_NOCK'} nock=${nock ? require('nock/package.json').version : 'off'}`)
  console.log(`[mem] load=${config.requests} reqs x ${config.concurrency} conc, resp=${config.respKB}KB, fix=${process.env.MSW_FIX ? process.env.FIX_KIND : 'off'}`)
  const { server, port } = await startServer()
  const agent = new https.Agent({ keepAlive: true, maxSockets: config.concurrency, rejectUnauthorized: false })
  let next = 0, done = 0, errors = 0
  sampleMem(0)
  const take = () => (next < config.requests ? next++ : null)
  const worker = async () => {
    while (take() !== null) {
      try { await issue(port, agent) } catch { errors++ }
      done++
      if (done % config.sample === 0) sampleMem(done)
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, worker))
  agent.destroy()
  await new Promise((r) => server.close(r))
  sampleMem(done)
  console.log(`[mem] errors=${errors} MaxListenersWarning=${warned}`)
  process.exit(0)
}
main().catch((e) => { console.error('[mem] fatal', e); process.exit(2) })
