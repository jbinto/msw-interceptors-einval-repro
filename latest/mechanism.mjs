#!/usr/bin/env node
// Deterministic isolation of the #753 WRITE-face primitive (no nock, no Happy
// Eyeballs). Recreate exactly what MockHttpSocket does: a real TLSSocket
// (originalSocket) with a write stuck in the TLSWrap (server never reads), then
// tear the handle down via the THREE candidate paths and see which one emits
// `write ECANCELED "Canceled because of SSL destruction"`:
//   A: close the borrowed handle directly (mock._handle.close())  -- the alias path
//   B: mock.destroy() where mock borrowed originalSocket._handle    -- MSW's exact alias
//   C: originalSocket.destroy(EINVAL)                               -- MSW once('error') cascade
import fs from 'fs'
import net from 'net'
import tls from 'tls'

// Force tiny TCP buffers so a write physically can't drain -> the SSL_write
// stays in-progress in the TLSWrap (current_write_ set) when we tear down.
try {
  fs.writeFileSync('/proc/sys/net/ipv4/tcp_wmem', '4096 8192 16384')
  fs.writeFileSync('/proc/sys/net/ipv4/tcp_rmem', '4096 8192 16384')
  console.log('[mech] tiny buffers set')
} catch (e) {
  console.log('[mech] could not set tiny buffers: ' + e.message)
}

const key = fs.readFileSync('/work/certs/key.pem')
const cert = fs.readFileSync('/work/certs/cert.pem')

// A PLAIN TCP server that accepts the connection but NEVER responds to the TLS
// ClientHello — so the client's handshake never completes. A write issued in
// that state is held by the TLSWrap as `current_write_` (OpenSSL can't encrypt
// app data until the handshake finishes). Closing the handle in that state hits
// TLSWrap::Destroy() -> InvokeQueued(UV_ECANCELED, "Canceled because of SSL
// destruction") — the EXACT real-CI error. (A completed-handshake server only
// yields generic stream-level "write ECANCELED".)
const server = net.createServer((socket) => {
  // swallow ClientHello bytes, never reply -> handshake hangs forever
  socket.on('data', () => {})
  socket.on('error', () => {})
})

const results = { A: {}, B: {}, C: {}, D: {} }
const samples = { A: {}, B: {}, C: {}, D: {} }
function tally(kind, code, msg) {
  const k = code + (msg && /SSL destruction/.test(msg) ? '+SSLdestruct' : '')
  results[kind][k] = (results[kind][k] || 0) + 1
  if (!samples[kind][code]) samples[kind][code] = msg // first literal message
}

const BODY = Buffer.alloc(4 * 1024 * 1024, 'x') // 4MB, exceeds buffers -> stuck write

function trial(kind) {
  return new Promise((resolve) => {
    const port = server.address().port
    // Connect: the handshake will HANG (server never replies to ClientHello).
    const orig = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    orig.on('secureConnect', () => {}) // never fires
    // Issue an application write while still handshaking -> held by the TLSWrap
    // as current_write_ (cannot be encrypted until handshake completes).
    orig.write(BODY, (err) => {
      if (err) tally(kind, 'wcb:' + err.code, err.message)
    })
    // Tear the handle down mid-handshake via the candidate path.
    setTimeout(() => {
      try {
        if (kind === 'A') {
          // Close the handle out from under the writer (== closing a BORROWED
          // shared handle).
          orig._handle && orig._handle.close()
        } else if (kind === 'B') {
          // MSW's EXACT alias: a separate socket borrows the handle, then its
          // own destroy() closes the shared handle.
          const mock = new net.Socket()
          Object.defineProperty(mock, '_handle', {
            value: orig._handle,
            enumerable: true,
            writable: true,
          })
          mock.on('error', () => {})
          mock.destroy()
        } else if (kind === 'C') {
          const e = new Error('read EINVAL')
          e.code = 'EINVAL'
          orig.destroy(e)
        } else if (kind === 'D') {
          // THE FIX: the mock does NOT borrow originalSocket's handle. Its
          // destroy() then cannot close originalSocket's TLSWrap, so the
          // pending write is NOT canceled — originalSocket is untouched.
          const mock = new net.Socket()
          mock.on('error', () => {})
          mock.destroy()
          // (orig only errors later when we tear it down at the timeout.)
        }
      } catch (err) {
        tally(kind, 'THREW:' + (err && err.code), err && err.message)
      }
    }, 50)
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { orig.destroy() } catch {}
      resolve()
    }
    orig.on('error', (err) => {
      tally(kind, err.code, err.message)
      done()
    })
    orig.on('close', () => setImmediate(done))
    setTimeout(done, 2000)
  })
}

async function runKind(kind, n) {
  for (let i = 0; i < n; i++) {
    await trial(kind)
  }
}

server.listen(0, '127.0.0.1', async () => {
  const N = parseInt(process.env.N || '50', 10)
  for (const kind of ['A', 'B', 'C', 'D']) {
    await runKind(kind, N)
    console.log(`[mech] ${kind} (${N} trials): ${JSON.stringify(results[kind])}`)
    for (const [code, msg] of Object.entries(samples[kind])) {
      console.log(`[mech]    ${kind} sample ${code}: "${msg}"`)
    }
  }
  server.close()
  process.exit(0)
})
