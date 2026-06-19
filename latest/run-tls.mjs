#!/usr/bin/env node
// TLS variant of the latest-packages repro. The real CI crash we hit at work is a
// `write ECANCELED "Canceled because of SSL destruction"` on a TLSSocket
// (MockHttpSocket.ts:293), which the plain-HTTP harness never surfaces.
// This drives HTTPS passthrough (nock active, real TLS socket wrapped by
// @mswjs/interceptors' MockHttpSocket) against a local self-signed server,
// under the same dual-stack + netem Happy-Eyeballs race, to surface the
// write/ECANCELED face in addition to the read/EINVAL face.
import https from 'https'
import net from 'net'
import fs from 'fs'
import nock from 'nock'
import { networkInterfaces } from 'os'
import dns from 'dns/promises'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const log = (m) => console.log(`[tls] ${m}`)

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
  certDir: process.env.CERT_DIR || '/work/certs',
  // Large request body so a TLS write is in-flight when Happy Eyeballs tears
  // the socket down -> surfaces `write ECANCELED "SSL destruction"` (the real
  // write face we hit at work), not just read EINVAL. 9-byte bodies flush too fast to catch it.
  bodyBytes: parseInt(process.env.BODY_KB || '256', 10) * 1024,
  targetHost: process.env.TARGET_HOST || 'localhost',
  maxSockets: parseInt(process.env.MAX_SOCKETS || process.env.CONCURRENCY || '300', 10),
  // 'drain'  : read the body normally (read-EINVAL face)
  // 'throttle': pause/resume the HTTP stream (weak backpressure)
  // 'stall'  : accept the TLS conn but NEVER read the body -> the client's TLS
  //            write fills the window and stays PENDING, so when the stale-handle
  //            cascade destroys the socket the in-flight write is cancelled =>
  //            `write ECANCELED "SSL destruction"` (the real write face we hit at work).
  serverMode: process.env.SERVER_MODE || 'drain',
  reqTimeoutMs: parseInt(process.env.REQ_TIMEOUT_MS || '0', 10),
  // When a request times out (e.g. against tlsstall), destroy it — this tears
  // the mock down, which closes the #706-shared handle while originalSocket is
  // mid-handshake with a pending write => `write ECANCELED "SSL destruction"`.
  // Faithful to real CI, where nock afterAll teardown / pool churn destroys the
  // mock mid-flight. Pair with the flag ON to remove the HE/EINVAL pre-emption.
  destroyOnTimeout: process.env.DESTROY_ON_TIMEOUT === '1',
}

// Capture the first ECANCELED so we can confirm it is bug-driven (originates in
// the interceptor's teardown) and not contamination from our own timeout.
let firstEcanceled = null

const BODY = Buffer.alloc(config.bodyBytes, 'x')

// ---- detection ----
const errorCounts = Object.create(null)
function bump(code) {
  const k = code || 'UNKNOWN'
  errorCounts[k] = (errorCounts[k] || 0) + 1
}
let stderrHits = 0
let sslDestructionHits = 0
const origStderr = process.stderr.write.bind(process.stderr)
process.stderr.write = (...args) => {
  const s = String(args[0])
  if (s.includes('EINVAL') || s.includes('ECANCELED')) stderrHits++
  if (s.includes('SSL destruction')) sslDestructionHits++
  return origStderr(...args)
}
let uncaught = 0
process.on('uncaughtException', (err) => {
  uncaught++
  bump(err && err.code)
  if (err && /SSL destruction/.test(err.message || '')) sslDestructionHits++
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
  // nock active: enableNetConnect lets the request pass through
  // MockHttpSocket.passthrough() to the real (TLS) socket, which is the
  // code path that holds the stale _handle.
  nock.enableNetConnect()
  nock('https://non-existent-domain.invalid').get('/').reply(200)
}

const startServer = (key, cert) => {
  const conns = new Set()
  // tlsstall: a PLAIN TCP server that accepts and swallows the ClientHello but
  // NEVER completes the TLS handshake. The client's passthrough TLSSocket is
  // then stuck mid-handshake with the request write pending (current_write_);
  // when the request times out and MSW tears the mock down, closing the shared
  // (#706-aliased) handle yields `write ECANCELED "SSL destruction"` — the real
  // write face we hit at work, through the actual interceptor.
  if (config.serverMode === 'tlsstall') {
    const server = net.createServer((socket) => {
      conns.add(socket)
      socket.on('data', () => {})
      socket.on('error', () => {})
      socket.on('close', () => conns.delete(socket))
    })
    return new Promise((resolve) =>
      // Bind dual-stack (::) so the TCP connect succeeds on whichever family
      // localhost resolves to (esp. with the flag ON, where there's no HE
      // fallback) — then the TLS handshake stalls as intended.
      server.listen(0, '::', () =>
        resolve({ server, conns, port: server.address().port })
      )
    )
  }
  const server = https.createServer({ key, cert }, (req, res) => {
    if (config.serverMode === 'stall') {
      // Never read the body and never respond: the client's TLS write backs up
      // and stalls (pending) until the bug tears the socket down -> ECANCELED.
      return
    }
    if (config.serverMode === 'throttle') {
      req.on('data', () => {
        req.pause()
        setTimeout(() => req.resume(), 10)
      })
    } else {
      req.resume()
    }
    req.on('end', () => {
      res.writeHead(200)
      res.end('ok')
    })
  })
  server.on('connection', (c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
  })
  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  return new Promise((resolve) =>
    // Default 127.0.0.1 (POISON_V6 needs a v4-only server). Set SERVER_BIND=::
    // for a dual-stack server so a `localhost` connect succeeds on either family
    // — needed to A/B the flag's effect on EINVAL with successful requests.
    server.listen(0, process.env.SERVER_BIND || '127.0.0.1', () =>
      resolve({ server, conns, port: server.address().port })
    )
  )
}

const issueRequest = ({ port, agent }) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        // Connect by hostname so dual-stack DNS yields both A + AAAA and Happy
        // Eyeballs races the families. With TARGET_HOST=mockhost (+ POISON_V6),
        // the v6 attempt is first and times out, mimicking CircleCI's no-v6-egress.
        host: config.targetHost,
        port,
        method: 'POST',
        path: '/',
        headers: {
          connection: 'keep-alive',
          'content-length': String(BODY.length),
        },
        rejectUnauthorized: false,
        agent,
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
      }
    )
    let timer = null
    if (config.reqTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (config.destroyOnTimeout) {
          // Tear the request (mock) down — closes the shared handle mid-flight.
          req.destroy()
        }
        const e = new Error('req-timeout')
        e.code = 'REQTIMEOUT'
        reject(e)
      }, config.reqTimeoutMs)
    }
    req.on('error', (err) => {
      if (timer) clearTimeout(timer)
      // Count SSL-destruction directly here: the destroy-on-timeout teardown
      // triggers it AFTER the timeout already settled the promise, so the
      // worker's catch would otherwise miss it.
      if (err && err.code === 'ECANCELED') {
        bump('ECANCELED')
        if (/SSL destruction/.test(err.message || '')) {
          sslDestructionHits++
          if (!firstEcanceled) {
            firstEcanceled = { message: err.message, stack: err.stack }
          }
        }
      }
      reject(err)
    })
    req.on('close', () => timer && clearTimeout(timer))
    // Write the body and end immediately without waiting for drain, so a large
    // TLS write stays queued on the real socket across the Happy-Eyeballs race.
    req.write(BODY)
    req.end()
  })

async function runOnce(key, cert) {
  setupMocks()
  const { server, conns, port } = await startServer(key, cert)
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: config.maxSockets,
    rejectUnauthorized: false,
  })
  let next = 0
  const take = () => (next < config.requests ? next++ : null)
  const worker = async () => {
    while (take() !== null) {
      try {
        await issueRequest({ port, agent })
      } catch (err) {
        bump(err && err.code)
        if (err && /SSL destruction/.test(err.message || '')) sslDestructionHits++
      }
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, worker))
  agent.destroy()
  conns.forEach((c) => c.destroy())
  await new Promise((r) => server.close(r))
}

async function main() {
  const key = fs.readFileSync(`${config.certDir}/key.pem`)
  const cert = fs.readFileSync(`${config.certDir}/cert.pem`)

  log(`⚡ LATEST-packages TLS stress test`)
  log(`  node:                ${process.version}`)
  log(`  @mswjs/interceptors: ${interceptorsVersion()}`)
  log(`  nock:                ${require('nock/package.json').version}`)
  log(`  autoSelectFamily:    ${net.getDefaultAutoSelectFamily()}`)
  log(`  targetHost:          ${config.targetHost}  maxSockets: ${config.maxSockets}  body: ${(config.bodyBytes / 1024) | 0}KB`)
  log(`  load:                ${config.requests} reqs × ${config.concurrency} sockets × ${config.runs} runs`)
  await checkDualStack()

  for (let i = 1; i <= config.runs; i++) {
    if (config.runs > 1) log(`──── run ${i}/${config.runs} ────`)
    await runOnce(key, cert)
  }

  const bugHits =
    (errorCounts.EINVAL || 0) + (errorCounts.ECANCELED || 0) + stderrHits
  log('')
  log(`═══ SUMMARY ═══`)
  log(`  error code histogram:           ${JSON.stringify(errorCounts)}`)
  log(`  stderr EINVAL/ECANCELED hits:   ${stderrHits}`)
  log(`  "SSL destruction" hits:         ${sslDestructionHits}`)
  log(`  uncaughtExceptions:             ${uncaught}`)
  log(`  → bug signal (EINVAL+ECANCELED+stderr): ${bugHits}`)
  if (firstEcanceled) {
    log(`  FIRST ECANCELED message: ${firstEcanceled.message}`)
    log(`  FIRST ECANCELED stack:\n${firstEcanceled.stack}`)
  }
  log(bugHits > 0 ? '❌ BUG REPRODUCED' : '✅ NO BUG (clean)')
  await new Promise((r) => setTimeout(r, 250))
  process.exit(bugHits > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[tls] fatal', e)
  process.exit(2)
})
