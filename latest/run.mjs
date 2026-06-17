#!/usr/bin/env node
// Repro against the REAL latest published packages (nock + @mswjs/interceptors),
// NOT the local fork. The fork's HANDLE-MISMATCH instrumentation does not exist
// here, so we detect the #753 bug by tallying real error codes from three
// channels: per-request 'error' events, process 'uncaughtException', and a
// stderr scan (Node prints "read EINVAL" / ECANCELED there on the crash path).
import http from 'http'
import net from 'net'
import nock from 'nock'
import { networkInterfaces } from 'os'
import dns from 'dns/promises'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const log = (m) => console.log(`[latest] ${m}`)

function interceptorsVersion() {
  try {
    return require('@mswjs/interceptors/package.json').version
  } catch {
    try {
      return require('nock/node_modules/@mswjs/interceptors/package.json').version
    } catch {
      return 'unknown'
    }
  }
}

const config = {
  concurrency: parseInt(process.env.CONCURRENCY || '300', 10),
  requests: parseInt(process.env.REQUESTS || '8000', 10),
  runs: parseInt(process.env.RUNS || '1', 10),
}

// ---- detection ----
const BUG_CODES = new Set(['EINVAL', 'ECANCELED'])
const errorCounts = Object.create(null)
function bump(code) {
  const k = code || 'UNKNOWN'
  errorCounts[k] = (errorCounts[k] || 0) + 1
}
let stderrHits = 0
const origStderr = process.stderr.write.bind(process.stderr)
process.stderr.write = (...args) => {
  const s = String(args[0])
  if (s.includes('EINVAL') || s.includes('ECANCELED')) stderrHits++
  return origStderr(...args)
}
let uncaught = 0
process.on('uncaughtException', (err) => {
  uncaught++
  bump(err && err.code)
  // swallow so a single socket EINVAL doesn't abort the whole burn-in
})

async function checkDualStack() {
  const ifs = Object.values(networkInterfaces()).flat()
  const hasV4 = ifs.some((i) => i.family === 'IPv4' && !i.internal)
  const hasV6 = ifs.some(
    (i) => i.family === 'IPv6' && !i.internal && !i.address.startsWith('fe80:')
  )
  let dnsV4 = false
  let dnsV6 = false
  try {
    const a = await dns.lookup('localhost', { all: true })
    dnsV4 = a.some((x) => x.family === 4)
    dnsV6 = a.some((x) => x.family === 6)
  } catch {}
  const ok = hasV4 && hasV6 && dnsV4 && dnsV6
  log(`dual stack: ${ok ? '✓ complete' : '⚠ incomplete'} (v4if=${hasV4} v6if=${hasV6} dnsV4=${dnsV4} dnsV6=${dnsV6})`)
  return ok
}

const setupMocks = () => {
  nock.enableNetConnect()
  nock('https://non-existent-domain.com').get('/').reply(200)
}

const startServer = () => {
  const conns = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  server.on('connection', (c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
  })
  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, conns, port: server.address().port }))
  )
}

const issueRequest = ({ port, agent }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { port, method: 'POST', path: '/', headers: { connection: 'keep-alive' }, agent },
      (res) => {
        res.resume()
        res.on('end', resolve)
      }
    )
    req.on('error', reject)
    req.write('test data')
    req.end()
  })

async function runOnce() {
  setupMocks()
  const { server, conns, port } = await startServer()
  const agent = new http.Agent({ keepAlive: true, maxSockets: config.concurrency })
  let next = 0
  const take = () => (next < config.requests ? next++ : null)
  const worker = async () => {
    while (take() !== null) {
      try {
        await issueRequest({ port, agent })
      } catch (err) {
        bump(err && err.code)
      }
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, worker))
  agent.destroy()
  conns.forEach((c) => c.destroy())
  await new Promise((r) => server.close(r))
}

async function main() {
  log(`⚡ LATEST-packages stress test`)
  log(`  node:             ${process.version}`)
  log(`  @mswjs/interceptors: ${interceptorsVersion()}`)
  log(`  nock:             ${require('nock/package.json').version}`)
  log(`  autoSelectFamily: ${net.getDefaultAutoSelectFamily()}`)
  log(`  load:             ${config.requests} reqs × ${config.concurrency} sockets × ${config.runs} runs`)
  await checkDualStack()

  for (let i = 1; i <= config.runs; i++) {
    if (config.runs > 1) log(`──── run ${i}/${config.runs} ────`)
    await runOnce()
  }

  const bugHits =
    (errorCounts.EINVAL || 0) + (errorCounts.ECANCELED || 0) + stderrHits
  log('')
  log(`═══ SUMMARY ═══`)
  log(`  error code histogram: ${JSON.stringify(errorCounts)}`)
  log(`  stderr EINVAL/ECANCELED hits: ${stderrHits}`)
  log(`  uncaughtExceptions: ${uncaught}`)
  log(`  → bug signal (EINVAL+ECANCELED+stderr): ${bugHits}`)
  log(bugHits > 0 ? '❌ BUG REPRODUCED' : '✅ NO BUG (clean)')
  // give any late async errors a tick to surface
  await new Promise((r) => setTimeout(r, 250))
  process.exit(bugHits > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[latest] fatal', e)
  process.exit(2)
})
